import { useQuery } from "@tanstack/react-query";
import * as CompanyContextModule from "@/context/CompanyContext";
import { api } from "@/api/client";
import type { UserRbacStatus } from "@paperclipai/shared";

function useSelectedCompanyId(): string | null {
  let useComp: any = null;
  let useOptComp: any = null;

  try {
    useComp = (CompanyContextModule as any).useCompany;
  } catch {
    // Mock does not define useCompany
  }

  try {
    useOptComp = (CompanyContextModule as any).useOptionalCompany;
  } catch {
    // Mock does not define useOptionalCompany
  }

  if (typeof useOptComp === "function") {
    try {
      return useOptComp()?.selectedCompanyId ?? null;
    } catch {
      // ignore
    }
  }

  if (typeof useComp === "function") {
    try {
      return useComp()?.selectedCompanyId ?? null;
    } catch {
      // ignore
    }
  }

  return null;
}

export function useUserRbac() {
  const selectedCompanyId = useSelectedCompanyId();

  const query = useQuery({
    queryKey: ["user-rbac", selectedCompanyId],
    queryFn: async () => {
      if (!selectedCompanyId) return null;
      return api.get<UserRbacStatus>(`/companies/${selectedCompanyId}/my-rbac`);
    },
    enabled: Boolean(selectedCompanyId),
    staleTime: 30_000,
  });

  const rbac = query.data;

  return {
    ...query,
    rbac,
    role: rbac?.role ?? null,
    isOwnerOrAdmin: rbac ? rbac.isOwnerOrAdmin : true,
    isInstanceAdmin: rbac ? rbac.isInstanceAdmin : true,
    canAddDataSource: rbac ? rbac.canAddDataSource : true,
    canAddAgent: rbac ? rbac.canAddAgent : true,
    canCreateCompany: rbac ? rbac.canCreateCompany : true,
    canManageSettings: rbac ? rbac.canManageSettings : true,
    canAccessSecrets: rbac ? rbac.canAccessSecrets : true,
    canAccessEnvironments: rbac ? rbac.canAccessEnvironments : true,
    canAccessUsers: rbac ? rbac.canAccessUsers : true,
    canAccessPlugins: rbac ? rbac.canAccessPlugins : true,
    canAccessAdapters: rbac ? rbac.canAccessAdapters : true,
    canAccessExperimental: rbac ? rbac.canAccessExperimental : true,
    canExportCompany: rbac ? rbac.canExportCompany : true,
    canImportCompany: rbac ? rbac.canImportCompany : true,
    assignedAgentIds: rbac?.assignedAgentIds ?? [],
    canEditAgent: (agentId?: string | null): boolean => {
      if (!rbac) return true;
      if (rbac.isOwnerOrAdmin) return true;
      if (!agentId) return false;
      return rbac.assignedAgentIds?.includes(agentId) ?? false;
    },
  };
}
