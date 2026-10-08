import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { dataSourceJobs } from "./data_source_jobs.js";

/**
 * Bounded, durable per-stage artifacts for datasource jobs. The job foreign key
 * makes retention follow the job ledger and the unique key makes retries
 * idempotent without growing `data_source_jobs.progress` with large payloads.
 */
export const dataSourceJobCheckpoints = pgTable(
  "data_source_job_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => dataSourceJobs.id, { onDelete: "cascade" }),
    checkpointType: text("checkpoint_type").notNull(),
    checkpointKey: text("checkpoint_key").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobStageIdx: index("data_source_job_checkpoints_job_stage_idx").on(
      table.jobId,
      table.checkpointType,
      table.inputFingerprint,
    ),
    uniqueCheckpoint: uniqueIndex("data_source_job_checkpoints_identity_uidx").on(
      table.jobId,
      table.checkpointType,
      table.checkpointKey,
    ),
  }),
);
