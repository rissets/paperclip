import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countExactDuplicates } from "./exact-duplicate-detector.js";

async function* records(rows: Array<Record<string, unknown>>) {
  for (const row of rows) yield row;
}

describe("countExactDuplicates", () => {
  it("counts exact primary-key and whole-row duplicates through multiple bounded merge passes", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-duplicate-detector-test-"));
    try {
      const result = await countExactDuplicates(
        records([
          { id: 1, value: "first" },
          { id: "1", value: "textual id is distinct" },
          { id: 1, value: "different row but same key" },
          { id: null, value: "same full row" },
          { id: null, value: "same full row" },
          { id: 2, value: "unique" },
          { id: 3, value: "unique" },
        ]),
        [{ name: "id" }, { name: "value" }],
        "id",
        { maxChunkEntries: 100, maxChunkBytes: 32, mergeFanIn: 2, temporaryDirectory },
      );

      expect(result).toEqual({ duplicateRows: 2, duplicateKeyRows: 1 });
      expect(await readdir(temporaryDirectory)).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("compares complete row values exactly when no primary key is available", async () => {
    const result = await countExactDuplicates(
      records([{ a: "x", b: 1 }, { a: "x", b: 1 }, { a: "x", b: "1" }]),
      [{ name: "a" }, { name: "b" }],
    );

    expect(result).toEqual({ duplicateRows: 1, duplicateKeyRows: 0 });
  });
});
