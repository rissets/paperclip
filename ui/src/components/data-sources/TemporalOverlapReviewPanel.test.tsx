import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { TemporalOverlapAnalysis } from "@paperclipai/shared";
import { TemporalOverlapReviewPanel } from "./TemporalOverlapReviewPanel";

const sources = [
  { id: "source-a", name: "North Region CSV" },
  { id: "source-b", name: "South Region Excel" },
];

function renderPanel(analysis: TemporalOverlapAnalysis | null | undefined) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TemporalOverlapReviewPanel analysis={analysis} dataSources={sources} />
    </MemoryRouter>,
  );
}

describe("TemporalOverlapReviewPanel", () => {
  it("asks the operator to run correlation when no analysis exists", () => {
    const html = renderPanel(undefined);

    expect(html).toContain("Temporal overlap has not been analyzed");
    expect(html).toContain("Re-Analyze &amp; Correlate");
  });

  it("warns that a limited analysis with no findings does not prove no overlap", () => {
    const html = renderPanel({
      status: "limited",
      tablesAnalyzed: 500,
      tablesWithTemporalBounds: 120,
      comparedPairs: 250,
      findingsTruncated: false,
      findings: [],
    });

    expect(html).toContain("Additional overlaps may exist");
    expect(html).toContain("does not establish that other tables have no overlap");
  });

  it("shows both sources, date columns, range, and the review-only caveat", () => {
    const html = renderPanel({
      status: "complete",
      tablesAnalyzed: 2,
      tablesWithTemporalBounds: 2,
      comparedPairs: 1,
      findingsTruncated: false,
      findings: [
        {
          sourceTableId: "table-a",
          sourceId: "source-a",
          sourceTable: "daily_network_kpi",
          targetTableId: "table-b",
          targetSourceId: "source-b",
          targetTable: "daily_network_kpi",
          sourceDateColumn: "event_date",
          targetDateColumn: "date",
          overlapStart: "2026-01-01",
          overlapEnd: "2026-01-31",
          matchedOn: "same_table_name",
          reviewRequired: true,
        },
      ],
    });

    expect(html).toContain("North Region CSV");
    expect(html).toContain("South Region Excel");
    expect(html).toContain('href="/data-sources/source-a"');
    expect(html).toContain("event_date");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("Review required");
    expect(html).toContain("not proof that rows are duplicates");
    expect(html).toContain("does not merge or union these tables");
  });
});
