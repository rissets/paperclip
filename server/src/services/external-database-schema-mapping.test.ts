import { describe, expect, it, vi } from "vitest";
import type { AiDatabaseAnalysisResult } from "./ai-reasoning.js";
import {
  analyzeExternalDatabaseSchemaGroup,
  analyzeExternalDatabaseSchemaBatch,
  groupExternalDatabaseSchemaTables,
  mergeExternalDatabaseMappingResults,
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
  it("groups bounded column batches across tables without putting a table into one request twice", () => {
    const groupA: ExternalDatabaseSchemaTable = {
      tableName: "core.entity_application",
      rowCount: 100,
      columns: Array.from({ length: 20 }, (_, index) => ({ name: `a${index}`, dataType: "text" })),
    };
    const groupB: ExternalDatabaseSchemaTable = {
      tableName: "core.deed",
      rowCount: 20,
      columns: Array.from({ length: 20 }, (_, index) => ({ name: `b${index}`, dataType: "text" })),
    };
    const secondBatchForA: ExternalDatabaseSchemaTable = {
      ...groupA,
      columns: Array.from({ length: 12 }, (_, index) => ({ name: `a${index + 20}`, dataType: "text" })),
    };

    const groups = groupExternalDatabaseSchemaTables([groupA, groupB, secondBatchForA], {
      maxTables: 4,
      maxColumns: 40,
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.map((table) => table.tableName))).toEqual([
      ["core.entity_application", "core.deed"],
      ["core.entity_application"],
    ]);
    expect(groups.every((group) => group.reduce((total, table) => total + table.columns.length, 0) <= 40)).toBe(true);
  });

  it("reduces a 49-table, 512-column schema to fourteen bounded requests", () => {
    const tables: ExternalDatabaseSchemaTable[] = Array.from({ length: 49 }, (_, tableIndex) => {
      const columnCount = tableIndex === 48 ? 32 : 10;
      const columns = Array.from({ length: columnCount }, (_, columnIndex) => ({ name: `column_${columnIndex}`, dataType: "text" }));
      return {
        tableName: `core.table_${tableIndex}`,
        rowCount: tableIndex * 100,
        columns,
      };
    }).flatMap((table) => {
      const units: ExternalDatabaseSchemaTable[] = [];
      for (let offset = 0; offset < table.columns.length; offset += 20) {
        units.push({ ...table, columns: table.columns.slice(offset, offset + 20) });
      }
      return units;
    });

    const groups = groupExternalDatabaseSchemaTables(tables);

    expect(tables.reduce((total, table) => total + table.columns.length, 0)).toBe(512);
    expect(groups).toHaveLength(14);
    expect(groups.flat()).toHaveLength(50);
    expect(groups.every((group) => group.length <= 4)).toBe(true);
    expect(groups.every((group) => group.reduce((total, table) => total + table.columns.length, 0) <= 60)).toBe(true);
  });

  it("maps multiple schema-qualified tables in one request and observes only the requested table", async () => {
    const tables: ExternalDatabaseSchemaTable[] = [
      { tableName: "core.parent", rowCount: 3, columns: [{ name: "id", dataType: "integer" }] },
      { tableName: "core.child", rowCount: 10, columns: [{ name: "parent_id", dataType: "integer", isForeign: true }] },
    ];
    const initial = analysis(result({
      tableRoles: { "core.parent": "dimension_table", "core.child": "fact_table" },
      observationRequests: [{ ...request, tableName: "core.child", columnName: "parent_id" }],
    }));
    const final = analysis(result({
      tableRoles: { "core.parent": "dimension_table", "core.child": "fact_table" },
      observationRequests: [],
    }), "validated", "router_http");
    const analyze = vi.fn<AnalyzeExternalDatabaseSchema>().mockResolvedValueOnce(initial).mockResolvedValueOnce(final);
    const observe = vi.fn().mockResolvedValue({
      valuesByColumn: { parent_id: [1, 2] },
      rowCount: 2,
      executionTimeMs: 5,
    });

    const mapped = await analyzeExternalDatabaseSchemaGroup({
      databaseType: "postgres",
      databaseName: "registry",
      tables,
      options: { agentName: "Database Ingestion Agent" },
      analyze,
      observe,
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[0]?.[2].map((item) => item.tableName)).toEqual(["core.parent", "core.child"]);
    expect(analyze.mock.calls[0]?.[3]).toMatchObject({ allowDatabaseObservations: true });
    expect(analyze.mock.calls[1]?.[2][0]?.columns[0]?.observedValues).toBeUndefined();
    expect(analyze.mock.calls[1]?.[2][1]?.columns[0]?.observedValues).toEqual([1, 2]);
    expect(observe).toHaveBeenCalledWith("core.child", ["parent_id"]);
    expect(mapped.result?.observationRequests).toEqual([]);
  });

  it("merges deterministic JEV coverage into tables whose AI mapping is missing", () => {
    const ai = result({
      domain: "Indonesian company registry",
      entities: ["legal entity"],
      primaryTopics: ["entity lifecycle"],
      tableRoles: { "core.entity": "dimension_table" },
      tableProfiles: {
        "core.entity": {
          tableName: "core.entity",
          tableRole: "dimension_table",
          context: "AI mapped the legal entity table.",
          topics: ["entity lifecycle"],
          entities: ["legal entity"],
          decisionSpecRefs: [],
          relationships: [],
        } as any,
      },
    });
    const jev = result({
      domain: "registry tables",
      entities: ["core.entity", "core.deed"],
      primaryTopics: ["registry lookup"],
      tableRoles: { "core.entity": "lookup_table", "core.deed": "fact_table" },
      tableProfiles: {
        "core.entity": {
          tableName: "core.entity",
          tableRole: "lookup_table",
          context: "JEV entity profile.",
          topics: ["registry lookup"],
          entities: ["core.entity"],
          decisionSpecRefs: ["db.table_role.v1"],
          relationships: [],
        } as any,
        "core.deed": {
          tableName: "core.deed",
          tableRole: "fact_table",
          context: "JEV deed profile.",
          topics: ["deed records"],
          entities: ["core.deed"],
          decisionSpecRefs: ["db.table_role.v1"],
          relationships: [],
        } as any,
      },
    });

    const merged = mergeExternalDatabaseMappingResults(ai, jev);

    expect(merged.domain).toBe("Indonesian company registry");
    expect(merged.tableRoles).toEqual({ "core.entity": "dimension_table", "core.deed": "fact_table" });
    expect(merged.entities).toEqual(["legal entity", "core.entity", "core.deed"]);
    expect(merged.tableProfiles?.["core.entity"]?.context).toContain("AI mapped");
    expect(merged.tableProfiles?.["core.entity"]?.context).toContain("JEV entity");
    expect(merged.tableProfiles?.["core.deed"]?.context).toBe("JEV deed profile.");
  });

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
