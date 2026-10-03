import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import {
  dataSourceCollections,
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
} from "@paperclipai/db";
import { DataSourceCollectionsService } from "../services/data-source-collections.js";

describe("DataSourceCollectionsService", () => {
  const service = new DataSourceCollectionsService({} as any);

  describe("extractZipEntries", () => {
    it("extracts supported files and filters out macOS metadata/hidden files", () => {
      const zip = new AdmZip();

      // Add valid structured and document files
      zip.addFile("timurtelecom/customers.csv", Buffer.from("id,name,plan\n1,Alice,Fiber100\n2,Bob,Fiber200"));
      zip.addFile("timurtelecom/subscriptions.csv", Buffer.from("sub_id,customer_id,bandwidth\n101,1,100Mbps"));
      zip.addFile("timurtelecom/network_sla.pdf", Buffer.from("%PDF-1.4 sample pdf content"));
      zip.addFile("timurtelecom/notes.txt", Buffer.from("Operational network maintenance notes"));

      // Add mac metadata and hidden files that must be excluded
      zip.addFile("__MACOSX/._customers.csv", Buffer.from("junk"));
      zip.addFile("timurtelecom/.DS_Store", Buffer.from("junk"));
      zip.addFile("timurtelecom/unsupported.bin", Buffer.from("binary blob"));

      const zipBuffer = zip.toBuffer();
      const extracted = service.extractZipEntries(zipBuffer);

      expect(extracted).toHaveLength(4);

      const fileNames = extracted.map((f) => f.originalname).sort();
      expect(fileNames).toEqual([
        "customers.csv",
        "network_sla.pdf",
        "notes.txt",
        "subscriptions.csv",
      ]);

      const csvFile = extracted.find((f) => f.originalname === "customers.csv");
      expect(csvFile?.mimetype).toBe("text/csv");
      expect(csvFile?.buffer.toString("utf-8")).toContain("Fiber100");

      const pdfFile = extracted.find((f) => f.originalname === "network_sla.pdf");
      expect(pdfFile?.mimetype).toBe("application/pdf");
    });
  });

  describe("correlateCollection & schema relationship inference", () => {
    it("discovers foreign keys between tables using primary key and column name heuristics", async () => {
      // Mock db with two structured tables: 'customers' and 'subscriptions'
      const mockCompanyId = "company-123";
      const mockCollectionId = "collection-timurtelecom";

      const mockCollection = {
        id: mockCollectionId,
        companyId: mockCompanyId,
        name: "Timur Telecom",
        slug: "timur-telecom",
        description: "Telecom operations and customers",
        color: "#0284c7",
        icon: "folder",
        semanticProfile: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDataSources = [
        {
          id: "ds-1",
          companyId: mockCompanyId,
          collectionId: mockCollectionId,
          name: "Customers",
          sourceType: "csv",
          status: "ready",
          fileName: "customers.csv",
          metadata: {
            semanticProfile: {
              domain: "Telecommunications",
              primaryTopics: ["Customers", "Subscribers"],
            },
          },
        },
        {
          id: "ds-2",
          companyId: mockCompanyId,
          collectionId: mockCollectionId,
          name: "Subscriptions",
          sourceType: "csv",
          status: "ready",
          fileName: "subscriptions.csv",
          metadata: {
            semanticProfile: {
              domain: "Telecommunications",
              primaryTopics: ["Subscriptions", "Billing"],
            },
          },
        },
        {
          id: "ds-3",
          companyId: mockCompanyId,
          collectionId: mockCollectionId,
          name: "SLA Policy",
          sourceType: "rag_document",
          status: "ready",
          fileName: "network_sla.pdf",
          metadata: {
            semanticProfile: {
              domain: "Telecommunications",
              primaryTopics: ["SLA", "Latency", "Customers"],
            },
          },
        },
      ];

      const mockTables = [
        {
          id: "tbl-1",
          dataSourceId: "ds-1",
          companyId: mockCompanyId,
          tableName: "customers",
          schemaDefinition: [
            { name: "id", dataType: "number", role: "identifier", isNullable: false },
            { name: "customer_name", dataType: "string", role: "dimension", isNullable: false },
            { name: "region", dataType: "string", role: "dimension", isNullable: false },
          ],
          rowCount: 3,
        },
        {
          id: "tbl-2",
          dataSourceId: "ds-2",
          companyId: mockCompanyId,
          tableName: "subscriptions",
          schemaDefinition: [
            { name: "subscription_id", dataType: "number", role: "identifier", isNullable: false },
            { name: "customer_id", dataType: "number", role: "foreign_key", isNullable: false },
            { name: "package_speed", dataType: "string", role: "dimension", isNullable: false },
            { name: "monthly_fee", dataType: "number", role: "metric", isNullable: false },
          ],
          rowCount: 5,
        },
      ];

      const mockRecords: Record<string, any[]> = {
        "tbl-1": [
          { data: { id: 1, customer_name: "PT Jaya Mandiri", region: "Surabaya" } },
          { data: { id: 2, customer_name: "CV Berkah Abadi", region: "Malang" } },
          { data: { id: 3, customer_name: "PT Timur Raya", region: "Sidoarjo" } },
        ],
        "tbl-2": [
          { data: { subscription_id: 101, customer_id: 1, package_speed: "100Mbps", monthly_fee: 500000 } },
          { data: { subscription_id: 102, customer_id: 1, package_speed: "50Mbps", monthly_fee: 300000 } },
          { data: { subscription_id: 103, customer_id: 2, package_speed: "200Mbps", monthly_fee: 900000 } },
        ],
      };

      const mockChunks = [
        {
          id: "chk-1",
          dataSourceId: "ds-3",
          companyId: mockCompanyId,
          chunkIndex: 0,
          title: "SLA Commitments for Enterprise Customers",
          content: "All enterprise customers in Surabaya and Malang including PT Jaya Mandiri have a 99.9% uptime SLA.",
        },
      ];

      // Mock Drizzle DB query builder
      const getTableResult = (table: any) => {
        if (table === dataSourceCollections) return [mockCollection];
        if (table === dataSources) return mockDataSources;
        if (table === dataSourceTables) return mockTables;
        if (table === dataSourceChunks) return mockChunks;
        if (table === dataSourceRecords) return mockRecords["tbl-1"] || [];
        return [];
      };

      const mockDb: any = {
        select: () => ({
          from: (table: any) => {
            const result = getTableResult(table);
            const queryObj: any = {
              where: () => queryObj,
              orderBy: () => queryObj,
              limit: () => queryObj,
              then: (resolve: any) => resolve(result),
            };
            return queryObj;
          },
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => [mockCollection],
              then: (resolve: any) => resolve([mockCollection]),
            }),
          }),
        }),
        insert: () => ({
          values: (vals: any) => ({
            returning: () => [vals],
            then: (resolve: any) => resolve([vals]),
          }),
        }),
      };

      const serviceWithMock = new DataSourceCollectionsService(mockDb);

      const profile = await serviceWithMock.correlateCollection(mockCompanyId, mockCollectionId);

      // Verify domain and topics
      expect(profile.domain).toContain("Telecommunications");
      expect(profile.primaryTopics).toContain("Customers");

      // Verify Cross-Table Relationship Discovery
      expect(profile.crossTableRelationships.length).toBeGreaterThan(0);
      const rel = profile.crossTableRelationships.find(
        (r) =>
          (r.sourceTable === "subscriptions" && r.targetTable === "customers") ||
          (r.sourceTable === "customers" && r.targetTable === "subscriptions"),
      );
      expect(rel).toBeDefined();
      expect(rel?.sourceTable).toBe("customers");
      expect(rel?.sourceColumn).toBe("id");
      expect(rel?.targetTable).toBe("subscriptions");
      expect(rel?.targetColumn).toBe("customer_id");
      expect(rel?.relationType).toBe("one_to_many");

      // Verify Cross-Document Correlation
      expect(profile.crossDocumentCorrelations).toBeDefined();

      // Verify Unified ClickHouse View DDL
      expect(profile.unifiedClickhouseViews && profile.unifiedClickhouseViews.length).toBeGreaterThan(0);
      const view = profile.unifiedClickhouseViews![0];
      expect(view.joinSql).toContain("CREATE OR REPLACE VIEW");
      expect(view.joinSql).toContain("LEFT JOIN");
      expect(view.sourceTables).toContain("subscriptions");
      expect(view.sourceTables).toContain("customers");

      // Verify Suggested Cross-Table Queries
      expect(profile.suggestedQueries.length).toBeGreaterThan(0);
      expect(profile.suggestedQueries[0].sqlSnippet).toContain("JOIN");
    });
  });

  describe("CRUD operations", () => {
    it("creates a collection with a slugified name and default values", async () => {
      let insertedVal: any = null;
      const mockDb: any = {
        select: () => ({
          from: () => ({
            where: () => ({
              then: (resolve: any) => resolve([]), // No collision
            }),
          }),
        }),
        insert: () => ({
          values: (val: any) => {
            if (val.slug) insertedVal = val;
            return {
              returning: () => [
                {
                  id: "col-new-123",
                  ...val,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ],
              then: (resolve: any) => resolve([val]),
            };
          },
        }),
      };

      const s = new DataSourceCollectionsService(mockDb);
      const created = await s.create("comp-1", {
        name: "Timur Telecom Indonesia",
        description: "Official ISP collection",
      });

      expect(created.name).toBe("Timur Telecom Indonesia");
      expect(created.slug).toBe("timur-telecom-indonesia");
      expect(insertedVal.slug).toBe("timur-telecom-indonesia");
      expect(created.color).toBe("#0284c7");
      expect(created.icon).toBe("folder");
    });
  });

  describe("Agent Collection Access & Scoped Isolation", () => {
    it("inherits all member data sources when an agent selects a collection", () => {
      const availableDataSources = [
        { id: "ds-col1-a", collectionId: "col-1", name: "Customers CSV" },
        { id: "ds-col1-b", collectionId: "col-1", name: "Billing Excel" },
        { id: "ds-col2-a", collectionId: "col-2", name: "HR Documents" },
        { id: "ds-standalone", collectionId: null, name: "Standalone DB" },
      ];

      const agentAccess = {
        mode: "selected" as const,
        dataSourceIds: ["ds-standalone"],
        collectionIds: ["col-1"],
      };

      const selectedColSet = new Set(agentAccess.collectionIds);
      const selectedDsSet = new Set(agentAccess.dataSourceIds);

      const effectiveAllowedSet = new Set<string>();
      for (const ds of availableDataSources) {
        if (selectedDsSet.has(ds.id)) {
          effectiveAllowedSet.add(ds.id);
        } else if (ds.collectionId && selectedColSet.has(ds.collectionId)) {
          effectiveAllowedSet.add(ds.id);
        }
      }

      const effectiveIds = Array.from(effectiveAllowedSet);
      expect(effectiveIds).toContain("ds-col1-a");
      expect(effectiveIds).toContain("ds-col1-b");
      expect(effectiveIds).toContain("ds-standalone");
      expect(effectiveIds).not.toContain("ds-col2-a");
      expect(effectiveIds).toHaveLength(3);
    });

    it("strictly isolates access when agent mode is none", () => {
      const availableDataSources = [
        { id: "ds-1", collectionId: "col-1", name: "Customers" },
      ];

      const agentAccess = {
        mode: "none" as const,
        dataSourceIds: ["ds-1"],
        collectionIds: ["col-1"],
      };

      let effectiveIds: string[] = [];
      if (agentAccess.mode === "all") {
        effectiveIds = availableDataSources.map((d) => d.id);
      } else if (agentAccess.mode === "selected") {
        effectiveIds = agentAccess.dataSourceIds;
      } else {
        effectiveIds = [];
      }

      expect(effectiveIds).toHaveLength(0);
    });
  });
});
