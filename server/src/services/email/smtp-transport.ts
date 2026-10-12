import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../../middleware/logger.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
  fromAddress?: string;
  displayName?: string;
}

export interface SendMailOptions {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  messageId?: string;
}

export function createSmtpTransporter(config: SmtpConfig): Transporter {
  const isSecure = config.secure ?? (config.port === 465);
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: isSecure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      // Allow STARTTLS for port 587/25
      rejectUnauthorized: true,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
}

export async function verifySmtp(config: SmtpConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = createSmtpTransporter(config);
    await transporter.verify();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ host: config.host, port: config.port, err: message }, "SMTP connection verification failed");
    return { success: false, error: message };
  }
}

export async function sendSmtpEmail(
  transporter: Transporter,
  config: SmtpConfig,
  opts: SendMailOptions
): Promise<{ success: boolean; messageId: string; error?: string }> {
  try {
    const fromHeader = opts.from || (config.displayName
      ? `"${config.displayName}" <${config.fromAddress || config.user}>`
      : config.fromAddress || config.user);

    const info = await transporter.sendMail({
      from: fromHeader,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, "<br>"),
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      messageId: opts.messageId,
    });

    logger.info({ messageId: info.messageId, to: opts.to, subject: opts.subject }, "Email successfully sent via SMTP");
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, to: opts.to, subject: opts.subject }, "Failed to send email via SMTP");
    return { success: false, messageId: "", error: message };
  }
}
