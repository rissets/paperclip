import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { api } from "@/api/client";
import type { UserRbacStatus } from "@paperclipai/shared";

export function useUserRbac() {
  const { selectedCompanyId } = useCompany();

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
    isOwnerOrAdmin: rbac?.isOwnerOrAdmin ?? false,
    canAddDataSource: rbac?.canAddDataSource ?? false,
    canAddAgent: rbac?.canAddAgent ?? false,
    assignedAgentIds: rbac?.assignedAgentIds ?? [],
    canEditAgent: (agentId?: string | null): boolean => {
      if (!rbac) return false;
      if (rbac.isOwnerOrAdmin) return true;
      if (!agentId) return false;
      return rbac.assignedAgentIds?.includes(agentId) ?? false;
    },
  };
}
