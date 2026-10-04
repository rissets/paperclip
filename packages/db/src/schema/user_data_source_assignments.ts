import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { dataSources } from "./data_sources.js";
import { companies } from "./companies.js";

export const userDataSourceAssignments = pgTable(
  "user_data_source_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDataSourceUniqueIdx: uniqueIndex("user_data_source_assignments_user_ds_uq").on(table.userId, table.dataSourceId),
    companyUserIdx: index("user_data_source_assignments_company_user_idx").on(table.companyId, table.userId),
    companyDataSourceIdx: index("user_data_source_assignments_company_ds_idx").on(table.companyId, table.dataSourceId),
  }),
);
