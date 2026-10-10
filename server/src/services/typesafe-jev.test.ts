import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeSafeJevService } from "./typesafe-jev.js";

describe("TypeSafe JEV PostgreSQL schema identities", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps duplicate table names isolated and emits PostgreSQL-qualified SQL", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const jev = new TypeSafeJevService({ apiKey: "" });
    const result = await jev.evaluateDatabaseTables([
      { name: "tenant_a.orders", tableName: "orders", schemaName: "tenant_a", columns: ["id", "customer_id", "name", "metadata"], rowCount: 120 },
      { name: "tenant_a.customers", tableName: "customers", schemaName: "tenant_a", columns: ["id", "name"], rowCount: 30 },
      { name: "tenant_b.orders", tableName: "orders", schemaName: "tenant_b", columns: ["id", "customer_id", "name"], rowCount: 80 },
      { name: "tenant_b.customers", tableName: "customers", schemaName: "tenant_b", columns: ["id", "name"], rowCount: 20 },
    ], { databaseType: "postgres" });

    expect(result.tableProfiles).toHaveProperty("tenant_a.orders");
    expect(result.tableProfiles).toHaveProperty("tenant_b.orders");
    expect(result.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceTable: "orders",
        sourceSchema: "tenant_a",
        targetTable: "customers",
        targetSchema: "tenant_a",
      }),
      expect.objectContaining({
        sourceTable: "orders",
        sourceSchema: "tenant_b",
        targetTable: "customers",
        targetSchema: "tenant_b",
      }),
    ]));
    expect(result.tableProfiles["tenant_a.orders"]?.relationships).toHaveLength(1);
    expect(result.tableProfiles["tenant_a.orders"]?.relationships?.[0]?.targetSchema).toBe("tenant_a");
    expect(result.crossTableClusters).toHaveLength(2);
    expect(result.crossTableClusters[0]?.tables).not.toContain("tenant_b.orders");

    const snippets = result.suggestedQueries.map((query) => query.sqlSnippet || "");
    expect(snippets.some((query) => query.includes('FROM "tenant_a"."orders"'))).toBe(true);
    expect(snippets.every((query) => !query.includes("`"))).toBe(true);
  });
});
