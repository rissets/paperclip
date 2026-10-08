import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  FileSpreadsheet,
  FileText,
  ArrowLeft,
  Sparkles,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  RefreshCw,
  Server,
  GitBranch,
  Key,
  Terminal,
  Bot,
  Globe,
  Radio,
  Video,
  Workflow,
  Target,
  Network,
  Table2,
  Link2,
  Hash,
  Compass,
  ArrowRight,
  CornerDownRight,
  FileCode,
  Check,
  Folder,
  XCircle,
  Trash2,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { dataSourcesApi } from "@/api/data-sources";
import { DataSourceMappingReviewPanel } from "@/components/data-sources/DataSourceMappingReviewPanel";
import { cn } from "@/lib/utils";
import type { SqlQueryResult, StructuredQueryResult } from "@paperclipai/shared";

function relationBelongsToTable(relation: any, table: any) {
  if (!relation || !table) return false;
  const schema = table.semanticModel?.sourceSchema || "public";
  return (
    (relation.sourceTable?.toLowerCase() === table.tableName?.toLowerCase() &&
      (!relation.sourceSchema || relation.sourceSchema === schema)) ||
    (relation.targetTable?.toLowerCase() === table.tableName?.toLowerCase() &&
      (!relation.targetSchema || relation.targetSchema === schema))
  );
}

export function DataSourceDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<string>("schema");
  const [selectedTableIndex, setSelectedTableIndex] = useState(0);
  const [expandedJsonCol, setExpandedJsonCol] = useState<string | null>(null);

  // Structured Query Tester state
  const [queryMetric, setQueryMetric] = useState("");
  const [queryAggFn, setQueryAggFn] = useState<"sum" | "avg" | "count" | "min" | "max">("sum");
  const [queryGroupBy, setQueryGroupBy] = useState("");
  const [queryFilterKey, setQueryFilterKey] = useState("");
  const [queryFilterVal, setQueryFilterVal] = useState("");
  const [queryMode, setQueryMode] = useState<"live" | "snapshot">("live");
  const [incrementalUpdatedAtColumn, setIncrementalUpdatedAtColumn] = useState("");
  const [incrementalDeletedAtColumn, setIncrementalDeletedAtColumn] = useState("");

  // Direct SQL Query Runner state (for external databases)
  const [sqlQuery, setSqlQuery] = useState("");
  const [sqlResult, setSqlResult] = useState<SqlQueryResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // RAG Search Tester state
  const [searchQuery, setSearchQuery] = useState("");
  const [targetEmbeddingSpace, setTargetEmbeddingSpace] = useState<"bge-m3" | "openrouter-text-embedding-3-small">("bge-m3");
  const [prunableVectorRows, setPrunableVectorRows] = useState<number | null>(null);
  const [prunableGenerations, setPrunableGenerations] = useState<Array<{ embeddingSpace: string; embeddingGeneration: string }>>([]);

  const { data: ds, isLoading, error } = useQuery({
    queryKey: ["data-source", selectedCompanyId, id],
    queryFn: () => dataSourcesApi.get(selectedCompanyId!, id!),
    enabled: !!selectedCompanyId && !!id,
    refetchInterval: (query) =>
      query.state.data?.status === "processing" || query.state.data?.status === "onboarding"
        || query.state.data?.ingestionJob?.status === "queued" || query.state.data?.ingestionJob?.status === "running"
        || query.state.data?.ingestionJob?.status === "cancel_requested"
        ? 1500
        : false,
  });

  const activeTable = ds?.tables?.[selectedTableIndex];
  const activeQuality = (activeTable?.semanticModel as any)?.qualityCounters as {
    totalRows?: number;
    validRows?: number;
    quarantinedRows?: number;
    publishedRows?: number;
    typeViolations?: number;
    duplicateRows?: number;
    quarantineSamples?: Array<{ rowNumber: number; columns: string[]; reason: string }>;
  } | undefined;
  const activeColumns = (Array.isArray(activeTable?.schemaDefinition) ? activeTable.schemaDefinition : []) as Array<{
    name: string;
    dataType?: string;
    role?: string;
  }>;
  const updatedAtCandidates = activeColumns.filter((column) => column.dataType === "date" || column.role === "timestamp");
  const deletedAtCandidates = activeColumns.filter((column) =>
    (column.dataType === "date" || column.role === "timestamp")
      && /(^|_)(deleted|deleted_at|removed|removed_at)($|_)/i.test(column.name),
  );
  const activeExternalSnapshot = (activeTable?.semanticModel as any)?.externalSnapshot;
  const jobProgress = ds?.ingestionJob?.progress ?? {};
  const ingestionJobActive = ds?.ingestionJob?.status === "queued"
    || ds?.ingestionJob?.status === "running"
    || ds?.ingestionJob?.status === "cancel_requested";
  const jobProgressText = typeof jobProgress.rowsScanned === "number"
    ? `${jobProgress.rowsScanned.toLocaleString()} rows scanned`
    : typeof jobProgress.insertedRows === "number" && typeof jobProgress.totalRows === "number"
      ? `${jobProgress.insertedRows.toLocaleString()} / ${jobProgress.totalRows.toLocaleString()} rows loaded`
      : typeof jobProgress.insertedChunks === "number" && typeof jobProgress.chunkCount === "number"
        ? `${jobProgress.insertedChunks.toLocaleString()} / ${jobProgress.chunkCount.toLocaleString()} chunks indexed`
        : typeof jobProgress.processedChunks === "number" && typeof jobProgress.totalChunks === "number"
          ? `${jobProgress.processedChunks.toLocaleString()} / ${jobProgress.totalChunks.toLocaleString()} chunks re-embedded`
      : null;

  const ragMetadata = (ds?.metadata || {}) as Record<string, unknown>;
  const documentExtraction = ragMetadata.documentExtractionQuality && typeof ragMetadata.documentExtractionQuality === "object"
    ? ragMetadata.documentExtractionQuality as Record<string, unknown>
    : null;
  const activeEmbeddingSpace = ragMetadata.embeddingSpace === "bge-m3"
    || ragMetadata.embeddingSpace === "openrouter-text-embedding-3-small"
    ? ragMetadata.embeddingSpace
    : null;
  const previousEmbeddingSpace = ragMetadata.previousEmbeddingSpace === "bge-m3"
    || ragMetadata.previousEmbeddingSpace === "openrouter-text-embedding-3-small"
    ? ragMetadata.previousEmbeddingSpace
    : null;
  const previousEmbeddingGeneration = typeof ragMetadata.previousEmbeddingGeneration === "string"
    ? ragMetadata.previousEmbeddingGeneration
    : null;

  useEffect(() => {
    if (activeEmbeddingSpace) {
      setTargetEmbeddingSpace(activeEmbeddingSpace === "bge-m3"
        ? "openrouter-text-embedding-3-small"
        : "bge-m3");
    }
  }, [ds?.id, activeEmbeddingSpace]);

  useEffect(() => {
    const preferredUpdatedAt = updatedAtCandidates.find((column) => /^(updated_at|updatedat|modified_at|last_modified)$/i.test(column.name));
    setIncrementalUpdatedAtColumn((preferredUpdatedAt || updatedAtCandidates[0])?.name || "");
    setIncrementalDeletedAtColumn(deletedAtCandidates[0]?.name || "");
  }, [activeTable?.id]);

  // Update starter SQL when active table changes
  useEffect(() => {
    if (activeTable && ds) {
      const quote = ds.sourceType === "postgres" ? `"` : "`";
      setSqlQuery(`SELECT * FROM ${quote}${activeTable.tableName}${quote} LIMIT 10`);
      setSqlResult(null);
      setSqlError(null);
    }
  }, [activeTable?.tableName, ds?.sourceType]);

  const queryMutation = useMutation({
    mutationFn: (params: any) => {
      return dataSourcesApi.queryTable(selectedCompanyId!, id!, activeTable!.id, params);
    },
  });

  const sqlMutation = useMutation({
    mutationFn: (sql: string) => {
      return dataSourcesApi.querySql(selectedCompanyId!, id!, sql, 50);
    },
    onSuccess: (res) => {
      setSqlResult(res);
      setSqlError(null);
    },
    onError: (err: any) => {
      setSqlError(err?.message || "SQL execution failed.");
      setSqlResult(null);
    },
  });

  const searchMutation = useMutation({
    mutationFn: (query: string) =>
      dataSourcesApi.searchKnowledge(selectedCompanyId!, query, {
        dataSourceId: id,
        limit: 5,
      }),
  });

  const reprocessMutation = useMutation({
    mutationFn: () => dataSourcesApi.reprocess(selectedCompanyId!, id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  const embeddingReindexMutation = useMutation({
    mutationFn: (request: { targetSpace: "bge-m3" | "openrouter-text-embedding-3-small"; targetGeneration?: string }) =>
      dataSourcesApi.reindexEmbeddings(selectedCompanyId!, id!, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  const embeddingPruneMutation = useMutation({
    mutationFn: (request: { confirm: boolean; expectedGenerations?: Array<{ embeddingSpace: string; embeddingGeneration: string }> }) =>
      dataSourcesApi.pruneEmbeddingGenerations(selectedCompanyId!, id!, request),
    onSuccess: ({ data }, confirm) => {
      setPrunableVectorRows(confirm.confirm ? null : data.candidateVectorRows);
      setPrunableGenerations(confirm.confirm ? [] : data.candidates.map(({ embeddingSpace, embeddingGeneration }) => ({
        embeddingSpace,
        embeddingGeneration,
      })));
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
    },
  });

  const snapshotMutation = useMutation({
    mutationFn: () => dataSourcesApi.snapshotExternalDatabase(selectedCompanyId!, id!, { mode: "full" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  const incrementalSnapshotMutation = useMutation({
    mutationFn: () => {
      if (!activeTable || !incrementalUpdatedAtColumn) throw new Error("Select an updated-at timestamp column first.");
      return dataSourcesApi.snapshotExternalDatabase(selectedCompanyId!, id!, {
        mode: "incremental",
        tableIds: [activeTable.id],
        tablePolicies: [{
          tableId: activeTable.id,
          updatedAtColumn: incrementalUpdatedAtColumn,
          ...(incrementalDeletedAtColumn ? { deletedAtColumn: incrementalDeletedAtColumn } : {}),
        }],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  const cancelIngestionMutation = useMutation({
    mutationFn: (jobId: string) => dataSourcesApi.cancelIngestionJob(selectedCompanyId!, id!, jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  if (!selectedCompanyId || !id) {
    return <div className="p-8 text-center text-muted-foreground">Invalid parameters.</div>;
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading data source details...
      </div>
    );
  }

  if (error || !ds) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
        <h3 className="mt-2 text-base font-semibold text-foreground">Data source not found</h3>
        <Link to="/data-sources" className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Data Sources
        </Link>
      </div>
    );
  }

  const isDatabase = ds.sourceType === "postgres" || ds.sourceType === "mariadb" || ds.sourceType === "mysql";
  const isStructured = ds.sourceType === "csv" || ds.sourceType === "excel";
  const serverVersion = (ds.metadata as any)?.serverVersion || "";
  const connectionConfig = (ds.metadata as any)?.connectionConfig;

  const handleRunStructuredQuery = () => {
    if (!activeTable) return;
    const filterObj: Record<string, any> = {};
    if (queryFilterKey && queryFilterVal) {
      filterObj[queryFilterKey] = queryFilterVal;
    }

    queryMutation.mutate({
      filter: Object.keys(filterObj).length > 0 ? filterObj : undefined,
      aggregate: queryMetric
        ? {
            column: queryMetric,
            fn: queryAggFn,
            groupBy: queryGroupBy || undefined,
          }
        : undefined,
      mode: queryMode,
      limit: 20,
    });
  };

  const handleRunSql = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sqlQuery.trim()) return;
    sqlMutation.mutate(sqlQuery.trim());
  };

  const handleRunSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    searchMutation.mutate(searchQuery.trim());
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Back button & Header */}
      <div>
        <Link
          to="/data-sources"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground mb-3 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Data Sources
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                isDatabase
                  ? "bg-primary/10 text-primary"
                  : isStructured
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-sky-500/10 text-sky-600"
              }`}
            >
              {isDatabase ? (
                <Database className="h-6 w-6" />
              ) : isStructured ? (
                <FileSpreadsheet className="h-6 w-6" />
              ) : (
                <FileText className="h-6 w-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-foreground">{ds.name}</h1>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    ds.status === "ready"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : ds.status === "processing" || ds.status === "onboarding"
                      ? "bg-amber-500/10 text-amber-500 border border-amber-500/20 animate-pulse"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {ds.status === "ready" && <CheckCircle2 className="h-3 w-3" />}
                  {(ds.status === "processing" || ds.status === "onboarding") && (
                    <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                  )}
                  {ds.status === "error" && <AlertCircle className="h-3 w-3" />}
                  {ds.status}
                </span>
                <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground uppercase tracking-wide">
                  {ds.sourceType}
                </span>
                {ds.collectionId && (
                  <Link
                    to={`/data-sources/collections/${ds.collectionId}`}
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 hover:bg-primary/20 transition-colors px-2 py-0.5 text-xs font-medium text-primary border border-primary/20"
                  >
                    <Folder className="h-3 w-3" />
                    Collection: {ds.collectionName || "Collection"}
                  </Link>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isDatabase ? (
                  <>
                    Connected to{" "}
                    <span className="font-semibold text-foreground">
                      {connectionConfig?.database || "database"}
                    </span>{" "}
                    ({connectionConfig?.host}:{connectionConfig?.port}) • {serverVersion || "Live Driver"}
                  </>
                ) : (
                  <>
                    {ds.fileName || "File"} • {ds.fileSize ? `${Math.round(ds.fileSize / 1024)} KB • ` : ""}
                    Added on {new Date(ds.createdAt).toLocaleDateString()}
                  </>
                )}
              </p>
              {ds.ingestionJob && (ingestionJobActive || ds.ingestionJob.status === "failed") && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2 text-xs" role="status" aria-live="polite">
                  <div>
                    <span className="font-medium text-foreground">{ds.ingestionJob.jobType === "external_db_snapshot"
                      ? "Snapshot"
                      : ds.ingestionJob.jobType === "embedding_reindex" ? "Embedding reindex" : "Ingestion"} {ds.ingestionJob.status.replaceAll("_", " ")}</span>
                    <span className="text-muted-foreground"> · {ds.ingestionJob.stage.replaceAll("_", " ")} · attempt {ds.ingestionJob.attempt}/{ds.ingestionJob.maxAttempts}</span>
                    {jobProgressText && <span className="text-muted-foreground"> · {jobProgressText}</span>}
                    {ds.ingestionJob.lastError && <p className="mt-1 text-destructive">{ds.ingestionJob.lastError}</p>}
                    {cancelIngestionMutation.isError && <p className="mt-1 text-destructive" role="alert">{(cancelIngestionMutation.error as Error).message || "Could not cancel the datasource job."}</p>}
                  </div>
                  {ds.ingestionJob.status === "cancel_requested" ? (
                    <span className="shrink-0 text-muted-foreground">Stopping…</span>
                  ) : ingestionJobActive && ds.ingestionJob.id ? (
                    <button
                      type="button"
                      onClick={() => cancelIngestionMutation.mutate(ds.ingestionJob!.id)}
                      disabled={cancelIngestionMutation.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 font-medium text-foreground transition-colors hover:bg-background disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {cancelIngestionMutation.isPending ? "Stopping…" : "Cancel job"}
                    </button>
                  ) : null}
                </div>
              )}
              {snapshotMutation.isError && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {(snapshotMutation.error as Error).message || "Could not queue the database snapshot."}
                </p>
              )}
              {incrementalSnapshotMutation.isError && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {(incrementalSnapshotMutation.error as Error).message || "Could not queue incremental sync."}
                </p>
              )}
              {embeddingReindexMutation.isError && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {(embeddingReindexMutation.error as Error).message || "Could not queue embedding reindex."}
                </p>
              )}
              {embeddingPruneMutation.isError && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {(embeddingPruneMutation.error as Error).message || "Could not clean up old embedding vectors."}
                </p>
              )}

              {/* JEV Semantic Profile Header Tags */}
              {ds.semanticProfile && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary border border-primary/20">
                    <Bot className="h-3 w-3" />
                    Onboarded by {ds.semanticProfile.onboardedBy || "Onboarding Orchestrator"}
                  </span>
                  {ds.semanticProfile.domain && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-mono uppercase text-foreground border border-border">
                      Domain: {ds.semanticProfile.domain}
                    </span>
                  )}
                  {ds.semanticProfile.targetAgentAffinity && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-secondary/80 px-2 py-0.5 text-xs font-medium text-secondary-foreground border border-border">
                      <Target className="h-3 w-3 text-primary" />
                      Agent Affinity: {ds.semanticProfile.targetAgentAffinity}
                    </span>
                  )}
                  {ds.semanticProfile.decisionSpecRefs && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-card px-2 py-0.5 text-xs font-mono text-muted-foreground border border-border">
                      JEV Specs: {ds.semanticProfile.decisionSpecRefs.join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
            {isDatabase && (
              <>
                <button
                  onClick={() => snapshotMutation.mutate()}
                  disabled={snapshotMutation.isPending || ingestionJobActive}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                  title="Read eligible tables in bounded keyset pages and publish a full ClickHouse reconciliation snapshot"
                >
                  <Database className={cn("h-3.5 w-3.5", snapshotMutation.isPending && "animate-pulse text-primary")} />
                  {snapshotMutation.isPending ? "Queueing snapshot..." : "Full snapshot"}
                </button>
                {activeTable && (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="incremental-updated-at">Updated at</label>
                    <select
                      id="incremental-updated-at"
                      value={incrementalUpdatedAtColumn}
                      onChange={(event) => setIncrementalUpdatedAtColumn(event.target.value)}
                      disabled={updatedAtCandidates.length === 0 || ingestionJobActive}
                      className="max-w-36 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                    >
                      {updatedAtCandidates.length === 0 && <option value="">No timestamp column</option>}
                      {updatedAtCandidates.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                    </select>
                    {deletedAtCandidates.length > 0 && (
                      <>
                        <label className="text-xs text-muted-foreground" htmlFor="incremental-deleted-at">Deleted at</label>
                        <select
                          id="incremental-deleted-at"
                          value={incrementalDeletedAtColumn}
                          onChange={(event) => setIncrementalDeletedAtColumn(event.target.value)}
                          disabled={ingestionJobActive}
                          className="max-w-32 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                        >
                          <option value="">No tombstone column</option>
                          {deletedAtCandidates.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                        </select>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => incrementalSnapshotMutation.mutate()}
                      disabled={incrementalSnapshotMutation.isPending || ingestionJobActive || !incrementalUpdatedAtColumn}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background disabled:opacity-50"
                      title="Read changed rows for the selected table. Hard deletes remain until a full snapshot unless a tombstone column is selected."
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", incrementalSnapshotMutation.isPending && "animate-spin text-primary")} />
                      {incrementalSnapshotMutation.isPending ? "Queueing delta..." : "Sync changes"}
                    </button>
                    <span className="w-full text-xs text-muted-foreground">
                      {incrementalDeletedAtColumn
                        ? `Tombstones use the later of ${incrementalUpdatedAtColumn || "updated-at"} and ${incrementalDeletedAtColumn}.`
                        : "Hard-deleted rows stay in the snapshot until the next full snapshot."}
                      {typeof activeExternalSnapshot?.watermarkMicros === "string" && (
                        <> Current watermark: {new Date(Number(BigInt(activeExternalSnapshot.watermarkMicros) / 1_000n)).toLocaleString()}.</>
                      )}
                    </span>
                  </div>
                )}
              </>
            )}
            {ds.sourceType === "rag_document" && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
                <span className="text-xs text-muted-foreground" title={typeof ragMetadata.embeddingGeneration === "string" ? ragMetadata.embeddingGeneration : undefined}>
                  Active: {activeEmbeddingSpace === "bge-m3" ? "BAAI BGE-M3" : activeEmbeddingSpace === "openrouter-text-embedding-3-small" ? "OpenRouter small" : "lexical only"}
                </span>
                {documentExtraction && (
                  <span
                    className={cn(
                      "text-xs",
                      documentExtraction.ocrStatus === "partial" || documentExtraction.ocrStatus === "unavailable"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                    title={typeof documentExtraction.ocrFailure === "string" ? documentExtraction.ocrFailure : undefined}
                  >
                    {documentExtraction.extractor === "pdfjs"
                      ? typeof documentExtraction.scannedPageCount === "number" && documentExtraction.scannedPageCount > 0
                        ? `OCR ${Number(documentExtraction.ocrPageCount || 0)}/${documentExtraction.scannedPageCount} scanned pages (${String(documentExtraction.ocrStatus || "unknown")})`
                        : "PDF text layer extracted; OCR not needed"
                      : "DOCX text extracted"}
                  </span>
                )}
                <label className="sr-only" htmlFor="embedding-reindex-target">Target embedding model</label>
                <select
                  id="embedding-reindex-target"
                  value={targetEmbeddingSpace}
                  onChange={(event) => setTargetEmbeddingSpace(event.target.value as typeof targetEmbeddingSpace)}
                  disabled={ingestionJobActive || embeddingReindexMutation.isPending}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  <option value="bge-m3">BAAI BGE-M3 · 1024</option>
                  <option value="openrouter-text-embedding-3-small">OpenRouter small · 1536</option>
                </select>
                <button
                  type="button"
                  onClick={() => embeddingReindexMutation.mutate({ targetSpace: targetEmbeddingSpace })}
                  disabled={ingestionJobActive || embeddingReindexMutation.isPending || ds.status !== "ready"}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background disabled:opacity-50"
                  title="Build the target vector generation in bounded batches; the current active index stays in use until the complete index is published."
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", embeddingReindexMutation.isPending && "animate-spin text-primary")} />
                  {embeddingReindexMutation.isPending ? "Queueing…" : "Reindex vectors"}
                </button>
                {previousEmbeddingSpace && previousEmbeddingGeneration && (
                  <button
                    type="button"
                    onClick={() => embeddingReindexMutation.mutate({
                      targetSpace: previousEmbeddingSpace,
                      targetGeneration: previousEmbeddingGeneration,
                    })}
                    disabled={ingestionJobActive || embeddingReindexMutation.isPending || ds.status !== "ready"}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    title={`Switch back to retained generation ${previousEmbeddingGeneration}`}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Roll back
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => embeddingPruneMutation.mutate({ confirm: false })}
                  disabled={ingestionJobActive || embeddingReindexMutation.isPending || embeddingPruneMutation.isPending || ds.status !== "ready"}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  title="Preview vector generations older than 90 days. Active and rollback generations are protected."
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", embeddingPruneMutation.isPending && "animate-spin text-primary")} />
                  {embeddingPruneMutation.isPending ? "Reviewing…" : "Review old vectors"}
                </button>
                {prunableVectorRows !== null && (
                  <span className="w-full text-xs text-muted-foreground" role="status">
                    {prunableVectorRows === 0
                      ? "No unpinned vector generations are older than 90 days."
                      : `${prunableVectorRows.toLocaleString()} vectors in unpinned generations are older than 90 days. Active and rollback generations are protected.`}
                  </span>
                )}
                {prunableVectorRows !== null && prunableVectorRows > 0 && (
                  <button
                    type="button"
                    onClick={() => embeddingPruneMutation.mutate({ confirm: true, expectedGenerations: prunableGenerations })}
                    disabled={ingestionJobActive || embeddingReindexMutation.isPending || embeddingPruneMutation.isPending || ds.status !== "ready"}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    title="Delete only the generations shown in the preview, subject to the same 90-day and active-generation checks."
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {embeddingPruneMutation.isPending ? "Deleting…" : "Delete eligible old vectors"}
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => reprocessMutation.mutate()}
              disabled={reprocessMutation.isPending || ingestionJobActive}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
              title="Reprocess data source (re-run AI analysis & sync)"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  reprocessMutation.isPending && "animate-spin text-primary",
                )}
              />
              {reprocessMutation.isPending ? "Reprocessing..." : "Reprocess"}
            </button>
          </div>
        </div>
      </div>

      {/* Live Onboarding Progress Card */}
      {(ds.status === "processing" || ds.status === "onboarding") && (
        <div className="rounded-xl border border-primary/20 bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary shrink-0">
              <Loader2 className="h-7 w-7 animate-spin" />
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-foreground">
                  Autonomous Onboarding In Progress
                </h2>
                <span className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
                  Live Ingestion
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Specialist agent{" "}
                <span className="font-semibold text-foreground">
                  {isStructured
                    ? "Structured Ingestion Agent"
                    : isDatabase
                    ? "Database Ingestion Agent"
                    : "Knowledge Ingestion Agent"}
                </span>{" "}
                is actively analyzing this dataset. Schema profiling, AI reasoning, entity mapping, and topic synthesis are running in the background. This page will update automatically.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <div className="font-semibold text-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                1. File Uploaded
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                {ds.fileName || "File"} safely saved.
              </p>
            </div>
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
              <div className="font-semibold text-primary flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                2. Schema Profiling
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Inspecting columns, types, null ratios, and cardinality.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
              <div className="font-semibold text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                3. AI Reasoning
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Determining domain, entities, composite PK, & metrics.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
              <div className="font-semibold text-muted-foreground flex items-center gap-1.5">
                <Layers className="h-4 w-4 text-muted-foreground" />
                4. Topics & Storage
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Synthesizing analytical topics & saving to database.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error Card */}
      {ds.status === "error" && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-destructive/10 p-3 text-destructive shrink-0">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="flex-1 space-y-1">
              <h2 className="text-base font-semibold text-destructive">
                Onboarding Failed
              </h2>
              <p className="text-xs text-muted-foreground">
                An error occurred while ingesting this data source:
              </p>
              <pre className="mt-2 rounded-md bg-muted/50 p-3 text-xs text-destructive overflow-x-auto font-mono">
                {(ds.metadata as any)?.error || "Unknown onboarding failure"}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Structured or Database View */}
      {(isDatabase || isStructured) && (
        <div className="space-y-6">
          {/* Table Selector */}
          {ds.tables && ds.tables.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                Select Table ({ds.tables.length}):
              </span>
              <div className="flex gap-1.5 overflow-x-auto">
                {ds.tables.map((tbl, idx) => (
                  <button
                    key={tbl.id}
                    onClick={() => {
                      setSelectedTableIndex(idx);
                      queryMutation.reset();
                      setSqlResult(null);
                      setSqlError(null);
                    }}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      selectedTableIndex === idx
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tbl.tableName} ({tbl.rowCount} rows)
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* View Tabs */}
          <div className="flex items-center gap-2 border-b border-border pb-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab("schema")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === "schema"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Schema & Profiling
            </button>
            <button
              onClick={() => setActiveTab("semantic")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === "semantic"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Semantic Model & Relations
            </button>
            {isDatabase && (
              <button
                onClick={() => setActiveTab("sql")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                  activeTab === "sql"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Terminal className="h-4 w-4" />
                Read-Only SQL Runner
              </button>
            )}
            <button
              onClick={() => setActiveTab("query")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === "query"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Aggregator Tester
            </button>
            <button
              onClick={() => setActiveTab("readiness")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === "readiness"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <CheckCircle2 className="h-4 w-4" />
              Readiness & Evidence
            </button>
            <button
              onClick={() => setActiveTab("jev")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === "jev"
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles className="h-4 w-4" />
              JEV Semantic Profile & DecisionSpecs
            </button>
          </div>

          {/* Tab: Readiness & Evidence */}
          {activeTab === "readiness" && (
            <ReadinessAndEvidenceView ds={ds} companyId={selectedCompanyId} />
          )}

          {/* Tab: JEV Semantic Profile */}
          {activeTab === "jev" && (
            <JevSemanticProfileView
              ds={ds}
              selectedTableIndex={selectedTableIndex}
              onSelectTableIndex={setSelectedTableIndex}
            />
          )}

          {/* Tab 1: Schema & Profiling */}
          {activeTab === "schema" && activeTable && (
            <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h3 className="font-semibold text-sm text-foreground">
                  Table Columns: <span className="font-mono text-primary">{activeTable.tableName}</span> (
                  {activeTable.columnCount} columns, {activeTable.rowCount} rows)
                </h3>
              </div>
              {isStructured && typeof activeQuality?.totalRows === "number" && (
                <div className="border-b border-border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Source records: <strong className="text-foreground">{activeQuality.totalRows.toLocaleString()}</strong></span>
                    <span>Published: <strong className="text-foreground">{(activeQuality.publishedRows ?? activeQuality.validRows ?? activeTable.rowCount).toLocaleString()}</strong></span>
                    <span>Quarantined: <strong className={activeQuality.quarantinedRows ? "text-amber-600" : "text-foreground"}>{(activeQuality.quarantinedRows ?? 0).toLocaleString()}</strong></span>
                    <span>Duplicate rows: <strong className="text-foreground">{(activeQuality.duplicateRows ?? 0).toLocaleString()}</strong></span>
                  </div>
                  {Boolean(activeQuality.quarantineSamples?.length) && (
                    <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
                      <p className="font-medium">Invalid records are excluded from queries. The original source file is retained for review.</p>
                      <ul className="mt-1 space-y-0.5 text-muted-foreground">
                        {activeQuality.quarantineSamples!.slice(0, 5).map((sample, index) => (
                          <li key={`${sample.rowNumber}-${index}`}>
                            Source record {sample.rowNumber.toLocaleString()} · {sample.reason.replaceAll("_", " ")}
                            {sample.columns.length ? ` · ${sample.columns.join(", ")}` : ""}
                          </li>
                        ))}
                      </ul>
                      {(activeQuality.quarantinedRows ?? 0) > activeQuality.quarantineSamples!.length && (
                        <p className="mt-1 text-muted-foreground">Showing the first {activeQuality.quarantineSamples!.length} row references; total quarantined: {activeQuality.quarantinedRows!.toLocaleString()}.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
                    <tr>
                      <th className="p-3">Column Name</th>
                      <th className="p-3">Role</th>
                      <th className="p-3">Data Type</th>
                      <th className="p-3">Key Attributes</th>
                      <th className="p-3">Distinct</th>
                      <th className="p-3">Null Ratio</th>
                      <th className="p-3">Sample Values</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-foreground">
                    {activeTable.schemaDefinition.map((col: any) => (
                      <tr key={col.name} className="hover:bg-muted/50">
                        <td className="p-3 font-medium flex items-center gap-1.5">
                          {col.isPrimaryKey && <Key className="h-3 w-3 text-amber-500 shrink-0" />}
                          {col.isForeignKey && <GitBranch className="h-3 w-3 text-primary shrink-0" />}
                          <div>
                            <div>{col.name}</div>
                            {col.clickhouseType && (
                              <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate max-w-xs" title={col.clickhouseType}>
                                CH: {col.clickhouseType}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <span
                            className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${
                              col.role === "metric"
                                ? "bg-amber-500/10 text-amber-600"
                                : col.role === "identifier"
                                ? "bg-purple-500/10 text-purple-600"
                                : col.role === "timestamp"
                                ? "bg-blue-500/10 text-blue-600"
                                : "bg-emerald-500/10 text-emerald-600"
                            }`}
                          >
                            {col.role}
                          </span>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-muted-foreground font-mono text-xs">{col.dataType}</span>
                            {col.isJson && (
                              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-xs font-semibold text-indigo-500">
                                JSON ({col.jsonStructure?.kind || "nested"})
                              </span>
                            )}
                          </div>
                          {col.isJson && col.jsonStructure?.subFields?.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setExpandedJsonCol(expandedJsonCol === col.name ? null : col.name)}
                              className="mt-1 text-xs text-primary hover:underline block font-medium"
                            >
                              {expandedJsonCol === col.name ? "Hide sub-fields" : `View ${col.jsonStructure.subFields.length} sub-fields`}
                            </button>
                          )}
                          {expandedJsonCol === col.name && col.jsonStructure?.subFields && (
                            <div className="mt-2 p-2.5 rounded-lg bg-muted/60 border border-border text-xs space-y-1.5 max-w-md">
                              <div className="font-semibold text-foreground text-xs uppercase tracking-wider">
                                Sub-fields from sample rows ({col.jsonStructure.subFields.length})
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                                {col.jsonStructure.subFields.map((sf: any) => (
                                  <div key={sf.name} className="p-1.5 rounded bg-background border border-border text-xs">
                                    <div className="flex justify-between font-mono">
                                      <span className="font-medium text-foreground truncate">{sf.name}</span>
                                      <span className="text-muted-foreground">{sf.dataType}</span>
                                    </div>
                                    {sf.sampleValues && sf.sampleValues.length > 0 && (
                                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                                        e.g. {sf.sampleValues.join(", ")}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          {col.isPrimaryKey && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-semibold text-amber-600">
                              PRIMARY KEY
                            </span>
                          )}
                          {col.isForeignKey && col.foreignKeyTarget && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                              FK → {col.foreignKeyTarget.table}.{col.foreignKeyTarget.column}
                            </span>
                          )}
                          {!col.isPrimaryKey && !col.isForeignKey && (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="p-3">{col.distinctCount ?? "-"}</td>
                        <td className="p-3">
                          {typeof col.nullRatio === "number" ? `${(col.nullRatio * 100).toFixed(1)}%` : "-"}
                        </td>
                        <td className="p-3 text-muted-foreground truncate max-w-xs">
                          {col.sampleValues?.join(", ") || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 2: Semantic Model & Relations */}
          {activeTab === "semantic" && activeTable && (
            <div className="space-y-4">
              {/* Foreign Key Relationships */}
              {(() => {
                const tableRelationships =
                  activeTable.semanticModel?.relationships && activeTable.semanticModel.relationships.length > 0
                    ? activeTable.semanticModel.relationships
                    : (ds?.semanticProfile?.relationships || []).filter(
                        (rel: any) => relationBelongsToTable(rel, activeTable)
                      );

                if (!tableRelationships || tableRelationships.length === 0) return null;

                return (
                  <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
                    <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                      <GitBranch className="h-4 w-4 text-primary" /> Foreign Key Relationships (Relational
                      Graph)
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      {tableRelationships.map((rel: any, idx: number) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg border border-border bg-muted/50 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between font-semibold text-foreground">
                            <span>
                              {rel.sourceTable}.{rel.sourceColumn}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-primary">
                              {rel.targetTable}.{rel.targetColumn}
                            </span>
                          </div>
                          <p className="text-muted-foreground text-xs">
                            Type: <span className="font-medium text-foreground">{rel.type || rel.relationType || "many-to-one"}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Nested JSON Dimensions */}
              {activeTable.semanticModel?.nestedDimensions &&
                activeTable.semanticModel.nestedDimensions.length > 0 && (
                  <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-indigo-500" /> Nested JSON Dimensions (
                        {activeTable.semanticModel.nestedDimensions.length} Virtual Attributes)
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        Mapped from sample rows for AI semantic querying
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-80 overflow-y-auto pr-1">
                      {activeTable.semanticModel.nestedDimensions.map((nd: any) => {
                        const synList = activeTable.semanticModel?.synonyms?.[nd.name] || [];
                        return (
                          <div
                            key={nd.name}
                            className="p-3 rounded-lg border border-border bg-muted/40 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between font-mono">
                              <span className="font-semibold text-foreground truncate">{nd.name}</span>
                              <span className="text-muted-foreground uppercase">{nd.dataType}</span>
                            </div>
                            <p className="text-muted-foreground text-xs truncate">{nd.description}</p>
                            {synList.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {synList.slice(0, 3).map((syn: string) => (
                                  <span
                                    key={syn}
                                    className="rounded bg-background border border-border px-1 py-0.5 text-xs text-muted-foreground"
                                  >
                                    {syn}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Metrics */}
                <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
                  <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" /> Metrics (Analytical Aggregations)
                  </h3>
                  <div className="space-y-2">
                    {activeTable.semanticModel?.metrics && activeTable.semanticModel.metrics.length > 0 ? (
                      activeTable.semanticModel.metrics.map((m: any) => (
                        <div
                          key={m.name}
                          className="p-3 rounded-lg bg-muted text-xs flex justify-between items-center"
                        >
                          <div>
                            <span className="font-semibold text-foreground">{m.name}</span>
                            <p className="text-muted-foreground mt-0.5">{m.description}</p>
                          </div>
                          <span className="font-mono text-primary font-medium">{m.expression}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">No numerical metrics detected in this table.</p>
                    )}
                  </div>
                </div>

                {/* Dimensions & Bilingual Synonyms */}
                <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
                  <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" /> Dimensions & Bilingual Synonyms
                  </h3>
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {activeTable.semanticModel?.dimensions && activeTable.semanticModel.dimensions.length > 0 ? (
                      activeTable.semanticModel.dimensions.map((d: any) => {
                        const synonymsList = activeTable.semanticModel?.synonyms?.[d.name] || [];
                        return (
                          <div key={d.name} className="p-3 rounded-lg bg-muted text-xs space-y-1.5">
                            <div className="flex justify-between items-center">
                              <span className="font-semibold text-foreground">{d.name}</span>
                              <span className="text-muted-foreground font-mono">dimension</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {synonymsList.map((syn: string) => (
                                <span
                                  key={syn}
                                  className="rounded bg-background border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                                >
                                  {syn}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-xs text-muted-foreground">No categorical dimensions detected.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* ClickHouse Schema & DDL */}
              {activeTable.semanticModel?.clickhouseSchema && (
                <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                      <Database className="h-4 w-4 text-emerald-500" /> ClickHouse Analytical Schema & DDL
                    </h3>
                    <span className="text-xs text-muted-foreground font-mono">
                      Engine: {activeTable.semanticModel.clickhouseSchema.engine}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Auto-generated ClickHouse table definition with mapped tuple columns and MergeTree ordering.
                  </p>
                  <pre className="p-4 rounded-lg bg-muted border border-border font-mono text-xs overflow-x-auto text-foreground whitespace-pre">
                    {activeTable.semanticModel.clickhouseSchema.createTableDdl}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Direct Read-Only SQL Runner (for external DBs) */}
          {activeTab === "sql" && isDatabase && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-primary" /> Read-Only SQL Playground
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Execute safe, bounded SELECT queries directly against {ds.name}. Mutations (DDL/DML) are blocked.
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const quote = ds.sourceType === "postgres" ? `"` : "`";
                      setSqlQuery(`SELECT * FROM ${quote}${activeTable?.tableName}${quote} LIMIT 10`);
                    }}
                    className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    Select 10
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const quote = ds.sourceType === "postgres" ? `"` : "`";
                      setSqlQuery(`SELECT COUNT(*) as total_rows FROM ${quote}${activeTable?.tableName}${quote}`);
                    }}
                    className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    Count Rows
                  </button>
                </div>
              </div>

              <form onSubmit={handleRunSql} className="space-y-3">
                <textarea
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                  rows={4}
                  className="w-full font-mono text-xs rounded-lg border border-border bg-background p-3 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="SELECT * FROM table LIMIT 10"
                />

                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Maximum limit: 500 rows per query</span>
                  <button
                    type="submit"
                    disabled={sqlMutation.isPending || !sqlQuery.trim()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
                  >
                    {sqlMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5 fill-current" />
                    )}
                    {sqlMutation.isPending ? "Executing..." : "Run Query"}
                  </button>
                </div>
              </form>

              {sqlError && (
                <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {sqlError}
                </div>
              )}

              {sqlResult && (
                <div className="space-y-3 pt-3 border-t border-border">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Returned <span className="font-semibold text-foreground">{sqlResult.rowCount}</span> rows in{" "}
                      <span className="font-semibold text-foreground">{sqlResult.executionTimeMs}ms</span>
                    </span>
                  </div>

                  <div className="rounded-lg border border-border overflow-x-auto max-h-80">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted text-muted-foreground font-medium border-b border-border sticky top-0">
                        <tr>
                          {sqlResult.columns.map((col) => (
                            <th key={col} className="p-2.5 whitespace-nowrap">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border text-foreground">
                        {sqlResult.rows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-muted/50">
                            {sqlResult.columns.map((col) => (
                              <td key={col} className="p-2.5 whitespace-nowrap">
                                {row[col] !== null && row[col] !== undefined ? String(row[col]) : "-"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 4: Interactive Aggregator Tester */}
          {activeTab === "query" && activeTable && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
              <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <Play className="h-4 w-4 text-primary fill-current" /> Aggregation & Filter Playground
              </h3>
              <p className="text-xs text-muted-foreground">
                Test controlled aggregations against this table as used by the Data Agent.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-muted/40 p-4 rounded-lg border border-border text-xs">
                <div>
                  <label className="block font-medium text-foreground mb-1">Metric Column</label>
                  <select
                    value={queryMetric}
                    onChange={(e) => setQueryMetric(e.target.value)}
                    className="w-full rounded border border-border bg-background p-1.5 text-foreground"
                  >
                    <option value="">(None - Select Rows)</option>
                    {activeTable.schemaDefinition
                      .filter((c: any) => c.role === "metric")
                      .map((c: any) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">Aggregation Function</label>
                  <select
                    value={queryAggFn}
                    onChange={(e) => setQueryAggFn(e.target.value as any)}
                    disabled={!queryMetric}
                    className="w-full rounded border border-border bg-background p-1.5 text-foreground disabled:opacity-50"
                  >
                    <option value="sum">SUM</option>
                    <option value="avg">AVG</option>
                    <option value="count">COUNT</option>
                    <option value="min">MIN</option>
                    <option value="max">MAX</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">Group By Dimension</label>
                  <select
                    value={queryGroupBy}
                    onChange={(e) => setQueryGroupBy(e.target.value)}
                    disabled={!queryMetric}
                    className="w-full rounded border border-border bg-background p-1.5 text-foreground disabled:opacity-50"
                  >
                    <option value="">(None - Global Aggregation)</option>
                    {activeTable.schemaDefinition
                      .filter((c: any) => c.role === "dimension" || c.role === "timestamp")
                      .map((c: any) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">Filter (Column = Value)</label>
                  <div className="flex gap-1">
                    <select
                      value={queryFilterKey}
                      onChange={(e) => setQueryFilterKey(e.target.value)}
                      className="w-1/2 rounded border border-border bg-background p-1.5 text-foreground"
                    >
                      <option value="">(Column)</option>
                      {activeTable.schemaDefinition.map((c: any) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="val"
                      value={queryFilterVal}
                      onChange={(e) => setQueryFilterVal(e.target.value)}
                      className="w-1/2 rounded border border-border bg-background p-1.5 text-foreground"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                {isDatabase && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Query source
                    <select
                      value={queryMode}
                      onChange={(event) => setQueryMode(event.target.value as "live" | "snapshot")}
                      className="rounded border border-border bg-background px-2 py-1.5 text-foreground"
                    >
                      <option value="live">Live database</option>
                      <option value="snapshot">ClickHouse snapshot</option>
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  onClick={handleRunStructuredQuery}
                  disabled={queryMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {queryMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                  {queryMutation.isPending ? "Running..." : "Run Query"}
                </button>
              </div>

              {queryMutation.data && (
                <div className="rounded-lg border border-border overflow-x-auto">
                  {queryMutation.data.querySource?.mode === "snapshot" && (
                    <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                      {queryMutation.data.querySource.syncMode === "incremental" ? "Incremental snapshot" : "Full snapshot"} from {queryMutation.data.querySource.snapshotAt ? new Date(queryMutation.data.querySource.snapshotAt).toLocaleString() : "unknown time"}; {queryMutation.data.querySource.consistency?.replaceAll("_", " ") || "best effort"} consistency.
                      {queryMutation.data.querySource.deleteSemantics === "soft_delete_column"
                        ? " Soft-delete tombstones are applied; hard deletes appear after a full snapshot."
                        : " Hard deletes appear after a full snapshot."}
                    </p>
                  )}
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
                      <tr>
                        {queryMutation.data.columns.map((col: string) => (
                          <th key={col} className="p-2.5 whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border text-foreground">
                      {queryMutation.data.rows.map((row: any, idx: number) => (
                        <tr key={idx} className="hover:bg-muted/50">
                          {queryMutation.data.columns.map((col: string) => (
                            <td key={col} className="p-2.5 whitespace-nowrap">
                              {row[col] !== null && row[col] !== undefined ? String(row[col]) : "-"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* RAG Knowledge Document View */}
      {ds.sourceType === "rag_document" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 border-b border-border pb-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab("rag-search")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab !== "jev" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Hybrid RAG Search Tester
            </button>
            <button
              onClick={() => setActiveTab("jev")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === "jev" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles className="h-4 w-4" />
              JEV Semantic Profile & DecisionSpecs
            </button>
          </div>

          {activeTab === "jev" ? (
            <JevSemanticProfileView ds={ds} />
          ) : (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
              <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> Hybrid Vector & Lexical RAG Search
              </h3>
              <p className="text-xs text-muted-foreground">
                Test semantic search across chunked passages in this document as performed by KnowledgeAgent.
              </p>

              <form onSubmit={handleRunSearch} className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Ask a question or enter keywords (e.g. SLA uptime guarantee)..."
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="submit"
                  disabled={searchMutation.isPending || !searchQuery.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {searchMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
                </button>
              </form>

              {searchMutation.data && (
                <div className="space-y-3 pt-3">
                  <h4 className="text-xs font-semibold text-foreground">
                    Search Results ({searchMutation.data.length} matches):
                  </h4>
                  {searchMutation.data.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No matching chunks found.</p>
                  ) : (
                    searchMutation.data.map((res) => (
                      <div key={res.chunkId} className="p-4 rounded-lg bg-muted border border-border text-xs space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-foreground">{res.title}</span>
                          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            Score: {(res.score * 100).toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-muted-foreground">{res.content}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Stream & API View */}
      {(ds.sourceType === "api_rest" || ds.sourceType === "mqtt_iot" || ds.sourceType === "cctv_feed") && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 border-b border-border pb-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab("stream-config")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab !== "jev" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Stream & Transport Configuration
            </button>
            <button
              onClick={() => setActiveTab("jev")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === "jev" ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles className="h-4 w-4" />
              JEV Semantic Profile & DecisionSpecs
            </button>
          </div>

          {activeTab === "jev" ? (
            <JevSemanticProfileView ds={ds} />
          ) : (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
              <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary" /> Live Stream Connection Specs
              </h3>
              <pre className="rounded-lg bg-muted p-4 text-xs font-mono text-foreground overflow-x-auto">
                {JSON.stringify(ds.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JevSemanticProfileView({
  ds,
  selectedTableIndex = 0,
  onSelectTableIndex,
}: {
  ds: any;
  selectedTableIndex?: number;
  onSelectTableIndex?: (idx: number) => void;
}) {
  const profile = ds.semanticProfile;
  const tables: any[] = ds.tables || [];
  const hasTables = tables.length > 0;
  const isRag = ds.sourceType === "rag_document";
  const hasExternalRelationalTables = ["postgres", "mysql", "mariadb"].includes(ds.sourceType);
  const tableScopeKey = (table: any) => hasExternalRelationalTables
    ? `${table.semanticModel?.sourceSchema || "public"}.${table.tableName}`
    : table.tableName;
  const tableProfileFor = (table: any) => {
    const key = tableScopeKey(table);
    return profile?.tableProfiles?.[key] || profile?.tableProfiles?.[table.tableName] || null;
  };
  const tableRoleFor = (table: any) => {
    const key = tableScopeKey(table);
    return tableProfileFor(table)?.tableRole
      || profile?.tableRoles?.[key]
      || profile?.tableRoles?.[table.tableName]
      || table.semanticModel?.tableRole;
  };
  const docProfiles: any[] = profile?.documentProfiles || [];

  const activeSelectedTable = hasTables && selectedTableIndex !== undefined && tables[selectedTableIndex]
    ? tables[selectedTableIndex]
    : null;

  const [selectedScope, setSelectedScope] = useState<string>(() => {
    return activeSelectedTable ? tableScopeKey(activeSelectedTable) : "global";
  });

  // Automatically update selectedScope when user picks a table from the top table selector
  useEffect(() => {
    if (activeSelectedTable) {
      setSelectedScope(tableScopeKey(activeSelectedTable));
    }
  }, [selectedTableIndex, activeSelectedTable?.tableName, activeSelectedTable?.semanticModel?.sourceSchema]);

  const [tableFilter, setTableFilter] = useState<string>("");
  const [copiedJoin, setCopiedJoin] = useState<string | null>(null);

  if (!profile) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center bg-card">
        <Sparkles className="mx-auto h-8 w-8 text-muted-foreground opacity-50" />
        <h4 className="mt-2 text-sm font-semibold text-foreground">No JEV Semantic Profile Available</h4>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          This data source has not been mapped with TypeSafe JEV System One DecisionSpecs yet. Click "Sync JEV Profiles" on the data sources page to generate it.
        </p>
      </div>
    );
  }

  // Active table if a table scope is selected
  const exactScopedTable = hasTables
    ? tables.find((table) => tableScopeKey(table).toLowerCase() === selectedScope.toLowerCase())
    : null;
  const legacyNameMatches = hasTables
    ? tables.filter((table) => table.tableName.toLowerCase() === selectedScope.toLowerCase())
    : [];
  const activeTable = hasTables
    ? exactScopedTable || (legacyNameMatches.length === 1 ? legacyNameMatches[0] : null) || activeSelectedTable || null
    : null;

  // Active document if RAG and document scope is selected
  const activeDoc = isRag && selectedScope !== "global"
    ? docProfiles.find((dp) => (dp.documentId || dp.fileName) === selectedScope) || docProfiles[0] || null
    : null;

  const currentTableProfile = activeTable ? tableProfileFor(activeTable) : null;
  const currentModel = activeTable?.semanticModel || {};

  // Table role badge helper
  const getTableRoleBadge = (role?: string) => {
    switch (role) {
      case "fact_table":
        return {
          label: "Fact Table",
          desc: "Transactional & Metrics Event Hub",
          className: "bg-blue-500/10 text-blue-500 border-blue-500/20",
        };
      case "dimension_table":
        return {
          label: "Dimension Table",
          desc: "Master Entity & Business Attributes",
          className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
        };
      case "lookup_table":
        return {
          label: "Lookup / Reference",
          desc: "Standard Codes, Statuses & Enums",
          className: "bg-purple-500/10 text-purple-500 border-purple-500/20",
        };
      case "bridge_table":
        return {
          label: "Bridge Junction",
          desc: "Many-to-Many Relational Association",
          className: "bg-amber-500/10 text-amber-500 border-amber-500/20",
        };
      case "staging_table":
        return {
          label: "Staging Table",
          desc: "Raw Ingestion Pipeline Buffer",
          className: "bg-muted text-muted-foreground border-border",
        };
      default:
        return {
          label: "Entity Table",
          desc: "Relational Domain Table",
          className: "bg-primary/10 text-primary border-primary/20",
        };
    }
  };

  const handleCopyJoin = (sql: string) => {
    void copyTextToClipboard(sql);
    setCopiedJoin(sql);
    setTimeout(() => setCopiedJoin(null), 2000);
  };

  const filteredTables = tables.filter((t) =>
    t.tableName.toLowerCase().includes(tableFilter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Scope Navigation Bar: Global Overview vs Per-Table / Per-Document Deep Dive */}
      <div className="rounded-xl border border-border bg-card p-3 shadow-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Compass className="h-4 w-4 text-primary" />
            <span>Semantic Inspection Scope:</span>
          </div>

          {hasTables && tables.length > 5 && (
            <input
              type="text"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Filter tables..."
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-full sm:w-48"
            />
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {/* Global Scope Button */}
          <button
            onClick={() => setSelectedScope("global")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border shadow-sm ${
              selectedScope === "global"
                ? "bg-primary text-primary-foreground border-primary font-semibold ring-1 ring-primary/30"
                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            {isRag ? "Corpus Overview & Topics" : "Global Overview & Multi-Table Topology"}
          </button>

          {/* Per-Table Scope Buttons */}
          {hasTables &&
            filteredTables.map((tbl, idx) => {
              const isSelected = selectedScope.toLowerCase() === tableScopeKey(tbl).toLowerCase();
              const role = tableRoleFor(tbl);
              const roleBadge = getTableRoleBadge(role);

              return (
                <button
                  key={tbl.id || tbl.tableName}
                  onClick={() => {
                    setSelectedScope(tableScopeKey(tbl));
                    onSelectTableIndex?.(idx);
                  }}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border ${
                    isSelected
                      ? "bg-primary text-primary-foreground border-primary font-semibold shadow-sm ring-1 ring-primary/30"
                      : "bg-muted/40 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Table2 className="h-3 w-3" />
                  <span className="font-mono">{tbl.tableName}</span>
                  {role && (
                    <span
                      className={`text-xs px-1.5 py-0.2 rounded font-normal ${
                        isSelected ? "bg-primary-foreground/20 text-primary-foreground" : roleBadge.className
                      }`}
                    >
                      {roleBadge.label}
                    </span>
                  )}
                </button>
              );
            })}

          {/* Per-Document Scope Buttons (RAG) */}
          {isRag &&
            docProfiles.map((dp, idx) => {
              const docKey = dp.documentId || dp.fileName || `doc-${idx}`;
              const isSelected = selectedScope === docKey;
              return (
                <button
                  key={docKey}
                  onClick={() => setSelectedScope(docKey)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border ${
                    isSelected
                      ? "bg-primary text-primary-foreground border-primary font-semibold shadow-sm ring-1 ring-primary/30"
                      : "bg-muted/40 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <FileText className="h-3 w-3" />
                  <span className="font-mono truncate max-w-xs">{dp.fileName || `Section ${idx + 1}`}</span>
                  {dp.topics && dp.topics.length > 0 && (
                    <span className="text-xs px-1.5 rounded bg-muted/60 text-muted-foreground">
                      {dp.topics.length} topics
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>

      {/* VIEW A: PER-TABLE DEEP DIVE */}
      {selectedScope !== "global" && activeTable && (
        <div className="space-y-6">
          {/* Table Header Banner */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Table2 className="h-5 w-5 text-primary" />
                  <h3 className="text-base font-bold text-foreground font-mono">
                    {tableScopeKey(activeTable)}
                  </h3>
                  {(() => {
                    const role =
                      currentTableProfile?.tableRole ||
                      profile.tableRoles?.[tableScopeKey(activeTable)] ||
                      profile.tableRoles?.[activeTable.tableName] ||
                      currentModel.tableRole;
                    const badge = getTableRoleBadge(role);
                    return (
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold border ${badge.className}`}
                        title={badge.desc}
                      >
                        {badge.label}
                      </span>
                    );
                  })()}
                  {currentModel.semanticMapping && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium border ${
                        currentModel.semanticMapping.status === "complete"
                          ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                          : currentModel.semanticMapping.status === "partial"
                            ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                            : "bg-muted text-muted-foreground border-border"
                      }`}
                      title={currentModel.semanticMapping.timeBudgetExceeded ? "Per-table semantic mapping budget was exhausted; deterministic catalog metadata was retained." : undefined}
                    >
                      Mapping {currentModel.semanticMapping.status} · {currentModel.semanticMapping.validatedBatches}/{currentModel.semanticMapping.expectedBatches} batches
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  JEV Table Profile & Schema Semantics ({activeTable.columnCount ?? activeTable.columns?.length ?? 0} columns,{" "}
                  {activeTable.rowCount ?? 0} rows)
                </p>
              </div>

              <button
                onClick={() => setSelectedScope("global")}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline self-start sm:self-auto"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Global Topology
              </button>
            </div>

            {/* Table Business Context Card */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                <Sparkles className="h-4 w-4" />
                <span>Table Business Context (JEV Reasoning)</span>
              </div>
              <p className="text-xs text-foreground leading-relaxed">
                {currentTableProfile?.context ||
                  currentModel.context ||
                  currentModel.description ||
                  `Relational table '${activeTable.tableName}' storing domain records with structured attributes for analytical querying.`}
              </p>
            </div>

            {/* Table-Specific Semantic Topics */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Hash className="h-4 w-4 text-amber-500" />
                <span>Table-Specific Semantic Topics ({activeTable.tableName})</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(currentTableProfile?.topics && currentTableProfile.topics.length > 0) ||
                (currentModel.topics && currentModel.topics.length > 0) ? (
                  (currentTableProfile?.topics || currentModel.topics).map((top: any, idx: number) => {
                    const label = typeof top === "string" ? top : top?.topic || top?.name || JSON.stringify(top);
                    return (
                      <span
                        key={idx}
                        className="rounded-md bg-muted border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:border-primary/40 transition-colors"
                      >
                        {label}
                      </span>
                    );
                  })
                ) : (
                  <span className="text-xs text-muted-foreground italic">
                    Per-table topics synthesized dynamically during onboarding.
                  </span>
                )}
              </div>
            </div>
          </div>

          {ds.companyId && ["csv", "excel", "postgres", "mysql", "mariadb", "clickhouse"].includes(ds.sourceType) && (
            <DataSourceMappingReviewPanel
              companyId={ds.companyId}
              dataSource={ds}
              table={activeTable}
            />
          )}

          {/* Multi-Table Connections for this table */}
          {(() => {
            const tableRels = (profile.relationships || []).filter(
              (r: any) => relationBelongsToTable(r, activeTable)
            );

            return (
              <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-semibold text-foreground">
                      Multi-Table Relational Connections ({tableRels.length})
                    </h4>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Inbound and Outbound Foreign Keys
                  </span>
                </div>

                {tableRels.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                    No foreign key relationships detected for this table. It operates as an independent entity or root lookup table.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {tableRels.map((rel: any, idx: number) => {
                      const isOutbound =
                        rel.sourceTable.toLowerCase() === activeTable.tableName.toLowerCase()
                        && (!rel.sourceSchema || rel.sourceSchema === (activeTable.semanticModel?.sourceSchema || "public"));
                      const otherTable = isOutbound ? rel.targetTable : rel.sourceTable;
                      const sourceName = rel.sourceSchema ? `${rel.sourceSchema}.${rel.sourceTable}` : rel.sourceTable;
                      const targetName = rel.targetSchema ? `${rel.targetSchema}.${rel.targetTable}` : rel.targetTable;
                      const joinSql = `JOIN ${targetName} ON ${sourceName}.${rel.sourceColumn} = ${targetName}.${rel.targetColumn}`;

                      return (
                        <div
                          key={idx}
                          className="rounded-lg border border-border bg-muted/30 p-3.5 space-y-2 hover:border-primary/40 transition-all"
                        >
                          <div className="flex items-center justify-between">
                            <span
                              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                isOutbound
                                  ? "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                                  : "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                              }`}
                            >
                              {isOutbound ? "Outbound FK (Many-to-One)" : "Inbound Ref (One-to-Many)"}
                            </span>

                            <button
                              onClick={() => {
                                setSelectedScope(otherTable);
                                const targetIdx = tables.findIndex(
                                  (t) => t.tableName.toLowerCase() === otherTable.toLowerCase()
                                );
                                if (targetIdx >= 0) onSelectTableIndex?.(targetIdx);
                              }}
                              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
                            >
                              View {otherTable} <ArrowRight className="h-3 w-3" />
                            </button>
                          </div>

                          <div className="flex items-center gap-2 text-xs font-mono text-foreground pt-1">
                            <span className="font-semibold text-primary">
                              {rel.sourceTable}.{rel.sourceColumn}
                            </span>
                            <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="font-semibold text-foreground">
                              {rel.targetTable}.{rel.targetColumn}
                            </span>
                          </div>

                          {/* Interactive SQL Join Preview */}
                          <div className="rounded bg-background border border-border p-2 flex items-center justify-between text-xs font-mono text-muted-foreground">
                            <span className="truncate">{joinSql}</span>
                            <button
                              onClick={() => handleCopyJoin(joinSql)}
                              className="ml-2 text-xs text-primary hover:text-primary/80 shrink-0 font-sans"
                            >
                              {copiedJoin === joinSql ? (
                                <span className="text-emerald-500 flex items-center gap-1">
                                  <Check className="h-3 w-3" /> Copied
                                </span>
                              ) : (
                                "Copy SQL"
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Table Metrics & Dimensions Discovered */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Dimensions */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-primary" />
                Table Dimensions & Categoricals
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {activeTable.schemaDefinition ? (
                  (activeTable.schemaDefinition as any[])
                    .filter((c: any) => c.role === "dimension" || c.dataType === "string" || c.dataType === "boolean")
                    .map((c: any) => (
                      <span
                        key={c.name}
                        className="rounded-md bg-muted border border-border px-2 py-1 text-xs font-mono text-foreground"
                      >
                        {c.name}
                        {c.distinctCount !== undefined && (
                          <span className="text-muted-foreground ml-1">({c.distinctCount})</span>
                        )}
                      </span>
                    ))
                ) : (
                  <span className="text-xs text-muted-foreground italic">No dimensions defined.</span>
                )}
              </div>
            </div>

            {/* Metrics */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Play className="h-3.5 w-3.5 text-primary fill-current" />
                Table Numeric Metrics & Measures
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {activeTable.schemaDefinition ? (
                  (activeTable.schemaDefinition as any[])
                    .filter((c: any) => c.role === "metric" || c.dataType === "number")
                    .map((c: any) => (
                      <span
                        key={c.name}
                        className="rounded-md bg-primary/10 border border-primary/20 px-2 py-1 text-xs font-mono font-medium text-primary"
                      >
                        {c.name}
                      </span>
                    ))
                ) : (
                  <span className="text-xs text-muted-foreground italic">No numeric metrics defined.</span>
                )}
              </div>
            </div>
          </div>

          {/* Table DecisionSpec Trace */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Table DecisionSpecs & Semantic Model
            </h4>
            <pre className="rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto text-foreground max-h-48">
              {JSON.stringify(
                {
                  tableName: activeTable.tableName,
                  profile: currentTableProfile,
                  semanticModel: currentModel,
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      )}

      {/* VIEW B: PER-DOCUMENT DEEP DIVE (RAG) */}
      {selectedScope !== "global" && isRag && activeDoc && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <h3 className="text-base font-bold text-foreground">
                  {activeDoc.fileName || "Document Section Profile"}
                </h3>
              </div>
              <button
                onClick={() => setSelectedScope("global")}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Corpus Overview
              </button>
            </div>

            {/* Document Context */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                <Sparkles className="h-4 w-4" />
                <span>Document Business Context & Relevance</span>
              </div>
              <p className="text-xs text-foreground leading-relaxed">
                {activeDoc.context ||
                  activeDoc.summary ||
                  "Indexed text passage for downstream agent retrieval."}
              </p>
            </div>

            {/* Document-Specific Topics */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Hash className="h-4 w-4 text-amber-500" />
                <span>Document-Specific Semantic Topics</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {activeDoc.topics && activeDoc.topics.length > 0 ? (
                  activeDoc.topics.map((top: any, idx: number) => {
                    const label = typeof top === "string" ? top : top?.topic || top?.name || JSON.stringify(top);
                    return (
                      <span
                        key={idx}
                        className="rounded-md bg-muted border border-border px-2.5 py-1 text-xs font-medium text-foreground"
                      >
                        {label}
                      </span>
                    );
                  })
                ) : (
                  <span className="text-xs text-muted-foreground italic">No section topics specified.</span>
                )}
              </div>
            </div>

            {/* Document Entities */}
            {activeDoc.entities && activeDoc.entities.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Layers className="h-4 w-4 text-primary" />
                  <span>Key Entities Identified in Document</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {activeDoc.entities.map((ent: any, idx: number) => {
                    const label = typeof ent === "string" ? ent : ent?.name || ent?.entity || JSON.stringify(ent);
                    return (
                      <span
                        key={idx}
                        className="rounded-md bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs font-semibold text-primary"
                      >
                        {label}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW C: GLOBAL OVERVIEW & MULTI-TABLE TOPOLOGY */}
      {selectedScope === "global" && (
        <div className="space-y-6">
          {/* Top Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Onboarding Agent */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Onboarding Specialist</span>
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <p className="text-base font-bold text-foreground truncate">
                {profile.onboardedBy || "Onboarding Orchestrator"}
              </p>
              <p className="text-xs text-muted-foreground">Autonomous ingestion agent</p>
            </div>

            {/* Domain Classification */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Domain Classification</span>
                <Sparkles className="h-4 w-4 text-amber-500" />
              </div>
              <p className="text-base font-bold text-foreground uppercase font-mono">
                {profile.domain || "General"}
              </p>
              <p className="text-xs text-muted-foreground">
                Confidence: {((profile.confidence ?? 0.88) * 100).toFixed(0)}%
              </p>
            </div>

            {/* Downstream Agent Affinity */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Target Agent Affinity</span>
                <Target className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="text-base font-bold text-foreground truncate">
                {profile.targetAgentAffinity || "data_agent"}
              </p>
              <p className="text-xs text-muted-foreground">Recommended consumer agent</p>
            </div>

            {/* DecisionSpecs Executed */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>JEV DecisionSpecs</span>
                <Workflow className="h-4 w-4 text-blue-500" />
              </div>
              <p className="text-base font-bold text-foreground">
                {profile.decisionSpecRefs?.length || 0} Specs
              </p>
              <p className="text-xs text-muted-foreground font-mono truncate">
                {profile.decisionSpecRefs?.join(", ")}
              </p>
            </div>
          </div>

          {/* Multi-Table Relational Clusters & Network Topology */}
          {hasTables && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Network className="h-5 w-5 text-primary" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      Multi-Table Relational Clusters & Network Topology
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Cross-table relational graphs and foreign key topologies discovered across {tables.length} tables.
                    </p>
                  </div>
                </div>
                <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  {profile.crossTableClusters?.length || 1} Cluster(s)
                </span>
              </div>

              {profile.crossTableClusters && profile.crossTableClusters.length > 0 ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {profile.crossTableClusters.map((cluster: any, cIdx: number) => (
                    <div
                      key={cIdx}
                      className="rounded-lg border border-border bg-muted/20 p-4 space-y-3 hover:border-primary/40 transition-all"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-0.5">
                          <h5 className="text-xs font-bold text-foreground flex items-center gap-1.5">
                            <Network className="h-3.5 w-3.5 text-primary" />
                            {cluster.name || cluster.clusterName || `Cluster #${cIdx + 1}`}
                          </h5>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {cluster.description}
                          </p>
                        </div>
                      </div>

                      {/* Tables in this cluster */}
                      <div className="space-y-1.5">
                        <span className="text-xs font-semibold text-muted-foreground">
                          Connected Tables ({cluster.tables?.length || 0}):
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {(cluster.tables || []).map((tName: string) => {
                            const tRole =
                              profile.tableProfiles?.[tName]?.tableRole ||
                              profile.tableRoles?.[tName];
                            const badge = getTableRoleBadge(tRole);
                            return (
                              <button
                                key={tName}
                                onClick={() => {
                                  setSelectedScope(tName);
                                  const tIdx = tables.findIndex(
                                    (t) => tableScopeKey(t).toLowerCase() === tName.toLowerCase()
                                      || (tables.filter((candidate) => candidate.tableName.toLowerCase() === tName.toLowerCase()).length === 1
                                        && t.tableName.toLowerCase() === tName.toLowerCase())
                                  );
                                  if (tIdx >= 0) onSelectTableIndex?.(tIdx);
                                }}
                                className={`rounded-md px-2 py-1 text-xs font-mono font-medium border flex items-center gap-1 hover:ring-1 hover:ring-primary/40 transition-all ${badge.className}`}
                                title={`Click to deep dive into table ${tName}`}
                              >
                                <span>{tName}</span>
                                <CornerDownRight className="h-3 w-3 opacity-60" />
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Cross-Table Topics */}
                      {cluster.topics && cluster.topics.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <span className="text-xs font-semibold text-muted-foreground">
                            Cross-Table Topics:
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {cluster.topics.map((top: any, tIdx: number) => {
                              const label = typeof top === "string" ? top : top?.topic || top?.name || JSON.stringify(top);
                              return (
                                <span
                                  key={tIdx}
                                  className="rounded bg-muted border border-border px-2 py-0.5 text-xs text-foreground font-medium"
                                >
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Relational Paths */}
                      {cluster.relationships && cluster.relationships.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-border">
                          <span className="text-xs font-semibold text-muted-foreground">
                            Join Conditions:
                          </span>
                          <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                            {cluster.relationships.slice(0, 5).map((r: any, rIdx: number) => (
                              <div
                                key={rIdx}
                                className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground bg-background p-1.5 rounded border border-border"
                              >
                                <span className="font-semibold text-primary">{r.sourceTable}.{r.sourceColumn}</span>
                                <ArrowRight className="h-3 w-3 shrink-0" />
                                <span className="text-foreground">{r.targetTable}.{r.targetColumn}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : profile.relationships && profile.relationships.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {profile.relationships.map((rel: any, idx: number) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-border bg-muted/20 p-3 space-y-1 text-xs font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-primary">{rel.sourceTable}.{rel.sourceColumn}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="font-semibold text-foreground">{rel.targetTable}.{rel.targetColumn}</span>
                      </div>
                      <p className="text-xs text-muted-foreground font-sans">
                        Discovered {rel.type || "many-to-one"} relationship between {rel.sourceTable} and {rel.targetTable}.
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  Single table or isolated schema. No cross-table relationships inferred.
                </div>
              )}
            </div>
          )}

          {/* Primary Entities & Global Key Topics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" /> Primary Entities Discovered ({profile.entities?.length || 0})
              </h4>
              <p className="text-xs text-muted-foreground">
                Core domain concepts indexed by JEV System One DecisionSpecs for autonomous query routing.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {profile.entities && profile.entities.length > 0 ? (
                  profile.entities.map((ent: any, idx: number) => {
                    const label = typeof ent === "string" ? ent : ent?.name || ent?.entity || JSON.stringify(ent);
                    return (
                      <span
                        key={idx}
                        className="rounded-lg bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs font-semibold text-primary"
                      >
                        {label}
                      </span>
                    );
                  })
                ) : (
                  <span className="text-xs text-muted-foreground italic">No primary entities isolated.</span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" /> Global Dataset Topics ({((profile.topics || profile.primaryTopics) || []).length})
              </h4>
              <p className="text-xs text-muted-foreground">
                Thematic clusters and domain topics indexed across the entire dataset.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {((profile.topics && profile.topics.length > 0) || (profile.primaryTopics && profile.primaryTopics.length > 0)) ? (
                  (profile.topics || profile.primaryTopics).map((top: any, idx: number) => {
                    const label = typeof top === "string" ? top : top?.topic || top?.name || JSON.stringify(top);
                    return (
                      <span
                        key={idx}
                        className="rounded-lg bg-muted border border-border px-2.5 py-1 text-xs font-medium text-foreground"
                      >
                        {label}
                      </span>
                    );
                  })
                ) : (
                  <span className="text-xs text-muted-foreground italic">Domain topics inferred automatically.</span>
                )}
              </div>
            </div>
          </div>

          {/* Numerical Metrics Discovered by JEV */}
          {profile.metrics && profile.metrics.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Play className="h-4 w-4 text-primary fill-current" /> Numerical Metrics Discovered by JEV ({profile.metrics.length})
              </h4>
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
                    <tr>
                      <th className="p-2.5">Metric Name</th>
                      <th className="p-2.5">Target Column / Expression</th>
                      <th className="p-2.5">Default Aggregation</th>
                      <th className="p-2.5">Format</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-foreground">
                    {profile.metrics.map((m: any, idx: number) => (
                      <tr key={idx} className="hover:bg-muted/50">
                        <td className="p-2.5 font-semibold text-primary">{m.name}</td>
                        <td className="p-2.5 font-mono text-muted-foreground">{m.expression || m.column}</td>
                        <td className="p-2.5 uppercase font-medium">{m.aggregation || "SUM"}</td>
                        <td className="p-2.5 text-muted-foreground">{m.format || "number"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Suggested Analytical Questions */}
          {profile.suggestedQueries && profile.suggestedQueries.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Compass className="h-4 w-4 text-primary" /> Suggested Analytical Questions (AI Formulated)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {profile.suggestedQueries.map((q: any, idx: number) => {
                  const title =
                    typeof q === "string"
                      ? q
                      : q?.title || q?.query || q?.description || `Analytical Query #${idx + 1}`;
                  const queryText =
                    typeof q === "object" && q !== null && q.query && q.query !== title
                      ? q.query
                      : null;
                  const category =
                    typeof q === "object" && q !== null ? q.category : null;
                  const description =
                    typeof q === "object" && q !== null && q.description && q.description !== title
                      ? q.description
                      : null;
                  const sqlSnippet =
                    typeof q === "object" && q !== null ? q.sqlSnippet : null;

                  return (
                    <div
                      key={idx}
                      className="p-3.5 rounded-lg border border-border bg-muted/20 text-xs text-foreground flex flex-col gap-2 hover:border-primary/40 transition-colors"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="rounded-full bg-primary/10 text-primary w-5 h-5 flex items-center justify-center shrink-0 text-xs font-bold mt-0.5">
                          {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-semibold text-foreground leading-snug">{title}</span>
                            {category && (
                              <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground uppercase border border-border shrink-0">
                                {category}
                              </span>
                            )}
                          </div>
                          {queryText && (
                            <p className="text-xs text-muted-foreground leading-relaxed">{queryText}</p>
                          )}
                          {description && (
                            <p className="text-xs text-muted-foreground/80 italic">{description}</p>
                          )}
                          {sqlSnippet && (
                            <div className="rounded bg-muted/60 p-2 font-mono text-xs text-foreground overflow-x-auto border border-border mt-1">
                              <code>{sqlSnippet}</code>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Raw DecisionSpec Metadata Audit */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              DecisionSpec Execution Trace
            </h4>
            <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto text-foreground max-h-60">
              {JSON.stringify(profile, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadinessAndEvidenceView({
  ds,
  companyId,
}: {
  ds: any;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [executionFeedbackNotes, setExecutionFeedbackNotes] = useState<Record<string, string>>({});
  const metadata = (ds?.metadata || {}) as Record<string, any>;
  const ingestionQuality = metadata.ingestionQuality as {
    totalRows?: number;
    validRows?: number;
    invalidRows?: number;
    duplicateRows?: number;
    typeViolations?: number;
  } | undefined;
  const metricGate = metadata.metricRegistryGate as {
    passed?: boolean;
    reasons?: string[];
    publishedAt?: string;
  } | undefined;

  const tables: any[] = ds?.tables || [];
  const indexedTableCount = tables.filter((t) => Array.isArray(t.indexDefinitions) && t.indexDefinitions.length > 0).length;
  const hasApproximateCounts = tables.some((t) => t.isApproximateCount === true);

  const { data: expData, isLoading: expLoading } = useQuery({
    queryKey: ["query-experiences", companyId, ds.id],
    queryFn: () => dataSourcesApi.getQueryExperiences(companyId, ds.id),
    enabled: !!companyId && !!ds?.id,
  });

  const { data: executionData, isLoading: executionsLoading, error: executionsError } = useQuery({
    queryKey: ["query-executions", companyId, ds.id],
    queryFn: () => dataSourcesApi.getQueryExecutions(companyId, ds.id),
    enabled: !!companyId && !!ds?.id,
    refetchInterval: 15_000,
  });

  const promoteMutation = useMutation({
    mutationFn: ({ experienceId, status }: { experienceId: string; status: "reference_verified" | "user_approved" }) =>
      dataSourcesApi.promoteQueryExperience(companyId, ds.id, experienceId, {
        status,
        verificationEvidence: "Verified by Paperclip operator review",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["query-experiences", companyId, ds.id] });
    },
  });

  const feedbackMutation = useMutation({
    mutationFn: ({ executionId, verdict, comment }: {
      executionId: string;
      verdict: "correct" | "needs_correction";
      comment?: string;
    }) => dataSourcesApi.submitQueryFeedback(companyId, ds.id, executionId, {
      verdict,
      ...(comment ? { comment, correctionNote: comment } : {}),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["query-executions", companyId, ds.id] });
      queryClient.invalidateQueries({ queryKey: ["query-experiences", companyId, ds.id] });
    },
  });

  const experiences = expData?.experiences || [];
  const executions = executionData?.executions || [];

  return (
    <div className="space-y-6">
      {/* Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Catalog & Schema Readiness */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Catalog Readiness</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                ds.status === "ready" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-500"
              )}
            >
              {ds.status}
            </span>
          </div>
          <div className="text-2xl font-bold text-foreground">
            {tables.length} <span className="text-xs font-normal text-muted-foreground">tables</span>
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{indexedTableCount} tables with verified indexes</p>
            {hasApproximateCounts && (
              <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                <AlertCircle className="h-3 w-3" /> Approximate stats active
              </span>
            )}
          </div>
        </div>

        {/* Card 2: Full-Data Quality Counters */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Quality Counters</span>
            <span className="text-xs font-mono text-muted-foreground">P3 Full-Scan</span>
          </div>
          <div className="text-2xl font-bold text-foreground">
            {ingestionQuality?.totalRows != null ? ingestionQuality.totalRows.toLocaleString() : "—"}{" "}
            <span className="text-xs font-normal text-muted-foreground">total rows</span>
          </div>
          <div className="text-xs text-muted-foreground grid grid-cols-2 gap-1 pt-1 border-t border-border">
            <span>Valid: <strong className="text-foreground">{ingestionQuality?.validRows ?? "—"}</strong></span>
            <span>Invalid: <strong className="text-foreground">{ingestionQuality?.invalidRows ?? 0}</strong></span>
            <span>Dups: <strong className="text-foreground">{ingestionQuality?.duplicateRows ?? 0}</strong></span>
            <span>Violations: <strong className="text-foreground">{ingestionQuality?.typeViolations ?? 0}</strong></span>
          </div>
        </div>

        {/* Card 3: Semantic Gate & Publication */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Metric Registry Gate</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold",
                metricGate?.passed ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
              )}
            >
              {metricGate?.passed ? "Passed" : "Standard"}
            </span>
          </div>
          <div className="text-2xl font-bold text-foreground">
            {metricGate?.passed ? "Verified" : "Catalogued"}
          </div>
          <p className="text-xs text-muted-foreground">
            {metricGate?.publishedAt
              ? `Published: ${new Date(metricGate.publishedAt).toLocaleDateString()}`
              : "Direct schema mapping active"}
          </p>
        </div>

        {/* Card 4: Vector & Routing Readiness */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Execution Routing</span>
            <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium uppercase">
              Hybrid
            </span>
          </div>
          <div className="text-sm font-semibold text-foreground">
            {metadata.embeddingSpace || "bge-m3"} (1024d)
          </div>
          <p className="text-xs text-muted-foreground">
            Point lookups: live driver. Aggregations: ClickHouse snapshot engine.
          </p>
        </div>
      </div>

      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="p-4 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Query execution history & trace</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Recent executions using this datasource. Results are omitted from this list; feedback is recorded against the execution trace.
          </p>
        </div>
        {executionsError ? (
          <p className="p-4 text-xs text-destructive" role="alert">
            {(executionsError as Error).message || "Could not load query execution history."}
          </p>
        ) : executionsLoading ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
            Loading execution history...
          </div>
        ) : executions.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">No query executions recorded for this datasource yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {executions.map((execution) => (
              <article key={execution.id} className="p-4 space-y-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground break-words">{execution.query}</p>
                    {execution.resultsSummary && (
                      <p className="text-xs text-muted-foreground break-words">{execution.resultsSummary}</p>
                    )}
                    {execution.errorMessage && (
                      <p className="text-xs text-destructive break-words">{execution.errorMessage}</p>
                    )}
                    <p className="text-xs text-muted-foreground font-mono break-all">
                      Trace: {execution.traceId || execution.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
                    <span className={cn(
                      "rounded-full px-2 py-0.5 font-medium uppercase",
                      execution.status === "completed" ? "bg-emerald-500/10 text-emerald-600"
                        : execution.status === "failed" || execution.status === "cancelled" ? "bg-destructive/10 text-destructive"
                          : "bg-amber-500/10 text-amber-500",
                    )}>{execution.status}</span>
                    <span className="text-muted-foreground">{execution.engine || "unknown engine"}</span>
                    <span className="text-muted-foreground">
                      {execution.stageTimings?.totalMs != null ? `${Math.round(execution.stageTimings.totalMs)} ms` : "duration unavailable"}
                    </span>
                    <span className="text-muted-foreground">{new Date(execution.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <label className="sr-only" htmlFor={`execution-feedback-${execution.id}`}>Correction note</label>
                  <textarea
                    id={`execution-feedback-${execution.id}`}
                    value={executionFeedbackNotes[execution.id] || ""}
                    onChange={(event) => setExecutionFeedbackNotes((current) => ({ ...current, [execution.id]: event.target.value }))}
                    placeholder="Catatan koreksi (opsional untuk jawaban benar)"
                    rows={2}
                    className="min-h-9 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => feedbackMutation.mutate({ executionId: execution.id, verdict: "correct" })}
                      disabled={feedbackMutation.isPending}
                      className="rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-background disabled:opacity-50"
                    >
                      Benar
                    </button>
                    <button
                      type="button"
                      onClick={() => feedbackMutation.mutate({
                        executionId: execution.id,
                        verdict: "needs_correction",
                        comment: executionFeedbackNotes[execution.id]?.trim(),
                      })}
                      disabled={feedbackMutation.isPending || !executionFeedbackNotes[execution.id]?.trim()}
                      className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Kirim koreksi
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {feedbackMutation.isError && (
          <p className="border-t border-border p-3 text-xs text-destructive" role="alert">
            {(feedbackMutation.error as Error).message || "Could not submit feedback."}
          </p>
        )}
        {feedbackMutation.isSuccess && (
          <p className="border-t border-border p-3 text-xs text-emerald-600" role="status">Feedback tersimpan untuk execution tersebut.</p>
        )}
      </section>

      {/* Query Learning & Experience Evidence */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Query Experience Memory & Provenance (P6)
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Candidate executions are recorded upon success. Unreviewed candidates are never reused until verified.
            </p>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            {experiences.length} recorded experiences
          </span>
        </div>

        {expLoading ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
            Loading query experiences...
          </div>
        ) : experiences.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            No query experiences recorded yet for this data source. Query executions will record candidate templates here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
                <tr>
                  <th className="p-3">Normalized Question</th>
                  <th className="p-3">Route / Engine</th>
                  <th className="p-3">Fingerprint</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Recorded</th>
                  <th className="p-3 text-right">Review Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {experiences.map((exp: any) => (
                  <tr key={exp.id} className="hover:bg-muted/50 transition-colors">
                    <td className="p-3 font-medium text-foreground max-w-xs truncate" title={exp.normalizedQuery}>
                      {exp.normalizedQuery}
                    </td>
                    <td className="p-3 text-muted-foreground font-mono">
                      {exp.executionRoute || "orchestrated"}
                    </td>
                    <td className="p-3 text-muted-foreground font-mono text-xs">
                      {exp.schemaFingerprint ? exp.schemaFingerprint.slice(0, 10) : "—"}
                    </td>
                    <td className="p-3">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium uppercase",
                          exp.status === "reference_verified"
                            ? "bg-emerald-500/10 text-emerald-600"
                            : exp.status === "user_approved"
                            ? "bg-sky-500/10 text-sky-600"
                            : exp.status === "rejected"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-amber-500/10 text-amber-500"
                        )}
                      >
                        {exp.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap">
                      {new Date(exp.createdAt).toLocaleDateString()}
                    </td>
                    <td className="p-3 text-right">
                      {exp.status === "candidate" ? (
                        <button
                          type="button"
                          onClick={() =>
                            promoteMutation.mutate({
                              experienceId: exp.id,
                              status: "user_approved",
                            })
                          }
                          disabled={promoteMutation.isPending}
                          className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground hover:bg-background transition-colors disabled:opacity-50"
                        >
                          <Check className="h-3 w-3 text-emerald-600" />
                          Approve
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Reviewed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
