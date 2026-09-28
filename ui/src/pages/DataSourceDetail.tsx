import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
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
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { dataSourcesApi } from "@/api/data-sources";
import type { SqlQueryResult, StructuredQueryResult } from "@paperclipai/shared";

export function DataSourceDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();

  const [activeTab, setActiveTab] = useState<string>("schema");
  const [selectedTableIndex, setSelectedTableIndex] = useState(0);
  const [expandedJsonCol, setExpandedJsonCol] = useState<string | null>(null);

  // Structured Query Tester state
  const [queryMetric, setQueryMetric] = useState("");
  const [queryAggFn, setQueryAggFn] = useState<"sum" | "avg" | "count" | "min" | "max">("sum");
  const [queryGroupBy, setQueryGroupBy] = useState("");
  const [queryFilterKey, setQueryFilterKey] = useState("");
  const [queryFilterVal, setQueryFilterVal] = useState("");

  // Direct SQL Query Runner state (for external databases)
  const [sqlQuery, setSqlQuery] = useState("");
  const [sqlResult, setSqlResult] = useState<SqlQueryResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // RAG Search Tester state
  const [searchQuery, setSearchQuery] = useState("");

  const { data: ds, isLoading, error } = useQuery({
    queryKey: ["data-source", selectedCompanyId, id],
    queryFn: () => dataSourcesApi.get(selectedCompanyId!, id!),
    enabled: !!selectedCompanyId && !!id,
  });

  const activeTable = ds?.tables?.[selectedTableIndex];

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
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" />
                  {ds.status}
                </span>
                <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground uppercase tracking-wide">
                  {ds.sourceType}
                </span>
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
        </div>
      </div>

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

          {/* Tab: JEV Semantic Profile */}
          {activeTab === "jev" && <JevSemanticProfileView ds={ds} />}

          {/* Tab 1: Schema & Profiling */}
          {activeTab === "schema" && activeTable && (
            <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h3 className="font-semibold text-sm text-foreground">
                  Table Columns: <span className="font-mono text-primary">{activeTable.tableName}</span> (
                  {activeTable.columnCount} columns, {activeTable.rowCount} rows)
                </h3>
              </div>
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
              {activeTable.semanticModel?.relationships &&
                activeTable.semanticModel.relationships.length > 0 && (
                  <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
                    <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                      <GitBranch className="h-4 w-4 text-primary" /> Foreign Key Relationships (Relational
                      Graph)
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      {activeTable.semanticModel.relationships.map((rel: any, idx: number) => (
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
                            Type: <span className="font-medium text-foreground">{rel.type || "many-to-one"}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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

              <div className="flex justify-end">
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

function JevSemanticProfileView({ ds }: { ds: any }) {
  const profile = ds.semanticProfile;
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

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Onboarding Agent */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Onboarding Specialist</span>
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <p className="text-base font-bold text-foreground truncate">{profile.onboardedBy || "Onboarding Orchestrator"}</p>
          <p className="text-xs text-muted-foreground">Autonomous ingestion agent</p>
        </div>

        {/* Domain Classification */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Domain Classification</span>
            <Sparkles className="h-4 w-4 text-amber-500" />
          </div>
          <p className="text-base font-bold text-foreground uppercase font-mono">{profile.domain || "General"}</p>
          <p className="text-xs text-muted-foreground">Confidence: {((profile.confidence ?? 0.85) * 100).toFixed(0)}%</p>
        </div>

        {/* Downstream Agent Affinity */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Target Agent Affinity</span>
            <Target className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="text-base font-bold text-foreground truncate">{profile.targetAgentAffinity || "Homseo Orchestrator"}</p>
          <p className="text-xs text-muted-foreground">Recommended consumer agent</p>
        </div>

        {/* DecisionSpecs Executed */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>JEV DecisionSpecs</span>
            <Workflow className="h-4 w-4 text-blue-500" />
          </div>
          <p className="text-base font-bold text-foreground">{profile.decisionSpecRefs?.length || 0} Specs</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{profile.decisionSpecRefs?.join(", ")}</p>
        </div>
      </div>

      {/* Primary Entities & Key Topics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" /> Primary Entities Identified
          </h4>
          <p className="text-xs text-muted-foreground">
            Core enterprise objects discovered by the JEV model to enable direct query routing and entity lookup.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {profile.entities && profile.entities.length > 0 ? (
              profile.entities.map((ent: string) => (
                <span
                  key={ent}
                  className="rounded-lg bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs font-semibold text-primary"
                >
                  {ent}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground italic">No primary entities isolated.</span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" /> Semantic Topics & Context
          </h4>
          <p className="text-xs text-muted-foreground">
            Semantic clusters and thematic keywords indexed for intelligent agent retrieval.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {profile.topics && profile.topics.length > 0 ? (
              profile.topics.map((top: string) => (
                <span
                  key={top}
                  className="rounded-lg bg-muted border border-border px-2.5 py-1 text-xs font-medium text-foreground"
                >
                  {top}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground italic">Domain topics inferred automatically.</span>
            )}
          </div>
        </div>
      </div>

      {/* Semantic Metrics Table */}
      {profile.metrics && profile.metrics.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-3">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Play className="h-4 w-4 text-primary fill-current" /> Numerical Metrics Discovered by JEV
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
  );
}
