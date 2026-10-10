import { createServer } from "node:http";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { DataSourceWorkerRuntime } from "./services/data-source-worker-runtime.js";
import { validateDataSourceModelConfig } from "./services/data-source-model-config.js";

function safePollFailureSummary(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (code === "53300" || /too many clients/i.test(message)) return "PostgreSQL connection limit reached";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)) return "database temporarily unavailable";
  if (/timeout|timed out/i.test(message)) return "database poll timed out";
  if (/^[0-9A-Z]{5}$/.test(code)) return `database poll failed (PostgreSQL ${code})`;
  return "database poll failed; error details omitted";
}

function createPollErrorReporter(workerName: string): (error: unknown) => void {
  let previousSummary = "";
  let lastLoggedAt = 0;
  let suppressed = 0;
  return (error) => {
    const summary = safePollFailureSummary(error);
    const now = Date.now();
    if (summary === previousSummary && now - lastLoggedAt < 60_000) {
      suppressed += 1;
      return;
    }
    const repeated = suppressed > 0 ? ` (${suppressed} duplicate poll errors suppressed)` : "";
    console.error(`[${workerName}] ${summary}; retry scheduled${repeated}`);
    previousSummary = summary;
    lastLoggedAt = now;
    suppressed = 0;
  };
}

async function main() {
  const config = loadConfig();
  validateDataSourceModelConfig();
  if (!config.databaseUrl) throw new Error("Standalone datasource worker requires DATABASE_URL");
  process.env.PAPERCLIP_SECRETS_PROVIDER ??= config.secretsProvider;
  process.env.PAPERCLIP_SECRETS_STRICT_MODE ??= String(config.secretsStrictMode);
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??= config.secretsMasterKeyFilePath;
  const pollMs = Number(process.env.DATASOURCE_WORKER_POLL_MS ?? 2000);
  // The local dev server can move from 3100 to 3101 in a worktree when 3100 is
  // already occupied, so keep the standalone worker health endpoint separate.
  const port = Number(process.env.DATASOURCE_WORKER_HEALTH_PORT ?? 3102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid datasource worker health port");
  const db = createDb(config.databaseUrl);
  let runtime: DataSourceWorkerRuntime | undefined;
  let snapshotRuntime: DataSourceWorkerRuntime | undefined;
  let queryRuntime: DataSourceWorkerRuntime | undefined;
  let embeddingRuntime: DataSourceWorkerRuntime | undefined;
  let ingestionWorker: { tick: () => Promise<void>; stop: () => void } | undefined;
  let snapshotWorker: { tick: () => Promise<void>; stop: () => void } | undefined;
  let queryWorker: { tick: () => Promise<void>; stop: () => void } | undefined;
  let embeddingWorker: { tick: () => Promise<void>; stop: () => void } | undefined;
  let externalDbWorker: { tick: () => Promise<void>; stop: () => void } | undefined;
  let externalDbRuntime: DataSourceWorkerRuntime | undefined;
  const healthServer = createServer((req, res) => {
    if (req.url !== "/health" || req.method !== "GET") { res.writeHead(404).end(); return; }
    const ingestion = runtime?.health();
    const snapshots = snapshotRuntime?.health();
    const queries = queryRuntime?.health();
    const embeddings = embeddingRuntime?.health();
    const externalDb = externalDbRuntime?.health();
    const health = {
      ready: Boolean(ingestion?.ready && snapshots?.ready && queries?.ready && embeddings?.ready && externalDb?.ready),
      busy: Boolean(ingestion?.busy || snapshots?.busy || queries?.busy || embeddings?.busy || externalDb?.busy),
      ingestion,
      externalSnapshots: snapshots,
      queryJobs: queries,
      embeddingReindex: embeddings,
      externalDbOnboarding: externalDb,
    };
    res.writeHead(health.ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
  });
  try {
    // API owns migrations. Refuse to start against an unmigrated database.
    await db.execute(sql`SELECT id, lease_owner, attempt FROM data_source_jobs LIMIT 0`);
    await db.execute(sql`SELECT id, storage_upload_id, expected_bytes FROM data_source_upload_sessions LIMIT 0`);
    await db.execute(sql`SELECT id, query_text, query_fingerprint, lease_owner FROM data_source_query_jobs LIMIT 0`);
    const { DataSourceIngestionWorker } = await import("./services/data-source-ingestion-worker.js");
    ingestionWorker = new DataSourceIngestionWorker(db);
    runtime = new DataSourceWorkerRuntime(() => ingestionWorker!.tick(), pollMs, createPollErrorReporter("DatasourceWorker"));
    snapshotWorker = new DataSourceIngestionWorker(db, "external_db_snapshot");
    snapshotRuntime = new DataSourceWorkerRuntime(() => snapshotWorker!.tick(), pollMs, createPollErrorReporter("DatasourceSnapshotWorker"));
    const { DataSourceQueryWorker } = await import("./services/data-source-query-worker.js");
    queryWorker = new DataSourceQueryWorker(db);
    const queryPollMs = Number(process.env.DATASOURCE_QUERY_WORKER_POLL_MS ?? 500);
    queryRuntime = new DataSourceWorkerRuntime(() => queryWorker!.tick(), queryPollMs, createPollErrorReporter("DatasourceQueryWorker"));
    embeddingWorker = new DataSourceIngestionWorker(db, "embedding_reindex");
    embeddingRuntime = new DataSourceWorkerRuntime(() => embeddingWorker!.tick(), pollMs, createPollErrorReporter("DatasourceEmbeddingWorker"));
    externalDbWorker = new DataSourceIngestionWorker(db, "external_db_onboarding");
    externalDbRuntime = new DataSourceWorkerRuntime(() => externalDbWorker!.tick(), pollMs, createPollErrorReporter("DatasourceExternalDbWorker"));
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(port, "0.0.0.0", resolve);
    });
    runtime.start();
    snapshotRuntime.start();
    queryRuntime.start();
    embeddingRuntime.start();
    externalDbRuntime.start();
    console.info("[DatasourceWorker] Started");
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      ingestionWorker?.stop();
      snapshotWorker?.stop();
      queryWorker?.stop();
      embeddingWorker?.stop();
      externalDbWorker?.stop();
      await Promise.all([runtime!.stop(), snapshotRuntime!.stop(), queryRuntime!.stop(), embeddingRuntime!.stop(), externalDbRuntime!.stop()]);
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      const { shutdownDataSourceCache } = await import("./services/data-source-cache.js");
      await shutdownDataSourceCache();
      const { shutdownDatabaseIntegrationPools } = await import("./services/database-integration.js");
      await shutdownDatabaseIntegrationPools();
      await db.$client.end({ timeout: 5 });
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop()
          .then(() => { process.exit(0); })
          .catch(() => process.exit(1));
      });
    }
  } catch (error) {
    ingestionWorker?.stop();
    snapshotWorker?.stop();
    queryWorker?.stop();
    embeddingWorker?.stop();
    externalDbWorker?.stop();
    await Promise.all([runtime?.stop(), snapshotRuntime?.stop(), queryRuntime?.stop(), embeddingRuntime?.stop(), externalDbRuntime?.stop()]);
    healthServer.close();
    const { shutdownDatabaseIntegrationPools } = await import("./services/database-integration.js");
    await shutdownDatabaseIntegrationPools();
    await db.$client.end({ timeout: 1 });
    const errorCode =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
    if (errorCode === "EADDRINUSE") {
      throw new Error(
        `Datasource worker health port ${port} is already in use; another datasource worker may already be running.`,
      );
    }
    throw new Error("Datasource worker startup failed; check database migrations and worker configuration");
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "";
  if (/^Datasource worker health port \d+ is already in use; another datasource worker may already be running\.$/.test(message)) {
    console.error(`[DatasourceWorker] ${message}`);
  } else {
    console.error("[DatasourceWorker] Startup failed; check database migrations and worker configuration");
  }
  process.exitCode = 1;
});
