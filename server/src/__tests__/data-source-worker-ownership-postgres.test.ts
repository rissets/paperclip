import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  dataSourceJobCheckpoints,
  dataSourceJobs,
  dataSources,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS } from "../services/external-database-mapping-checkpoints.js";
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
  beforeEach(async () => {
    pipeline.mockReset();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed(maxAttempts = 3, jobType = "ingest_file", sourceType = "csv") {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker test", issuePrefix: `W${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "CSV", sourceType, status: jobType === "embedding_reindex" ? "ready" : "processing" });
    let specialistAgentId: string | undefined;
    if (jobType === "external_db_onboarding") {
      specialistAgentId = randomUUID();
      await db.insert(agents).values({
        id: specialistAgentId,
        companyId,
        name: "Database Ingestion Agent",
        adapterType: "pi_local",
        adapterConfig: {
          model: "rissets/llm-hd/qwen3.8-27b",
          instructionsFilePath: "/agents/database-ingestion/AGENTS.md",
        },
        metadata: { paperclipBuiltInAgent: { key: "database-ingestion", featureKeys: ["database-ingestion"] } },
      });
    }
    await db.insert(dataSourceJobs).values({ id: jobId, companyId, dataSourceId: sourceId, jobType, idempotencyKey: randomUUID(), maxAttempts });
    if (specialistAgentId) {
      await db.update(dataSourceJobs).set({ progress: { specialistAgentId } }).where(eq(dataSourceJobs.id, jobId));
    }
    return { companyId, sourceId, jobId, specialistAgentId };
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
    const { companyId, sourceId, jobId, specialistAgentId } = await seed(1, "external_db_onboarding", "postgres");
    await db.insert(dataSourceJobCheckpoints).values({
      jobId,
      checkpointType: "external_schema_mapping",
      checkpointKey: "batch-1",
      inputFingerprint: "f".repeat(64),
      payload: { result: { domain: "sales" } },
    });
    expect(EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(110_000);
    pipeline.mockImplementation(async (_companyId: string, _sourceId: string, progress: Record<string, unknown>) => {
      expect(progress).toMatchObject({
        specialistAgentId,
        specialistAgentName: "Database Ingestion Agent",
        agentModel: "rissets/llm-hd/qwen3.8-27b",
        adapterType: "pi_local",
      });
      expect(progress.ingestionRunId).toMatch(/^[0-9a-f-]{36}$/i);
    });

    await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(job).toMatchObject({ companyId, dataSourceId: sourceId, status: "succeeded" });
    expect(await db.select().from(dataSourceJobCheckpoints).where(eq(dataSourceJobCheckpoints.jobId, jobId))).toHaveLength(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({
      agentId: specialistAgentId,
      status: "succeeded",
      runtimeMode: "builtin_ingestion",
      resultJson: { dataSourceId: sourceId, builtInAgentKey: "database-ingestion", stage: "succeeded" },
    });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    expect(events.map((event) => event.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("[START] Database Ingestion Agent"),
      expect.stringContaining("[COMPLETE] Database Ingestion Agent"),
    ]));
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, run.id))).toHaveLength(1);
  }, 30_000);

  it("shows a failed Database Ingestion Agent run when model execution fails", async () => {
    const { companyId, jobId, specialistAgentId } = await seed(1, "external_db_onboarding", "postgres");
    pipeline.mockRejectedValue(new Error("Inference provider returned HTTP 499"));

    await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({
      agentId: specialistAgentId,
      status: "failed",
      runtimeMode: "builtin_ingestion",
      error: "Inference provider returned HTTP 499",
    });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    expect(events.map((event) => event.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("[FAILED] Inference provider returned HTTP 499"),
    ]));
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(job.status).toBe("failed");
  }, 30_000);

  it("refuses to run external database onboarding under a non-database built-in agent", async () => {
    const { companyId, jobId } = await seed(1, "external_db_onboarding", "postgres");
    const wrongAgentId = randomUUID();
    await db.insert(agents).values({ id: wrongAgentId, companyId, name: "Structured Ingestion Agent" });
    await db.update(dataSourceJobs).set({ progress: { specialistAgentId: wrongAgentId } }).where(eq(dataSourceJobs.id, jobId));

    await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

    expect(pipeline).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    expect(job).toMatchObject({ status: "failed", lastError: expect.stringContaining("Database Ingestion Agent") });
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
