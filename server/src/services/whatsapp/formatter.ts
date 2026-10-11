/**
 * WhatsApp message formatter.
 * Converts Markdown formatting to WhatsApp-compatible markup and splits long text.
 */

export function formatMarkdownForWhatsApp(markdown: string): string {
  if (!markdown) return "";

  let text = markdown;

  // Normalize line breaks
  text = text.replace(/\r\n/g, "\n");

  // Headers (# Header) -> *Header*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold (**text** or __text__) -> *text*
  text = text.replace(/(\*\*|__)(.*?)\1/g, "*$2*");

  // Strikethrough (~~text~~) -> ~text~
  text = text.replace(/~~(.*?)~~/g, "~$1~");

  // Bullet points (- or * at line start) -> •
  text = text.replace(/^[\*\-]\s+(.+)$/gm, "• $1");

  // Blockquotes (> text)
  text = text.replace(/^>\s*(.+)$/gm, "> $1");

  return text.trim();
}

/**
 * Splits message text into chunks that do not exceed the maximum character limit (4000 characters).
 * Attempts to break on paragraph or newline boundaries.
 */
export function splitWhatsAppText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = remaining.lastIndexOf(". ", maxLen);
      if (splitIdx !== -1) splitIdx += 1;
    }
    if (splitIdx === -1 || splitIdx < maxLen / 2) {
      splitIdx = maxLen;
    }

    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
