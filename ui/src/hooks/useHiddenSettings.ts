import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useUserRbac } from "./useUserRbac";

/**
 * Settings surfaces hidden by the hosting operator, from the app-wide health
 * query cache (keys from the shared settings-visibility registry, e.g.
 * "instance.plugins" or "instance.experimental.enableSmokeLab"), merged with
 * role-based access control (RBAC) restrictions for the current user.
 *
 * `loaded` is false until the health response is in the cache — gates should
 * render nothing rather than flash a surface that may turn out to be hidden.
 */
export function useHiddenSettings(): { hidden: ReadonlySet<string>; loaded: boolean } {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: false,
  });

  const { rbac } = useUserRbac();

  const data = healthQuery.data;
  return useMemo(() => {
    const hiddenSet = new Set(data?.hiddenSettings ?? []);

    if (rbac) {
      if (!rbac.canAccessSecrets) {
        hiddenSet.add("company.secrets");
      }
      if (!rbac.canAccessEnvironments) {
        hiddenSet.add("instance.environments");
        hiddenSet.add("instance.heartbeats");
      }
      if (!rbac.canAccessUsers) {
        hiddenSet.add("instance.access");
        hiddenSet.add("company.members");
        hiddenSet.add("company.invites");
      }
      if (!rbac.canAccessExperimental) {
        hiddenSet.add("instance.experimental");
      }
      if (!rbac.canAccessPlugins) {
        hiddenSet.add("instance.plugins");
      }
      if (!rbac.canAccessAdapters) {
        hiddenSet.add("instance.adapters");
      }
      if (!rbac.canExportCompany) {
        hiddenSet.add("company.export");
      }
      if (!rbac.canImportCompany) {
        hiddenSet.add("company.import");
      }
      if (!rbac.canManageSettings) {
        hiddenSet.add("company.settings");
      }
    }

    return { hidden: hiddenSet, loaded: data !== undefined };
  }, [data, rbac]);
}

