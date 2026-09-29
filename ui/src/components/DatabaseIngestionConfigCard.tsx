import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  Database,
  Server,
  Cpu,
  Layers,
  Zap,
  ExternalLink,
  Save,
  Plus,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToastActions } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { dataSourcesApi } from "@/api/data-sources";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";

interface DatabaseIngestionConfig {
  autoMirrorToClickHouse: boolean;
  autoDiscoverRelations: boolean;
  sampleSize: "50" | "100" | "500" | "2000";
  querySafetyMode: "strict" | "standard" | "extended";
}

export function DatabaseIngestionConfigCard({
  agent,
  companyId,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const savedConfig: Partial<DatabaseIngestionConfig> =
    (agent.metadata as any)?.databaseIngestionConfig || {};

  const [autoMirrorToClickHouse, setAutoMirrorToClickHouse] = useState<boolean>(
    savedConfig.autoMirrorToClickHouse !== false
  );
  const [autoDiscoverRelations, setAutoDiscoverRelations] = useState<boolean>(
    savedConfig.autoDiscoverRelations !== false
  );
  const [sampleSize, setSampleSize] = useState<
    "50" | "100" | "500" | "2000"
  >(savedConfig.sampleSize || "100");
  const [querySafetyMode, setQuerySafetyMode] = useState<
    "strict" | "standard" | "extended"
  >(savedConfig.querySafetyMode || "standard");

  const [isSaving, setIsSaving] = useState(false);

  // Fetch company data sources to display managed external databases
  const dataSourcesQuery = useQuery({
    queryKey: ["data-sources", companyId],
    queryFn: () => (companyId ? dataSourcesApi.list(companyId) : Promise.resolve([])),
    enabled: Boolean(companyId),
  });

  const databaseSources = (dataSourcesQuery.data || []).filter(
    (ds) =>
      ds.sourceType === "postgres" ||
      ds.sourceType === "mariadb" ||
      ds.sourceType === "mysql" ||
      ds.sourceType === "clickhouse" ||
      ds.metadata?.onboardedBy === agent.name ||
      (ds.metadata?.connectionConfig && typeof ds.metadata.connectionConfig === "object")
  );

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const nextConfig: DatabaseIngestionConfig = {
        autoMirrorToClickHouse,
        autoDiscoverRelations,
        sampleSize,
        querySafetyMode,
      };

      const updatedMetadata = {
        ...(typeof agent.metadata === "object" && agent.metadata !== null
          ? agent.metadata
          : {}),
        databaseIngestionConfig: nextConfig,
      };

      await agentsApi.update(agent.id, {
        metadata: updatedMetadata,
      });

      queryClient.invalidateQueries({ queryKey: ["agents", agent.id] });
      pushToast({
        title: "Configuration Saved",
        body: "Relational database topology & mirror policies updated successfully.",
        tone: "success",
      });
    } catch (err: any) {
      pushToast({
        title: "Failed to Save",
        body: err?.message || "Could not update database ingestion configuration.",
        tone: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6"
      aria-labelledby="database-ingestion-heading"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <h3
              id="database-ingestion-heading"
              className="text-base font-semibold text-foreground flex items-center gap-2"
            >
              Relational Database Catalog &amp; Topology Policies
              <Badge variant="outline" className="text-xs bg-muted">
                JEV Relational Engine
              </Badge>
            </h3>
            <p className="text-xs text-muted-foreground">
              Autonomous foreign key inferencing, topology graph discovery, read-only analytical query profiling, and ClickHouse schema mirroring.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{isSaving ? "Saving..." : "Save Settings"}</span>
          </Button>
        </div>
      </div>

      {/* Engine & OLAP Mirror Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Catalog &amp; Topology Engine
            </span>
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className="text-sm font-medium text-foreground">Autonomous Schema Introspector</div>
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              db.table_role.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              db.join_candidates.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              db.foreign_keys.v1
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              ClickHouse OLAP Mirror
            </span>
            <Layers className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <span>Continuous / Batch CDC Sync</span>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <p className="text-xs text-muted-foreground">
            Direct table projection to ClickHouse analytical tables with materialized views and dictionary lookups.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Supported Engines
            </span>
            <Zap className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="secondary" className="text-xs">
              PostgreSQL
            </Badge>
            <Badge variant="secondary" className="text-xs">
              MariaDB
            </Badge>
            <Badge variant="secondary" className="text-xs">
              MySQL
            </Badge>
            <Badge variant="secondary" className="text-xs">
              ClickHouse
            </Badge>
            <Badge variant="secondary" className="text-xs">
              SQL Server
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Secure read-only connection pooling with SSL certificate validation and query throttling.
          </p>
        </div>
      </div>

      {/* Config Form Controls */}
      <div className="rounded-lg border border-border p-4 bg-card space-y-4">
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Database Ingestion &amp; Catalog Preferences
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Auto-Mirror Tables to ClickHouse OLAP
              </span>
              <p className="text-xs text-muted-foreground">
                Automatically construct ClickHouse analytical mirror tables and materialized views upon onboarding.
              </p>
            </div>
            <ToggleSwitch
              checked={autoMirrorToClickHouse}
              onCheckedChange={setAutoMirrorToClickHouse}
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Autonomous Relation &amp; FK Discovery
              </span>
              <p className="text-xs text-muted-foreground">
                Analyze data overlap and column semantics to infer cross-table joins and entity relationships when foreign keys are missing.
              </p>
            </div>
            <ToggleSwitch
              checked={autoDiscoverRelations}
              onCheckedChange={setAutoDiscoverRelations}
            />
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Schema Introspection Sampling Size
            </label>
            <Select
              value={sampleSize}
              onValueChange={(val: any) => setSampleSize(val)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select sample size" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">
                  50 rows per table (Ultra Fast Sampling)
                </SelectItem>
                <SelectItem value="100">
                  100 rows per table (Fast Profiling - Recommended)
                </SelectItem>
                <SelectItem value="500">
                  500 rows per table (Balanced Profiling)
                </SelectItem>
                <SelectItem value="2000">
                  2,000 rows per table (Deep Cardinality Profiling)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Number of rows sampled per table to profile column data types, cardinality, and null rates.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Read-Only Query Safety Limit
            </label>
            <Select
              value={querySafetyMode}
              onValueChange={(val: any) => setQuerySafetyMode(val)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select query safety mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">
                  Strict (5s execution timeout / 1,000 rows max)
                </SelectItem>
                <SelectItem value="standard">
                  Standard (15s timeout / 5,000 rows max - Recommended)
                </SelectItem>
                <SelectItem value="extended">
                  Extended (30s timeout / 25,000 rows max)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Enforces maximum execution timeout and limit for background agent schema queries.
            </p>
          </div>
        </div>
      </div>

      {/* Managed External Databases List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" /> Connected External Databases (
            {databaseSources.length})
          </h4>
          <Link
            to="/data-sources"
            className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
          >
            <span>+ Connect External Database</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {databaseSources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
            <Server className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              No external relational databases currently connected.
            </p>
            <Link to="/data-sources">
              <Button size="sm" variant="outline" className="mt-2 text-xs">
                <Plus className="h-3.5 w-3.5 mr-1" /> Connect First Database
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {databaseSources.map((ds) => {
              const conn = (ds.metadata as any)?.connectionConfig;
              const hostStr = conn?.host ? `${conn.host}${conn.port ? `:${conn.port}` : ""}` : null;
              const tables = (ds.metadata as any)?.schemaProfile?.tables || [];
              const tableCount = tables.length || ((ds.metadata as any)?.tablesCount) || 0;
              const domain = ds.semanticProfile?.domain || (ds.metadata as any)?.semanticProfile?.domain;

              return (
                <div
                  key={ds.id}
                  className="rounded-lg border border-border bg-muted/20 p-4 space-y-2.5 transition-all hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/data-sources/${ds.id}`}
                        className="font-medium text-sm text-foreground hover:text-primary hover:underline truncate block"
                      >
                        {ds.name}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground uppercase font-mono">
                          {conn?.type || ds.sourceType}
                        </span>
                        {hostStr && (
                          <span className="text-xs text-muted-foreground font-mono truncate max-w-40">
                            {hostStr}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge
                        variant={ds.status === "ready" ? "secondary" : "outline"}
                        className="text-xs"
                      >
                        {ds.status}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                      >
                        <Sparkles className="h-3 w-3 mr-1" />
                        Mirror Active
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                    <span className="truncate max-w-48">
                      {tableCount > 0 ? `${tableCount} table${tableCount !== 1 ? "s" : ""}` : "Catalog synced"}
                      {domain ? ` · ${domain}` : ""}
                    </span>
                    <Link
                      to={`/data-sources/${ds.id}`}
                      className="text-primary hover:underline flex items-center gap-1 shrink-0"
                    >
                      <span>View Database Catalog</span>
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
