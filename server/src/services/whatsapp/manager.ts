import makeWASocket, {
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, toolConnections } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  initWhatsAppAuthState,
  clearWhatsAppAuthState,
  hasWhatsAppSession,
} from "./auth-store.js";
import { WhatsAppChatAdapter } from "./adapter.js";

export interface WhatsAppSessionState {
  status: "idle" | "qr_ready" | "connecting" | "connected" | "failed";
  qrCodeDataUrl?: string | null;
  phoneNumber?: string | null;
  pushName?: string | null;
  lastError?: string | null;
}

export class WhatsAppConnectionManager {
  private static instance: WhatsAppConnectionManager;
  private sockets = new Map<string, WASocket>();
  private states = new Map<string, WhatsAppSessionState>();
  private adapters = new Map<string, WhatsAppChatAdapter>();
  private messageHandlers = new Map<
    string,
    (msg: WAMessage) => Promise<void>
  >();

  static getInstance(): WhatsAppConnectionManager {
    if (!this.instance) {
      this.instance = new WhatsAppConnectionManager();
    }
    return this.instance;
  }

  getSocket(endpointId: string): WASocket | undefined {
    return this.sockets.get(endpointId);
  }

  getAdapter(
    endpointId: string,
    botPhoneNumber: string,
    userName = "Paperclip",
  ): WhatsAppChatAdapter {
    let adapter = this.adapters.get(endpointId);
    if (!adapter) {
      adapter = new WhatsAppChatAdapter(
        () => this.getSocket(endpointId),
        botPhoneNumber,
        userName,
      );
      this.adapters.set(endpointId, adapter);
    }
    return adapter;
  }

  registerMessageHandler(
    endpointId: string,
    handler: (msg: WAMessage) => Promise<void>,
  ) {
    this.messageHandlers.set(endpointId, handler);
  }

  unregisterMessageHandler(endpointId: string) {
    this.messageHandlers.delete(endpointId);
  }

  getStatus(endpointId: string): WhatsAppSessionState {
    return (
      this.states.get(endpointId) ?? {
        status: "idle",
        qrCodeDataUrl: null,
        phoneNumber: null,
        pushName: null,
        lastError: null,
      }
    );
  }

  async pair(
    endpointId: string,
    companyId: string,
    db: Db,
    onQr?: (qrCodeDataUrl: string) => void,
  ): Promise<WhatsAppSessionState> {
    const existing = this.sockets.get(endpointId);
    if (existing) {
      const state = this.getStatus(endpointId);
      if (state.status === "connected") {
        return state;
      }
      try {
        existing.end(undefined);
      } catch {}
      this.sockets.delete(endpointId);
    }

    this.states.set(endpointId, {
      status: "connecting",
      qrCodeDataUrl: null,
      phoneNumber: null,
      pushName: null,
      lastError: null,
    });

    const { state, saveCreds } = await initWhatsAppAuthState(
      companyId,
      endpointId,
    );

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Paperclip", "Chrome", "1.0.0"],
    });

    this.sockets.set(endpointId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrCodeDataUrl = await qrcode.toDataURL(qr);
          const current = this.states.get(endpointId) ?? {
            status: "qr_ready",
          };
          current.status = "qr_ready";
          current.qrCodeDataUrl = qrCodeDataUrl;
          this.states.set(endpointId, current);
          onQr?.(qrCodeDataUrl);
        } catch (err) {
          console.error("Failed to generate WhatsApp QR data URL", err);
        }
      }

      if (connection === "open") {
        const rawUser = sock.user?.id ?? "";
        const phoneNumber = rawUser.split(":")[0].split("@")[0];
        const pushName = sock.user?.name ?? `+${phoneNumber}`;

        this.states.set(endpointId, {
          status: "connected",
          qrCodeDataUrl: null,
          phoneNumber,
          pushName,
          lastError: null,
        });

        // Update endpoint in DB
        try {
          const [updated] = await db
            .update(chatEndpoints)
            .set({
              status: "active",
              botExternalId: phoneNumber,
              botUsername: `+${phoneNumber}`,
              botDisplayName: pushName,
              setup: sql`jsonb_set(
                jsonb_set(coalesce(${chatEndpoints.setup}, '{}'::jsonb), '{step}', '"complete"'),
                '{whatsapp}',
                ${JSON.stringify({ status: "connected", phoneNumber, pushName })}::jsonb
              )`,
              updatedAt: new Date(),
            })
            .where(eq(chatEndpoints.id, endpointId))
            .returning({ connectionId: chatEndpoints.connectionId });

          if (updated?.connectionId) {
            await db
              .update(toolConnections)
              .set({
                status: "active",
                enabled: true,
                healthStatus: "healthy",
                healthMessage: "Connected",
                lastError: null,
                healthCheckedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(toolConnections.id, updated.connectionId));
          }
        } catch (err) {
          console.error("Failed to update chat endpoint for WhatsApp", err);
        }
      }

      if (connection === "close") {
        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode ??
          (lastDisconnect?.error as { statusCode?: number })?.statusCode;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          this.states.set(endpointId, {
            status: "failed",
            qrCodeDataUrl: null,
            phoneNumber: null,
            pushName: null,
            lastError: "Perangkat telah keluar (logged out)",
          });
          this.sockets.delete(endpointId);
          await clearWhatsAppAuthState(companyId, endpointId);
          await db
            .update(chatEndpoints)
            .set({
              status: "attention",
              healthMessage: "WhatsApp terputus / logged out dari ponsel",
              updatedAt: new Date(),
            })
            .where(eq(chatEndpoints.id, endpointId));
        } else if (shouldReconnect) {
          // Reconnect automatically if session still exists
          if (hasWhatsAppSession(companyId, endpointId)) {
            setTimeout(() => {
              void this.pair(endpointId, companyId, db);
            }, 3000);
          }
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        const handler = this.messageHandlers.get(endpointId);
        if (handler) {
          try {
            await handler(msg);
          } catch (err) {
            console.error("Error processing inbound WhatsApp message:", err);
          }
        }
      }
    });

    return this.getStatus(endpointId);
  }

  async ensureConnected(
    endpointId: string,
    companyId: string,
    db: Db,
  ): Promise<void> {
    if (this.sockets.has(endpointId)) return;
    if (hasWhatsAppSession(companyId, endpointId)) {
      await this.pair(endpointId, companyId, db);
    }
  }

  async disconnect(
    endpointId: string,
    companyId: string,
    db: Db,
  ): Promise<void> {
    const sock = this.sockets.get(endpointId);
    if (sock) {
      try {
        sock.end(undefined);
      } catch {}
      this.sockets.delete(endpointId);
    }

    this.states.set(endpointId, {
      status: "idle",
      qrCodeDataUrl: null,
      phoneNumber: null,
      pushName: null,
      lastError: null,
    });

    await clearWhatsAppAuthState(companyId, endpointId);

    await db
      .update(chatEndpoints)
      .set({
        status: "paused",
        updatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, endpointId));
  }
}

export const whatsAppConnectionManager =
  WhatsAppConnectionManager.getInstance();
