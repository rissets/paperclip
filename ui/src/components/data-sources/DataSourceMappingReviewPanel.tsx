import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Save, Sparkles } from "lucide-react";
import type { DataSource, DataSourceMappingReviewRequest, DataSourceTable } from "@paperclipai/shared";
import { dataSourcesApi } from "@/api/data-sources";

type Aggregation = "sum" | "avg" | "count" | "min" | "max";
type MetricRow = { name: string; column: string; aggregation: Aggregation; description: string };
type DimensionRow = { name: string; column: string; description: string };

function buildRows(table: DataSourceTable) {
  const model = (table.semanticModel || {}) as Record<string, any>;
  const columns = Array.isArray(table.schemaDefinition) ? table.schemaDefinition : [];
  const exactPhysicalColumn = (name: string) => columns.find((column: any) => column?.name === name)?.name || "";
  const metrics: MetricRow[] = (Array.isArray(model.metrics) ? model.metrics : []).map((value: any) => ({
    name: typeof value === "string" ? value : String(value?.name || ""),
    column: typeof value === "object"
      ? String(value?.column || value?.physicalColumn || exactPhysicalColumn(String(value?.name || "")))
      : exactPhysicalColumn(value),
    aggregation: ["sum", "avg", "count", "min", "max"].includes(value?.aggregation) ? value.aggregation : "sum",
    description: typeof value === "object" ? String(value?.description || "") : "",
  }));
  const dimensions: DimensionRow[] = (Array.isArray(model.dimensions) ? model.dimensions : []).map((value: any) => ({
    name: typeof value === "string" ? value : String(value?.name || ""),
    column: typeof value === "object"
      ? String(value?.column || exactPhysicalColumn(String(value?.name || "")))
      : exactPhysicalColumn(value),
    description: typeof value === "object" ? String(value?.description || "") : "",
  }));
  return { metrics, dimensions };
}

function sameRow<T extends Record<string, string>>(left: T, right: T) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export function DataSourceMappingReviewPanel({
  companyId,
  dataSource,
  table,
}: {
  companyId: string;
  dataSource: DataSource;
  table: DataSourceTable;
}) {
  const queryClient = useQueryClient();
  const initialRows = useMemo(() => buildRows(table), [table]);
  const [metrics, setMetrics] = useState<MetricRow[]>(initialRows.metrics);
  const [dimensions, setDimensions] = useState<DimensionRow[]>(initialRows.dimensions);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const model = (table.semanticModel || {}) as Record<string, any>;
  const review = model.mappingReview as { status?: string; revision?: number; reviewedAt?: string; note?: string } | undefined;
  const columns = Array.isArray(table.schemaDefinition) ? table.schemaDefinition : [];

  useEffect(() => {
    setMetrics(initialRows.metrics);
    setDimensions(initialRows.dimensions);
    setNote("");
    setNotice(null);
  }, [initialRows]);

  const mutation = useMutation({
    mutationFn: (request: DataSourceMappingReviewRequest) =>
      dataSourcesApi.reviewSemanticMapping(companyId, dataSource.id, table.id, request),
    onSuccess: async (_result, request) => {
      setNotice(request.decision === "approved" ? "Mapping disetujui dan siap dipakai agent." : "Koreksi mapping tersimpan dan siap dipakai agent.");
      await queryClient.invalidateQueries({ queryKey: ["data-source", companyId, dataSource.id] });
    },
  });

  const metricCorrections = metrics.flatMap((row, index) =>
    sameRow(row, initialRows.metrics[index] || row) ? [] : [{ index, ...row }]);
  const dimensionCorrections = dimensions.flatMap((row, index) =>
    sameRow(row, initialRows.dimensions[index] || row) ? [] : [{ index, ...row }]);
  const hasChanges = metricCorrections.length + dimensionCorrections.length > 0;

  const submit = (decision: DataSourceMappingReviewRequest["decision"]) => {
    setNotice(null);
    const request: DataSourceMappingReviewRequest = {
      decision,
      ...(note.trim() ? { note: note.trim() } : {}),
      metricCorrections,
      dimensionCorrections,
    };
    mutation.mutate(request);
  };

  const columnOptions = columns.filter((column: any) => typeof column?.name === "string");

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-4" aria-labelledby={`mapping-review-title-${table.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 id={`mapping-review-title-${table.id}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Semantic mapping review
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Periksa label, kolom fisik, dan agregasi sebelum agent memakai mapping ini. Koreksi hanya dapat mengikat ke kolom schema yang ditemukan saat onboarding.
          </p>
        </div>
        <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          {review?.status || "not reviewed"}{review?.revision ? ` · rev ${review.revision}` : ""}
        </span>
      </div>

      {metrics.length === 0 && dimensions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          Belum ada metric atau dimension semantic untuk direview pada tabel ini.
        </p>
      ) : (
        <div className="space-y-4">
          {metrics.length > 0 && (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metrics</h5>
              {metrics.map((metric, index) => (
                <div key={`metric-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/20 p-3 md:grid-cols-4">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Nama semantic</span>
                    <input
                      aria-label={`Metric ${index + 1} semantic name`}
                      value={metric.name}
                      onChange={(event) => setMetrics((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Kolom fisik</span>
                    <select
                      aria-label={`Metric ${index + 1} physical column`}
                      value={metric.column}
                      onChange={(event) => setMetrics((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, column: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    >
                      <option value="">Pilih kolom schema</option>
                      {columnOptions.map((column: any) => <option key={column.name} value={column.name}>{column.name} · {column.dataType || "unknown"}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Agregasi</span>
                    <select
                      aria-label={`Metric ${index + 1} aggregation`}
                      value={metric.aggregation}
                      onChange={(event) => setMetrics((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, aggregation: event.target.value as Aggregation } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    >
                      {(["sum", "avg", "count", "min", "max"] as const).map((aggregation) => <option key={aggregation} value={aggregation}>{aggregation}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Deskripsi</span>
                    <input
                      aria-label={`Metric ${index + 1} description`}
                      value={metric.description}
                      onChange={(event) => setMetrics((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, description: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {dimensions.length > 0 && (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dimensions</h5>
              {dimensions.map((dimension, index) => (
                <div key={`dimension-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/20 p-3 md:grid-cols-3">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Nama semantic</span>
                    <input
                      aria-label={`Dimension ${index + 1} semantic name`}
                      value={dimension.name}
                      onChange={(event) => setDimensions((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Kolom fisik</span>
                    <select
                      aria-label={`Dimension ${index + 1} physical column`}
                      value={dimension.column}
                      onChange={(event) => setDimensions((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, column: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    >
                      <option value="">Pilih kolom schema</option>
                      {columnOptions.map((column: any) => <option key={column.name} value={column.name}>{column.name} · {column.dataType || "unknown"}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Deskripsi</span>
                    <input
                      aria-label={`Dimension ${index + 1} description`}
                      value={dimension.description}
                      onChange={(event) => setDimensions((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, description: event.target.value } : row))}
                      className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs text-foreground"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Catatan review (opsional)</span>
        <textarea
          aria-label="Semantic mapping review note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => submit("approved")}
          disabled={mutation.isPending || metrics.length + dimensions.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve mapping
        </button>
        <button
          type="button"
          onClick={() => submit("corrected")}
          disabled={mutation.isPending || !hasChanges}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-2 text-xs font-medium text-foreground hover:bg-background disabled:opacity-50"
        >
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save corrections
        </button>
        {hasChanges && <span className="text-xs text-amber-600">Perubahan belum disimpan.</span>}
      </div>

      {mutation.isError && <p role="alert" className="text-xs text-destructive">{(mutation.error as Error).message || "Review mapping gagal disimpan."}</p>}
      {notice && <p role="status" className="text-xs text-emerald-600">{notice}</p>}
      {Array.isArray(model.mappingReviewHistory) && model.mappingReviewHistory.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-semibold text-foreground">Riwayat review</p>
          <ul className="mt-2 space-y-1">
            {[...model.mappingReviewHistory].slice(-3).reverse().map((entry: any) => (
              <li key={entry.id} className="text-xs text-muted-foreground">
                {entry.decision === "approved" ? "Approved" : "Corrected"} · {entry.reviewerId} · {new Date(entry.reviewedAt).toLocaleString()}
                {entry.note ? ` · ${entry.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
