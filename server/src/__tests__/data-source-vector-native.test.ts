import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, companies, createDb, dataSourceChunks, dataSourceChunkEmbeddings, dataSourceGatewayChunkEmbeddings, dataSources } from "@paperclipai/db";
import { DataSourceVectorStore } from "../services/data-source-vector-store.js";

// Opt-in against the isolated Compose verification database, never a live app DB.
const url = process.env.DATASOURCE_INTEGRATION_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/paperclip_datasource_verification") {
    throw new Error("Native vector tests require a loopback paperclip_datasource_verification database");
  }
}
(url ? describe : describe.skip)("datasource native pgvector integration", () => {
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const sourceId = randomUUID();
  const otherSourceId = randomUUID();
  const foreignSourceId = randomUUID();
  const unit = (dimensions: number, axis = 0) => Array.from({ length: dimensions }, (_, i) => i === axis ? 1 : 0);

  beforeAll(async () => {
    await applyPendingMigrations(url!);
    db = createDb(url!);
    const extension = Array.from(await db.execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`));
    expect(extension).toHaveLength(1);
    await db.insert(companies).values([
      { id: companyId, name: "Native vector test", issuePrefix: `V${companyId.slice(0, 8)}` },
      { id: foreignCompanyId, name: "Foreign vector test", issuePrefix: `V${foreignCompanyId.slice(0, 8)}` },
    ]);
    await db.insert(dataSources).values([
      { id: sourceId, companyId, name: "Scoped corpus", sourceType: "rag_document", status: "ready" },
      { id: otherSourceId, companyId, name: "Other corpus", sourceType: "rag_document", status: "ready" },
      { id: foreignSourceId, companyId: foreignCompanyId, name: "Foreign corpus", sourceType: "rag_document", status: "ready" },
    ]);
  }, 90_000);
  afterAll(async () => {
    if (db) {
      await db.delete(companies).where(inArray(companies.id, [companyId, foreignCompanyId]));
      await db.$client.end({ timeout: 1 });
    }
  });

  it("stores both dimensions natively, uses HNSW, and restricts company/source retrieval", async () => {
    const store = new DataSourceVectorStore(db);
    const values = [
      { companyId, dataSourceId: sourceId, chunkIndex: 0, content: "nearest", embedding: unit(1024), metadata: { embeddingSpace: "bge-m3" } },
      { companyId, dataSourceId: sourceId, chunkIndex: 1, content: "orthogonal", embedding: unit(1024, 1), metadata: { embeddingSpace: "bge-m3" } },
      { companyId, dataSourceId: sourceId, chunkIndex: 2, content: "gateway", embedding: unit(1536), metadata: { embeddingSpace: "openrouter-text-embedding-3-small" } },
      { companyId, dataSourceId: otherSourceId, chunkIndex: 3, content: "other-source", embedding: unit(1024), metadata: { embeddingSpace: "bge-m3" } },
      { companyId: foreignCompanyId, dataSourceId: foreignSourceId, chunkIndex: 4, content: "foreign", embedding: unit(1024), metadata: { embeddingSpace: "bge-m3" } },
    ];
    await store.insertChunks(values);
    const chunks = await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    expect(chunks.every(chunk => chunk.embedding === null)).toBe(true);
    const bge = await db.select().from(dataSourceChunkEmbeddings).where(and(eq(dataSourceChunkEmbeddings.companyId, companyId), eq(dataSourceChunkEmbeddings.dataSourceId, sourceId)));
    const gateway = await db.select().from(dataSourceGatewayChunkEmbeddings).where(eq(dataSourceGatewayChunkEmbeddings.dataSourceId, sourceId));
    expect(bge).toHaveLength(2);
    expect(bge[0].embedding).toHaveLength(1024);
    expect(gateway).toHaveLength(1);
    expect(gateway[0].embedding).toHaveLength(1536);
    const found = await store.search({ companyId, dataSourceIds: [sourceId], embeddingSpace: "bge-m3", embeddingGeneration: "bge-m3", vector: unit(1024), limit: 10 });
    expect(found?.size).toBe(2);
    expect([...found!.keys()][0]).toBe(chunks.find(chunk => chunk.content === "nearest")!.id);
    const gatewayFound = await store.search({ companyId, dataSourceIds: [sourceId], embeddingSpace: "openrouter-text-embedding-3-small", embeddingGeneration: "openrouter-text-embedding-3-small", vector: unit(1536), limit: 10 });
    expect([...gatewayFound!.keys()]).toEqual([gateway[0].chunkId]);
    const foreign = await store.search({ companyId, dataSourceIds: [foreignSourceId], embeddingSpace: "bge-m3", embeddingGeneration: "bge-m3", vector: unit(1024), limit: 10 });
    expect(foreign?.size).toBe(0);
    const plans = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`EXPLAIN SELECT chunk_id FROM data_source_chunk_embeddings WHERE embedding_space = 'bge-m3' ORDER BY embedding <=> ${JSON.stringify(unit(1024))}::vector LIMIT 2`);
    });
    expect(JSON.stringify(plans)).toContain("data_source_chunk_embeddings_bge_hnsw_idx");
  });

  it("keeps model revisions isolated inside the same vector dimension", async () => {
    const store = new DataSourceVectorStore(db);
    await store.insertChunks([{
      companyId,
      dataSourceId: sourceId,
      chunkIndex: 90,
      content: "same BGE dimension, first model revision",
      embedding: unit(1024),
      metadata: { embeddingSpace: "bge-m3", embeddingGeneration: "bge-m3@revision-one" },
    }]);
    const chunkRows = await db.select().from(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    const chunk = chunkRows.find(row => row.chunkIndex === 90);
    await db.insert(dataSourceChunkEmbeddings).values({
      chunkId: chunk!.id,
      companyId,
      dataSourceId: sourceId,
      embeddingSpace: "bge-m3",
      embeddingGeneration: "bge-m3@revision-two",
      embedding: unit(1024, 1),
    });

    const firstRevision = await store.search({
      companyId,
      dataSourceIds: [sourceId],
      embeddingSpace: "bge-m3",
      embeddingGeneration: "bge-m3@revision-one",
      vector: unit(1024),
      limit: 10,
    });
    const secondRevision = await store.search({
      companyId,
      dataSourceIds: [sourceId],
      embeddingSpace: "bge-m3",
      embeddingGeneration: "bge-m3@revision-two",
      vector: unit(1024, 1),
      limit: 10,
    });
    expect(firstRevision?.get(chunk!.id)).toBeCloseTo(1);
    expect(secondRevision?.get(chunk!.id)).toBeCloseTo(1);
    const rows = await db.select().from(dataSourceChunkEmbeddings).where(eq(dataSourceChunkEmbeddings.chunkId, chunk!.id));
    expect(rows.map(row => row.embeddingGeneration).sort()).toEqual([
      "bge-m3@revision-one",
      "bge-m3@revision-two",
    ]);
  });

  it("rolls back chunk insertion on invalid vector dimensions and cascades sidecar deletion", async () => {
    const store = new DataSourceVectorStore(db);
    await expect(store.insertChunks([{ companyId, dataSourceId: sourceId, chunkIndex: 10, content: "invalid-vector", embedding: [1, 0], metadata: { embeddingSpace: "bge-m3" } }])).rejects.toThrow("1024");
    const invalid = await db.select().from(dataSourceChunks).where(and(eq(dataSourceChunks.dataSourceId, sourceId), eq(dataSourceChunks.chunkIndex, 10)));
    expect(invalid).toHaveLength(0);
    await db.delete(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, sourceId));
    expect(await db.select().from(dataSourceChunkEmbeddings).where(eq(dataSourceChunkEmbeddings.dataSourceId, sourceId))).toHaveLength(0);
    expect(await db.select().from(dataSourceGatewayChunkEmbeddings).where(eq(dataSourceGatewayChunkEmbeddings.dataSourceId, sourceId))).toHaveLength(0);
  });
});
