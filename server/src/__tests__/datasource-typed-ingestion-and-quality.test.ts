import { describe, it, expect } from "vitest";
import { StructuredIngestionService } from "../services/structured-ingestion.js";
import type { TableSemanticModel, ColumnDefinition } from "@paperclipai/shared";

describe("Package P3: Typed Parser, Full-Data Quality Counters & Semantic Registry", () => {
  describe("P3-01: Typed Parser and Data Contracts", () => {
    it("preserves leading zeros for identifiers without numeric truncation", () => {
      expect(StructuredIngestionService.parseTypedIdentifier("0123")).toBe("0123");
      expect(StructuredIngestionService.parseTypedIdentifier("007")).toBe("007");
      expect(StructuredIngestionService.parseTypedIdentifier("08123456789")).toBe("08123456789");
      expect(StructuredIngestionService.parseTypedIdentifier("  045600  ")).toBe("045600");
      expect(StructuredIngestionService.parseTypedIdentifier(null)).toBe("");
      expect(StructuredIngestionService.parseTypedIdentifier(undefined)).toBe("");
    });

    it("parses locale-aware numerics in US and Indonesian formats with currency symbols", () => {
      // US comma thousands, dot decimal
      expect(StructuredIngestionService.parseTypedNumeric("1,234,567.89")).toBe(1234567.89);
      expect(StructuredIngestionService.parseTypedNumeric("$ 1,500.50")).toBe(1500.5);
      expect(StructuredIngestionService.parseTypedNumeric("USD 250.75")).toBe(250.75);

      // Indonesian dot thousands, comma decimal
      expect(StructuredIngestionService.parseTypedNumeric("1.234.567,89")).toBe(1234567.89);
      expect(StructuredIngestionService.parseTypedNumeric("Rp 50.000,00")).toBe(50000);
      expect(StructuredIngestionService.parseTypedNumeric("Rp. 1.250.000")).toBe(1250000);
      expect(StructuredIngestionService.parseTypedNumeric("1.500", { locale: "id" })).toBe(1500);

      // Percentages
      expect(StructuredIngestionService.parseTypedNumeric("15%")).toBe(0.15);
      expect(StructuredIngestionService.parseTypedNumeric("12,5%")).toBe(0.125);

      // Negative values
      expect(StructuredIngestionService.parseTypedNumeric("-1,234.50")).toBe(-1234.5);
      expect(StructuredIngestionService.parseTypedNumeric("-50.000,00")).toBe(-50000);
    });

    it("does not silently turn invalid strings into zero", () => {
      expect(StructuredIngestionService.parseTypedNumeric("N/A")).toBeNull();
      expect(StructuredIngestionService.parseTypedNumeric("none")).toBeNull();
      expect(StructuredIngestionService.parseTypedNumeric("--")).toBeNull();
      expect(StructuredIngestionService.parseTypedNumeric("invalid_value")).toBeNull();
      expect(StructuredIngestionService.parseTypedNumeric("")).toBeNull();
    });

    it("parses ISO dates, Indonesian/European date formats, and Excel serial dates", () => {
      // ISO dates
      const isoRes = StructuredIngestionService.parseTypedDate("2026-10-07");
      expect(isoRes).not.toBeNull();
      expect(isoRes?.iso.startsWith("2026-10-07")).toBe(true);

      // Indonesian / European dates (DD/MM/YYYY)
      const dmySlash = StructuredIngestionService.parseTypedDate("07/10/2026");
      expect(dmySlash).not.toBeNull();
      expect(dmySlash?.iso).toBe("2026-10-07T00:00:00.000Z");

      const dmyDash = StructuredIngestionService.parseTypedDate("25-12-2025");
      expect(dmyDash).not.toBeNull();
      expect(dmyDash?.iso).toBe("2025-12-25T00:00:00.000Z");

      // Excel serial date: 44197 -> 2021-01-01
      const excelRes = StructuredIngestionService.parseTypedDate(44197);
      expect(excelRes).not.toBeNull();
      expect(excelRes?.iso.startsWith("2021-01-01")).toBe(true);

      // Invalid dates
      expect(StructuredIngestionService.parseTypedDate("not-a-date")).toBeNull();
      expect(StructuredIngestionService.parseTypedDate("")).toBeNull();
    });

    it("synthesizes Decimal(18, 4) in ClickHouse schema for financial columns", () => {
      const csv = `id,kode_transaksi,nominal_omzet,biaya_admin,qty,catatan\n` +
        `1,TRX-001,1500000.50,5000,10,Sukses\n` +
        `2,TRX-002,2750000.00,7500,20,Sukses\n`;

      const parsed = StructuredIngestionService.parseCsv(csv, "transaksi_penjualan");
      expect(parsed.semanticModel.clickhouseSchema).toBeDefined();
      const colTypes = parsed.semanticModel.clickhouseSchema!.columnTypes;

      // Financial fields map to Decimal(18, 4)
      expect(colTypes.nominal_omzet).toBe("Decimal(18, 4)");
      expect(colTypes.biaya_admin).toBe("Decimal(18, 4)");

      // Non-financial metrics or dimensions
      expect(colTypes.qty).toBe("Float64");
      expect(colTypes.kode_transaksi).toBe("String");
      expect(colTypes.catatan).toBe("String");
    });
  });

  describe("P3-02: Full-Data Quality Counters & Duplicate Tracking", () => {
    it("accumulates quality counters, identifies nulls, type violations, and duplicate rows", () => {
      const csv = `id,customer_name,total_spend,created_at\n` +
        `1,Andi,150000,2026-01-01\n` +
        `2,Budi,invalid_spend,2026-01-02\n` +
        `3,,300000,2026-01-03\n` +
        `1,Andi,150000,2026-01-01\n`; // Duplicate of row 1

      const parsed = StructuredIngestionService.parseCsv(csv, "customer_spend");
      const qc = parsed.semanticModel.qualityCounters;

      expect(qc).toBeDefined();
      expect(qc?.totalRows).toBe(4);
      expect(qc?.invalidRows).toBe(1); // row 2 has invalid_spend
      expect(qc?.validRows).toBe(3);
      expect(qc?.quarantinedRows).toBe(1);
      expect(qc?.publishedRows).toBe(3);
      expect(parsed.publishableRowCount).toBe(3);
      expect(parsed.rows).toHaveLength(3);
      expect(qc?.typeViolations).toBeGreaterThanOrEqual(1);
      expect(qc?.duplicateRows).toBe(1); // row 4 duplicates row 1
      expect(qc?.nullValueCount.customer_name).toBe(1); // row 3 has empty customer_name
      expect(qc?.sampleErrors?.length).toBeGreaterThan(0);
      expect(qc?.sampleErrors?.[0].column).toBe("total_spend");
      expect(qc?.sampleErrors?.some((error) => error.error.includes("invalid_spend"))).toBe(false);
    });
  });

  describe("P3-03: Verified Metric/Grain Registry & Publication Gate", () => {
    it("registers physical bindings, grain, and passes publication gate on valid dataset", () => {
      const csv = `id,region,omzet\n` +
        `1,Jakarta,5000000\n` +
        `2,Surabaya,3000000\n` +
        `3,Bandung,2000000\n`;

      const parsed = StructuredIngestionService.parseCsv(csv, "sales_report");
      const metrics = parsed.semanticModel.metrics;

      expect(metrics.length).toBeGreaterThan(0);
      const omzetMetric = metrics.find((m) => m.name === "omzet");
      expect(omzetMetric).toBeDefined();
      expect(omzetMetric?.physicalColumn).toBe("omzet");
      expect(omzetMetric?.grain).toBe("per_id");
      expect(omzetMetric?.nullPolicy).toBe("zero");
      expect(omzetMetric?.provenance).toBe("inferred");
      expect(omzetMetric?.publicationGateStatus).toBe("verified");

      expect(parsed.semanticModel.publicationGateStatus).toBe("verified");
      expect(parsed.semanticModel.unresolvedDefinitions).toEqual([]);
    });

    it("rejects publication gate when invalid row ratio exceeds the threshold", () => {
      const dummyModel: TableSemanticModel = {
        tableName: "bad_table",
        description: "Bad table with high error rate",
        dimensions: [],
        metrics: [
          {
            name: "revenue",
            physicalColumn: "revenue",
            expression: "SUM(revenue)",
            description: "Total revenue",
            aggregation: "sum",
          },
        ],
        synonyms: {},
        qualityCounters: {
          totalRows: 100,
          validRows: 70,
          invalidRows: 30, // 30% invalid > 10% threshold
          nullValueCount: {},
          typeViolations: 30,
          duplicateRows: 0,
        },
      };

      const gate = StructuredIngestionService.verifyMetricRegistryAndGate(dummyModel, { maxInvalidRowRatio: 0.1 });
      expect(gate.verified).toBe(false);
      expect(gate.gateStatus).toBe("rejected");
      expect(dummyModel.publicationGateStatus).toBe("rejected");
      expect(gate.unresolvedDefinitions.length).toBeGreaterThan(0);
      expect(gate.unresolvedDefinitions[0]).toContain("Quality gate failed");
    });

    it("rejects publication gate when metric lacks physical column and expression", () => {
      const dummyModel: TableSemanticModel = {
        tableName: "broken_metric_table",
        description: "Table with missing metric binding",
        dimensions: [],
        metrics: [
          {
            name: "ghost_metric",
            expression: "",
            description: "No physical binding",
            aggregation: "sum",
          },
        ],
        synonyms: {},
      };

      const gate = StructuredIngestionService.verifyMetricRegistryAndGate(dummyModel);
      expect(gate.verified).toBe(false);
      expect(gate.gateStatus).toBe("rejected");
      expect(gate.unresolvedDefinitions[0]).toContain("has no physical column binding");
    });
  });
});
