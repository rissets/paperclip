import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

export function getWhatsAppSessionDir(companyId: string, endpointId: string): string {
  return path.join(process.cwd(), "data", "whatsapp-sessions", companyId, endpointId);
}

export function hasWhatsAppSession(companyId: string, endpointId: string): boolean {
  const sessionDir = getWhatsAppSessionDir(companyId, endpointId);
  const credsPath = path.join(sessionDir, "creds.json");
  return fsSync.existsSync(credsPath);
}

export async function initWhatsAppAuthState(companyId: string, endpointId: string) {
  const sessionDir = getWhatsAppSessionDir(companyId, endpointId);
  await fs.mkdir(sessionDir, { recursive: true });
  return await useMultiFileAuthState(sessionDir);
}

export async function clearWhatsAppAuthState(companyId: string, endpointId: string): Promise<void> {
  const sessionDir = getWhatsAppSessionDir(companyId, endpointId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // Ignore error if directory doesn't exist
  }
}
