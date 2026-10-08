import { describe, expect, it, vi } from "vitest";
import type { AiDatabaseAnalysisResult } from "./ai-reasoning.js";
import {
  analyzeExternalDatabaseSchemaBatch,
  type AnalyzeExternalDatabaseSchema,
  type ExternalDatabaseSchemaAnalysis,
  type ExternalDatabaseSchemaTable,
} from "./external-database-schema-mapping.js";

const request = {
  tableName: "public.orders",
  columnName: "status",
  method: "sample_values" as const,
  reason: "Observed sample vocabulary resolves the ambiguous status field.",
};

function result(overrides: Partial<AiDatabaseAnalysisResult> = {}): AiDatabaseAnalysisResult {
  return {
    domain: "sales",
    entities: ["order"],
    primaryTopics: ["fulfillment"],
    tableRoles: { "public.orders": "fact_table" },
    relationships: [],
    suggestedQueries: [],
    reasoningSummary: "Orders contain sales activity.",
    ...overrides,
  };
}

function analysis(
  semantic: AiDatabaseAnalysisResult,
  validationStatus: ExternalDatabaseSchemaAnalysis["validationStatus"] = "validated",
  backend: ExternalDatabaseSchemaAnalysis["backend"] = "pi_cli",
  thought = "Mapped the inspected table.",
): ExternalDatabaseSchemaAnalysis {
  return {
    result: semantic,
    iterations: 1,
    backend,
    reasoningSteps: [{ stage: 1, name: "table_mapping", agent: "Database Ingestion Agent", thought, backend }],
    validationStatus,
  };
}

const table: ExternalDatabaseSchemaTable = {
  tableName: "public.orders",
  rowCount: 12,
  columns: [
    { name: "status", dataType: "string", role: "dimension", sampleValues: ["active"] },
    { name: "order_id", dataType: "number", isPrimary: true, role: "identifier" },
  ],
};

describe("external database schema mapping observation cycle", () => {
  it("observes only a validated request, then makes one final inference with those values", async () => {
    const initial = analysis(result({ observationRequests: [request] }), "validated", "pi_cli", "Needs status evidence.");
    const final = analysis(result({ observationRequests: [] }), "validated", "router_http", "Status evidence confirms the mapping.");
    const analyze = vi.fn<AnalyzeExternalDatabaseSchema>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(final);
    const observe = vi.fn().mockResolvedValue({
      valuesByColumn: { status: ["active", "closed"] },
      rowCount: 2,
      executionTimeMs: 4,
    });
    const progress: string[] = [];

    const mapped = await analyzeExternalDatabaseSchemaBatch({
      databaseType: "postgres",
      databaseName: "warehouse",
      table,
      options: { agentName: "Database Ingestion Agent", signal: new AbortController().signal },
      analyze,
      observe,
      onObservationRequested: (requests) => { progress.push(`requested:${requests.length}`); },
      onObservationCompleted: (requests, sampled) => { progress.push(`completed:${requests.length}:${sampled.rowCount}`); },
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[0]?.[3]).toMatchObject({ allowDatabaseObservations: true });
    expect(analyze.mock.calls[1]?.[3]).toMatchObject({
      allowDatabaseObservations: false,
      databaseObservationFollowup: true,
    });
    expect(analyze.mock.calls[1]?.[2][0]?.columns[0]?.observedValues).toEqual(["active", "closed"]);
    expect(analyze.mock.calls[1]?.[2][0]?.columns[1]?.observedValues).toEqual([]);
    expect(observe).toHaveBeenCalledWith(["status"]);
    expect(progress).toEqual(["requested:1", "completed:1:2"]);
    expect(mapped.reasoningSteps.map((step) => step.thought)).toEqual([
      "Needs status evidence.",
      "Status evidence confirms the mapping.",
    ]);
    expect(mapped.backend).toBe("router_http");
    expect(mapped.iterations).toBe(2);
    expect(mapped.result?.observationRequests).toEqual([]);
  });

  it("does not observe requests from invalid or best-effort model output", async () => {
    const bestEffort = analysis(result({ observationRequests: [request] }), "best_effort");
    const analyze = vi.fn<AnalyzeExternalDatabaseSchema>().mockResolvedValue(bestEffort);
    const observe = vi.fn();

    const mapped = await analyzeExternalDatabaseSchemaBatch({
      databaseType: "postgres",
      databaseName: "warehouse",
      table,
      options: {},
      analyze,
      observe,
    });

    expect(mapped).toBe(bestEffort);
    expect(analyze).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not add a follow-up request when a validated mapping needs no observation", async () => {
    const initial = analysis(result({ observationRequests: [] }));
    const analyze = vi.fn<AnalyzeExternalDatabaseSchema>().mockResolvedValue(initial);
    const observe = vi.fn();

    await analyzeExternalDatabaseSchemaBatch({
      databaseType: "postgres",
      databaseName: "warehouse",
      table,
      options: {},
      analyze,
      observe,
    });

    expect(analyze).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not run the final mapping if the bounded source observation fails", async () => {
    const initial = analysis(result({ observationRequests: [request] }));
    const analyze = vi.fn<AnalyzeExternalDatabaseSchema>().mockResolvedValue(initial);
    const observe = vi.fn().mockRejectedValue(new Error("source statement timed out"));

    await expect(analyzeExternalDatabaseSchemaBatch({
      databaseType: "postgres",
      databaseName: "warehouse",
      table,
      options: {},
      analyze,
      observe,
    })).rejects.toThrow("source statement timed out");

    expect(analyze).toHaveBeenCalledOnce();
  });
});
