import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Mail,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldCheck,
  Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import {
  emailConnectorApi,
  type EmailTestResult,
} from "@/api/emailConnector";
import type {
  ChatEndpoint,
  ChatEndpointSetupAction,
} from "@/api/chatEndpoints";

export function EmailConnectStep({
  endpoint,
  agentName,
  provider: initialProvider,
  repairing,
  pending,
  onAction,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  provider: "gmail" | "email";
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
}) {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const [provider, setProvider] = useState<"gmail" | "email">(initialProvider);
  const [displayName, setDisplayName] = useState(
    endpoint.botLabel || agentName || "Support Agent",
  );
  const [emailAddress, setEmailAddress] = useState(
    endpoint.botExternalId || "",
  );
  const [appPassword, setAppPassword] = useState("");

  // Custom SMTP settings
  const [smtpHost, setSmtpHost] = useState(
    provider === "gmail" ? "smtp.gmail.com" : "",
  );
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");

  // Custom IMAP settings
  const [sameAsSmtp, setSameAsSmtp] = useState(true);
  const [imapHost, setImapHost] = useState(
    provider === "gmail" ? "imap.gmail.com" : "",
  );
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Sync Gmail defaults when switching to gmail
  const handleSelectProvider = (p: "gmail" | "email") => {
    setProvider(p);
    setTestResult(null);
    setTestError(null);
    if (p === "gmail") {
      setSmtpHost("smtp.gmail.com");
      setSmtpPort(465);
      setSmtpSecure(true);
      setImapHost("imap.gmail.com");
      setImapPort(993);
      setImapSecure(true);
    }
  };

  const effectiveSmtpUser = provider === "gmail" ? emailAddress : smtpUser;
  const effectiveSmtpPass = provider === "gmail" ? appPassword : smtpPassword;
  const effectiveImapUser =
    provider === "gmail"
      ? emailAddress
      : sameAsSmtp
        ? smtpUser
        : imapUser;
  const effectiveImapPass =
    provider === "gmail"
      ? appPassword
      : sameAsSmtp
        ? smtpPassword
        : imapPassword;

  const testMutation = useMutation({
    mutationFn: () => {
      setTestError(null);
      return emailConnectorApi.testConnection(selectedCompanyId!, {
        provider,
        emailAddress: emailAddress.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        smtpSecure,
        smtpUser: effectiveSmtpUser.trim(),
        smtpPassword: effectiveSmtpPass.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecure,
        imapUser: effectiveImapUser.trim(),
        imapPassword: effectiveImapPass.trim(),
      });
    },
    onSuccess: (data) => {
      setTestResult(data);
    },
    onError: (err: Error) => {
      setTestError(err.message || "Gagal melakukan tes koneksi");
    },
  });

  const setupMutation = useMutation({
    mutationFn: () => {
      return emailConnectorApi.setupConnection(selectedCompanyId!, {
        endpointId: endpoint.id,
        provider,
        assignedAgentId: endpoint.assignedAgentId,
        displayName: displayName.trim(),
        emailAddress: emailAddress.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        smtpSecure,
        smtpUser: effectiveSmtpUser.trim(),
        smtpPassword: effectiveSmtpPass.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecure,
        imapUser: effectiveImapUser.trim(),
        imapPassword: effectiveImapPass.trim(),
        pollIntervalSeconds: 30,
      });
    },
    onSuccess: () => {
      onAction("verify");
    },
  });

  const canTest =
    emailAddress.trim().length > 0 &&
    (provider === "gmail"
      ? appPassword.trim().length > 0
      : smtpHost.trim().length > 0 &&
        effectiveSmtpUser.trim().length > 0 &&
        effectiveSmtpPass.trim().length > 0 &&
        imapHost.trim().length > 0 &&
        effectiveImapUser.trim().length > 0 &&
        effectiveImapPass.trim().length > 0);

  const canSubmit = canTest && !testMutation.isPending && !setupMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-xl font-bold">
          Connect {agentName} to {provider === "gmail" ? "Gmail" : "Custom Email"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {provider === "gmail"
            ? "Connect your Gmail or Google Workspace inbox with an App Password. The agent will read incoming customer emails, create tasks, and send replies directly."
            : "Connect any domain email using standard SMTP and IMAP. The agent will automatically process incoming emails and reply to customers."}
        </p>
      </div>

      {/* Provider Selector */}
      <div className="flex gap-2 rounded-lg border border-border p-1">
        <Button
          type="button"
          size="sm"
          variant={provider === "gmail" ? "default" : "ghost"}
          className="flex-1"
          onClick={() => handleSelectProvider("gmail")}
        >
          <Mail className="mr-2 size-4" />
          Gmail / Google Workspace
        </Button>
        <Button
          type="button"
          size="sm"
          variant={provider === "email" ? "default" : "ghost"}
          className="flex-1"
          onClick={() => handleSelectProvider("email")}
        >
          <Server className="mr-2 size-4" />
          Custom Email (SMTP / IMAP)
        </Button>
      </div>

      {/* Gmail Instructions Card */}
      {provider === "gmail" && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 font-medium text-sm text-foreground">
            <ShieldCheck className="size-4 text-(--status-task-done)" />
            <span>Cara membuat Google App Password:</span>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
            <li>
              Buka{" "}
              <a
                href="https://myaccount.google.com/security"
                target="_blank"
                rel="noreferrer"
                className="underline text-foreground inline-flex items-center gap-0.5"
              >
                Google Account Security <ExternalLink className="size-3" />
              </a>{" "}
              dan pastikan <strong>2-Step Verification</strong> sudah aktif.
            </li>
            <li>
              Cari menu <strong>App Passwords</strong> (Sandi Aplikasi).
            </li>
            <li>
              Beri nama (misal: <code>Paperclip Support</code>) dan klik{" "}
              <strong>Create</strong>.
            </li>
            <li>
              Salin kode 16 karakter yang muncul dan tempelkan pada kolom di bawah.
            </li>
          </ol>
        </div>
      )}

      {/* Form Fields */}
      <div className="space-y-4 rounded-lg border border-border bg-card p-5">
        <div className="space-y-2">
          <Label htmlFor="displayName">Display Name</Label>
          <Input
            id="displayName"
            placeholder="Paperclip Support"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="emailAddress">Email Address</Label>
          <Input
            id="emailAddress"
            type="email"
            placeholder={
              provider === "gmail" ? "support@yourdomain.com" : "cs@mycompany.com"
            }
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
          />
        </div>

        {provider === "gmail" ? (
          <div className="space-y-2">
            <Label htmlFor="appPassword">Google App Password (16 characters)</Label>
            <Input
              id="appPassword"
              type="password"
              placeholder="xxxx xxxx xxxx xxxx"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
            />
          </div>
        ) : (
          /* Custom Email Fields */
          <div className="space-y-5 pt-2">
            {/* Outgoing (SMTP) */}
            <div className="space-y-3 rounded-md border border-border p-4">
              <h3 className="font-semibold text-sm text-foreground">
                Outgoing Mail Server (SMTP)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1 sm:col-span-1">
                  <Label htmlFor="smtpHost">SMTP Host</Label>
                  <Input
                    id="smtpHost"
                    placeholder="mail.mycompany.com"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-1">
                  <Label htmlFor="smtpPort">Port</Label>
                  <Input
                    id="smtpPort"
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="smtpSecure"
                  checked={smtpSecure}
                  onCheckedChange={(c) => setSmtpSecure(Boolean(c))}
                />
                <Label htmlFor="smtpSecure" className="text-xs">
                  SSL / TLS (Port 465). Uncheck for STARTTLS (Port 587).
                </Label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="smtpUser">Username</Label>
                  <Input
                    id="smtpUser"
                    placeholder="user@mycompany.com"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="smtpPassword">Password</Label>
                  <Input
                    id="smtpPassword"
                    type="password"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Incoming (IMAP) */}
            <div className="space-y-3 rounded-md border border-border p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-foreground">
                  Incoming Mail Server (IMAP)
                </h3>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="sameAsSmtp"
                    checked={sameAsSmtp}
                    onCheckedChange={(c) => setSameAsSmtp(Boolean(c))}
                  />
                  <Label htmlFor="sameAsSmtp" className="text-xs">
                    Same credentials as SMTP
                  </Label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1 sm:col-span-1">
                  <Label htmlFor="imapHost">IMAP Host</Label>
                  <Input
                    id="imapHost"
                    placeholder="mail.mycompany.com"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-1">
                  <Label htmlFor="imapPort">Port</Label>
                  <Input
                    id="imapPort"
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="imapSecure"
                  checked={imapSecure}
                  onCheckedChange={(c) => setImapSecure(Boolean(c))}
                />
                <Label htmlFor="imapSecure" className="text-xs">
                  SSL / TLS (Port 993)
                </Label>
              </div>

              {!sameAsSmtp && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="imapUser">IMAP Username</Label>
                    <Input
                      id="imapUser"
                      value={imapUser}
                      onChange={(e) => setImapUser(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="imapPassword">IMAP Password</Label>
                    <Input
                      id="imapPassword"
                      type="password"
                      value={imapPassword}
                      onChange={(e) => setImapPassword(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Gmail Advanced Settings Toggle */}
        {provider === "gmail" && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
              <span>Advanced Server Settings</span>
            </button>
            {showAdvanced && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-border p-3 text-xs">
                <div>
                  <Label className="text-xs">SMTP Host & Port</Label>
                  <p className="text-muted-foreground font-mono mt-1">
                    {smtpHost}:{smtpPort} (SSL)
                  </p>
                </div>
                <div>
                  <Label className="text-xs">IMAP Host & Port</Label>
                  <p className="text-muted-foreground font-mono mt-1">
                    {imapHost}:{imapPort} (SSL)
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Live Test Button & Status */}
        <div className="pt-3 border-t border-border flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canTest || testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending && (
                <Loader2 className="mr-2 size-3.5 animate-spin" />
              )}
              Test Connection
            </Button>
            <span className="text-xs text-muted-foreground">
              Verifies outgoing SMTP and incoming IMAP before connecting.
            </span>
          </div>

          {/* Test Results */}
          {testResult && (
            <div
              className={`rounded-md border p-3 text-sm ${
                testResult.success
                  ? "border-(--status-task-done) bg-card"
                  : "border-(--status-task-cancelled) bg-card"
              }`}
            >
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="size-4 text-(--status-task-done)" />
                ) : (
                  <AlertCircle className="size-4 text-(--status-task-cancelled)" />
                )}
                <span className="font-medium text-foreground">
                  {testResult.success
                    ? "Connection verified! SMTP and IMAP are active."
                    : "Connection verification failed."}
                </span>
              </div>
              {!testResult.success && (
                <div className="mt-2 space-y-1 text-xs text-muted-foreground pl-6">
                  {!testResult.smtp.success && (
                    <p>• SMTP: {testResult.smtp.error || "Failed to connect"}</p>
                  )}
                  {!testResult.imap.success && (
                    <p>• IMAP: {testResult.imap.error || "Failed to connect"}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {testError && (
            <div className="rounded-md border border-destructive bg-card p-3 text-xs text-destructive flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              <span>{testError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Form Footer conforming to DESIGN.md */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={setupMutation.isPending}
          onClick={() => navigate("/apps")}
        >
          Save & exit
        </Button>
        <Button
          type="button"
          disabled={!canSubmit || setupMutation.isPending || pending}
          onClick={() => setupMutation.mutate()}
        >
          {setupMutation.isPending && (
            <Loader2 className="mr-2 size-4 animate-spin" />
          )}
          Connect & Finish
        </Button>
      </div>
    </div>
  );
}
