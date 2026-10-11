import { describe, it, expect, vi } from "vitest";
import {
  formatMarkdownForWhatsApp,
  splitWhatsAppText,
} from "../services/whatsapp/formatter.js";
import {
  WhatsAppChatAdapter,
  whatsAppThreadId,
  parseWhatsAppThreadId,
} from "../services/whatsapp/adapter.js";

describe("WhatsApp Formatter", () => {
  it("converts headers to bold text", () => {
    expect(formatMarkdownForWhatsApp("# Header 1")).toBe("*Header 1*");
    expect(formatMarkdownForWhatsApp("### Subheader")).toBe("*Subheader*");
  });

  it("converts markdown bold to whatsapp bold", () => {
    expect(formatMarkdownForWhatsApp("This is **bold** text")).toBe(
      "This is *bold* text",
    );
    expect(formatMarkdownForWhatsApp("This is __also bold__ text")).toBe(
      "This is *also bold* text",
    );
  });

  it("converts markdown strikethrough to whatsapp strikethrough", () => {
    expect(formatMarkdownForWhatsApp("~~deleted~~")).toBe("~deleted~");
  });

  it("converts markdown bullets to bullet characters", () => {
    const input = "- Item 1\n- Item 2";
    expect(formatMarkdownForWhatsApp(input)).toBe("• Item 1\n• Item 2");
  });

  it("splits long text cleanly", () => {
    const shortText = "Short message";
    expect(splitWhatsAppText(shortText, 100)).toEqual(["Short message"]);

    const longText = "Paragraph 1\n\nParagraph 2\n\nParagraph 3";
    const chunks = splitWhatsAppText(longText, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n")).toContain("Paragraph 1");
    expect(chunks.join("\n\n")).toContain("Paragraph 3");
  });
});

describe("WhatsApp Adapter", () => {
  it("encodes and decodes thread identities properly", () => {
    const jid = "628123456789@s.whatsapp.net";
    const threadId = whatsAppThreadId(jid);
    expect(threadId).toBe("whatsapp:628123456789@s.whatsapp.net");

    const decoded = parseWhatsAppThreadId(threadId);
    expect(decoded.jid).toBe(jid);
    expect(decoded.isGroup).toBe(false);

    const groupJid = "1203630248293@g.us";
    const groupThread = parseWhatsAppThreadId(whatsAppThreadId(groupJid));
    expect(groupThread.isGroup).toBe(true);
  });

  it("parses inbound WAMessage into standard Message", () => {
    const adapter = new WhatsAppChatAdapter(
      () => undefined,
      "628999999999",
      "AgentBot",
    );

    const raw = {
      key: {
        remoteJid: "628123456789@s.whatsapp.net",
        id: "MSG123",
        fromMe: false,
      },
      message: {
        conversation: "Hello Paperclip agent!",
      },
      pushName: "Danang",
      messageTimestamp: 1700000000,
    };

    const parsed = adapter.parseMessage(raw as any);
    expect(parsed.id).toBe("MSG123");
    expect(parsed.text).toBe("Hello Paperclip agent!");
    expect(parsed.author.userName).toBe("Danang");
    expect(parsed.threadId).toBe("whatsapp:628123456789@s.whatsapp.net");
  });

  it("posts message through socket", async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({
      key: { id: "SENT_MSG_1", remoteJid: "628123456789@s.whatsapp.net" },
      message: { conversation: "*Hello back!*" },
    });

    const mockSocket = {
      sendMessage: mockSendMessage,
    };

    const adapter = new WhatsAppChatAdapter(
      () => mockSocket as any,
      "628999999999",
      "AgentBot",
    );

    const result = await adapter.postMessage(
      "whatsapp:628123456789@s.whatsapp.net",
      { markdown: "**Hello back!**" },
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      "628123456789@s.whatsapp.net",
      { text: "*Hello back!*" },
    );
    expect(result.id).toBe("SENT_MSG_1");
  });
});
