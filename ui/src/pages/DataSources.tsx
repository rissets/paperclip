import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Database,
  FileSpreadsheet,
  FileText,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  UploadCloud,
  Server,
  Zap,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { dataSourcesApi } from "@/api/data-sources";
import type {
  DataSource,
  DataSourceType,
  DatabaseConnectionConfig,
  DatabaseConnectionTestResult,
} from "@paperclipai/shared";

export function DataSources() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<"all" | "databases" | "structured" | "knowledge">("all");

  // File Upload modal state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Connect Database modal state
  const [isConnectDbOpen, setIsConnectDbOpen] = useState(false);
  const [dbType, setDbType] = useState<"postgres" | "mariadb" | "mysql">("postgres");
  const [dbHost, setDbHost] = useState("localhost");
  const [dbPort, setDbPort] = useState(5432);
  const [dbDatabase, setDbDatabase] = useState("");
  const [dbUsername, setDbUsername] = useState("");
  const [dbPassword, setDbPassword] = useState("");
  const [dbSsl, setDbSsl] = useState(false);
  const [dbCustomName, setDbCustomName] = useState("");
  const [dbCustomDescription, setDbCustomDescription] = useState("");
  const [dbIsTesting, setDbIsTesting] = useState(false);
  const [dbTestResult, setDbTestResult] = useState<DatabaseConnectionTestResult | null>(null);
  const [dbConnectError, setDbConnectError] = useState<string | null>(null);

  const {
    data: dataSources = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["data-sources", selectedCompanyId],
    queryFn: () => dataSourcesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      dataSourcesApi.upload(selectedCompanyId!, file, {
        name: customName || undefined,
        description: customDescription || undefined,
      }),
    onSuccess: (newDs) => {
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
      setIsUploadOpen(false);
      setSelectedFile(null);
      setCustomName("");
      setCustomDescription("");
      setUploadError(null);
      navigate(`/data-sources/${newDs.id}`);
    },
    onError: (err: any) => {
      setUploadError(err?.message || "Failed to onboard data source.");
    },
  });

  const connectDbMutation = useMutation({
    mutationFn: (config: DatabaseConnectionConfig) =>
      dataSourcesApi.connectDatabase(selectedCompanyId!, config, {
        name: dbCustomName || undefined,
        description: dbCustomDescription || undefined,
      }),
    onSuccess: (newDs) => {
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
      setIsConnectDbOpen(false);
      setDbConnectError(null);
      setDbTestResult(null);
      navigate(`/data-sources/${newDs.id}`);
    },
    onError: (err: any) => {
      setDbConnectError(err?.message || "Failed to connect and onboard database.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => dataSourcesApi.delete(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-sources", selectedCompanyId] });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      if (!customName) {
        setCustomName(file.name.replace(/\.[^/.]+$/, ""));
      }
    }
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;
    setUploadError(null);
    uploadMutation.mutate(selectedFile);
  };

  const handleEngineChange = (type: "postgres" | "mariadb" | "mysql") => {
    setDbType(type);
    setDbTestResult(null);
    setDbConnectError(null);
    if (type === "postgres") {
      setDbPort(5432);
    } else {
      setDbPort(3306);
    }
  };

  const handleTestConnection = async () => {
    if (!dbHost || !dbDatabase || !dbUsername) {
      setDbTestResult({
        success: false,
        error: "Host, database name, and username are required to test connection.",
      });
      return;
    }

    setDbIsTesting(true);
    setDbTestResult(null);
    setDbConnectError(null);

    try {
      const res = await dataSourcesApi.testConnection(selectedCompanyId!, {
        type: dbType,
        host: dbHost,
        port: Number(dbPort),
        database: dbDatabase,
        username: dbUsername,
        password: dbPassword,
        ssl: dbSsl,
      });
      setDbTestResult(res);
    } catch (err: any) {
      setDbTestResult({
        success: false,
        error: err?.message || "Connection test failed.",
      });
    } finally {
      setDbIsTesting(false);
    }
  };

  const handleConnectDbSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setDbConnectError(null);
    connectDbMutation.mutate({
      type: dbType,
      host: dbHost,
      port: Number(dbPort),
      database: dbDatabase,
      username: dbUsername,
      password: dbPassword,
      ssl: dbSsl,
    });
  };

  const filteredSources = dataSources.filter((ds) => {
    if (activeTab === "databases") {
      return ds.sourceType === "postgres" || ds.sourceType === "mariadb" || ds.sourceType === "mysql";
    }
    if (activeTab === "structured") {
      return ds.sourceType === "csv" || ds.sourceType === "excel";
    }
    if (activeTab === "knowledge") {
      return ds.sourceType === "rag_document";
    }
    return true;
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Please select a company to view data sources.
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Database className="h-6 w-6 text-primary" />
            Enterprise Data Sources
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect external databases (PostgreSQL, MariaDB, MySQL), tabular files (CSV, Excel), and document knowledge bases for AI agents.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => {
              setIsConnectDbOpen(true);
              setDbTestResult(null);
              setDbConnectError(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <Server className="h-4 w-4 text-primary" />
            Connect Database
          </button>
          <button
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Upload File
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-border pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab("all")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === "all"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          All ({dataSources.length})
        </button>
        <button
          onClick={() => setActiveTab("databases")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === "databases"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Databases (
          {
            dataSources.filter(
              (d) => d.sourceType === "postgres" || d.sourceType === "mariadb" || d.sourceType === "mysql",
            ).length
          }
          )
        </button>
        <button
          onClick={() => setActiveTab("structured")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === "structured"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Files (CSV & Excel) (
          {dataSources.filter((d) => d.sourceType === "csv" || d.sourceType === "excel").length}
          )
        </button>
        <button
          onClick={() => setActiveTab("knowledge")}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === "knowledge"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Knowledge Base (RAG) (
          {dataSources.filter((d) => d.sourceType === "rag_document").length}
          )
        </button>
      </div>

      {/* Loading & Error States */}
      {isLoading && (
        <div className="flex items-center justify-center p-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading data sources...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          Failed to load data sources.
        </div>
      )}

      {/* Empty State */}
      {!isLoading && filteredSources.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <UploadCloud className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">No data sources found</h3>
          <p className="mt-1 text-sm text-muted-foreground max-w-sm mx-auto">
            Connect an external database (PostgreSQL, MariaDB, MySQL), upload spreadsheets, or import policy documents.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={() => setIsConnectDbOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              <Server className="h-4 w-4 text-primary" />
              Connect Database
            </button>
            <button
              onClick={() => setIsUploadOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Upload File
            </button>
          </div>
        </div>
      )}

      {/* Sources Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredSources.map((ds) => {
          const isDatabase =
            ds.sourceType === "postgres" || ds.sourceType === "mariadb" || ds.sourceType === "mysql";
          const isStructured = ds.sourceType === "csv" || ds.sourceType === "excel";
          const tableCount = ds.tables?.length || (ds.metadata as any)?.tableCount || 0;
          const totalRows = (ds.metadata as any)?.totalRows ?? (ds.tables?.[0]?.rowCount || 0);
          const chunkCount = (ds.metadata as any)?.chunkCount || 0;
          const serverVersion = (ds.metadata as any)?.serverVersion || "";

          let badgeColor = "bg-primary/10 text-primary";
          let icon = <Database className="h-5 w-5" />;
          let typeLabel = "Database";

          if (ds.sourceType === "postgres") {
            badgeColor = "bg-primary/10 text-primary";
            icon = <Database className="h-5 w-5" />;
            typeLabel = "PostgreSQL";
          } else if (ds.sourceType === "mariadb") {
            badgeColor = "bg-amber-500/10 text-amber-600";
            icon = <Server className="h-5 w-5" />;
            typeLabel = "MariaDB";
          } else if (ds.sourceType === "mysql") {
            badgeColor = "bg-blue-500/10 text-blue-600";
            icon = <Server className="h-5 w-5" />;
            typeLabel = "MySQL";
          } else if (ds.sourceType === "csv") {
            badgeColor = "bg-emerald-500/10 text-emerald-600";
            icon = <FileSpreadsheet className="h-5 w-5" />;
            typeLabel = "CSV File";
          } else if (ds.sourceType === "excel") {
            badgeColor = "bg-emerald-500/10 text-emerald-600";
            icon = <FileSpreadsheet className="h-5 w-5" />;
            typeLabel = "Excel Workbook";
          } else {
            badgeColor = "bg-sky-500/10 text-sky-600";
            icon = <FileText className="h-5 w-5" />;
            typeLabel = "RAG Document";
          }

          return (
            <div
              key={ds.id}
              className="group relative flex flex-col justify-between rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:border-primary/50 hover:shadow-md"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${badgeColor}`}
                    >
                      {icon}
                    </div>
                    <div>
                      <h4 className="font-semibold text-foreground truncate max-w-xs">{ds.name}</h4>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">
                        {typeLabel}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {ds.status === "ready" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" />
                        Ready
                      </span>
                    )}
                    {ds.status === "processing" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-600 animate-pulse">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Onboarding
                      </span>
                    )}
                    {ds.status === "error" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        <AlertCircle className="h-3 w-3" />
                        Error
                      </span>
                    )}
                  </div>
                </div>

                {ds.description && (
                  <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{ds.description}</p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">Volume:</span>
                    <span className="ml-1 font-medium text-foreground">
                      {isDatabase || isStructured
                        ? `${tableCount} table(s) • ${totalRows.toLocaleString()} rows`
                        : `${chunkCount} chunks`}
                    </span>
                  </div>
                  <div className="text-right truncate">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="ml-1 font-medium text-foreground truncate">
                      {isDatabase ? (serverVersion ? serverVersion.split(" ")[0] : "Live DB") : ds.fileSize ? `${Math.round(ds.fileSize / 1024)} KB` : "Document"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                <button
                  onClick={() => {
                    if (confirm(`Delete data source '${ds.name}'?`)) {
                      deleteMutation.mutate(ds.id);
                    }
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
                  title="Delete data source"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <Link
                  to={`/data-sources/${ds.id}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Inspect & Query <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connect Database Modal */}
      {isConnectDbOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl my-8">
            <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              Connect External Database
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Connect PostgreSQL, MariaDB, or MySQL to run automated schema discovery and bilingual semantic modeling.
            </p>

            {dbConnectError && (
              <div className="mt-4 rounded-lg bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {dbConnectError}
              </div>
            )}

            {dbTestResult && (
              <div
                className={`mt-4 rounded-lg p-3 text-xs flex items-start gap-2 ${
                  dbTestResult.success
                    ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                    : "bg-destructive/10 text-destructive border border-destructive/20"
                }`}
              >
                {dbTestResult.success ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="font-semibold">
                    {dbTestResult.success ? "Connection Successful!" : "Connection Failed"}
                  </p>
                  <p className="mt-0.5">
                    {dbTestResult.success
                      ? `Connected to ${dbTestResult.database} (${dbTestResult.version}) in ${dbTestResult.latencyMs}ms.`
                      : dbTestResult.error}
                  </p>
                </div>
              </div>
            )}

            <form onSubmit={handleConnectDbSubmit} className="mt-4 space-y-4">
              {/* Engine Selector */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">Database Engine</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => handleEngineChange("postgres")}
                    className={`rounded-lg border p-2 text-xs font-medium text-center transition-colors ${
                      dbType === "postgres"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    PostgreSQL
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEngineChange("mariadb")}
                    className={`rounded-lg border p-2 text-xs font-medium text-center transition-colors ${
                      dbType === "mariadb"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    MariaDB
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEngineChange("mysql")}
                    className={`rounded-lg border p-2 text-xs font-medium text-center transition-colors ${
                      dbType === "mysql"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    MySQL
                  </button>
                </div>
              </div>

              {/* Host and Port */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-foreground mb-1">Host / Server</label>
                  <input
                    type="text"
                    value={dbHost}
                    onChange={(e) => setDbHost(e.target.value)}
                    placeholder="localhost or db.company.com"
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Port</label>
                  <input
                    type="number"
                    value={dbPort}
                    onChange={(e) => setDbPort(Number(e.target.value))}
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    required
                  />
                </div>
              </div>

              {/* Database Name */}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">Database Name</label>
                <input
                  type="text"
                  value={dbDatabase}
                  onChange={(e) => setDbDatabase(e.target.value)}
                  placeholder="e.g. enterprise_erp"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  required
                />
              </div>

              {/* Username and Password */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Username</label>
                  <input
                    type="text"
                    value={dbUsername}
                    onChange={(e) => setDbUsername(e.target.value)}
                    placeholder="readonly_user"
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Password</label>
                  <input
                    type="password"
                    value={dbPassword}
                    onChange={(e) => setDbPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              {/* SSL toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="dbSsl"
                  checked={dbSsl}
                  onChange={(e) => setDbSsl(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <label htmlFor="dbSsl" className="text-xs text-foreground cursor-pointer">
                  Require SSL / TLS Encrypted Connection
                </label>
              </div>

              {/* Custom Display Name & Description */}
              <div className="border-t border-border pt-3">
                <label className="block text-xs font-medium text-foreground mb-1">
                  Display Name (Optional)
                </label>
                <input
                  type="text"
                  value={dbCustomName}
                  onChange={(e) => setDbCustomName(e.target.value)}
                  placeholder="e.g. Production ERP PostgreSQL"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Description (Optional)
                </label>
                <textarea
                  value={dbCustomDescription}
                  onChange={(e) => setDbCustomDescription(e.target.value)}
                  placeholder="Operational context for the AI agents..."
                  rows={2}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-between border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsConnectDbOpen(false);
                      setDbTestResult(null);
                      setDbConnectError(null);
                    }}
                    disabled={connectDbMutation.isPending}
                    className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={dbIsTesting || connectDbMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    {dbIsTesting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Zap className="h-3.5 w-3.5 text-amber-500" />
                    )}
                    {dbIsTesting ? "Testing..." : "Test Connection"}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={connectDbMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {connectDbMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {connectDbMutation.isPending ? "Connecting..." : "Connect & Inspect"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload File Modal */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
            <h3 className="text-lg font-bold text-foreground">Upload Data Source</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Upload a file to trigger the autonomous Onboarding Orchestrator.
            </p>

            {uploadError && (
              <div className="mt-4 rounded-lg bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {uploadError}
              </div>
            )}

            <form onSubmit={handleUploadSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Source File (.csv, .xlsx, .xls, .pdf, .docx, .md, .txt)
                </label>
                <input
                  type="file"
                  accept=".csv,.tsv,.xlsx,.xls,.pdf,.docx,.txt,.md"
                  onChange={handleFileChange}
                  className="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-muted file:text-foreground hover:file:bg-muted/80 cursor-pointer border border-border rounded-md p-1"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Data Source Name
                </label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g. Sales Q3 Transaksi"
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">
                  Description (Optional)
                </label>
                <textarea
                  value={customDescription}
                  onChange={(e) => setCustomDescription(e.target.value)}
                  placeholder="Provide brief context for the AI agents..."
                  rows={2}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex items-center justify-between border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setIsUploadOpen(false);
                    setSelectedFile(null);
                    setUploadError(null);
                  }}
                  disabled={uploadMutation.isPending}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedFile || uploadMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {uploadMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {uploadMutation.isPending ? "Onboarding..." : "Start Onboarding"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
