import { describe, expect, it } from "vitest";
import { mergeExternalDatabaseTableProfileBatches } from "./data-sources.js";

describe("mergeExternalDatabaseTableProfileBatches", () => {
  it("preserves semantic fields from every column batch and deduplicates repeated bindings", () => {
    const first = mergeExternalDatabaseTableProfileBatches(undefined, {
      tableName: "orders",
      context: "Order identity and customer fields.",
      topics: ["order volume"],
      entities: ["order"],
      metrics: [{ name: "order total", column: "total", aggregation: "sum" }],
      dimensions: [{ name: "order status", column: "status" }],
      relationships: [{ sourceTable: "orders", sourceColumn: "customer_id", targetTable: "customers", targetColumn: "id" }],
    });

    const merged = mergeExternalDatabaseTableProfileBatches(first, {
      tableName: "orders",
      context: "Amounts, timestamps, and fulfillment fields.",
      topics: ["order volume", "fulfillment time"],
      entities: ["order", "shipment"],
      metrics: [
        { name: "order total", column: "total", aggregation: "sum", description: "Updated definition" },
        { name: "fulfillment days", column: "fulfilled_days", aggregation: "avg" },
      ],
      dimensions: [{ name: "order status", column: "status" }, { name: "order date", column: "created_at" }],
      relationships: [{ sourceTable: "orders", sourceColumn: "customer_id", targetTable: "customers", targetColumn: "id" }],
    });

    expect(merged.context).toContain("Order identity and customer fields.");
    expect(merged.context).toContain("Amounts, timestamps, and fulfillment fields.");
    expect(merged.topics).toEqual(["order volume", "fulfillment time"]);
    expect(merged.entities).toEqual(["order", "shipment"]);
    expect(merged.metrics).toHaveLength(2);
    expect(merged.metrics[0]).toMatchObject({ description: "Updated definition" });
    expect(merged.dimensions).toHaveLength(2);
    expect(merged.relationships).toHaveLength(1);
  });
});
