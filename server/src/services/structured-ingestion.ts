import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import type { ColumnDefinition, TableSemanticModel, ClickhouseSchemaDefinition, IngestionQualityCounters } from "@paperclipai/shared";
import { attachCsvSourceRowCheckpoint } from "./data-source-stream-checkpoint.js";
import { countExactDuplicates } from "./exact-duplicate-detector.js";

function updateTemporalBounds(
  counters: IngestionQualityCounters,
  column: string,
  isoDate: string,
): void {
  const update = (bounds: { minDate?: string; maxDate?: string }) => {
    if (!bounds.minDate || isoDate < bounds.minDate) bounds.minDate = isoDate;
    if (!bounds.maxDate || isoDate > bounds.maxDate) bounds.maxDate = isoDate;
  };
  counters.temporalBounds ??= {};
  update(counters.temporalBounds);
  counters.temporalBoundsByColumn ??= {};
  const columnBounds = counters.temporalBoundsByColumn[column] ??= {};
  update(columnBounds);
}

function updateDeferredTemporalBounds(
  boundsByColumn: Record<string, { minDate?: string; maxDate?: string }>,
  column: string,
  isoDate: string,
): void {
  const bounds = boundsByColumn[column] ??= {};
  if (!bounds.minDate || isoDate < bounds.minDate) bounds.minDate = isoDate;
  if (!bounds.maxDate || isoDate > bounds.maxDate) bounds.maxDate = isoDate;
}

function mergeDeferredTemporalBounds(
  counters: IngestionQualityCounters,
  boundsByColumn: Record<string, { minDate?: string; maxDate?: string }>,
): void {
  for (const [column, bounds] of Object.entries(boundsByColumn)) {
    if (bounds.minDate) updateTemporalBounds(counters, column, bounds.minDate);
    if (bounds.maxDate) updateTemporalBounds(counters, column, bounds.maxDate);
  }
}

function recordQuarantinedRow(
  counters: IngestionQualityCounters,
  rowNumber: number,
  columns: string[],
  reason: "type_violation" | "field_count",
): void {
  counters.quarantinedRows = (counters.quarantinedRows || 0) + 1;
  counters.quarantineSamples ??= [];
  if (counters.quarantineSamples.length < 50) {
    counters.quarantineSamples.push({
      rowNumber,
      columns: [...new Set(columns)].slice(0, 32).map((column) => column.slice(0, 128)),
      reason,
    });
  }
  if (reason === "field_count" && (counters.sampleErrors?.length || 0) < 10) {
    counters.sampleErrors ??= [];
    counters.sampleErrors.push({ rowNumber, error: "Row field count does not match the profiled schema" });
  }
}

function emptyQualityCounters(): IngestionQualityCounters {
  return {
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    quarantinedRows: 0,
    publishedRows: 0,
    nullValueCount: {},
    typeViolations: 0,
    duplicateRows: 0,
    duplicateDetection: "deferred",
    sampleErrors: [],
    quarantineSamples: [],
  };
}

const require = createRequire(import.meta.url);
const unzipper = require("unzipper") as {
  Open: {
    file: (filePath: string) => Promise<{
      files: Array<{
        path: string;
        uncompressedSize: number;
        buffer: () => Promise<Buffer>;
      }>;
    }>;
  };
};

export interface ParsedTableData {
  tableName: string;
  columns: ColumnDefinition[];
  semanticModel: TableSemanticModel;
  rows: Record<string, unknown>[];
  /** Source rows that passed type validation and will be published/queryable. */
  publishableRowCount?: number;
  rowCount?: number;
  headerRowPresent?: boolean;
}

export interface ParseStructuredOptions {
  knownColumns?: string[];
  catalogMap?: Map<string, string[]>;
  /** Exact source width for a CSV header before worksheet padding. */
  sourceHeaderWidth?: number;
  onProgress?: (rowsScanned: number) => void | Promise<void>;
}

export class StructuredIngestionService {
  private static readonly STREAM_SAMPLE_ROWS = 2_000;
  private static readonly MAX_XLSX_METADATA_ENTRY_BYTES = 1024 * 1024;
  private static readonly MAX_IN_MEMORY_COMPATIBILITY_BYTES = 32 * 1024 * 1024;
  private static readonly MAX_IN_MEMORY_COMPATIBILITY_ROWS = 65_536;
  private static readonly MAX_IN_MEMORY_COMPATIBILITY_COLUMNS = 16_384;
  private static readonly MAX_IN_MEMORY_COMPATIBILITY_CELLS = 1_000_000;

  private static assertInMemoryCompatibilityShape(rowCount: number, columnCount: number): void {
    const cellCount = rowCount * columnCount;
    if (rowCount > this.MAX_IN_MEMORY_COMPATIBILITY_ROWS
      || columnCount > this.MAX_IN_MEMORY_COMPATIBILITY_COLUMNS
      || !Number.isSafeInteger(cellCount)
      || cellCount > this.MAX_IN_MEMORY_COMPATIBILITY_CELLS) {
      throw new Error(
        `In-memory structured input exceeds the compatibility limit (${this.MAX_IN_MEMORY_COMPATIBILITY_ROWS.toLocaleString()} rows, ${this.MAX_IN_MEMORY_COMPATIBILITY_COLUMNS.toLocaleString()} columns, ${this.MAX_IN_MEMORY_COMPATIBILITY_CELLS.toLocaleString()} cells). Split the input or convert it to file-backed CSV/XLSX streaming ingestion.`,
      );
    }
  }

  private static assertInMemoryCompatibilityBytes(byteCount: number): void {
    if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > this.MAX_IN_MEMORY_COMPATIBILITY_BYTES) {
      throw new Error(
        `In-memory structured input exceeds the ${this.MAX_IN_MEMORY_COMPATIBILITY_BYTES / (1024 * 1024)} MiB compatibility limit. Use file-backed CSV/TSV/XLSX streaming ingestion instead.`,
      );
    }
  }

  /**
   * File-backed CSV and XLSX sources always use the streaming parser. File size
   * is not a safe proxy for row count: a small, wide or highly compressible
   * file can still expand into a large in-memory row array.
   */
  static streamingFormatFor(
    sourceType: string,
    extension: string,
  ): "csv" | "xlsx" | null {
    const normalizedExtension = extension.toLowerCase().replace(/^\./, "");
    if (sourceType === "csv" && (normalizedExtension === "csv" || normalizedExtension === "tsv")) return "csv";
    if (sourceType === "excel" && normalizedExtension === "xlsx") return "xlsx";
    return null;
  }

  /** Stage an in-memory compatibility input privately so profiling can stream it. */
  static async stageBufferForStreaming(
    buffer: Buffer,
    extension: string,
  ): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-structured-ingestion-"));
    const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, "") || "data";
    const filePath = path.join(temporaryDirectory, `source.${safeExtension}`);
    try {
      await fs.promises.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      filePath,
      cleanup: () => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }),
    };
  }

  private static applyFullProfileRowCount(table: ParsedTableData, rowCount: number): void {
    table.rowCount = rowCount;
    const publishedRows = table.publishableRowCount ?? rowCount;
    const quarantinedRows = Math.max(0, rowCount - publishedRows);
    table.semanticModel.description = `Structured analytical table '${table.tableName}' with ${publishedRows} valid published records from ${rowCount} source rows; ${quarantinedRows} invalid rows quarantined across ${table.columns.length} columns.`;
    if (table.semanticModel.context) {
      const roleDescription = table.semanticModel.tableRole === "fact_table"
        ? "Tabel Fakta Kuantitatif"
        : "Tabel Master Dimensi";
      const humanEntity = table.tableName.replace(/_/g, " ");
      table.semanticModel.context = `${roleDescription} untuk '${humanEntity}'. Memuat ${table.columns.length} kolom terstruktur; ${publishedRows.toLocaleString()} baris valid dipublikasikan dari ${rowCount.toLocaleString()} baris sumber dan ${quarantinedRows.toLocaleString()} baris dikarantina.`;
    }
  }

  private static decodeXmlAttribute(value: string): string {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|apos|quot);/gi, (entity, token: string) => {
      const normalized = token.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "apos") return "'";
      if (normalized === "quot") return '"';
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
  }

  private static xmlAttributes(tag: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const body = tag.slice(tag.indexOf(" ") + 1).replace(/\s*\/?\s*>$/, "");
    const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
    for (const match of body.matchAll(attributePattern)) {
      attributes[match[1]] = this.decodeXmlAttribute(match[3]);
    }
    return attributes;
  }

  /** Detect common delimiters without asking csv-parse to speculatively parse quoted rows. */
  private static detectCsvDelimiter(filePath: string, byteOffset = 0): string {
    const descriptor = fs.openSync(filePath, "r");
    const sample = Buffer.alloc(64 * 1024);
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(descriptor, sample, 0, sample.length, byteOffset);
    } finally {
      fs.closeSync(descriptor);
    }
    const text = sample.subarray(0, bytesRead).toString("utf8");
    const candidates = [",", ";", "\t", "|"];
    const scores = candidates.map((delimiter) => {
      const fieldCounts: number[] = [];
      let fields = 1;
      let inQuotes = false;
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"') {
          if (inQuotes && text[index + 1] === '"') index += 1;
          else inQuotes = !inQuotes;
        } else if (!inQuotes && character === delimiter) {
          fields += 1;
        } else if (!inQuotes && (character === "\n" || character === "\r")) {
          fieldCounts.push(fields);
          fields = 1;
          if (character === "\r" && text[index + 1] === "\n") index += 1;
          if (fieldCounts.length >= 32) break;
        }
      }
      if (fieldCounts.length < 32 && fields > 1) fieldCounts.push(fields);
      const counts = new Map<number, number>();
      for (const count of fieldCounts) counts.set(count, (counts.get(count) || 0) + 1);
      const [fieldCount, matchingRows] = [...counts.entries()].sort((left, right) =>
        right[1] - left[1] || right[0] - left[0],
      )[0] || [1, 0];
      return { delimiter, fieldCount, matchingRows };
    });
    const best = scores.sort((left, right) =>
      right.matchingRows - left.matchingRows || right.fieldCount - left.fieldCount,
    )[0];
    return best && best.fieldCount > 1 ? best.delimiter : ",";
  }

  /**
   * ExcelJS's streaming reader can encounter worksheet ZIP entries before
   * workbook.xml and then consult its worksheet model before that model exists.
   * Read only the two small metadata entries from the ZIP central directory and
   * prime those lookups; worksheet cells and shared strings remain streamed.
   */
  private static async createExcelWorkbookReader(filePath: string) {
    const archive = await unzipper.Open.file(filePath);
    const readMetadataEntry = async (entryPath: string): Promise<string> => {
      const entry = archive.files.find((candidate) => candidate.path === entryPath);
      if (!entry) throw new Error(`Excel workbook is missing '${entryPath}'`);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > this.MAX_XLSX_METADATA_ENTRY_BYTES) {
        throw new Error(`Excel workbook metadata '${entryPath}' exceeds the allowed size`);
      }
      return (await entry.buffer()).toString("utf8");
    };

    const [workbookXml, relationshipsXml] = await Promise.all([
      readMetadataEntry("xl/workbook.xml"),
      readMetadataEntry("xl/_rels/workbook.xml.rels"),
    ]);
    const relationships = [...relationshipsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)]
      .map(([tag]) => this.xmlAttributes(tag))
      .filter((attributes) => attributes.Id && attributes.Target)
      .map((attributes) => ({ Id: attributes.Id, Target: attributes.Target }));
    const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)]
      .map(([tag]) => this.xmlAttributes(tag))
      .filter((attributes) => attributes.name && attributes.sheetId && attributes["r:id"])
      .map((attributes) => ({
        id: Number.parseInt(attributes.sheetId, 10),
        name: attributes.name,
        state: attributes.state,
        rId: attributes["r:id"],
      }));
    if (relationships.length === 0 || sheets.length === 0 || sheets.some((sheet) => !Number.isSafeInteger(sheet.id))) {
      throw new Error("Excel workbook has invalid worksheet metadata");
    }

    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      worksheets: "emit",
      sharedStrings: "emit",
      hyperlinks: "ignore",
      styles: "ignore",
    });
    const internalReader = reader as unknown as {
      model?: { sheets: typeof sheets };
      workbookRels?: typeof relationships;
    };
    internalReader.model = { sheets };
    internalReader.workbookRels = relationships;
    return reader;
  }

  private static csvParser(
    filePath: string,
    options: { startByteOffset?: number; delimiter?: string; includeInfo?: boolean } = {},
  ) {
    const startByteOffset = options.startByteOffset ?? 0;
    const delimiter = options.delimiter || this.detectCsvDelimiter(filePath, startByteOffset);
    return fs.createReadStream(filePath, startByteOffset > 0 ? { start: startByteOffset } : undefined).pipe(parse({
      bom: startByteOffset === 0,
      delimiter,
      skip_empty_lines: true,
      // Preserve ragged records so the row-level quality pass can quarantine
      // them instead of aborting an otherwise usable large file.
      relax_column_count: true,
      ...(options.includeInfo ? { info: true } : {}),
    }));
  }

  private static isEmptyCsvRecord(record: unknown[]): boolean {
    return record.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
  }

  public static parseTypedIdentifier(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  public static parseTypedNumeric(value: unknown, options?: { locale?: "id" | "en" | "auto" }): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    let s = String(value).trim();
    if (s === "" || s === "-" || s === "--" || s.toLowerCase() === "n/a" || s.toLowerCase() === "null") {
      return null;
    }
    // Strip currency symbols and whitespace
    s = s.replace(/^(rp\.?|idr|\$|usd|eur|€|£|¥)\s*/i, "")
      .replace(/\s*(idr|usd|eur)$/i, "")
      .trim();

    let isPercent = false;
    if (s.endsWith("%")) {
      isPercent = true;
      s = s.slice(0, -1).trim();
    }

    const hasDot = s.includes(".");
    const hasComma = s.includes(",");

    if (hasDot && hasComma) {
      const lastDot = s.lastIndexOf(".");
      const lastComma = s.lastIndexOf(",");
      if (lastDot < lastComma) {
        // Indonesian / German e.g. 1.234.567,89 -> dot thousands, comma decimal
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        // US / UK e.g. 1,234,567.89 -> comma thousands, dot decimal
        s = s.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      const parts = s.split(",");
      if (parts.length > 2) {
        s = s.replace(/,/g, "");
      } else if (options?.locale === "id" || parts[1]?.length !== 3 || parts[0].length === 0) {
        s = s.replace(",", ".");
      } else {
        if (/^\d{1,3}$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
          s = s.replace(",", "");
        } else {
          s = s.replace(",", ".");
        }
      }
    } else if (hasDot && !hasComma) {
      const parts = s.split(".");
      if (parts.length > 2) {
        s = s.replace(/\./g, "");
      } else if (options?.locale === "id" && /^\d{1,3}$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
        s = s.replace(/\./g, "");
      }
    }

    s = s.replace(/\s+/g, "");
    const num = Number(s);
    if (!Number.isFinite(num)) {
      return null;
    }
    return isPercent ? num / 100 : num;
  }

  public static parseTypedDate(
    value: unknown,
    options?: { excelDateSystem?: "1900" | "1904" },
  ): { iso: string; raw: string } | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : { iso: value.toISOString(), raw: value.toISOString() };
    }
    if (typeof value === "number") {
      // Excel serial date range: ~1 (Jan 1 1900) to ~2958465 (Dec 31 9999)
      if (value > 0 && value < 3000000) {
        const epoch = options?.excelDateSystem === "1904"
          ? new Date(Date.UTC(1904, 0, 1))
          : new Date(Date.UTC(1899, 11, 30));
        const millis = epoch.getTime() + Math.round(value * 86400 * 1000);
        const d = new Date(millis);
        if (!isNaN(d.getTime())) {
          return { iso: d.toISOString(), raw: String(value) };
        }
      }
      return null;
    }

    const s = String(value).trim();
    if (!s || s.length < 4) return null;

    // ISO format: YYYY-MM-DD
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (isoMatch) {
      const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T00:00:00.000Z`);
      if (!isNaN(d.getTime())) return { iso: d.toISOString(), raw: s };
    }

    // Indonesian/European format: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
    const dmyMatch = /^(\d{1,2})[/\.-](\d{1,2})[/\.-](\d{4})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (dmyMatch) {
      const day = Number(dmyMatch[1]);
      const month = Number(dmyMatch[2]);
      const year = Number(dmyMatch[3]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const hours = dmyMatch[4] ? Number(dmyMatch[4]) : 0;
        const minutes = dmyMatch[5] ? Number(dmyMatch[5]) : 0;
        const seconds = dmyMatch[6] ? Number(dmyMatch[6]) : 0;
        const d = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
        // Date.UTC normalizes invalid dates (for example, February 31) into
        // the following month, so compare the parsed components before accepting.
        if (
          !isNaN(d.getTime()) &&
          d.getUTCFullYear() === year &&
          d.getUTCMonth() === month - 1 &&
          d.getUTCDate() === day &&
          hours <= 23 && minutes <= 59 && seconds <= 59
        ) {
          return { iso: d.toISOString(), raw: s };
        }
      }
    }

    // Accept common human-readable month formats, but never let Date.parse
    // infer a date from arbitrary text (for example, "catatan-1001").
    const namedMonthDate = /^(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4}))(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|UTC|GMT)?)?$/i.exec(s);
    if (namedMonthDate) {
      const monthName = namedMonthDate[1] ?? namedMonthDate[5];
      const day = Number(namedMonthDate[2] ?? namedMonthDate[4]);
      const year = Number(namedMonthDate[3] ?? namedMonthDate[6]);
      const monthStart = Date.parse(`${monthName} 1, ${year} UTC`);
      if (!isNaN(monthStart)) {
        const month = new Date(monthStart).getUTCMonth();
        let hour = Number(namedMonthDate[7] ?? 0);
        const minute = Number(namedMonthDate[8] ?? 0);
        const second = Number(namedMonthDate[9] ?? 0);
        const meridiem = namedMonthDate[10]?.toUpperCase();
        if (meridiem === "AM" || meridiem === "PM") {
          if (hour < 1 || hour > 12) return null;
          hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
        }
        const parsedDate = new Date(0);
        parsedDate.setUTCFullYear(year, month, day);
        parsedDate.setUTCHours(hour, minute, second, 0);
        if (
          year >= 1 && year <= 9999 &&
          day >= 1 && day <= 31 &&
          hour >= 0 && hour <= 23 &&
          minute <= 59 && second <= 59 &&
          parsedDate.getUTCFullYear() === year &&
          parsedDate.getUTCMonth() === month &&
          parsedDate.getUTCDate() === day
        ) {
          return { iso: parsedDate.toISOString(), raw: s };
        }
      }
    }

    return null;
  }

  private static normalizeCsvValue(
    value: unknown,
    column: ColumnDefinition,
    rowNumber: number,
    qualityCounters?: IngestionQualityCounters,
    deferredTemporalBounds?: Record<string, { minDate?: string; maxDate?: string }>,
  ): unknown {
    if (value === null || value === undefined || String(value).trim() === "") {
      if (qualityCounters) {
        qualityCounters.nullValueCount[column.name] = (qualityCounters.nullValueCount[column.name] || 0) + 1;
      }
      return null;
    }
    if (column.role === "identifier" || column.semanticCategory === "identity") {
      return this.parseTypedIdentifier(value);
    }
    if (column.dataType === "number") {
      const parsedNumber = typeof value === "number" ? (Number.isFinite(value) ? value : null) : this.parseTypedNumeric(value);
      if (parsedNumber === null) {
        if (qualityCounters) {
          qualityCounters.typeViolations += 1;
          qualityCounters.sampleErrors = qualityCounters.sampleErrors || [];
          if (qualityCounters.sampleErrors.length < 10) {
            qualityCounters.sampleErrors.push({
              rowNumber,
              column: column.name,
              error: `Invalid numeric value in column '${column.name}'`,
            });
          }
          return null;
        }
        throw new Error(`CSV row ${rowNumber} has a non-numeric value in column '${column.name}'`);
      }
      return parsedNumber;
    }
    if (column.dataType === "boolean") {
      if (typeof value === "boolean") return value;
      const normalized = String(value).trim().toLowerCase();
      if (["true", "1", "yes", "ya"].includes(normalized)) return true;
      if (["false", "0", "no", "tidak"].includes(normalized)) return false;
      if (qualityCounters) {
        qualityCounters.typeViolations += 1;
        qualityCounters.sampleErrors = qualityCounters.sampleErrors || [];
        if (qualityCounters.sampleErrors.length < 10) {
            qualityCounters.sampleErrors.push({
              rowNumber,
              column: column.name,
              error: `Invalid boolean value in column '${column.name}'`,
          });
        }
        return null;
      }
      throw new Error(`CSV row ${rowNumber} has a non-boolean value in column '${column.name}'`);
    }
    if (column.dataType === "date" || column.role === "timestamp") {
      const parsedDate = this.parseTypedDate(value);
      if (parsedDate) {
        if (deferredTemporalBounds) updateDeferredTemporalBounds(deferredTemporalBounds, column.name, parsedDate.iso);
        else if (qualityCounters) updateTemporalBounds(qualityCounters, column.name, parsedDate.iso);
        return parsedDate.iso;
      }
      if (qualityCounters) {
        qualityCounters.typeViolations += 1;
        qualityCounters.sampleErrors = qualityCounters.sampleErrors || [];
        if (qualityCounters.sampleErrors.length < 10) {
          qualityCounters.sampleErrors.push({
            rowNumber,
            column: column.name,
            error: `Invalid date value in column '${column.name}'`,
          });
        }
        return null;
      }
    }
    return String(value);
  }

  private static excelCellValue(value: unknown, sharedStrings?: unknown[]): unknown {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
    if (!value || typeof value !== "object") return value;
    const cell = value as Record<string, unknown>;
    if ("result" in cell) return this.excelCellValue(cell.result, sharedStrings);
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => String((part as Record<string, unknown>)?.text ?? "")).join("");
    }
    if (typeof cell.text === "string") return cell.text;
    if (typeof cell.sharedString === "number") {
      const resolved = sharedStrings?.[cell.sharedString];
      return resolved === undefined ? String(cell.sharedString) : this.excelCellValue(resolved, sharedStrings);
    }
    if (typeof cell.error === "string") return cell.error;
    return value;
  }

  private static excelRowRecord(row: { values?: unknown[] | Record<string, unknown> }, sharedStrings?: unknown[]): string[] {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const record = values.map((value) => {
      const normalized = this.excelCellValue(value, sharedStrings);
      return normalized === null || normalized === undefined ? "" : String(normalized);
    });
    while (record.length > 0 && record[record.length - 1] === "") record.pop();
    return record;
  }

  private static async *excelWorkbookEvents(reader: { parse: () => AsyncIterator<unknown> }): AsyncGenerator<unknown> {
    const parser = reader.parse();
    while (true) {
      const next = await parser.next();
      if (next.done) return;
      yield next.value;
    }
  }

  /** Profile bounded sample rows, while counting the full CSV without retaining it. */
  static async profileCsvFile(
    filePath: string,
    tableName: string,
    options?: ParseStructuredOptions,
  ): Promise<ParsedTableData> {
    const sampleGrid: string[][] = [];
    let firstRecordIsHeader: boolean | null = null;
    let dataRowCount = 0;

    for await (const rawRecord of this.csvParser(filePath)) {
      const record = Array.from(rawRecord as unknown[]).map((cell) => String(cell ?? ""));
      if (this.isEmptyCsvRecord(record)) continue;
      if (firstRecordIsHeader === null) {
        firstRecordIsHeader = !this.isRowDataRatherThanHeader(record);
      }
      const isHeader = sampleGrid.length === 0 && firstRecordIsHeader;
      if (sampleGrid.length < this.STREAM_SAMPLE_ROWS + (firstRecordIsHeader ? 1 : 0)) {
        sampleGrid.push(record);
      }
      if (!isHeader) dataRowCount += 1;
      if (dataRowCount > 0 && dataRowCount % 100_000 === 0) {
        await options?.onProgress?.(dataRowCount);
      }
    }

    if (dataRowCount > 0 && dataRowCount % 100_000 !== 0) await options?.onProgress?.(dataRowCount);

    if (sampleGrid.length === 0) {
      const empty = this.profileAndBuildTable(tableName, []);
      return { ...empty, rowCount: 0 };
    }

    const parsed = this.parseCsvRows(sampleGrid, tableName, options);
    const sampleQualityCounters = emptyQualityCounters();
    const normalizedSampleRows: Record<string, unknown>[] = [];
    for (const [index, row] of parsed.rows.slice(0, this.STREAM_SAMPLE_ROWS).entries()) {
      const violationsBeforeRow = sampleQualityCounters.typeViolations;
      const rowTemporalBounds: Record<string, { minDate?: string; maxDate?: string }> = {};
      const normalized = Object.fromEntries(parsed.columns.map((column) => [
        column.name,
        this.normalizeCsvValue(row[column.name], column, index + 1, sampleQualityCounters, rowTemporalBounds),
      ]));
      if (sampleQualityCounters.typeViolations > violationsBeforeRow) continue;
      mergeDeferredTemporalBounds(sampleQualityCounters, rowTemporalBounds);
      normalizedSampleRows.push(normalized);
    }
    parsed.rows = normalizedSampleRows;
    parsed.rowCount = dataRowCount;

    // Re-scan the file after inferring its schema from the bounded sample. This
    // keeps semantic quality counters complete without retaining the dataset.
    const qualityCounters = emptyQualityCounters();
    const duplicateCounts = await countExactDuplicates(
      this.streamCsvRows(filePath, parsed.columns, {}, qualityCounters),
      parsed.columns,
      parsed.semanticModel.primaryKey,
    );
    qualityCounters.duplicateRows = duplicateCounts.duplicateRows;
    qualityCounters.duplicateKeyRows = duplicateCounts.duplicateKeyRows;
    qualityCounters.duplicateDetection = "complete";
    if (qualityCounters.totalRows !== dataRowCount) {
      throw new Error(`CSV quality scan found ${qualityCounters.totalRows} rows; profile found ${dataRowCount}`);
    }
    qualityCounters.quarantinedRows = qualityCounters.invalidRows;
    qualityCounters.publishedRows = qualityCounters.validRows;
    parsed.publishableRowCount = qualityCounters.validRows;
    this.applyFullProfileRowCount(parsed, qualityCounters.totalRows);
    parsed.semanticModel.qualityCounters = qualityCounters;
    const gate = this.verifyMetricRegistryAndGate(parsed.semanticModel);
    parsed.semanticModel.publicationGateStatus = gate.gateStatus;
    parsed.semanticModel.unresolvedDefinitions = gate.unresolvedDefinitions;
    return parsed;
  }

  /** Profile XLSX sheets from the streaming reader while retaining only the semantic sample. */
  static async profileExcelFile(
    filePath: string,
    options?: ParseStructuredOptions,
  ): Promise<ParsedTableData[]> {
    const reader = await this.createExcelWorkbookReader(filePath);
    const tables: ParsedTableData[] = [];
    const sharedStrings: unknown[] = [];
    let totalRowsScanned = 0;

    for await (const event of this.excelWorkbookEvents(reader)) {
      const item = event as { eventType?: string; value?: any; index?: number; text?: unknown };
      // ExcelJS 4.4 yields shared-string { index, text } records directly even
      // though its README describes them as { eventType, value } events.
      if (typeof item.index === "number" && "text" in item) {
        sharedStrings[item.index] = item.text;
        continue;
      }
      if (item.eventType !== "worksheet") continue;
      const worksheet = item.value;
      const sheet = worksheet as typeof worksheet & { name?: string; id?: number };
      const sampleGrid: string[][] = [];
      let firstRecordIsHeader: boolean | null = null;
      let dataRowCount = 0;
      for await (const row of worksheet) {
        const record = this.excelRowRecord(row, sharedStrings);
        if (this.isEmptyCsvRecord(record)) continue;
        if (firstRecordIsHeader === null) firstRecordIsHeader = !this.isRowDataRatherThanHeader(record);
        const isHeader = sampleGrid.length === 0 && firstRecordIsHeader;
        if (sampleGrid.length < this.STREAM_SAMPLE_ROWS + (firstRecordIsHeader ? 1 : 0)) sampleGrid.push(record);
        if (!isHeader) dataRowCount += 1;
        if (dataRowCount > 0 && dataRowCount % 100_000 === 0) {
          await options?.onProgress?.(totalRowsScanned + dataRowCount);
        }
      }
      totalRowsScanned += dataRowCount;
      if (sampleGrid.length === 0) continue;

      const parsed = this.parseCsvRows(sampleGrid, sheet.name || `Sheet${sheet.id}`, options);
      const sampleQualityCounters = emptyQualityCounters();
      const normalizedSampleRows: Record<string, unknown>[] = [];
      for (const [index, row] of parsed.rows.slice(0, this.STREAM_SAMPLE_ROWS).entries()) {
        const violationsBeforeRow = sampleQualityCounters.typeViolations;
        const rowTemporalBounds: Record<string, { minDate?: string; maxDate?: string }> = {};
        const normalized = Object.fromEntries(parsed.columns.map((column) => [
          column.name,
          this.normalizeCsvValue(row[column.name], column, index + 1, sampleQualityCounters, rowTemporalBounds),
        ]));
        if (sampleQualityCounters.typeViolations > violationsBeforeRow) continue;
        mergeDeferredTemporalBounds(sampleQualityCounters, rowTemporalBounds);
        normalizedSampleRows.push(normalized);
      }
      parsed.rows = normalizedSampleRows;
      parsed.rowCount = dataRowCount;
      tables.push(parsed);
    }
    // Re-open each profiled sheet for a complete bounded-memory quality pass.
    // The semantic schema comes from the sample, but counters and publication
    // gates must describe every row, including records after the preview cap.
    for (const table of tables) {
      const qualityCounters = emptyQualityCounters();
      const duplicateCounts = await countExactDuplicates(
        this.streamExcelRows(filePath, table.tableName, table.columns, qualityCounters, table.headerRowPresent),
        table.columns,
        table.semanticModel.primaryKey,
      );
      qualityCounters.duplicateRows = duplicateCounts.duplicateRows;
      qualityCounters.duplicateKeyRows = duplicateCounts.duplicateKeyRows;
      qualityCounters.duplicateDetection = "complete";
      // Header inference can differ between worksheet sampling and a reopened
      // XLSX stream. This normalized stream is the one later loaded to ClickHouse,
      // so its count is the authoritative row count for the semantic model.
      totalRowsScanned += qualityCounters.totalRows - (table.rowCount ?? 0);
      qualityCounters.quarantinedRows = qualityCounters.invalidRows;
      qualityCounters.publishedRows = qualityCounters.validRows;
      table.publishableRowCount = qualityCounters.validRows;
      this.applyFullProfileRowCount(table, qualityCounters.totalRows);
      table.semanticModel.qualityCounters = qualityCounters;
      const gate = this.verifyMetricRegistryAndGate(table.semanticModel);
      table.semanticModel.publicationGateStatus = gate.gateStatus;
      table.semanticModel.unresolvedDefinitions = gate.unresolvedDefinitions;
    }
    if (totalRowsScanned > 0 && totalRowsScanned % 100_000 !== 0) {
      await options?.onProgress?.(totalRowsScanned);
    }
    return tables;
  }

  /** Stream normalized CSV rows again after schema profiling has completed. */
  static async *streamCsvRows(
    filePath: string,
    columns: ColumnDefinition[],
    resume: { byteOffset?: number; rowsCommitted?: number; delimiter?: string } = {},
    qualityCounters?: IngestionQualityCounters,
  ): AsyncGenerator<Record<string, unknown>> {
    const byteOffset = resume.byteOffset ?? 0;
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error("CSV resume byte offset is invalid");
    const rowsCommitted = resume.rowsCommitted ?? 0;
    if (!Number.isSafeInteger(rowsCommitted) || rowsCommitted < 0) throw new Error("CSV resume row count is invalid");
    if (byteOffset > 0 && !resume.delimiter) throw new Error("CSV resume checkpoint is missing its detected delimiter");
    let firstRecord = byteOffset === 0;
    let firstRecordIsHeader = false;
    let rowNumber = rowsCommitted;
    const counters = qualityCounters ?? emptyQualityCounters();
    const parser = this.csvParser(filePath, {
      startByteOffset: byteOffset,
      delimiter: resume.delimiter,
      includeInfo: true,
    });
    for await (const parsedRecord of parser) {
      const parsed = parsedRecord as { record: unknown[]; info: { bytes: number } };
      const rawRecord = parsed.record;
      const record = Array.from(rawRecord as unknown[]).map((cell) => String(cell ?? ""));
      if (this.isEmptyCsvRecord(record)) continue;
      if (firstRecord) {
        firstRecordIsHeader = !this.isRowDataRatherThanHeader(record);
        firstRecord = false;
        if (firstRecordIsHeader) continue;
      }
      rowNumber += 1;
      counters.totalRows += 1;
      if (record.length !== columns.length) {
        counters.invalidRows += 1;
        counters.typeViolations += 1;
        const affectedColumns = record.length < columns.length
          ? columns.slice(record.length).map((column) => column.name)
          : ["__field_count__"];
        recordQuarantinedRow(counters, rowNumber, affectedColumns, "field_count");
        continue;
      }
      const violationsBeforeRow = counters.typeViolations;
      const row: Record<string, unknown> = {};
      const invalidColumns: string[] = [];
      const rowTemporalBounds: Record<string, { minDate?: string; maxDate?: string }> = {};
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        const violationsBeforeCell = counters.typeViolations;
        row[column.name] = this.normalizeCsvValue(record[index], column, rowNumber, counters, rowTemporalBounds);
        if (counters.typeViolations > violationsBeforeCell) invalidColumns.push(column.name);
      }
      if (counters.typeViolations > violationsBeforeRow) {
        counters.invalidRows += 1;
        recordQuarantinedRow(counters, rowNumber, invalidColumns, "type_violation");
        continue;
      }
      counters.validRows += 1;
      mergeDeferredTemporalBounds(counters, rowTemporalBounds);
      const detectedDelimiter = resume.delimiter
        || (parser as unknown as { options?: { delimiter?: Buffer[] } }).options?.delimiter?.[0]?.toString("utf8")
        || ",";
      attachCsvSourceRowCheckpoint(row, {
        byteOffset: byteOffset + parsed.info.bytes,
        rowNumber,
        delimiter: detectedDelimiter,
      });
      yield row;
    }
  }

  /** Re-read one XLSX sheet and normalize its records using the profiled column schema. */
  static async *streamExcelRows(
    filePath: string,
    sheetName: string,
    columns: ColumnDefinition[],
    qualityCounters?: IngestionQualityCounters,
    headerRowPresent?: boolean,
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = await this.createExcelWorkbookReader(filePath);
    const sharedStrings: unknown[] = [];
    let firstNonEmptyRecord = true;
    let rowNumber = 0;
    let foundSheet = false;
    const counters = qualityCounters ?? emptyQualityCounters();
    for await (const event of this.excelWorkbookEvents(reader)) {
      const item = event as { eventType?: string; value?: any; index?: number; text?: unknown };
      if (typeof item.index === "number" && "text" in item) {
        sharedStrings[item.index] = item.text;
        continue;
      }
      if (item.eventType !== "worksheet") continue;
      const worksheet = item.value;
      const sheet = worksheet as typeof worksheet & { name?: string };
      if (sheet.name === sheetName) foundSheet = true;
      for await (const rawRow of worksheet) {
        if (sheet.name !== sheetName) continue;
        const record = this.excelRowRecord(rawRow, sharedStrings);
        if (this.isEmptyCsvRecord(record)) continue;
        if (firstNonEmptyRecord) {
          firstNonEmptyRecord = false;
          const isHeader = headerRowPresent ?? !this.isRowDataRatherThanHeader(record);
          if (isHeader) continue;
        }
        rowNumber += 1;
        counters.totalRows += 1;
        if (record.length > columns.length) {
          counters.invalidRows += 1;
          counters.typeViolations += 1;
          recordQuarantinedRow(counters, rowNumber, ["__field_count__"], "field_count");
          continue;
        }
        const violationsBeforeRow = counters.typeViolations;
        const row: Record<string, unknown> = {};
        const invalidColumns: string[] = [];
        const rowTemporalBounds: Record<string, { minDate?: string; maxDate?: string }> = {};
        for (let index = 0; index < columns.length; index += 1) {
          const violationsBeforeCell = counters.typeViolations;
          row[columns[index].name] = this.normalizeCsvValue(
            record[index] ?? "",
            columns[index],
            rowNumber,
            counters,
            rowTemporalBounds,
          );
          if (counters.typeViolations > violationsBeforeCell) invalidColumns.push(columns[index].name);
        }
        if (counters.typeViolations > violationsBeforeRow) {
          counters.invalidRows += 1;
          recordQuarantinedRow(counters, rowNumber, invalidColumns, "type_violation");
          continue;
        }
        counters.validRows += 1;
        mergeDeferredTemporalBounds(counters, rowTemporalBounds);
        yield row;
      }
    }
    if (!foundSheet) throw new Error(`Excel sheet '${sheetName}' no longer exists`);
  }

  /** Parse a bounded array-of-arrays sample using the same header and semantic profiler as XLSX. */
  static parseCsvRows(
    rows: unknown[][],
    tableName = "Sheet1",
    options?: ParseStructuredOptions,
  ): ParsedTableData {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const firstRow = Array.isArray(rows[0]) ? rows[0] : [];
    const sourceHeaderWidth = firstRow.length > 0 && !this.isRowDataRatherThanHeader(firstRow)
      ? firstRow.length
      : undefined;
    return this.parseWorksheet(worksheet, tableName, {
      ...options,
      ...(sourceHeaderWidth ? { sourceHeaderWidth } : {}),
    });
  }

  /**
   * Parse CSV content from string or buffer with smart header detection and enterprise catalog resolution
   */
  static parseCsv(content: string, tableName = "Sheet1", options?: ParseStructuredOptions): ParsedTableData {
    this.assertInMemoryCompatibilityBytes(Buffer.byteLength(content, "utf8"));
    // Strip UTF-8 BOM if present
    const cleanContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const workbook = XLSX.read(cleanContent, { type: "string" });
    const sheetName = tableName && tableName !== "Sheet1" ? tableName : (workbook.SheetNames[0] || tableName);
    const worksheet = workbook.Sheets[workbook.SheetNames[0] || "Sheet1"];
    return this.parseWorksheet(worksheet, tableName || sheetName, options);
  }

  /**
   * Parse Excel buffer (supports multi-sheet XLS / XLSX) with smart header detection and enterprise catalog resolution
   */
  static parseExcel(buffer: Buffer, options?: ParseStructuredOptions): ParsedTableData[] {
    this.assertInMemoryCompatibilityBytes(buffer.byteLength);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const results: ParsedTableData[] = [];

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const parsed = this.parseWorksheet(worksheet, sheetName, options);
      if (parsed.rows.length > 0) {
        results.push(parsed);
      }
    }

    return results;
  }

  /**
   * Checks whether the first row represents actual record data rather than column headers.
   * A row is considered data ONLY when the vast majority of cells are pure numbers,
   * dates, or email/phone data values rather than header labels.
   */
  static isRowDataRatherThanHeader(row: any[]): boolean {
    if (!row || row.length === 0) return true;
    let dataSignals = 0;
    let labelSignals = 0;
    let totalNonEmpty = 0;

    for (const cell of row) {
      if (cell === null || cell === undefined || cell === "") continue;
      totalNonEmpty++;
      const s = String(cell).replace(/^\ufeff/, "").trim();

      // 1. Pure number (integer or float)
      if (typeof cell === "number" || (!isNaN(Number(s)) && !isNaN(parseFloat(s)))) {
        dataSignals++;
        continue;
      }
      // 2. Email address
      if (s.includes("@") && s.includes(".")) {
        dataSignals++;
        continue;
      }
      // 3. Full Date pattern (e.g. 2023-01-01 or 01/01/2023)
      if (StructuredIngestionService.parseTypedDate(s) !== null) {
        dataSignals++;
        continue;
      }
      // 4. Pure phone number
      if (/^\+?\d{9,15}$/.test(s.replace(/[\s-]/g, ""))) {
        dataSignals++;
        continue;
      }

      // If it looks like a text label or column title (alphabetic identifier)
      if (/^[a-zA-Z_][a-zA-Z0-9_\s\.\-]*$/.test(s) && s.length <= 40) {
        labelSignals++;
      }
    }

    if (totalNonEmpty === 0) return false;
    // Row is data only if majority of columns are numeric/date data AND almost no label signals
    return dataSignals > labelSignals && (dataSignals / totalNonEmpty) >= 0.6;
  }

  /**
   * Synthesizes clean semantic column names when dataset is truly headerless
   */
  private static inferColumnNamesFromGrid(grid: any[][], colCount: number): string[] {
    const names: string[] = [];
    const sampleRows = grid.slice(0, 20);

    for (let c = 0; c < colCount; c++) {
      const samples = sampleRows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== "");
      names.push(this.inferSingleColumnName(c, samples));
    }
    return names;
  }

  private static inferSingleColumnName(colIdx: number, samples: any[]): string {
    if (samples.length === 0) return `col_${colIdx + 1}`;

    if (samples.some((v) => typeof v === "string" && v.includes("@") && v.includes("."))) {
      return `email_${colIdx + 1}`;
    }
    if (samples.every((v) => /^\d{5}$/.test(String(v).trim()))) {
      return `postal_code_${colIdx + 1}`;
    }
    if (samples.some((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) {
      return `date_${colIdx + 1}`;
    }
    if (colIdx === 0 && samples.every((v) => !isNaN(Number(v)))) {
      return "id";
    }
    return `col_${colIdx + 1}`;
  }

  /**
   * Smart worksheet parser supporting header detection, catalog resolution, and anomaly recovery
   */
  private static parseWorksheet(
    worksheet: XLSX.WorkSheet,
    tableName: string,
    options?: ParseStructuredOptions,
  ): ParsedTableData {
    const rangeReference = worksheet["!ref"];
    if (typeof rangeReference === "string") {
      const range = XLSX.utils.decode_range(rangeReference);
      this.assertInMemoryCompatibilityShape(
        range.e.r - range.s.r + 1,
        range.e.c - range.s.c + 1,
      );
    }
    const rawGrid = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: null });
    const grid = rawGrid.filter((row) => row && row.some((cell) => cell !== null && cell !== undefined && cell !== ""));

    if (grid.length === 0) {
      return this.profileAndBuildTable(tableName, []);
    }

    const row0 = grid[0];
    const isData = this.isRowDataRatherThanHeader(row0);

    let columnNames: string[] = [];
    let dataRows: Record<string, any>[] = [];

    const normName = tableName.toLowerCase().replace(/[^a-z0-9_]/g, "_");

    // Check known columns from options or dynamic catalogMap
    let knownCols = options?.knownColumns;
    if (!knownCols && options?.catalogMap) {
      knownCols = options.catalogMap.get(normName) || options.catalogMap.get(tableName.toLowerCase());
      if (!knownCols) {
        // Dynamic search in catalogMap by name similarity or matching column count with name overlap
        const normTokens = normName.split(/[_\-\s]+/).filter((w) => w.length >= 3);
        for (const [catName, cols] of options.catalogMap.entries()) {
          if (cols.length === row0.length) {
            const catTokens = catName.split(/[_\-\s]+/).filter((w) => w.length >= 3);
            const hasCommonToken = normTokens.some((nt) => catTokens.includes(nt));
            if (hasCommonToken || catName.includes(normName) || normName.includes(catName)) {
              knownCols = cols;
              break;
            }
          }
        }
      }
    }

    if (isData) {
      // Row 0 is data! No header in file!
      const colCount = Math.max(...grid.slice(0, 10).map((r) => r.length));

      if (knownCols && knownCols.length === colCount) {
        columnNames = [...knownCols];
      } else {
        columnNames = this.inferColumnNamesFromGrid(grid, colCount);
      }

      // Convert all rows (including row 0!) into Record<string, any>
      dataRows = grid.map((row) => {
        const obj: Record<string, any> = {};
        for (let c = 0; c < columnNames.length; c++) {
          obj[columnNames[c]] = row[c] ?? null;
        }
        return obj;
      });
    } else {
      // Row 0 is header!
      const headerCells = Number.isSafeInteger(options?.sourceHeaderWidth) && options!.sourceHeaderWidth! > 0
        ? row0.slice(0, options!.sourceHeaderWidth)
        : row0;
      const rawHeaders = headerCells.map((cell, idx) => {
        const str = String(cell || "").replace(/^\ufeff/, "").trim();
        return str || `col_${idx + 1}`;
      });

      const seen = new Set<string>();
      columnNames = rawHeaders.map((h) => {
        let name = h;
        let count = 1;
        while (seen.has(name.toLowerCase())) {
          name = `${h}_${count++}`;
        }
        seen.add(name.toLowerCase());
        return name;
      });

      // Data rows start from row 1
      dataRows = grid.slice(1).map((row) => {
        const obj: Record<string, any> = {};
        for (let c = 0; c < columnNames.length; c++) {
          obj[columnNames[c]] = row[c] ?? null;
        }
        return obj;
      });
    }

    const parsed = this.profileAndBuildTable(tableName, dataRows);
    parsed.headerRowPresent = !isData;
    return parsed;
  }

  /**
   * Synthesize semantic model directly from rows, useful for external or in-memory tables.
   */
  synthesizeSemanticModel(
    tableName: string,
    rawRows: Record<string, any>[],
    options?: { primaryKey?: string },
  ): TableSemanticModel {
    return StructuredIngestionService.profileAndBuildTable(tableName, rawRows, options).semanticModel;
  }

  /**
   * Deterministic Profiler & Semantic Model Builder
   */
  static profileAndBuildTable(
    tableName: string,
    rawRows: Record<string, any>[],
    options?: { primaryKey?: string },
  ): ParsedTableData {
    if (rawRows.length === 0) {
      return {
        tableName,
        columns: [],
        semanticModel: {
          tableName,
          description: `Empty table ${tableName}`,
          dimensions: [],
          metrics: [],
          synonyms: {},
        },
        rows: [],
      };
    }

    // Standardize column keys
    const rawKeys = Object.keys(rawRows[0] || {});
    this.assertInMemoryCompatibilityShape(rawRows.length, rawKeys.length);
    let estimatedPayloadBytes = 0;
    for (const row of rawRows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("In-memory structured rows must be plain row objects");
      }
      for (const key of rawKeys) {
        const value = row[key];
        if (typeof value === "string") estimatedPayloadBytes += Buffer.byteLength(value, "utf8");
        else if (Buffer.isBuffer(value)) estimatedPayloadBytes += value.byteLength;
        if (estimatedPayloadBytes > this.MAX_IN_MEMORY_COMPATIBILITY_BYTES) {
          this.assertInMemoryCompatibilityBytes(estimatedPayloadBytes);
        }
      }
    }
    const cleanRows: Record<string, unknown>[] = rawRows.map((row) => {
      const cleanRow: Record<string, unknown> = {};
      for (const key of rawKeys) {
        const cleanKey = key.trim();
        cleanRow[cleanKey] = row[key];
      }
      return cleanRow;
    });

    const columns: ColumnDefinition[] = [];
    const dimensions: { name: string; description: string; sampleValues?: string[] }[] = [];
    const metrics: TableSemanticModel["metrics"] = [];
    const synonyms: Record<string, string[]> = {};
    let primaryKey: string | undefined = options?.primaryKey;

    const rowCount = cleanRows.length;

    for (const rawKey of rawKeys) {
      const colName = rawKey.trim();
      const values = cleanRows.map((r) => r[colName]);

      let nullCount = 0;
      let numberCount = 0;
      let dateCount = 0;
      let booleanCount = 0;
      let stringCount = 0;
      const nonNullValues: any[] = [];
      const distinctSet = new Set<string>();
      let minVal: any = null;
      let maxVal: any = null;

      for (const val of values) {
        if (val === null || val === undefined || val === "") {
          nullCount++;
          continue;
        }

        nonNullValues.push(val);
        distinctSet.add(String(val));

        if (typeof val === "boolean" || val === "true" || val === "false") {
          booleanCount++;
        } else if (typeof val === "number" || (!isNaN(Number(val)) && typeof val === "string" && val.trim() !== "")) {
          numberCount++;
          const num = Number(val);
          if (minVal === null || num < minVal) minVal = num;
          if (maxVal === null || num > maxVal) maxVal = num;
        } else if (typeof val === "string" && StructuredIngestionService.parseTypedDate(val) !== null) {
          dateCount++;
          const parsedDate = StructuredIngestionService.parseTypedDate(val)!;
          const d = new Date(parsedDate.iso).getTime();
          if (minVal === null || d < minVal) minVal = val;
          if (maxVal === null || d > maxVal) maxVal = val;
        } else {
          stringCount++;
        }
      }

      const nonNullTotal = nonNullValues.length;
      let dataType: "string" | "number" | "boolean" | "date" | "unknown" = "string";

      if (nonNullTotal > 0) {
        if (numberCount / nonNullTotal >= 0.7) {
          dataType = "number";
        } else if (dateCount / nonNullTotal >= 0.7) {
          dataType = "date";
        } else if (booleanCount / nonNullTotal >= 0.7) {
          dataType = "boolean";
        } else {
          dataType = "string";
        }
      }

      const distinctCount = distinctSet.size;
      const nullRatio = rowCount > 0 ? nullCount / rowCount : 0;
      const sampleValues = Array.from(distinctSet).slice(0, 5);

      // Determine role
      const lowerName = colName.toLowerCase();
      let role: "dimension" | "metric" | "identifier" | "timestamp" | "attribute" = "dimension";

      if (
        (lowerName === "id" || lowerName.endsWith("_id") || lowerName.startsWith("id_") || lowerName.startsWith("kd_") || lowerName.includes("kode") || lowerName.includes("code") || lowerName.includes("sku") || lowerName === "uid") &&
        (distinctCount / (nonNullTotal || 1) > 0.6 || lowerName === "id" || lowerName.startsWith("kd_"))
      ) {
        role = "identifier";
        if (!primaryKey && (distinctCount === rowCount || lowerName === "id")) {
          primaryKey = colName;
        }
      } else if (
        dataType === "date" ||
        lowerName.includes("date") ||
        lowerName.includes("tanggal") ||
        lowerName.includes("created_at") ||
        lowerName.includes("time") ||
        lowerName.includes("tahun") ||
        lowerName.endsWith("_thn") ||
        lowerName.includes("thn") ||
        lowerName.includes("year")
      ) {
        role = "timestamp";
      } else if (
        lowerName.includes("pos") ||
        lowerName.includes("kodepos") ||
        lowerName.includes("telp") ||
        lowerName.includes("phone") ||
        lowerName.includes("fax") ||
        lowerName.includes("hp") ||
        lowerName.includes("area") ||
        lowerName.includes("kota") ||
        lowerName.includes("wilayah") ||
        lowerName.includes("kanwil") ||
        lowerName.includes("organisasi") ||
        lowerName.includes("npwp") ||
        lowerName.includes("nik")
      ) {
        role = "dimension";
      } else if (
        dataType === "number" &&
        distinctCount >= 1 &&
        (lowerName.includes("price") ||
          lowerName.includes("harga") ||
          lowerName.includes("sales") ||
          lowerName.includes("revenue") ||
          lowerName.includes("omzet") ||
          lowerName.includes("pendapatan") ||
          lowerName.includes("qty") ||
          lowerName.includes("quantity") ||
          lowerName.includes("jumlah") ||
          lowerName.includes("total") ||
          lowerName.includes("amount") ||
          lowerName.includes("cost") ||
          lowerName.includes("biaya") ||
          lowerName.includes("profit") ||
          lowerName.includes("laba") ||
          lowerName.includes("discount") ||
          lowerName.includes("diskon") ||
          lowerName.includes("score") ||
          lowerName.includes("nilai") ||
          lowerName.includes("nominal"))
      ) {
        role = "metric";
      } else if (
        lowerName.includes("alamat") ||
        lowerName.includes("email") ||
        lowerName.includes("gedung") ||
        lowerName.includes("sk_") ||
        lowerName.includes("keterangan") ||
        lowerName.includes("description") ||
        lowerName.includes("catatan") ||
        lowerName.includes("hint") ||
        lowerName.includes("password")
      ) {
        role = "attribute";
      } else {
        role = "dimension";
      }

      const semanticCategory = this.determineSemanticCategory(colName, dataType, role === "identifier");
      const humanLabel = this.humanizeLabel(colName);
      const isSearchable = this.isSearchableColumn(colName, role, semanticCategory);

      columns.push({
        name: colName,
        dataType,
        nullCount,
        nullRatio,
        distinctCount,
        min: minVal,
        max: maxVal,
        sampleValues,
        role,
        semanticCategory,
        humanLabel,
        isSearchable,
      });

      // Semantic model building
      if (role === "metric") {
        metrics.push({
          name: colName,
          physicalColumn: colName,
          expression: `SUM("${colName}")`,
          description: `Total sum of ${colName}`,
          aggregation: "sum",
          grain: primaryKey ? `per_${primaryKey}` : "per_record",
          nullPolicy: "zero",
          provenance: "inferred",
          publicationGateStatus: "pending",
        });
      } else if (role === "dimension" || role === "timestamp") {
        dimensions.push({
          name: colName,
          description: `Categorical dimension ${colName}`,
          sampleValues: sampleValues.map(String),
        });
      }

      // Generate dynamic synonyms from column name tokens and humanized labels
      const synList: string[] = [colName.toLowerCase()];
      const human = this.humanizeLabel(colName).toLowerCase();
      if (human !== colName.toLowerCase()) {
        synList.push(human);
      }
      const parts = colName.split(/[_\-\s]+/).filter((w) => w.length >= 2);
      for (const p of parts) {
        synList.push(p.toLowerCase());
      }
      if (lowerName.includes("sales") || lowerName.includes("revenue")) {
        synList.push("penjualan", "omzet", "pendapatan", "revenue");
      }
      if (lowerName.includes("price") || lowerName.includes("harga")) {
        synList.push("harga", "price", "nilai satuan");
      }
      if (lowerName.includes("profit") || lowerName.includes("laba")) {
        synList.push("keuntungan", "profit", "laba", "margin");
      }
      if (lowerName.includes("qty") || lowerName.includes("quantity") || lowerName.includes("jumlah")) {
        synList.push("jumlah", "kuantitas", "volume", "banyaknya", "quantity", "qty");
      }
      if (lowerName.includes("date") || lowerName.includes("tanggal")) {
        synList.push("tanggal", "waktu", "periode", "date");
      }
      if (lowerName.includes("customer") || lowerName.includes("pelanggan")) {
        synList.push("pelanggan", "klien", "customer", "buyer");
      }
      if (lowerName.includes("region") || lowerName.includes("wilayah") || lowerName.includes("cabang") || lowerName.includes("branch")) {
        synList.push("wilayah", "area", "lokasi", "cabang", "region", "branch");
      }
      synonyms[colName] = Array.from(new Set(synList));
    }

    if (metrics.length === 0) {
      metrics.push({
        name: "total_records",
        physicalColumn: primaryKey || (columns[0]?.name ?? "*"),
        expression: "COUNT(*)",
        description: `Total count of records in ${tableName}`,
        aggregation: "count",
        grain: primaryKey ? `per_${primaryKey}` : "per_record",
        nullPolicy: "zero",
        provenance: "inferred",
        publicationGateStatus: "pending",
      });
    }

    const cleanTableName = tableName.replace(/^(tbl_|table_|tb_|m_|t_)/i, "").toLowerCase();
    const tableWords = cleanTableName.split(/[\s_\-]+/).filter((w) => w.length > 2);
    const entities = Array.from(
      new Set([
        this.humanizeLabel(cleanTableName),
        ...tableWords.map((w) => this.humanizeLabel(w)),
      ]),
    );

    const searchableColumns = columns
      .filter((c) => c.isSearchable || c.role === "identifier" || c.semanticCategory === "identity")
      .map((c) => c.name);

    // Generate ClickHouse Schema Definition for OLAP storage
    const chTypes: Record<string, string> = {
      number: "Float64",
      date: "String",
      boolean: "UInt8",
      string: "String",
      json: "String",
      unknown: "String",
    };

    const columnTypes: Record<string, string> = {};
    for (const c of columns) {
      let chType = chTypes[c.dataType] || "String";
      if (
        c.dataType === "number" &&
        (c.semanticCategory === "financial" ||
          /(price|harga|sales|revenue|omzet|pendapatan|cost|profit|nominal|modal|saldo|pajak|tarif|disetor|balance|amount)/i.test(c.name)) &&
        !/(qty|quantity|count|volume|unit|banyak)/i.test(c.name)
      ) {
        chType = "Decimal(18, 4)";
      }
      c.clickhouseType = chType;
      columnTypes[c.name] = chType;
    }

    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const ddlColumns = columns
      .map((c) => `  \`${c.name}\` ${columnTypes[c.name]}`)
      .join(",\n");

    const orderBy = primaryKey ? [primaryKey] : (columns.length > 0 ? [columns[0].name] : []);
    const orderByClause = orderBy.length > 0 ? `\`${orderBy.join("`, `")}\`` : "tuple()";

    const versionCol = columns.find((c) =>
      /(updated_at|modified_at|version|last_modified|sync_at|ingested_at)/i.test(c.name)
    )?.name;

    const engine = (primaryKey && versionCol) ? "ReplacingMergeTree" : "MergeTree";
    const engineClause = engine === "ReplacingMergeTree"
      ? `ReplacingMergeTree(\`${versionCol}\`)`
      : "MergeTree()";

    const createTableDdl = `CREATE TABLE IF NOT EXISTS \`${sanitizedTableName}\` (\n${ddlColumns}\n) ENGINE = ${engineClause}\nORDER BY (${orderByClause});`;

    // P5-01: Workload-informed projection for fast aggregations on key metrics & dimensions
    const metricCol = columns.find((c) => c.role === "metric" || /(total|amount|revenue|omset|jumlah|harga)/i.test(c.name))?.name;
    const dimCol = columns.find((c) => (c.role === "dimension" || c.name !== primaryKey) && c.name !== metricCol && c.dataType === "string")?.name;
    let projectionDdl: string | undefined;
    if (metricCol && dimCol) {
      projectionDdl = `ALTER TABLE \`${sanitizedTableName}\` ADD PROJECTION IF NOT EXISTS proj_agg (SELECT \`${dimCol}\`, sum(\`${metricCol}\`), count(*) GROUP BY \`${dimCol}\`)`;
    }

    const clickhouseSchema: ClickhouseSchemaDefinition = {
      createTableDdl,
      engine,
      orderBy,
      columnTypes,
      versionColumn: versionCol,
      deduplicationStrategy: engine === "ReplacingMergeTree" ? "final" : "none",
      projectionDdl,
    };

    const humanEntity = tableName.replace(/[^a-zA-Z0-9]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
    const colNames = columns.map((c) => c.name.toLowerCase());
    const tableTopics: string[] = [];
    tableTopics.push(`${humanEntity} Tabular Profile & Data Records`);

    if (colNames.some((c) => /(total|harga|price|modal|nominal|jumlah|amount|omset|revenue|biaya|tarif|billing|saldo|pembayaran|payment|paid)/i.test(c))) {
      tableTopics.push(`${humanEntity} Financial Accounting & Monetary Aggregation`);
    }
    if (colNames.some((c) => /(status|state|kondisi|is_active|aktif|valid|flag|verified|is_)/i.test(c))) {
      tableTopics.push(`${humanEntity} Status & Verification Auditing`);
    }
    if (colNames.some((c) => /(provinsi|kabupaten|kota|kecamatan|kelurahan|wilayah|region|alamat|address|latitude|longitude|geo|postal)/i.test(c))) {
      tableTopics.push(`${humanEntity} Geographic Distribution & Regional Routing`);
    }
    if (colNames.some((c) => /(tanggal|date|created_at|updated_at|waktu|time|period|periode|tahun|bulan|sk_date)/i.test(c))) {
      tableTopics.push(`${humanEntity} Temporal Trends & Historical Timeline`);
    }
    if (colNames.some((c) => /(nama|name|title|judul|kode|code|sku|item|product|produk|customer|pelanggan)/i.test(c))) {
      tableTopics.push(`${humanEntity} Entity Identification & SKU Metadata`);
    }

    const uniqueTopics = Array.from(new Set(tableTopics));
    const tableRole = (metrics.length > 0 && rowCount > 100) ? "fact_table" : "dimension_table";
    const roleDesc = tableRole === "fact_table" ? "Tabel Fakta Kuantitatif" : "Tabel Master Dimensi";
    const context = `${roleDesc} untuk '${humanEntity}'. Memuat ${columns.length} kolom terstruktur dengan ${rowCount.toLocaleString()} baris data untuk pelaporan dan agregasi analitik.`;

    // Compute streaming/full data quality counters with bounded memory
    const qualityCounters = emptyQualityCounters();

    // This synchronous array profiler is restricted to capped small uploads and
    // bounded external samples. Compare canonical identities directly so hash
    // collisions can never classify distinct rows as duplicates. Large files
    // use countExactDuplicates() and its disk-backed external sort instead.
    const seenIdentities = new Set<string>();
    const publishableRows: Record<string, unknown>[] = [];

    for (let rIdx = 0; rIdx < cleanRows.length; rIdx++) {
      const row = cleanRows[rIdx];
      qualityCounters.totalRows += 1;
      const rowTemporalBounds: Record<string, { minDate?: string; maxDate?: string }> = {};
      const normalizedRow: Record<string, unknown> = {};
      const invalidColumns: string[] = [];
      for (const col of columns) {
        const violationsBeforeCell = qualityCounters.typeViolations;
        normalizedRow[col.name] = this.normalizeCsvValue(
          row[col.name],
          col,
          rIdx + 1,
          qualityCounters,
          rowTemporalBounds,
        );
        if (qualityCounters.typeViolations > violationsBeforeCell) invalidColumns.push(col.name);
      }

      if (invalidColumns.length > 0) {
        qualityCounters.invalidRows += 1;
        recordQuarantinedRow(qualityCounters, rIdx + 1, invalidColumns, "type_violation");
        continue;
      }

      qualityCounters.validRows += 1;
      mergeDeferredTemporalBounds(qualityCounters, rowTemporalBounds);

      // Full-dataset duplicate & primary key uniqueness detection is computed
      // over the queryable rows only; a quarantined record cannot poison keys.
      const hasPk = Boolean(primaryKey && row[primaryKey] !== null && row[primaryKey] !== undefined);
      const idKey = hasPk
        ? `pk:${JSON.stringify([typeof row[primaryKey!], row[primaryKey!]])}`
        : `row:${JSON.stringify(columns.map((column) => row[column.name]))}`;
      if (seenIdentities.has(idKey)) {
        qualityCounters.duplicateRows += 1;
        if (hasPk) qualityCounters.duplicateKeyRows = (qualityCounters.duplicateKeyRows || 0) + 1;
      } else {
        seenIdentities.add(idKey);
      }
      publishableRows.push(normalizedRow);
    }
    qualityCounters.quarantinedRows = qualityCounters.invalidRows;
    qualityCounters.publishedRows = qualityCounters.validRows;
    qualityCounters.duplicateDetection = "complete";

    const semanticModel: TableSemanticModel = {
      tableName,
      description: `Structured analytical table '${tableName}' with ${qualityCounters.validRows} valid published records from ${rowCount} source rows; ${qualityCounters.invalidRows} invalid rows quarantined across ${columns.length} columns.`,
      context,
      topics: uniqueTopics,
      tableRole,
      decisionSpecs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1"],
      entities,
      searchableColumns,
      dimensions,
      metrics,
      primaryKey,
      synonyms,
      clickhouseSchema,
      qualityCounters,
    };

    const gate = this.verifyMetricRegistryAndGate(semanticModel);
    semanticModel.publicationGateStatus = gate.gateStatus;
    semanticModel.unresolvedDefinitions = gate.unresolvedDefinitions;

    return {
      tableName,
      columns,
      semanticModel,
      rows: publishableRows,
      rowCount,
      publishableRowCount: qualityCounters.validRows,
    };
  }

  public static verifyMetricRegistryAndGate(
    semanticModel: TableSemanticModel,
    options?: { maxInvalidRowRatio?: number; maxDuplicateKeyRatio?: number },
  ): {
    verified: boolean;
    unresolvedDefinitions: string[];
    gateStatus: "verified" | "rejected";
  } {
    const unresolvedDefinitions: string[] = [];
    const maxInvalidRatio = options?.maxInvalidRowRatio ?? 0.1;
    const maxDuplicateRatio = options?.maxDuplicateKeyRatio ?? 0.05;

    for (const metric of semanticModel.metrics || []) {
      if (!metric.physicalColumn && !metric.expression) {
        unresolvedDefinitions.push(`Metric '${metric.name}' has no physical column binding or expression`);
        metric.publicationGateStatus = "rejected";
      } else {
        // Strict formula / aggregation / timezone / grain validation
        const validAggregations = ["sum", "avg", "count", "min", "max"];
        if (metric.aggregation && !validAggregations.includes(metric.aggregation.toLowerCase())) {
          unresolvedDefinitions.push(`Metric '${metric.name}' has invalid aggregation '${metric.aggregation}'`);
          metric.publicationGateStatus = "rejected";
          continue;
        }
        if (metric.timezone) {
          try {
            Intl.DateTimeFormat(undefined, { timeZone: metric.timezone });
          } catch {
            unresolvedDefinitions.push(`Metric '${metric.name}' has invalid timezone '${metric.timezone}'`);
            metric.publicationGateStatus = "rejected";
            continue;
          }
        }
        if (metric.grain && !/^(daily|weekly|monthly|quarterly|yearly|none|per_[a-zA-Z0-9_]+|[a-zA-Z0-9_]+)$/i.test(metric.grain)) {
          unresolvedDefinitions.push(`Metric '${metric.name}' has unsupported grain '${metric.grain}'`);
          metric.publicationGateStatus = "rejected";
          continue;
        }
        metric.provenance = metric.provenance || "verified";
        metric.publicationGateStatus = "verified";
      }
    }

    if (semanticModel.qualityCounters) {
      const { totalRows, invalidRows, duplicateKeyRows } = semanticModel.qualityCounters;
      const uniquenessDenominator = semanticModel.qualityCounters.validRows || totalRows;
      if (totalRows > 0 && invalidRows / totalRows > maxInvalidRatio) {
        unresolvedDefinitions.push(
          `Quality gate failed: ${invalidRows}/${totalRows} rows (${((invalidRows / totalRows) * 100).toFixed(1)}%) are invalid, exceeding ${maxInvalidRatio * 100}% threshold`,
        );
      }
      if (duplicateKeyRows && uniquenessDenominator > 0 && duplicateKeyRows / uniquenessDenominator > maxDuplicateRatio) {
        unresolvedDefinitions.push(
          `Uniqueness gate failed: ${duplicateKeyRows}/${uniquenessDenominator} publishable rows (${((duplicateKeyRows / uniquenessDenominator) * 100).toFixed(1)}%) have duplicate primary keys, exceeding ${maxDuplicateRatio * 100}% threshold`,
        );
      }
    }

    const verified = unresolvedDefinitions.length === 0;
    const gateStatus = verified ? "verified" : "rejected";
    semanticModel.publicationGateStatus = gateStatus;
    semanticModel.unresolvedDefinitions = unresolvedDefinitions;

    return {
      verified,
      unresolvedDefinitions,
      gateStatus,
    };
  }

  public static determineSemanticCategory(
    colName: string,
    dataType: string,
    isPk: boolean,
  ): "identity" | "location" | "financial" | "contact" | "temporal" | "status" | "classification" | "nested_structure" | "content" | "general" {
    const lower = colName.toLowerCase();

    if (
      isPk ||
      /(^id$|_id$|^id_|nomor|no_|sk_|code|kode|sku|npwp|nik|reg|uuid|passport)/i.test(lower) ||
      /(^nama$|^name$|nama_|name_|_name|_nama|title|judul)/i.test(lower)
    ) {
      return "identity";
    }
    if (/(status|state|kondisi|active|aktif|flag|is_|enabled|valid)/i.test(lower)) {
      return "status";
    }
    if (
      /(alamat|address|street|jalan|kelurahan|desa|kecamatan|kabupaten|kota|city|provinsi|province|state|country|negara|pos|zip|postal|region|wilayah|latitude|longitude|lat|lon|lng)/i.test(
        lower,
      )
    ) {
      return "location";
    }
    if (
      /(modal|harga|price|nilai|total|amount|nominal|biaya|cost|omset|omzet|pendapatan|revenue|saldo|fee|tax|pajak|tarif|disetor|balance|salary|gaji|uang)/i.test(
        lower,
      )
    ) {
      return "financial";
    }
    if (/(email|mail|phone|telepon|telp|hp|handphone|fax|mobile|kontak|contact|website|url)/i.test(lower)) {
      return "contact";
    }
    if (
      dataType === "date" ||
      /(tanggal|date|tgl|created|updated|waktu|time|tahun|year|bulan|month|period|periode|timestamp)/i.test(lower)
    ) {
      return "temporal";
    }
    if (
      /(jenis|tipe|type|category|kategori|kelompok|group|divisi|division|departemen|department|sektor|sector|role|jabatan|kbli)/i.test(
        lower,
      )
    ) {
      return "classification";
    }
    if (/(keterangan|deskripsi|description|catatan|notes|remark|memo|detail|bio|summary)/i.test(lower)) {
      return "content";
    }
    if (dataType === "number") {
      return /(qty|quantity|count|jumlah|volume|banyak|unit)/i.test(lower) ? "general" : "financial";
    }
    return "general";
  }

  public static humanizeLabel(name: string): string {
    return name
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(" ")
      .map((word) => {
        const lower = word.toLowerCase();
        if (lower === "sk") return "SK";
        if (lower === "npwp") return "NPWP";
        if (lower === "id") return "ID";
        if (lower === "cv") return "CV";
        if (lower === "pt") return "PT";
        if (lower === "kbli") return "KBLI";
        if (lower === "tgl") return "Tanggal";
        if (lower === "no") return "Nomor";
        if (lower === "pk") return "PK";
        if (lower === "fk") return "FK";
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  public static isSearchableColumn(colName: string, role: string, semanticCategory: string): boolean {
    if (role === "identifier") return true;
    if (semanticCategory === "identity") return true;
    return /^(nama_|nama$|name$|_name|title|judul|kode_|code|label)/i.test(colName);
  }
}
