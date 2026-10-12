import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { logger } from "../../middleware/logger.js";

export interface ImapConfig {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
  pollIntervalSeconds?: number;
}

export interface InboundEmail {
  messageId: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
  isAutoReply: boolean;
}

export async function verifyImap(config: ImapConfig): Promise<{ success: boolean; error?: string }> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure ?? (config.port === 993),
    auth: {
      user: config.user,
      pass: config.pass,
    },
    logger: false,
    tls: {
      rejectUnauthorized: true,
    },
  });

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    await client.logout();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ host: config.host, port: config.port, err: message }, "IMAP verification failed");
    try {
      await client.logout();
    } catch {
      // ignore
    }
    return { success: false, error: message };
  }
}

export class ImapListener {
  private client: ImapFlow | null = null;
  private isRunning = false;
  private isFetching = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(
    private config: ImapConfig,
    private onNewEmail: (email: InboundEmail) => Promise<void>
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await Promise.race([
        this.initClient(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("IMAP connection timed out (10s)")), 10000)
        ),
      ]);
      void this.runListeningLoop();

      // Periodic check as fallback in case IDLE drops or exists event is missed
      this.pollTimer = setInterval(() => {
        if (this.isRunning && this.client && this.client.usable) {
          void this.fetchUnreadMessages();
        }
      }, (this.config.pollIntervalSeconds ?? 30) * 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ user: this.config.user, err: message }, "Failed connecting to IMAP server on start");
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore
      }
      this.client = null;
    }
    logger.info({ user: this.config.user, host: this.config.host }, "IMAP listener stopped");
  }

  private async initClient(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore
      }
      this.client = null;
    }

    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? (this.config.port === 993),
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false,
      tls: {
        rejectUnauthorized: true,
      },
    });

    this.client.on("error", (err) => {
      logger.warn({ user: this.config.user, err: err.message }, "IMAP client error");
      this.scheduleReconnect();
    });

    this.client.on("close", () => {
      logger.info({ user: this.config.user }, "IMAP connection closed");
      this.scheduleReconnect();
    });

    this.client.on("exists", (data) => {
      logger.info({ user: this.config.user, count: data.count }, "New message detected via IMAP exists event");
      void this.fetchUnreadMessages();
    });

    await this.client.connect();
    this.reconnectAttempts = 0;
    logger.info({ user: this.config.user, host: this.config.host }, "IMAP client connected successfully");
  }

  private async runListeningLoop(): Promise<void> {
    if (!this.isRunning || !this.client || !this.client.usable) return;

    try {
      // Initial fetch of unread messages
      await this.fetchUnreadMessages();

      // Listen for new messages using IDLE (do NOT hold lock across idle())
      while (this.isRunning && this.client && this.client.usable) {
        try {
          await this.client.idle();
          await this.fetchUnreadMessages();
        } catch (idleErr) {
          if (!this.isRunning) break;
          logger.warn({ user: this.config.user, err: idleErr }, "IMAP idle interrupted, fetching again");
          await this.fetchUnreadMessages();
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ user: this.config.user, err: message }, "Error in IMAP listening loop");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(60000, 3000 * Math.pow(1.5, this.reconnectAttempts));
    logger.info({ user: this.config.user, delayMs: delay }, "Scheduling IMAP reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectAndListen();
    }, delay);
  }

  private async connectAndListen(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.initClient();
      void this.runListeningLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ user: this.config.user, err: message }, "Failed connecting to IMAP server");
      this.scheduleReconnect();
    }
  }

  private async fetchUnreadMessages(): Promise<void> {
    if (!this.client || !this.client.usable || this.isFetching) return;
    this.isFetching = true;

    let lock;
    try {
      lock = await this.client.getMailboxLock("INBOX");
    } catch (lockErr) {
      this.isFetching = false;
      logger.warn({ user: this.config.user, err: lockErr }, "Failed to get mailbox lock for fetch");
      return;
    }

    const rawMessages: { uid?: number; source: Buffer }[] = [];

    try {
      // Search unseen messages from the last 3 days
      const searchSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const uids = await this.client.search({ seen: false, since: searchSince }, { uid: true });

      if (uids && uids.length > 0) {
        const messages = this.client.fetch(uids, { source: true, flags: true, uid: true }, { uid: true });
        for await (const msg of messages) {
          if (!this.isRunning) break;
          if (!msg.source) continue;
          rawMessages.push({ uid: msg.uid, source: msg.source });
        }

        // Mark messages as seen outside the fetch generator to prevent IMAP stream deadlock
        const fetchedUids = rawMessages
          .map((m) => m.uid)
          .filter((uid): uid is number => typeof uid === "number");
        if (fetchedUids.length > 0) {
          try {
            await this.client.messageFlagsAdd(fetchedUids, ["\\Seen"], { uid: true });
          } catch (flagErr) {
            logger.warn({ user: this.config.user, err: flagErr }, "Failed to mark fetched messages as seen");
          }
        }
      }
    } catch (fetchErr) {
      logger.warn({ err: fetchErr }, "Error fetching unread messages from IMAP");
    } finally {
      lock.release();
      this.isFetching = false;
    }

    // Process parsed emails after mailbox lock is released so long DB/agent operations do not block IMAP
    for (const raw of rawMessages) {
      if (!this.isRunning) break;
      try {
        const parsed = await simpleParser(raw.source);
        const inbound = this.normalizeEmail(parsed);

        // Filter auto-replies / bounce loops
        if (inbound.isAutoReply) {
          logger.info({ subject: inbound.subject, from: inbound.from }, "Skipping automatic/bounce email");
          continue;
        }

        await this.onNewEmail(inbound);
      } catch (parseErr) {
        logger.error({ err: parseErr }, "Failed to parse inbound email message");
      }
    }
  }

  private normalizeEmail(parsed: ParsedMail): InboundEmail {
    const fromAddress = parsed.from?.value?.[0]?.address || "unknown@sender.com";
    const fromName = parsed.from?.value?.[0]?.name || fromAddress;

    const toAddresses = (parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to.flatMap((t) => t.value.map((v) => v.address || ""))
        : parsed.to.value.map((v) => v.address || "")
      : []
    ).filter(Boolean);

    const ccAddresses = (parsed.cc
      ? Array.isArray(parsed.cc)
        ? parsed.cc.flatMap((c) => c.value.map((v) => v.address || ""))
        : parsed.cc.value.map((v) => v.address || "")
      : []
    ).filter(Boolean);

    // Check for auto-replies / robot emails / newsletters / marketing
    const autoSubmitted = parsed.headers.get("auto-submitted")?.toString().toLowerCase();
    const xAutoreply = parsed.headers.get("x-autoreply")?.toString().toLowerCase();
    const precedence = parsed.headers.get("precedence")?.toString().toLowerCase();
    const hasListUnsubscribe = Boolean(parsed.headers.get("list-unsubscribe") || parsed.headers.get("list-id"));
    const isAutomatedSender = /^(no-?reply|notifications?|mailer-daemon|alerts?|updates?|billing|newsletter|marketing|promo|news)@/i.test(fromAddress);

    const isAutoReply = Boolean(
      (autoSubmitted && autoSubmitted !== "no") ||
      xAutoreply === "yes" ||
      precedence === "bulk" ||
      precedence === "junk" ||
      precedence === "auto_reply" ||
      hasListUnsubscribe ||
      isAutomatedSender
    );

    const rawReferences = parsed.references;
    const referencesList = Array.isArray(rawReferences)
      ? rawReferences
      : typeof rawReferences === "string"
      ? [rawReferences]
      : [];

    const stringHeaders: Record<string, string> = {};
    for (const [k, v] of parsed.headers) {
      if (typeof v === "string") stringHeaders[k] = v;
      else if (v && typeof v === "object" && "text" in v && typeof v.text === "string") {
        stringHeaders[k] = v.text;
      }
    }

    return {
      messageId: parsed.messageId || `<${Date.now()}@paperclip.local>`,
      from: fromAddress,
      fromName,
      to: toAddresses,
      cc: ccAddresses,
      subject: parsed.subject || "(Tanpa Subjek)",
      text: parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ").trim() : ""),
      html: typeof parsed.html === "string" ? parsed.html : undefined,
      date: parsed.date || new Date(),
      inReplyTo: parsed.inReplyTo,
      references: referencesList,
      headers: stringHeaders,
      isAutoReply,
    };
  }
}
