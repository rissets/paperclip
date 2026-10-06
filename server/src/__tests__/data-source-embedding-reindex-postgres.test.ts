import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, dataSourceChunks, dataSourceJobs, dataSources } from "@paperclipai/db";
import type { DataSourceJobLease } from "../services/data-source-job-lease.js";
import { assertDataSourceJobLease } from "../services/data-source-job-lease.js";
import type { EmbeddingSpace } from "../services/rag-models.js";
import { DataSourcesService } from "../services/data-sources.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource embedding reindex PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource embedding reindex PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const sourceId = randomUUID();
  const actor = { actorType: "user" as const, actorId: "embedding-admin" };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-embedding-reindex-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
    await db.insert(companies).values({
      id: companyId,
      name: "Embedding reindex test",
      issuePrefix: `ER${companyId.slice(0, 8)}`,
    });
    await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "RAG corpus",
      sourceType: "rag_document",
      status: "ready",
      metadata: { embeddingSpace: "bge-m3", embeddingBackend: "local-bge-m3", embeddingStatus: "ready" },
    });
    await db.insert(dataSourceChunks).values(Array.from({ length: 40 }, (_, index) => ({
      dataSourceId: sourceId,
      companyId,
      chunkIndex: index,
      title: `Chunk ${index}`,
      content: `A bounded document passage numbered ${index}.`,
      metadata: { embeddingSpace: "bge-m3", embeddingBackend: "local-bge-m3" },
      embedding: null,
    })));
  });
  afterAll(async () => {
    await temporary?.cleanup();
  });

  function makeDependencies(
    model: { embed: ReturnType<typeof vi.fn> },
    initialVectors: Array<{ space: EmbeddingSpace; generation: string; ids: string[] }> = [],
    pruneFixtures: Array<{ embeddingSpace: EmbeddingSpace; embeddingGeneration: string; rowCount: number; lastCreatedAt: string }> = [],
  ) {
    const vectorKey = (space: EmbeddingSpace, generation: string) => `${space}|${generation}`;
    const vectors = new Map<string, Set<string>>();
    const deletedGenerations: string[] = [];
    for (const value of initialVectors) vectors.set(vectorKey(value.space, value.generation), new Set(value.ids));
    const vectorStore = {
      hasEmbeddingSpace: async () => true,
      embeddingCoverage: async (scopeCompanyId: string, scopeSourceId: string, space: EmbeddingSpace, _generation = space, executor: { execute: typeof db.execute } = db) => {
        const result = await executor.execute(sql<{ count: number | string }>`
          SELECT count(*) AS count FROM data_source_chunks
          WHERE company_id = ${scopeCompanyId} AND data_source_id = ${scopeSourceId}
        `);
        const row = Array.from(result as Iterable<{ count: number | string }>)[0];
        return {
          available: true,
          chunkCount: Number(row?.count || 0),
          embeddingCount: vectors.get(vectorKey(space, _generation))?.size || 0,
        };
      },
      upsertChunkEmbeddings: async (values: Array<{ chunkId: string; companyId: string; dataSourceId: string; embeddingSpace: EmbeddingSpace; embedding: number[] }>, ownership: { companyId: string; sourceId: string; lease: DataSourceJobLease }) => {
        await db.transaction(async (tx) => {
          await assertDataSourceJobLease(tx, ownership.companyId, ownership.sourceId, ownership.lease);
          const first = values[0]!;
          const key = vectorKey(first.embeddingSpace, first.embeddingGeneration);
          const target = vectors.get(key) || new Set<string>();
          for (const value of values) target.add(value.chunkId);
          vectors.set(key, target);
        });
      },
      listPrunableGenerations: async (_scopeCompanyId: string, _scopeSourceId: string, cutoff: Date, pinned: Array<{ embeddingSpace: EmbeddingSpace; embeddingGeneration: string }>) => {
        const pinnedKeys = new Set(pinned.map((entry) => `${entry.embeddingSpace}|${entry.embeddingGeneration}`));
        return pruneFixtures.filter((entry) => new Date(entry.lastCreatedAt) < cutoff
          && !pinnedKeys.has(`${entry.embeddingSpace}|${entry.embeddingGeneration}`));
      },
      deleteGenerationRows: async (_scopeCompanyId: string, _scopeSourceId: string, generation: { embeddingSpace: EmbeddingSpace; embeddingGeneration: string }) => {
        deletedGenerations.push(`${generation.embeddingSpace}|${generation.embeddingGeneration}`);
        const fixture = pruneFixtures.find((entry) => entry.embeddingSpace === generation.embeddingSpace
          && entry.embeddingGeneration === generation.embeddingGeneration);
        return fixture?.rowCount || 0;
      },
    };
    const embeddingReindexModels = {
      ...model,
      embeddingGeneration: (space: EmbeddingSpace) => space === "bge-m3"
        ? "bge-m3@test-revision"
        : "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
    };
    const service = new DataSourcesService(db, {
      embeddingReindexStore: vectorStore,
      embeddingReindexModels: embeddingReindexModels as never,
    });
    return { service, vectors, vectorKey, deletedGenerations };
  }

  async function claim(jobId: string, attempt: number, owner: string) {
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
    await db.update(dataSourceJobs).set({
      status: "running",
      stage: "starting",
      attempt,
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(dataSourceJobs.id, jobId));
    let checkpoint = { ...job!.progress };
    const lease: DataSourceJobLease = {
      jobId,
      owner,
      attempt,
      maxAttempts: 3,
      progress: checkpoint,
      reportProgress: async (stage, details = {}) => {
        checkpoint = { ...checkpoint, ...details, stage };
        await db.update(dataSourceJobs).set({ progress: checkpoint, stage }).where(eq(dataSourceJobs.id, jobId));
      },
    };
    return { job: { ...job!, progress: checkpoint }, lease };
  }

  it("resumes a failed batch and switches active retrieval space only after complete coverage", async () => {
    let modelCalls = 0;
    const model = {
      embed: vi.fn(async (texts: string[], space?: EmbeddingSpace) => {
        modelCalls += 1;
        if (modelCalls === 2) throw new Error("temporary embedding gateway outage");
        return {
          vectors: texts.map(() => Array(space === "bge-m3" ? 1024 : 1536).fill(0.25)),
          space: space || "openrouter-text-embedding-3-small",
          generation: space === "bge-m3"
            ? "bge-m3@test-revision"
            : "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
          backend: "openrouter",
        };
      }),
    };
    const { service, vectors, vectorKey } = makeDependencies(model);
    const job = await service.enqueueEmbeddingReindex(companyId, sourceId, "openrouter-text-embedding-3-small", actor);
    const firstAttempt = await claim(job.id, 1, "reindex-worker-1");

    await expect(service.runEmbeddingReindex(companyId, sourceId, firstAttempt.job.progress, firstAttempt.lease))
      .rejects.toThrow("temporary embedding gateway outage");
    const gatewayGeneration = "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small";
    expect(vectors.get(vectorKey("openrouter-text-embedding-3-small", gatewayGeneration))?.size).toBe(32);
    const [stillActive] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(stillActive?.metadata).toMatchObject({ embeddingSpace: "bge-m3", embeddingStatus: "ready" });

    const [persistedJob] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, job.id));
    expect(persistedJob?.progress).toMatchObject({
      processedChunks: 32,
      totalChunks: 40,
      targetGeneration: "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
    });
    expect(typeof persistedJob?.progress.nextChunkId).toBe("string");
    await db.update(dataSourceJobs).set({ status: "queued", stage: "retry_wait", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(dataSourceJobs.id, job.id));
    const secondAttempt = await claim(job.id, 2, "reindex-worker-2");
    await service.runEmbeddingReindex(companyId, sourceId, secondAttempt.job.progress, secondAttempt.lease);

    const [published] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    const [completedJob] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, job.id));
    expect(published?.metadata).toMatchObject({
      embeddingSpace: "openrouter-text-embedding-3-small",
      embeddingGeneration: "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
      embeddingBackend: "openrouter",
      embeddingStatus: "ready",
      previousEmbeddingSpace: "bge-m3",
    });
    expect(completedJob).toMatchObject({ status: "succeeded", stage: "completed" });
    expect(vectors.get(vectorKey("openrouter-text-embedding-3-small", gatewayGeneration))?.size).toBe(40);
    const chunks = await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    expect(chunks.every((chunk) => chunk.metadata?.embeddingSpace === "bge-m3")).toBe(true);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceId));
    expect(audit.map((entry) => entry.action)).toEqual([
      "data_source.embedding_reindex.queued",
      "data_source.embedding_reindex.published",
    ]);
  }, 30_000);

  it("rolls back to a retained complete vector space without calling an embedding model", async () => {
    const chunkRows = await db.select({ id: dataSourceChunks.id }).from(dataSourceChunks)
      .where(eq(dataSourceChunks.dataSourceId, sourceId));
    const retainedBge = chunkRows.map((chunk) => chunk.id);
    const model = {
      embed: vi.fn(async (texts: string[], space?: EmbeddingSpace) => ({
        vectors: texts.map(() => Array(space === "bge-m3" ? 1024 : 1536).fill(0.5)),
        space: space || "openrouter-text-embedding-3-small",
        generation: space === "bge-m3"
          ? "bge-m3@test-revision"
          : "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
        backend: "openrouter",
      })),
    };
    const { service, vectors, vectorKey } = makeDependencies(model, [
      { space: "bge-m3", generation: "bge-m3", ids: retainedBge },
    ]);
    const forwardJob = await service.enqueueEmbeddingReindex(companyId, sourceId, "openrouter-text-embedding-3-small", actor);
    const forwardAttempt = await claim(forwardJob.id, 1, "reindex-forward");
    await service.runEmbeddingReindex(companyId, sourceId, forwardAttempt.job.progress, forwardAttempt.lease);
    const callsAfterForward = model.embed.mock.calls.length;
    expect(vectors.get(vectorKey(
      "openrouter-text-embedding-3-small",
      "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
    ))?.size).toBe(40);

    const rollbackJob = await service.enqueueEmbeddingReindex(companyId, sourceId, "bge-m3", actor, "bge-m3");
    expect(rollbackJob.progress).toMatchObject({ reuseExistingVectors: true, fromSpace: "openrouter-text-embedding-3-small" });
    const rollbackAttempt = await claim(rollbackJob.id, 1, "reindex-rollback");
    await service.runEmbeddingReindex(companyId, sourceId, rollbackAttempt.job.progress, rollbackAttempt.lease);

    const [rolledBack] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(rolledBack?.metadata).toMatchObject({ embeddingSpace: "bge-m3", embeddingBackend: "local-bge-m3" });
    expect(model.embed).toHaveBeenCalledTimes(callsAfterForward);
    expect(vectors.get(vectorKey("bge-m3", "bge-m3"))?.size).toBe(40);
  }, 30_000);

  it("backfills a new model revision within the same vector dimension", async () => {
    await db.update(dataSources).set({ metadata: {
      embeddingSpace: "bge-m3",
      embeddingGeneration: "bge-m3@previous-revision",
      embeddingBackend: "local-bge-m3",
      embeddingStatus: "ready",
    } }).where(eq(dataSources.id, sourceId));
    const model = {
      embed: vi.fn(async (texts: string[], space?: EmbeddingSpace) => ({
        vectors: texts.map(() => Array(1024).fill(0.75)),
        space: space || "bge-m3",
        generation: "bge-m3@test-revision",
        backend: "local-bge-m3",
      })),
    };
    const { service, vectors, vectorKey } = makeDependencies(model, [
      { space: "bge-m3", generation: "bge-m3@previous-revision", ids: (await db.select({ id: dataSourceChunks.id }).from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId))).map((chunk) => chunk.id) },
    ]);
    const job = await service.enqueueEmbeddingReindex(companyId, sourceId, "bge-m3", actor);
    expect(job.progress).toMatchObject({
      fromGeneration: "bge-m3@previous-revision",
      targetGeneration: "bge-m3@test-revision",
      reuseExistingVectors: false,
    });
    const attempt = await claim(job.id, 1, "same-space-revision-worker");
    await service.runEmbeddingReindex(companyId, sourceId, attempt.job.progress, attempt.lease);

    const [published] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(published?.metadata).toMatchObject({ embeddingSpace: "bge-m3", embeddingGeneration: "bge-m3@test-revision" });
    expect(vectors.get(vectorKey("bge-m3", "bge-m3@previous-revision"))?.size).toBe(40);
    expect(vectors.get(vectorKey("bge-m3", "bge-m3@test-revision"))?.size).toBe(40);
  }, 30_000);

  it("pins a gateway alias to its resolved model before resuming the next batch", async () => {
    let calls = 0;
    const resolvedGeneration = "openrouter-text-embedding-3-small@openai/text-embedding-3-small";
    const model = {
      embed: vi.fn(async (texts: string[], space?: EmbeddingSpace) => {
        calls += 1;
        if (calls === 2) throw new Error("injected worker restart after the first batch");
        return {
          vectors: texts.map(() => Array(1536).fill(0.5)),
          space: space || "openrouter-text-embedding-3-small",
          generation: resolvedGeneration,
          backend: "openrouter",
        };
      }),
    };
    const { service, vectors, vectorKey } = makeDependencies(model);
    const job = await service.enqueueEmbeddingReindex(companyId, sourceId, "openrouter-text-embedding-3-small", actor);
    expect(job.progress).toMatchObject({
      targetGeneration: "openrouter-text-embedding-3-small@openrouter/text-embedding-3-small",
      targetGenerationResolved: false,
    });

    const firstAttempt = await claim(job.id, 1, "resolved-model-worker-1");
    await expect(service.runEmbeddingReindex(companyId, sourceId, firstAttempt.job.progress, firstAttempt.lease))
      .rejects.toThrow("injected worker restart after the first batch");
    const [checkpointed] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, job.id));
    expect(checkpointed?.progress).toMatchObject({
      targetGeneration: resolvedGeneration,
      targetGenerationResolved: true,
      processedChunks: 32,
    });
    expect(vectors.get(vectorKey("openrouter-text-embedding-3-small", resolvedGeneration))?.size).toBe(32);
    const [stillPublished] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(stillPublished?.metadata).toMatchObject({ embeddingSpace: "bge-m3", embeddingStatus: "ready" });

    await db.update(dataSourceJobs).set({ status: "queued", stage: "retry_wait", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(dataSourceJobs.id, job.id));
    const secondAttempt = await claim(job.id, 2, "resolved-model-worker-2");
    await service.runEmbeddingReindex(companyId, sourceId, secondAttempt.job.progress, secondAttempt.lease);
    const [published] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(published?.metadata).toMatchObject({ embeddingGeneration: resolvedGeneration, embeddingBackend: "openrouter" });
    expect(vectors.get(vectorKey("openrouter-text-embedding-3-small", resolvedGeneration))?.size).toBe(40);
  }, 30_000);

  it("previews 90-day cleanup, preserves active and rollback generations, then audits explicit deletion", async () => {
    const activeGeneration = "bge-m3@active";
    const rollbackGeneration = "openrouter-text-embedding-3-small@rollback";
    await db.update(dataSources).set({ metadata: {
      embeddingSpace: "bge-m3",
      embeddingGeneration: activeGeneration,
      previousEmbeddingSpace: "openrouter-text-embedding-3-small",
      previousEmbeddingGeneration: rollbackGeneration,
    } }).where(eq(dataSources.id, sourceId));
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const fixtures = [
      { embeddingSpace: "bge-m3" as const, embeddingGeneration: activeGeneration, rowCount: 40, lastCreatedAt: old },
      { embeddingSpace: "openrouter-text-embedding-3-small" as const, embeddingGeneration: rollbackGeneration, rowCount: 40, lastCreatedAt: old },
      { embeddingSpace: "bge-m3" as const, embeddingGeneration: "bge-m3@stale", rowCount: 17, lastCreatedAt: old },
      { embeddingSpace: "openrouter-text-embedding-3-small" as const, embeddingGeneration: "gateway@stale", rowCount: 9, lastCreatedAt: old },
    ];
    const model = { embed: vi.fn() };
    const { service, deletedGenerations } = makeDependencies(model, [], fixtures);

    const preview = await service.pruneEmbeddingGenerations(companyId, sourceId, actor, false);
    expect(preview).toMatchObject({ dryRun: true, retentionDays: 90, candidateVectorRows: 26, deletedRows: 0 });
    expect(preview.candidates.map((entry) => entry.embeddingGeneration)).toEqual(["bge-m3@stale", "gateway@stale"]);
    expect(deletedGenerations).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceId))).toHaveLength(0);
    fixtures.push({
      embeddingSpace: "bge-m3",
      embeddingGeneration: "bge-m3@became-eligible-after-preview",
      rowCount: 5,
      lastCreatedAt: old,
    });

    const deleted = await service.pruneEmbeddingGenerations(companyId, sourceId, actor, true, preview.candidates.map(({ embeddingSpace, embeddingGeneration }) => ({
      embeddingSpace,
      embeddingGeneration,
    })));
    expect(deleted).toMatchObject({ dryRun: false, candidateVectorRows: 26, deletedRows: 26 });
    expect(deletedGenerations).toEqual(["bge-m3|bge-m3@stale", "openrouter-text-embedding-3-small|gateway@stale"]);
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceId));
    expect(audit).toMatchObject({
      action: "data_source.embedding_generations.pruned",
      details: { retentionDays: 90, deletedRows: 26 },
    });
  });

  it("refuses vector cleanup while a datasource job is active", async () => {
    await db.insert(dataSourceJobs).values({
      companyId,
      dataSourceId: sourceId,
      jobType: "embedding_reindex",
      status: "running",
      stage: "embedding",
      idempotencyKey: `active-prune-test:${randomUUID()}`,
    });
    const { service, deletedGenerations } = makeDependencies({ embed: vi.fn() }, [], [
      {
        embeddingSpace: "bge-m3",
        embeddingGeneration: "bge-m3@stale",
        rowCount: 10,
        lastCreatedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    await expect(service.pruneEmbeddingGenerations(companyId, sourceId, actor, true, [
      { embeddingSpace: "bge-m3", embeddingGeneration: "bge-m3@stale" },
    ])).rejects.toThrow("active datasource job");
    expect(deletedGenerations).toEqual([]);
  });
});
