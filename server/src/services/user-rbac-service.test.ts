import { describe, expect, it } from "vitest";
import { buildPermissionsForRole } from "./user-rbac-service.js";

describe("userRbacService buildPermissionsForRole", () => {
  it("builds exact permissions for instance admin", () => {
    const permissions = buildPermissionsForRole("comp-1", "user-1", "owner", true, []);
    expect(permissions.isInstanceAdmin).toBe(true);
    expect(permissions.isOwnerOrAdmin).toBe(true);
    expect(permissions.canCreateCompany).toBe(true);
    expect(permissions.canManageSettings).toBe(true);
    expect(permissions.canAccessSecrets).toBe(true);
    expect(permissions.canAccessEnvironments).toBe(true);
    expect(permissions.canAccessUsers).toBe(true);
    expect(permissions.canAccessPlugins).toBe(true);
    expect(permissions.canAccessAdapters).toBe(true);
    expect(permissions.canAccessExperimental).toBe(true);
    expect(permissions.canExportCompany).toBe(true);
    expect(permissions.canImportCompany).toBe(true);
  });

  it("builds exact permissions for company owner and admin", () => {
    const ownerPerms = buildPermissionsForRole("comp-1", "user-1", "owner", false, []);
    expect(ownerPerms.isOwnerOrAdmin).toBe(true);
    expect(ownerPerms.canCreateCompany).toBe(true);
    expect(ownerPerms.canManageSettings).toBe(true);
    expect(ownerPerms.canAccessSecrets).toBe(true);
    expect(ownerPerms.canAccessEnvironments).toBe(false);
    expect(ownerPerms.canAccessUsers).toBe(true);
    expect(ownerPerms.canAccessPlugins).toBe(false);
    expect(ownerPerms.canAccessAdapters).toBe(false);
    expect(ownerPerms.canAccessExperimental).toBe(false);
    expect(ownerPerms.canExportCompany).toBe(true);
    expect(ownerPerms.canImportCompany).toBe(true);

    const adminPerms = buildPermissionsForRole("comp-1", "user-2", "admin", false, []);
    expect(adminPerms.isOwnerOrAdmin).toBe(true);
    expect(adminPerms.canCreateCompany).toBe(true);
    expect(adminPerms.canManageSettings).toBe(true);
    expect(adminPerms.canAccessSecrets).toBe(true);
  });

  it("builds restricted permissions for operator", () => {
    const operatorPerms = buildPermissionsForRole("comp-1", "user-3", "operator", false, ["agent-1"]);
    expect(operatorPerms.role).toBe("operator");
    expect(operatorPerms.isOwnerOrAdmin).toBe(false);
    expect(operatorPerms.isInstanceAdmin).toBe(false);
    expect(operatorPerms.canCreateCompany).toBe(false);
    expect(operatorPerms.canManageSettings).toBe(false);
    expect(operatorPerms.canAccessSecrets).toBe(false);
    expect(operatorPerms.canAccessEnvironments).toBe(false);
    expect(operatorPerms.canAccessUsers).toBe(false);
    expect(operatorPerms.canAccessPlugins).toBe(false);
    expect(operatorPerms.canAccessAdapters).toBe(false);
    expect(operatorPerms.canAccessExperimental).toBe(false);
    expect(operatorPerms.canExportCompany).toBe(false);
    expect(operatorPerms.canImportCompany).toBe(false);
    expect(operatorPerms.canAddAgent).toBe(true);
    expect(operatorPerms.operatorMaxAgents).toBe(3);
    expect(operatorPerms.assignedAgentIds).toEqual(["agent-1"]);
    expect(operatorPerms.allowedDataSourceIds).toEqual([]);
    expect(operatorPerms.assignedProjectIds).toEqual([]);
  });

  it("builds restricted permissions for viewer", () => {
    const viewerPerms = buildPermissionsForRole("comp-1", "user-4", "viewer", false, []);
    expect(viewerPerms.role).toBe("viewer");
    expect(viewerPerms.isOwnerOrAdmin).toBe(false);
    expect(viewerPerms.canManageSettings).toBe(false);
    expect(viewerPerms.canAccessSecrets).toBe(false);
    expect(viewerPerms.canCreateCompany).toBe(false);
  });
});
