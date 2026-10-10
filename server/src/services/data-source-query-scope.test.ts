import { describe, expect, it } from "vitest";
import { resolveQueryTableScope } from "./data-source-query-scope.js";

const tables = [
  { id: "file-table", dataSourceId: "file-source", tableName: "26_site_opex_cost" },
  { id: "external-table", dataSourceId: "db-source", tableName: "tbl_payments" },
];

describe("resolveQueryTableScope", () => {
  it("binds a generic Pi table placeholder to one exact authorized semantic match", () => {
    const result = resolveQueryTableScope({
      query: "sum maintenance_cost_usd for August 2026",
      requestedReferences: ["table"],
      allowedTables: tables,
      rankedTables: [{ id: "file-table", relevanceScore: 1 }],
      exactMatchFound: true,
    });

    expect(result.tables?.map((table) => table.id)).toEqual(["file-table"]);
    expect(result.referencedTables).toEqual(["26_site_opex_cost"]);
    expect(result.needsClarification).toBe(false);
  });

  it("does not guess when the generic placeholder has multiple exact matches", () => {
    const result = resolveQueryTableScope({
      query: "sum revenue",
      requestedReferences: ["table"],
      allowedTables: tables,
      rankedTables: [
        { id: "file-table", relevanceScore: 1 },
        { id: "external-table", relevanceScore: 1 },
      ],
      exactMatchFound: true,
    });

    expect(result.tables).toBeNull();
    expect(result.unresolvedReferences).toEqual(["table"]);
    expect(result.needsClarification).toBe(true);
  });

  it("keeps explicit unknown names unresolved instead of mapping them to another allowed table", () => {
    const result = resolveQueryTableScope({
      query: "sum maintenance_cost_usd",
      requestedReferences: ["customer_secret_table"],
      allowedTables: tables,
      rankedTables: [{ id: "file-table", relevanceScore: 1 }],
      exactMatchFound: true,
    });

    expect(result.tables).toBeNull();
    expect(result.unresolvedReferences).toEqual(["customer_secret_table"]);
  });

  it("selects a high-confidence unique candidate when there is no explicit table", () => {
    const result = resolveQueryTableScope({
      query: "total maintenance cost",
      requestedReferences: [],
      allowedTables: tables,
      rankedTables: [
        { id: "file-table", relevanceScore: 0.91 },
        { id: "external-table", relevanceScore: 0.4 },
      ],
    });

    expect(result.tables?.map((table) => table.id)).toEqual(["file-table"]);
  });

  it("uses a uniquely named table mentioned in the natural-language query", () => {
    const result = resolveQueryTableScope({
      query: "Use only table 26_site_opex_cost and sum maintenance cost",
      requestedReferences: [],
      allowedTables: tables,
      rankedTables: [{ id: "external-table", relevanceScore: 1 }],
      exactMatchFound: true,
    });

    expect(result.tables?.map((table) => table.id)).toEqual(["file-table"]);
    expect(result.referencedTables).toEqual(["26_site_opex_cost"]);
    expect(result.needsClarification).toBe(false);
  });

  it("requires clarification when a natural-language table name exists in multiple sources", () => {
    const duplicateTables = [
      { id: "source-a-table", dataSourceId: "source-a", tableName: "incident_stats" },
      { id: "source-b-table", dataSourceId: "source-b", tableName: "incident_stats" },
    ];
    const result = resolveQueryTableScope({
      query: "Count incidents in incident_stats",
      requestedReferences: [],
      allowedTables: duplicateTables,
      rankedTables: [{ id: "source-a-table", relevanceScore: 1 }],
      exactMatchFound: true,
    });

    expect(result.tables).toBeNull();
    expect(result.unresolvedReferences).toEqual(["incident_stats"]);
    expect(result.needsClarification).toBe(true);
  });

  it("resolves a schema-qualified PostgreSQL table without crossing to a same-named schema", () => {
    const duplicateTables = [
      { id: "geo-table", dataSourceId: "source-a", tableName: "provinsi", semanticModel: { sourceSchema: "geo" } },
      { id: "legacy-table", dataSourceId: "source-b", tableName: "provinsi", semanticModel: { sourceSchema: "legacy" } },
    ];
    const result = resolveQueryTableScope({
      query: 'SELECT * FROM "geo"."provinsi" LIMIT 10',
      requestedReferences: ["geo.provinsi"],
      allowedTables: duplicateTables,
    });

    expect(result.tables?.map((table) => table.id)).toEqual(["geo-table"]);
    expect(result.referencedTables).toEqual(["geo.provinsi"]);
    expect(result.needsClarification).toBe(false);
  });

  it("requires a schema when an explicit PostgreSQL table name is duplicated", () => {
    const duplicateTables = [
      { id: "geo-table", dataSourceId: "source-a", tableName: "provinsi", semanticModel: { sourceSchema: "geo" } },
      { id: "legacy-table", dataSourceId: "source-b", tableName: "provinsi", semanticModel: { sourceSchema: "legacy" } },
    ];
    const result = resolveQueryTableScope({
      query: "Read provinsi",
      requestedReferences: ["provinsi"],
      allowedTables: duplicateTables,
    });

    expect(result.tables).toBeNull();
    expect(result.unresolvedReferences).toEqual(["provinsi"]);
    expect(result.needsClarification).toBe(true);
  });
});
