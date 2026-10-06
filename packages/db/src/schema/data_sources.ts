import { pgTable, uuid, text, integer, bigint, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const dataSourceCollections = pgTable(
  "data_source_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    semanticProfile: jsonb("semantic_profile").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_source_collections_company_idx").on(table.companyId),
    companySlugIdx: index("data_source_collections_company_slug_idx").on(table.companyId, table.slug),
  }),
);

export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id").references(() => dataSourceCollections.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    sourceType: text("source_type").notNull(), // 'csv' | 'excel' | 'rag_document'
    status: text("status").notNull().default("onboarding"), // 'onboarding' | 'processing' | 'ready' | 'error'
    fileName: text("file_name"),
    fileSize: bigint("file_size", { mode: "number" }),
    mimeType: text("mime_type"),
    storagePath: text("storage_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_sources_company_idx").on(table.companyId),
    companyStatusIdx: index("data_sources_company_status_idx").on(table.companyId, table.status),
    companyTypeIdx: index("data_sources_company_type_idx").on(table.companyId, table.sourceType),
    collectionIdx: index("data_sources_collection_idx").on(table.collectionId),
  }),
);

export const dataSourceTables = pgTable(
  "data_source_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    rowCount: bigint("row_count", { mode: "number" }).notNull().default(0),
    columnCount: integer("column_count").notNull().default(0),
    schemaDefinition: jsonb("schema_definition").notNull().$type<any[]>(),
    semanticModel: jsonb("semantic_model").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dataSourceIdx: index("data_source_tables_ds_idx").on(table.dataSourceId),
    companyIdx: index("data_source_tables_company_idx").on(table.companyId),
  }),
);

export const dataSourceRecords = pgTable(
  "data_source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id").notNull().references(() => dataSourceTables.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    data: jsonb("data").notNull().$type<Record<string, unknown>>(),
  },
  (table) => ({
    tableRowIdx: index("data_source_records_table_row_idx").on(table.tableId, table.rowIndex),
    companyTableIdx: index("data_source_records_company_table_idx").on(table.companyId, table.tableId),
  }),
);

export const dataSourceChunks = pgTable(
  "data_source_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    embedding: jsonb("embedding").$type<number[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dataSourceIdx: index("data_source_chunks_ds_idx").on(table.dataSourceId),
    companyIdx: index("data_source_chunks_company_idx").on(table.companyId),
  }),
);

export const orchestratorSessions = pgTable(
  "orchestrator_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New Orchestration Session"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("orchestrator_sessions_company_idx").on(table.companyId),
  }),
);

export const orchestratorMessages = pgTable(
  "orchestrator_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => orchestratorSessions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    orchestrationPlan: jsonb("orchestration_plan").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("orchestrator_messages_session_idx").on(table.sessionId),
    companyIdx: index("orchestrator_messages_company_idx").on(table.companyId),
  }),
);
