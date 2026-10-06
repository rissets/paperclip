import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ publishCompetitor: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: (from: string, to: string) => {
    if (race.publishCompetitor) {
      race.publishCompetitor = false;
      fs.writeFileSync(to, Buffer.alloc(32, 17).toString("base64"), { flag: "wx", mode: 0o600 });
    }
    return fs.linkSync(from, to);
  } };
});
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  race.publishCompetitor = false;
});

describe("shared secret master key publication", () => {
  it("uses the winning process key when another process publishes first", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "paperclip-key-race-"));
    const keyPath = path.join(directory, "master.key");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyPath);
    race.publishCompetitor = true;
    const prepared = await localEncryptedProvider.createSecret({ value: "synthetic-value" } as never);
    const value = await localEncryptedProvider.resolveVersion({ material: prepared.material } as never);
    expect(value).toBe("synthetic-value");
    expect(readFileSync(keyPath, "utf8")).toBe(Buffer.alloc(32, 17).toString("base64"));
    expect(readdirSync(directory)).toEqual(["master.key"]);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("does not replace an existing key when preparing secrets", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "paperclip-key-existing-"));
    const keyPath = path.join(directory, "master.key");
    const key = Buffer.alloc(32, 29).toString("base64");
    writeFileSync(keyPath, key, { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyPath);
    await localEncryptedProvider.createSecret({ value: "synthetic-value" } as never);
    expect(readFileSync(keyPath, "utf8")).toBe(key);
    expect(readdirSync(directory)).toEqual(["master.key"]);
  });
});
