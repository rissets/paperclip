import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workbook } from "exceljs";
import { StructuredIngestionService } from "../services/structured-ingestion.js";
import { getCsvSourceRowCheckpoint } from "../services/data-source-stream-checkpoint.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

function placeWorksheetZipEntriesFirst(archive: Buffer): Buffer {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("XLSX test archive has no ZIP end record");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const entries: Array<{ path: string; centralOffset: number; localOffset: number }> = [];
  let centralOffset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("Invalid XLSX central directory entry");
    const pathLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    entries.push({
      path: archive.toString("utf8", centralOffset + 46, centralOffset + 46 + pathLength),
      centralOffset,
      localOffset: archive.readUInt32LE(centralOffset + 42),
    });
    centralOffset += 46 + pathLength + extraLength + commentLength;
  }
  if (centralOffset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error("Unexpected XLSX central directory length");
  }

  const byLocalOffset = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  const blocks = byLocalOffset.map((entry, index) => ({
    ...entry,
    bytes: archive.subarray(entry.localOffset, byLocalOffset[index + 1]?.localOffset ?? centralDirectoryOffset),
  }));
  const orderedBlocks = [
    ...blocks.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path)),
    ...blocks.filter((entry) => !/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path)),
  ];
  const newOffsets = new Map<string, number>();
  let nextLocalOffset = 0;
  for (const entry of orderedBlocks) {
    newOffsets.set(entry.path, nextLocalOffset);
    nextLocalOffset += entry.bytes.length;
  }
  const reorderedCentralDirectory = Buffer.from(archive.subarray(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize));
  for (const entry of entries) {
    const newOffset = newOffsets.get(entry.path);
    if (newOffset === undefined) throw new Error(`Missing local XLSX entry '${entry.path}'`);
    reorderedCentralDirectory.writeUInt32LE(newOffset, entry.centralOffset - centralDirectoryOffset + 42);
  }
  return Buffer.concat([
    ...orderedBlocks.map((entry) => entry.bytes),
    reorderedCentralDirectory,
    archive.subarray(endOffset),
  ]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("streaming structured ingestion", () => {
  it("selects the streaming parser for supported structured formats without a size threshold", () => {
    expect(StructuredIngestionService.streamingFormatFor("csv", "csv")).toBe("csv");
    expect(StructuredIngestionService.streamingFormatFor("csv", ".tsv")).toBe("csv");
    expect(StructuredIngestionService.streamingFormatFor("excel", "xlsx")).toBe("xlsx");
    expect(StructuredIngestionService.streamingFormatFor("excel", "xls")).toBeNull();
    expect(StructuredIngestionService.streamingFormatFor("rag_document", "csv")).toBeNull();
  });

  it("stages buffer inputs with private permissions and removes the temporary file", async () => {
    const staged = await StructuredIngestionService.stageBufferForStreaming(Buffer.from("id,value\n1,secret"), ".CSV");
    try {
      const stat = await fs.stat(staged.filePath);
      expect(stat.mode & 0o777).toBe(0o600);
      await expect(fs.readFile(staged.filePath, "utf8")).resolves.toBe("id,value\n1,secret");
    } finally {
      await staged.cleanup();
    }
    await expect(fs.stat(staged.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses exact identities for capped in-memory profiles", () => {
    const profile = StructuredIngestionService.profileAndBuildTable("memory", [
      { id: 1, amount: 10 },
      { id: 1, amount: 20 },
      { id: "1", amount: 30 },
      { id: null, amount: 40 },
      { id: null, amount: 40 },
    ], { primaryKey: "id" });

    expect(profile.semanticModel.qualityCounters).toMatchObject({
      totalRows: 5,
      duplicateRows: 2,
      duplicateKeyRows: 1,
      duplicateDetection: "complete",
    });
  });

  it("rejects in-memory compatibility inputs above the row limit before cloning them", () => {
    const rows = Array.from({ length: 65_537 }, (_, id) => ({ id }));
    expect(() => StructuredIngestionService.profileAndBuildTable("oversized-memory", rows))
      .toThrow(/in-memory structured input exceeds the compatibility limit/i);
  });

  it("rejects excessively wide in-memory compatibility rows before profiling cells", () => {
    const wideRow = Object.fromEntries(Array.from({ length: 16_385 }, (_, index) => [`column_${index}`, index]));
    expect(() => StructuredIngestionService.profileAndBuildTable("oversized-wide-memory", [wideRow]))
      .toThrow(/in-memory structured input exceeds the compatibility limit/i);
  });

  it("rejects oversized CSV compatibility strings before parsing a workbook", () => {
    const oversizedContent = "x".repeat(32 * 1024 * 1024 + 1);
    expect(() => StructuredIngestionService.parseCsv(oversizedContent, "oversized-csv"))
      .toThrow(/32 MiB compatibility limit/i);
  });

  it("loads the ExcelJS streaming reader with Node's native ESM loader", async () => {
    const sourcePath = fileURLToPath(new URL("../services/structured-ingestion.ts", import.meta.url));
    const serverRoot = path.resolve(path.dirname(sourcePath), "../..");
    await execFileAsync(process.execPath, [
      "--import", path.join(serverRoot, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e", `await import(${JSON.stringify(sourcePath)})`,
    ], { cwd: serverRoot, timeout: 15_000 });
  });

  it("profiles a large delimited file with bounded preview rows and streams every normalized row", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-stream-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "sales.csv");
    const rows = ["order_id;region;amount"];
    for (let index = 0; index < 2_305; index += 1) {
      rows.push(`${String(index + 1).padStart(6, "0")};region-${index % 7};${index * 1.25}`);
    }
    await fs.writeFile(filePath, rows.join("\n"), "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "sales");
    expect(profile.rowCount).toBe(2_305);
    expect(profile.rows).toHaveLength(2_000);
    expect(profile.columns.map((column) => column.name)).toEqual(["order_id", "region", "amount"]);

    const streamed: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns)) streamed.push(row);
    expect(streamed).toHaveLength(profile.rowCount);
    expect(streamed[0]).toEqual({ order_id: "000001", region: "region-0", amount: 0 });
    expect(streamed.at(-1)).toEqual({ order_id: "002305", region: "region-1", amount: 2_880 });
  });

  it("counts typed violations across the full CSV without retaining rows beyond the sample", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-quality-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "quality.csv");
    const rows = ["id,amount,created_at"];
    for (let index = 0; index < 2_003; index += 1) {
      const amount = index === 2_001 ? "not-a-number" : String(index * 10);
      const createdAt = index === 2_002 ? "not-a-date" : `2026-10-${String((index % 28) + 1).padStart(2, "0")}`;
      const id = index === 2_002 ? 1 : index + 1;
      rows.push(`${id},${amount},${createdAt}`);
    }
    await fs.writeFile(filePath, rows.join("\n"), "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "quality");

    expect(profile.rows).toHaveLength(2_000);
    expect(profile.rowCount).toBe(2_003);
    expect(profile.semanticModel.qualityCounters).toMatchObject({
      totalRows: 2_003,
      validRows: 2_001,
      invalidRows: 2,
      quarantinedRows: 2,
      publishedRows: 2_001,
      typeViolations: 2,
      duplicateRows: 0,
      duplicateKeyRows: 0,
      duplicateDetection: "complete",
    });
    expect(profile.publishableRowCount).toBe(2_001);
    expect(profile.semanticModel.qualityCounters?.temporalBoundsByColumn?.created_at).toEqual({
      minDate: "2026-10-01T00:00:00.000Z",
      maxDate: "2026-10-28T00:00:00.000Z",
    });
    expect(profile.semanticModel.qualityCounters?.sampleErrors).toEqual([
      { rowNumber: 2_002, column: "amount", error: "Invalid numeric value in column 'amount'" },
      { rowNumber: 2_003, column: "created_at", error: "Invalid date value in column 'created_at'" },
    ]);
    expect(profile.semanticModel.qualityCounters?.quarantineSamples).toEqual([
      { rowNumber: 2_002, columns: ["amount"], reason: "type_violation" },
      { rowNumber: 2_003, columns: ["created_at"], reason: "type_violation" },
    ]);
    expect(profile.semanticModel.publicationGateStatus).toBe("verified");
    expect(profile.semanticModel.qualityCounters?.sampleErrors?.some((error) => error.error?.includes("not-a-number"))).toBe(false);

    const publishedRows: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns)) publishedRows.push(row);
    expect(publishedRows).toHaveLength(2_001);
    expect(publishedRows.some((row) => row.id === "2002" || (row.id === "1" && row.created_at === null))).toBe(false);
  });

  it("rejects a streamed CSV when exact duplicate primary keys exceed the quality threshold", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-duplicate-gate-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "duplicate-keys.csv");
    const rows = ["id,amount"];
    for (let index = 0; index < 20; index += 1) rows.push(`1,${index * 10}`);
    await fs.writeFile(filePath, rows.join("\n"), "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "duplicate-keys");

    expect(profile.semanticModel.qualityCounters).toMatchObject({
      totalRows: 20,
      duplicateRows: 19,
      duplicateKeyRows: 19,
      duplicateDetection: "complete",
    });
    expect(profile.semanticModel.publicationGateStatus).toBe("rejected");
    expect(profile.semanticModel.unresolvedDefinitions?.some((item) => item.startsWith("Uniqueness gate failed:"))).toBe(true);
  });

  it("keeps an invalid Excel Date value as a quality error instead of throwing during normalization", () => {
    const invalidDate = new Date(Number.NaN);
    const normalized = (StructuredIngestionService as any).excelCellValue(invalidDate);
    expect(normalized).toBe("Invalid Date");
    expect(StructuredIngestionService.parseTypedDate(normalized)).toBeNull();
    expect(StructuredIngestionService.parseTypedDate("catatan-1001")).toBeNull();
    expect(StructuredIngestionService.parseTypedDate("31/12/2025")?.iso).toBe("2025-12-31T00:00:00.000Z");
    expect(StructuredIngestionService.parseTypedDate("February 31, 2025")).toBeNull();
  });

  it("quarantines a streamed record whose width differs from the profiled schema", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-stream-invalid-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "invalid.csv");
    await fs.writeFile(filePath, "id,name\n1,Ada\n2,Grace,extra\n", "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "people");
    expect(profile.rowCount).toBe(2);
    expect(profile.publishableRowCount).toBe(1);
    expect(profile.semanticModel.qualityCounters).toMatchObject({
      totalRows: 2,
      validRows: 1,
      invalidRows: 1,
      quarantinedRows: 1,
      publishedRows: 1,
    });
    expect(profile.semanticModel.qualityCounters?.quarantineSamples).toEqual([
      { rowNumber: 2, columns: ["__field_count__"], reason: "field_count" },
    ]);
    expect(profile.semanticModel.publicationGateStatus).toBe("rejected");
    const publishedRows: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns)) publishedRows.push(row);
    expect(publishedRows).toEqual([{ id: "1", name: "Ada" }]);
  });

  it("resumes a delimited stream at the exact committed record boundary, including quoted newlines", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-resume-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "resume.tsv");
    const lines = ["id;note", '1;"baris pertama\ndan kedua — 東京"'];
    for (let index = 2; index <= 1_205; index += 1) lines.push(`${index};catatan-${index}`);
    await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "resume");
    const prefix: Record<string, unknown>[] = [];
    let checkpoint: ReturnType<typeof getCsvSourceRowCheckpoint>;
    let initialRowsScanned = 0;
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns)) {
      initialRowsScanned += 1;
      if (initialRowsScanned <= 1_000) prefix.push(row);
      if (initialRowsScanned === 1_000) checkpoint = getCsvSourceRowCheckpoint(row);
    }

    expect(initialRowsScanned).toBe(1_205);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.rowNumber).toBe(1_000);
    expect(checkpoint?.delimiter).toBe(";");
    const suffix: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns, {
      byteOffset: checkpoint!.byteOffset,
      rowsCommitted: checkpoint!.rowNumber,
      delimiter: checkpoint!.delimiter,
    })) suffix.push(row);

    expect(prefix[0]).toEqual({ id: "1", note: "baris pertama\ndan kedua — 東京" });
    expect(prefix).toHaveLength(1_000);
    expect(suffix).toHaveLength(205);
    expect(suffix[0]).toEqual({ id: "1001", note: "catatan-1001" });
    expect(suffix.at(-1)).toEqual({ id: "1205", note: "catatan-1205" });
    expect([...prefix, ...suffix].map((row) => row.id)).toEqual(Array.from({ length: 1_205 }, (_, index) => String(index + 1)));
  });

  it("resumes after published batches using source position when quarantined rows were skipped", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-quarantine-resume-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "quarantine-resume.csv");
    const rows = ["id,amount"];
    for (let index = 1; index <= 1_205; index += 1) {
      rows.push(`${index},${index === 500 ? "not-a-number" : index * 10}`);
    }
    await fs.writeFile(filePath, rows.join("\n"), "utf8");

    const profile = await StructuredIngestionService.profileCsvFile(filePath, "quarantine-resume");
    const prefix: Record<string, unknown>[] = [];
    let checkpoint: ReturnType<typeof getCsvSourceRowCheckpoint>;
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns)) {
      if (prefix.length < 1_000) prefix.push(row);
      if (prefix.length === 1_000) checkpoint ??= getCsvSourceRowCheckpoint(row);
    }
    expect(prefix).toHaveLength(1_000);
    expect(checkpoint?.rowNumber).toBe(1_001);

    const suffix: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamCsvRows(filePath, profile.columns, {
      byteOffset: checkpoint!.byteOffset,
      rowsCommitted: checkpoint!.rowNumber,
      delimiter: checkpoint!.delimiter,
    })) suffix.push(row);

    expect(suffix).toHaveLength(204);
    expect([...prefix, ...suffix]).toHaveLength(profile.publishableRowCount);
    expect([...prefix, ...suffix].some((row) => row.id === "500")).toBe(false);
    expect(suffix[0]?.id).toBe("1002");
  });

  it("profiles large XLSX sheets from a bounded sample and streams every sheet row", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-xlsx-stream-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "workbook.xlsx");
    const workbook = new Workbook();
    const salesSheet = workbook.addWorksheet("sales");
    salesSheet.addRow(["order_id", "region", "amount"]);
    for (let index = 0; index < 2_305; index += 1) {
      salesSheet.addRow([String(index + 1).padStart(6, "0"), `region-${index % 7}`, index * 1.25]);
    }
    workbook.addWorksheet("owners").addRows([["owner", "active"], ["Ada", true], ["Grace", false]]);
    await workbook.xlsx.writeFile(filePath);
    const reorderedFilePath = path.join(directory, "workbook-sheet-first.xlsx");
    await fs.writeFile(reorderedFilePath, placeWorksheetZipEntriesFirst(await fs.readFile(filePath)));

    const tables = await StructuredIngestionService.profileExcelFile(reorderedFilePath);
    expect(tables.map((table) => [table.tableName, table.rowCount, table.rows.length])).toEqual([
      ["sales", 2_305, 2_000],
      ["owners", 2, 2],
    ]);
    const sales = tables[0];
    expect(sales.headerRowPresent).toBe(true);
    const streamed: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamExcelRows(
      reorderedFilePath,
      "sales",
      sales.columns,
      undefined,
      sales.headerRowPresent,
    )) {
      streamed.push(row);
    }
    expect(streamed).toHaveLength(2_305);
    expect(streamed[0]).toEqual({ order_id: "000001", region: "region-0", amount: 0 });
    expect(streamed.at(-1)).toEqual({ order_id: "002305", region: "region-1", amount: 2_880 });
  });

  it("counts XLSX type violations after the bounded semantic sample", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-xlsx-quality-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "quality.xlsx");
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet("quality");
    sheet.addRow(["id", "amount", "created_at"]);
    for (let index = 0; index < 2_003; index += 1) {
      sheet.addRow([
        index === 2_002 ? 1 : index + 1,
        index === 2_001 ? "not-a-number" : index * 10,
        index === 2_002 ? "not-a-date" : `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
      ]);
    }
    await workbook.xlsx.writeFile(filePath);

    const [profile] = await StructuredIngestionService.profileExcelFile(filePath);

    expect(profile.rows).toHaveLength(2_000);
    expect(profile.rowCount).toBe(2_003);
    expect(profile.semanticModel.qualityCounters).toMatchObject({
      totalRows: 2_003,
      validRows: 2_001,
      invalidRows: 2,
      quarantinedRows: 2,
      publishedRows: 2_001,
      typeViolations: 2,
      duplicateRows: 0,
      duplicateKeyRows: 0,
      duplicateDetection: "complete",
    });
    expect(profile.publishableRowCount).toBe(2_001);
    expect(profile.semanticModel.publicationGateStatus).toBe("verified");
    const publishedRows: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamExcelRows(
      filePath,
      "quality",
      profile.columns,
      undefined,
      profile.headerRowPresent,
    )) publishedRows.push(row);
    expect(publishedRows).toHaveLength(2_001);
  });

});
