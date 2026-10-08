import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Folder,
  ArrowLeft,
  Sparkles,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  Server,
  GitBranch,
  Key,
  Terminal,
  Bot,
  Globe,
  Radio,
  Video,
  Target,
  Network,
  Table2,
  Link2,
  Hash,
  Compass,
  ArrowRight,
  FileCode,
  Check,
  RefreshCw,
  Plus,
  Trash2,
  UploadCloud,
  Copy,
  Database,
  FileSpreadsheet,
  FileText,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useUserRbac } from "@/hooks/useUserRbac";
import { copyTextToClipboard } from "@/lib/clipboard";
import { dataSourcesApi } from "@/api/data-sources";
import { TemporalOverlapReviewPanel } from "@/components/data-sources/TemporalOverlapReviewPanel";
import type {
  DataSourceCollection,
  DataSource,
  CollectionSemanticProfile,
  TableRelation,
  CrossDocumentCorrelation,
  CrossModalCorrelation,
  UnifiedClickhouseView,
  SuggestedQueryTemplate,
  SqlQueryResult,
} from "@paperclipai/shared";

export function DataSourceCollectionDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const { canAddDataSource } = useUserRbac();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<"sources" | "relationships" | "semantics" | "views" | "temporal-overlaps">("sources");
  const [copiedViewIndex, setCopiedViewIndex] = useState<number | null>(null);

  // Upload modal & stepped ingestion state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [ingestionStage, setIngestionStage] = useState<"idle" | "uploading" | "completed">("idle");
  const [uploadedResultCount, setUploadedResultCount] = useState<number>(0);

  // SQL Runner state for ClickHouse / cross-table queries
  const [activeSql, setActiveSql] = useState("");
  const [sqlResult, setSqlResult] = useState<SqlQueryResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [isRunningSql, setIsRunningSql] = useState(false);

  // 1. Fetch Collection details with active auto-polling for processing items
  const {
    data: collection,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["data-source-collection", selectedCompanyId, id],
    queryFn: () => dataSourcesApi.getCollection(selectedCompanyId!, id!),
    enabled: !!selectedCompanyId && !!id,
    refetchInterval: (query) => {
      const dataSourcesList = query.state.data?.dataSources || [];
      const hasProcessing = dataSourcesList.some(
        (ds: any) => ds.status === "processing" || ds.status === "onboarding",
      );
      return hasProcessing ? 2500 : false;
    },
  });

  // 2. Correlate mutation
  const correlateMutation = useMutation({
    mutationFn: () => dataSourcesApi.correlateCollection(selectedCompanyId!, id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source-collection", selectedCompanyId, id] });
    },
  });

  // 3. Upload mutation
  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => {
      setIngestionStage("uploading");
      return dataSourcesApi.uploadToCollection(
        selectedCompanyId!,
        id!,
        files,
        uploadDescription || undefined,
      );
    },
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["data-source-collection", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
      setUploadedResultCount(res?.count || res?.dataSources?.length || uploadFiles.length);
      setIngestionStage("completed");
      setUploadError(null);
    },
    onError: (err: any) => {
      setUploadError(err?.message || "Failed to upload files to collection.");
      setIngestionStage("idle");
    },
  });

  const handleCloseUploadModal = () => {
    setIsUploadOpen(false);
    setUploadFiles([]);
    setUploadDescription("");
    setUploadError(null);
    setIngestionStage("idle");
    setUploadedResultCount(0);
    queryClient.invalidateQueries({ queryKey: ["data-source-collection", selectedCompanyId, id] });
    queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
  };

  // 4. Remove source mutation
  const removeSourceMutation = useMutation({
    mutationFn: (dataSourceId: string) =>
      dataSourcesApi.removeSourceFromCollection(selectedCompanyId!, id!, dataSourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-source-collection", selectedCompanyId, id] });
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  // 5. Run SQL Query
  const runSqlQuery = async (sql: string) => {
    if (!sql.trim()) return;
    setIsRunningSql(true);
    setSqlError(null);
    try {
      const res = await dataSourcesApi.queryClickhouse(selectedCompanyId!, sql, 50);
      setSqlResult(res);
    } catch (err: any) {
      setSqlError(err?.message || "Query execution failed.");
      setSqlResult(null);
    } finally {
      setIsRunningSql(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    void copyTextToClipboard(text);
    setCopiedViewIndex(index);
    setTimeout(() => setCopiedViewIndex(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !collection) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
        <h2 className="mt-4 text-lg font-semibold text-foreground">Collection Not Found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The requested data source collection does not exist or you do not have permission to view it.
        </p>
        <Link
          to="/data-sources"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Data Sources
        </Link>
      </div>
    );
  }

  const profile: CollectionSemanticProfile | null = collection.semanticProfile || null;
  const dataSourcesList: DataSource[] = collection.dataSources || [];
  const crossTableRelationships: TableRelation[] = profile?.crossTableRelationships || [];
  const crossDocCorrelations: CrossDocumentCorrelation[] = profile?.crossDocumentCorrelations || [];
  const crossModalCorrelations: CrossModalCorrelation[] = profile?.crossModalCorrelations || [];
  const unifiedViews: UnifiedClickhouseView[] = profile?.unifiedClickhouseViews || [];
  const temporalOverlapAnalysis = profile?.temporalOverlapAnalysis;
  const temporalOverlapCount = temporalOverlapAnalysis?.findings.length ?? 0;
  const deployedUnifiedViewCount = unifiedViews.filter((view) => view.deploymentStatus === "deployed").length;
  const suggestedQueries: SuggestedQueryTemplate[] = profile?.suggestedQueries || [];
  const processingSources: DataSource[] = dataSourcesList.filter(
    (ds) => ds.status === "processing" || ds.status === "onboarding",
  );

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Top Breadcrumb & Nav */}
      <div className="flex items-center justify-between">
        <Link
          to="/data-sources"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Data Sources
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={() => correlateMutation.mutate()}
            disabled={correlateMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${correlateMutation.isPending ? "animate-spin" : ""}`} />
            {correlateMutation.isPending ? "Re-Analyzing..." : "Re-Analyze & Correlate"}
          </button>
          {canAddDataSource && (
            <button
              onClick={() => setIsUploadOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              Upload to Collection
            </button>
          )}
        </div>
      </div>

      {/* Top Banner: Autonomous Ingestion & Cross-Correlation Active */}
      {processingSources.length > 0 && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-sm flex items-start gap-3.5">
          <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-semibold text-foreground">
                Autonomous Ingestion & Cross-Correlation Sedang Berjalan
              </h4>
              <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                {processingSources.length} data source aktif diproses
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Paperclip Autonomous Data Orchestrator sedang memproses berkas, memprofilkan semantik TypeSafe JEV, mendeteksi foreign key relasional, dan menyusun ClickHouse OLAP join views untuk koleksi ini. Halaman ini memperbarui status secara otomatis.
            </p>
          </div>
        </div>
      )}

      {/* Collection Header Banner */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary border border-primary/20 shrink-0">
              <Folder className="h-7 w-7" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">
                  {collection.name}
                </h1>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground border border-border">
                  slug: {collection.slug}
                </span>
                <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary border border-primary/20">
                  Universal Collection
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {collection.description || "Project folder and universal correlation boundary for enterprise data sources."}
              </p>

              {/* Semantic Domain & Primary Topics */}
              {profile && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-foreground border border-border">
                    <Compass className="h-3 w-3 text-primary" />
                    Domain: {profile.domain}
                  </span>
                  {profile.primaryTopics.map((topic, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-md bg-secondary/80 px-2 py-0.5 text-xs font-medium text-secondary-foreground border border-border"
                    >
                      {topic}
                    </span>
                  ))}
                  {profile.lastCorrelatedAt && (
                    <span className="text-xs text-muted-foreground ml-1">
                      Correlated {new Date(profile.lastCorrelatedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Metric Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
            <span>Data Sources</span>
            <Folder className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">
            {collection.dataSourceCount ?? dataSourcesList.length}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {collection.documentCount ?? 0} docs, {(collection.dataSourceCount ?? 0) - (collection.documentCount ?? 0)} structured
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
            <span>Structured Tables</span>
            <Table2 className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">
            {collection.tableCount ?? 0}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {(collection.totalRows ?? 0).toLocaleString()} total records
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
            <span>Foreign Key Links</span>
            <GitBranch className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">
            {crossTableRelationships.length}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {deployedUnifiedViewCount} deployed ClickHouse views
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground flex items-center justify-between">
            <span>Knowledge Chunks</span>
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">
            {(collection.totalChunks ?? 0).toLocaleString()}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {crossDocCorrelations.length + crossModalCorrelations.length} cross-correlations
          </p>
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="flex border-b border-border gap-1 overflow-x-auto">
        <button
          onClick={() => setActiveTab("sources")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "sources"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Folder className="h-4 w-4" />
          Member Sources ({dataSourcesList.length})
        </button>
        <button
          onClick={() => setActiveTab("relationships")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "relationships"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <GitBranch className="h-4 w-4" />
          Cross-Table Relationships ({crossTableRelationships.length})
        </button>
        <button
          onClick={() => setActiveTab("semantics")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "semantics"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Compass className="h-4 w-4" />
          Topics & Cross-Modal ({crossModalCorrelations.length + crossDocCorrelations.length})
        </button>
        <button
          onClick={() => setActiveTab("views")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "views"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileCode className="h-4 w-4" />
          Unified SQL & ClickHouse ({deployedUnifiedViewCount})
        </button>
        <button
          onClick={() => setActiveTab("temporal-overlaps")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === "temporal-overlaps"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <AlertCircle className="h-4 w-4" />
          Temporal Overlap ({temporalOverlapCount})
        </button>
      </div>

      {activeTab === "temporal-overlaps" && (
        <TemporalOverlapReviewPanel analysis={temporalOverlapAnalysis} dataSources={dataSourcesList} />
      )}

      {/* Tab 1: Member Sources */}
      {activeTab === "sources" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Data Sources in {collection.name}
            </h2>
            <button
              onClick={() => setIsUploadOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors shadow-sm"
            >
              <UploadCloud className="h-3.5 w-3.5 text-primary" />
              Upload Files or ZIP
            </button>
          </div>

          {dataSourcesList.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
              <Folder className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-base font-semibold text-foreground">No data sources yet</h3>
              <p className="mt-2 text-sm text-muted-foreground max-w-sm mx-auto">
                Upload CSV, TSV, Excel, PDF, or a .ZIP archive. The system will unpack, analyze semantic topics, and map cross-table foreign keys automatically.
              </p>
              <button
                onClick={() => setIsUploadOpen(true)}
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
              >
                <Plus className="h-4 w-4" />
                Upload Data Sources
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {dataSourcesList.map((ds) => (
                <div
                  key={ds.id}
                  className="rounded-xl border border-border bg-card p-4 shadow-sm hover:border-primary/40 transition-all flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0">
                          {ds.sourceType === "csv" && <FileSpreadsheet className="h-5 w-5" />}
                          {ds.sourceType === "excel" && <FileSpreadsheet className="h-5 w-5" />}
                          {ds.sourceType === "rag_document" && <FileText className="h-5 w-5" />}
                          {ds.sourceType === "postgres" && <Database className="h-5 w-5" />}
                          {ds.sourceType === "mariadb" && <Database className="h-5 w-5" />}
                          {ds.sourceType === "mysql" && <Database className="h-5 w-5" />}
                          {ds.sourceType === "api_rest" && <Globe className="h-5 w-5" />}
                          {ds.sourceType === "mqtt_iot" && <Radio className="h-5 w-5" />}
                          {ds.sourceType === "cctv_feed" && <Video className="h-5 w-5" />}
                        </div>
                        <div>
                          <Link
                            to={`/data-sources/${ds.id}`}
                            className="font-semibold text-foreground hover:text-primary transition-colors text-sm line-clamp-1"
                          >
                            {ds.name}
                          </Link>
                          <span className="text-xs font-mono uppercase text-muted-foreground">
                            {ds.sourceType}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium capitalize ${
                          ds.status === "ready"
                            ? "bg-emerald-500/10 text-emerald-500"
                            : ds.status === "processing"
                            ? "bg-amber-500/10 text-amber-500 animate-pulse"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {ds.status}
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {ds.description || ds.fileName || "No description provided."}
                    </p>

                    {/* Stats */}
                    <div className="flex items-center gap-3 pt-2 text-xs text-muted-foreground border-t border-border">
                      {ds.tables && ds.tables.length > 0 && (
                        <span>{ds.tables.length} table(s)</span>
                      )}
                      {ds.chunks && ds.chunks.length > 0 && (
                        <span>{ds.chunks.length} chunks</span>
                      )}
                      {ds.fileSize ? (
                        <span>{Math.round(ds.fileSize / 1024)} KB</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between pt-2 border-t border-border">
                    <Link
                      to={`/data-sources/${ds.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      View Details
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                    <button
                      onClick={() => removeSourceMutation.mutate(ds.id)}
                      disabled={removeSourceMutation.isPending}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors p-1"
                      title="Remove from collection"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Cross-Table Foreign Key Map & Cardinality */}
      {activeTab === "relationships" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-emerald-500" />
              Automated Cross-Table Relationship Discovery
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Specialist agents inspect schema definitions, primary keys, and sample data values across tables within this collection to map join paths and cardinality.
            </p>
          </div>

          {crossTableRelationships.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
              <GitBranch className="mx-auto h-10 w-10 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-semibold text-foreground">
                No Cross-Table Relationships Discovered Yet
              </h3>
              <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
                Upload at least two structured files (e.g. customers.csv and subscriptions.csv) to discover foreign keys and join candidates.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {crossTableRelationships.map((rel, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-500 border border-emerald-500/20">
                      Foreign Key Join
                    </span>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-mono uppercase text-foreground border border-border">
                      {rel.relationType}
                    </span>
                  </div>

                  {/* Schema connection visual */}
                  <div className="flex items-center justify-between gap-3 bg-muted/30 p-3 rounded-lg border border-border">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-foreground">
                        {rel.sourceTable}
                      </div>
                      <div className="text-xs font-mono text-primary flex items-center gap-1">
                        <Key className="h-3 w-3" />
                        {rel.sourceColumn}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 text-muted-foreground px-2">
                      <ArrowRight className="h-4 w-4 text-emerald-500" />
                    </div>

                    <div className="space-y-0.5 text-right">
                      <div className="text-xs font-semibold text-foreground">
                        {rel.targetTable}
                      </div>
                      <div className="text-xs font-mono text-primary flex items-center justify-end gap-1">
                        {rel.targetColumn}
                        <Key className="h-3 w-3" />
                      </div>
                    </div>
                  </div>

                  {/* Join SQL Snippet */}
                  <div className="text-xs font-mono bg-muted p-2 rounded text-foreground overflow-x-auto">
                    ON {rel.sourceTable}.{rel.sourceColumn} = {rel.targetTable}.{rel.targetColumn}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Topics & Cross-Modal Linking */}
      {activeTab === "semantics" && (
        <div className="space-y-6">
          {/* Domain & Topics */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Compass className="h-5 w-5 text-primary" />
              Collection Semantic Context & Domain
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Inferred Domain</span>
                <p className="text-base font-semibold text-foreground">
                  {profile?.domain || "General Enterprise"}
                </p>
              </div>
              <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
                <span className="text-xs font-medium text-muted-foreground">Primary Topics</span>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {profile?.primaryTopics && profile.primaryTopics.length > 0 ? (
                    profile.primaryTopics.map((t, i) => (
                      <span
                        key={i}
                        className="rounded-md bg-secondary/80 px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                      >
                        {t}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">No topics synthesized yet.</span>
                  )}
                </div>
              </div>
            </div>

            {/* Recognized Entities */}
            {profile?.entities && profile.entities.length > 0 && (
              <div className="pt-2">
                <span className="text-xs font-medium text-muted-foreground block mb-2">
                  Recognized Cross-Source Entities
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {profile.entities.map((entity, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary border border-primary/20"
                    >
                      {entity}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Cross-Modal Linking (Docs <-> Structured Tables) */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Network className="h-5 w-5 text-primary" />
              Cross-Modal Document-to-Table Correlations
            </h2>
            <p className="text-xs text-muted-foreground">
              RAG document chunks mapped to structured table entities (e.g. SLA contracts referencing specific customers or network assets).
            </p>

            {crossModalCorrelations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No cross-modal links found between documents and tables in this collection.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {crossModalCorrelations.map((cm, i) => (
                  <div key={i} className="p-4 rounded-lg bg-muted/30 border border-border space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-foreground flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 text-primary" />
                        {cm.documentTitle}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-semibold text-foreground flex items-center gap-1.5">
                        <Table2 className="h-3.5 w-3.5 text-emerald-500" />
                        {cm.tableName}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{cm.correlationDescription}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {cm.sharedEntities.map((ent, ei) => (
                        <span key={ei} className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                          {ent}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Cross-Document Correlations */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              Cross-Document RAG Knowledge Correlations
            </h2>

            {crossDocCorrelations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No multiple RAG documents in this collection to correlate.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {crossDocCorrelations.map((cd, i) => (
                  <div key={i} className="p-4 rounded-lg bg-muted/30 border border-border space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-foreground">{cd.sourceDocTitle}</span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary">
                        {Math.round(cd.semanticSimilarity * 100)}% match
                      </span>
                      <span className="font-semibold text-foreground">{cd.targetDocTitle}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{cd.correlationSummary}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 4: Unified SQL & ClickHouse Views */}
      {activeTab === "views" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-2">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <FileCode className="h-5 w-5 text-primary" />
              Unified Multi-Table ClickHouse Views
            </h2>
            <p className="text-xs text-muted-foreground">
              These auto-synthesized views stitch together related tables in this collection using discovered foreign key relationships.
            </p>
          </div>

          {unifiedViews.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-xs text-muted-foreground">
              No unified views available. Upload structured tables with relationships to generate views.
            </div>
          ) : (
            <div className="space-y-4">
              {unifiedViews.map((view, i) => (
                <div key={i} className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-foreground font-mono">
                        {view.viewName}
                      </h3>
                      <p className="text-xs text-muted-foreground">{view.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {view.deploymentStatus === "deployed"
                          ? "Deployed in this company’s ClickHouse database."
                          : view.deploymentMessage || "Not deployed; source tables may not be synchronized to ClickHouse."}
                      </p>
                    </div>
                    {view.deploymentStatus === "deployed" && (
                      <button
                        onClick={() => copyToClipboard(view.joinSql, i)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/80 transition-colors"
                      >
                        {copiedViewIndex === i ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            Copy DDL
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {view.deploymentStatus === "deployed" && (
                    <pre className="p-3 rounded-lg bg-muted text-foreground font-mono text-xs overflow-x-auto whitespace-pre-wrap">
                      {view.joinSql}
                    </pre>
                  )}

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-muted-foreground">
                      Sources: {view.sourceTables.join(", ")}
                    </span>
                    {view.deploymentStatus === "deployed" && (
                      <button
                        onClick={() => {
                          const selectSql = `SELECT * FROM ${view.viewName} LIMIT 10;`;
                          setActiveSql(selectSql);
                          runSqlQuery(selectSql);
                        }}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                      >
                        <Play className="h-3 w-3" />
                        Preview View Data
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Suggested Multi-Table Queries */}
          {suggestedQueries.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                Suggested Cross-Table Analytical Queries
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {suggestedQueries.map((sq, i) => (
                  <div key={i} className="p-4 rounded-lg bg-muted/30 border border-border space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground text-xs">{sq.title}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono uppercase text-muted-foreground">
                        {sq.category}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{sq.query}</p>
                    {sq.sqlSnippet && (
                      <pre className="p-2 rounded bg-muted font-mono text-xs text-foreground overflow-x-auto whitespace-pre-wrap">
                        {sq.sqlSnippet}
                      </pre>
                    )}
                    {sq.sqlSnippet && (
                      <button
                        onClick={() => {
                          setActiveSql(sq.sqlSnippet!);
                          runSqlQuery(sq.sqlSnippet!);
                        }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline pt-1"
                      >
                        <Play className="h-3 w-3" />
                        Execute Query
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Interactive SQL Result Preview */}
          {(isRunningSql || sqlResult || sqlError) && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                Query Execution Result
              </h3>

              {isRunningSql && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  Executing query on ClickHouse...
                </div>
              )}

              {sqlError && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                  {sqlError}
                </div>
              )}

              {sqlResult && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{sqlResult.rowCount} rows returned in {sqlResult.executionTimeMs}ms</span>
                  </div>

                  <div className="overflow-x-auto border border-border rounded-lg">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted text-muted-foreground uppercase text-xs">
                        <tr>
                          {sqlResult.columns.map((col, idx) => (
                            <th key={idx} className="px-3 py-2 font-mono">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {sqlResult.rows.map((row, rIdx) => (
                          <tr key={rIdx} className="hover:bg-muted/40">
                            {sqlResult.columns.map((col, cIdx) => (
                              <td key={cIdx} className="px-3 py-2 font-mono text-foreground truncate max-w-xs">
                                {String(row[col] ?? "")}
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
        </div>
      )}

      {/* Upload Modal (Files or ZIP) */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg space-y-4">
            {uploadMutation.isPending || ingestionStage === "completed" ? (
              <div className="space-y-5">
                <div className="flex items-center justify-between border-b border-border/60 pb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary">
                      {ingestionStage === "completed" ? (
                        <CheckCircle2 className="h-5 w-5" />
                      ) : (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      )}
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-foreground">
                        {ingestionStage === "completed"
                          ? "Ingestion Koleksi Berhasil Diinisialisasi"
                          : "Memproses Berkas & Menjalankan Ingestion..."}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {collection.name} &middot; {uploadedResultCount || uploadFiles.length} berkas sumber
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleCloseUploadModal}
                    className="text-muted-foreground hover:text-foreground text-sm"
                  >
                    ✕
                  </button>
                </div>

                {/* Stepper Progress View */}
                <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                  {/* Step 1: Upload & Extraction */}
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    </div>
                    <div className="space-y-0.5 flex-1">
                      <div className="text-xs font-semibold text-foreground flex items-center justify-between">
                        <span>1. Transfer Berkas & Ekstraksi Arsip</span>
                        <span className="text-xs text-emerald-500 font-mono">Selesai</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Mengunggah {uploadFiles.length} berkas/arsip ZIP dan memvalidasi struktur berkas.
                      </p>
                    </div>
                  </div>

                  {/* Step 2: Semantic Profiling */}
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {ingestionStage === "completed" ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border border-primary/40 flex items-center justify-center text-xs text-primary font-mono">
                          2
                        </div>
                      )}
                    </div>
                    <div className="space-y-0.5 flex-1">
                      <div className="text-xs font-semibold text-foreground flex items-center justify-between">
                        <span>2. TypeSafe JEV & Autonomous Semantic Profiling</span>
                        <span className="text-xs text-primary font-mono">
                          {ingestionStage === "completed" ? "Aktif Berjalan" : "Antrean"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Menginferensi tipe data kuat, normalisasi kolom, ringkasan domain, dan ekstraksi entitas.
                      </p>
                    </div>
                  </div>

                  {/* Step 3: FK & Topic Discovery */}
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {ingestionStage === "completed" ? (
                        <Sparkles className="h-4 w-4 text-primary animate-pulse" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border border-muted-foreground/30 flex items-center justify-center text-xs text-muted-foreground font-mono">
                          3
                        </div>
                      )}
                    </div>
                    <div className="space-y-0.5 flex-1">
                      <div className="text-xs font-semibold text-foreground flex items-center justify-between">
                        <span>3. Universal Cross-Source FK & Relasi Otomatis</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {ingestionStage === "completed" ? "Dalam Antrean Koleksi" : "Menunggu"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Mendeteksi relasi foreign key antar tabel dan korelasi semantik dokumen RAG dalam koleksi ini.
                      </p>
                    </div>
                  </div>

                  {/* Step 4: ClickHouse Views & Vectors */}
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                      <div className="h-4 w-4 rounded-full border border-muted-foreground/30 flex items-center justify-center text-xs text-muted-foreground font-mono">
                        4
                      </div>
                    </div>
                    <div className="space-y-0.5 flex-1">
                      <div className="text-xs font-semibold text-foreground flex items-center justify-between">
                        <span>4. ClickHouse OLAP Views & Vector Embeddings</span>
                        <span className="text-xs text-muted-foreground font-mono">Terjadwal</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Menghasilkan ClickHouse unified views untuk analitik SQL cepat dan chunking vektor dokumen.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Autonomous notice */}
                <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-muted-foreground">
                  Semua proses berjalan secara otonom di latar belakang melalui Paperclip Onboarding Orchestrator. Status data source dan korelasi akan otomatis diperbarui pada tabel koleksi.
                </div>

                {/* Footer Buttons */}
                <div className="flex items-center justify-end pt-2 border-t border-border">
                  <button
                    type="button"
                    onClick={handleCloseUploadModal}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Tutup & Pantau di Halaman Koleksi
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-foreground">
                    Upload to {collection.name}
                  </h2>
                  <button
                    onClick={handleCloseUploadModal}
                    className="text-muted-foreground hover:text-foreground text-sm"
                  >
                    ✕
                  </button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Add CSV, TSV, Excel, PDF, DOCX, TXT, MD, or a complete <span className="font-semibold text-foreground">.ZIP</span> archive.
                  Files will be analyzed and linked into this collection automatically.
                </p>

                {uploadError && (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                    {uploadError}
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1">
                      Select Files or ZIP Archive
                    </label>
                    <input
                      type="file"
                      multiple
                      accept=".csv,.tsv,.xlsx,.xls,.pdf,.txt,.docx,.md,.json,.zip"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        setUploadFiles(files);
                      }}
                      className="w-full text-xs text-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
                    />
                  </div>

                  {uploadFiles.length > 0 && (
                    <div className="max-h-32 overflow-y-auto rounded border border-border p-2 space-y-1">
                      {uploadFiles.map((f, i) => (
                        <div key={i} className="text-xs font-mono text-muted-foreground flex justify-between">
                          <span className="truncate">{f.name}</span>
                          <span>{Math.round(f.size / 1024)} KB</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-foreground mb-1">
                      Optional Description
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Timur Telecom operational raw logs"
                      value={uploadDescription}
                      onChange={(e) => setUploadDescription(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

                {/* Form Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-border">
                  <button
                    type="button"
                    onClick={handleCloseUploadModal}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={uploadFiles.length === 0 || uploadMutation.isPending}
                    onClick={() => uploadMutation.mutate(uploadFiles)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    <UploadCloud className="h-3.5 w-3.5" />
                    Upload & Ingest
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
