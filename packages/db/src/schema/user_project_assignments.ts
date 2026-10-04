import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { projects } from "./projects.js";
import { companies } from "./companies.js";

export const userProjectAssignments = pgTable(
  "user_project_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProjectUniqueIdx: uniqueIndex("user_project_assignments_user_project_uq").on(table.userId, table.projectId),
    companyUserIdx: index("user_project_assignments_company_user_idx").on(table.companyId, table.userId),
    companyProjectIdx: index("user_project_assignments_company_project_idx").on(table.companyId, table.projectId),
  }),
);
