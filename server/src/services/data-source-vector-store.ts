import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSourceChunkEmbeddings,
  dataSourceChunks,
  dataSourceGatewayChunkEmbeddings,
} from "@paperclipai/db";
import type { EmbeddingSpace } from "./rag-models.js";
import { assertDataSourceJobLease, type DataSourceJobLease } from "./data-source-job-lease.js";

type ChunkInsert = typeof dataSourceChunks.$inferInsert;
type EmbeddedChunkInput = ChunkInsert & { embedding: number[] | null };
type VectorSearchOptions = {
  companyId: string;
  dataSourceIds: string[] | null;
  embeddingSpace: EmbeddingSpace;
  embeddingGeneration: string;
  vector: number[];
  limit: number;
};
export type ReindexVectorInput = {
  chunkId: string;
  companyId: string;
  dataSourceId: string;
  embeddingSpace: EmbeddingSpace;
  embeddingGeneration: string;
  embedding: number[];
};
export type EmbeddingCoverage = { available: boolean; chunkCount: number; embeddingCount: number };
export type PrunableEmbeddingGeneration = {
  embeddingSpace: EmbeddingSpace;
  embeddingGeneration: string;
  rowCount: number;
  lastCreatedAt: string;
};

const BGE_DIMENSIONS = 1024;
const GATEWAY_DIMENSIONS = 1536;
const AVAILABILITY_CACHE_MS = 60_000;
type VectorSpaceAvailability = { bge: boolean; gateway: boolean };

function assertVector(value: number[], dimensions: number, space: string): void {
  if (value.length !== dimensions || !value.every(Number.isFinite)) {
    throw new Error(`Datasource vector for ${space} must contain ${dimensions} finite numbers`);
  }
}

function rowsOf<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>);
}

/**
 * Stores isolated model generations in dimension-specific pgvector sidecars.
 * PGlite and ordinary PostgreSQL installs without pgvector keep JSONB vectors
 * and lexical retrieval until the optional extension migration is available.
 */
export class DataSourceVectorStore {
  private availableUntil = 0;
  private availability: VectorSpaceAvailability = { bge: false, gateway: false };

  constructor(private readonly db: Db) {}

  private async availableSpaces(): Promise<VectorSpaceAvailability> {
    if (Date.now() < this.availableUntil) return this.availability;
    const result = await this.db.execute(sql<{ bgeAvailable: boolean; gatewayAvailable: boolean }>`
      SELECT to_regclass('public.data_source_chunk_embeddings') IS NOT NULL AS "bgeAvailable",
             to_regclass('public.data_source_gateway_chunk_embeddings') IS NOT NULL AS "gatewayAvailable"
    `);
    const row = rowsOf<{ bgeAvailable: boolean; gatewayAvailable: boolean }>(result)[0];
    this.availability = {
      bge: row?.bgeAvailable === true,
      gateway: row?.gatewayAvailable === true,
    };
    this.availableUntil = Date.now() + AVAILABILITY_CACHE_MS;
    return this.availability;
  }

  async hasEmbeddingSpace(space: EmbeddingSpace): Promise<boolean> {
    const available = await this.availableSpaces();
    return space === "bge-m3" ? available.bge : available.gateway;
  }

  async embeddingCoverage(
    companyId: string,
    sourceId: string,
    space: EmbeddingSpace,
    generation: string = space,
    executor: Pick<Db, "execute"> = this.db,
  ): Promise<EmbeddingCoverage> {
    const available = await this.hasEmbeddingSpace(space);
    const table = space === "bge-m3"
      ? sql.raw('"data_source_chunk_embeddings"')
      : sql.raw('"data_source_gateway_chunk_embeddings"');
    const result = await executor.execute(sql<{ chunkCount: number | string; embeddingCount: number | string }>`
      SELECT
        (SELECT count(*) FROM data_source_chunks
         WHERE company_id = ${companyId} AND data_source_id = ${sourceId}) AS "chunkCount",
        ${available
          ? sql`(SELECT count(*) FROM ${table} WHERE company_id = ${companyId} AND data_source_id = ${sourceId} AND embedding_space = ${space} AND embedding_generation = ${generation})`
          : sql`0`} AS "embeddingCount"
    `);
    const row = rowsOf<{ chunkCount: number | string; embeddingCount: number | string }>(result)[0];
    return {
      available,
      chunkCount: Number(row?.chunkCount ?? 0),
      embeddingCount: Number(row?.embeddingCount ?? 0),
    };
  }

  /** List old vector generations except the caller-provided active and rollback pointers. */
  async listPrunableGenerations(
    companyId: string,
    sourceId: string,
    cutoff: Date,
    pinned: Array<{ embeddingSpace: EmbeddingSpace; embeddingGeneration: string }>,
    executor: Pick<Db, "execute"> = this.db,
  ): Promise<PrunableEmbeddingGeneration[]> {
    const available = await this.availableSpaces();
    const candidates: PrunableEmbeddingGeneration[] = [];
    const pinnedKeys = new Set(pinned.map((item) => `${item.embeddingSpace}\0${item.embeddingGeneration}`));
    const spaces: Array<{ space: EmbeddingSpace; table: ReturnType<typeof sql.raw>; enabled: boolean }> = [
      { space: "bge-m3", table: sql.raw('"data_source_chunk_embeddings"'), enabled: available.bge },
      { space: "openrouter-text-embedding-3-small", table: sql.raw('"data_source_gateway_chunk_embeddings"'), enabled: available.gateway },
    ];

    for (const { space, table, enabled } of spaces) {
      if (!enabled) continue;
      const result = await executor.execute(sql<{
        embeddingGeneration: string;
        rowCount: number | string;
        lastCreatedAt: Date | string;
      }>`
        SELECT embedding_generation AS "embeddingGeneration",
               count(*) AS "rowCount",
               max(created_at) AS "lastCreatedAt"
        FROM ${table}
        WHERE company_id = ${companyId}
          AND data_source_id = ${sourceId}
          AND embedding_space = ${space}
        GROUP BY embedding_generation
        HAVING max(created_at) < ${cutoff}
      `);
      for (const row of rowsOf<{ embeddingGeneration: string; rowCount: number | string; lastCreatedAt: Date | string }>(result)) {
        if (pinnedKeys.has(`${space}\0${row.embeddingGeneration}`)) continue;
        candidates.push({
          embeddingSpace: space,
          embeddingGeneration: row.embeddingGeneration,
          rowCount: Number(row.rowCount),
          lastCreatedAt: row.lastCreatedAt instanceof Date ? row.lastCreatedAt.toISOString() : new Date(row.lastCreatedAt).toISOString(),
        });
      }
    }
    return candidates;
  }

  /** Delete one already-reviewed old generation, retaining a second cutoff predicate as a safety fence. */
  async deleteGenerationRows(
    companyId: string,
    sourceId: string,
    generation: PrunableEmbeddingGeneration,
    cutoff: Date,
    executor: Pick<Db, "execute"> = this.db,
  ): Promise<number> {
    const table = generation.embeddingSpace === "bge-m3"
      ? sql.raw('"data_source_chunk_embeddings"')
      : sql.raw('"data_source_gateway_chunk_embeddings"');
    const result = await executor.execute(sql<{ deleted: number | string }>`
      WITH removed AS (
        DELETE FROM ${table}
        WHERE company_id = ${companyId}
          AND data_source_id = ${sourceId}
          AND embedding_space = ${generation.embeddingSpace}
          AND embedding_generation = ${generation.embeddingGeneration}
          AND created_at < ${cutoff}
        RETURNING 1
      )
      SELECT count(*) AS deleted FROM removed
    `);
    const row = rowsOf<{ deleted: number | string }>(result)[0];
    return Number(row?.deleted ?? 0);
  }

  /** Store target vectors without changing the currently published chunk generation. */
  async upsertChunkEmbeddings(
    values: ReindexVectorInput[],
    ownership: { companyId: string; sourceId: string; lease: DataSourceJobLease },
  ): Promise<void> {
    if (values.length === 0) return;
    if (values.some((value) => value.companyId !== ownership.companyId
      || value.dataSourceId !== ownership.sourceId
      || value.embeddingSpace !== values[0]?.embeddingSpace
      || value.embeddingGeneration !== values[0]?.embeddingGeneration)) {
      throw new Error("RAG reindex values do not match their job company/source/model ownership");
    }
    const chunkIds = values.map((value) => value.chunkId);
    if (new Set(chunkIds).size !== chunkIds.length) throw new Error("RAG reindex batch contains duplicate chunk ids");
    const space = values[0]!.embeddingSpace;
    if (!await this.hasEmbeddingSpace(space)) {
      throw new Error(`pgvector sidecar for ${space} is unavailable; target generation cannot be published`);
    }
    const dimensions = space === "bge-m3" ? BGE_DIMENSIONS : GATEWAY_DIMENSIONS;
    for (const value of values) assertVector(value.embedding, dimensions, space);

    await this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, ownership.companyId, ownership.sourceId, ownership.lease);
      const ownedChunks = await tx.select({ id: dataSourceChunks.id }).from(dataSourceChunks).where(and(
        eq(dataSourceChunks.companyId, ownership.companyId),
        eq(dataSourceChunks.dataSourceId, ownership.sourceId),
        inArray(dataSourceChunks.id, chunkIds),
      ));
      if (ownedChunks.length !== values.length) {
        throw new Error("RAG reindex batch contains a missing or foreign datasource chunk");
      }
      const rows = values.map(({ embedding, ...value }) => ({ ...value, embedding }));
      if (space === "bge-m3") {
        await tx.insert(dataSourceChunkEmbeddings).values(rows).onConflictDoUpdate({
          target: [dataSourceChunkEmbeddings.chunkId, dataSourceChunkEmbeddings.embeddingGeneration],
          set: { embedding: sql`excluded.embedding`, createdAt: new Date() },
        });
      } else {
        await tx.insert(dataSourceGatewayChunkEmbeddings).values(rows).onConflictDoUpdate({
          target: [dataSourceGatewayChunkEmbeddings.chunkId, dataSourceGatewayChunkEmbeddings.embeddingGeneration],
          set: { embedding: sql`excluded.embedding`, createdAt: new Date() },
        });
      }
    });
  }

  async insertChunks(values: EmbeddedChunkInput[], ownership?: { companyId: string; sourceId: string; lease: DataSourceJobLease }): Promise<void> {
    if (values.length === 0) return;
    if (ownership && values.some((value) => value.companyId !== ownership.companyId || value.dataSourceId !== ownership.sourceId)) {
      throw new Error("RAG staging values do not match their job company/source ownership");
    }
    const available = await this.availableSpaces();
    const bgeValues = values.filter((value) => {
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      return value.embedding && metadata.embeddingSpace === "bge-m3" && available.bge;
    });
    const gatewayValues = values.filter((value) => {
      const metadata = (value.metadata ?? {}) as Record<string, unknown>;
      return value.embedding && metadata.embeddingSpace === "openrouter-text-embedding-3-small" && available.gateway;
    });
    const vectorChunkIndexes = new Set([...bgeValues, ...gatewayValues].map((value) => value.chunkIndex));

    await this.db.transaction(async (tx) => {
      if (ownership) await assertDataSourceJobLease(tx, ownership.companyId, ownership.sourceId, ownership.lease);
      const inserted = await tx
        .insert(dataSourceChunks)
        .values(values.map((value) => ({
          ...value,
          embedding: vectorChunkIndexes.has(value.chunkIndex) ? null : value.embedding,
        })))
        .returning({ id: dataSourceChunks.id, chunkIndex: dataSourceChunks.chunkIndex });
      const insertedIds = new Map(inserted.map((row) => [row.chunkIndex, row.id]));

      const makeVectorRows = (entries: EmbeddedChunkInput[], dimensions: number, space: string) => entries.map((value) => {
        const metadata = (value.metadata ?? {}) as Record<string, unknown>;
        const embeddingSpace = metadata.embeddingSpace;
        const embeddingGeneration = metadata.embeddingGeneration;
        if (!value.embedding || typeof embeddingSpace !== "string") {
          throw new Error(`Inserted RAG chunk ${value.chunkIndex} is missing its embedding`);
        }
        assertVector(value.embedding, dimensions, space);
        const chunkId = insertedIds.get(value.chunkIndex);
        if (!chunkId) throw new Error(`Inserted RAG chunk ${value.chunkIndex} did not return an id`);
        return {
          chunkId,
          companyId: value.companyId!,
          dataSourceId: value.dataSourceId!,
          embeddingSpace,
          embeddingGeneration: typeof embeddingGeneration === "string" ? embeddingGeneration : embeddingSpace,
          embedding: value.embedding,
        };
      });

      if (bgeValues.length > 0) {
        await tx.insert(dataSourceChunkEmbeddings).values(makeVectorRows(bgeValues, BGE_DIMENSIONS, "bge-m3"));
      }
      if (gatewayValues.length > 0) {
        await tx.insert(dataSourceGatewayChunkEmbeddings).values(makeVectorRows(
          gatewayValues,
          GATEWAY_DIMENSIONS,
          "openrouter-text-embedding-3-small",
        ));
      }
    });
  }

  /** Returns cosine similarity for the nearest authorized chunks, keyed by chunk id. */
  async search(options: VectorSearchOptions): Promise<Map<string, number> | null> {
    if (options.dataSourceIds?.length === 0) return new Map();
    const available = await this.availableSpaces();
    const isBge = options.embeddingSpace === "bge-m3";
    if ((isBge && !available.bge) || (!isBge && !available.gateway)) return null;
    assertVector(options.vector, isBge ? BGE_DIMENSIONS : GATEWAY_DIMENSIONS, options.embeddingSpace);

    const table = isBge
      ? sql.raw('"data_source_chunk_embeddings"')
      : sql.raw('"data_source_gateway_chunk_embeddings"');
    const sourcePredicate = options.dataSourceIds === null
      ? sql`TRUE`
      : sql`embedding.data_source_id IN (${sql.join(options.dataSourceIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
    const vectorLiteral = `[${options.vector.join(",")}]`;
    const result = await this.db.execute(sql<{ chunkId: string; score: number | string }>`
      SELECT embedding.chunk_id AS "chunkId",
             1 - (embedding.embedding <=> ${vectorLiteral}::vector) AS score
      FROM ${table} AS embedding
      WHERE embedding.company_id = ${options.companyId}
        AND embedding.embedding_space = ${options.embeddingSpace}
        AND embedding.embedding_generation = ${options.embeddingGeneration}
        AND ${sourcePredicate}
      ORDER BY embedding.embedding <=> ${vectorLiteral}::vector
      LIMIT ${Math.max(1, Math.min(500, options.limit))}
    `);

    const scoredRows = rowsOf<{ chunkId: string; score: number | string }>(result)
      .map((row) => [row.chunkId, Number(row.score)] as const)
      .filter((entry) => Number.isFinite(entry[1]));
    return new Map<string, number>(scoredRows);
  }

  /** Returns cosine similarity for schema vectors specifically, keyed by chunk id. */
  async searchSchemaVectors(options: VectorSearchOptions): Promise<Map<string, number> | null> {
    if (options.dataSourceIds?.length === 0) return new Map();
    const available = await this.availableSpaces();
    const isBge = options.embeddingSpace === "bge-m3";
    if ((isBge && !available.bge) || (!isBge && !available.gateway)) return null;
    assertVector(options.vector, isBge ? BGE_DIMENSIONS : GATEWAY_DIMENSIONS, options.embeddingSpace);

    const table = isBge
      ? sql.raw('"data_source_chunk_embeddings"')
      : sql.raw('"data_source_gateway_chunk_embeddings"');
    const sourcePredicate = options.dataSourceIds === null
      ? sql`TRUE`
      : sql`embedding.data_source_id IN (${sql.join(options.dataSourceIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
    const vectorLiteral = `[${options.vector.join(",")}]`;
    const result = await this.db.execute(sql<{ targetId: string; score: number | string }>`
      SELECT COALESCE(chunk.metadata->>'tableId', embedding.chunk_id) AS "targetId",
             1 - (embedding.embedding <=> ${vectorLiteral}::vector) AS score
      FROM ${table} AS embedding
      JOIN data_source_chunks AS chunk ON chunk.id = embedding.chunk_id
      JOIN data_sources AS source
        ON source.id = embedding.data_source_id
       AND source.company_id = embedding.company_id
      WHERE embedding.company_id = ${options.companyId}
        AND embedding.embedding_space = ${options.embeddingSpace}
        AND embedding.embedding_generation = ${options.embeddingGeneration}
        AND source.status = 'ready'
        AND source.metadata->>'embeddingSpace' = embedding.embedding_space
        AND source.metadata->>'embeddingGeneration' = embedding.embedding_generation
        AND (chunk.metadata->>'corpusKind' = 'schema' OR chunk.metadata->>'tableId' IS NOT NULL)
        AND ${sourcePredicate}
      ORDER BY embedding.embedding <=> ${vectorLiteral}::vector
      LIMIT ${Math.max(1, Math.min(500, options.limit))}
    `);

    const scoredMap = new Map<string, number>();
    for (const row of rowsOf<{ targetId: string; score: number | string }>(result)) {
      const scoreNum = Number(row.score);
      if (Number.isFinite(scoreNum)) {
        const existing = scoredMap.get(row.targetId);
        if (existing === undefined || scoreNum > existing) {
          scoredMap.set(row.targetId, scoreNum);
        }
      }
    }
    return scoredMap;
  }
}
