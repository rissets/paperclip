import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, toolApplications, toolConnections } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { emailConnectorConfigSchema, emailConnectorTestSchema } from "@paperclipai/shared";
import { verifySmtp } from "../services/email/smtp-transport.js";
import { verifyImap } from "../services/email/imap-listener.js";
import { emailConnectionManager, type EmailStoredCredentials } from "../services/email/email-connection-manager.js";

export function emailConnectorRoutes(db: Db) {
  const router = Router();

  // Test SMTP and IMAP connection without saving
  router.post(
    "/companies/:companyId/email-connector/test",
    validate(emailConnectorTestSchema),
    async (req: Request, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, imapHost, imapPort, imapSecure, imapUser, imapPassword } = req.body;

      // Verify SMTP and IMAP in parallel
      const [smtpResult, imapResult] = await Promise.all([
        verifySmtp({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          user: smtpUser,
          pass: smtpPassword,
        }),
        verifyImap({
          host: imapHost,
          port: imapPort,
          secure: imapSecure,
          user: imapUser,
          pass: imapPassword,
        }),
      ]);

      res.json({
        success: smtpResult.success && imapResult.success,
        smtp: smtpResult,
        imap: imapResult,
      });
    }
  );

  // Setup and activate an email connector endpoint
  router.post(
    "/companies/:companyId/email-connector/setup",
    validate(emailConnectorConfigSchema),
    async (req: Request, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      const body = req.body;

      // 1. Verify credentials first
      const [smtpResult, imapResult] = await Promise.all([
        verifySmtp({
          host: body.smtpHost,
          port: body.smtpPort,
          secure: body.smtpSecure,
          user: body.smtpUser,
          pass: body.smtpPassword,
        }),
        verifyImap({
          host: body.imapHost,
          port: body.imapPort,
          secure: body.imapSecure,
          user: body.imapUser,
          pass: body.imapPassword,
        }),
      ]);

      if (!smtpResult.success || !imapResult.success) {
        throw badRequest(
          `Verifikasi koneksi gagal. SMTP: ${smtpResult.error || "OK"}, IMAP: ${imapResult.error || "OK"}`
        );
      }

      const storedCreds: EmailStoredCredentials = {
        provider: body.provider,
        displayName: body.displayName,
        emailAddress: body.emailAddress,
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        smtpSecure: body.smtpSecure,
        smtpUser: body.smtpUser,
        smtpPass: body.smtpPassword,
        imapHost: body.imapHost,
        imapPort: body.imapPort,
        imapSecure: body.imapSecure,
        imapUser: body.imapUser,
        imapPass: body.imapPassword,
        pollIntervalSeconds: body.pollIntervalSeconds,
      };

      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const endpointId = randomUUID();
      const sanitizedMail = body.emailAddress.toLowerCase().replace(/[^a-z0-9]/g, "-");
      const endpointPublicId = `email-${sanitizedMail}-${randomUUID().slice(0, 8)}`;

      // 2. Create toolApplication
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId,
        applicationKey: `chat:${body.provider}:${endpointId}`,
        name: body.displayName || body.emailAddress,
        description: `Email channel for ${body.emailAddress}`,
        type: "chat",
        status: "active",
        metadata: { sourceTemplateKey: body.provider, purpose: "channel" },
        ownerUserId: req.actor.userId ?? null,
      });

      // 3. Create toolConnection record
      const [connection] = await db
        .insert(toolConnections)
        .values({
          id: connectionId,
          companyId,
          applicationId,
          name: body.displayName || body.emailAddress,
          uid: `email-${sanitizedMail}`,
          connectionKind: "managed",
          connectionPurpose: "channel",
          ownership: "customer",
          transport: "chat_sdk",
          authKind: "api_key",
          credentialPolicy: "shared",
          status: "active",
          enabled: true,
          config: storedCreds as unknown as Record<string, unknown>,
          transportConfig: {},
          createdByUserId: req.actor.userId ?? null,
        })
        .returning();

      // 4. Create or update chatEndpoint record
      let endpoint: typeof chatEndpoints.$inferSelect;
      if (body.endpointId) {
        const [updated] = await db
          .update(chatEndpoints)
          .set({
            connectionId: connection.id,
            provider: body.provider,
            botExternalId: body.emailAddress,
            botDisplayName: body.displayName || body.emailAddress,
            botUsername: body.emailAddress,
            status: "active",
            capabilities: {
              threads: true,
              directMessages: true,
              nativeStreaming: false,
              messageEdits: false,
              messageDeletes: false,
              reactions: false,
              files: true,
              cards: false,
              actions: false,
              modals: false,
              slashCommands: false,
              ephemeralMessages: false,
              proactiveDirectMessages: true,
            },
            setup: { step: "complete" },
            updatedAt: new Date(),
          })
          .where(and(eq(chatEndpoints.id, body.endpointId), eq(chatEndpoints.companyId, companyId)))
          .returning();
        endpoint = updated;
      } else {
        const [inserted] = await db
          .insert(chatEndpoints)
          .values({
            id: endpointId,
            companyId,
            connectionId: connection.id,
            provider: body.provider,
            publicId: endpointPublicId,
            assignedAgentId: body.assignedAgentId,
            sponsorUserId: req.actor.userId ?? null,
            botExternalId: body.emailAddress,
            botDisplayName: body.displayName || body.emailAddress,
            botUsername: body.emailAddress,
            status: "active",
            capabilities: {
              threads: true,
              directMessages: true,
              nativeStreaming: false,
              messageEdits: false,
              messageDeletes: false,
              reactions: false,
              files: true,
              cards: false,
              actions: false,
              modals: false,
              slashCommands: false,
              ephemeralMessages: false,
              proactiveDirectMessages: true,
            },
            setup: { step: "complete" },
          })
          .returning();
        endpoint = inserted;
      }

      // 4. Start active IMAP listener and SMTP transporter
      await emailConnectionManager.startEndpoint(endpoint.id, companyId, storedCreds);

      res.status(201).json({
        endpoint,
        connectionId: connection.id,
        emailAddress: body.emailAddress,
        status: "connected",
      });
    }
  );

  // Get real-time connection status
  router.get(
    "/companies/:companyId/email-connector/status/:endpointId",
    async (req: Request, res) => {
      const companyId = req.params.companyId as string;
      const endpointId = req.params.endpointId as string;
      assertCompanyAccess(req, companyId);

      const status = emailConnectionManager.getStatus(endpointId);
      res.json(status);
    }
  );

  // Send reply from agent / user to a customer issue
  router.post(
    "/companies/:companyId/email-connector/reply",
    validate(
      z.object({
        endpointId: z.string().uuid(),
        issueId: z.string().uuid(),
        replyText: z.string().min(1).max(50000),
      })
    ),
    async (req: Request, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { endpointId, issueId, replyText } = req.body;
      const result = await emailConnectionManager.sendAgentReply(
        endpointId,
        companyId,
        issueId,
        replyText
      );

      if (!result.success) {
        throw badRequest(result.error || "Gagal mengirim balasan email");
      }

      res.json(result);
    }
  );

  // Disconnect or pause endpoint
  router.post(
    "/companies/:companyId/email-connector/disconnect/:endpointId",
    async (req: Request, res) => {
      const companyId = req.params.companyId as string;
      const endpointId = req.params.endpointId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);

      await emailConnectionManager.stopEndpoint(endpointId);

      await db
        .update(chatEndpoints)
        .set({ status: "archived" })
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId)));

      res.json({ success: true, message: "Koneksi email berhasil dihentikan" });
    }
  );

  return router;
}
