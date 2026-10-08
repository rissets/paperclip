import { pgTable, uuid, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * P6-01: Company-scoped query experience records for retrieval-based learning.
 * Stores validated/candidate intent-to-plan templates without raw sensitive result rows.
 */
export const dataSourceQueryExperiences = pgTable(
  "data_source_query_experiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    originatingExecutionId: text("originating_execution_id").notNull(),
    intent: text("intent").notNull(),
    parameterizedSql: text("parameterized_sql").notNull(),
    parameterSchema: jsonb("parameter_schema").$type<Record<string, { type: string; description?: string }>>().notNull().default({}),
    referencedDataSourceIds: jsonb("referenced_data_source_ids").$type<string[]>().notNull().default([]),
    referencedTables: jsonb("referenced_tables").$type<string[]>().notNull().default([]),
    referencedColumns: jsonb("referenced_columns").$type<string[]>().notNull().default([]),
    metricBindings: jsonb("metric_bindings").$type<string[]>().notNull().default([]),
    schemaFingerprint: text("schema_fingerprint").notNull(),
    engine: text("engine").notNull().default("clickhouse"),
    status: text("status").notNull().default("candidate"),
    validationEvidence: jsonb("validation_evidence").$type<Record<string, unknown>>().notNull().default({}),
    feedbackCount: integer("feedback_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_source_query_exp_company_idx").on(table.companyId, table.createdAt),
    statusIdx: index("data_source_query_exp_status_idx").on(table.companyId, table.status),
    fingerprintIdx: index("data_source_query_exp_fingerprint_idx").on(table.companyId, table.schemaFingerprint),
    intentIdx: index("data_source_query_exp_intent_idx").on(table.companyId, table.intent),
    statusCheck: check(
      "data_source_query_exp_status_check",
      sql`${table.status} IN ('candidate', 'execution_checked', 'reference_verified', 'user_approved', 'rejected', 'deprecated')`,
    ),
    engineCheck: check(
      "data_source_query_exp_engine_check",
      sql`${table.engine} IN ('clickhouse', 'live_external', 'hybrid')`,
    ),
  }),
);
