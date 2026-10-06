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

  it("rejects a streamed record whose width differs from the profiled schema", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-csv-stream-invalid-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "invalid.csv");
    await fs.writeFile(filePath, "id,name\n1,Ada\n2,Grace,extra\n", "utf8");

    await expect(StructuredIngestionService.profileCsvFile(filePath, "people"))
      .rejects.toThrow("Invalid Record Length");
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
    const streamed: Record<string, unknown>[] = [];
    for await (const row of StructuredIngestionService.streamExcelRows(reorderedFilePath, "sales", sales.columns)) {
      streamed.push(row);
    }
    expect(streamed).toHaveLength(2_305);
    expect(streamed[0]).toEqual({ order_id: "000001", region: "region-0", amount: 0 });
    expect(streamed.at(-1)).toEqual({ order_id: "002305", region: "region-1", amount: 2_880 });
  });

});
