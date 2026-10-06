import { index, pgTable, text, timestamp, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { dataSourceChunks, dataSources } from "./data_sources.js";

/**
 * Optional BGE-M3 pgvector sidecar. The data-plane migration creates this table
 * only when PostgreSQL provides the vector extension; embedded dev keeps JSONB
 * embeddings and lexical retrieval until that capability is present.
 */
export const dataSourceChunkEmbeddings = pgTable(
  "data_source_chunk_embeddings",
  {
    chunkId: uuid("chunk_id").notNull().references(() => dataSourceChunks.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    embeddingSpace: text("embedding_space").notNull(),
    embeddingGeneration: text("embedding_generation").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chunkGenerationIdx: uniqueIndex("data_source_chunk_embeddings_chunk_generation_idx").on(table.chunkId, table.embeddingGeneration),
    companySourceSpaceIdx: index("data_source_chunk_embeddings_company_source_space_idx").on(
      table.companyId,
      table.dataSourceId,
      table.embeddingSpace,
      table.embeddingGeneration,
    ),
    bgeHnswIdx: index("data_source_chunk_embeddings_bge_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`embedding_space = 'bge-m3'`),
  }),
);
