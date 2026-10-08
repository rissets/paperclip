import { describe, expect, it, vi } from "vitest";
import {
  DataSourcesService,
  clickhouseAggregateColumnExpression,
  compileStructuredFilters,
  isCountAllAggregate,
  structuredAggregateAlias,
  structuredAggregateSqlExpression,
  shouldApplyClickhouseFinalDeduplication,
  validateStructuredAggregationColumn,
} from "../services/data-sources.js";
import { buildClickhouseTableAliasMap, rewriteClickhouseTableReferences } from "../services/clickhouse.js";

describe("structured datasource query shaping", () => {
  it("adds ClickHouse FINAL only for tables configured for replacing-engine deduplication", () => {
    expect(shouldApplyClickhouseFinalDeduplication({ clickhouseSchema: { engine: "MergeTree" } })).toBe(false);
    expect(shouldApplyClickhouseFinalDeduplication({ externalSnapshot: { engine: "merge_delta_v1" } })).toBe(false);
    expect(shouldApplyClickhouseFinalDeduplication({ clickhouseSchema: { engine: "ReplacingMergeTree" } })).toBe(true);
    expect(shouldApplyClickhouseFinalDeduplication({ clickhouseSchema: { deduplicationStrategy: "final" } })).toBe(true);
    expect(shouldApplyClickhouseFinalDeduplication({ useDeduplication: true })).toBe(true);
  });

  it("allows min/max on timestamp columns while keeping sum/avg numeric-only", () => {
    const timestamp = { name: "timestamp", dataType: "string", role: "timestamp" };

    expect(() => validateStructuredAggregationColumn(timestamp, "min")).not.toThrow();
    expect(() => validateStructuredAggregationColumn(timestamp, "max")).not.toThrow();
    expect(() => validateStructuredAggregationColumn({ name: "timestamp", dataType: "string" }, "min")).not.toThrow();
    expect(() => validateStructuredAggregationColumn(timestamp, "sum")).toThrow("sum requires a numeric column");
    expect(() => validateStructuredAggregationColumn(timestamp, "avg")).toThrow("avg requires a numeric column");
    expect(() => validateStructuredAggregationColumn({ name: "label", dataType: "string" }, "min"))
      .toThrow("min requires a numeric or date/time column");
  });

  it("parses string timestamps for ClickHouse min/max and keeps native date columns unchanged", () => {
    expect(clickhouseAggregateColumnExpression({ name: "timestamp", dataType: "string", role: "timestamp" }, "min"))
      .toBe("parseDateTimeBestEffortOrNull(`timestamp`)");
    expect(clickhouseAggregateColumnExpression({ name: "created_at", dataType: "date", clickhouseType: "Nullable(DateTime64(3))" }, "max"))
      .toBe("`created_at`");
    expect(clickhouseAggregateColumnExpression({ name: "timestamp", dataType: "number", clickhouseType: "UInt64" }, "min"))
      .toBe("`timestamp`");
    expect(clickhouseAggregateColumnExpression({ name: "timestamp", dataType: "string" }, "min"))
      .toBe("parseDateTimeBestEffortOrNull(`timestamp`)");
    expect(clickhouseAggregateColumnExpression({ name: "amount", dataType: "number" }, "max"))
      .toBe("`amount`");
  });

  it("supports count-all aggregates with safe, dialect-specific SQL and aliases", () => {
    expect(isCountAllAggregate("count", "*")).toBe(true);
    expect(isCountAllAggregate("sum", "*")).toBe(false);
    expect(structuredAggregateAlias("count", "*")).toBe("count_all");
    expect(structuredAggregateSqlExpression("count", "*", true, "ansi")).toBe("COUNT(*)");
    expect(structuredAggregateSqlExpression("count", "*", true, "clickhouse")).toBe("count()");
    expect(structuredAggregateSqlExpression("count", '"domain"', false, "ansi")).toBe('COUNT("domain")');
    expect(structuredAggregateSqlExpression("sum", '"amount"', false, "ansi")).toBe('SUM("amount")');
    expect(() => structuredAggregateSqlExpression("sum", "*", true, "ansi"))
      .toThrow("COUNT(*) requires the count aggregation function");
  });

  it("compiles bounded temporal ranges with typed, parameterized filters", () => {
    const result = compileStructuredFilters(
      { month: { gte: 46_235, lt: 46_266 } },
      [{ name: "month", dataType: "number", role: "temporal", clickhouseType: "Float64" }],
      "clickhouse",
    );

    expect(result.whereSql).toBe(" WHERE `month` >= {ds_filter_0:Int64} AND `month` < {ds_filter_1:Int64}");
    expect(result.clickhouseParams).toEqual({
      ds_filter_0: { type: "Int64", value: 46_235 },
      ds_filter_1: { type: "Int64", value: 46_266 },
    });
  });

  it("binds the same temporal range for external PostgreSQL without interpolating values", () => {
    const result = compileStructuredFilters(
      { created_at: { gte: "2026-08-01T00:00:00.000Z", lt: "2026-09-01T00:00:00.000Z" } },
      [{ name: "created_at", dataType: "timestamp", role: "temporal" }],
      "postgres",
    );

    expect(result.whereSql).toBe(' WHERE "created_at" >= $1 AND "created_at" < $2');
    expect(result.values).toEqual(["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
  });

  it("rewrites assigned legacy and logical table names without touching literals or comments", () => {
    const aliases = new Map([
      ["03_ran_kpi_hourly_2months", "ds_actual_03_ran_kpi_hourly"],
      ["ds_03_ran_kpi_hourly_2months", "ds_actual_03_ran_kpi_hourly"],
      ["ds_actual_03_ran_kpi_hourly", "ds_actual_03_ran_kpi_hourly"],
    ]);
    const query = "-- FROM ds_03_ran_kpi_hourly_2months\n"
      + "SELECT 'FROM 03_ran_kpi_hourly_2months' AS note FROM `ds_03_ran_kpi_hourly_2months` AS k "
      + "JOIN 03_ran_kpi_hourly_2months AS other ON k.id = other.id /* JOIN 03_ran_kpi_hourly_2months */";

    expect(rewriteClickhouseTableReferences(query, aliases)).toBe(
      "-- FROM ds_03_ran_kpi_hourly_2months\n"
      + "SELECT 'FROM 03_ran_kpi_hourly_2months' AS note FROM `ds_actual_03_ran_kpi_hourly` AS k "
      + "JOIN `ds_actual_03_ran_kpi_hourly` AS other ON k.id = other.id /* JOIN 03_ran_kpi_hourly_2months */",
    );
  });

  it("rewrites a schema-qualified logical name to its assigned physical table", () => {
    const aliases = new Map([["sales.orders", "ds_order_snapshot"]]);
    expect(rewriteClickhouseTableReferences(
      "SELECT * FROM `sales`.`orders` AS o JOIN sales.orders AS prior ON o.id = prior.id",
      aliases,
    )).toBe("SELECT * FROM `ds_order_snapshot` AS o JOIN `ds_order_snapshot` AS prior ON o.id = prior.id");
  });

  it("keeps same-named tables ambiguous while authorizing their schema-qualified aliases", () => {
    const aliases = buildClickhouseTableAliasMap([
      { id: "table-a", tableName: "orders", sourceSchema: "sales", clickhouseTable: "ds_sales_orders" },
      { id: "table-b", tableName: "orders", sourceSchema: "archive", clickhouseTable: "ds_archive_orders" },
    ]);

    expect(aliases.has("orders")).toBe(false);
    expect(aliases.get("sales.orders")).toBe("ds_sales_orders");
    expect(aliases.get("archive.orders")).toBe("ds_archive_orders");
    expect(rewriteClickhouseTableReferences(
      "SELECT * FROM sales.orders JOIN archive.orders ON 1 = 1",
      aliases,
    )).toBe("SELECT * FROM `ds_sales_orders` JOIN `ds_archive_orders` ON 1 = 1");
  });

  it("does not rewrite ClickHouse system metadata references to a company table alias", () => {
    const aliases = buildClickhouseTableAliasMap([
      { id: "source-tables", tableName: "tables", sourceSchema: "system", clickhouseTable: "ds_source_tables" },
    ]);
    expect(rewriteClickhouseTableReferences("SELECT name FROM system.tables", aliases))
      .toBe("SELECT name FROM system.tables");
  });

  it("rewrites a schema-qualified logical name to its assigned physical table", () => {
    const aliases = new Map([["sales.orders", "ds_order_snapshot"]]);
    expect(rewriteClickhouseTableReferences(
      "SELECT * FROM `sales`.`orders` AS o JOIN sales.orders AS prior ON o.id = prior.id",
      aliases,
    )).toBe("SELECT * FROM `ds_order_snapshot` AS o JOIN `ds_order_snapshot` AS prior ON o.id = prior.id");
  });

  it("does not rewrite a common table expression that shares an assigned alias", () => {
    const query = "WITH logical_table AS (SELECT 1 AS id) SELECT * FROM logical_table";
    expect(rewriteClickhouseTableReferences(
      query,
      new Map([["logical_table", "ds_real_table"]]),
      new Set(["logical_table"]),
    )).toBe(query);
  });

  it("resolves a unique logical ClickHouse table name to its published physical table", async () => {
    const physicalName = "ds_8232671d88a8b3e18f28373e_14_subscriber_master_360";
    const table = {
      id: "table-1",
      tableName: "14_subscriber_master_360",
      semanticModel: { clickhouseTable: physicalName },
    };
    const db = {
      select: () => ({ from: () => ({ where: async () => [table] }) }),
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ data: [], meta: [], rows: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    try {
      await new DataSourcesService(db).queryClickhouse(
        "9297e06c-1abc-443e-8ba3-f4bb7be8a851",
        "SELECT count() AS subscribers FROM 14_subscriber_master_360",
        50,
      );

      expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(`FROM \`${physicalName}\``);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects an ambiguous logical ClickHouse table name with physical table choices", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: "table-1",
              tableName: "14_subscriber_master_360",
              semanticModel: { clickhouseTable: "ds_8232671d88a8b3e18f28373e_14_subscriber_master_360" },
            },
            {
              id: "table-2",
              tableName: "14_subscriber_master_360",
              semanticModel: { clickhouseTable: "ds_865b2cbe28f4e99a5cd02acd_14_subscriber_master_360" },
            },
          ],
        }),
      }),
    } as never;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      await expect(new DataSourcesService(db).queryClickhouse(
        "9297e06c-1abc-443e-8ba3-f4bb7be8a851",
        "SELECT count() AS subscribers FROM 14_subscriber_master_360",
        50,
      )).rejects.toThrow(/ambiguous.*ds_8232671d88a8b3e18f28373e_14_subscriber_master_360.*ds_865b2cbe28f4e99a5cd02acd_14_subscriber_master_360/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
