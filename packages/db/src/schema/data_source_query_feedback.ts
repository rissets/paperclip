import { pgTable, uuid, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { dataSourceQueryExperiences } from "./data_source_query_experiences.js";

/**
 * P6-01: Company-scoped query feedback records linking execution/experience reviews.
 */
export const dataSourceQueryFeedback = pgTable(
  "data_source_query_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    experienceId: uuid("experience_id").references(() => dataSourceQueryExperiences.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    sentiment: text("sentiment").notNull(),
    businessFieldsToFix: jsonb("business_fields_to_fix").$type<string[]>().notNull().default([]),
    correctionNote: text("correction_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("data_source_query_fb_company_idx").on(table.companyId, table.createdAt),
    experienceIdx: index("data_source_query_fb_exp_idx").on(table.companyId, table.experienceId),
    executionIdx: index("data_source_query_fb_exec_idx").on(table.companyId, table.executionId),
    actorCheck: check(
      "data_source_query_fb_actor_check",
      sql`${table.actorType} IN ('board', 'agent', 'user')`,
    ),
    sentimentCheck: check(
      "data_source_query_fb_sentiment_check",
      sql`${table.sentiment} IN ('positive', 'negative')`,
    ),
  }),
);
