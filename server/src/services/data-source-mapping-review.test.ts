import { describe, expect, it } from "vitest";
import { dataSourceMappingReviewRequestSchema } from "@paperclipai/shared";
import {
  applyDataSourceMappingCorrections,
  type MappingReviewColumn,
} from "./data-source-mapping-review.js";
import { resolveSemanticMetricBindings } from "./data-source-query-semantics.js";

const columns: MappingReviewColumn[] = [
  { name: "revenue_usd", dataType: "number", role: "metric", semanticCategory: "financial" },
  { name: "site_name", dataType: "string", role: "dimension", semanticCategory: "location" },
  { name: "email_address", dataType: "string", role: "attribute", semanticCategory: "contact" },
  { name: "notes", dataType: "string", role: "attribute", semanticCategory: "general" },
];

describe("datasource semantic mapping review", () => {
  it("accepts bounded mapping corrections but rejects free-form SQL fields", () => {
    const parsed = dataSourceMappingReviewRequestSchema.safeParse({
      decision: "corrected",
      metricCorrections: [{ index: 0, name: "Revenue", column: "revenue_usd", aggregation: "sum", description: "Invoice revenue" }],
    });
    expect(parsed.success).toBe(true);
    expect(dataSourceMappingReviewRequestSchema.safeParse({
      decision: "corrected",
      metricCorrections: [{ index: 0, name: "Revenue", column: "revenue_usd", aggregation: "sum", expression: "sum(secret())" }],
    }).success).toBe(false);
  });

  it("requires a correction when the operator chooses the corrected action", () => {
    expect(dataSourceMappingReviewRequestSchema.safeParse({ decision: "corrected" }).success).toBe(false);
    expect(dataSourceMappingReviewRequestSchema.safeParse({
      decision: "approved",
      metricCorrections: [
        { index: 0, name: "Revenue", column: "revenue_usd", aggregation: "sum" },
        { index: 0, name: "Duplicate", column: "revenue_usd", aggregation: "sum" },
      ],
    }).success).toBe(false);
  });

  it("binds a corrected semantic metric to an inspected physical column and invalidates stale SQL expression", () => {
    const corrected = applyDataSourceMappingCorrections(
      [{ name: "Cost", column: "old_cost", expression: "sum(old_cost)", aggregation: "sum", synonyms: ["spend"] }],
      [{ index: 0, name: "Revenue", column: "revenue_usd", aggregation: "sum", description: "Revenue" }],
      "metric",
      columns,
    );

    expect(corrected[0]).toMatchObject({
      name: "Revenue",
      column: "revenue_usd",
      physicalColumn: "revenue_usd",
      aggregation: "sum",
      description: "Revenue",
      provenance: "user_defined",
      publicationGateStatus: "verified",
      synonyms: ["spend", "Cost"],
    });
    expect(corrected[0]).not.toHaveProperty("expression");
    expect(resolveSemanticMetricBindings(corrected, columns)).toEqual([
      { name: "Revenue", column: "revenue_usd", synonyms: ["spend", "Cost"] },
    ]);
  });

  it("clears old dimension samples and refuses invented, nonnumeric, or personal columns", () => {
    const corrected = applyDataSourceMappingCorrections(
      [{ name: "Location", column: "old_location", sampleValues: ["wrong sample"] }],
      [{ index: 0, name: "Site", column: "site_name", description: "Site label" }],
      "dimension",
      columns,
    );
    expect(corrected[0]).toMatchObject({ name: "Site", column: "site_name", provenance: "user_defined" });
    expect(corrected[0]).not.toHaveProperty("sampleValues");
    expect(() => applyDataSourceMappingCorrections(
      [{ name: "Revenue" }], [{ index: 0, name: "Revenue", column: "missing", aggregation: "sum" }], "metric", columns,
    )).toThrow(/tidak ada dalam schema/);
    expect(() => applyDataSourceMappingCorrections(
      [{ name: "Revenue" }], [{ index: 0, name: "Revenue", column: "notes", aggregation: "sum" }], "metric", columns,
    )).toThrow(/bukan kolom numerik/);
    expect(() => applyDataSourceMappingCorrections(
      [{ name: "Email" }], [{ index: 0, name: "Email", column: "email_address" }], "dimension", columns,
    )).toThrow(/sensitif/);
  });
});
