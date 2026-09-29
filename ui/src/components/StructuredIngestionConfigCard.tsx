import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  Database,
  FileSpreadsheet,
  Cpu,
  Zap,
  CheckCircle2,
  ExternalLink,
  Save,
  Plus,
  ArrowRight,
  Sparkles,
  GitBranch,
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

interface StructuredIngestionConfig {
  autoSyncClickhouse: boolean;
  crossTableRelations: boolean;
  defaultSyncStrategy: "upsert" | "replace" | "append";
  batchSize: number;
}

export function StructuredIngestionConfigCard({
  agent,
  companyId,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const savedConfig: Partial<StructuredIngestionConfig> =
    (agent.metadata as any)?.structuredIngestionConfig || {};

  const [autoSyncClickhouse, setAutoSyncClickhouse] = useState<boolean>(
    savedConfig.autoSyncClickhouse !== false
  );
  const [crossTableRelations, setCrossTableRelations] = useState<boolean>(
    savedConfig.crossTableRelations !== false
  );
  const [defaultSyncStrategy, setDefaultSyncStrategy] = useState<
    "upsert" | "replace" | "append"
  >(savedConfig.defaultSyncStrategy || "upsert");
  const [batchSize, setBatchSize] = useState<string>(
    String(savedConfig.batchSize || 100)
  );

  const [isSaving, setIsSaving] = useState(false);

  // Fetch company data sources to display managed datasets
  const dataSourcesQuery = useQuery({
    queryKey: ["data-sources", companyId],
    queryFn: () => (companyId ? dataSourcesApi.list(companyId) : Promise.resolve([])),
    enabled: Boolean(companyId),
  });

  const structuredSources = (dataSourcesQuery.data || []).filter(
    (ds) =>
      ds.sourceType === "csv" ||
      ds.sourceType === "excel" ||
      ds.metadata?.onboardedBy === agent.name
  );

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const nextConfig: StructuredIngestionConfig = {
        autoSyncClickhouse,
        crossTableRelations,
        defaultSyncStrategy,
        batchSize: Number(batchSize) || 100,
      };

      const updatedMetadata = {
        ...(typeof agent.metadata === "object" && agent.metadata !== null
          ? agent.metadata
          : {}),
        structuredIngestionConfig: nextConfig,
      };

      await agentsApi.update(agent.id, {
        metadata: updatedMetadata,
      });

      queryClient.invalidateQueries({ queryKey: ["agents", agent.id] });
      pushToast({
        title: "Configuration Saved",
        body: "Structured data ingestion policies updated successfully.",
        tone: "success",
      });
    } catch (err: any) {
      pushToast({
        title: "Failed to Save",
        body: err?.message || "Could not update ingestion configuration.",
        tone: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6"
      aria-labelledby="structured-ingestion-heading"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <h3
              id="structured-ingestion-heading"
              className="text-base font-semibold text-foreground flex items-center gap-2"
            >
              Structured Data Ingestion & OLAP Policies
              <Badge variant="outline" className="text-xs bg-muted">
                JEV System One
              </Badge>
            </h3>
            <p className="text-xs text-muted-foreground">
              Automated schema extraction, TypeSafe JEV semantic mapping, and ClickHouse OLAP acceleration.
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

      {/* Engine & OLAP Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Ingestion Engine
            </span>
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className="text-sm font-medium text-foreground">TypeSafe JEV System One</div>
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              struct.column_role.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              struct.entity_metric_mapping.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              struct.sync_strategy.v1
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              OLAP Engine
            </span>
            <Database className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <span>ClickHouse MergeTree</span>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <p className="text-xs text-muted-foreground">
            Automatic column DDL deduction &amp; batch JSONEachRow streaming active.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Supported Formats
            </span>
            <Zap className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="secondary" className="text-xs">
              CSV (.csv)
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Excel (.xlsx, .xls)
            </Badge>
            <Badge variant="secondary" className="text-xs">
              TSV / Parquet
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Multi-sheet extraction with cross-table foreign key inference.
          </p>
        </div>
      </div>

      {/* Config Form Controls */}
      <div className="rounded-lg border border-border p-4 bg-card space-y-4">
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Ingestion &amp; Synchronization Preferences
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Auto-Sync to ClickHouse OLAP
              </span>
              <p className="text-xs text-muted-foreground">
                Mirror all onboarded structured datasets into ClickHouse OLAP tables for sub-second queries.
              </p>
            </div>
            <ToggleSwitch
              checked={autoSyncClickhouse}
              onCheckedChange={setAutoSyncClickhouse}
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Cross-Table Semantic Linking
              </span>
              <p className="text-xs text-muted-foreground">
                Automatically link customer, product, and transaction keys with existing company tables.
              </p>
            </div>
            <ToggleSwitch
              checked={crossTableRelations}
              onCheckedChange={setCrossTableRelations}
            />
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Default Ingestion Strategy
            </label>
            <Select
              value={defaultSyncStrategy}
              onValueChange={(val: any) => setDefaultSyncStrategy(val)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upsert">
                  Upsert on Primary Key (Preserve History)
                </SelectItem>
                <SelectItem value="replace">
                  Full Replace (Periodic Snapshot)
                </SelectItem>
                <SelectItem value="append">
                  Append-Only (Log Stream)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applied when no explicit sync strategy is provided in the file header.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Batch Ingestion Chunk Size
            </label>
            <Select value={batchSize} onValueChange={setBatchSize}>
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select batch size" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="100">100 rows / batch (Low Memory)</SelectItem>
                <SelectItem value="500">500 rows / batch (Balanced)</SelectItem>
                <SelectItem value="1000">1,000 rows / batch (High Throughput)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Controls database insert batch size for records and ClickHouse streaming.
            </p>
          </div>
        </div>
      </div>

      {/* Managed Structured Data Sources List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" /> Managed Structured Data Sources (
            {structuredSources.length})
          </h4>
          <Link
            to="/data-sources"
            className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
          >
            <span>+ Onboard New Dataset</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {structuredSources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
            <FileSpreadsheet className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              No structured data sources currently onboarded.
            </p>
            <Link to="/data-sources">
              <Button size="sm" variant="outline" className="mt-2 text-xs">
                <Plus className="h-3.5 w-3.5 mr-1" /> Onboard First Dataset
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {structuredSources.map((ds) => {
              const tableCount = (ds.metadata as any)?.tableCount || ds.tables?.length || 1;
              const totalRows = (ds.metadata as any)?.totalRows || 0;
              const completedAt = (ds.metadata as any)?.completedAt || ds.updatedAt;

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
                      <span className="text-xs text-muted-foreground uppercase font-mono">
                        {ds.sourceType}
                      </span>
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
                        ClickHouse Active
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                    <span>
                      {tableCount} table{tableCount !== 1 ? "s" : ""} · {totalRows > 0 ? `${totalRows.toLocaleString()} rows` : "Populated"}
                    </span>
                    <Link
                      to={`/data-sources/${ds.id}`}
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      <span>View Profile</span>
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
