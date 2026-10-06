import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const enabled = process.env.DATASOURCE_REDIS_INTEGRATION === "true";
const testRedisUrl = process.env.DATASOURCE_REDIS_TEST_URL
  || `redis://127.0.0.1:${process.env.DATASOURCE_REDIS_TEST_PORT || "6379"}`;
if (enabled && !["127.0.0.1", "localhost", "::1"].includes(new URL(testRedisUrl).hostname)) {
  throw new Error("Redis process integration accepts loopback Redis only");
}
(enabled ? describe : describe.skip)("datasource Redis cross-process result and retrieval cache", () => {
  it("shares structured-result and scoped RAG candidates between Node processes", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "paperclip-redis-flight-"));
    const marker = path.join(temp, "compute-count");
    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    const runner = [
      "import { appendFileSync } from 'node:fs';",
      "const { DataSourceCacheService, makeDataSourceCacheKey, shutdownDataSourceCache } = await import('./src/services/data-source-cache.ts');",
      "const cache = new DataSourceCacheService();",
      "const kind = process.env.CACHE_KIND;",
      "const parts = JSON.parse(process.env.CACHE_PARTS);",
      "const key = makeDataSourceCacheKey(parts);",
      "const valid = value => value && typeof value === 'object' && value.kind === kind && value.answer === 42;",
      "try {",
      "  const value = await cache.getOrComputeJson(key, valid, 60, async () => {",
      "    appendFileSync(process.env.FLIGHT_MARKER, kind + '\\n');",
      "    await new Promise(resolve => setTimeout(resolve, 900));",
      "    return { kind, answer: 42 };",
      "  });",
      "  if (!valid(value)) process.exitCode = 2;",
      "} catch { process.exitCode = 3; }",
      "finally { await shutdownDataSourceCache(); }",
    ].join("\n");
    try {
      const run = (kind: string, parts: string[]) => new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--import", path.join(serverRoot, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", runner,
        ], {
          cwd: serverRoot,
          env: {
            ...process.env,
            REDIS_URL: testRedisUrl,
            REDIS_HOST: "",
            REDIS_PASSWORD: "",
            CACHE_KIND: kind,
            CACHE_PARTS: JSON.stringify(parts),
            FLIGHT_MARKER: marker,
          },
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? -1));
      });
      const companyId = "cache-process-company";
      const structured = ["structured-query-result", companyId, "acl-a", "source-revision-1", "aggregate-shape"];
      const retrieval = ["rag-retrieval", companyId, "acl-a", "source-revision-1", "bge-m3", "normalized-query"];
      const revokedScope = ["rag-retrieval", companyId, "acl-b", "source-revision-1", "bge-m3", "normalized-query"];
      const results = await Promise.all([
        run("structured", structured), run("structured", structured),
        run("retrieval", retrieval), run("retrieval", retrieval),
        run("retrieval", revokedScope),
      ]);
      expect(results).toEqual([0, 0, 0, 0, 0]);
      expect(readFileSync(marker, "utf8").trim().split("\n").sort()).toEqual(["retrieval", "retrieval", "structured"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
