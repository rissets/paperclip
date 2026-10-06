import fs from "node:fs";
import { createRequire } from "node:module";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import type { ColumnDefinition, TableSemanticModel, ClickhouseSchemaDefinition } from "@paperclipai/shared";
import { attachCsvSourceRowCheckpoint } from "./data-source-stream-checkpoint.js";

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
  rowCount?: number;
}

export interface ParseStructuredOptions {
  knownColumns?: string[];
  catalogMap?: Map<string, string[]>;
  onProgress?: (rowsScanned: number) => void | Promise<void>;
}

export class StructuredIngestionService {
  private static readonly STREAM_SAMPLE_ROWS = 2_000;
  private static readonly MAX_XLSX_METADATA_ENTRY_BYTES = 1024 * 1024;

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
      relax_column_count: false,
      ...(options.includeInfo ? { info: true } : {}),
    }));
  }

  private static isEmptyCsvRecord(record: unknown[]): boolean {
    return record.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
  }

  private static normalizeCsvValue(value: unknown, column: ColumnDefinition, rowNumber: number): unknown {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    if (column.role === "identifier" || column.semanticCategory === "identity") return String(value);
    if (column.dataType === "number") {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) {
        throw new Error(`CSV row ${rowNumber} has a non-numeric value in column '${column.name}'`);
      }
      return number;
    }
    if (column.dataType === "boolean") {
      if (typeof value === "boolean") return value;
      const normalized = String(value).trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
      throw new Error(`CSV row ${rowNumber} has a non-boolean value in column '${column.name}'`);
    }
    return String(value);
  }

  private static excelCellValue(value: unknown, sharedStrings?: unknown[]): unknown {
    if (value instanceof Date) return value.toISOString();
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
    parsed.rows = parsed.rows
      .slice(0, this.STREAM_SAMPLE_ROWS)
      .map((row, index) => Object.fromEntries(parsed.columns.map((column) => [
        column.name,
        this.normalizeCsvValue(row[column.name], column, index + 1),
      ])));
    parsed.rowCount = dataRowCount;
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
      parsed.rows = parsed.rows
        .slice(0, this.STREAM_SAMPLE_ROWS)
        .map((row, index) => Object.fromEntries(parsed.columns.map((column) => [
          column.name,
          this.normalizeCsvValue(row[column.name], column, index + 1),
        ])));
      parsed.rowCount = dataRowCount;
      tables.push(parsed);
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
  ): AsyncGenerator<Record<string, unknown>> {
    const byteOffset = resume.byteOffset ?? 0;
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error("CSV resume byte offset is invalid");
    const rowsCommitted = resume.rowsCommitted ?? 0;
    if (!Number.isSafeInteger(rowsCommitted) || rowsCommitted < 0) throw new Error("CSV resume row count is invalid");
    if (byteOffset > 0 && !resume.delimiter) throw new Error("CSV resume checkpoint is missing its detected delimiter");
    let firstRecord = byteOffset === 0;
    let firstRecordIsHeader = false;
    let rowNumber = rowsCommitted;
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
      if (record.length !== columns.length) {
        throw new Error(`CSV row ${rowNumber + 1} has ${record.length} fields; expected ${columns.length}`);
      }
      rowNumber += 1;
      const row: Record<string, unknown> = {};
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        row[column.name] = this.normalizeCsvValue(record[index], column, rowNumber);
      }
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
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = await this.createExcelWorkbookReader(filePath);
    const sharedStrings: unknown[] = [];
    let firstRecordIsHeader: boolean | null = null;
    let rowNumber = 0;
    let foundSheet = false;
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
        if (firstRecordIsHeader === null) {
          firstRecordIsHeader = !this.isRowDataRatherThanHeader(record);
          if (firstRecordIsHeader) continue;
        }
        if (record.length > columns.length) {
          throw new Error(`Excel row ${rowNumber + 1} has ${record.length} fields; expected ${columns.length}`);
        }
        rowNumber += 1;
        const row: Record<string, unknown> = {};
        for (let index = 0; index < columns.length; index += 1) {
          row[columns[index].name] = this.normalizeCsvValue(record[index] ?? "", columns[index], rowNumber);
        }
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
    return this.parseWorksheet(worksheet, tableName, options);
  }

  /**
   * Parse CSV content from string or buffer with smart header detection and enterprise catalog resolution
   */
  static parseCsv(content: string, tableName = "Sheet1", options?: ParseStructuredOptions): ParsedTableData {
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
      if (!isNaN(Date.parse(s)) && (s.includes("-") || s.includes("/")) && /\d{4}/.test(s)) {
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
      const rawHeaders = row0.map((cell, idx) => {
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

    return this.profileAndBuildTable(tableName, dataRows);
  }

  /**
   * Deterministic Profiler & Semantic Model Builder
   */
  private static profileAndBuildTable(tableName: string, rawRows: Record<string, any>[]): ParsedTableData {
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
    const metrics: { name: string; expression: string; description: string; aggregation: "sum" | "avg" | "count" | "min" | "max" }[] = [];
    const synonyms: Record<string, string[]> = {};
    let primaryKey: string | undefined;

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
        } else if (typeof val === "string" && !isNaN(Date.parse(val)) && val.length > 5 && /\d/.test(val)) {
          dateCount++;
          const d = new Date(val).getTime();
          if (minVal === null || d < minVal) minVal = val;
          if (maxVal === null || d > maxVal) maxVal = val;
        } else {
          stringCount++;
        }
      }

      const nonNullTotal = nonNullValues.length;
      let dataType: "string" | "number" | "boolean" | "date" | "unknown" = "string";

      if (nonNullTotal > 0) {
        if (numberCount / nonNullTotal > 0.8) {
          dataType = "number";
        } else if (dateCount / nonNullTotal > 0.8) {
          dataType = "date";
        } else if (booleanCount / nonNullTotal > 0.8) {
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
        distinctCount > 3 &&
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
          expression: `SUM("${colName}")`,
          description: `Total sum of ${colName}`,
          aggregation: "sum",
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
        expression: "COUNT(*)",
        description: `Total count of records in ${tableName}`,
        aggregation: "count",
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
      const chType = chTypes[c.dataType] || "String";
      c.clickhouseType = chType;
      columnTypes[c.name] = chType;
    }

    const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const ddlColumns = columns
      .map((c) => `  \`${c.name}\` ${columnTypes[c.name]}`)
      .join(",\n");

    const orderBy = primaryKey ? [primaryKey] : (columns.length > 0 ? [columns[0].name] : []);
    const orderByClause = orderBy.length > 0 ? `\`${orderBy.join("`, `")}\`` : "tuple()";
    const createTableDdl = `CREATE TABLE IF NOT EXISTS \`${sanitizedTableName}\` (\n${ddlColumns}\n) ENGINE = MergeTree()\nORDER BY (${orderByClause});`;

    const clickhouseSchema: ClickhouseSchemaDefinition = {
      createTableDdl,
      engine: "MergeTree",
      orderBy,
      columnTypes,
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

    const semanticModel: TableSemanticModel = {
      tableName,
      description: `Structured analytical table '${tableName}' with ${rowCount} records and ${columns.length} columns.`,
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
    };

    return {
      tableName,
      columns,
      semanticModel,
      rows: cleanRows,
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
      /(modal|harga|price|nilai|total|amount|nominal|biaya|cost|omset|pendapatan|revenue|saldo|fee|tax|pajak|tarif|disetor|balance|salary|gaji|uang)/i.test(
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
    if (dataType === "number") return "financial";
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
