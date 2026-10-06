import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, dataSourceChunks, dataSourceJobs, dataSources, dataSourceTables } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const pipeline = vi.hoisted(() => vi.fn());
vi.mock("../services/onboarding-orchestrator.js", () => ({ OnboardingOrchestratorService: class { executeOnboardingPipeline(...args: unknown[]) { return pipeline(...args); } } }));
import { DataSourcesService } from "../services/data-sources.js";
import { assertDataSourceJobLease, completeDataSourceJobLease, DataSourceLeaseLostError } from "../services/data-source-job-lease.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource publication PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource reprocess transaction fencing", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtureDir: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-publication-");
    db = createDb(temporary.connectionString);
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-datasource-fixture-"));
    fs.writeFileSync(path.join(fixtureDir, "orders.csv"), "id\n1\n", { mode: 0o600 });
  }, 90_000);
  beforeEach(async () => { pipeline.mockReset(); await db.delete(companies); });
  afterAll(async () => { await temporary?.cleanup(); if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); });
  async function seed() {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Publish test", issuePrefix: `F${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "Orders", sourceType: "csv", fileName: "orders.csv", storagePath: path.join(fixtureDir, "orders.csv"), status: "ready", metadata: { semanticProfile: { generation: "old" } } });
    await db.insert(dataSourceTables).values({ companyId, dataSourceId: sourceId, tableName: "old", schemaDefinition: [] });
    await db.insert(dataSourceJobs).values({ id: jobId, companyId, dataSourceId: sourceId, jobType: "ingest_file", status: "running", attempt: 1, leaseOwner: "first-worker", leaseExpiresAt: new Date(Date.now() + 60_000), idempotencyKey: randomUUID() });
    return { companyId, sourceId, jobId, lease: { jobId, owner: "first-worker", attempt: 1 } };
  }
  async function stage(companyId: string, sourceId: string, name: string) {
    await db.insert(dataSourceTables).values({ companyId, dataSourceId: sourceId, tableName: name, schemaDefinition: [] });
    await db.insert(dataSourceChunks).values({ companyId, dataSourceId: sourceId, chunkIndex: 0, content: name });
  }

  it("commits published source and successful job together", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    pipeline.mockImplementation(async (_company, source) => {
      await stage(companyId, sourceId, "replacement");
      return { metadata: { ...source.metadata, semanticProfile: { generation: "new" } } };
    });
    await new DataSourcesService(db).reprocess(companyId, sourceId, lease);
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(source.status).toBe("ready");
    expect(source.metadata?.semanticProfile).toEqual({ generation: "new" });
    expect(source.metadata).not.toHaveProperty("reprocessingToken");
    expect(job.status).toBe("succeeded");
    expect(job.leaseOwner).toBeNull();
    const tables = await db.select().from(dataSourceTables).where(eq(dataSourceTables.dataSourceId, sourceId));
    expect(tables.map((table) => table.tableName)).toEqual(["replacement"]);
  });

  it("passes the durable CSV cursor from the claimed job into the retry pipeline", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    const csvCheckpoint = {
      version: 1,
      identityHash: "a".repeat(64),
      tableId: randomUUID(),
      byteOffset: 9_876,
      committedRows: 1_000,
      nextBatchIndex: 1,
      delimiter: ";",
    };
    await db.update(dataSourceJobs).set({ progress: { csvCheckpoint } }).where(eq(dataSourceJobs.id, jobId));
    pipeline.mockImplementation(async (_company, source, _file, options) => {
      expect((options as any).jobLease.progress.csvCheckpoint).toEqual(csvCheckpoint);
      await stage(companyId, sourceId, "replacement");
      return { metadata: source.metadata };
    });

    await new DataSourcesService(db).reprocess(companyId, sourceId, {
      ...lease,
      progress: { csvCheckpoint },
    });
    expect(pipeline).toHaveBeenCalledOnce();
  });

  it("passes a large local XLSX by path so reprocessing does not allocate a workbook-sized Buffer", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const workbookPath = path.join(fixtureDir, "large-workbook.xlsx");
    const fileSize = 8 * 1024 * 1024 + 1;
    const descriptor = fs.openSync(workbookPath, "w");
    fs.ftruncateSync(descriptor, fileSize);
    fs.closeSync(descriptor);
    await db.insert(companies).values({ id: companyId, name: "Large workbook test", issuePrefix: `W${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "Large workbook",
      sourceType: "excel",
      fileName: "large-workbook.xlsx",
      storagePath: workbookPath,
      fileSize,
      status: "ready",
      metadata: { storageBackend: "local" },
    });
    await db.insert(dataSourceJobs).values({
      id: jobId,
      companyId,
      dataSourceId: sourceId,
      jobType: "ingest_file",
      status: "running",
      attempt: 1,
      leaseOwner: "first-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: randomUUID(),
    });
    pipeline.mockImplementation(async (_company, source, file) => {
      expect(file.filePath).toBe(workbookPath);
      expect(file.buffer).toBeUndefined();
      expect(file.size).toBe(fileSize);
      return { metadata: source.metadata };
    });

    await new DataSourcesService(db).reprocess(companyId, sourceId, {
      jobId,
      owner: "first-worker",
      attempt: 1,
    });
    expect(pipeline).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])("denies stale %s publication/rollback and preserves the successor's staging", async (outcome) => {
    const { companyId, sourceId, jobId, lease } = await seed();
    let started!: () => void;
    let resume!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    pipeline.mockImplementation(async (_company, source) => {
      started(); await resumed;
      if (outcome === "failure") throw new Error("Old pipeline failure");
      return { metadata: { ...source.metadata, semanticProfile: { generation: "stale" } } };
    });
    const old = new DataSourcesService(db).reprocess(companyId, sourceId, lease);
    const denied = expect(old).rejects.toBeInstanceOf(DataSourceLeaseLostError);
    await began;
    await db.update(dataSourceJobs).set({ attempt: 2, leaseOwner: "successor", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(dataSourceJobs.id, jobId));
    await db.update(dataSources).set({ metadata: { reprocessingToken: "successor-token", semanticProfile: { generation: "successor" } } }).where(eq(dataSources.id, sourceId));
    await stage(companyId, sourceId, "successor-stage");
    resume(); await denied;
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.metadata?.reprocessingToken).toBe("successor-token");
    expect(source.metadata?.semanticProfile).toEqual({ generation: "successor" });
    const tables = await db.select().from(dataSourceTables).where(eq(dataSourceTables.dataSourceId, sourceId));
    expect(tables.map((table) => table.tableName).sort()).toEqual(["old", "successor-stage"]);
    const chunks = await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    expect(chunks.map((chunk) => chunk.content)).toEqual(["successor-stage"]);
  });

  it("rolls back owned failed staging while retaining the published data", async () => {
    const { companyId, sourceId, lease } = await seed();
    pipeline.mockImplementation(async () => { await stage(companyId, sourceId, "failed-stage"); throw new Error("Extraction failed"); });
    await expect(new DataSourcesService(db).reprocess(companyId, sourceId, lease)).rejects.toThrow("Extraction failed");
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.status).toBe("ready");
    expect(source.metadata?.semanticProfile).toEqual({ generation: "old" });
    const tables = await db.select().from(dataSourceTables).where(eq(dataSourceTables.dataSourceId, sourceId));
    expect(tables.map((table) => table.tableName)).toEqual(["old"]);
  });

  it("denies an expired attempt before the ingestion pipeline starts", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    await db.update(dataSourceJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(dataSourceJobs.id, jobId));
    await expect(new DataSourcesService(db).reprocess(companyId, sourceId, lease)).rejects.toBeInstanceOf(DataSourceLeaseLostError);
    expect(pipeline).not.toHaveBeenCalled();
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.status).toBe("ready");
    expect(source.metadata?.semanticProfile).toEqual({ generation: "old" });
  });

  it("rolls back publication when real time expires inside the transaction", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    await expect(db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, sourceId, lease);
      await tx.execute(sql`UPDATE data_source_jobs SET lease_expires_at = clock_timestamp() + interval '100 milliseconds' WHERE id = ${jobId}`);
      await tx.update(dataSources).set({ metadata: { semanticProfile: { generation: "must-not-publish" } } }).where(eq(dataSources.id, sourceId));
      await tx.execute(sql`SELECT pg_sleep(0.2)`);
      await completeDataSourceJobLease(tx, companyId, sourceId, lease);
    })).rejects.toBeInstanceOf(DataSourceLeaseLostError);
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(source.metadata?.semanticProfile).toEqual({ generation: "old" });
    expect(job.status).toBe("running");
  });
});
