import { pgTable, uuid, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { dataSources } from "./data_sources.js";

/** Durable, company-scoped requests to run bounded read-only queries on external databases. */
export const dataSourceQueryJobs = pgTable(
  "data_source_query_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    status: text("status").notNull().default("queued"),
    queryText: text("query_text"),
    queryParams: jsonb("query_params").$type<unknown[]>().notNull().default([]),
    queryFingerprint: text("query_fingerprint").notNull(),
    rowLimit: integer("row_limit").notNull().default(100),
    statementTimeoutMs: integer("statement_timeout_ms").notNull().default(30_000),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    resultBytes: integer("result_bytes"),
    resultExpiresAt: timestamp("result_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    queueIdx: index("data_source_query_jobs_queue_idx").on(table.status, table.createdAt),
    companyIdx: index("data_source_query_jobs_company_idx").on(table.companyId, table.createdAt),
    sourceIdx: index("data_source_query_jobs_source_idx").on(table.companyId, table.dataSourceId, table.createdAt),
    leaseIdx: index("data_source_query_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    resultExpiryIdx: index("data_source_query_jobs_result_expiry_idx").on(table.resultExpiresAt),
    statusCheck: check("data_source_query_jobs_status_check", sql`${table.status} IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled')`),
    actorCheck: check("data_source_query_jobs_actor_check", sql`${table.requestedByType} IN ('board', 'agent')`),
    rowLimitCheck: check("data_source_query_jobs_row_limit_check", sql`${table.rowLimit} BETWEEN 1 AND 1000`),
    statementTimeoutCheck: check("data_source_query_jobs_statement_timeout_check", sql`${table.statementTimeoutMs} BETWEEN 1000 AND 60000`),
    resultBytesCheck: check("data_source_query_jobs_result_bytes_check", sql`${table.resultBytes} IS NULL OR ${table.resultBytes} BETWEEN 0 AND 1048576`),
  }),
);
