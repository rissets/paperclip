import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const enabled = process.env.DATASOURCE_REDIS_ADMISSION_INTEGRATION === "true";
if (enabled) {
  const url = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Redis query-admission integration accepts loopback Redis only");
  }
}

(enabled ? describe : describe.skip)("datasource query admission across Redis-connected processes", () => {
  it("enforces the same source concurrency limit across independent Node processes", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "paperclip-query-admission-"));
    const marker = path.join(temp, "events");
    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    const sourceKey = "integration/company/source/" + randomUUID();
    const runner = [
      "import { appendFileSync } from 'node:fs';",
      "const { ExternalQueryAdmission } = await import('./src/services/external-query-admission.ts');",
      "const { shutdownDataSourceCache } = await import('./src/services/data-source-cache.ts');",
      "const delay = ms => new Promise(resolve => setTimeout(resolve, ms));",
      "try {",
      "  if (process.env.ADMISSION_ID === 'second') await delay(100);",
      "  const admission = new ExternalQueryAdmission(1, 1, 3000);",
      "  await admission.run(process.env.ADMISSION_SOURCE, async () => {",
      "    appendFileSync(process.env.ADMISSION_MARKER, process.env.ADMISSION_ID + ':start:' + Date.now() + '\\n');",
      "    await delay(process.env.ADMISSION_ID === 'first' ? 900 : 10);",
      "    appendFileSync(process.env.ADMISSION_MARKER, process.env.ADMISSION_ID + ':end:' + Date.now() + '\\n');",
      "  });",
      "} catch { process.exitCode = 2; }",
      "finally { await shutdownDataSourceCache(); }",
    ].join("\n");

    try {
      const run = (id: "first" | "second") => new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--import", path.join(serverRoot, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", runner,
        ], {
          cwd: serverRoot,
          env: {
            ...process.env,
            ADMISSION_ID: id,
            ADMISSION_MARKER: marker,
            ADMISSION_SOURCE: sourceKey,
          },
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? -1));
      });

      expect(await Promise.all([run("first"), run("second")])).toEqual([0, 0]);
      const events = readFileSync(marker, "utf8").trim().split("\n").map((line) => {
        const [id, event, timestamp] = line.split(":");
        return { id, event, timestamp: Number(timestamp) };
      });
      const firstEnd = events.find((event) => event.id === "first" && event.event === "end")!;
      const secondStart = events.find((event) => event.id === "second" && event.event === "start")!;
      expect(firstEnd.timestamp).toBeLessThanOrEqual(secondStart.timestamp);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
