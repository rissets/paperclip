import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { dataSources } from "./data_sources.js";

export const dataSourceJobs = pgTable(
  "data_source_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id").notNull().references(() => dataSources.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_source_jobs_company_idx").on(table.companyId),
    queueIdx: index("data_source_jobs_queue_idx").on(table.status, table.availableAt, table.createdAt),
    leaseIdx: index("data_source_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    dataSourceIdx: index("data_source_jobs_source_idx").on(table.companyId, table.dataSourceId, table.createdAt),
    idempotencyIdx: uniqueIndex("data_source_jobs_idempotency_idx").on(table.companyId, table.idempotencyKey),
  }),
);
