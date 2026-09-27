import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
} from "./transport-security.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);
const REMOTE_SKILLS_TIMEOUT_MS = 5_000;
const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

type AssignedSkill = {
  key: string;
  markdown: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = normalizedPath === "/" ? "" : normalizedPath;
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, apiPath: string): string {
  return `${baseUrl.toString().replace(/\/+$/, "")}${apiPath}`;
}

function parseExtraHeaders(value: unknown): Record<string, string> {
  const source = typeof value === "string" && value.trim().length > 0
    ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      })()
    : value;
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(parseObject(source))) {
    const key = rawKey.trim();
    if (!key || CRITICAL_HEADERS.has(key.toLowerCase()) || typeof rawValue !== "string") continue;
    headers[key] = rawValue;
  }
  return headers;
}

async function listRemoteHermesSkills(config: Record<string, unknown>): Promise<{
  entries: AdapterSkillEntry[];
  warnings: string[];
}> {
  const apiBaseUrl = asString(config.apiBaseUrl);
  const apiKey = asString(config.apiKey);
  if (!apiBaseUrl || !apiKey) {
    return { entries: [], warnings: [] };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!baseUrl) {
    return { entries: [], warnings: ["Hermes Gateway skill discovery skipped because apiBaseUrl is invalid."] };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(config)) {
    return { entries: [], warnings: ["Hermes Gateway skill discovery skipped because remote plain HTTP is disabled."] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_SKILLS_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(baseUrl, "/v1/skills"), {
      headers: {
        ...parseExtraHeaders(config.headers),
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        entries: [],
        warnings: [`Hermes Gateway skill discovery returned HTTP ${response.status}; remote Hermes skills are not shown.`],
      };
    }

    const payload: unknown = await response.json().catch(() => null);
    const payloadRecord = asRecord(payload);
    const skills = Array.isArray(payload)
      ? payload
      : Array.isArray(payloadRecord?.skills)
        ? payloadRecord.skills
        : null;
    if (!skills) {
      return { entries: [], warnings: ["Hermes Gateway skill discovery returned an unsupported response shape."] };
    }

    const entries = skills.flatMap((raw): AdapterSkillEntry[] => {
      const skill = asRecord(raw);
      const name = asString(skill?.name) ?? asString(skill?.key);
      if (!name) return [];
      const category = asString(skill?.category);
      return [{
        key: name,
        runtimeName: name,
        desired: true,
        managed: false,
        state: "installed",
        origin: "user_installed",
        originLabel: "Hermes Gateway skill",
        locationLabel: category ? `Hermes · ${category}` : "Hermes API server",
        readOnly: true,
        sourcePath: null,
        targetPath: null,
        detail: asString(skill?.description) ?? "Installed on the remote Hermes profile; Paperclip cannot toggle it per agent.",
      }];
    });
    return { entries, warnings: [] };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "timed out"
      : "could not be reached";
    return { entries: [], warnings: [`Hermes Gateway skill discovery ${message}; remote Hermes skills are not shown.`] };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildHermesGatewaySkillSnapshot(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(ctx.config, availableEntries);
  const snapshot = buildRuntimeMountedSkillSnapshot({
    adapterType: "hermes_gateway",
    availableEntries,
    desiredSkills,
    mode: "ephemeral",
    configuredDetail: "Delivered to this remote Hermes agent as per-run instructions; no skill files are installed on the Hermes host.",
    missingDetail: "Paperclip cannot find this skill in the company skills library.",
  });

  const remote = await listRemoteHermesSkills(ctx.config);
  const paperclipNames = new Set(snapshot.entries.flatMap((entry) => [entry.key, entry.runtimeName].filter((name): name is string => Boolean(name))));
  const remoteEntries = remote.entries.filter((entry) => !paperclipNames.has(entry.key));
  return {
    ...snapshot,
    entries: [...snapshot.entries, ...remoteEntries].sort((a, b) => a.key.localeCompare(b.key)),
    warnings: [...snapshot.warnings, ...remote.warnings],
  };
}

export async function listHermesGatewaySkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesGatewaySkillSnapshot(ctx);
}

export async function syncHermesGatewaySkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Agent skill preferences are persisted by Paperclip before this hook runs.
  // Gateway skills are ephemeral: the selected Markdown is sent with each run.
  return buildHermesGatewaySkillSnapshot(ctx);
}

export async function readHermesGatewayAssignedSkills(
  config: Record<string, unknown>,
): Promise<{ skills: AssignedSkill[]; warnings: string[] }> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const entriesByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const skills: AssignedSkill[] = [];
  const warnings: string[] = [];

  for (const key of desiredSkills) {
    const entry = entriesByKey.get(key);
    if (!entry || entry.sourceStatus === "missing") {
      warnings.push(`Assigned Paperclip skill "${key}" is unavailable and was skipped.`);
      continue;
    }
    try {
      const markdown = (await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8")).trim();
      if (markdown) skills.push({ key, markdown });
      else warnings.push(`Assigned Paperclip skill "${key}" has an empty SKILL.md and was skipped.`);
    } catch {
      warnings.push(`Assigned Paperclip skill "${key}" could not be read and was skipped.`);
    }
  }

  return { skills, warnings };
}
