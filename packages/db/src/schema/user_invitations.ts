import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const userInvitations = pgTable(
  "user_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").notNull().default("operator"), // "owner" | "admin" | "operator" | "viewer"
    companyIds: jsonb("company_ids").$type<string[]>().notNull().default([]), // multi-workspace assignment
    agentIds: jsonb("agent_ids").$type<string[]>().notNull().default([]), // assigned agent IDs
    token: text("token").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id"),
    status: text("status").notNull().default("pending"), // "pending" | "accepted" | "revoked" | "expired"
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("user_invitations_token_hash_uq").on(table.tokenHash),
    emailStatusIdx: index("user_invitations_email_status_idx").on(table.email, table.status),
  }),
);
