import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Durable, audited query execution records managed by the Enterprise Orchestrator. */
export const dataSourceQueryExecutions = pgTable(
  "data_source_query_executions",
  {
    id: text("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: text("run_id"),
    sessionId: text("session_id"),
    // Null only for legacy rows whose datasource scope cannot be reconstructed.
    dataSourceIds: jsonb("data_source_ids").$type<string[]>(),
    query: text("query").notNull(),
    planHash: text("plan_hash").notNull(),
    engine: text("engine").default("clickhouse"),
    status: text("status").notNull().default("running"),
    stageTimings: jsonb("stage_timings").$type<Record<string, number>>(),
    resultsSummary: text("results_summary"),
    dataPreview: jsonb("data_preview"),
    errorMessage: text("error_message"),
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("data_source_query_executions_company_idx").on(table.companyId, table.createdAt),
    // Legacy workspaces may already contain UUID-keyed execution rows with
    // duplicate run/plan pairs. Keep them intact while making new exec-* rows
    // race-safe; the service reads and reuses any legacy match first.
    runPlanUniqueIdx: uniqueIndex("data_source_query_executions_run_plan_uidx")
      .on(table.companyId, table.runId, table.planHash)
      .where(sql`${table.id} LIKE 'exec-%'`),
    agentIdx: index("data_source_query_executions_agent_idx").on(table.companyId, table.agentId, table.createdAt),
    dataSourceScopeIdx: index("data_source_query_executions_data_source_ids_gin_idx").using("gin", table.dataSourceIds),
    statusCheck: check(
      "data_source_query_executions_status_check",
      sql`${table.status} IN ('running', 'completed', 'cancelled', 'failed')`,
    ),
  }),
);
