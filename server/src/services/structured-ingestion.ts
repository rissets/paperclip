import * as XLSX from "xlsx";
import type { ColumnDefinition, TableSemanticModel } from "@paperclipai/shared";

export interface ParsedTableData {
  tableName: string;
  columns: ColumnDefinition[];
  semanticModel: TableSemanticModel;
  rows: Record<string, unknown>[];
}

export class StructuredIngestionService {
  /**
   * Parse CSV content from string or buffer
   */
  static parseCsv(content: string, tableName = "Sheet1"): ParsedTableData {
    const workbook = XLSX.read(content, { type: "string" });
    const sheetName = tableName && tableName !== "Sheet1" ? tableName : (workbook.SheetNames[0] || tableName);
    const worksheet = workbook.Sheets[workbook.SheetNames[0] || "Sheet1"];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: null });
    return this.profileAndBuildTable(tableName || sheetName, rawRows);
  }

  /**
   * Parse Excel buffer (supports multi-sheet XLS / XLSX)
   */
  static parseExcel(buffer: Buffer): ParsedTableData[] {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const results: ParsedTableData[] = [];

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: null });
      if (rawRows.length > 0) {
        results.push(this.profileAndBuildTable(sheetName, rawRows));
      }
    }

    return results;
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
        (lowerName === "id" || lowerName.endsWith("_id") || lowerName.endsWith("id") || lowerName.includes("code") || lowerName.includes("sku")) &&
        distinctCount / (nonNullTotal || 1) > 0.7
      ) {
        role = "identifier";
        if (!primaryKey && distinctCount === rowCount) {
          primaryKey = colName;
        }
      } else if (dataType === "date" || lowerName.includes("date") || lowerName.includes("tanggal") || lowerName.includes("created_at") || lowerName.includes("time")) {
        role = "timestamp";
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
          lowerName.includes("nilai"))
      ) {
        role = "metric";
      } else if (dataType === "number" && distinctCount > 10) {
        role = "metric";
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

      // Generate bilingual synonyms
      const synList: string[] = [colName.toLowerCase()];
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

    const semanticModel: TableSemanticModel = {
      tableName,
      description: `Structured analytical table '${tableName}' with ${rowCount} records and ${columns.length} columns.`,
      entities,
      searchableColumns,
      dimensions,
      metrics,
      primaryKey,
      synonyms,
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
