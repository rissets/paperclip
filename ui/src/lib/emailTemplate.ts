import type { EmailTemplateConfiguration } from "@paperclipai/shared";

export const EMAIL_PRESET_OPTIONS: {
  id: "card" | "minimal" | "formal" | "custom";
  label: string;
  description: string;
}[] = [
  {
    id: "card",
    label: "Modern Card",
    description: "White card on subtle backdrop with rounded corners and shadow (default).",
  },
  {
    id: "minimal",
    label: "Minimalist",
    description: "Clean and borderless layout without outer cards or heavy elements.",
  },
  {
    id: "formal",
    label: "Corporate Formal",
    description: "Business letterhead with colored top brand bar, date, and formal footer.",
  },
  {
    id: "custom",
    label: "Custom HTML",
    description: "Full custom HTML template using {{content}}, {{senderName}}, and {{footer}} tags.",
  },
];

export const EMAIL_COLOR_SWATCHES = [
  { name: "Blue", value: "#2563eb" },
  { name: "Emerald", value: "#059669" },
  { name: "Purple", value: "#7c3aed" },
  { name: "Amber", value: "#d97706" },
  { name: "Slate", value: "#475569" },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateEmailPreviewHtml(
  template: EmailTemplateConfiguration,
  senderName = "Data Agent",
): string {
  const preset = template.preset || "card";
  const brandColor = template.brandColor || "#2563eb";
  const headerTitle = template.headerTitle?.trim() || senderName;
  const headerBadge = template.headerBadge !== undefined ? template.headerBadge : "AI Assistant";

  const rawFooter = template.footerText?.trim();
  const footerContent = rawFooter
    ? escapeHtml(rawFooter)
        .replace(/\{senderName\}/g, escapeHtml(senderName))
        .replace(/\{headerTitle\}/g, escapeHtml(headerTitle))
    : `Dijawab otomatis oleh <strong>${escapeHtml(senderName)}</strong> &bull; Paperclip Control Plane`;

  const sampleBodyHtml = `
    <p style="margin: 0 0 16px 0; line-height: 1.6; color: #374151; font-size: 15px;">Halo Pak/Bu,</p>
    <p style="margin: 0 0 16px 0; line-height: 1.6; color: #374151; font-size: 15px;">Terima kasih telah menghubungi kami. Kami telah menerima permintaan Anda dan siap membantu.</p>
    <blockquote style="border-left: 4px solid ${brandColor}; margin: 16px 0; padding: 10px 16px; background-color: #f8fafc; color: #1e293b; border-radius: 0 6px 6px 0; font-size: 14px;">
      Pertanyaan terkait informasi data dan layanan pelanggan.
    </blockquote>
    <ul style="margin: 0 0 16px 0; padding-left: 24px; color: #374151; font-size: 15px; line-height: 1.6;">
      <li style="margin-bottom: 6px;"><strong>Status</strong>: Berhasil diproses</li>
      <li style="margin-bottom: 6px;"><strong>Prioritas</strong>: Normal</li>
    </ul>
    <p style="margin: 0 0 16px 0; line-height: 1.6; color: #374151; font-size: 15px;">Jika Anda membutuhkan informasi tambahan, silakan balas email ini langsung.</p>
  `;

  if (preset === "custom" && template.customHtml && template.customHtml.trim().length > 0) {
    let custom = template.customHtml;
    const nowStr = new Date().toLocaleDateString("id-ID", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    custom = custom
      .replace(/\{\{\s*content\s*\}\}/gi, sampleBodyHtml)
      .replace(/\{\{\s*senderName\s*\}\}/gi, escapeHtml(senderName))
      .replace(/\{\{\s*sender_name\s*\}\}/gi, escapeHtml(senderName))
      .replace(/\{\{\s*headerTitle\s*\}\}/gi, escapeHtml(headerTitle))
      .replace(/\{\{\s*header_title\s*\}\}/gi, escapeHtml(headerTitle))
      .replace(/\{\{\s*footer\s*\}\}/gi, footerContent)
      .replace(/\{\{\s*footerText\s*\}\}/gi, footerContent)
      .replace(/\{\{\s*brandColor\s*\}\}/gi, brandColor)
      .replace(/\{\{\s*date\s*\}\}/gi, nowStr)
      .replace(/\{\{\s*subject\s*\}\}/gi, "Re: Pertanyaan Layanan");

    if (!/\{\{\s*content\s*\}\}/i.test(template.customHtml)) {
      custom += `<div style="max-width: 600px; margin: 20px auto; padding: 20px; font-family: sans-serif;">${sampleBodyHtml}</div>`;
    }

    return custom;
  }

  const badgeHtml = headerBadge && headerBadge.trim().length > 0
    ? `<span style="display: inline-block; margin-left: 8px; font-size: 11px; font-weight: 600; color: ${brandColor}; background-color: #eff6ff; border: 1px solid #bfdbfe; padding: 2px 8px; border-radius: 9999px; vertical-align: middle;">${escapeHtml(headerBadge.trim())}</span>`
    : "";

  if (preset === "minimal") {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px 16px;">
    <div style="padding-bottom: 12px; margin-bottom: 18px; border-bottom: 1px solid #e5e7eb;">
      <span style="font-size: 16px; font-weight: 700; color: #111827;">${escapeHtml(headerTitle)}</span>
      ${badgeHtml}
    </div>
    <div style="margin-bottom: 24px;">${sampleBodyHtml}</div>
    <div style="padding-top: 12px; border-top: 1px solid #f3f4f6;">
      <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">${footerContent}</p>
    </div>
  </div>
</body>
</html>`;
  }

  if (preset === "formal") {
    const dateFormatted = new Date().toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; padding: 24px 8px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 640px; background-color: #ffffff; border: 1px solid #cbd5e1; border-top: 4px solid ${brandColor};">
          <tr>
            <td style="padding: 18px 24px; border-bottom: 1px solid #e2e8f0;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <span style="font-size: 16px; font-weight: 700; color: #0f172a;">${escapeHtml(headerTitle)}</span>
                    ${badgeHtml}
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="font-size: 12px; color: #64748b;">${dateFormatted}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="padding: 24px 24px 16px 24px;">${sampleBodyHtml}</td></tr>
          <tr>
            <td style="padding: 16px 24px; background-color: #f1f5f9; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.5;">${footerContent}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // Default "card"
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6; padding: 24px 8px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);">
          <tr>
            <td style="padding: 16px 20px; border-bottom: 1px solid #f1f5f9;">
              <span style="font-size: 16px; font-weight: 700; color: #0f172a;">${escapeHtml(headerTitle)}</span>
              ${badgeHtml}
            </td>
          </tr>
          <tr><td style="padding: 20px 20px 14px 20px;">${sampleBodyHtml}</td></tr>
          <tr>
            <td style="padding: 14px 20px; background-color: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">${footerContent}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
