import { describe, expect, it, vi } from "vitest";
import { DatabaseIntegrationService } from "../services/database-integration.js";

describe("bounded external datasource observations", () => {
  const config = {
    type: "postgres" as const,
    host: "db.example.test",
    port: 5432,
    database: "analytics",
    username: "readonly",
    password: "test-only",
    allowedSchemas: ["public"],
    allowedTables: ["orders"],
  };

  it("builds an identifier-quoted SELECT with fixed row and statement limits", async () => {
    const service = new DatabaseIntegrationService();
    const query = vi.spyOn(service, "queryDatabase").mockResolvedValue({
      columns: ["status"],
      rows: [{ status: "paid" }, { status: "cancelled" }],
      rowCount: 2,
      executionTimeMs: 7,
      sql: "SELECT status FROM orders LIMIT 8",
    });
    const controller = new AbortController();

    const result = await service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["status"],
      signal: controller.signal,
    });

    expect(query).toHaveBeenCalledWith(
      config,
      'SELECT "status" FROM "public"."orders" LIMIT 8',
      8,
      [],
      controller.signal,
      { statementTimeoutMs: 5_000 },
    );
    expect(result).toEqual({
      valuesByColumn: { status: ["paid", "cancelled"] },
      rowCount: 2,
      executionTimeMs: 7,
    });
  });

  it("rejects tables outside the source allowlist before querying", async () => {
    const service = new DatabaseIntegrationService();
    const query = vi.spyOn(service, "queryDatabase");

    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "payroll",
      columns: ["status"],
    })).rejects.toThrow("outside the configured table allowlist");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects sensitive, duplicate, or excessive column requests before querying", async () => {
    const service = new DatabaseIntegrationService();
    const query = vi.spyOn(service, "queryDatabase");

    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["customer_email"],
    })).rejects.toThrow("Sensitive columns");
    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["nama_pelanggan"],
    })).rejects.toThrow("Sensitive columns");
    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["nik"],
    })).rejects.toThrow("Sensitive columns");
    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["status", "status"],
    })).rejects.toThrow("identities are invalid");
    await expect(service.observeExternalTableColumns(config, {
      schemaName: "public",
      tableName: "orders",
      columns: ["a", "b", "c", "d", "e"],
    })).rejects.toThrow("between one and four columns");
    expect(query).not.toHaveBeenCalled();
  });
});
