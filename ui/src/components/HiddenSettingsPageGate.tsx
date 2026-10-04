import { Navigate, Outlet } from "@/lib/router";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useUserRbac } from "@/hooks/useUserRbac";

/**
 * Route gate for settings pages the hosting operator or RBAC policy can hide
 * (`instance.access`, `instance.plugins`, `instance.adapters`, `company.secrets`, etc.).
 * Hidden pages redirect to the settings root or dashboard instead of rendering.
 */
export function HiddenSettingsPageGate({ pageKey }: { pageKey: string }) {
  const { hidden, loaded } = useHiddenSettings();
  const { canManageSettings, isLoading: rbacLoading } = useUserRbac();

  if (!loaded || rbacLoading) return null;
  if (hidden.has(pageKey)) {
    return <Navigate to={canManageSettings ? "/company/settings" : "/dashboard"} replace />;
  }
  return <Outlet />;
}

