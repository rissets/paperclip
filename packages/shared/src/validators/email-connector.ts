import { z } from "zod";

export const emailConnectorConfigSchema = z.object({
  endpointId: z.string().uuid().optional(),
  provider: z.enum(["gmail", "email"]),
  assignedAgentId: z.string().uuid(),
  displayName: z.string().min(1).max(100),
  emailAddress: z.string().trim().email(),
  // SMTP Outbound
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean().default(false), // true for port 465 (SSL), false for 587 (STARTTLS)
  smtpUser: z.string().min(1),
  smtpPassword: z.string().min(1),
  // IMAP Inbound
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean().default(true), // true for port 993 (SSL)
  imapUser: z.string().min(1),
  imapPassword: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(30),
});

export type EmailConnectorConfigInput = z.infer<typeof emailConnectorConfigSchema>;

export const emailConnectorTestSchema = z.object({
  provider: z.enum(["gmail", "email"]),
  emailAddress: z.string().trim().email(),
  // SMTP Outbound
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().min(1),
  smtpPassword: z.string().min(1),
  // IMAP Inbound
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean().default(true),
  imapUser: z.string().min(1),
  imapPassword: z.string().min(1),
});

export type EmailConnectorTestInput = z.infer<typeof emailConnectorTestSchema>;
