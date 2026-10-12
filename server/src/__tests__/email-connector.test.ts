import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  emailConnectorConfigSchema,
  emailConnectorTestSchema,
} from "@paperclipai/shared";
import { createSmtpTransporter } from "../services/email/smtp-transport.js";

describe("Email Connector Unit Tests", () => {
  describe("Validation Schemas", () => {
    it("validates Gmail connector config", () => {
      const validGmail = {
        provider: "gmail",
        assignedAgentId: randomUUID(),
        displayName: "Customer Support",
        emailAddress: "support@mycompany.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "support@mycompany.com",
        smtpPassword: "abcd efgh ijkl mnop",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapSecure: true,
        imapUser: "support@mycompany.com",
        imapPassword: "abcd efgh ijkl mnop",
      };

      const result = emailConnectorConfigSchema.safeParse(validGmail);
      expect(result.success).toBe(true);
    });

    it("validates custom SMTP/IMAP config", () => {
      const validCustom = {
        provider: "email",
        assignedAgentId: randomUUID(),
        displayName: "Helpdesk",
        emailAddress: "help@customdomain.id",
        smtpHost: "mail.customdomain.id",
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: "help@customdomain.id",
        smtpPassword: "secretPassword123",
        imapHost: "mail.customdomain.id",
        imapPort: 993,
        imapSecure: true,
        imapUser: "help@customdomain.id",
        imapPassword: "secretPassword123",
        pollIntervalSeconds: 60,
      };

      const result = emailConnectorConfigSchema.safeParse(validCustom);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pollIntervalSeconds).toBe(60);
      }
    });

    it("rejects invalid email address in test schema", () => {
      const invalid = {
        provider: "gmail",
        emailAddress: "not-an-email",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "user",
        smtpPassword: "pass",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapSecure: true,
        imapUser: "user",
        imapPassword: "pass",
      };

      const result = emailConnectorTestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("SMTP Transporter Factory", () => {
    it("creates nodemailer transporter with expected options", () => {
      const transporter = createSmtpTransporter({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: "test@gmail.com",
        pass: "appPassword",
      });

      expect(transporter).toBeDefined();
      expect(typeof transporter.sendMail).toBe("function");
    });
  });
});
