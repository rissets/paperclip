import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../middleware/logger.js";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface InvitationEmailOptions {
  email: string;
  name?: string | null;
  inviterName?: string | null;
  companyNames: string[];
  role: string;
  inviteUrl: string;
}

interface PasswordResetEmailOptions {
  email: string;
  name?: string | null;
  resetUrl: string;
}

function getSmtpConfig() {
  const host = process.env.EMAIL_HOST || "smtp.gmail.com";
  const port = Number(process.env.EMAIL_PORT || 587);
  const user = process.env.EMAIL_HOST_USER || "memories.risset@gmail.com";
  const pass = process.env.EMAIL_HOST_PASSWORD || "ltqmodcgdkyiolat";
  const defaultFrom = process.env.DEFAULT_FROM_EMAIL || "no-reply@lokakara.com";
  const timeoutMs = Number(process.env.EMAIL_TIMEOUT || 15) * 1000;

  return {
    host,
    port,
    user,
    pass,
    defaultFrom,
    timeoutMs,
  };
}

let transporterInstance: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporterInstance) {
    return transporterInstance;
  }

  const config = getSmtpConfig();
  transporterInstance = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });

  return transporterInstance;
}

export async function sendEmail(opts: SendEmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const config = getSmtpConfig();
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: `"Primbon Control Plane" <${config.defaultFrom}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text || opts.html.replace(/<[^>]+>/g, " "),
    });

    logger.info({ messageId: info.messageId, to: opts.to, subject: opts.subject }, "Email sent successfully via SMTP");
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: opts.to, subject: opts.subject }, "Failed to send email via SMTP");
    return { success: false, error: errorMsg };
  }
}

export async function sendInvitationEmail(opts: InvitationEmailOptions) {
  const inviter = opts.inviterName || "The Administrator";
  const companyListStr = opts.companyNames.join(", ");
  const roleLabel = opts.role.charAt(0).toUpperCase() + opts.role.slice(1);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #09090b; color: #f4f4f5; margin: 0; padding: 40px 20px; }
    .container { max-width: 560px; margin: 0 auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 32px; }
    .logo { font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 24px; letter-spacing: -0.5px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background-color: #27272a; color: #a1a1aa; font-size: 12px; margin-bottom: 16px; font-weight: 500; }
    h1 { font-size: 20px; font-weight: 600; color: #ffffff; margin-top: 0; margin-bottom: 16px; }
    p { font-size: 14px; line-height: 1.6; color: #a1a1aa; margin: 0 0 16px; }
    .highlight-box { background-color: #09090b; border: 1px solid #27272a; border-radius: 6px; padding: 16px; margin: 20px 0; }
    .item-label { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .item-val { font-size: 14px; color: #f4f4f5; font-weight: 500; margin-bottom: 12px; }
    .item-val:last-child { margin-bottom: 0; }
    .btn-container { margin: 28px 0; text-align: center; }
    .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; }
    .btn:hover { background-color: #1d4ed8; }
    .footer { margin-top: 32px; border-top: 1px solid #27272a; padding-top: 20px; font-size: 12px; color: #71717a; line-height: 1.5; }
    .link-alt { word-break: break-all; color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Primbon · Lokakara</div>
    <div class="badge">Invitation</div>
    <h1>You're invited to join Primbon</h1>
    <p>Hello${opts.name ? ` ${opts.name}` : ""},</p>
    <p><strong>${inviter}</strong> has invited you to join the team on Primbon Control Plane.</p>
    
    <div class="highlight-box">
      <div class="item-label">Assigned Workspaces</div>
      <div class="item-val">${companyListStr}</div>
      <div class="item-label">Assigned Role</div>
      <div class="item-val">${roleLabel}</div>
    </div>

    <div class="btn-container">
      <a href="${opts.inviteUrl}" class="btn" target="_blank">Accept Invitation & Join</a>
    </div>

    <p>Or copy and paste this link into your browser:</p>
    <p class="link-alt">${opts.inviteUrl}</p>

    <div class="footer">
      This invitation link is valid for 7 days. If you were not expecting this invitation, you can safely ignore this email.
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to: opts.email,
    subject: `You've been invited to join ${companyListStr} on Primbon`,
    html,
  });
}

export async function sendPasswordResetEmail(opts: PasswordResetEmailOptions) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #09090b; color: #f4f4f5; margin: 0; padding: 40px 20px; }
    .container { max-width: 560px; margin: 0 auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 32px; }
    .logo { font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 24px; letter-spacing: -0.5px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background-color: #27272a; color: #a1a1aa; font-size: 12px; margin-bottom: 16px; font-weight: 500; }
    h1 { font-size: 20px; font-weight: 600; color: #ffffff; margin-top: 0; margin-bottom: 16px; }
    p { font-size: 14px; line-height: 1.6; color: #a1a1aa; margin: 0 0 16px; }
    .btn-container { margin: 28px 0; text-align: center; }
    .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; }
    .btn:hover { background-color: #1d4ed8; }
    .footer { margin-top: 32px; border-top: 1px solid #27272a; padding-top: 20px; font-size: 12px; color: #71717a; line-height: 1.5; }
    .link-alt { word-break: break-all; color: #60a5fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Primbon · Lokakara</div>
    <div class="badge">Security</div>
    <h1>Reset your password</h1>
    <p>Hello${opts.name ? ` ${opts.name}` : ""},</p>
    <p>We received a request to reset the password for your Primbon account (<strong>${opts.email}</strong>).</p>

    <div class="btn-container">
      <a href="${opts.resetUrl}" class="btn" target="_blank">Reset Password</a>
    </div>

    <p>Or copy and paste this link into your browser:</p>
    <p class="link-alt">${opts.resetUrl}</p>

    <div class="footer">
      This password reset link is valid for 1 hour. If you did not request a password reset, no action is needed and your account remains secure.
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to: opts.email,
    subject: "Reset your Primbon password",
    html,
  });
}
