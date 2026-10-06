import { describe, expect, it } from "vitest";
import {
  compareRestoredEmbeddingCoverage,
  compareRestoredFile,
  compareRestoredRowCount,
} from "./data-source-restore-verifier.js";

describe("datasource restore reconciliation checks", () => {
  it("compares restored file size and checksum without requiring optional checksum metadata", () => {
    expect(compareRestoredFile({ exists: false, expectedBytes: 10 })).toEqual(["file_missing"]);
    expect(compareRestoredFile({ exists: true, expectedBytes: 10, actualBytes: 9 })).toEqual(["file_size_mismatch"]);
    expect(compareRestoredFile({
      exists: true,
      expectedBytes: 10,
      actualBytes: 10,
      expectedSha256: "expected",
      actualSha256: "actual",
    })).toEqual(["file_checksum_mismatch"]);
    expect(compareRestoredFile({
      exists: true,
      expectedBytes: 10,
      actualBytes: 10,
      expectedSha256: "expected",
    })).toEqual(["file_checksum_unverifiable"]);
  });

  it("detects logical ClickHouse snapshot row-count drift", () => {
    expect(compareRestoredRowCount("500", "500")).toEqual([]);
    expect(compareRestoredRowCount(500, 499)).toEqual(["snapshot_row_count_mismatch"]);
    expect(compareRestoredRowCount("unknown", 1)).toEqual(["snapshot_row_count_unavailable"]);
    expect(compareRestoredRowCount(null, 0)).toEqual(["snapshot_row_count_unavailable"]);
    expect(compareRestoredRowCount(true, 1)).toEqual(["snapshot_row_count_unavailable"]);
  });

  it("requires complete vectors only when chunks and an active vector space exist", () => {
    expect(compareRestoredEmbeddingCoverage({ chunkCount: 0, embeddingCount: 0, available: false })).toEqual([]);
    expect(compareRestoredEmbeddingCoverage({ chunkCount: 5, embeddingCount: 5, available: true })).toEqual([]);
    expect(compareRestoredEmbeddingCoverage({ chunkCount: 5, embeddingCount: 4, available: true })).toEqual(["rag_embedding_coverage_mismatch"]);
    expect(compareRestoredEmbeddingCoverage({ chunkCount: 5, embeddingCount: 0, available: false })).toEqual(["rag_vector_store_unavailable"]);
  });
});
