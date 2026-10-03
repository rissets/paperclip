import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const userAgentAssignments = pgTable(
  "user_agent_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userAgentUniqueIdx: uniqueIndex("user_agent_assignments_user_agent_uq").on(table.userId, table.agentId),
    companyUserIdx: index("user_agent_assignments_company_user_idx").on(table.companyId, table.userId),
    companyAgentIdx: index("user_agent_assignments_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
