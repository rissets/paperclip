import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FormattedContent,
  type ThreadInfo,
} from "chat";
import { formatMarkdownForWhatsApp, splitWhatsAppText } from "./formatter.js";

export interface WhatsAppThread {
  jid: string;
  isGroup: boolean;
}

export function whatsAppThreadId(jid: string): string {
  return `whatsapp:${jid}`;
}

export function parseWhatsAppThreadId(threadId: string): WhatsAppThread {
  const match = /^whatsapp:(.+)$/.exec(threadId);
  if (!match) throw new Error("Invalid WhatsApp thread identity");
  const jid = match[1];
  return { jid, isGroup: jid.endsWith("@g.us") };
}

export class WhatsAppChatAdapter implements Adapter<WhatsAppThread, WAMessage> {
  readonly name = "whatsapp";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;

  constructor(
    readonly getSocket: () => WASocket | undefined,
    readonly botPhoneNumber: string,
    readonly userName = "Paperclip",
  ) {
    this.botUserId = botPhoneNumber;
  }

  async initialize(_chat: ChatInstance): Promise<void> {}
  async disconnect(): Promise<void> {}

  encodeThreadId(value: WhatsAppThread): string {
    return whatsAppThreadId(value.jid);
  }

  decodeThreadId(id: string): WhatsAppThread {
    return parseWhatsAppThreadId(id);
  }

  channelIdFromThreadId(id: string): string {
    return id;
  }

  isDM(id: string): boolean {
    return !this.decodeThreadId(id).isGroup;
  }

  async fetchThread(id: string): Promise<ThreadInfo> {
    const thread = this.decodeThreadId(id);
    return {
      id,
      channelId: id,
      channelName: thread.jid.replace(/@s\.whatsapp\.net|@g\.us/, ""),
      isDM: !thread.isGroup,
      metadata: {},
    };
  }

  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return {
      id,
      name: info.channelName,
      isDM: info.isDM,
      metadata: info.metadata,
    };
  }

  async fetchMessages(_id: string, _options?: any) {
    return {
      messages: [],
    };
  }

  parseMessage(raw: WAMessage): Message<WAMessage> {
    const remoteJid = raw.key.remoteJid ?? "";
    const isGroup = remoteJid.endsWith("@g.us");
    const threadId = whatsAppThreadId(remoteJid);
    const sender = raw.key.participant ?? (raw.key.fromMe ? this.botUserId : remoteJid);
    const authorId = sender.replace(/@s\.whatsapp\.net|@g\.us/, "");

    const content = raw.message;
    let text = "";
    if (content?.conversation) {
      text = content.conversation;
    } else if (content?.extendedTextMessage?.text) {
      text = content.extendedTextMessage.text;
    } else if (content?.imageMessage?.caption) {
      text = content.imageMessage.caption;
    } else if (content?.videoMessage?.caption) {
      text = content.videoMessage.caption;
    } else if (content?.documentMessage?.caption) {
      text = content.documentMessage.caption;
    }

    const timestamp = raw.messageTimestamp
      ? new Date(
          typeof raw.messageTimestamp === "number"
            ? raw.messageTimestamp * 1000
            : Number(raw.messageTimestamp) * 1000,
        )
      : new Date();

    return new Message({
      id: raw.key.id ?? `wa-${Date.now()}`,
      threadId,
      author: {
        userId: authorId,
        userName: raw.pushName ?? authorId,
        fullName: raw.pushName ?? authorId,
        isBot: raw.key.fromMe ?? false,
        isMe: raw.key.fromMe ?? false,
      },
      text,
      formatted: parseMarkdown(text),
      raw,
      attachments: [],
      metadata: {
        dateSent: timestamp,
        edited: false,
      },
    });
  }

  async postMessage(
    id: string,
    message: AdapterPostableMessage,
  ): Promise<Message<WAMessage>> {
    const thread = this.decodeThreadId(id);
    const sock = this.getSocket();
    if (!sock) {
      throw new Error("WhatsApp socket is not connected");
    }

    let text = "";
    if (typeof message === "string") {
      text = message;
    } else if ("markdown" in message && message.markdown) {
      text = message.markdown;
    } else if ("fallbackText" in message && message.fallbackText) {
      text = message.fallbackText;
    } else if ("raw" in message && typeof message.raw === "string") {
      text = message.raw;
    }

    const formatted = formatMarkdownForWhatsApp(text);
    const chunks = splitWhatsAppText(formatted);
    let lastSentMessage: WAMessage | undefined;

    for (const chunk of chunks) {
      lastSentMessage =
        (await sock.sendMessage(thread.jid, { text: chunk })) ?? undefined;
    }

    if (lastSentMessage) {
      return this.parseMessage(lastSentMessage);
    }

    return new Message({
      id: `wa-${Date.now()}`,
      threadId: id,
      author: {
        userId: this.botUserId,
        userName: this.userName,
        fullName: this.userName,
        isBot: true,
        isMe: true,
      },
      text: formatted,
      formatted: parseMarkdown(formatted),
      raw: {} as WAMessage,
      attachments: [],
      metadata: { dateSent: new Date(), edited: false },
    });
  }

  async editMessage(): Promise<never> {
    throw new Error("WhatsApp message edit is not supported");
  }

  async deleteMessage(): Promise<never> {
    throw new Error("WhatsApp message delete is not supported");
  }

  async addReaction(
    id: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const thread = this.decodeThreadId(id);
    const sock = this.getSocket();
    if (!sock) return;
    await sock.sendMessage(thread.jid, {
      react: {
        text: emoji,
        key: {
          remoteJid: thread.jid,
          id: messageId,
        },
      },
    });
  }

  async removeReaction(id: string, messageId: string): Promise<void> {
    await this.addReaction(id, messageId, "");
  }

  async startTyping(id: string): Promise<void> {
    const thread = this.decodeThreadId(id);
    const sock = this.getSocket();
    if (!sock) return;
    await sock.sendPresenceUpdate("composing", thread.jid).catch(() => {});
  }

  async endTyping(id: string): Promise<void> {
    const thread = this.decodeThreadId(id);
    const sock = this.getSocket();
    if (!sock) return;
    await sock.sendPresenceUpdate("paused", thread.jid).catch(() => {});
  }

  async handleWebhook(): Promise<Response> {
    return new Response("WhatsApp uses direct WebSocket gateway", {
      status: 405,
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }
}
