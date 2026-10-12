import { describe, it, expect } from "vitest";
import { formatEmailHtml } from "./email-formatter.js";

describe("formatEmailHtml", () => {
  it("renders default modern card preset with markdown formatting", () => {
    const html = formatEmailHtml("Hello **world**\n\n- Item 1\n- Item 2", {
      senderName: "Support Bot",
    });

    expect(html).toContain("Support Bot");
    expect(html).toContain("AI Assistant");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain('<li style="margin-bottom: 6px;">Item 1</li>');
    expect(html).toContain("Dijawab otomatis oleh <strong>Support Bot</strong>");
  });

  it("renders minimal preset without card borders", () => {
    const html = formatEmailHtml("This is minimal", {
      senderName: "Minimal Bot",
      template: {
        preset: "minimal",
        brandColor: "#059669",
        headerTitle: "Quick Help",
        headerBadge: null,
      },
    });

    expect(html).toContain("Quick Help");
    expect(html).not.toContain("AI Assistant");
    expect(html).toContain("This is minimal");
  });

  it("renders formal corporate preset with letterhead and date", () => {
    const html = formatEmailHtml("Formal message content", {
      senderName: "Director",
      template: {
        preset: "formal",
        brandColor: "#7c3aed",
        headerTitle: "Official Response",
        headerBadge: "Verified",
        footerText: "Confidential • PT Lokakara Solusi Mandiri",
      },
    });

    expect(html).toContain("Official Response");
    expect(html).toContain("Verified");
    expect(html).toContain("Confidential • PT Lokakara Solusi Mandiri");
    expect(html).toContain("#7c3aed");
  });

  it("renders custom HTML template with tag replacements", () => {
    const customTemplate = `
      <div class="custom-wrapper">
        <h1>{{headerTitle}}</h1>
        <div class="body">{{content}}</div>
        <p class="signature">{{footer}}</p>
      </div>
    `;

    const html = formatEmailHtml("Custom *content* here", {
      senderName: "Custom Bot",
      template: {
        preset: "custom",
        headerTitle: "My Custom Header",
        footerText: "Custom Footer for {senderName}",
        customHtml: customTemplate,
      },
    });

    expect(html).toContain("<h1>My Custom Header</h1>");
    expect(html).toContain("<em>content</em>");
    expect(html).toContain("Custom Footer for Custom Bot");
  });

  it("falls back to card when custom preset has empty HTML", () => {
    const html = formatEmailHtml("Fallback test", {
      senderName: "Fallback Bot",
      template: {
        preset: "custom",
        customHtml: "   ",
      },
    });

    expect(html).toContain("Fallback Bot");
    expect(html).toContain("Fallback test");
  });
});
