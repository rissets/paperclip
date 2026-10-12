import { useState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Eye, EyeOff, Sparkles, Check } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import {
  EMAIL_PRESET_OPTIONS,
  EMAIL_COLOR_SWATCHES,
  generateEmailPreviewHtml,
} from "@/lib/emailTemplate";
import type { EmailTemplateConfiguration } from "@paperclipai/shared";

export function EmailTemplateSettings({
  endpoint,
  pending,
  onSave,
}: {
  endpoint: ChatEndpoint;
  pending: boolean;
  onSave: (template: EmailTemplateConfiguration) => Promise<void>;
}) {
  const current = endpoint.setup?.emailTemplate;
  const [preset, setPreset] = useState<"card" | "minimal" | "formal" | "custom">(
    current?.preset || "card",
  );
  const [brandColor, setBrandColor] = useState(current?.brandColor || "");
  const [headerTitle, setHeaderTitle] = useState(current?.headerTitle || "");
  const [headerBadge, setHeaderBadge] = useState<string>(
    current?.headerBadge !== undefined && current?.headerBadge !== null
      ? current.headerBadge
      : "AI Assistant",
  );
  const [footerText, setFooterText] = useState(current?.footerText || "");
  const [customHtml, setCustomHtml] = useState(current?.customHtml || "");

  const [showPreview, setShowPreview] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = useId();

  const isDirty =
    preset !== (current?.preset || "card") ||
    brandColor !== (current?.brandColor || "") ||
    headerTitle !== (current?.headerTitle || "") ||
    headerBadge !== (current?.headerBadge ?? "AI Assistant") ||
    footerText !== (current?.footerText || "") ||
    customHtml !== (current?.customHtml || "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setSaved(false);

    try {
      await onSave({
        preset,
        brandColor: brandColor.trim() || null,
        headerTitle: headerTitle.trim() || null,
        headerBadge: headerBadge.trim() || null,
        footerText: footerText.trim() || null,
        customHtml: customHtml.trim() || null,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save template settings");
    }
  };

  const previewConfig: EmailTemplateConfiguration = {
    preset,
    brandColor: brandColor.trim() || null,
    headerTitle: headerTitle.trim() || null,
    headerBadge: headerBadge.trim() || null,
    footerText: footerText.trim() || null,
    customHtml: customHtml.trim() || null,
  };

  const previewHtml = generateEmailPreviewHtml(
    previewConfig,
    endpoint.botLabel || endpoint.assignedAgentName || "Data Agent",
  );

  return (
    <form onSubmit={handleSave} className="space-y-6 rounded-lg border border-border p-5 bg-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Email Branding & Template
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure how outbound email replies are formatted and branded when sent to customers.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowPreview(!showPreview)}
          className="gap-1.5"
        >
          {showPreview ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {showPreview ? "Hide Preview" : "Live Preview"}
        </Button>
      </div>

      {showPreview && (
        <Card className="border border-border overflow-hidden">
          <div className="bg-muted px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border flex items-center justify-between">
            <span>Email Client Preview</span>
            <span className="text-muted-foreground/70">Responsive HTML</span>
          </div>
          <CardContent className="p-0">
            <iframe
              title="Email Preview"
              srcDoc={previewHtml}
              className="w-full h-80 border-0 bg-background"
              sandbox="allow-same-origin"
            />
          </CardContent>
        </Card>
      )}

      {/* Preset Picker */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold">Layout Preset</Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {EMAIL_PRESET_OPTIONS.map((opt) => {
            const isSelected = preset === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setPreset(opt.id);
                  setSaved(false);
                }}
                className={`flex flex-col text-left p-3 rounded-md border text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/5 text-foreground font-medium"
                    : "border-border bg-background hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                <span className="font-semibold text-foreground flex items-center justify-between">
                  {opt.label}
                  {isSelected && <Check className="size-3 text-primary" />}
                </span>
                <span className="text-muted-foreground text-xs mt-1 leading-snug line-clamp-2">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Preset Custom HTML Editor */}
      {preset === "custom" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${id}-customHtml`} className="text-xs font-semibold">
              Custom HTML Template
            </Label>
            <span className="text-xs text-muted-foreground">
              Tags: {"{{content}}"}, {"{{senderName}}"}, {"{{footer}}"}, {"{{date}}"}
            </span>
          </div>
          <Textarea
            id={`${id}-customHtml`}
            value={customHtml}
            onChange={(e) => {
              setCustomHtml(e.target.value);
              setSaved(false);
            }}
            placeholder={`<!DOCTYPE html>\n<html>\n<body>\n  <header><h1>{{headerTitle}}</h1></header>\n  <main>{{content}}</main>\n  <footer>{{footer}}</footer>\n</body>\n</html>`}
            rows={8}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            The Agent markdown response will replace {"{{content}}"}. Standard inline CSS will be applied for email client compatibility.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Brand Color */}
          <div className="space-y-2">
            <Label htmlFor={`${id}-brandColor`} className="text-xs font-semibold">
              Brand Accent Color
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${id}-brandColor`}
                value={brandColor}
                onChange={(e) => {
                  setBrandColor(e.target.value);
                  setSaved(false);
                }}
                placeholder="Hex color code"
                className="font-mono text-xs max-w-xs"
              />
              <div className="flex items-center gap-1">
                {EMAIL_COLOR_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.name}
                    type="button"
                    title={swatch.name}
                    onClick={() => {
                      setBrandColor(swatch.value);
                      setSaved(false);
                    }}
                    className="size-6 rounded-full border border-border flex items-center justify-center transition-transform hover:scale-110"
                    style={{ backgroundColor: swatch.value }}
                  >
                    {brandColor === swatch.value && <Check className="size-3 text-primary-foreground" />}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Used for links, callout blockquote border, and badges.
            </p>
          </div>

          {/* Header Title */}
          <div className="space-y-2">
            <Label htmlFor={`${id}-headerTitle`} className="text-xs font-semibold">
              Header Display Name
            </Label>
            <Input
              id={`${id}-headerTitle`}
              value={headerTitle}
              onChange={(e) => {
                setHeaderTitle(e.target.value);
                setSaved(false);
              }}
              placeholder={`Default: ${endpoint.botLabel || endpoint.assignedAgentName || "Agent"}`}
              className="text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Displayed at the top of the email template.
            </p>
          </div>

          {/* Header Badge */}
          <div className="space-y-2">
            <Label htmlFor={`${id}-headerBadge`} className="text-xs font-semibold">
              Badge Label
            </Label>
            <Input
              id={`${id}-headerBadge`}
              value={headerBadge}
              onChange={(e) => {
                setHeaderBadge(e.target.value);
                setSaved(false);
              }}
              placeholder="AI Assistant (leave blank to hide)"
              className="text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Shown next to the header title. Leave empty to hide badge.
            </p>
          </div>

          {/* Footer Text */}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={`${id}-footerText`} className="text-xs font-semibold">
              Custom Footer / Signature
            </Label>
            <Textarea
              id={`${id}-footerText`}
              value={footerText}
              onChange={(e) => {
                setFooterText(e.target.value);
                setSaved(false);
              }}
              placeholder={`Default: Dijawab otomatis oleh {senderName} • Paperclip Control Plane`}
              rows={2}
              className="text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Disclaimers, privacy policy, or signature. You can use {"{senderName}"} and {"{headerTitle}"}.
            </p>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
        <div>
          {saved && !isDirty && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Check className="size-3.5 text-primary" /> Template saved successfully.
            </span>
          )}
        </div>
        <Button type="submit" disabled={!isDirty || pending} size="sm">
          {pending ? "Saving..." : "Save Template Settings"}
        </Button>
      </div>
    </form>
  );
}
