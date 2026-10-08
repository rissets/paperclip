import { describe, expect, it } from "vitest";
import { analyzeTemporalOverlaps, type TemporalOverlapTableInput } from "./data-source-temporal-overlap.js";

function source(input: Partial<TemporalOverlapTableInput> & Pick<TemporalOverlapTableInput, "tableId" | "sourceId" | "tableName">): TemporalOverlapTableInput {
  return {
    sourceType: "csv",
    sourceStatus: "ready",
    semanticModel: {
      qualityCounters: {
        temporalBoundsByColumn: {
          event_date: { minDate: "2026-01-01T00:00:00.000Z", maxDate: "2026-01-31T00:00:00.000Z" },
        },
      },
      entities: ["network events"],
      metrics: [{ name: "traffic volume" }],
    },
    ...input,
  };
}

describe("analyzeTemporalOverlaps", () => {
  it("flags overlapping windows for equivalent tables as review candidates", () => {
    const analysis = analyzeTemporalOverlaps([
      source({ tableId: "table-a", sourceId: "source-a", tableName: "hourly_kpi" }),
      source({
        tableId: "table-b",
        sourceId: "source-b",
        tableName: "hourly-kpi",
        semanticModel: {
          qualityCounters: {
            temporalBoundsByColumn: {
              event_date: { minDate: "2026-01-15T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
            },
          },
          entities: ["network events"],
          metrics: [{ name: "traffic volume" }],
          secretSampleValues: ["must not be copied into the finding"],
        },
      }),
    ]);

    expect(analysis).toMatchObject({ status: "complete", comparedPairs: 1, findingsTruncated: false });
    expect(analysis.findings).toEqual([expect.objectContaining({
      sourceTableId: "table-a",
      targetTableId: "table-b",
      sourceDateColumn: "event_date",
      targetDateColumn: "event_date",
      overlapStart: "2026-01-15T00:00:00.000Z",
      overlapEnd: "2026-01-31T00:00:00.000Z",
      matchedOn: "same_table_name",
      reviewRequired: true,
    })]);
    expect(JSON.stringify(analysis)).not.toContain("must not be copied");
  });

  it("requires shared entities and metrics when table names differ", () => {
    const left = source({ tableId: "table-a", sourceId: "source-a", tableName: "hourly_kpi" });
    const right = source({
      tableId: "table-b",
      sourceId: "source-b",
      tableName: "ran_performance",
      semanticModel: {
        qualityCounters: {
          temporalBoundsByColumn: {
            event_date: { minDate: "2026-01-15T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
          },
        },
        entities: ["network events"],
        metrics: [{ name: "traffic volume" }],
      },
    });
    expect(analyzeTemporalOverlaps([left, right]).findings[0]?.matchedOn).toBe("shared_entity_and_metric");

    const unrelated = source({
      tableId: "table-c",
      sourceId: "source-c",
      tableName: "subscriber_profile",
      semanticModel: {
        qualityCounters: {
          temporalBoundsByColumn: {
            event_date: { minDate: "2026-01-15T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
          },
        },
        entities: ["subscribers"],
        metrics: [{ name: "subscriber count" }],
      },
    });
    expect(analyzeTemporalOverlaps([left, unrelated]).findings).toHaveLength(0);
  });

  it("does not compare different physical date columns or disjoint periods", () => {
    const left = source({ tableId: "table-a", sourceId: "source-a", tableName: "hourly_kpi" });
    const differentColumn = source({
      tableId: "table-b",
      sourceId: "source-b",
      tableName: "hourly_kpi",
      semanticModel: {
        qualityCounters: {
          temporalBoundsByColumn: {
            report_date: { minDate: "2026-01-15T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
          },
        },
      },
    });
    const disjoint = source({
      tableId: "table-c",
      sourceId: "source-c",
      tableName: "hourly_kpi",
      semanticModel: {
        qualityCounters: {
          temporalBoundsByColumn: {
            event_date: { minDate: "2026-02-01T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
          },
        },
      },
    });
    expect(analyzeTemporalOverlaps([left, differentColumn, disjoint]).findings).toHaveLength(0);
  });

  it("marks truncated analysis and legacy unqualified bounds as limited", () => {
    const legacy = source({
      tableId: "table-a",
      sourceId: "source-a",
      tableName: "hourly_kpi",
      semanticModel: { qualityCounters: { temporalBounds: { minDate: "2026-01-01", maxDate: "2026-02-01" } } },
    });
    expect(analyzeTemporalOverlaps([legacy]).status).toBe("limited");
    expect(analyzeTemporalOverlaps([], { tablesTruncated: true }).status).toBe("limited");
  });
});
