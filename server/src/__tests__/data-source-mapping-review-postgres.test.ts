import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, dataSourceChunks, dataSourceTables, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DataSourceMappingReviewService } from "../services/data-source-mapping-review.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource mapping review PostgreSQL integration unavailable: ${support.reason}`);

(support.supported ? describe : describe.skip)("datasource semantic mapping review PostgreSQL integration", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-mapping-review-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed(status = "ready") {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Mapping review test",
      issuePrefix: `M${companyId.slice(0, 7)}`,
    });
    await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "Opex",
      sourceType: "postgres",
      status,
      metadata: {
        embeddingSpace: "bge-m3",
        embeddingGeneration: "bge-m3@test-revision",
        embeddingStatus: "ready",
        embeddingReindexStatus: "complete",
        semanticProfile: {
          tableProfiles: {
            "finance.site_cost": { tableName: "finance.site_cost", metrics: [{ name: "Cost", column: "monthly_cost" }] },
          },
        },
      },
    });
    await db.insert(dataSourceTables).values({
      id: tableId,
      companyId,
      dataSourceId: sourceId,
      tableName: "site_cost",
      schemaDefinition: [
        { name: "monthly_cost", dataType: "number", role: "metric", semanticCategory: "financial" },
        { name: "annual_cost", dataType: "number", role: "metric", semanticCategory: "financial" },
        { name: "site_name", dataType: "string", role: "dimension", semanticCategory: "location" },
        { name: "alternate_site_name", dataType: "string", role: "dimension", semanticCategory: "location" },
        { name: "email_address", dataType: "string", role: "attribute", semanticCategory: "contact" },
      ],
      semanticModel: {
        tableName: "site_cost",
        sourceSchema: "finance",
        metrics: [{ name: "Cost", column: "monthly_cost", expression: "sum(monthly_cost)", aggregation: "sum" }],
        dimensions: [{ name: "Site", column: "site_name", description: "Site", sampleValues: ["Sample site"] }],
        synonyms: {},
        version: 1,
      },
    });
    await db.insert(dataSourceChunks).values({
      companyId,
      dataSourceId: sourceId,
      chunkIndex: 0,
      title: "Schema: site_cost",
      content: "Old schema mapping: Cost [sum · monthly_cost]",
      metadata: { corpusKind: "schema", tableId, tableName: "site_cost" },
    });
    return { companyId, sourceId, tableId };
  }

  it("persists an operator correction, bounded review history, semantic profile, and invalidates bindings by version", async () => {
    const { companyId, sourceId, tableId } = await seed();
    const reviewed = await new DataSourceMappingReviewService(db).review({
      companyId,
      dataSourceId: sourceId,
      tableId,
      reviewerId: "owner-user",
      request: {
        decision: "corrected",
        note: "Annualized field is the intended metric.",
        metricCorrections: [{ index: 0, name: "Annual operating cost", column: "annual_cost", aggregation: "sum", description: "Annual site operating cost" }],
        dimensionCorrections: [{ index: 0, name: "Telecom site", column: "alternate_site_name", description: "Site label" }],
      },
    });
    const [storedTable] = await db.select().from(dataSourceTables)
      .where(and(eq(dataSourceTables.id, tableId), eq(dataSourceTables.companyId, companyId)));
    const [storedSource] = await db.select().from(dataSources)
      .where(and(eq(dataSources.id, sourceId), eq(dataSources.companyId, companyId)));
    const [storedChunk] = await db.select().from(dataSourceChunks)
      .where(and(eq(dataSourceChunks.dataSourceId, sourceId), eq(dataSourceChunks.companyId, companyId)));
    const auditRows = await db.select().from(activityLog).where(eq(activityLog.entityId, tableId));
    const model = storedTable.semanticModel as any;
    const profile = (storedSource.metadata as any).semanticProfile.tableProfiles["finance.site_cost"];

    expect(reviewed.semanticModel.mappingReview).toMatchObject({ status: "corrected", revision: 1, reviewerId: "owner-user" });
    expect(model.version).toBe(2);
    expect(model.metrics[0]).toMatchObject({ name: "Annual operating cost", column: "annual_cost", physicalColumn: "annual_cost", provenance: "user_defined" });
    expect(model.metrics[0]).not.toHaveProperty("expression");
    expect(model.dimensions[0]).toMatchObject({
      name: "Telecom site",
      column: "alternate_site_name",
      provenance: "user_defined",
      synonyms: ["Site"],
    });
    expect(model.dimensions[0]).not.toHaveProperty("sampleValues");
    expect(model.mappingReviewHistory).toHaveLength(1);
    expect(model.mappingReviewHistory[0]).toMatchObject({ decision: "corrected", reviewerId: "owner-user", note: "Annualized field is the intended metric." });
    expect(profile.metrics[0].column).toBe("annual_cost");
    expect(storedChunk?.content).toContain("Annual operating cost [sum · annual_cost]");
    expect(storedChunk?.content).toContain("Telecom site [alternate_site_name]");
    expect(storedChunk?.embedding).toBeNull();
    expect(storedSource?.metadata).toMatchObject({
      previousEmbeddingSpace: "bge-m3",
      previousEmbeddingGeneration: "bge-m3@test-revision",
      semanticMappingRevision: 1,
      embeddingStatus: "pending",
      embeddingReindexStatus: "pending",
    });
    expect(storedSource?.metadata).not.toHaveProperty("embeddingSpace");
    expect(storedSource?.metadata).not.toHaveProperty("embeddingGeneration");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorId: "owner-user",
      action: "data_source.semantic_mapping_reviewed",
      details: { decision: "corrected", revision: 1, embeddingRefreshPending: true },
    });
  });

  it("does not approve unmapped metrics, sensitive columns, or a source still being onboarded", async () => {
    const first = await seed();
    await db.update(dataSourceTables).set({
      semanticModel: { tableName: "site_cost", metrics: [{ name: "Cost", aggregation: "sum" }], dimensions: [], synonyms: {} },
    }).where(eq(dataSourceTables.id, first.tableId));
    await expect(new DataSourceMappingReviewService(db).review({
      companyId: first.companyId,
      dataSourceId: first.sourceId,
      tableId: first.tableId,
      reviewerId: "owner-user",
      request: { decision: "approved", metricCorrections: [], dimensionCorrections: [] },
    })).rejects.toThrow(/belum terikat/);

    await db.update(dataSourceTables).set({
      semanticModel: { tableName: "site_cost", metrics: [], dimensions: [{ name: "Contact" }] },
    }).where(eq(dataSourceTables.id, first.tableId));
    await expect(new DataSourceMappingReviewService(db).review({
      companyId: first.companyId,
      dataSourceId: first.sourceId,
      tableId: first.tableId,
      reviewerId: "owner-user",
      request: {
        decision: "corrected",
        metricCorrections: [],
        dimensionCorrections: [{ index: 0, name: "Contact", column: "email_address", description: "Contact" }],
      },
    })).rejects.toThrow(/sensitif/);

    const processing = await seed("processing");
    await expect(new DataSourceMappingReviewService(db).review({
      companyId: processing.companyId,
      dataSourceId: processing.sourceId,
      tableId: processing.tableId,
      reviewerId: "owner-user",
      request: { decision: "approved", metricCorrections: [], dimensionCorrections: [] },
    })).rejects.toThrow(/ready/);
  });
});
