import { describe, expect, it, vi } from "vitest";
import { dataSourceTables, dataSources } from "@paperclipai/db";
import { validateReadOnlySqlQuery } from "./database-integration.js";
import { aiReasoningService } from "./ai-reasoning.js";
import { DataAgentService } from "./data-agent.js";

describe("DataAgent structured semantic bindings", () => {
  it("executes exact metric plus period and group-by filters on verified physical columns", async () => {
    const source = {
      id: "source-1",
      companyId: "company-1",
      sourceType: "csv",
      status: "ready",
      name: "Site operating costs",
    };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "site_opex",
      rowCount: 120,
      schemaDefinition: [
        { name: "month", dataType: "number", role: "temporal", clickhouseType: "Float64", min: 46_235, max: 46_266 },
        { name: "site_name", dataType: "string", role: "dimension" },
        { name: "maintenance_cost_usd", dataType: "number", role: "metric" },
      ],
      semanticModel: {
        entities: ["operating cost"],
        metrics: [{ name: "Maintenance Cost", aggregation: "sum" }],
        dimensions: [{ name: "Site", column: "site_name", synonyms: ["site location"] }],
      },
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const queryTable = vi.fn(async () => ({
      rows: [{ site_name: "North", sum_maintenance_cost_usd: 1250 }],
      columns: ["site_name", "sum_maintenance_cost_usd"],
      totalRows: 1,
    }));
    (service as any).dataSourcesService.queryTable = queryTable;

    const result = await service.answer(
      "company-1",
      "total maintenance cost per site for August 2026",
      { dataSourceIds: [source.id], tableIds: [table.id], preferredMode: "snapshot" },
    );

    expect(queryTable).toHaveBeenCalledWith(
      "company-1",
      "table-1",
      expect.objectContaining({
        filter: { month: { gte: 46_235, lt: 46_266 } },
        aggregate: { column: "maintenance_cost_usd", fn: "sum", groupBy: "site_name" },
        mode: "snapshot",
      }),
    );
    expect(result.resultsSummary).toContain("site_name");
  });

  it("does not execute an explicitly requested unbound group-by field", async () => {
    const source = { id: "source-1", companyId: "company-1", sourceType: "csv", status: "ready", name: "Costs" };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "site_opex",
      rowCount: 120,
      schemaDefinition: [
        { name: "maintenance_cost_usd", dataType: "number", role: "metric" },
        { name: "site_name", dataType: "string", role: "dimension" },
      ],
      semanticModel: {
        metrics: [{ name: "Maintenance Cost" }],
        dimensions: [{ name: "Site", column: "site_name" }],
      },
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const queryTable = vi.fn();
    (service as any).dataSourcesService.queryTable = queryTable;

    const result = await service.answer(
      "company-1",
      "total maintenance cost for site_opex group by region",
      { dataSourceIds: [source.id], tableIds: [table.id], preferredMode: "snapshot" },
    );

    expect(queryTable).not.toHaveBeenCalled();
    expect(result.resultsSummary).toContain("tidak memiliki binding kolom terverifikasi");
  });

  it("uses the onboarded semantic model for MariaDB distribution queries without entity lookup or SQL generation", async () => {
    const source = { id: "source-1", companyId: "company-1", sourceType: "mariadb", status: "ready", name: "AHU_DB" };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "customer_metrics",
      rowCount: 250_000,
      schemaDefinition: [
        { name: "gross_revenue", dataType: "number", role: "metric" },
        { name: "province_code", dataType: "string", role: "dimension" },
      ],
      semanticModel: {
        entities: ["pelanggan"],
        metrics: [{ name: "Omzet", column: "gross_revenue", aggregation: "sum", synonyms: ["revenue"] }],
        dimensions: [{ name: "Provinsi", column: "province_code", synonyms: ["province"] }],
      },
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const queryTable = vi.fn(async () => ({
      rows: [{ province_code: "DKI", row_count: 42 }],
      columns: ["province_code", "row_count"],
      totalRows: 1,
    }));
    (service as any).dataSourcesService.queryTable = queryTable;
    (service as any).dataSourcesService.querySql = vi.fn();
    const dynamicSql = vi.spyOn(aiReasoningService, "generateDynamicSqlQuery").mockResolvedValue(null);

    try {
      await service.answer("company-1", "Tampilkan sebaran pelanggan berdasarkan provinsi", {
        dataSourceIds: [source.id],
        tableIds: [table.id],
      });

      expect(queryTable).toHaveBeenCalledWith("company-1", table.id, expect.objectContaining({
        aggregate: { column: "*", fn: "count", groupBy: "province_code" },
        mode: "live",
      }));
      expect(dynamicSql).not.toHaveBeenCalled();
      expect((service as any).dataSourcesService.querySql).not.toHaveBeenCalled();
    } finally {
      dynamicSql.mockRestore();
    }
  });

  it("uses mapped metrics and dimensions for a simple MariaDB aggregate instead of waiting on SQL generation", async () => {
    const source = { id: "source-1", companyId: "company-1", sourceType: "mariadb", status: "ready", name: "AHU_DB" };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "company_metrics",
      rowCount: 250_000,
      schemaDefinition: [
        { name: "gross_revenue", dataType: "number", role: "metric" },
        { name: "province_code", dataType: "string", role: "dimension" },
      ],
      semanticModel: {
        metrics: [{ name: "Omzet", column: "gross_revenue", aggregation: "sum", synonyms: ["revenue"] }],
        dimensions: [{ name: "Provinsi", column: "province_code", synonyms: ["province"] }],
      },
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const queryTable = vi.fn(async () => ({
      rows: [{ province_code: "DKI", sum_gross_revenue: 100 }],
      columns: ["province_code", "sum_gross_revenue"],
      totalRows: 1,
    }));
    (service as any).dataSourcesService.queryTable = queryTable;
    (service as any).dataSourcesService.querySql = vi.fn();
    const dynamicSql = vi.spyOn(aiReasoningService, "generateDynamicSqlQuery").mockResolvedValue(null);
    vi.spyOn((service as any).jevService, "systemOne").mockResolvedValue({ answers: {} });

    try {
      await service.answer("company-1", "Total omzet per provinsi", {
        dataSourceIds: [source.id],
        tableIds: [table.id],
      });

      expect(queryTable).toHaveBeenCalledWith("company-1", table.id, expect.objectContaining({
        aggregate: { column: "gross_revenue", fn: "sum", groupBy: "province_code" },
        mode: "live",
      }));
      expect(dynamicSql).not.toHaveBeenCalled();
    } finally {
      dynamicSql.mockRestore();
    }
  });

  it("probes indexed entity columns in one bounded parameterized MariaDB query", async () => {
    const source = { id: "source-1", companyId: "company-1", sourceType: "mariadb", status: "ready", name: "AHU_DB" };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "master_perusahaan",
      rowCount: 250_000,
      schemaDefinition: [
        { name: "id", dataType: "integer", role: "identifier", isPrimaryKey: true },
        { name: "nama_perusahaan", dataType: "string", role: "identifier", isSearchable: true },
        { name: "status", dataType: "string", role: "dimension" },
      ],
      semanticModel: {
        sourceSchema: "ahu",
        tableRole: "dimension_table",
        entities: ["perusahaan"],
        indexes: [{ name: "idx_nama_perusahaan", columns: ["nama_perusahaan"], isUnique: false }],
      },
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const querySql = vi.fn(async () => ({
      rows: [{ id: 42, nama_perusahaan: "PT Alpha", status: "aktif" }],
      columns: ["id", "nama_perusahaan", "status"],
      rowCount: 1,
      executionTimeMs: 8,
      sql: "SELECT ...",
    }));
    (service as any).dataSourcesService.querySql = querySql;

    await service.answer("company-1", "Profil perusahaan PT Alpha", {
      dataSourceIds: [source.id],
      tableIds: [table.id],
    });

    expect(querySql).toHaveBeenCalledTimes(1);
    const [queryCall] = querySql.mock.calls as any[];
    expect(queryCall[2]).toContain("ORDER BY CASE WHEN");
    expect(queryCall[2]).toContain("`ahu`.`master_perusahaan`");
    expect(queryCall[2]).not.toContain("PT Alpha");
    expect(validateReadOnlySqlQuery(queryCall[2], "mysql")).toContain("ORDER BY CASE WHEN");
    expect(queryCall[5]).toMatchObject({
      params: expect.arrayContaining(["PT Alpha", "ALPHA", "PT ALPHA"]),
      statementTimeoutMs: 3_000,
    });
  });

  it("does not repeat SQL generation when the model returns no query", async () => {
    const source = { id: "source-1", companyId: "company-1", sourceType: "mariadb", status: "ready", name: "Sales DB" };
    const table = {
      id: "table-1",
      companyId: "company-1",
      dataSourceId: source.id,
      tableName: "sales_records",
      rowCount: 100,
      schemaDefinition: [
        { name: "region", dataType: "string" },
        { name: "sales_amount", dataType: "number" },
      ],
      semanticModel: {},
    };
    const rows = (value: unknown[]) => {
      const promise = Promise.resolve(value);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const db: any = {
      select: () => ({
        from: (tableRef: unknown) => rows(tableRef === dataSources ? [source] : tableRef === dataSourceTables ? [table] : []),
      }),
    };
    const service = new DataAgentService(db);
    const dynamicSql = vi.spyOn(aiReasoningService, "generateDynamicSqlQuery").mockResolvedValue(null);

    try {
      await service.answer("company-1", "sum sales by region", {
        dataSourceIds: [source.id],
        tableIds: [table.id],
      });

      expect(dynamicSql).toHaveBeenCalledTimes(1);
    } finally {
      dynamicSql.mockRestore();
    }
  });
});
