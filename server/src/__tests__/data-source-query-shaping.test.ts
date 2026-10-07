import { describe, expect, it } from "vitest";
import { clickhouseAggregateColumnExpression, validateStructuredAggregationColumn } from "../services/data-sources.js";
import { rewriteClickhouseTableReferences } from "../services/clickhouse.js";

describe("structured datasource query shaping", () => {
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

  it("does not rewrite a common table expression that shares an assigned alias", () => {
    const query = "WITH logical_table AS (SELECT 1 AS id) SELECT * FROM logical_table";
    expect(rewriteClickhouseTableReferences(
      query,
      new Map([["logical_table", "ds_real_table"]]),
      new Set(["logical_table"]),
    )).toBe(query);
  });
});
