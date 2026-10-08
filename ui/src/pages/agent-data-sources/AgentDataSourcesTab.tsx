import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  FileText,
  Table as TableIcon,
  Globe,
  Sliders,
  ShieldAlert,
  Search,
  Check,
  CheckCircle2,
  Save,
  Server,
  Folder,
  Layers,
  Sparkles,
} from "lucide-react";
import type { Agent, AgentDataSourcesResponse, DataSource, DataSourceCollection } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageSkeleton } from "@/components/PageSkeleton";

interface Props {
  agent: Agent;
  companyId?: string;
}

type AccessMode = "all" | "selected" | "none";

export function AgentDataSourcesTab({ agent, companyId }: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const { data, isLoading } = useQuery<AgentDataSourcesResponse>({
    queryKey: queryKeys.agents.dataSources(agent.id),
    queryFn: () => agentsApi.dataSources(agent.id, companyId),
    enabled: Boolean(agent.id),
  });

  const [mode, setMode] = useState<AccessMode>("none");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
  const [orchestrationMode, setOrchestrationMode] = useState<"auto" | "off">("auto");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "rag_document" | "structured" | "database">("all");
  const [isDirty, setIsDirty] = useState(false);

  // Sync state from query data
  useEffect(() => {
    if (data) {
      setMode(data.mode);
      setSelectedIds(data.dataSourceIds || []);
      setSelectedCollectionIds(data.collectionIds || []);
      setOrchestrationMode(data.orchestrationMode || "auto");
      setIsDirty(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (newConfig: {
      mode: AccessMode;
      dataSourceIds: string[];
      collectionIds: string[];
      orchestrationMode: "auto" | "off";
    }) =>
      agentsApi.updateDataSources(agent.id, newConfig, companyId),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.agents.dataSources(agent.id), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      setIsDirty(false);
      pushToast({
        title: "Akses Data Source Diperbarui",
        body: `Pengaturan data source dan koleksi untuk ${agent.name} berhasil disimpan.`,
      });
    },
    onError: (err: any) => {
      pushToast({
        title: "Gagal Menyimpan Data Source",
        body: err?.message || "Terjadi kesalahan saat menyimpan pengaturan.",
      });
    },
  });

  const handleModeChange = (newMode: AccessMode) => {
    setMode(newMode);
    setIsDirty(true);
  };

  const handleToggleCollection = (id: string) => {
    setSelectedCollectionIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      setIsDirty(true);
      return next;
    });
  };

  const handleSelectAllCollections = () => {
    setSelectedCollectionIds(availableCollections.map((c) => c.id));
    setIsDirty(true);
  };

  const handleDeselectAllCollections = () => {
    setSelectedCollectionIds([]);
    setIsDirty(true);
  };

  const handleToggleSource = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      setIsDirty(true);
      return next;
    });
  };

  const handleSelectAll = (filteredSources: DataSource[]) => {
    const idsToAdd = filteredSources.map((ds) => ds.id);
    setSelectedIds((prev) => {
      const combined = Array.from(new Set([...prev, ...idsToAdd]));
      setIsDirty(true);
      return combined;
    });
  };

  const handleDeselectAll = (filteredSources: DataSource[]) => {
    const idsToRemove = new Set(filteredSources.map((ds) => ds.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => !idsToRemove.has(id));
      setIsDirty(true);
      return next;
    });
  };

  const handleSave = () => {
    mutation.mutate({
      mode,
      dataSourceIds: mode === "selected" ? selectedIds : [],
      collectionIds: mode === "selected" ? selectedCollectionIds : [],
      orchestrationMode,
    });
  };

  const availableSources = useMemo(() => data?.availableDataSources || [], [data]);
  const availableCollections = useMemo<DataSourceCollection[]>(
    () => (data?.availableCollections as DataSourceCollection[]) || [],
    [data],
  );

  const selectedCollectionSet = useMemo(() => new Set(selectedCollectionIds), [selectedCollectionIds]);

  // Data sources covered via collection membership
  const coveredByCollectionSourceIds = useMemo(() => {
    const set = new Set<string>();
    for (const ds of availableSources) {
      if (ds.collectionId && selectedCollectionSet.has(ds.collectionId)) {
        set.add(ds.id);
      }
    }
    return set;
  }, [availableSources, selectedCollectionSet]);

  // Total active accessible data sources count
  const effectiveCount = useMemo(() => {
    if (mode === "all") return availableSources.length;
    if (mode === "none") return 0;
    const combined = new Set([...selectedIds, ...Array.from(coveredByCollectionSourceIds)]);
    return combined.size;
  }, [mode, availableSources.length, selectedIds, coveredByCollectionSourceIds]);

  const filteredSources = useMemo(() => {
    return availableSources.filter((ds) => {
      const matchesSearch =
        !search ||
        ds.name.toLowerCase().includes(search.toLowerCase()) ||
        (ds.description && ds.description.toLowerCase().includes(search.toLowerCase())) ||
        (ds.collectionName && ds.collectionName.toLowerCase().includes(search.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterType === "all") return true;
      if (filterType === "rag_document") return ds.sourceType === "rag_document";
      if (filterType === "structured") return ds.sourceType === "csv" || ds.sourceType === "excel";
      if (filterType === "database") {
        return (
          ds.sourceType === "database" ||
          ds.sourceType === "postgres" ||
          ds.sourceType === "mariadb" ||
          ds.sourceType === "mysql"
        );
      }
      return true;
    });
  }, [availableSources, search, filterType]);

  const getSourceIcon = (type: string) => {
    const t = type.toLowerCase();
    if (t === "rag_document") return FileText;
    if (t === "csv" || t === "excel") return TableIcon;
    return Server;
  };

  if (isLoading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex flex-col gap-1 border-b border-border pb-4">
        <h3 className="text-lg font-semibold tracking-tight text-foreground flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          Data Sources & Knowledge Access
        </h3>
        <p className="text-sm text-muted-foreground">
          Tentukan koleksi dan data source yang dapat diakses oleh agen ini untuk menjawab pertanyaan,
          mengekstrak konteks, atau menjalankan query analisis. Data di luar pilihan ini tidak dapat diakses agen.
        </p>
      </div>

      {/* Mode Selection Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Mode: ALL */}
        <div
          onClick={() => handleModeChange("all")}
          className={`cursor-pointer rounded-lg border p-4 transition-all flex flex-col justify-between ${
            mode === "all"
              ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
              : "border-border bg-card hover:border-muted-foreground/40"
          }`}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-md bg-primary/10 text-primary">
                <Globe className="h-5 w-5" />
              </div>
              {mode === "all" && <CheckCircle2 className="h-5 w-5 text-primary" />}
            </div>
            <h4 className="font-medium text-foreground">Semua Data Source (Universal)</h4>
            <p className="text-xs text-muted-foreground">
              Agen memiliki akses global ke seluruh koleksi, dokumen RAG, file terstruktur, dan database aktif organisasi.
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-border/50 text-xs text-muted-foreground font-mono">
            {availableSources.length} sumber data tersedia
          </div>
        </div>

        {/* Mode: SELECTED */}
        <div
          onClick={() => handleModeChange("selected")}
          className={`cursor-pointer rounded-lg border p-4 transition-all flex flex-col justify-between ${
            mode === "selected"
              ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
              : "border-border bg-card hover:border-muted-foreground/40"
          }`}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-md bg-accent text-accent-foreground">
                <Sliders className="h-5 w-5" />
              </div>
              {mode === "selected" && <CheckCircle2 className="h-5 w-5 text-primary" />}
            </div>
            <h4 className="font-medium text-foreground">Pilih Koleksi / Data Source (Scoped)</h4>
            <p className="text-xs text-muted-foreground">
              Akses dibatasi secara ketat hanya pada koleksi atau data source spesifik yang dipilih di bawah.
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-border/50 text-xs text-muted-foreground font-mono">
            {selectedCollectionIds.length > 0 ? (
              <span>{selectedCollectionIds.length} koleksi &middot; {effectiveCount} data source aktif</span>
            ) : (
              <span>{selectedIds.length} dari {availableSources.length} dipilih</span>
            )}
          </div>
        </div>

        {/* Mode: NONE */}
        <div
          onClick={() => handleModeChange("none")}
          className={`cursor-pointer rounded-lg border p-4 transition-all flex flex-col justify-between ${
            mode === "none"
              ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
              : "border-border bg-card hover:border-muted-foreground/40"
          }`}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-md bg-muted text-muted-foreground">
                <ShieldAlert className="h-5 w-5" />
              </div>
              {mode === "none" && <CheckCircle2 className="h-5 w-5 text-primary" />}
            </div>
            <h4 className="font-medium text-foreground">Tidak Ada Akses (Terisolasi)</h4>
            <p className="text-xs text-muted-foreground">
              Agen tidak memiliki izin untuk mengambil data atau membaca basis pengetahuan organisasi apa pun.
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-border/50 text-xs text-muted-foreground font-mono">
            0 sumber data
          </div>
        </div>
      </div>

      {/* Selected Sources Configuration Panel */}
      {mode === "selected" && (
        <div className="space-y-6 rounded-lg border border-border bg-card p-5">
          {/* Section 1: Koleksi / Folder Data Source */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Folder className="h-4 w-4 text-primary" />
                  Koleksi Data ({availableCollections.length})
                </h4>
                <p className="text-xs text-muted-foreground">
                  Pilih satu atau beberapa koleksi (folder) untuk memberikan agen akses ke seluruh dataset, tabel, dan dokumen di dalamnya sekaligus.
                </p>
              </div>
              {availableCollections.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSelectAllCollections}
                    disabled={selectedCollectionIds.length === availableCollections.length}
                  >
                    Pilih Semua Koleksi
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeselectAllCollections}
                    disabled={selectedCollectionIds.length === 0}
                  >
                    Batal Koleksi
                  </Button>
                </div>
              )}
            </div>

            {availableCollections.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Belum ada koleksi data yang dibuat di organisasi ini. Anda dapat membuat koleksi baru di menu Data Sources.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {availableCollections.map((col) => {
                  const isSelected = selectedCollectionIds.includes(col.id);
                  return (
                    <div
                      key={col.id}
                      onClick={() => handleToggleCollection(col.id)}
                      className={`cursor-pointer rounded-lg border p-3 transition-all flex flex-col justify-between ${
                        isSelected
                          ? "border-primary bg-primary/5 ring-1 ring-primary/40 shadow-sm"
                          : "border-border bg-background hover:border-muted-foreground/30"
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                              <Folder className="h-4 w-4" />
                            </div>
                            <span className="font-semibold text-sm text-foreground line-clamp-1">
                              {col.name}
                            </span>
                          </div>
                          <div
                            className={`h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                              isSelected
                                ? "bg-primary border-primary text-primary-foreground"
                                : "border-muted-foreground/40 bg-background"
                            }`}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </div>
                        </div>

                        {col.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {col.description}
                          </p>
                        )}
                      </div>

                      <div className="mt-3 pt-2 border-t border-border/50 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground font-mono">
                        <Badge variant="outline" className="text-xs">
                          {col.dataSourceCount || 0} Data Sources
                        </Badge>
                        {(col.tableCount || 0) > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {col.tableCount} Tabel
                          </Badge>
                        )}
                        {(col.documentCount || 0) > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {col.documentCount} Dokumen RAG
                          </Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section 2: Data Source Individual */}
          <div className="space-y-3 pt-2">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Database className="h-4 w-4 text-primary" />
                  Data Source Individual & Detail
                </h4>
                <p className="text-xs text-muted-foreground">
                  Pilih data source tambahan atau periksa status akses per dataset. Data source yang termasuk dalam koleksi terpilih otomatis aktif.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSelectAll(filteredSources)}
                  disabled={filteredSources.length === 0}
                >
                  Pilih Semua
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDeselectAll(filteredSources)}
                  disabled={filteredSources.length === 0}
                >
                  Batal Semua
                </Button>
              </div>
            </div>

            {/* Filters & Search */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Cari berdasarkan nama, koleksi, dokumen, atau database..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                <Button
                  variant={filterType === "all" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setFilterType("all")}
                >
                  Semua ({availableSources.length})
                </Button>
                <Button
                  variant={filterType === "rag_document" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setFilterType("rag_document")}
                >
                  RAG Dokumen
                </Button>
                <Button
                  variant={filterType === "structured" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setFilterType("structured")}
                >
                  Terstruktur (CSV/Excel)
                </Button>
                <Button
                  variant={filterType === "database" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setFilterType("database")}
                >
                  Database
                </Button>
              </div>
            </div>

            {/* Source List */}
            <div className="space-y-2 pt-1">
              {filteredSources.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Tidak ada data source yang sesuai dengan filter pencarian.
                </div>
              ) : (
                filteredSources.map((ds) => {
                  const isDirectlySelected = selectedIds.includes(ds.id);
                  const isCoveredByCollection = coveredByCollectionSourceIds.has(ds.id);
                  const isEffectiveSelected = isDirectlySelected || isCoveredByCollection;
                  const IconComponent = getSourceIcon(ds.sourceType);
                  const tableCount = ds.tables?.length || 0;

                  return (
                    <div
                      key={ds.id}
                      onClick={() => {
                        if (!isCoveredByCollection) {
                          handleToggleSource(ds.id);
                        }
                      }}
                      className={`flex items-center justify-between p-3 rounded-md border transition-colors ${
                        isEffectiveSelected
                          ? "border-primary/60 bg-primary/5 hover:bg-primary/10"
                          : "border-border bg-background hover:bg-muted/40 cursor-pointer"
                      } ${isCoveredByCollection ? "cursor-default" : "cursor-pointer"}`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-5 w-5 rounded border flex items-center justify-center transition-colors ${
                            isEffectiveSelected
                              ? "bg-primary border-primary text-primary-foreground"
                              : "border-muted-foreground/40 bg-background"
                          }`}
                        >
                          {isEffectiveSelected && <Check className="h-3.5 w-3.5" />}
                        </div>
                        <div className="p-2 rounded bg-muted/60 text-foreground">
                          <IconComponent className="h-4 w-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-foreground">{ds.name}</span>
                            <Badge variant="outline" className="text-xs uppercase font-mono">
                              {ds.sourceType}
                            </Badge>
                            {isCoveredByCollection ? (
                              <Badge variant="default" className="text-xs flex items-center gap-1">
                                <Folder className="h-3 w-3" />
                                Termasuk via Koleksi: {ds.collectionName || "Koleksi"}
                              </Badge>
                            ) : ds.collectionName ? (
                              <Badge variant="secondary" className="text-xs flex items-center gap-1">
                                <Folder className="h-3 w-3" />
                                Koleksi: {ds.collectionName}
                              </Badge>
                            ) : null}
                            {ds.status === "ready" && (
                              <Badge variant="secondary" className="text-xs">
                                Ready
                              </Badge>
                            )}
                          </div>
                          {ds.description && (
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                              {ds.description}
                            </p>
                          )}
                          {tableCount > 0 && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {tableCount} tabel relasional terhubung
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Enterprise Orchestrator Card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Enterprise Orchestrator
            </h4>
            <p className="text-xs text-muted-foreground">
              Kontrol koordinasi terpusat untuk perencanaan query analitis, fast-path routing, dan eksekusi terverifikasi.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={orchestrationMode === "auto" && mode !== "none" && effectiveCount > 0 ? "default" : "secondary"}
              className="text-xs"
            >
              {orchestrationMode === "auto" && mode !== "none" && effectiveCount > 0
                ? "Status: Aktif"
                : "Status: Nonaktif"}
            </Badge>
            <Badge variant="outline" className="text-xs font-mono">
              Adapter: Supported
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              Mode Orchestration
            </label>
            <p className="text-xs text-muted-foreground">
              {orchestrationMode === "auto"
                ? "Auto: Coordinator hanya diaktifkan ketika pertanyaan membutuhkan data analitis/terstruktur."
                : "Off: Eksekusi normal agen tanpa koordinasi pipeline Enterprise Orchestrator."}
            </p>
            {mode === "none" && (
              <p className="text-xs text-amber-500">
                Catatan: Akses data source saat ini adalah Terisolasi (none). Berikan akses data source agar orkestrasi dapat berjalan.
              </p>
            )}
          </div>

          <div className="flex justify-start md:justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant={orchestrationMode === "auto" ? "default" : "outline"}
              onClick={() => {
                setOrchestrationMode("auto");
                setIsDirty(true);
              }}
            >
              Auto (Rekomendasi)
            </Button>
            <Button
              type="button"
              size="sm"
              variant={orchestrationMode === "off" ? "default" : "outline"}
              onClick={() => {
                setOrchestrationMode("off");
                setIsDirty(true);
              }}
            >
              Off
            </Button>
          </div>
        </div>

        <div className="pt-2 border-t border-border/40 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span>
            Scope Penugasan: <strong className="text-foreground capitalize">{mode}</strong>
          </span>
          <span>&bull;</span>
          <span>
            Fast-Path Latency Target: <strong className="text-foreground">p95 &lt; 250ms</strong>
          </span>
          <span>&bull;</span>
          <span>
            Whole-Question Ceiling: <strong className="text-foreground">60s</strong>
          </span>
        </div>
      </div>

      {/* Verified Experience Learning & Mapping Review Card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Verified Experience &amp; Mapping Review
            </h4>
            <p className="text-xs text-muted-foreground">
              Sistem query learning berbasis memori template terverifikasi dengan proteksi drift skema dan tinjauan umpan balik operator.
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            Audit Policy: Guarded
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3 rounded-md border border-border/60 bg-muted/20 space-y-1">
            <div className="text-xs text-muted-foreground">Status Pembelajaran</div>
            <div className="text-sm font-medium text-foreground">Candidate &rarr; Verified</div>
            <p className="text-xs text-muted-foreground">
              Keberhasilan SQL semata tidak otomatis mempromosikan template ke produksi.
            </p>
          </div>

          <div className="p-3 rounded-md border border-border/60 bg-muted/20 space-y-1">
            <div className="text-xs text-muted-foreground">Proteksi Skema Drift</div>
            <div className="text-sm font-medium text-foreground">Fingerprint Active</div>
            <p className="text-xs text-muted-foreground">
              Template dideaktivasi otomatis jika skema atau definisi metrik upstream berubah.
            </p>
          </div>

          <div className="p-3 rounded-md border border-border/60 bg-muted/20 space-y-1">
            <div className="text-xs text-muted-foreground">Isolasi Akses &amp; ACL</div>
            <div className="text-sm font-medium text-foreground">Reauthorized</div>
            <p className="text-xs text-muted-foreground">
              Penggunaan ulang template selalu memverifikasi izin sumber data terkini pemanggil.
            </p>
          </div>
        </div>
      </div>

      {/* Save Action Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-border">
        <div className="text-xs text-muted-foreground">
          {isDirty ? (
            <span className="text-amber-500 font-medium">Ada perubahan yang belum disimpan.</span>
          ) : (
            <span>Semua perubahan tersimpan.</span>
          )}
        </div>
        <Button onClick={handleSave} disabled={!isDirty || mutation.isPending} className="gap-2">
          <Save className="h-4 w-4" />
          {mutation.isPending ? "Menyimpan..." : "Simpan Pengaturan"}
        </Button>
      </div>
    </div>
  );
}
