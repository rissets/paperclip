import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companyMemberships,
  userAgentAssignments,
  userDataSourceAssignments,
  userProjectAssignments,
  principalPermissionGrants,
  agents,
  projects,
} from "@paperclipai/db";
import type {
  UserRbacStatus,
  UserAccessConfigResponse,
  UpdateUserAccessConfigRequest,
} from "@paperclipai/shared";

export function buildPermissionsForRole(
  companyId: string,
  userId: string,
  role: "owner" | "admin" | "operator" | "viewer",
  isInstanceAdmin = false,
  assignedAgentIds: string[] = [],
  allowedDataSourceIds: string[] = [],
  assignedProjectIds: string[] = [],
  operatorCreatedAgentCount = 0,
  operatorMaxAgents = 3,
): UserRbacStatus {
  if (isInstanceAdmin || userId === "local-board") {
    return {
      userId,
      companyId,
      role: "owner",
      isOwnerOrAdmin: true,
      isInstanceAdmin: true,
      canAddDataSource: true,
      canAddAgent: true,
      canCreateCompany: true,
      canManageSettings: true,
      canAccessSecrets: true,
      canAccessEnvironments: true,
      canAccessUsers: true,
      canAccessPlugins: true,
      canAccessAdapters: true,
      canAccessExperimental: true,
      canExportCompany: true,
      canImportCompany: true,
      assignedAgentIds: [],
      allowedDataSourceIds: [],
      assignedProjectIds: [],
      operatorCreatedAgentCount: 0,
      operatorMaxAgents: 999,
    };
  }
  const isOwnerOrAdmin = role === "owner" || role === "admin";
  const isOperator = role === "operator";
  return {
    userId,
    companyId,
    role,
    isOwnerOrAdmin,
    isInstanceAdmin: false,
    canAddDataSource: isOwnerOrAdmin,
    canAddAgent: isOwnerOrAdmin || (isOperator && operatorCreatedAgentCount < operatorMaxAgents),
    canCreateCompany: isOwnerOrAdmin,
    canManageSettings: isOwnerOrAdmin,
    canAccessSecrets: isOwnerOrAdmin,
    canAccessEnvironments: false,
    canAccessUsers: isOwnerOrAdmin,
    canAccessPlugins: false,
    canAccessAdapters: false,
    canAccessExperimental: false,
    canExportCompany: isOwnerOrAdmin,
    canImportCompany: isOwnerOrAdmin,
    assignedAgentIds: isOwnerOrAdmin ? [] : assignedAgentIds,
    allowedDataSourceIds: isOwnerOrAdmin ? [] : allowedDataSourceIds,
    assignedProjectIds: isOwnerOrAdmin ? [] : assignedProjectIds,
    operatorCreatedAgentCount,
    operatorMaxAgents: isOwnerOrAdmin ? 999 : operatorMaxAgents,
  };
}

export function userRbacService(db: Db) {
  const hasDb = Boolean(db && typeof (db as any).select === "function");
  return {
    buildPermissionsForRole,

    async getUserRoleInCompany(companyId: string, userId: string): Promise<"owner" | "admin" | "operator" | "viewer" | null> {
      if (userId === "local-board" || !hasDb) return "owner";

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

      if (!membership || !membership.membershipRole) return null;
      const role = membership.membershipRole?.toLowerCase();
      if (role === "owner" || role === "admin" || role === "operator" || role === "viewer") {
        return role;
      }
      return "operator";
    },

    async isOwnerOrAdmin(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board" || !hasDb) return true;
      const role = await this.getUserRoleInCompany(companyId, userId);
      return role === "owner" || role === "admin";
    },

    async canUserAddDataSource(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      return this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
    },

    async getOperatorCreatedAgentCount(companyId: string, userId: string): Promise<number> {
      if (!hasDb) return 0;
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.createdByUserId, userId),
          ),
        );
      return rows.length;
    },

    async canUserAddAgent(companyId: string, userId: string, isInstanceAdmin = false): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board" || !hasDb) return true;
      const isOwnerOrAdmin = await this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
      if (isOwnerOrAdmin) return true;
      const role = await this.getUserRoleInCompany(companyId, userId);
      if (role === "operator") {
        const count = await this.getOperatorCreatedAgentCount(companyId, userId);
        return count < 3;
      }
      if (role === "viewer") {
        return false;
      }
      return true;
    },

    async canUserEditAgent(companyId: string, userId: string, agentId: string, isInstanceAdmin = false): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board" || !hasDb) return true;
      const role = await this.getUserRoleInCompany(companyId, userId);
      if (role === "owner" || role === "admin") {
        return true;
      }
      if (role === "viewer") {
        return false;
      }

      // Check if agent was created by this user
      const agentRow = await db
        .select({ createdByUserId: agents.createdByUserId })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
        .then((rows) => rows[0] ?? null);
      if (agentRow && agentRow.createdByUserId === userId) {
        return true;
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
      if (assignment) return true;

      // Check explicit permission grants for this agent
      const grants = await db
        .select({ scope: principalPermissionGrants.scope })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
            inArray(principalPermissionGrants.permissionKey, ["agents:configure", "agents:manage", "agents:create"]),
          ),
        );
      for (const grant of grants) {
        const sc = grant.scope as any;
        if (!sc || sc.allAgents || (Array.isArray(sc.agentIds) && sc.agentIds.includes(agentId))) {
          return true;
        }
      }

      return false;
    },

    async getAssignedAgentsForUser(companyId: string, userId: string): Promise<string[]> {
      if (!hasDb) return [];
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

    async getAssignedAgentIds(companyId: string, userId: string): Promise<string[]> {
      return this.getAssignedAgentsForUser(companyId, userId);
    },

    async getAssignedUsersForAgent(companyId: string, agentId: string): Promise<Array<{
      id: string;
      userId: string;
      userName: string | null;
      userEmail: string | null;
      createdAt: Date;
    }>> {
      if (!hasDb) return [];
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
      if (!hasDb || typeof (db as any).transaction !== "function") return;
      await db.transaction(async (tx) => {
        await tx
          .delete(userAgentAssignments)
          .where(
            and(
              eq(userAgentAssignments.companyId, companyId),
              eq(userAgentAssignments.agentId, agentId),
            ),
          );

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
      if (!hasDb || typeof (db as any).transaction !== "function") return;
      await db.transaction(async (tx) => {
        await tx
          .delete(userAgentAssignments)
          .where(
            and(
              eq(userAgentAssignments.companyId, companyId),
              eq(userAgentAssignments.userId, userId),
            ),
          );

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

    // Data Sources access management
    async getAllowedDataSourcesForUser(companyId: string, userId: string): Promise<string[]> {
      if (!hasDb) return [];
      const rows = await db
        .select({ dataSourceId: userDataSourceAssignments.dataSourceId })
        .from(userDataSourceAssignments)
        .where(
          and(
            eq(userDataSourceAssignments.companyId, companyId),
            eq(userDataSourceAssignments.userId, userId),
          ),
        );
      return rows.map((r) => r.dataSourceId);
    },

    async assignDataSourcesToUser(
      companyId: string,
      userId: string,
      dataSourceIds: string[],
      assignedByUserId: string,
    ): Promise<void> {
      if (!hasDb || typeof (db as any).transaction !== "function") return;
      await db.transaction(async (tx) => {
        await tx
          .delete(userDataSourceAssignments)
          .where(
            and(
              eq(userDataSourceAssignments.companyId, companyId),
              eq(userDataSourceAssignments.userId, userId),
            ),
          );

        if (dataSourceIds.length > 0) {
          const toInsert = dataSourceIds.map((dataSourceId) => ({
            companyId,
            dataSourceId,
            userId,
            assignedByUserId,
          }));
          await tx.insert(userDataSourceAssignments).values(toInsert);
        }
      });
    },

    async canUserAccessDataSource(
      companyId: string,
      userId: string,
      dataSourceId: string,
      isInstanceAdmin = false,
    ): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board" || !hasDb) return true;
      const isOwnerOrAdmin = await this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
      if (isOwnerOrAdmin) return true;
      const allowed = await this.getAllowedDataSourcesForUser(companyId, userId);
      return allowed.includes(dataSourceId);
    },

    // Projects access management
    async getAssignedProjectsForUser(companyId: string, userId: string): Promise<string[]> {
      if (!hasDb) return [];
      const rows = await db
        .select({ projectId: userProjectAssignments.projectId })
        .from(userProjectAssignments)
        .where(
          and(
            eq(userProjectAssignments.companyId, companyId),
            eq(userProjectAssignments.userId, userId),
          ),
        );
      return rows.map((r) => r.projectId);
    },

    async assignProjectsToUser(
      companyId: string,
      userId: string,
      projectIds: string[],
      assignedByUserId: string,
    ): Promise<void> {
      if (!hasDb || typeof (db as any).transaction !== "function") return;
      await db.transaction(async (tx) => {
        await tx
          .delete(userProjectAssignments)
          .where(
            and(
              eq(userProjectAssignments.companyId, companyId),
              eq(userProjectAssignments.userId, userId),
            ),
          );

        if (projectIds.length > 0) {
          const toInsert = projectIds.map((projectId) => ({
            companyId,
            projectId,
            userId,
            assignedByUserId,
          }));
          await tx.insert(userProjectAssignments).values(toInsert);
        }
      });
    },

    async canUserAccessProject(
      companyId: string,
      userId: string,
      projectId: string,
      isInstanceAdmin = false,
    ): Promise<boolean> {
      if (isInstanceAdmin || userId === "local-board" || !hasDb) return true;
      const isOwnerOrAdmin = await this.isOwnerOrAdmin(companyId, userId, isInstanceAdmin);
      if (isOwnerOrAdmin) return true;

      // Check if project was created by this user
      const projectRow = await db
        .select({ createdByUserId: projects.createdByUserId })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
        .then((r) => r[0] ?? null);
      if (projectRow && projectRow.createdByUserId === userId) {
        return true;
      }

      const assigned = await this.getAssignedProjectsForUser(companyId, userId);
      return assigned.includes(projectId);
    },

    async getUserAccessConfig(companyId: string, userId: string): Promise<UserAccessConfigResponse> {
      const role = (await this.getUserRoleInCompany(companyId, userId)) || "operator";
      const assignedAgentIds = await this.getAssignedAgentsForUser(companyId, userId);
      const allowedDataSourceIds = await this.getAllowedDataSourcesForUser(companyId, userId);
      const assignedProjectIds = await this.getAssignedProjectsForUser(companyId, userId);
      const operatorCreatedAgentCount = await this.getOperatorCreatedAgentCount(companyId, userId);

      return {
        userId,
        companyId,
        role,
        assignedAgentIds,
        allowedDataSourceIds,
        assignedProjectIds,
        operatorCreatedAgentCount,
        operatorMaxAgents: 3,
      };
    },

    async updateUserAccessConfig(
      companyId: string,
      userId: string,
      input: UpdateUserAccessConfigRequest,
      actorUserId: string,
    ): Promise<UserAccessConfigResponse> {
      if (!hasDb) return this.getUserAccessConfig(companyId, userId);
      if (input.role) {
        await db
          .update(companyMemberships)
          .set({ membershipRole: input.role, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, userId),
            ),
          );
      }

      if (input.assignedAgentIds !== undefined) {
        await this.assignAgentsToUser(companyId, userId, input.assignedAgentIds, actorUserId);
      }

      if (input.allowedDataSourceIds !== undefined) {
        await this.assignDataSourcesToUser(companyId, userId, input.allowedDataSourceIds, actorUserId);
      }

      if (input.assignedProjectIds !== undefined) {
        await this.assignProjectsToUser(companyId, userId, input.assignedProjectIds, actorUserId);
      }

      return this.getUserAccessConfig(companyId, userId);
    },

    async getUserRbacStatus(companyId: string, userId: string, isInstanceAdmin = false): Promise<UserRbacStatus> {
      if (isInstanceAdmin || userId === "local-board") {
        return buildPermissionsForRole(companyId, userId, "owner", true, [], [], [], 0, 999);
      }
      const role = (await this.getUserRoleInCompany(companyId, userId)) || "operator";
      const isOwnerOrAdmin = role === "owner" || role === "admin";
      const assignedAgentIds = isOwnerOrAdmin
        ? []
        : await this.getAssignedAgentsForUser(companyId, userId);
      const allowedDataSourceIds = isOwnerOrAdmin
        ? []
        : await this.getAllowedDataSourcesForUser(companyId, userId);
      const assignedProjectIds = isOwnerOrAdmin
        ? []
        : await this.getAssignedProjectsForUser(companyId, userId);
      const operatorCreatedAgentCount = isOwnerOrAdmin
        ? 0
        : await this.getOperatorCreatedAgentCount(companyId, userId);

      return buildPermissionsForRole(
        companyId,
        userId,
        role,
        false,
        assignedAgentIds,
        allowedDataSourceIds,
        assignedProjectIds,
        operatorCreatedAgentCount,
        3,
      );
    },
  };
}
