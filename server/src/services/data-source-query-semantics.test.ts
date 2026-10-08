import { describe, expect, it } from "vitest";
import {
  resolveRequestedDimension,
  resolveSemanticDimensionBindings,
  resolveSemanticMetricBindings,
  resolveTemporalRangeFilter,
} from "./data-source-query-semantics.js";

describe("structured query semantics", () => {
  it("converts an Indonesian month phrase to an Excel-serial half-open range", () => {
    const result = resolveTemporalRangeFilter("jumlah maintenance Agustus 2026", [
      { name: "month", dataType: "number", role: "temporal", clickhouseType: "Float64" },
    ]);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.column).toBe("month");
    expect(result.label).toBe("2026-08");
    expect(result.gte).toBeCloseTo(46_235);
    expect(result.lt).toBeCloseTo(46_266);
  });

  it("refuses to aggregate an explicitly requested period when its numeric encoding is unknown", () => {
    const result = resolveTemporalRangeFilter("maintenance cost August 2026", [
      { name: "event_time", dataType: "number", role: "temporal", clickhouseType: "Float64" },
    ]);

    expect(result.status).toBe("unsafe");
  });

  it("binds display metric names to one physical metric column", () => {
    const bindings = resolveSemanticMetricBindings(
      [{ name: "Maintenance Cost", aggregation: "sum" }],
      [
        { name: "month", role: "temporal" },
        { name: "maintenance_cost_usd", role: "metric" },
      ],
    );

    expect(bindings).toEqual([
      { name: "Maintenance Cost", column: "maintenance_cost_usd", synonyms: [] },
    ]);
  });

  it("binds an explicit group-by label to the physical dimension column", () => {
    const bindings = resolveSemanticDimensionBindings(
      [{ name: "Site", column: "site_name", synonyms: ["site location"] }],
      [{ name: "site_name", role: "dimension" }, { name: "maintenance_cost_usd", role: "metric" }],
    );

    expect(resolveRequestedDimension("total maintenance cost per site", bindings)).toEqual({
      status: "resolved",
      name: "Site",
      column: "site_name",
    });
  });

  it("asks for clarification when a grouping phrase names multiple dimensions", () => {
    const bindings = resolveSemanticDimensionBindings(
      [{ name: "Site", column: "site_name" }, { name: "Site Type", column: "site_type" }],
      [{ name: "site_name" }, { name: "site_type" }],
    );

    expect(resolveRequestedDimension("group by site and site type", bindings)).toEqual({
      status: "ambiguous",
      names: ["Site", "Site Type"],
    });
  });

  it("does not silently drop an unknown grouping dimension", () => {
    const bindings = resolveSemanticDimensionBindings(
      [{ name: "Site", column: "site_name" }],
      [{ name: "site_name", role: "dimension" }],
    );

    expect(resolveRequestedDimension("group by region", bindings)).toEqual({ status: "unmatched" });
  });

  it("ignores dimensions mentioned only in a later prohibition or execution instruction", () => {
    const bindings = resolveSemanticDimensionBindings(
      [
        { name: "Domain", column: "domain" },
        { name: "Hidden Root Cause", column: "hidden_root_cause_for_demo" },
      ],
      [
        { name: "domain", role: "dimension" },
        { name: "hidden_root_cause_for_demo", role: "dimension" },
      ],
    );

    expect(resolveRequestedDimension(
      "Gunakan hanya datasource dan tabel 22_demo_incident_scenarios_truth_table. "
        + "Hitung jumlah skenario per domain melalui Enterprise Datasource Orchestrator dengan query read-only. "
        + "Jangan mengambil jawaban dari memory, dan jangan memilih, menampilkan, atau men-query hidden_root_cause_for_demo. "
        + "Sertakan sumber/tabel, jumlah per domain, total, dan trace ID jika tersedia.",
      bindings,
    )).toEqual({ status: "resolved", name: "Domain", column: "domain" });
  });

  it("does not treat a grouping cue inside a prohibition as a requested dimension", () => {
    const bindings = resolveSemanticDimensionBindings(
      [{ name: "Secret", column: "secret" }],
      [{ name: "secret", role: "dimension" }],
    );

    expect(resolveRequestedDimension("do not group by secret", bindings)).toEqual({ status: "not_requested" });
  });
});
