import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  dataSourceChunks,
  dataSourceCollections,
  dataSourceRecords,
  dataSources,
  dataSourceTables,
} from "@paperclipai/db";
import { DataSourceCollectionsService } from "../services/data-source-collections.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource collection PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource collection PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-collections-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  beforeEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("returns exact landing-page metrics and builds scoped joins from bounded samples", async () => {
    const companyId = randomUUID();
    const collectionId = randomUUID();
    const customerSourceId = randomUUID();
    const subscriptionSourceId = randomUUID();
    const documentSourceId = randomUUID();
    const customerTableId = randomUUID();
    const subscriptionTableId = randomUUID();
    const executedViews: string[] = [];
    const fakeClickhouse = {
      getCompanyDatabase: () => `paperclip_${companyId.replaceAll("-", "_")}`,
      isHealthy: async () => ({ ok: true }),
      ensureCompanyDatabase: async () => `paperclip_${companyId.replaceAll("-", "_")}`,
      execute: async (query: string) => { executedViews.push(query); },
    };

    await db.insert(companies).values({ id: companyId, name: "Collection metrics test", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(dataSourceCollections).values({ id: collectionId, companyId, name: "Operations", slug: "operations" });
    await db.insert(dataSources).values([
      { id: customerSourceId, companyId, collectionId, name: "Customers", sourceType: "csv", status: "ready" },
      { id: subscriptionSourceId, companyId, collectionId, name: "Subscriptions", sourceType: "csv", status: "ready" },
      {
        id: documentSourceId,
        companyId,
        collectionId,
        name: "SLA policy",
        sourceType: "rag_document",
        status: "ready",
        metadata: { semanticProfile: { entities: ["PT Jaya Mandiri"], primaryTopics: ["SLA"] } },
      },
    ]);
    await db.insert(dataSourceTables).values([
      {
        id: customerTableId,
        companyId,
        dataSourceId: customerSourceId,
        tableName: "customers",
        rowCount: 2,
        schemaDefinition: [
          { name: "id", dataType: "number", isPrimaryKey: true },
          { name: "customer_name", dataType: "string" },
        ],
        semanticModel: { clickhouseTable: "ds_customers" },
      },
      {
        id: subscriptionTableId,
        companyId,
        dataSourceId: subscriptionSourceId,
        tableName: "subscriptions",
        rowCount: 3,
        schemaDefinition: [
          { name: "subscription_id", dataType: "number", isPrimaryKey: true },
          { name: "customer_id", dataType: "number" },
        ],
        semanticModel: { clickhouseTable: "ds_subscriptions" },
      },
    ]);
    await db.insert(dataSourceRecords).values([
      { companyId, dataSourceId: customerSourceId, tableId: customerTableId, rowIndex: 0, data: { id: 1, customer_name: "PT Jaya Mandiri" } },
      { companyId, dataSourceId: customerSourceId, tableId: customerTableId, rowIndex: 1, data: { id: 2, customer_name: "CV Sejahtera" } },
      { companyId, dataSourceId: subscriptionSourceId, tableId: subscriptionTableId, rowIndex: 0, data: { subscription_id: 101, customer_id: 1 } },
      { companyId, dataSourceId: subscriptionSourceId, tableId: subscriptionTableId, rowIndex: 1, data: { subscription_id: 102, customer_id: 1 } },
    ]);
    await db.insert(dataSourceChunks).values(Array.from({ length: 12 }, (_, index) => ({
      companyId,
      dataSourceId: documentSourceId,
      chunkIndex: index,
      title: `Section ${index + 1}`,
      content: index === 0 ? "PT Jaya Mandiri has a 99.9 percent uptime SLA in Surabaya." : `Policy section ${index + 1}.`,
      tokenCount: 8,
    })));

    const service = new DataSourceCollectionsService(db, fakeClickhouse as any);
    const [collection] = await service.list(companyId);
    expect(collection).toMatchObject({
      id: collectionId,
      dataSourceCount: 3,
      tableCount: 2,
      documentCount: 1,
      totalRows: 5,
      totalChunks: 12,
    });

    const profile = await service.correlateCollection(companyId, collectionId);
    const customerSubscriptionRelation = profile.crossTableRelationships.find((relation) =>
      (relation.sourceTableId === customerTableId && relation.targetTableId === subscriptionTableId)
      || (relation.sourceTableId === subscriptionTableId && relation.targetTableId === customerTableId));
    expect(customerSubscriptionRelation).toBeDefined();
    expect(new Set([customerSubscriptionRelation?.sourceColumn, customerSubscriptionRelation?.targetColumn]))
      .toEqual(new Set(["id", "customer_id"]));
    expect(profile.unifiedClickhouseViews).toHaveLength(1);
    expect(profile.unifiedClickhouseViews?.[0]).toMatchObject({ deploymentStatus: "deployed" });
    expect(executedViews[0]).toContain("LEFT JOIN");
    expect(profile.crossModalCorrelations).toContainEqual(expect.objectContaining({
      documentId: documentSourceId,
      tableId: customerTableId,
    }));
  }, 30_000);

  it("publishes temporal overlap candidates in the collection profile without copying row values", async () => {
    const companyId = randomUUID();
    const collectionId = randomUUID();
    const firstSourceId = randomUUID();
    const secondSourceId = randomUUID();
    const firstTableId = randomUUID();
    const secondTableId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Temporal overlap test", issuePrefix: `T${companyId.slice(0, 8)}` });
    await db.insert(dataSourceCollections).values({ id: collectionId, companyId, name: "Operations", slug: "operations" });
    await db.insert(dataSources).values([
      { id: firstSourceId, companyId, collectionId, name: "First upload", sourceType: "csv", status: "ready" },
      { id: secondSourceId, companyId, collectionId, name: "Second upload", sourceType: "excel", status: "ready" },
    ]);
    await db.insert(dataSourceTables).values([
      {
        id: firstTableId,
        companyId,
        dataSourceId: firstSourceId,
        tableName: "hourly_kpi",
        rowCount: 2,
        schemaDefinition: [{ name: "event_date", dataType: "date" }],
        semanticModel: {
          metrics: [{ name: "traffic volume" }],
          entities: ["network events"],
          qualityCounters: {
            temporalBoundsByColumn: {
              event_date: { minDate: "2026-01-01T00:00:00.000Z", maxDate: "2026-01-31T00:00:00.000Z" },
            },
          },
        },
      },
      {
        id: secondTableId,
        companyId,
        dataSourceId: secondSourceId,
        tableName: "hourly_kpi",
        rowCount: 2,
        schemaDefinition: [{ name: "event_date", dataType: "date" }],
        semanticModel: {
          metrics: [{ name: "traffic volume" }],
          entities: ["network events"],
          qualityCounters: {
            temporalBoundsByColumn: {
              event_date: { minDate: "2026-01-15T00:00:00.000Z", maxDate: "2026-02-15T00:00:00.000Z" },
            },
          },
          privateSample: ["sensitive row value must not leave its source"],
        },
      },
    ]);

    const service = new DataSourceCollectionsService(db, {
      getCompanyDatabase: () => `paperclip_${companyId.replaceAll("-", "_")}`,
    } as any);
    const profile = await service.correlateCollection(companyId, collectionId);

    expect(profile.temporalOverlapAnalysis).toMatchObject({
      status: "complete",
      tablesAnalyzed: 2,
      tablesWithTemporalBounds: 2,
      comparedPairs: 1,
      findings: [expect.objectContaining({
        overlapStart: "2026-01-15T00:00:00.000Z",
        overlapEnd: "2026-01-31T00:00:00.000Z",
        reviewRequired: true,
      })],
    });
    const overlapFinding = profile.temporalOverlapAnalysis?.findings[0];
    expect(new Set([overlapFinding?.sourceTableId, overlapFinding?.targetTableId]))
      .toEqual(new Set([firstTableId, secondTableId]));
    expect(JSON.stringify(profile.temporalOverlapAnalysis)).not.toContain("sensitive row value");
  }, 30_000);
});
