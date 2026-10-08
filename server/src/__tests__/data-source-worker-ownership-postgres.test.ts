import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, dataSourceJobCheckpoints, dataSourceJobs, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const pipeline = vi.hoisted(() => vi.fn());
vi.mock("../services/data-sources.js", () => ({ DataSourcesService: class {
  reprocess(...args: unknown[]) { return pipeline(...args); }
  runExternalDatabaseOnboarding(...args: unknown[]) { return pipeline(...args); }
  runEmbeddingReindex(...args: unknown[]) { return pipeline(...args); }
  reconcilePendingStructuredEmbeddingJobs() { return Promise.resolve({ reconciled: 0 }); }
} }));
import { DataSourceIngestionWorker } from "../services/data-source-ingestion-worker.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource worker PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource worker ownership PostgreSQL integration", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-worker-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => { pipeline.mockReset(); await db.delete(companies); });
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed(maxAttempts = 3, jobType = "ingest_file", sourceType = "csv") {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker test", issuePrefix: `W${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "CSV", sourceType, status: jobType === "embedding_reindex" ? "ready" : "processing" });
    await db.insert(dataSourceJobs).values({ id: jobId, companyId, dataSourceId: sourceId, jobType, idempotencyKey: randomUUID(), maxAttempts });
    return { companyId, sourceId, jobId };
  }

  it("does not let a stale worker failure overwrite a successful successor", async () => {
    const { sourceId, jobId } = await seed();
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let rejectOld!: (error: Error) => void;
    pipeline.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    }).mockImplementationOnce(async () => {
      await db.update(dataSources).set({ status: "ready" }).where(eq(dataSources.id, sourceId));
    });
    const first = new DataSourceIngestionWorker(db).tick();
    await began;
    await db.update(dataSourceJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(dataSourceJobs.id, jobId));
    await new DataSourceIngestionWorker(db).tick();
    rejectOld(new Error("Old attempt failed after takeover"));
    await first;
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(job.status).toBe("succeeded");
    expect(job.attempt).toBe(2);
    expect(job.lastError).toBeNull();
    expect(source.status).toBe("ready");
  }, 30_000);

  it("records a terminal owned failure atomically and redacts credentials", async () => {
    const { sourceId, jobId } = await seed(1);
    pipeline.mockRejectedValue(new Error("Provider failed password=synthetic-test-value"));
    await new DataSourceIngestionWorker(db).tick();
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(job.status).toBe("failed");
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.lastError).not.toContain("synthetic-test-value");
    expect(job.leaseOwner).toBeNull();
    expect(source.status).toBe("error");
  });

  it("persists bounded progress only through the active job lease", async () => {
    const { jobId } = await seed(1);
    pipeline.mockImplementation(async (_companyId: string, _sourceId: string, lease: any) => {
      await lease.reportProgress("clickhouse_insert", {
        insertedRows: 50_000,
        totalRows: 100_000,
        tableName: `${"table".repeat(40)}\nlong-name`,
        currentTable: "analytics.orders",
        currentBatchIndex: 2,
        batchCount: 4,
        completedBatchesCount: 3,
        checkpointStage: "batch_checkpointed",
        schemaFingerprint: "a".repeat(64),
      });
    });

    await new DataSourceIngestionWorker(db).tick();

    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(job).toMatchObject({ status: "succeeded", stage: "completed" });
    expect(job.progress).toMatchObject({ stage: "completed", insertedRows: 50_000, totalRows: 100_000 });
    expect(job.progress).toMatchObject({
      currentTable: "analytics.orders",
      currentBatchIndex: 2,
      batchCount: 4,
      completedBatchesCount: 3,
      checkpointStage: "batch_checkpointed",
      schemaFingerprint: "a".repeat(64),
    });
    expect(String(job.progress.tableName)).toHaveLength(128);
    expect(String(job.progress.tableName)).not.toContain("\n");
  }, 30_000);

  it("removes external schema mapping checkpoints atomically after owned success", async () => {
    const { companyId, sourceId, jobId } = await seed(1, "external_db_onboarding", "postgres");
    await db.insert(dataSourceJobCheckpoints).values({
      jobId,
      checkpointType: "external_schema_mapping",
      checkpointKey: "batch-1",
      inputFingerprint: "f".repeat(64),
      payload: { result: { domain: "sales" } },
    });
    pipeline.mockResolvedValue(undefined);

    await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(job).toMatchObject({ companyId, dataSourceId: sourceId, status: "succeeded" });
    expect(await db.select().from(dataSourceJobCheckpoints).where(eq(dataSourceJobCheckpoints.jobId, jobId))).toHaveLength(0);
  }, 30_000);

  it("dispatches embedding reindex jobs through the resumable worker lane", async () => {
    const { sourceId, jobId } = await seed(3, "embedding_reindex", "rag_document");
    pipeline.mockImplementation(async (_companyId: string, _sourceId: string, _progress: unknown, lease: any) => {
      await lease.reportProgress("embedding_reindex_batch", {
        targetSpace: "openrouter-text-embedding-3-small",
        nextChunkId: randomUUID(),
        processedChunks: 32,
        totalChunks: 40,
        modelBackend: "openrouter",
      });
    });

    await new DataSourceIngestionWorker(db, "embedding_reindex").tick();

    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(job).toMatchObject({ jobType: "embedding_reindex", status: "succeeded", stage: "completed" });
    expect(job.progress).toMatchObject({
      targetSpace: "openrouter-text-embedding-3-small",
      processedChunks: 32,
      totalChunks: 40,
      modelBackend: "openrouter",
      stage: "completed",
    });
    expect(source.status).toBe("ready");
  }, 30_000);

  it("marks the source failed when the final attempt expires without a successor attempt", async () => {
    const { sourceId, jobId } = await seed(1);
    await db.update(dataSourceJobs).set({ status: "running", attempt: 1, leaseOwner: "dead-controller", leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(dataSourceJobs.id, jobId));
    await new DataSourceIngestionWorker(db).tick();
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(job.status).toBe("failed");
    expect(source.status).toBe("error");
    expect(pipeline).not.toHaveBeenCalled();
  });
});
