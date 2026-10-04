// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { UserRbacStatus } from "@paperclipai/shared";
import { useUserRbac } from "./useUserRbac";
import { useHiddenSettings } from "./useHiddenSettings";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "test-company" }),
  useOptionalCompany: () => ({ selectedCompanyId: "test-company" }),
}));

const mockApiGet = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({
  api: {
    get: mockApiGet,
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useUserRbac and useHiddenSettings", () => {
  it("computes restricted permissions and hides restricted settings for operator role", async () => {
    const operatorRbac: UserRbacStatus = {
      companyId: "test-company",
      userId: "user-operator",
      role: "operator",
      isOwnerOrAdmin: false,
      isInstanceAdmin: false,
      canAddDataSource: false,
      canAddAgent: false,
      canCreateCompany: false,
      canManageSettings: false,
      canAccessSecrets: false,
      canAccessEnvironments: false,
      canAccessUsers: false,
      canAccessPlugins: false,
      canAccessAdapters: false,
      canAccessExperimental: false,
      canExportCompany: false,
      canImportCompany: false,
      assignedAgentIds: ["agent-assigned-1"],
      allowedDataSourceIds: [],
      assignedProjectIds: [],
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["user-rbac", "test-company"], operatorRbac);
    client.setQueryData(queryKeys.health, { hiddenSettings: [] });

    let hookResult: ReturnType<typeof useUserRbac> | undefined;
    let hiddenSettingsResult: ReturnType<typeof useHiddenSettings> | undefined;

    function TestComponent() {
      hookResult = useUserRbac();
      hiddenSettingsResult = useHiddenSettings();
      return <div data-testid="ready">Ready</div>;
    }

    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <TestComponent />
          </QueryClientProvider>
        );
      });

      expect(hookResult).toBeDefined();
      expect(hookResult?.role).toBe("operator");
      expect(hookResult?.isOwnerOrAdmin).toBe(false);
      expect(hookResult?.canManageSettings).toBe(false);
      expect(hookResult?.canCreateCompany).toBe(false);
      expect(hookResult?.canAccessSecrets).toBe(false);
      expect(hookResult?.canAccessEnvironments).toBe(false);
      expect(hookResult?.canAccessUsers).toBe(false);
      expect(hookResult?.canAccessPlugins).toBe(false);
      expect(hookResult?.canAccessAdapters).toBe(false);
      expect(hookResult?.canAccessExperimental).toBe(false);
      expect(hookResult?.canExportCompany).toBe(false);
      expect(hookResult?.canImportCompany).toBe(false);

      // Agent edit capability checks
      expect(hookResult?.canEditAgent("agent-assigned-1")).toBe(true);
      expect(hookResult?.canEditAgent("agent-unassigned-2")).toBe(false);

      // Hidden settings checks for operator
      const hidden = hiddenSettingsResult?.hidden;
      expect(hidden?.has("company.secrets")).toBe(true);
      expect(hidden?.has("instance.environments")).toBe(true);
      expect(hidden?.has("instance.access")).toBe(true);
      expect(hidden?.has("company.members")).toBe(true);
      expect(hidden?.has("company.invites")).toBe(true);
      expect(hidden?.has("instance.experimental")).toBe(true);
      expect(hidden?.has("instance.plugins")).toBe(true);
      expect(hidden?.has("instance.adapters")).toBe(true);
      expect(hidden?.has("company.export")).toBe(true);
      expect(hidden?.has("company.import")).toBe(true);
      expect(hidden?.has("company.settings")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });

  it("grants full permissions and hides nothing for owner role", async () => {
    const ownerRbac: UserRbacStatus = {
      companyId: "test-company",
      userId: "user-owner",
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
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["user-rbac", "test-company"], ownerRbac);
    client.setQueryData(queryKeys.health, { hiddenSettings: [] });

    let hookResult: ReturnType<typeof useUserRbac> | undefined;
    let hiddenSettingsResult: ReturnType<typeof useHiddenSettings> | undefined;

    function TestComponent() {
      hookResult = useUserRbac();
      hiddenSettingsResult = useHiddenSettings();
      return <div data-testid="ready">Ready</div>;
    }

    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <TestComponent />
          </QueryClientProvider>
        );
      });

      expect(hookResult).toBeDefined();
      expect(hookResult?.role).toBe("owner");
      expect(hookResult?.isOwnerOrAdmin).toBe(true);
      expect(hookResult?.canManageSettings).toBe(true);
      expect(hookResult?.canCreateCompany).toBe(true);
      expect(hookResult?.canAccessSecrets).toBe(true);
      expect(hookResult?.canAccessEnvironments).toBe(true);
      expect(hookResult?.canAccessUsers).toBe(true);
      expect(hookResult?.canAccessPlugins).toBe(true);
      expect(hookResult?.canAccessAdapters).toBe(true);
      expect(hookResult?.canAccessExperimental).toBe(true);
      expect(hookResult?.canExportCompany).toBe(true);
      expect(hookResult?.canImportCompany).toBe(true);

      // Owner can edit any agent
      expect(hookResult?.canEditAgent("any-agent-id")).toBe(true);

      // Hidden settings should be empty (none added by RBAC)
      const hidden = hiddenSettingsResult?.hidden;
      expect(hidden?.size).toBe(0);
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
});
