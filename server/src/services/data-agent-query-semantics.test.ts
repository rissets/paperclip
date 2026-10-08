import { describe, expect, it, vi } from "vitest";
import { dataSourceTables, dataSources } from "@paperclipai/db";
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
});
