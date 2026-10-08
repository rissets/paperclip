import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  DataSourceExperienceService,
  type RecordCandidateExperienceInput,
} from "../services/data-source-experience.js";

describe("Package P6: Verified Query Experience & Feedback Learning", () => {
  let mockExperiences: any[] = [];
  let mockFeedback: any[] = [];

  const mockDb: any = {
    insert: (table: any) => ({
      values: (val: any) => ({
        returning: async () => {
          const row = {
            id: `exp-${mockExperiences.length + 1}`,
            ...val,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          if (table._?.name === "data_source_query_feedback" || val.executionId) {
            mockFeedback.push(row);
          } else {
            mockExperiences.push(row);
          }
          return [row];
        },
      }),
    }),
    update: (table: any) => ({
      set: (updates: any) => ({
        where: () => {
          const exp = mockExperiences[0];
          if (exp) {
            Object.assign(exp, updates);
          }
          return Object.assign(Promise.resolve(exp ? [exp] : []), {
            returning: async () => (exp ? [exp] : []),
          });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => mockExperiences,
        }),
      }),
    }),
  };

  beforeEach(() => {
    mockExperiences = [];
    mockFeedback = [];
  });

  describe("P6-01 & P6-02: Experience candidate recording & explicit promotion", () => {
    it("records a candidate experience with candidate status; execution success alone does NOT promote", async () => {
      const service = new DataSourceExperienceService(mockDb);

      const candidateInput: RecordCandidateExperienceInput = {
        companyId: "cmp-test",
        originatingExecutionId: "exec-101",
        intent: "Berapa total penjualan per kategori bulan ini?",
        parameterizedSql: "SELECT category, sum(total) as revenue FROM ds_sales WHERE period = :period GROUP BY category",
        parameterSchema: { period: { type: "string", description: "Bulan periode analitik" } },
        referencedDataSourceIds: ["ds-sales-1"],
        referencedTables: ["ds_sales"],
        referencedColumns: ["category", "total", "period"],
        metricBindings: ["revenue"],
        schemaFingerprint: "fp-v1-abc",
        engine: "clickhouse",
        status: "candidate",
      };

      const record = await service.recordCandidateExperience(candidateInput);

      expect(record.id).toBeDefined();
      expect(record.companyId).toBe("cmp-test");
      expect(record.status).toBe("candidate");
      expect(record.intent).toBe("Berapa total penjualan per kategori bulan ini?");
      expect(record.engine).toBe("clickhouse");
      expect(record.referencedDataSourceIds).toEqual(["ds-sales-1"]);
    });

    it("promotes an experience to reference_verified only through explicit verification", async () => {
      const service = new DataSourceExperienceService(mockDb);
      const row = {
        id: "exp-1",
        companyId: "cmp-test",
        originatingExecutionId: "exec-101",
        intent: "Total omzet per wilayah",
        parameterizedSql: "SELECT region, sum(omzet) FROM ds_regional GROUP BY region",
        schemaFingerprint: "fp-reg",
        status: "candidate",
        referencedDataSourceIds: ["ds-1"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockExperiences.push(row);

      const promoted = await service.promoteExperience("cmp-test", "exp-1", "reference_verified", {
        verifiedBy: "analyst-admin",
        matchedGoldenWorkload: true,
      });

      expect(promoted.status).toBe("reference_verified");
      expect(promoted.validationEvidence).toEqual({
        verifiedBy: "analyst-admin",
        matchedGoldenWorkload: true,
      });
    });

    it("records user feedback and rejects experience on negative sentiment", async () => {
      const service = new DataSourceExperienceService(mockDb);
      const row = {
        id: "exp-1",
        companyId: "cmp-test",
        executionId: "exec-101",
        status: "candidate",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockExperiences.push(row);

      const feedback = await service.recordFeedback({
        companyId: "cmp-test",
        executionId: "exec-101",
        experienceId: "exp-1",
        actorType: "board",
        actorId: "usr-42",
        sentiment: "negative",
        businessFieldsToFix: ["category", "metric_formula"],
        correctionNote: "Perhitungan harus mengecualikan transaksi retur",
      });

      expect(feedback.sentiment).toBe("negative");
      expect(feedback.businessFieldsToFix).toContain("category");
      expect(row.status).toBe("rejected");
    });
  });

  describe("P6-03: Applicable experience retrieval & security guards", () => {
    it("lists experiences only for the requested datasource and fails closed for an empty grant", async () => {
      const service = new DataSourceExperienceService(mockDb);
      mockExperiences.push(
        {
          id: "exp-ds-1",
          companyId: "cmp-test",
          intent: "Total incidents",
          parameterizedSql: "SELECT SUM(incidents) FROM ds_incidents",
          status: "candidate",
          referencedDataSourceIds: ["ds-1"],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "exp-ds-2",
          companyId: "cmp-test",
          intent: "Total payroll",
          parameterizedSql: "SELECT SUM(amount) FROM ds-payroll",
          status: "candidate",
          referencedDataSourceIds: ["ds-payroll"],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      );

      const scoped = await service.listExperiences("cmp-test", {
        allowedDataSourceIds: ["ds-1"],
        dataSourceId: "ds-1",
      });
      const denied = await service.listExperiences("cmp-test", {
        allowedDataSourceIds: [],
      });

      expect(scoped.map((experience) => experience.id)).toEqual(["exp-ds-1"]);
      expect(denied).toEqual([]);
    });

    it("retrieves verified experience matching intent when caller is authorized and fingerprint matches", async () => {
      const service = new DataSourceExperienceService(mockDb);
      const row = {
        id: "exp-verified-1",
        companyId: "cmp-test",
        originatingExecutionId: "exec-99",
        intent: "Berapa total penjualan per kategori?",
        parameterizedSql: "SELECT category, sum(total) FROM ds_sales WHERE period = :period GROUP BY category",
        schemaFingerprint: "fp-fingerprint-clean",
        status: "reference_verified",
        referencedDataSourceIds: ["ds-sales-1"],
        referencedTables: ["ds_sales"],
        referencedColumns: ["category", "total", "period"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockExperiences.push(row);

      // Caller has access to ds-sales-1 and matching fingerprint
      const retrieved = await service.retrieveApplicableExperience(
        "cmp-test",
        "Berapa total penjualan per kategori?",
        ["ds-sales-1"],
        "fp-fingerprint-clean",
      );

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("exp-verified-1");
      expect(retrieved?.status).toBe("reference_verified");
    });

    it("strictly refrains from reusing experience if caller does NOT have access to all referenced data sources (ACL guard)", async () => {
      const service = new DataSourceExperienceService(mockDb);
      const row = {
        id: "exp-multi-source",
        companyId: "cmp-test",
        originatingExecutionId: "exec-88",
        intent: "Cross table joining orders and payroll",
        parameterizedSql: "SELECT * FROM ds_orders a JOIN ds_payroll b ON a.id = b.id",
        schemaFingerprint: "fp-clean",
        status: "reference_verified",
        referencedDataSourceIds: ["ds-orders", "ds-confidential-payroll"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockExperiences.push(row);

      // Caller only has access to ds-orders, not ds-confidential-payroll!
      const retrieved = await service.retrieveApplicableExperience(
        "cmp-test",
        "Cross table joining orders and payroll",
        ["ds-orders"],
        "fp-clean",
      );

      expect(retrieved).toBeNull();
    });

    it("strictly refrains from reusing experience if schema fingerprint has drifted (Schema Drift guard)", async () => {
      const service = new DataSourceExperienceService(mockDb);
      const row = {
        id: "exp-old-schema",
        companyId: "cmp-test",
        originatingExecutionId: "exec-77",
        intent: "Daftar pelanggan aktif",
        parameterizedSql: "SELECT * FROM ds_customers WHERE is_active = 1",
        schemaFingerprint: "fp-old-v1",
        status: "reference_verified",
        referencedDataSourceIds: ["ds-customers"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockExperiences.push(row);

      // Current schema fingerprint is fp-new-v2 (e.g. column dropped or renamed)
      const retrieved = await service.retrieveApplicableExperience(
        "cmp-test",
        "Daftar pelanggan aktif",
        ["ds-customers"],
        "fp-new-v2",
      );

      expect(retrieved).toBeNull();
    });

    it("safely binds parameters into SQL without carryover of prior literals", () => {
      const service = new DataSourceExperienceService(mockDb);
      const template = "SELECT * FROM ds_sales WHERE period = :period AND region = {{region}}";
      const bound = service.bindParameters(template, {
        period: "2026-10",
        region: "Jakarta Pusat",
      });

      expect(bound).toBe("SELECT * FROM ds_sales WHERE period = '2026-10' AND region = 'Jakarta Pusat'");
    });

    it("computes deterministic schema fingerprints from tables, columns, and metrics", () => {
      const fp1 = DataSourceExperienceService.computeSchemaFingerprint({
        tables: ["orders", "items"],
        columns: ["id", "price", "order_id"],
        metrics: ["total_price"],
      });
      const fp2 = DataSourceExperienceService.computeSchemaFingerprint({
        tables: ["items", "orders"],
        columns: ["order_id", "price", "id"],
        metrics: ["total_price"],
      });

      expect(fp1).toBe(fp2);
      expect(fp1.length).toBe(32);
    });

    it("invalidates learned query reuse when a reviewed metric or dimension physical binding changes", () => {
      const baseTables = [{
        tableName: "site_opex",
        schemaDefinition: [
          { name: "site_name", dataType: "string" },
          { name: "monthly_cost", dataType: "number" },
          { name: "annual_cost", dataType: "number" },
        ],
        semanticModel: {
          dimensions: [{ name: "Site", column: "site_name" }],
          metrics: [{ name: "Operating cost", column: "monthly_cost", aggregation: "sum" }],
        },
      }];
      const before = DataSourceExperienceService.computeFingerprintFromTables(baseTables);
      const changedMetric = DataSourceExperienceService.computeFingerprintFromTables([{
        ...baseTables[0],
        semanticModel: {
          ...baseTables[0].semanticModel,
          metrics: [{ name: "Operating cost", column: "annual_cost", aggregation: "sum" }],
        },
      }]);
      const changedDimension = DataSourceExperienceService.computeFingerprintFromTables([{
        ...baseTables[0],
        semanticModel: {
          ...baseTables[0].semanticModel,
          dimensions: [{ name: "Site", column: "monthly_cost" }],
        },
      }]);

      expect(changedMetric).not.toBe(before);
      expect(changedDimension).not.toBe(before);
    });
  });
});
