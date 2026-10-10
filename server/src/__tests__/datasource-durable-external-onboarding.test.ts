import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  dataSourceJobs,
  dataSources,
  dataSourceTables,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  DatabaseIntegrationService,
  synthesizeDatabaseRelationsAndComponents,
  type InspectedTableResult,
} from "../services/database-integration.js";
import type { ColumnDefinition, TableRelation, TableSemanticModel } from "@paperclipai/shared";

const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock("../services/data-sources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/data-sources.js")>();
  return {
    ...actual,
    DataSourcesService: class extends actual.DataSourcesService {
      runExternalDatabaseOnboarding(...args: unknown[]) {
        return pipelineMock(...args);
      }
    },
  };
});
import { DataSourceIngestionWorker } from "../services/data-source-ingestion-worker.js";

const support = await getEmbeddedPostgresTestSupport();

describe("Package P2: Durable External Onboarding, Index Discovery & Relation Verification", () => {
  describe("P2-04 & P2-02: Relation Verification, Connected Components & Schema Discovery", () => {
    it("preserves explicit foreign keys with high confidence and provenance 'foreign_key'", () => {
      const mockColumns: ColumnDefinition[] = [
        {
          name: "id",
          dataType: "number",
          nativeType: "int4",
          nullCount: 0,
          nullRatio: 0,
          distinctCount: 100,
          sampleValues: [1, 2, 3],
          role: "identifier",
          isPrimaryKey: true,
        },
        {
          name: "user_id",
          dataType: "number",
          nativeType: "int4",
          nullCount: 0,
          nullRatio: 0,
          distinctCount: 50,
          sampleValues: [1, 2],
          role: "identifier",
          isForeignKey: true,
        },
      ];

      const ordersTable: InspectedTableResult = {
        tableName: "orders",
        schemaName: "public",
        rowCount: 100,
        columnCount: 2,
        schemaDefinition: mockColumns,
        semanticModel: {
          tableName: "orders",
          description: "Orders table",
          dimensions: [],
          metrics: [],
          synonyms: {},
          indexes: [
            {
              name: "orders_pkey",
              columns: ["id"],
              isUnique: true,
              isPrimary: true,
            },
          ],
          rowCountEstimated: true,
          sourceSchema: "public",
        },
      };

      const usersTable: InspectedTableResult = {
        tableName: "users",
        schemaName: "public",
        rowCount: 50,
        columnCount: 1,
        schemaDefinition: [
          {
            name: "id",
            dataType: "number",
            nativeType: "int4",
            nullCount: 0,
            nullRatio: 0,
            distinctCount: 50,
            sampleValues: [1, 2],
            role: "identifier",
            isPrimaryKey: true,
          },
        ],
        semanticModel: {
          tableName: "users",
          description: "Users table",
          dimensions: [],
          metrics: [],
          synonyms: {},
          sourceSchema: "public",
        },
      };

      const explicitFks: TableRelation[] = [
        {
          sourceTable: "orders",
          sourceColumn: "user_id",
          targetTable: "users",
          targetColumn: "id",
          relationType: "many_to_one",
        },
      ];

      const { enrichedRelations, connectedComponents } = synthesizeDatabaseRelationsAndComponents(
        [ordersTable, usersTable],
        explicitFks,
      );

      expect(enrichedRelations).toHaveLength(1);
      expect(enrichedRelations[0]?.provenance).toBe("foreign_key");
      expect(enrichedRelations[0]?.confidence).toBe(1.0);
      expect(connectedComponents).toHaveLength(1);
      expect(connectedComponents[0]?.tableNames).toContain("public.orders");
      expect(connectedComponents[0]?.tableNames).toContain("public.users");
      expect(ordersTable.semanticModel.connectedComponentId).toBe(connectedComponents[0]?.id);
      expect(usersTable.semanticModel.connectedComponentId).toBe(connectedComponents[0]?.id);
    });

    it("infers candidate foreign keys when column matches target table naming with type compatibility", () => {
      const itemsTable: InspectedTableResult = {
        tableName: "order_items",
        schemaName: "public",
        rowCount: 300,
        columnCount: 2,
        schemaDefinition: [
          {
            name: "id",
            dataType: "number",
            nativeType: "int8",
            nullCount: 0,
            nullRatio: 0,
            distinctCount: 300,
            sampleValues: [1, 2],
            role: "identifier",
            isPrimaryKey: true,
          },
          {
            name: "product_id",
            dataType: "number",
            nativeType: "int8",
            nullCount: 0,
            nullRatio: 0,
            distinctCount: 40,
            sampleValues: [10, 20],
            role: "identifier",
            isForeignKey: false, // Not defined as explicit FK in database constraint
          },
        ],
        semanticModel: {
          tableName: "order_items",
          description: "Order items",
          dimensions: [],
          metrics: [],
          synonyms: {},
        },
      };

      const productsTable: InspectedTableResult = {
        tableName: "products",
        schemaName: "public",
        rowCount: 40,
        columnCount: 1,
        schemaDefinition: [
          {
            name: "id",
            dataType: "number",
            nativeType: "int8",
            nullCount: 0,
            nullRatio: 0,
            distinctCount: 40,
            sampleValues: [10, 20],
            role: "identifier",
            isPrimaryKey: true,
          },
        ],
        semanticModel: {
          tableName: "products",
          description: "Products catalog",
          dimensions: [],
          metrics: [],
          synonyms: {},
        },
      };

      const auditTable: InspectedTableResult = {
        tableName: "audit_logs",
        schemaName: "public",
        rowCount: 10,
        columnCount: 1,
        schemaDefinition: [
          {
            name: "id",
            dataType: "string",
            nullCount: 0,
            nullRatio: 0,
            distinctCount: 10,
            sampleValues: ["uuid-1"],
            role: "identifier",
            isPrimaryKey: true,
          },
        ],
        semanticModel: {
          tableName: "audit_logs",
          description: "Isolated logs",
          dimensions: [],
          metrics: [],
          synonyms: {},
        },
      };

      const { enrichedRelations, connectedComponents } = synthesizeDatabaseRelationsAndComponents(
        [itemsTable, productsTable, auditTable],
        [], // No raw DB FKs
      );

      // product_id -> products.id should be discovered as inferred
      const inferred = enrichedRelations.find(
        (r) => r.sourceTable === "order_items" && r.sourceColumn === "product_id",
      );
      expect(inferred).toBeDefined();
      expect(inferred?.targetTable).toBe("products");
      expect(inferred?.targetColumn).toBe("id");
      expect(inferred?.provenance).toBe("inferred");
      expect(inferred?.confidence).toBeGreaterThanOrEqual(0.8);
      expect(inferred?.cardinalityEvidence?.sourceDistinctCount).toBe(40);

      // Connected components: order_items + products in one component, audit_logs in another
      expect(connectedComponents).toHaveLength(2);
      expect(itemsTable.semanticModel.connectedComponentId).toBe(productsTable.semanticModel.connectedComponentId);
      expect(auditTable.semanticModel.connectedComponentId).not.toBe(itemsTable.semanticModel.connectedComponentId);
    });

    it("keeps duplicate table names and their explicit relations isolated by schema", () => {
      const makeTable = (schemaName: string, tableName: string, columns: ColumnDefinition[]): InspectedTableResult => ({
        tableName,
        schemaName,
        rowCount: 10,
        columnCount: columns.length,
        schemaDefinition: columns,
        semanticModel: { tableName, description: `${schemaName}.${tableName}`, dimensions: [], metrics: [], synonyms: {} },
      });
      const makeId = (): ColumnDefinition => ({
        name: "id", dataType: "number", nullCount: 0, nullRatio: 0, distinctCount: 10,
        sampleValues: [1], role: "identifier", isPrimaryKey: true,
      });
      const makeFk = (): ColumnDefinition => ({
        name: "user_id", dataType: "number", nullCount: 0, nullRatio: 0, distinctCount: 10,
        sampleValues: [1], role: "identifier", isForeignKey: true,
        foreignKeyTarget: { schema: "tenant_a", table: "users", column: "id" },
      });
      const tenantAOrders = makeTable("tenant_a", "orders", [makeId(), makeFk()]);
      const tenantAUsers = makeTable("tenant_a", "users", [makeId()]);
      const tenantBOrders = makeTable("tenant_b", "orders", [makeId(), {
        ...makeFk(), foreignKeyTarget: { schema: "tenant_b", table: "users", column: "id" },
      }]);
      const tenantBUsers = makeTable("tenant_b", "users", [makeId()]);

      const { enrichedRelations, connectedComponents } = synthesizeDatabaseRelationsAndComponents(
        [tenantAOrders, tenantAUsers, tenantBOrders, tenantBUsers],
        [
          {
            sourceTable: "orders", sourceSchema: "tenant_a", sourceColumn: "user_id",
            targetTable: "users", targetSchema: "tenant_a", targetColumn: "id", relationType: "many_to_one",
          },
          {
            sourceTable: "orders", sourceSchema: "tenant_b", sourceColumn: "user_id",
            targetTable: "users", targetSchema: "tenant_b", targetColumn: "id", relationType: "many_to_one",
          },
        ],
      );

      expect(connectedComponents).toHaveLength(2);
      expect(tenantAOrders.semanticModel.connectedComponentId).toBe(tenantAUsers.semanticModel.connectedComponentId);
      expect(tenantBOrders.semanticModel.connectedComponentId).toBe(tenantBUsers.semanticModel.connectedComponentId);
      expect(tenantAOrders.semanticModel.connectedComponentId).not.toBe(tenantBOrders.semanticModel.connectedComponentId);
      expect(enrichedRelations.filter((relation) => relation.sourceSchema === "tenant_a")).toHaveLength(1);
      expect(enrichedRelations.filter((relation) => relation.sourceSchema === "tenant_b")).toHaveLength(1);
      expect(tenantAOrders.semanticModel.relationships?.[0]?.targetSchema).toBe("tenant_a");
      expect(tenantBOrders.semanticModel.relationships?.[0]?.targetSchema).toBe("tenant_b");
    });
  });

  (support.supported ? describe : describe.skip)("P2-01 & P2-05: Durable Worker & Recovery Proof", () => {
    let db: ReturnType<typeof createDb>;
    let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

    beforeAll(async () => {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-durable-onboarding-");
      db = createDb(temporary.connectionString);
    }, 90_000);

    beforeEach(async () => {
      pipelineMock.mockReset();
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await temporary?.cleanup();
    });

    async function seed(jobType = "external_db_onboarding") {
      const companyId = randomUUID();
      const sourceId = randomUUID();
      const jobId = randomUUID();
      const specialistAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Durable DB Co",
        issuePrefix: `D${companyId.slice(0, 8)}`,
      });
      await db.insert(dataSources).values({
        id: sourceId,
        companyId,
        name: "Postgres Production",
        sourceType: "postgres",
        status: "processing",
        metadata: { host: "localhost", database: "prod_db" },
      });
      await db.insert(agents).values({
        id: specialistAgentId,
        companyId,
        name: "Database Ingestion Agent",
        adapterType: "pi_local",
        adapterConfig: { model: "rissets/llm-hd/qwen3.8-27b" },
        metadata: { paperclipBuiltInAgent: { key: "database-ingestion", featureKeys: ["database-ingestion"] } },
      });
      await db.insert(dataSourceJobs).values({
        id: jobId,
        companyId,
        dataSourceId: sourceId,
        jobType,
        status: "queued",
        stage: "queued",
        idempotencyKey: `ext-onboard-${randomUUID()}`,
        progress: { schemaVersion: 1, specialistAgentId },
      });
      return { companyId, sourceId, jobId, specialistAgentId };
    }

    it("claims and executes external_db_onboarding job through DataSourceIngestionWorker", async () => {
      const { sourceId, jobId } = await seed();

      pipelineMock.mockImplementationOnce(async (_companyId, _sourceId, _progress, lease) => {
        await lease.reportProgress("connectivity", { schemaVersion: 1 });
        await lease.reportProgress("discovery", { tablesCount: 5 });
        await lease.reportProgress("publication", { tablesCount: 5 });
        await db.update(dataSources).set({ status: "ready" }).where(eq(dataSources.id, sourceId));
      });

      const worker = new DataSourceIngestionWorker(db, "external_db_onboarding");
      await worker.tick();

      expect(pipelineMock).toHaveBeenCalledTimes(1);
      const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
      const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));

      expect(job.status).toBe("succeeded");
      expect(job.stage).toBe("completed");
      expect(job.attempt).toBe(1);
      expect(source.status).toBe("ready");
    });

    it("supersedes an open Database Ingestion Agent run when a job lease is reclaimed", async () => {
      const { companyId, jobId, specialistAgentId } = await seed();
      const previousRunId = randomUUID();
      const startedAt = new Date(Date.now() - 60_000);
      await db.update(dataSourceJobs).set({
        status: "running",
        attempt: 1,
        leaseOwner: "expired-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }).where(eq(dataSourceJobs.id, jobId));
      await db.insert(heartbeatRuns).values({
        id: previousRunId,
        companyId,
        agentId: specialistAgentId,
        status: "running",
        runtimeMode: "builtin_ingestion",
        startedAt,
        resultJson: {
          jobId,
          attempt: 1,
          builtInAgentKey: "database-ingestion",
          stage: "table_mapping",
        },
      });
      pipelineMock.mockResolvedValueOnce(undefined);

      await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

      const [previousRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, previousRunId));
      expect(previousRun).toMatchObject({
        status: "interrupted",
        errorCode: "datasource_worker_lease_expired",
        resultJson: {
          stage: "interrupted",
          stopReason: "datasource_worker_lease_expired",
        },
      });
      const currentRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(currentRuns).toHaveLength(2);
      expect(currentRuns.filter((run) => run.status === "succeeded")).toHaveLength(1);
    });

    it("restores a false process_lost run while its datasource job lease is still live", async () => {
      const { companyId, jobId, specialistAgentId } = await seed();
      const runId = randomUUID();
      await db.update(dataSourceJobs).set({
        status: "running",
        attempt: 1,
        leaseOwner: "active-worker",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        progress: { specialistAgentId, stage: "table_mapping", currentTable: "core.entity" },
      }).where(eq(dataSourceJobs.id, jobId));
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: specialistAgentId,
        status: "failed",
        runtimeMode: "builtin_ingestion",
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        livenessState: "failed",
        livenessReason: "process_lost",
        startedAt: new Date(Date.now() - 6 * 60_000),
        finishedAt: new Date(),
        resultJson: {
          jobId,
          attempt: 1,
          builtInAgentKey: "database-ingestion",
          stage: "starting",
          stopReason: "process_lost",
          processLossDiagnostic: { pidRecorded: false, groupRecorded: false, localCheck: "no_identifiers" },
        },
      });

      await new DataSourceIngestionWorker(db, "external_db_onboarding").tick();

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(pipelineMock).not.toHaveBeenCalled();
      expect(run).toMatchObject({
        status: "running",
        error: null,
        errorCode: null,
        finishedAt: null,
        livenessState: "running",
        livenessReason: null,
      });
      expect(run.resultJson).toMatchObject({ stage: "table_mapping", recoveredAfterDatasourceLeaseCheck: true });
      expect(run.resultJson).not.toHaveProperty("processLossDiagnostic");
      expect(run.resultJson).not.toHaveProperty("stopReason");
    });

    it("handles cancellation gracefully when cancel_requested is set on the job", async () => {
      const { sourceId, jobId } = await seed();

      pipelineMock.mockImplementationOnce(async (_companyId, _sourceId, _progress, lease, signal) => {
        // Simulate job receiving cancel request while in progress
        await db.update(dataSourceJobs).set({ status: "cancel_requested" }).where(eq(dataSourceJobs.id, jobId));
        // Wait a tick for cancellation poller
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (signal?.aborted || lease.isCancellationRequested?.()) {
          throw new Error("Datasource onboarding was cancelled");
        }
      });

      const worker = new DataSourceIngestionWorker(db, "external_db_onboarding");
      await worker.tick();

      const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
      expect(job.status).toBe("cancelled");
      expect(job.stage).toBe("cancelled");
    });
  });
});
