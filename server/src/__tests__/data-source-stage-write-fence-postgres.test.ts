import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, dataSourceChunks, dataSourceJobs, dataSources, dataSourceTables, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { OnboardingOrchestratorService, type OnboardingOptions } from "../services/onboarding-orchestrator.js";
import { DataSourceVectorStore } from "../services/data-source-vector-store.js";
import { DataSourceLeaseLostError } from "../services/data-source-job-lease.js";
// No inference is used: these tests exercise the actual PostgreSQL mutation boundaries.
vi.mock("../services/ai-reasoning.js", () => ({ aiReasoningService: {} }));
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource stage PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource stage write PostgreSQL fencing", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-stage-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => { await db.delete(companies); });
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(); const sourceId = randomUUID(); const jobId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stage test", issuePrefix: `S${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "Documents", sourceType: "rag_document", status: "processing" });
    await db.insert(dataSourceJobs).values({ id: jobId, companyId, dataSourceId: sourceId, jobType: "ingest_file", status: "running", attempt: 1, leaseOwner: "worker-a", leaseExpiresAt: new Date(Date.now() + 60_000), idempotencyKey: randomUUID() });
    return { companyId, sourceId, jobId, lease: { jobId, owner: "worker-a", attempt: 1 } };
  }
  function stageWriter() {
    // The staging wrapper remains an internal API; invoke it to test the transaction with real writes.
    return new OnboardingOrchestratorService(db) as unknown as {
      mutateFileStage<T>(companyId: string, sourceId: string, options: OnboardingOptions, write: (db: Db) => Promise<T>): Promise<T>;
    };
  }

  it("commits owned structured staging and denies a stale callback after takeover", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    const writer = stageWriter();
    await writer.mutateFileStage(companyId, sourceId, { jobLease: lease }, async (tx) => {
      await tx.insert(dataSourceTables).values({ companyId, dataSourceId: sourceId, tableName: "owned-stage", schemaDefinition: [] });
    });
    await db.update(dataSourceJobs).set({ attempt: 2, leaseOwner: "worker-b" }).where(eq(dataSourceJobs.id, jobId));
    const staleWrite = vi.fn(async (tx: Db) => { await tx.insert(dataSourceTables).values({ companyId, dataSourceId: sourceId, tableName: "stale-stage", schemaDefinition: [] }); });
    await expect(writer.mutateFileStage(companyId, sourceId, { jobLease: lease }, staleWrite)).rejects.toBeInstanceOf(DataSourceLeaseLostError);
    expect(staleWrite).not.toHaveBeenCalled();
    const tables = await db.select().from(dataSourceTables).where(eq(dataSourceTables.dataSourceId, sourceId));
    expect(tables.map((table) => table.tableName)).toEqual(["owned-stage"]);
  });

  it("commits owned chunks and denies stale RAG batches after takeover", async () => {
    const { companyId, sourceId, jobId, lease } = await seed();
    const store = new DataSourceVectorStore(db);
    const ownership = { companyId, sourceId, lease };
    await store.insertChunks([{ companyId, dataSourceId: sourceId, chunkIndex: 0, content: "owned passage", embedding: null }], ownership);
    await db.update(dataSourceJobs).set({ attempt: 2, leaseOwner: "worker-b" }).where(eq(dataSourceJobs.id, jobId));
    await expect(store.insertChunks([{ companyId, dataSourceId: sourceId, chunkIndex: 1, content: "stale passage", embedding: null }], ownership)).rejects.toBeInstanceOf(DataSourceLeaseLostError);
    const chunks = await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    expect(chunks.map((chunk) => chunk.content)).toEqual(["owned passage"]);
  });

  it("rejects chunks whose company/source does not match the lease context", async () => {
    const { companyId, sourceId, lease } = await seed();
    await expect(new DataSourceVectorStore(db).insertChunks([{ companyId: randomUUID(), dataSourceId: sourceId, chunkIndex: 0, content: "foreign", embedding: null }], { companyId, sourceId, lease })).rejects.toThrow("company/source ownership");
    expect(await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId))).toHaveLength(0);
  });
});
