import { AlertCircle, CalendarRange } from "lucide-react";
import { Link } from "react-router-dom";
import type { DataSource, TemporalOverlapAnalysis } from "@paperclipai/shared";

type DataSourceReference = Pick<DataSource, "id" | "name">;

interface TemporalOverlapReviewPanelProps {
  analysis: TemporalOverlapAnalysis | null | undefined;
  dataSources: DataSourceReference[];
}

function sourceName(sourceId: string, sourcesById: Map<string, string>) {
  return sourcesById.get(sourceId) || `Source ${sourceId}`;
}

export function TemporalOverlapReviewPanel({
  analysis,
  dataSources,
}: TemporalOverlapReviewPanelProps) {
  const sourcesById = new Map(dataSources.map((source) => [source.id, source.name]));

  if (!analysis) {
    return (
      <section className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
        <CalendarRange className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-semibold text-foreground">Temporal overlap has not been analyzed</h2>
        <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
          Run Re-Analyze &amp; Correlate from the collection header to compare recognized date ranges across ready CSV and Excel tables.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="temporal-overlap-heading">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <CalendarRange className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h2 id="temporal-overlap-heading" className="text-base font-semibold text-foreground">
                Candidate periods for review
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {analysis.tablesAnalyzed.toLocaleString()} tables analyzed, {analysis.tablesWithTemporalBounds.toLocaleString()} with recognized date bounds, and {analysis.comparedPairs.toLocaleString()} table pairs compared.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground">
            {analysis.findings.length.toLocaleString()} candidate{analysis.findings.length === 1 ? "" : "s"}
          </span>
        </div>

        {(analysis.status === "limited" || analysis.findingsTruncated) && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              The analysis reached its comparison or result limit. Additional overlaps may exist beyond the candidates shown here.
            </p>
          </div>
        )}

        {analysis.findings.length === 0 && (
          <p className="mt-4 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
            {analysis.status === "complete" && !analysis.findingsTruncated
              ? "No candidate overlaps were found among the tables that were compared."
              : "No candidates were returned. Because this analysis is limited, that does not establish that other tables have no overlap."}
          </p>
        )}
      </div>

      {analysis.findings.map((finding, index) => (
        <article
          key={`${finding.sourceId}:${finding.sourceTableId}:${finding.targetSourceId}:${finding.targetTableId}:${index}`}
          className="rounded-xl border border-border bg-card p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-foreground">
              <AlertCircle className="h-3.5 w-3.5 text-primary" />
              Review required
            </span>
            <span className="text-xs text-muted-foreground">
              {finding.matchedOn === "same_table_name"
                ? "Matched by table name"
                : "Matched by shared entity and metric"}
            </span>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <Link
                to={`/data-sources/${finding.sourceId}`}
                className="text-xs font-medium text-primary hover:underline"
              >
                {sourceName(finding.sourceId, sourcesById)}
              </Link>
              <p className="mt-1 break-words text-sm font-semibold text-foreground">{finding.sourceTable}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Date column: <code className="font-mono text-foreground">{finding.sourceDateColumn}</code>
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <Link
                to={`/data-sources/${finding.targetSourceId}`}
                className="text-xs font-medium text-primary hover:underline"
              >
                {sourceName(finding.targetSourceId, sourcesById)}
              </Link>
              <p className="mt-1 break-words text-sm font-semibold text-foreground">{finding.targetTable}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Date column: <code className="font-mono text-foreground">{finding.targetDateColumn}</code>
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Intersecting date range: <time dateTime={finding.overlapStart}>{finding.overlapStart}</time>
            {" to "}
            <time dateTime={finding.overlapEnd}>{finding.overlapEnd}</time>
          </p>
        </article>
      ))}

      <div className="rounded-lg border border-border bg-muted/50 p-4 text-xs text-muted-foreground">
        These candidates come from matching table or semantic metadata and intersecting date bounds. They are not proof that rows are duplicates, and the collection does not merge or union these tables. Review source meaning and merge policy before combining their totals.
      </div>
    </section>
  );
}
