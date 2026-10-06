import { describe, expect, it } from "vitest";
import { dataSourceEmbeddingPruneRequestSchema } from "./data-source-embedding-prune.js";

describe("dataSourceEmbeddingPruneRequestSchema", () => {
  it("defaults to a non-destructive preview", () => {
    expect(dataSourceEmbeddingPruneRequestSchema.parse({})).toEqual({ confirm: false });
  });

  it("requires the exact previewed generation identities before confirming deletion", () => {
    expect(dataSourceEmbeddingPruneRequestSchema.safeParse({ confirm: true }).success).toBe(false);
    expect(dataSourceEmbeddingPruneRequestSchema.parse({
      confirm: true,
      expectedGenerations: [{
        embeddingSpace: "bge-m3",
        embeddingGeneration: "bge-m3@revision-7",
      }],
    }).confirm).toBe(true);
  });

  it("rejects invalid spaces and unknown request fields", () => {
    expect(dataSourceEmbeddingPruneRequestSchema.safeParse({
      confirm: true,
      expectedGenerations: [{ embeddingSpace: "unknown", embeddingGeneration: "old" }],
    }).success).toBe(false);
    expect(dataSourceEmbeddingPruneRequestSchema.safeParse({ preview: true }).success).toBe(false);
  });
});
