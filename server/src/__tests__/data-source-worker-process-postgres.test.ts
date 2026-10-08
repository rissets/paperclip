import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, dataSourceJobs, dataSourceQueryJobs, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DataSourceQueryJobsService } from "../services/data-source-query-jobs.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("standalone datasource worker PostgreSQL process", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let child: ChildProcess | undefined;
  let home: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-worker-process-");
    home = mkdtempSync(path.join(tmpdir(), "paperclip-worker-home-"));
  }, 90_000);
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await temporary?.cleanup();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("claims durable jobs in a separate process and exits on SIGTERM", async () => {
    const db = createDb(temporary.connectionString);
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const querySourceId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Process test", issuePrefix: "WPROC" });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "Process source", sourceType: "csv", status: "processing" });
    const externalUrl = new URL(temporary.connectionString);
    await db.insert(dataSources).values({
      id: querySourceId,
      companyId,
      name: "Process external query source",
      sourceType: "postgres",
      status: "ready",
      metadata: { rawConfig: {
        type: "postgres",
        host: externalUrl.hostname,
        port: Number(externalUrl.port),
        database: decodeURIComponent(externalUrl.pathname.slice(1)),
        username: decodeURIComponent(externalUrl.username),
        password: decodeURIComponent(externalUrl.password),
        ssl: false,
      } },
    });
    await db.insert(dataSourceJobs).values({ id: jobId, companyId, dataSourceId: sourceId, jobType: "ingest_file", maxAttempts: 1, idempotencyKey: jobId });
    const queryJob = await new DataSourceQueryJobsService(db).enqueue({
      companyId,
      dataSourceId: querySourceId,
      sql: "SELECT 1 AS value LIMIT 1",
      rowLimit: 1,
      actor: { type: "board", id: "process-test" },
    });
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    child = spawn(process.execPath, ["--import", path.join(serverRoot, "node_modules/tsx/dist/loader.mjs"), path.join(serverRoot, "src/datasource-worker.ts")], {
      cwd: home,
      env: { ...process.env, DATABASE_URL: temporary.connectionString, PAPERCLIP_HOME: home,
        PAPERCLIP_CONFIG: path.join(home, "config.json"), PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(home, "master.key"),
        DATASOURCE_WORKER_POLL_MS: "100", DATASOURCE_WORKER_HEALTH_PORT: String(port),
        TYPESAFE_API_KEY: "" },
      stdio: "ignore",
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok).catch(() => false);
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(healthy).toBe(true);
    let job;
    for (let i = 0; i < 50; i++) {
      [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
      if (job?.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(job).toMatchObject({ status: "failed", attempt: 1, leaseOwner: null });
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.status).toBe("error");
    let queryState: typeof dataSourceQueryJobs.$inferSelect | undefined;
    for (let i = 0; i < 100; i++) {
      [queryState] = await db.select().from(dataSourceQueryJobs).where(eq(dataSourceQueryJobs.id, queryJob.id));
      if (queryState?.status === "succeeded" || queryState?.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(queryState?.status, queryState?.lastError || "query worker did not finish").toBe("succeeded");
    expect(queryState?.result).toMatchObject({ columns: ["value"], rows: [{ value: 1 }], rowCount: 1 });
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
  }, 60_000);

  it("lets a new worker take over a durable lease after the owning process is hard-killed", async () => {
    const db = createDb(temporary.connectionString);
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hard-kill takeover", issuePrefix: `K${companyId.slice(0, 7)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External source", sourceType: "postgres", status: "ready" });
    await db.insert(dataSourceJobs).values({
      id: jobId,
      companyId,
      dataSourceId: sourceId,
      jobType: "external_db_snapshot",
      status: "queued",
      maxAttempts: 2,
      progress: {},
      idempotencyKey: jobId,
    });

    const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
    const loader = path.join(serverRoot, "node_modules/tsx/dist/loader.mjs");
    const claimantScript = [
      'import { createDb } from "@paperclipai/db";',
      'import { DataSourceIngestionWorker } from "./src/services/data-source-ingestion-worker.ts";',
      'const worker = new DataSourceIngestionWorker(createDb(process.env.DATABASE_URL), "external_db_snapshot");',
      'const job = await worker.claim();',
      'process.stdout.write(JSON.stringify({ id: job?.id, attempt: job?.attempt, owner: worker.owner }) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", claimantScript], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: temporary.connectionString },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let claimBuffer = "";
    const claimed = await new Promise<{ id: string; attempt: number; owner: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`child did not claim the job: ${claimBuffer}`)), 10_000);
      child!.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child!.stdout!.on("data", (chunk: Buffer) => {
        claimBuffer += chunk.toString("utf8");
        const newline = claimBuffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        resolve(JSON.parse(claimBuffer.slice(0, newline)) as { id: string; attempt: number; owner: string });
      });
    });
    expect(claimed).toMatchObject({ id: jobId, attempt: 1 });
    const crashedChild = child;
    const crashed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      crashedChild.once("exit", (code, signal) => resolve({ code, signal }));
    });
    crashedChild.kill("SIGKILL");
    expect(await crashed).toEqual({ code: null, signal: "SIGKILL" });

    await db.update(dataSourceJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(dataSourceJobs.id, jobId));
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    child = spawn(process.execPath, ["--import", loader, path.join(serverRoot, "src/datasource-worker.ts")], {
      cwd: home,
      env: { ...process.env, DATABASE_URL: temporary.connectionString, PAPERCLIP_HOME: home,
        PAPERCLIP_CONFIG: path.join(home, "config.json"), PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(home, "master.key"),
        DATASOURCE_WORKER_POLL_MS: "100", DATASOURCE_WORKER_HEALTH_PORT: String(port), TYPESAFE_API_KEY: "" },
      stdio: "ignore",
    });
    let job;
    for (let i = 0; i < 100; i++) {
      [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
      if (job?.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(job).toMatchObject({ status: "failed", attempt: 2, leaseOwner: null });
    expect(job.lastError).toContain("bounded table selection");
    const replacementChild = child;
    const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      replacementChild!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    replacementChild!.kill("SIGTERM");
    expect(await stopped).toEqual({ code: 0, signal: null });
  }, 30_000);
});
