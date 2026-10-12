import type { Db } from "@paperclipai/db";
import {
  chatEndpoints,
  chatConversations,
  emailMessages,
  issues,
  companySecrets,
  toolConnections,
} from "@paperclipai/db";
import type { ChatEndpointStatus } from "@paperclipai/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { createSmtpTransporter, sendSmtpEmail, type SmtpConfig } from "./smtp-transport.js";
import { ImapListener, type ImapConfig, type InboundEmail } from "./imap-listener.js";
import type { Transporter } from "nodemailer";

export interface EmailStoredCredentials {
  provider: "gmail" | "email";
  displayName?: string;
  emailAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPass: string;
  pollIntervalSeconds?: number;
}

export class EmailConnectionManager {
  private static instance: EmailConnectionManager;
  private listeners = new Map<string, ImapListener>();
  private transporters = new Map<string, Transporter>();
  private credentialsCache = new Map<string, EmailStoredCredentials>();
  private statuses = new Map<string, { status: "connected" | "connecting" | "error" | "idle"; lastError?: string }>();
  private db: Db | null = null;
  private heartbeat: { wakeup: (agentId: string) => Promise<unknown> } | null = null;

  static getInstance(): EmailConnectionManager {
    if (!this.instance) {
      this.instance = new EmailConnectionManager();
    }
    return this.instance;
  }

  setDependencies(db: Db, heartbeat: { wakeup: (agentId: string) => Promise<unknown> }) {
    this.db = db;
    this.heartbeat = heartbeat;
  }

  getStatus(endpointId: string) {
    return this.statuses.get(endpointId) ?? { status: "idle" };
  }

  async startEndpoint(endpointId: string, companyId: string, creds: EmailStoredCredentials): Promise<void> {
    await this.stopEndpoint(endpointId);

    this.credentialsCache.set(endpointId, creds);
    this.statuses.set(endpointId, { status: "connecting" });

    // 1. Initialize SMTP transporter
    const smtpConfig: SmtpConfig = {
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      user: creds.smtpUser,
      pass: creds.smtpPass,
      fromAddress: creds.emailAddress,
      displayName: creds.displayName,
    };
    const transporter = createSmtpTransporter(smtpConfig);
    this.transporters.set(endpointId, transporter);

    // 2. Initialize IMAP listener
    const imapConfig: ImapConfig = {
      host: creds.imapHost,
      port: creds.imapPort,
      secure: creds.imapSecure,
      user: creds.imapUser,
      pass: creds.imapPass,
    };

    const listener = new ImapListener(imapConfig, async (inboundEmail) => {
      await this.handleIncomingEmail(endpointId, companyId, inboundEmail);
    });

    this.listeners.set(endpointId, listener);

    try {
      await listener.start();
      this.statuses.set(endpointId, { status: "connected" });
      logger.info({ endpointId, email: creds.emailAddress }, "Email connection manager started endpoint successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.statuses.set(endpointId, { status: "error", lastError: message });
      logger.error({ endpointId, err: message }, "Failed starting IMAP listener for endpoint");
    }
  }

  async stopEndpoint(endpointId: string): Promise<void> {
    const listener = this.listeners.get(endpointId);
    if (listener) {
      await listener.stop();
      this.listeners.delete(endpointId);
    }
    const transporter = this.transporters.get(endpointId);
    if (transporter) {
      transporter.close();
      this.transporters.delete(endpointId);
    }
    this.statuses.delete(endpointId);
  }

  async handleIncomingEmail(endpointId: string, companyId: string, email: InboundEmail): Promise<void> {
    if (!this.db) {
      logger.error("Database not initialized in EmailConnectionManager");
      return;
    }

    try {
      // 1. Find the endpoint record
      const [endpoint] = await this.db
        .select()
        .from(chatEndpoints)
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId)));

      if (!endpoint || endpoint.status === "archived" || endpoint.status === "paused") {
        logger.warn({ endpointId }, "Endpoint not active or not found, ignoring incoming email");
        return;
      }

      // 2. Check if this email belongs to an existing conversation thread
      let existingConversation: typeof chatConversations.$inferSelect | null = null;

      // Look up via inReplyTo or references in emailMessages
      const candidateMessageIds: string[] = [];
      if (email.inReplyTo) candidateMessageIds.push(email.inReplyTo);
      if (email.references && email.references.length > 0) {
        candidateMessageIds.push(...email.references);
      }

      if (candidateMessageIds.length > 0) {
        const matchingMessages = await this.db
          .select({
            conversationId: emailMessages.conversationId,
          })
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.endpointId, endpointId),
              inArray(emailMessages.providerMessageId, candidateMessageIds)
            )
          )
          .limit(1);

        if (matchingMessages.length > 0) {
          const [conv] = await this.db
            .select()
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.id, matchingMessages[0].conversationId),
                eq(chatConversations.endpointId, endpointId)
              )
            );
          if (conv) existingConversation = conv;
        }
      }

      // If still not found, check by externalConversationId (customer email address) and thread id
      if (!existingConversation && email.inReplyTo) {
        const [conv] = await this.db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.endpointId, endpointId),
              eq(chatConversations.externalThreadId, email.inReplyTo)
            )
          )
          .limit(1);
        if (conv) existingConversation = conv;
      }

      // 3. Dispatch based on whether thread exists
      if (existingConversation) {
        logger.info(
          { conversationId: existingConversation.id, issueId: existingConversation.issueId, from: email.from },
          "Matching email to existing conversation thread"
        );

        // Record incoming message in emailMessages
        await this.db.insert(emailMessages).values({
          companyId,
          endpointId,
          conversationId: existingConversation.id,
          providerMessageId: email.messageId,
          direction: "inbound",
          text: email.text,
          fullText: email.html || email.text,
          envelope: {
            from: email.from,
            to: email.to,
            cc: email.cc,
            subject: email.subject,
          },
          timestamp: email.date,
          automatic: email.isAutoReply,
        });

        // Add customer comment to the existing issue
        const commentBody = `**Email Masuk dari ${email.fromName} (${email.from})**:\n\n${email.text}`;
        await issueService(this.db).addComment(
          existingConversation.issueId,
          commentBody,
          {
            userId: endpoint.sponsorUserId || undefined,
          }
        );

        // Re-open issue if done or cancelled
        const [task] = await this.db
          .select()
          .from(issues)
          .where(eq(issues.id, existingConversation.issueId));

        if (task && (task.status === "done" || task.status === "cancelled")) {
          await issueService(this.db).update(task.id, { status: "todo" });
        }

        // Wake up assigned agent
        if (this.heartbeat && endpoint.assignedAgentId) {
          await this.heartbeat.wakeup(endpoint.assignedAgentId);
        }
      } else {
        // Create a new task / issue for this email conversation
        logger.info({ from: email.from, subject: email.subject }, "Creating new task for customer email");

        const taskTitle = email.subject ? email.subject.slice(0, 150) : `Pesan Email dari ${email.from}`;
        const taskDescription = `**Email Customer Baru**\n\n* **Dari**: ${email.fromName} <${email.from}>\n* **Subjek**: ${email.subject}\n* **Tanggal**: ${email.date.toLocaleString()}\n\n---\n\n${email.text}`;

        const task = await issueService(this.db).create(
          companyId,
          {
            title: taskTitle,
            description: taskDescription,
            status: "todo",
            priority: "medium",
            assigneeAgentId: endpoint.assignedAgentId,
            responsibleUserId: endpoint.sponsorUserId || undefined,
            originKind: "chat_channel",
            originId: `email:${endpoint.id}:${email.messageId}`,
            idempotencyKey: `email:${endpoint.id}:${email.messageId}`,
          }
        );

        // Insert chat conversation row
        const [conversation] = await this.db
          .insert(chatConversations)
          .values({
            companyId,
            endpointId,
            issueId: task.id,
            externalConversationId: email.from,
            externalThreadId: email.messageId,
            externalLabel: email.subject,
            isDirectMessage: true,
          })
          .returning();

        // Record incoming message in emailMessages
        await this.db.insert(emailMessages).values({
          companyId,
          endpointId,
          conversationId: conversation.id,
          providerMessageId: email.messageId,
          direction: "inbound",
          text: email.text,
          fullText: email.html || email.text,
          envelope: {
            from: email.from,
            to: email.to,
            cc: email.cc,
            subject: email.subject,
          },
          timestamp: email.date,
          automatic: email.isAutoReply,
        });

        // Wake up assigned agent
        if (this.heartbeat && endpoint.assignedAgentId) {
          await this.heartbeat.wakeup(endpoint.assignedAgentId);
        }
      }
    } catch (err) {
      logger.error({ err, from: email.from, subject: email.subject }, "Error handling incoming email message");
    }
  }

  async sendAgentReply(
    endpointId: string,
    companyId: string,
    issueId: string,
    replyText: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.db) {
      return { success: false, error: "Database not initialized" };
    }

    try {
      // 1. Find conversation by issueId
      const [conversation] = await this.db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.issueId, issueId),
            eq(chatConversations.companyId, companyId)
          )
        );

      if (!conversation) {
        return { success: false, error: "Conversation not found for this issue" };
      }

      const creds = this.credentialsCache.get(endpointId);
      const transporter = this.transporters.get(endpointId);

      if (!creds || !transporter) {
        return { success: false, error: "Email transporter not initialized for this endpoint" };
      }

      // 2. Find the last inbound message in this conversation for threading
      const prevMessages = await this.db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.conversationId, conversation.id),
            eq(emailMessages.direction, "inbound")
          )
        )
        .orderBy(sql`${emailMessages.timestamp} DESC`)
        .limit(1);

      const lastCustomerMessage = prevMessages[0];
      const recipient = conversation.externalConversationId || (lastCustomerMessage?.envelope?.from);

      if (!recipient) {
        return { success: false, error: "Recipient email address not found" };
      }

      const subject = conversation.externalLabel?.startsWith("Re:")
        ? conversation.externalLabel
        : `Re: ${conversation.externalLabel || "Balasan"}`;

      const references = lastCustomerMessage ? [lastCustomerMessage.providerMessageId] : [];
      const inReplyTo = lastCustomerMessage?.providerMessageId;

      // 3. Send email via SMTP
      const sendResult = await sendSmtpEmail(
        transporter,
        {
          host: creds.smtpHost,
          port: creds.smtpPort,
          secure: creds.smtpSecure,
          user: creds.smtpUser,
          pass: creds.smtpPass,
          fromAddress: creds.emailAddress,
          displayName: creds.displayName,
        },
        {
          to: recipient,
          subject,
          text: replyText,
          inReplyTo,
          references,
        }
      );

      if (!sendResult.success) {
        return { success: false, error: sendResult.error };
      }

      // 4. Record outbound message in emailMessages
      await this.db.insert(emailMessages).values({
        companyId,
        endpointId,
        conversationId: conversation.id,
        providerMessageId: sendResult.messageId,
        direction: "outbound",
        text: replyText,
        fullText: replyText,
        envelope: {
          from: creds.emailAddress,
          to: [recipient],
          subject,
        },
        timestamp: new Date(),
        automatic: false,
      });

      return { success: true, messageId: sendResult.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, issueId }, "Failed to send agent email reply");
      return { success: false, error: message };
    }
  }

  async initializeActiveEndpoints(db: Db, heartbeat: { wakeup: (agentId: string) => Promise<unknown> }): Promise<void> {
    this.setDependencies(db, heartbeat);

    try {
      // Find all active endpoints for email and gmail
      const activeEndpoints = await db
        .select()
        .from(chatEndpoints)
        .where(
          and(
            inArray(chatEndpoints.provider, ["email", "gmail"]),
            eq(chatEndpoints.status, "active")
          )
        );

      logger.info({ count: activeEndpoints.length }, "Initializing active email endpoints on server startup");

      for (const ep of activeEndpoints) {
        try {
          // Look up stored secret in toolConnections or companySecrets
          const [conn] = await db
            .select()
            .from(toolConnections)
            .where(eq(toolConnections.id, ep.connectionId));

          if (conn && conn.config) {
            const creds = conn.config as unknown as EmailStoredCredentials;
            if (creds.smtpHost && creds.imapHost) {
              await this.startEndpoint(ep.id, ep.companyId, creds);
            }
          }
        } catch (epErr) {
          logger.error({ endpointId: ep.id, err: epErr }, "Failed to start active email endpoint during initialization");
        }
      }
    } catch (err) {
      logger.error({ err }, "Error querying active email endpoints during startup");
    }
  }
}

export const emailConnectionManager = EmailConnectionManager.getInstance();
