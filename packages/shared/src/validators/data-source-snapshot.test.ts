import { describe, expect, it } from "vitest";
import { dataSourceSnapshotRequestSchema } from "./data-source-snapshot.js";

const tableId = "11111111-1111-4111-8111-111111111111";

describe("datasource snapshot request", () => {
  it("defaults to a bounded full snapshot for existing clients", () => {
    expect(dataSourceSnapshotRequestSchema.parse({})).toEqual({ mode: "full" });
  });

  it("requires a per-table updated-at policy for incremental sync", () => {
    expect(dataSourceSnapshotRequestSchema.safeParse({ mode: "incremental", tableIds: [tableId] }).success).toBe(false);
    expect(dataSourceSnapshotRequestSchema.parse({
      mode: "incremental",
      tableIds: [tableId],
      tablePolicies: [{ tableId, updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at" }],
    })).toMatchObject({ mode: "incremental" });
  });

  it("rejects duplicate and out-of-scope policies", () => {
    expect(dataSourceSnapshotRequestSchema.safeParse({ tableIds: [tableId, tableId] }).success).toBe(false);
    expect(dataSourceSnapshotRequestSchema.safeParse({
      mode: "incremental",
      tableIds: [tableId],
      tablePolicies: [{ tableId: "22222222-2222-4222-8222-222222222222", updatedAtColumn: "updated_at" }],
    }).success).toBe(false);
  });
});
