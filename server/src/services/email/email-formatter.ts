import { marked } from "marked";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatEmailHtml(markdownText: string, options?: { senderName?: string }): string {
  const senderName = options?.senderName || "AI Assistant";
  const rawHtml = marked.parse(markdownText, { gfm: true, breaks: true }) as string;

  // Add inline styles for broad email client compatibility (Gmail, Outlook, iOS Mail)
  const styledHtml = rawHtml
    .replace(/<p>/g, '<p style="margin: 0 0 16px 0; line-height: 1.6; color: #374151; font-size: 15px;">')
    .replace(/<h1>/g, '<h1 style="margin: 24px 0 12px 0; color: #111827; font-size: 20px; font-weight: 700; line-height: 1.3;">')
    .replace(/<h2>/g, '<h2 style="margin: 20px 0 10px 0; color: #111827; font-size: 18px; font-weight: 600; line-height: 1.35;">')
    .replace(/<h3>/g, '<h3 style="margin: 16px 0 8px 0; color: #111827; font-size: 16px; font-weight: 600; line-height: 1.4;">')
    .replace(/<ul>/g, '<ul style="margin: 0 0 16px 0; padding-left: 24px; color: #374151; font-size: 15px; line-height: 1.6;">')
    .replace(/<ol>/g, '<ol style="margin: 0 0 16px 0; padding-left: 24px; color: #374151; font-size: 15px; line-height: 1.6;">')
    .replace(/<li>/g, '<li style="margin-bottom: 6px;">')
    .replace(/<blockquote>/g, '<blockquote style="border-left: 4px solid #3b82f6; margin: 16px 0; padding: 10px 16px; background-color: #eff6ff; color: #1e40af; border-radius: 0 6px 6px 0; font-size: 14px;">')
    .replace(/<pre>/g, '<pre style="background-color: #1f2937; color: #f9fafb; padding: 14px 16px; border-radius: 8px; overflow-x: auto; margin: 16px 0; font-size: 13px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">')
    .replace(/<code>/g, '<code style="background-color: #f3f4f6; color: #1f2937; padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">')
    .replace(/<pre style="([^"]+)">\s*<code style="([^"]+)">/g, '<pre style="$1"><code style="background-color: transparent; color: inherit; padding: 0; font-family: inherit;">')
    .replace(/<hr>/g, '<hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;">')
    .replace(/<a /g, '<a style="color: #2563eb; text-decoration: underline;" ')
    .replace(/<table>/g, '<table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">')
    .replace(/<th>/g, '<th style="border: 1px solid #e5e7eb; padding: 8px 12px; background-color: #f9fafb; text-align: left; font-weight: 600; color: #111827;">')
    .replace(/<td>/g, '<td style="border: 1px solid #e5e7eb; padding: 8px 12px; color: #374151;">');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f3f4f6; padding: 28px 12px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);">
          <!-- Header -->
          <tr>
            <td style="padding: 18px 24px; background-color: #ffffff; border-bottom: 1px solid #f1f5f9;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align: middle;">
                    <span style="font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -0.01em;">${escapeHtml(senderName)}</span>
                    <span style="display: inline-block; margin-left: 8px; font-size: 11px; font-weight: 600; color: #2563eb; background-color: #eff6ff; border: 1px solid #bfdbfe; padding: 2px 8px; border-radius: 9999px; vertical-align: middle;">AI Assistant</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 24px 24px 16px 24px; background-color: #ffffff;">
              ${styledHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 16px 24px; background-color: #f8fafc; border-top: 1px solid #f1f5f9; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
                Dijawab otomatis oleh <strong>${escapeHtml(senderName)}</strong> &bull; Paperclip Control Plane
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
