import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const lines = stdout.split(/\r?\n/);
  
  // Skip header line if present
  let startIndex = 0;
  if (lines.length > 0 && (lines[0].includes("provider") || lines[0].includes("model"))) {
    startIndex = 1;
  }
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse format: "provider   model   context  max-out  thinking  images"
    // Split by 2+ spaces to handle the columnar format
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    
    const provider = parts[0].trim();
    const model = parts[1].trim();
    
    if (!provider || !model) continue;
    if (provider === "provider" && model === "model") continue; // Skip header
    
    const id = `${provider}/${model}`;
    parsed.push({ id, label: id });
  }
  
  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function resolvePiCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_PI_COMMAND === "string" &&
    process.env.PAPERCLIP_PI_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_PI_COMMAND.trim()
      : "pi";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

function extractCustomProviderModels(rawProviders: string | undefined): AdapterModel[] {
  if (!rawProviders) return [];
  try {
    const parsed = JSON.parse(rawProviders);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const models: AdapterModel[] = [];
    for (const [providerName, providerConfig] of Object.entries(parsed)) {
      if (
        providerConfig &&
        typeof providerConfig === "object" &&
        Array.isArray((providerConfig as any).models)
      ) {
        for (const m of (providerConfig as any).models) {
          const modelId = typeof m === "string" ? m.trim() : asString(m?.id, "").trim();
          if (modelId) {
            const label =
              typeof m === "object" && m && (m.name || m.label)
                ? asString(m.name || m.label, modelId)
                : modelId;
            models.push({ id: `${providerName}/${modelId}`, label: `${providerName}/${label}` });
            models.push({ id: modelId, label });
          }
        }
      }
    }
    return models;
  } catch {
    return [];
  }
}

export async function discoverPiModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });
  const customModels = extractCustomProviderModels(
    runtimeEnv.PAPERCLIP_PI_PROVIDERS ?? process.env.PAPERCLIP_PI_PROVIDERS,
  );

  try {
    const result = await runChildProcess(
      `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["--list-models"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 20,
        graceSec: 3,
        onLog: async () => {},
      },
    );

    if (result.timedOut) {
      if (customModels.length > 0) return sortModels(dedupeModels(customModels));
      throw new Error("`pi --list-models` timed out.");
    }
    if ((result.exitCode ?? 1) !== 0) {
      if (customModels.length > 0) return sortModels(dedupeModels(customModels));
      const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
      throw new Error(detail ? `\`pi --list-models\` failed: ${detail}` : "`pi --list-models` failed.");
    }

    // Pi outputs model list to stderr, but fall back to stdout for older versions
    const output = result.stderr || result.stdout;
    const parsedCli = parseModelsOutput(output);
    return sortModels(dedupeModels([...customModels, ...parsedCli]));
  } catch (err) {
    if (customModels.length > 0) return sortModels(dedupeModels(customModels));
    throw err;
  }
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverPiModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverPiModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export function normalizePiModelId(model: string, availableModels?: AdapterModel[]): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  if (availableModels?.some((m) => m.id === trimmed)) return trimmed;
  if (availableModels) {
    const matching = availableModels.find((m) => {
      const slashIdx = m.id.indexOf("/");
      if (slashIdx !== -1 && m.id.slice(slashIdx + 1) === trimmed) return true;
      return false;
    });
    if (matching) return matching.id;
  }
  if (trimmed.startsWith("custom/")) {
    const withoutCustom = trimmed.slice("custom/".length);
    if (availableModels?.some((m) => m.id === withoutCustom)) return withoutCustom;
  } else {
    const withCustom = `custom/${trimmed}`;
    if (availableModels?.some((m) => m.id === withCustom)) return withCustom;
  }
  if (trimmed.startsWith("cmd/")) {
    const candidate = `rissets/${trimmed}`;
    if (!availableModels || availableModels.some((m) => m.id === candidate)) {
      return candidate;
    }
  }
  return trimmed;
}

export async function ensurePiModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const rawModel = asString(input.model, "").trim();
  if (!rawModel) {
    throw new Error("Pi requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverPiModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error("Pi returned no models. Run `pi --list-models` and verify provider auth.");
  }

  const model = normalizePiModelId(rawModel, models);

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured Pi model is unavailable: ${rawModel}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listPiModels(): Promise<AdapterModel[]> {
  try {
    return await discoverPiModelsCached();
  } catch {
    return [];
  }
}

export function resetPiModelsCacheForTests() {
  discoveryCache.clear();
}

export async function syncCustomPiModels(input: {
  endpoint: string;
  apiKey?: string;
}): Promise<AdapterModel[]> {
  const rawEndpoint = asString(input.endpoint, "").trim();
  if (!rawEndpoint) {
    throw new Error("Custom API endpoint is required.");
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, "");
  const apiKey = asString(input.apiKey, "").trim();

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const urlsToTry: string[] = [];
  if (baseUrl.endsWith("/models")) {
    urlsToTry.push(baseUrl);
  } else {
    urlsToTry.push(`${baseUrl}/models`);
    if (!baseUrl.endsWith("/v1")) {
      urlsToTry.push(`${baseUrl}/v1/models`);
    }
  }

  let lastError: Error | null = null;
  for (const url of urlsToTry) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed (${response.status}): check your API token.`);
        }
        if (response.status === 404 && urlsToTry.indexOf(url) < urlsToTry.length - 1) {
          continue;
        }
        const text = await response.text().catch(() => "");
        throw new Error(`API endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const json = await response.json();
      const extracted: AdapterModel[] = [];

      if (json && typeof json === "object" && Array.isArray((json as any).data)) {
        for (const item of (json as any).data) {
          const id = asString(item?.id, "").trim();
          if (id) {
            const label = asString(item?.name, id).trim() || id;
            extracted.push({ id, label });
          }
        }
      } else if (json && typeof json === "object" && Array.isArray((json as any).models)) {
        for (const item of (json as any).models) {
          const id = asString(item?.name || item?.model || item?.id, "").trim();
          if (id) {
            extracted.push({ id, label: id });
          }
        }
      } else if (Array.isArray(json)) {
        for (const item of json) {
          const id = typeof item === "string" ? item.trim() : asString(item?.id || item?.name, "").trim();
          if (id) {
            extracted.push({ id, label: typeof item === "object" && item?.name ? item.name : id });
          }
        }
      }

      if (extracted.length === 0) {
        throw new Error("No models found in endpoint response.");
      }

      const dedupled = sortModels(dedupeModels(extracted));
      try {
        await savePiProviderToHost({
          endpoint: baseUrl,
          apiKey,
          models: dedupled,
        });
      } catch {
        // ignore save error
      }

      return dedupled;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Failed to connect to the custom API endpoint.");
}

export interface PiConnection {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  modelsCount: number;
  models: AdapterModel[];
}

export async function savePiProviderToHost(input: {
  endpoint: string;
  apiKey?: string;
  models: AdapterModel[];
  providerName?: string;
}): Promise<string> {
  const hostDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const modelsPath = path.join(hostDir, "models.json");
  const baseUrl = input.endpoint.replace(/\/+$/, "");

  let data: any = { providers: {} };
  try {
    const raw = await fs.readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") data = parsed;
    if (!data.providers || typeof data.providers !== "object") data.providers = {};
  } catch {
    // initialize new object
  }

  let targetProviderKey = "";
  if (input.providerName && data.providers[input.providerName]) {
    targetProviderKey = input.providerName;
  } else {
    for (const [key, p] of Object.entries(data.providers as Record<string, any>)) {
      if (p && typeof p === "object" && typeof p.baseUrl === "string") {
        const pBase = p.baseUrl.replace(/\/+$/, "");
        if (pBase === baseUrl) {
          targetProviderKey = key;
          break;
        }
      }
    }
  }

  if (!targetProviderKey) {
    if (input.providerName) {
      targetProviderKey = input.providerName;
    } else {
      try {
        const u = new URL(baseUrl);
        const hostParts = u.hostname.split(".");
        targetProviderKey = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : "custom";
      } catch {
        targetProviderKey = "custom";
      }
      if (data.providers[targetProviderKey] && data.providers[targetProviderKey].baseUrl !== baseUrl) {
        targetProviderKey = `custom-${Date.now().toString(36)}`;
      }
    }
  }

  const existingProvider = data.providers[targetProviderKey] || {};
  const existingModels: any[] = Array.isArray(existingProvider.models) ? existingProvider.models : [];
  const existingModelIds = new Set(existingModels.map((m: any) => m.id || m.name));

  const newModels = [...existingModels];
  for (const m of input.models) {
    if (!existingModelIds.has(m.id)) {
      newModels.push({
        id: m.id,
        name: m.label || m.id,
        reasoning: true,
        input: ["text"],
      });
      existingModelIds.add(m.id);
    }
  }

  data.providers[targetProviderKey] = {
    ...existingProvider,
    baseUrl,
    api: existingProvider.api || "openai-completions",
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    models: newModels,
  };

  try {
    await fs.mkdir(hostDir, { recursive: true });
    await fs.writeFile(modelsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    discoveryCache.clear();
  } catch {
    // ignore
  }

  return targetProviderKey;
}

export async function listExistingPiConnections(): Promise<PiConnection[]> {
  const hostDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const modelsPath = path.join(hostDir, "models.json");
  const connections: PiConnection[] = [];

  try {
    const raw = await fs.readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      for (const [providerId, config] of Object.entries(parsed.providers as Record<string, any>)) {
        if (!config || typeof config !== "object") continue;
        const baseUrl = asString(config.baseUrl, "");
        const modelsList: AdapterModel[] = [];
        if (Array.isArray(config.models)) {
          for (const m of config.models) {
            const rawId = asString(m?.id || m?.name, "");
            if (rawId) {
              const label = asString(m?.name || m?.label, rawId);
              modelsList.push({
                id: `${providerId}/${rawId}`,
                label: label !== rawId ? `${label} (${providerId})` : `${rawId} (${providerId})`,
              });
            }
          }
        }
        connections.push({
          id: providerId,
          name: providerId,
          baseUrl,
          hasApiKey: !!(config.apiKey && String(config.apiKey).trim().length > 0),
          modelsCount: Array.isArray(config.models) ? config.models.length : 0,
          models: dedupeModels(modelsList),
        });
      }
    }
  } catch {
    // models.json not present
  }

  const envProvidersRaw = process.env.PAPERCLIP_PI_PROVIDERS;
  if (envProvidersRaw) {
    try {
      const parsedEnv = JSON.parse(envProvidersRaw);
      if (parsedEnv && typeof parsedEnv === "object" && !Array.isArray(parsedEnv)) {
        for (const [providerId, config] of Object.entries(parsedEnv as Record<string, any>)) {
          if (!config || typeof config !== "object") continue;
          if (connections.some((c) => c.id === providerId)) continue;
          const baseUrl = asString(config.baseUrl, "");
          const modelsList: AdapterModel[] = [];
          if (Array.isArray(config.models)) {
            for (const m of config.models) {
              const rawId = asString(m?.id || m?.name, "");
              if (rawId) {
                const label = asString(m?.name || m?.label, rawId);
                modelsList.push({
                  id: `${providerId}/${rawId}`,
                  label: label !== rawId ? `${label} (${providerId})` : `${rawId} (${providerId})`,
                });
              }
            }
          }
          connections.push({
            id: providerId,
            name: providerId,
            baseUrl,
            hasApiKey: !!(config.apiKey && String(config.apiKey).trim().length > 0),
            modelsCount: Array.isArray(config.models) ? config.models.length : 0,
            models: dedupeModels(modelsList),
          });
        }
      }
    } catch {}
  }

  return connections;
}

