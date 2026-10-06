import { pgTable, uuid, text, bigint, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { dataSourceCollections } from "./data_sources.js";
import { dataSources } from "./data_sources.js";

export type DataSourceUploadPartReceipt = {
  partNumber: number;
  byteSize: number;
  sha256: string;
  etag: string;
};

export const dataSourceUploadSessions = pgTable(
  "data_source_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id").references(() => dataSources.id, { onDelete: "set null" }),
    collectionId: uuid("collection_id").references(() => dataSourceCollections.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    sourceName: text("source_name"),
    description: text("description"),
    contentType: text("content_type").notNull(),
    expectedBytes: bigint("expected_bytes", { mode: "number" }).notNull(),
    expectedSha256: text("expected_sha256"),
    objectKey: text("object_key").notNull(),
    storageUploadId: text("storage_upload_id"),
    partSize: integer("part_size").notNull(),
    parts: jsonb("parts").$type<DataSourceUploadPartReceipt[]>().notNull().default([]),
    status: text("status").notNull().default("starting"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusExpiryIdx: index("data_source_upload_sessions_company_status_expiry_idx").on(table.companyId, table.status, table.expiresAt),
    sourceIdx: index("data_source_upload_sessions_source_idx").on(table.companyId, table.dataSourceId),
    objectKeyUq: uniqueIndex("data_source_upload_sessions_object_key_uq").on(table.objectKey),
  }),
);
