import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companyMemberships,
  userAgentAssignments,
  agents,
} from "@paperclipai/db";
import type { UserRbacStatus } from "@paperclipai/shared";

export function userRbacService(db: Db) {
  return {
    async getUserRoleInCompany(companyId: string, userId: string): Promise<"owner" | "admin" | "operator" | "viewer" | null> {
      if (userId === "local-board") return "owner";

      const membership = await db
        .select({
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!membership) return null;
      const role = membership.membershipRole?.toLowerCase();
      if (role === "owner" || role === "admin" || role === "operator" || role === "viewer") {
        return role;
      }
      return "operator";
    },

    async isOwnerOrAdmin(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board") return true;
      const role = await this.getUserRoleInCompany(companyId, userId);
      return role === "owner" || role === "admin";
    },

    async canUserAddDataSource(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      return this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
    },

    async canUserAddAgent(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      return this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
    },

    async canUserEditAgent(companyId: string, userId: string, agentId: string, isInstanceAdmin = false): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board") return true;
      const role = await this.getUserRoleInCompany(companyId, userId);
      if (role === "owner" || role === "admin") {
        return true;
      }
      if (role === "viewer") {
        return false;
      }

      // For operator/member: check if agent is assigned to this user
      const assignment = await db
        .select({ id: userAgentAssignments.id })
        .from(userAgentAssignments)
        .where(
          and(
            eq(userAgentAssignments.companyId, companyId),
            eq(userAgentAssignments.userId, userId),
            eq(userAgentAssignments.agentId, agentId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      return Boolean(assignment);
    },

    async getAssignedAgentsForUser(companyId: string, userId: string): Promise<string[]> {
      const rows = await db
        .select({ agentId: userAgentAssignments.agentId })
        .from(userAgentAssignments)
        .where(
          and(
            eq(userAgentAssignments.companyId, companyId),
            eq(userAgentAssignments.userId, userId),
          ),
        );
      return rows.map((r) => r.agentId);
    },

    async getAssignedUsersForAgent(companyId: string, agentId: string): Promise<Array<{
      id: string;
      userId: string;
      userName: string | null;
      userEmail: string | null;
      createdAt: Date;
    }>> {
      const rows = await db
        .select({
          id: userAgentAssignments.id,
          userId: userAgentAssignments.userId,
          createdAt: userAgentAssignments.createdAt,
          userName: authUsers.name,
          userEmail: authUsers.email,
        })
        .from(userAgentAssignments)
        .leftJoin(authUsers, eq(userAgentAssignments.userId, authUsers.id))
        .where(
          and(
            eq(userAgentAssignments.companyId, companyId),
            eq(userAgentAssignments.agentId, agentId),
          ),
        );

      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: r.userName ?? null,
        userEmail: r.userEmail ?? null,
        createdAt: r.createdAt,
      }));
    },

    async assignUsersToAgent(
      companyId: string,
      agentId: string,
      userIds: string[],
      assignedByUserId: string,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        // Delete existing assignments for this agent
        await tx
          .delete(userAgentAssignments)
          .where(
            and(
              eq(userAgentAssignments.companyId, companyId),
              eq(userAgentAssignments.agentId, agentId),
            ),
          );

        // Insert new assignments
        if (userIds.length > 0) {
          const toInsert = userIds.map((userId) => ({
            companyId,
            agentId,
            userId,
            assignedByUserId,
          }));
          await tx.insert(userAgentAssignments).values(toInsert);
        }
      });
    },

    async assignAgentsToUser(
      companyId: string,
      userId: string,
      agentIds: string[],
      assignedByUserId: string,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        // Delete existing assignments for this user in this company
        await tx
          .delete(userAgentAssignments)
          .where(
            and(
              eq(userAgentAssignments.companyId, companyId),
              eq(userAgentAssignments.userId, userId),
            ),
          );

        // Insert new assignments
        if (agentIds.length > 0) {
          const toInsert = agentIds.map((agentId) => ({
            companyId,
            agentId,
            userId,
            assignedByUserId,
          }));
          await tx.insert(userAgentAssignments).values(toInsert);
        }
      });
    },

    async getUserRbacStatus(companyId: string, userId: string, isInstanceAdmin = false): Promise<UserRbacStatus> {
      if (isInstanceAdmin || userId === "local-board") {
        return {
          userId,
          companyId,
          role: "owner",
          isOwnerOrAdmin: true,
          canAddDataSource: true,
          canAddAgent: true,
          assignedAgentIds: [],
        };
      }
      const role = (await this.getUserRoleInCompany(companyId, userId)) || "operator";
      const isOwnerOrAdmin = role === "owner" || role === "admin";
      const assignedAgentIds = isOwnerOrAdmin
        ? [] // Owners/admins have access to all agents
        : await this.getAssignedAgentsForUser(companyId, userId);

      return {
        userId,
        companyId,
        role,
        isOwnerOrAdmin,
        canAddDataSource: isOwnerOrAdmin,
        canAddAgent: isOwnerOrAdmin,
        assignedAgentIds,
      };
    },
  };
}
