import { useState, useId } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { aiConnectionsApi } from "@/api/ai-connections";
import { createAiConnectionSchema, type AiProviderRouting } from "@paperclipai/shared";

export function CustomEndpointConnectionForm({
  companyId,
  defaultName = "Custom Gateway",
  defaultProtocol = "chat",
  showProtocol = false,
  onCancel,
  onComplete,
}: {
  companyId: string;
  defaultName?: string;
  defaultProtocol?: AiProviderRouting["protocol"];
  showProtocol?: boolean;
  onCancel: () => void;
  onComplete: (result: {
    connectionId: string;
    grantId: string;
    model?: string;
  }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<AiProviderRouting["protocol"]>(defaultProtocol);
  const [model, setModel] = useState("");
  const [syncedModels, setSyncedModels] = useState<Array<{ id: string; label: string }>>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const modelDatalistId = useId();

  const handleSync = async () => {
    if (!baseUrl.trim()) return;
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const res = await aiConnectionsApi.syncEndpointModels(companyId, {
        endpoint: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      const list = res.models ?? [];
      setSyncedModels(list);
      if (list.length > 0) {
        setSyncMessage(`Found ${list.length} model${list.length === 1 ? "" : "s"}`);
        if (!model && list[0]) {
          setModel(list[0].id);
        }
      } else {
        setSyncMessage("No models detected at endpoint");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to sync models from endpoint";
      setSyncError(msg);
    } finally {
      setSyncing(false);
    }
  };

  const handleSave = async () => {
    if (!baseUrl.trim()) {
      setSaveError("Endpoint URL is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const selectedModel = model.trim();
      const modelsList = selectedModel
        ? [{ id: selectedModel }]
        : syncedModels.length > 0
          ? syncedModels.map((m) => ({ id: m.id }))
          : [{ id: "default" }];

      const payload = createAiConnectionSchema.parse({
        provider: protocol === "messages" ? "anthropic" : "openai",
        method: "api_key",
        name: name.trim() || defaultName,
        ownership: "shared",
        allAgents: true,
        agentIds: [],
        apiKey: apiKey.trim() || "none",
        routing: {
          kind: "gateway",
          protocol,
          auth: apiKey.trim() ? "bearer" : "none",
          baseUrl: baseUrl.trim(),
          models: modelsList,
        },
      });

      const res = await aiConnectionsApi.create(companyId, payload);
      onComplete({
        connectionId: res.connectionId,
        grantId: res.grantId,
        model: selectedModel || modelsList[0]?.id,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create connection";
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">Connection name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Endpoint URL / Base URL</label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1 or https://my-gateway/v1"
        />
        <p className="text-xs text-muted-foreground">
          OpenAI or Ollama compatible endpoint
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">API Key (optional)</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Leave blank if no authentication is required"
        />
      </div>

      {showProtocol && (
        <div className="space-y-1">
          <label className="text-sm font-medium">Protocol</label>
          <Select
            value={protocol}
            onValueChange={(val) => setProtocol(val as AiProviderRouting["protocol"])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">OpenAI Chat (/v1/chat/completions)</SelectItem>
              <SelectItem value="responses">OpenAI Responses</SelectItem>
              <SelectItem value="messages">Anthropic Messages (/v1/messages)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1">
        <label className="text-sm font-medium">Model ID</label>
        <div className="flex gap-2">
          <Input
            value={model}
            list={modelDatalistId}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. llama3, qwen-2.5, gpt-4o-mini…"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleSync}
            disabled={syncing || !baseUrl.trim()}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin mr-1.5" />
            ) : (
              <RefreshCw className="size-4 mr-1.5" />
            )}
            Sync models
          </Button>
        </div>
        <datalist id={modelDatalistId}>
          {syncedModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
        {syncMessage && (
          <p className="text-xs text-muted-foreground">{syncMessage}</p>
        )}
        {syncError && (
          <p role="alert" className="text-xs text-destructive">{syncError}</p>
        )}
      </div>

      {saveError && (
        <p role="alert" className="text-sm text-destructive">{saveError}</p>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={saving || !baseUrl.trim()}
          onClick={handleSave}
        >
          {saving ? "Connecting…" : "Connect endpoint"}
        </Button>
      </div>
    </div>
  );
}
