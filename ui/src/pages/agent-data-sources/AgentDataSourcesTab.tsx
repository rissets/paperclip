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
} from "lucide-react";
import type { Agent, AgentDataSourcesResponse, DataSource } from "@paperclipai/shared";
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
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "rag_document" | "structured" | "database">("all");
  const [isDirty, setIsDirty] = useState(false);

  // Sync state from query data
  useEffect(() => {
    if (data) {
      setMode(data.mode);
      setSelectedIds(data.dataSourceIds || []);
      setIsDirty(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (newConfig: { mode: AccessMode; dataSourceIds: string[] }) =>
      agentsApi.updateDataSources(agent.id, newConfig, companyId),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.agents.dataSources(agent.id), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      setIsDirty(false);
      pushToast({
        title: "Akses Data Source Diperbarui",
        body: `Pengaturan data source untuk ${agent.name} berhasil disimpan.`,
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
    });
  };

  const availableSources = useMemo(() => data?.availableDataSources || [], [data]);

  const filteredSources = useMemo(() => {
    return availableSources.filter((ds) => {
      const matchesSearch =
        !search ||
        ds.name.toLowerCase().includes(search.toLowerCase()) ||
        (ds.description && ds.description.toLowerCase().includes(search.toLowerCase()));

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
          Tentukan data source dan basis pengetahuan yang dapat diakses oleh agen ini untuk menjawab pertanyaan,
          mengekstrak konteks, atau menjalankan query analisis.
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
              Agen memiliki akses global ke seluruh dokumen RAG, file terstruktur, dan database aktif organisasi.
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
            <h4 className="font-medium text-foreground">Pilih Data Source Tertentu (Scoped)</h4>
            <p className="text-xs text-muted-foreground">
              Akses dibatasi hanya pada data source spesifik yang dipilih manual di bawah.
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-border/50 text-xs text-muted-foreground font-mono">
            {selectedIds.length} dari {availableSources.length} dipilih
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
              Agen tidak memiliki izin untuk mengambil data atau membaca basis pengetahuan organisasi.
            </p>
          </div>
          <div className="mt-4 pt-2 border-t border-border/50 text-xs text-muted-foreground font-mono">
            0 sumber data
          </div>
        </div>
      </div>

      {/* Selected Sources Configuration Panel */}
      {mode === "selected" && (
        <div className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Pilih Data Source untuk {agent.name}</h4>
              <p className="text-xs text-muted-foreground">
                Centang data source yang relevan dengan tugas dan spesialisasi agen ini.
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
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cari berdasarkan nama dokumen, tabel, atau database..."
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
          <div className="space-y-2 pt-2">
            {filteredSources.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Tidak ada data source yang sesuai dengan filter pencarian.
              </div>
            ) : (
              filteredSources.map((ds) => {
                const isSelected = selectedIds.includes(ds.id);
                const IconComponent = getSourceIcon(ds.sourceType);
                const tableCount = ds.tables?.length || 0;

                return (
                  <div
                    key={ds.id}
                    onClick={() => handleToggleSource(ds.id)}
                    className={`flex items-center justify-between p-3 rounded-md border cursor-pointer transition-colors ${
                      isSelected
                        ? "border-primary/60 bg-primary/5 hover:bg-primary/10"
                        : "border-border bg-background hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-5 w-5 rounded border flex items-center justify-center transition-colors ${
                          isSelected
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-muted-foreground/40 bg-background"
                        }`}
                      >
                        {isSelected && <Check className="h-3.5 w-3.5" />}
                      </div>
                      <div className="p-2 rounded bg-muted/60 text-foreground">
                        <IconComponent className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-foreground">{ds.name}</span>
                          <Badge variant="outline" className="text-xs uppercase font-mono">
                            {ds.sourceType}
                          </Badge>
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
      )}

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
