import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { accessApi, type HumanCompanyRole } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { dataSourcesApi } from "@/api/data-sources";
import { projectsApi } from "@/api/projects";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Card } from "@/components/ui/card";
import { companyDirectoryQueryOptions, useAccountIdentity } from "@/api/companies-query";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

function CompanyMembershipAccessConfig({
  companyId,
  companyName,
  userId,
  search,
}: {
  companyId: string;
  companyName: string;
  userId: string;
  search: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const accessConfigQuery = useQuery({
    queryKey: ["user-access-config", companyId, userId],
    queryFn: () => accessApi.getUserAccessConfig(companyId, userId),
    enabled: !!companyId && !!userId,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const dataSourcesQuery = useQuery({
    queryKey: ["data-sources", companyId],
    queryFn: () => dataSourcesApi.list(companyId),
    enabled: !!companyId,
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", companyId],
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const [role, setRole] = useState<HumanCompanyRole>("operator");
  const [assignedAgentIds, setAssignedAgentIds] = useState<string[]>([]);
  const [allowedDataSourceIds, setAllowedDataSourceIds] = useState<string[]>([]);
  const [assignedProjectIds, setAssignedProjectIds] = useState<string[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!accessConfigQuery.data) return;
    setRole(accessConfigQuery.data.role);
    setAssignedAgentIds(accessConfigQuery.data.assignedAgentIds ?? []);
    setAllowedDataSourceIds(accessConfigQuery.data.allowedDataSourceIds ?? []);
    setAssignedProjectIds(accessConfigQuery.data.assignedProjectIds ?? []);
  }, [accessConfigQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      accessApi.updateUserAccessConfig(companyId, userId, {
        role,
        assignedAgentIds,
        allowedDataSourceIds,
        assignedProjectIds,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user-access-config", companyId, userId] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(userId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      pushToast({ title: `Access configuration saved for ${companyName}`, tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update access",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const agents = agentsQuery.data ?? [];
  const dataSources = dataSourcesQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{companyName}</h3>
          <p className="text-xs text-muted-foreground">Configure role and fine-grained resource permissions</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <span>Role:</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as HumanCompanyRole)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium focus:ring-ring"
            >
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </Button>
        </div>
      </div>

      {isExpanded && (
        <>
          {role === "owner" || role === "admin" ? (
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              {role === "owner" ? "Owners" : "Admins"} have full administrative access to all agents, data sources, projects, and settings across {companyName}.
            </div>
          ) : role === "viewer" ? (
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              Viewers have read-only visibility for this organization.
            </div>
          ) : (
            <div className="space-y-4 border-t border-border pt-3">
              {accessConfigQuery.data && (
                <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-xs">
                  <span className="font-medium">Operator Agent Limit:</span>
                  <span className="text-muted-foreground">
                    {accessConfigQuery.data.operatorCreatedAgentCount} / {accessConfigQuery.data.operatorMaxAgents} agents created by this operator (Max 3)
                  </span>
                </div>
              )}

              {/* Assigned Agents */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Assigned Agents ({assignedAgentIds.length}/{agents.length})
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAssignedAgentIds(agents.map((a) => a.id))}
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAssignedAgentIds([])}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {agents.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground">No agents in this organization.</div>
                  ) : (
                    agents.map((agent) => (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-xs hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={assignedAgentIds.includes(agent.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setAssignedAgentIds((prev) => [...prev, agent.id]);
                            } else {
                              setAssignedAgentIds((prev) => prev.filter((id) => id !== agent.id));
                            }
                          }}
                        />
                        <span className="font-medium text-foreground">{agent.name}</span>
                        <span className="text-muted-foreground">({agent.role})</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              {/* Allowed Data Sources */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Allowed Data Sources ({allowedDataSourceIds.length}/{dataSources.length})
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAllowedDataSourceIds(dataSources.map((ds) => ds.id))}
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAllowedDataSourceIds([])}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {dataSources.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground">No data sources in this organization.</div>
                  ) : (
                    dataSources.map((ds) => (
                      <label
                        key={ds.id}
                        className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-xs hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={allowedDataSourceIds.includes(ds.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setAllowedDataSourceIds((prev) => [...prev, ds.id]);
                            } else {
                              setAllowedDataSourceIds((prev) => prev.filter((id) => id !== ds.id));
                            }
                          }}
                        />
                        <span className="font-medium text-foreground">{ds.name}</span>
                        <span className="text-muted-foreground">({ds.sourceType})</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              {/* Assigned Projects */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Assigned Projects ({assignedProjectIds.length}/{projects.length})
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAssignedProjectIds(projects.map((p) => p.id))}
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAssignedProjectIds([])}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {projects.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground">No projects in this organization.</div>
                  ) : (
                    projects.map((proj) => (
                      <label
                        key={proj.id}
                        className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-xs hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={assignedProjectIds.includes(proj.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setAssignedProjectIds((prev) => [...prev, proj.id]);
                            } else {
                              setAssignedProjectIds((prev) => prev.filter((id) => id !== proj.id));
                            }
                          }}
                        />
                        <span className="font-medium text-foreground">{proj.name}</span>
                        {proj.description && (
                          <span className="truncate text-muted-foreground">({proj.description})</span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end border-t border-border pt-3">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving..." : "Save Access Configuration"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function InstanceAccess() {
  const { userId: accountUserId, settled: accountSettled } = useAccountIdentity();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  const companiesQuery = useQuery({
    ...companyDirectoryQueryOptions(accountUserId),
    enabled: accountSettled && usersQuery.isSuccess,
  });
  const companies = companiesQuery.data ?? [];

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  const updateCompanyAccessMutation = useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Organization access updated", tone: "success" });
    },
  });

  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      if (selectedUserId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId) });
      }
      pushToast({ title: "Instance role updated", tone: "success" });
    },
  });

  if (usersQuery.isLoading || !accountSettled || (usersQuery.isSuccess && companiesQuery.isPending)) {
    return <div className="text-sm text-muted-foreground">Loading instance access…</div>;
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? "Instance admin access is required to manage users."
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : "Failed to load users.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  if (companiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">Failed to load organizations. Try again before changing access.</p>
        <Button onClick={() => void companiesQuery.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Instance Access</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which organizations they can access.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-(--gtc-34)">
        <Card className="block space-y-4 p-4">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Search users</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or email"
            />
          </label>
          <div className="space-y-2">
            {(usersQuery.data ?? []).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  user.id === selectedUserId
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.email || user.id}</div>
                    <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                  </div>
                  {user.isInstanceAdmin ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {user.activeCompanyMembershipCount} active organization memberships
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="block space-y-4 p-5">
          {!selectedUserId ? (
            <div className="text-sm text-muted-foreground">Select a user to inspect instance access.</div>
          ) : userAccessQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading user access…</div>
          ) : userAccessQuery.error ? (
            <div className="text-sm text-destructive">
              {userAccessQuery.error instanceof Error ? userAccessQuery.error.message : "Failed to load user access."}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold">
                    {selectedUser?.name || selectedUser?.email || selectedUserId}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selectedUser?.email || selectedUserId}
                  </div>
                </div>
                <Button
                  variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                  onClick={() => setAdminMutation.mutate(!(selectedUser?.isInstanceAdmin ?? false))}
                  disabled={setAdminMutation.isPending}
                >
                  {selectedUser?.isInstanceAdmin ? "Remove instance admin" : "Promote to instance admin"}
                </Button>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Organization access</h2>
                  <p className="text-sm text-muted-foreground">
                    Toggle organization membership for this user. New access defaults to an active operator membership.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                    >
                      <Checkbox
                        checked={selectedCompanyIds.has(company.id)}
                        onCheckedChange={(checked) => {
                          setSelectedCompanyIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(company.id);
                            else next.delete(company.id);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{company.name}</span>
                        <span className="block text-xs text-muted-foreground">{company.issuePrefix}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => updateCompanyAccessMutation.mutate()}
                    disabled={updateCompanyAccessMutation.isPending}
                  >
                    {updateCompanyAccessMutation.isPending ? "Saving…" : "Save organization access"}
                  </Button>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">Organization Permissions & Resource Access</h2>
                  <p className="text-sm text-muted-foreground">
                    Configure role and fine-grained agent, data source, and project access for each organization membership.
                  </p>
                </div>
                <div className="space-y-4">
                  {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                    <CompanyMembershipAccessConfig
                      key={membership.id}
                      companyId={membership.companyId}
                      companyName={membership.companyName || membership.companyId}
                      userId={selectedUserId}
                      search={search}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
