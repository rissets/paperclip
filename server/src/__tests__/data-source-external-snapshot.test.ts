import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, companies, createDb, dataSourceChunks, dataSourceJobs, dataSourceTables, dataSources } from "@paperclipai/db";
import { DatabaseIntegrationService } from "../services/database-integration.js";
import { ClickhouseService } from "../services/clickhouse.js";
import { DataSourcesService } from "../services/data-sources.js";
import { DataSourceDatabaseConfigService } from "../services/data-source-database-config.js";
import { DataSourceVectorStore } from "../services/data-source-vector-store.js";
import { RagModelService } from "../services/rag-models.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("external datasource keyset snapshots", () => {
  it("uses a projected, qualified PostgreSQL keyset page with bounded limits", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: ["id", "amount"], rows: [{ id: 41, amount: 12.5 }], rowCount: 1, executionTimeMs: 3,
      sql: "SELECT \"id\", \"amount\" FROM \"reporting\".\"orders\" WHERE \"id\" > $1 ORDER BY \"id\" ASC LIMIT 2000",
    });

    const result = await integration.queryKeysetPage({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    }, {
      schemaName: "reporting", tableName: "orders", columns: ["id", "amount"],
      primaryKey: "id", after: 40, pageSize: 2_000,
    });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ type: "postgres" }),
      expect.stringContaining('FROM "reporting"."orders" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 2000'),
      2_000,
      [40],
      undefined,
      { statementTimeoutMs: 30_000 },
    );
    expect(result.rows).toEqual([{ id: 41, amount: 12.5 }]);
  });

  it("quotes MySQL identifiers and rejects tables or schemas outside configured allowlists", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: [], rows: [], rowCount: 0, executionTimeMs: 1, sql: "",
    });
    const config = {
      type: "mysql" as const, host: "db.internal", port: 3306, database: "warehouse", username: "reader",
      allowedSchemas: ["warehouse"], allowedTables: ["order items"],
    };

    await integration.queryKeysetPage(config, {
      schemaName: "warehouse", tableName: "order items", columns: ["order`id"],
      primaryKey: "order`id", pageSize: 100,
    });
    expect(query).toHaveBeenCalledWith(
      config,
      "SELECT `order``id` FROM `warehouse`.`order items` ORDER BY `order``id` ASC LIMIT 100",
      100,
      [],
      undefined,
      { statementTimeoutMs: 30_000 },
    );

    await expect(integration.queryKeysetPage(config, {
      schemaName: "other", tableName: "order items", columns: ["id"], primaryKey: "id", pageSize: 100,
    })).rejects.toThrow("schema is outside");
    await expect(integration.queryKeysetPage(config, {
      schemaName: "warehouse", tableName: "users", columns: ["id"], primaryKey: "id", pageSize: 100,
    })).rejects.toThrow("table is outside");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires a single schema match when recovering legacy PostgreSQL source metadata", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: ["table_schema"],
      rows: [{ table_schema: "reporting" }],
      rowCount: 1,
      executionTimeMs: 1,
      sql: "",
    });
    const config = { type: "postgres" as const, host: "db.internal", port: 5432, database: "warehouse", username: "reader" };

    query.mockResolvedValueOnce({
      columns: ["table_schema"], rows: [{ table_schema: "reporting" }], rowCount: 1, executionTimeMs: 1, sql: "",
    });
    await expect(integration.resolveTableSchema(config, "orders")).resolves.toBe("reporting");
    query.mockResolvedValueOnce({ columns: ["table_schema"], rows: [], rowCount: 0, executionTimeMs: 1, sql: "" });
    await expect(integration.resolveTableSchema(config, "missing")).rejects.toThrow("not found");
    query.mockResolvedValueOnce({
      columns: ["table_schema"], rows: [{ table_schema: "public" }, { table_schema: "reporting" }],
      rowCount: 2, executionTimeMs: 1, sql: "",
    });
    await expect(integration.resolveTableSchema(config, "orders")).rejects.toThrow("multiple schemas");
  });

  it("filters schema recovery inside PostgreSQL before applying the ambiguity limit", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: ["table_schema"], rows: [{ table_schema: "reporting" }], rowCount: 1, executionTimeMs: 1, sql: "",
    });

    await expect(integration.resolveTableSchema({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"],
    }, "orders")).resolves.toBe("reporting");
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSchemas: ["reporting"] }),
      expect.stringContaining("AND table_schema = ANY($2::text[])"),
      2,
      ["orders", ["reporting"]],
    );
  });

  it("reads incremental rows in an updated-at and primary-key cursor with bounded parameters", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: ["id", "updated_at", "amount"], rows: [{ id: 8, updated_at: new Date("2026-10-01T00:00:01.000Z"), amount: 4 }],
      rowCount: 1, executionTimeMs: 2, sql: "",
    });
    const config = {
      type: "postgres" as const, host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    };

    await integration.queryUpdatedKeysetPage(config, {
      schemaName: "reporting", tableName: "orders", columns: ["id", "updated_at", "deleted_at", "amount"],
      primaryKey: "id", updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at", since: "2026-10-01T00:00:00.000Z",
      after: { updatedAt: "2026-10-01 00:00:00.500123", primaryKey: 7 }, pageSize: 2_000,
    });

    expect(query).toHaveBeenCalledWith(
      config,
      'SELECT "id", "updated_at", "deleted_at", "amount", CAST(GREATEST(COALESCE("updated_at", "deleted_at"), COALESCE("deleted_at", "updated_at")) AS TEXT) AS _paperclip_sync_change_cursor FROM "reporting"."orders" WHERE GREATEST(COALESCE("updated_at", "deleted_at"), COALESCE("deleted_at", "updated_at")) >= $1 AND (GREATEST(COALESCE("updated_at", "deleted_at"), COALESCE("deleted_at", "updated_at")) > $2 OR (GREATEST(COALESCE("updated_at", "deleted_at"), COALESCE("deleted_at", "updated_at")) = $3 AND "id" > $4)) ORDER BY GREATEST(COALESCE("updated_at", "deleted_at"), COALESCE("deleted_at", "updated_at")) ASC, "id" ASC LIMIT 2000',
      2_000,
      ["2026-10-01T00:00:00.000Z", "2026-10-01 00:00:00.500123", "2026-10-01 00:00:00.500123", 7],
      undefined,
      { statementTimeoutMs: 30_000 },
    );
  });

  it("uses portable MySQL timestamp cursor SQL and requires cursor columns in the projection", async () => {
    const integration = new DatabaseIntegrationService();
    const query = vi.spyOn(integration, "queryDatabase").mockResolvedValue({
      columns: [], rows: [], rowCount: 0, executionTimeMs: 1, sql: "",
    });
    const config = {
      type: "mysql" as const, host: "db.internal", port: 3306, database: "warehouse", username: "reader",
      allowedSchemas: ["warehouse"], allowedTables: ["orders"],
    };

    await integration.queryUpdatedKeysetPage(config, {
      schemaName: "warehouse", tableName: "orders", columns: ["id", "updated_at", "deleted_at"],
      primaryKey: "id", updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at",
      since: "2026-10-01T00:00:00.000Z", pageSize: 250,
    });
    expect(query).toHaveBeenCalledWith(
      config,
      "SELECT `id`, `updated_at`, `deleted_at`, CAST(GREATEST(COALESCE(`updated_at`, `deleted_at`), COALESCE(`deleted_at`, `updated_at`)) AS CHAR) AS _paperclip_sync_change_cursor FROM `warehouse`.`orders` WHERE GREATEST(COALESCE(`updated_at`, `deleted_at`), COALESCE(`deleted_at`, `updated_at`)) >= ? ORDER BY GREATEST(COALESCE(`updated_at`, `deleted_at`), COALESCE(`deleted_at`, `updated_at`)) ASC, `id` ASC LIMIT 250",
      250,
      ["2026-10-01T00:00:00.000Z"],
      undefined,
      { statementTimeoutMs: 30_000 },
    );
    await expect(integration.queryUpdatedKeysetPage(config, {
      schemaName: "warehouse", tableName: "orders", columns: ["id", "updated_at"],
      primaryKey: "id", updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at",
      since: "2026-10-01T00:00:00.000Z", pageSize: 250,
    })).rejects.toThrow("bounded projection");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`External snapshot PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("external datasource snapshot publication PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-external-snapshot-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(companies);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("reconciles terminal unreferenced ClickHouse targets without dropping active bases or deltas", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const orphanTableId = randomUUID();
    const activeBaseTableId = randomUUID();
    const activeDeltaTableId = randomUUID();
    const activeAttemptTableId = randomUUID();
    const recentPendingTableId = randomUUID();
    const activeAttemptJobId = randomUUID();
    const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    const recentTimestamp = new Date(Date.now() - 60_000).toISOString();
    const orphanTarget = "ds_orders_active__g_deadbeef01_1_12345678";
    const activeBase = "ds_users_active";
    const activeDelta = "ds_accounts_active__d_deadbeef01_1_87654321";
    await db.insert(companies).values({ id: companyId, name: "Snapshot reconciliation", issuePrefix: `O${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready" });
    await db.insert(dataSourceJobs).values({
      id: jobId, companyId, dataSourceId: sourceId, jobType: "external_db_snapshot", status: "failed",
      attempt: 2, maxAttempts: 2, idempotencyKey: randomUUID(),
    });
    await db.insert(dataSourceJobs).values({
      id: activeAttemptJobId, companyId, dataSourceId: sourceId, jobType: "external_db_snapshot", status: "running",
      attempt: 2, maxAttempts: 3, leaseOwner: "live-snapshot-worker", leaseExpiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: randomUUID(),
    });
    await db.insert(dataSourceTables).values([
      {
        id: orphanTableId, companyId, dataSourceId: sourceId, tableName: "orders", schemaDefinition: [],
        semanticModel: {
          clickhouseTable: "ds_orders_active",
          externalSnapshot: { status: "ready", deltaTables: [], rowCount: 5 },
          pendingExternalSnapshot: {
            jobId, attempt: 2, status: "staging", pendingTargetTable: orphanTarget,
            pendingStageTable: "ds_orders_active__g_deadbeef01_1_12345678__s_stage",
            cleanupTargets: ["ds_orders_active__g_deadbeef01_1_abcdef12"], startedAt: oldTimestamp,
          },
        },
      },
      {
        id: activeBaseTableId, companyId, dataSourceId: sourceId, tableName: "users", schemaDefinition: [],
        semanticModel: {
          clickhouseTable: activeBase,
          externalSnapshot: { status: "ready", deltaTables: [], rowCount: 1 },
          pendingExternalSnapshot: { jobId, attempt: 2, pendingTargetTable: activeBase, publishStartedAt: oldTimestamp },
        },
      },
      {
        id: activeDeltaTableId, companyId, dataSourceId: sourceId, tableName: "accounts", schemaDefinition: [],
        semanticModel: {
          clickhouseTable: "ds_accounts_active",
          externalSnapshot: { status: "ready", deltaTables: [activeDelta], rowCount: 2 },
          pendingExternalSnapshot: { jobId, attempt: 2, pendingTargetTable: activeDelta, publishStartedAt: oldTimestamp },
        },
      },
      {
        id: activeAttemptTableId, companyId, dataSourceId: sourceId, tableName: "events", schemaDefinition: [],
        semanticModel: {
          clickhouseTable: "ds_events_active",
          externalSnapshot: { status: "ready", deltaTables: [], rowCount: 3 },
          pendingExternalSnapshot: {
            jobId: activeAttemptJobId, attempt: 2, pendingTargetTable: "ds_events_active__g_cafefeed01_2_12345678",
            publishStartedAt: oldTimestamp,
          },
        },
      },
      {
        id: recentPendingTableId, companyId, dataSourceId: sourceId, tableName: "recent", schemaDefinition: [],
        semanticModel: {
          clickhouseTable: "ds_recent_active",
          externalSnapshot: { status: "ready", deltaTables: [], rowCount: 4 },
          pendingExternalSnapshot: {
            jobId, attempt: 2, pendingTargetTable: "ds_recent_active__g_deadbeef01_1_12345678",
            publishStartedAt: recentTimestamp,
          },
        },
      },
    ]);
    const drop = vi.spyOn(ClickhouseService.prototype, "execute").mockResolvedValue(undefined);

    await expect(new DataSourcesService(db).reconcilePendingExternalSnapshotTargets(10)).resolves.toBe(1);

    expect(drop).toHaveBeenCalledTimes(3);
    const droppedTables = drop.mock.calls.map(([statement]) => statement);
    expect(droppedTables).toContain(`DROP TABLE IF EXISTS \`${orphanTarget}\``);
    expect(droppedTables).toContain("DROP TABLE IF EXISTS `ds_orders_active__g_deadbeef01_1_12345678__s_stage`");
    expect(droppedTables).toContain("DROP TABLE IF EXISTS `ds_orders_active__g_deadbeef01_1_abcdef12`");
    expect(droppedTables).not.toContain(`DROP TABLE IF EXISTS \`${activeBase}\``);
    expect(droppedTables).not.toContain(`DROP TABLE IF EXISTS \`${activeDelta}\``);
    for (const [, , signal] of drop.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
    const [reconciled] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, orphanTableId));
    const [base] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, activeBaseTableId));
    const [delta] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, activeDeltaTableId));
    const [activeAttempt] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, activeAttemptTableId));
    const [recent] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, recentPendingTableId));
    expect(reconciled.semanticModel).toMatchObject({ clickhouseTable: "ds_orders_active", externalSnapshot: { status: "ready", rowCount: 5 } });
    expect(reconciled.semanticModel).not.toHaveProperty("pendingExternalSnapshot");
    expect(base.semanticModel).toHaveProperty("pendingExternalSnapshot");
    expect(delta.semanticModel).toHaveProperty("pendingExternalSnapshot");
    expect(activeAttempt.semanticModel).toHaveProperty("pendingExternalSnapshot");
    expect(recent.semanticModel).toHaveProperty("pendingExternalSnapshot");
  }, 30_000);

  (process.env.DATASOURCE_TEST_CLICKHOUSE_URL ? it : it.skip)(
    "preserves the live snapshot and reconciles a real ClickHouse target after an exchange failure",
    async () => {
      const clickhouseUrl = process.env.DATASOURCE_TEST_CLICKHOUSE_URL!;
      const clickhouseUser = process.env.DATASOURCE_TEST_CLICKHOUSE_USER || "default";
      const clickhousePassword = process.env.DATASOURCE_TEST_CLICKHOUSE_PASSWORD || "";
      const companyId = randomUUID();
      const sourceId = randomUUID();
      const tableId = randomUUID();
      const jobId = randomUUID();
      const incrementalJobId = randomUUID();
      const owner = `snapshot-live-${randomUUID()}`;
      const schemaName = `snapshot_fixture_${companyId.replaceAll("-", "")}`;
      const activeTable = `ds_${companyId.replaceAll("-", "").slice(0, 20)}_live`;
      const externalUrl = new URL(temporary.connectionString);
      const databaseConfig = {
        type: "postgres" as const,
        host: externalUrl.hostname,
        port: Number(externalUrl.port),
        database: decodeURIComponent(externalUrl.pathname.slice(1)),
        username: decodeURIComponent(externalUrl.username),
        password: decodeURIComponent(externalUrl.password),
        ssl: false,
        allowedSchemas: [schemaName],
        allowedTables: ["orders"],
      };
      vi.stubEnv("CLICKHOUSE_URL", clickhouseUrl);
      vi.stubEnv("CLICKHOUSE_USER", clickhouseUser);
      vi.stubEnv("CLICKHOUSE_PASSWORD", clickhousePassword);
      vi.stubEnv("CLICKHOUSE_DATABASE", "default");
      const clickhouse = new ClickhouseService();
      const companyDatabase = clickhouse.getCompanyDatabase(companyId);
      const snapshotProgress = {
        tableIds: [tableId],
        syncMode: "incremental",
        tablePolicies: [{ tableId, updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at" }],
        totalTables: 1,
      };
      let schemaCreated = false;

      try {
        await db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        schemaCreated = true;
        await db.execute(sql.raw(`CREATE TABLE "${schemaName}"."orders" ("id" BIGINT PRIMARY KEY, "amount" NUMERIC(12, 2) NOT NULL, "updated_at" TIMESTAMPTZ NOT NULL, "deleted_at" TIMESTAMPTZ)`));
        await db.execute(sql.raw(`INSERT INTO "${schemaName}"."orders" VALUES
          (1, 10.25, '2026-09-01T00:00:00Z', NULL), (2, 20.50, '2026-09-01T00:00:00Z', NULL)`));
        await db.insert(companies).values({ id: companyId, name: "Live snapshot crash window", issuePrefix: `L${companyId.slice(0, 7)}` });
        await db.insert(dataSources).values({ id: sourceId, companyId, name: "Live external source", sourceType: "postgres", status: "ready" });
        await db.insert(dataSourceTables).values({
          id: tableId,
          companyId,
          dataSourceId: sourceId,
          tableName: "orders",
          rowCount: 1,
          columnCount: 4,
          schemaDefinition: [
            { name: "id", dataType: "number", isPrimaryKey: true, clickhouseType: "Int64" },
            { name: "amount", dataType: "number", clickhouseType: "Decimal(12, 2)" },
            { name: "updated_at", dataType: "date", clickhouseType: "DateTime64(6, 'UTC')" },
            { name: "deleted_at", dataType: "date", clickhouseType: "Nullable(DateTime64(6, 'UTC'))" },
          ],
          semanticModel: {
            sourceSchema: schemaName,
            clickhouseTable: activeTable,
            clickhouseSchema: {},
            externalSnapshot: { engine: "merge_delta_v1", status: "ready", deltaTables: [], rowCount: 1 },
          },
        });
        await db.insert(dataSourceJobs).values({
          id: jobId,
          companyId,
          dataSourceId: sourceId,
          jobType: "external_db_snapshot",
          status: "running",
          stage: "snapshot_read",
          attempt: 1,
          maxAttempts: 2,
          leaseOwner: owner,
          leaseExpiresAt: new Date(Date.now() + 120_000),
          progress: snapshotProgress,
          idempotencyKey: randomUUID(),
        });

        await clickhouse.ensureCompanyDatabase(companyId);
        await clickhouse.execute(`CREATE TABLE \`${activeTable}\` (\`id\` Int64, \`amount\` Decimal(12, 2), \`updated_at\` DateTime64(6, 'UTC'), \`deleted_at\` Nullable(DateTime64(6, 'UTC')), \`_paperclip_sync_version\` UInt64, \`_paperclip_sync_deleted\` UInt8) ENGINE = MergeTree() ORDER BY (\`id\`)`, companyDatabase);
        await clickhouse.execute(`INSERT INTO \`${activeTable}\` VALUES (1, 99.00, '2026-09-01 00:00:00', NULL, 0, 0)`, companyDatabase);
        vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue(databaseConfig);

        const realExecute = ClickhouseService.prototype.execute;
        let exchanged = false;
        const exchangeFailure = vi.spyOn(ClickhouseService.prototype, "execute").mockImplementation(async function (statement, dbName, signal) {
          await realExecute.call(this, statement, dbName, signal);
          if (!exchanged && /^(?:RENAME|EXCHANGE) TABLE/i.test(statement.trim())) {
            exchanged = true;
            throw new Error("simulated process loss after ClickHouse exchange");
          }
        });
        const service = new DataSourcesService(db);
        await expect(service.runExternalDatabaseSnapshot(companyId, sourceId, snapshotProgress, {
          jobId, owner, attempt: 1,
        })).rejects.toThrow("simulated process loss after ClickHouse exchange");
        expect(exchanged).toBe(true);
        exchangeFailure.mockRestore();

        const [pendingTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        const pendingModel = pendingTable.semanticModel as Record<string, any>;
        const orphanTarget = pendingModel.pendingExternalSnapshot.pendingTargetTable as string;
        expect(pendingModel.clickhouseTable).toBe(activeTable);
        expect(await clickhouse.query(`SELECT count() AS rows FROM \`${activeTable}\``, companyDatabase).then((result) => result.rows[0]?.rows)).toBe(1);
        expect(await clickhouse.listTables(companyId)).toContain(orphanTarget);

        await db.update(dataSourceTables).set({ semanticModel: {
          ...pendingModel,
          pendingExternalSnapshot: {
            ...pendingModel.pendingExternalSnapshot,
            publishStartedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
          },
        } }).where(eq(dataSourceTables.id, tableId));
        await db.update(dataSourceJobs).set({ status: "failed", leaseOwner: null, leaseExpiresAt: null })
          .where(eq(dataSourceJobs.id, jobId));

        await expect(service.reconcilePendingExternalSnapshotTargets(8)).resolves.toBe(1);
        const [readyTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        expect(readyTable.semanticModel?.clickhouseTable).toBe(activeTable);
        expect(readyTable.semanticModel).not.toHaveProperty("pendingExternalSnapshot");
        const clickhouseTables = await clickhouse.listTables(companyId);
        expect(clickhouseTables).toContain(activeTable);
        expect(clickhouseTables).not.toContain(orphanTarget);

        const retryOwner = `${owner}-retry`;
        await db.update(dataSourceJobs).set({
          status: "running", attempt: 2, leaseOwner: retryOwner, leaseExpiresAt: new Date(Date.now() + 120_000),
        }).where(eq(dataSourceJobs.id, jobId));
        await service.runExternalDatabaseSnapshot(companyId, sourceId, snapshotProgress, {
          jobId, owner: retryOwner, attempt: 2,
        });
        const [bootstrappedTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        expect(bootstrappedTable.rowCount).toBe(2);
        expect(bootstrappedTable.semanticModel?.externalSnapshot).toMatchObject({
          status: "ready", syncMode: "incremental", consistency: "best_effort_keyset", rowCount: 2,
          updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at",
        });
        const bootstrapRows = await service.queryTable(companyId, tableId, { mode: "snapshot", limit: 10 });
        expect(bootstrapRows.totalRows).toBe(2);
        expect(bootstrapRows.rows.map((row) => row.id).sort()).toEqual([1, 2]);

        const changedAt = new Date(Date.now() + 2_000).toISOString();
        const externalTable = sql.raw(`"${schemaName}"."orders"`);
        await db.execute(sql`UPDATE ${externalTable} SET amount = 12.00, updated_at = ${changedAt}::timestamptz WHERE id = 1`);
        await db.execute(sql`UPDATE ${externalTable} SET deleted_at = ${changedAt}::timestamptz WHERE id = 2`);
        await db.execute(sql`INSERT INTO ${externalTable} (id, amount, updated_at, deleted_at) VALUES (3, 4.00, ${changedAt}::timestamptz, NULL)`);
        await db.insert(dataSourceJobs).values({
          id: incrementalJobId,
          companyId,
          dataSourceId: sourceId,
          jobType: "external_db_snapshot",
          status: "running",
          stage: "snapshot_read",
          attempt: 1,
          maxAttempts: 2,
          leaseOwner: `${owner}-incremental`,
          leaseExpiresAt: new Date(Date.now() + 120_000),
          progress: snapshotProgress,
          idempotencyKey: randomUUID(),
        });
        await service.runExternalDatabaseSnapshot(companyId, sourceId, snapshotProgress, {
          jobId: incrementalJobId, owner: `${owner}-incremental`, attempt: 1,
        });
        const [incrementalTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        expect(incrementalTable.rowCount).toBe(2);
        expect(incrementalTable.semanticModel?.externalSnapshot).toMatchObject({
          status: "ready", syncMode: "incremental", consistency: "best_effort_updated_at", rowCount: 2,
          deleteSemantics: "soft_delete_column",
        });
        expect((incrementalTable.semanticModel?.externalSnapshot as Record<string, unknown>).deltaTables).toHaveLength(1);
        const logicalRows = await service.queryTable(companyId, tableId, { mode: "snapshot", limit: 10 });
        expect(logicalRows.totalRows).toBe(2);
        expect(logicalRows.rows.map((row) => row.id).sort()).toEqual([1, 3]);
        expect(logicalRows.querySource).toMatchObject({ mode: "snapshot", consistency: "best_effort_updated_at" });
        const logicalAggregate = await service.queryTable(companyId, tableId, {
          mode: "snapshot", aggregate: { column: "amount", fn: "sum" },
        });
        expect(Number(logicalAggregate.rows[0]?.sum_amount)).toBeCloseTo(16, 4);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await clickhouse.execute(`DROP DATABASE IF EXISTS \`${companyDatabase}\``).catch(() => {});
        if (schemaCreated) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)).catch(() => {});
      }
    },
    90_000,
  );

  (process.env.DATASOURCE_TEST_CLICKHOUSE_URL ? it : it.skip)(
    "reclaims a real ClickHouse stage after SIGKILL and publishes the takeover attempt",
    async () => {
      const clickhouseUrl = process.env.DATASOURCE_TEST_CLICKHOUSE_URL!;
      const clickhouseUser = process.env.DATASOURCE_TEST_CLICKHOUSE_USER || "default";
      const clickhousePassword = process.env.DATASOURCE_TEST_CLICKHOUSE_PASSWORD || "";
      const companyId = randomUUID();
      const sourceId = randomUUID();
      const tableId = randomUUID();
      const jobId = randomUUID();
      const schemaName = `snapshot_kill_${companyId.replaceAll("-", "")}`;
      const activeTable = `ds_${companyId.replaceAll("-", "").slice(0, 20)}_active`;
      const externalUrl = new URL(temporary.connectionString);
      const databaseConfig = {
        type: "postgres" as const,
        host: externalUrl.hostname,
        port: Number(externalUrl.port),
        database: decodeURIComponent(externalUrl.pathname.slice(1)),
        username: decodeURIComponent(externalUrl.username),
        password: decodeURIComponent(externalUrl.password),
        ssl: false,
        allowedSchemas: [schemaName],
        allowedTables: ["orders"],
      };
      const clickhouse = new ClickhouseService({ url: clickhouseUrl, user: clickhouseUser, password: clickhousePassword, database: "default" });
      const companyDatabase = clickhouse.getCompanyDatabase(companyId);
      let schemaCreated = false;
      let proxy: ReturnType<typeof createServer> | undefined;
      let firstWorker: ChildProcess | undefined;
      let retryWorker: ChildProcess | undefined;
      const workerOutput: string[] = [];
      let resolveFirstInsert!: () => void;
      const firstInsertAccepted = new Promise<void>((resolve) => { resolveFirstInsert = resolve; });
      let pauseFirstInsert = true;

      const stopChild = async (child: ChildProcess | undefined, signal: "SIGTERM" | "SIGKILL") => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill(signal);
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
      };

      try {
        vi.stubEnv("CLICKHOUSE_URL", clickhouseUrl);
        vi.stubEnv("CLICKHOUSE_USER", clickhouseUser);
        vi.stubEnv("CLICKHOUSE_PASSWORD", clickhousePassword);
        vi.stubEnv("CLICKHOUSE_DATABASE", "default");
        await db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        schemaCreated = true;
        await db.execute(sql.raw(`CREATE TABLE "${schemaName}"."orders" ("id" BIGINT PRIMARY KEY, "payload" TEXT NOT NULL)`));
        await db.execute(sql.raw(`INSERT INTO "${schemaName}"."orders" SELECT value, repeat('x', 1000) FROM generate_series(1, 20000) AS value`));
        await db.insert(companies).values({ id: companyId, name: "Hard-killed snapshot worker", issuePrefix: `K${companyId.slice(0, 7)}` });
        await db.insert(dataSources).values({
          id: sourceId,
          companyId,
          name: "Snapshot crash fixture",
          sourceType: "postgres",
          status: "ready",
          metadata: { rawConfig: databaseConfig },
        });
        await db.insert(dataSourceTables).values({
          id: tableId,
          companyId,
          dataSourceId: sourceId,
          tableName: "orders",
          rowCount: 1,
          columnCount: 2,
          schemaDefinition: [
            { name: "id", dataType: "number", isPrimaryKey: true, clickhouseType: "Int64" },
            { name: "payload", dataType: "string", clickhouseType: "String" },
          ],
          semanticModel: {
            sourceSchema: schemaName,
            clickhouseTable: activeTable,
            externalSnapshot: { engine: "merge_delta_v1", status: "ready", deltaTables: [], rowCount: 1 },
          },
        });
        await db.insert(dataSourceJobs).values({
          id: jobId,
          companyId,
          dataSourceId: sourceId,
          jobType: "external_db_snapshot",
          status: "queued",
          maxAttempts: 2,
          progress: { tableIds: [tableId], syncMode: "full", totalTables: 1 },
          idempotencyKey: randomUUID(),
        });

        await clickhouse.ensureCompanyDatabase(companyId);
        await clickhouse.execute(`CREATE TABLE \`${activeTable}\` (\`id\` Int64, \`payload\` String, \`_paperclip_sync_version\` UInt64, \`_paperclip_sync_deleted\` UInt8) ENGINE = MergeTree() ORDER BY (\`id\`)`, companyDatabase);
        await clickhouse.execute(`INSERT INTO \`${activeTable}\` VALUES (0, 'previous snapshot', 0, 0)`, companyDatabase);

        proxy = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            const target = new URL(request.url || "/", clickhouseUrl);
            const headers: Record<string, string> = {};
            for (const name of ["authorization", "content-type", "x-clickhouse-user", "x-clickhouse-key"]) {
              const value = request.headers[name];
              if (typeof value === "string") headers[name] = value;
            }
            const upstream = await fetch(target, {
              method: request.method || "POST",
              headers,
              body: body.length > 0 ? body : undefined,
            });
            const upstreamBody = Buffer.from(await upstream.arrayBuffer());
            const query = target.searchParams.get("query") || "";
            if (pauseFirstInsert && /^INSERT INTO/i.test(query)) {
              pauseFirstInsert = false;
              resolveFirstInsert();
              await Promise.race([
                new Promise<void>((resolve) => response.once("close", () => resolve())),
                new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
              ]);
            }
            if (response.destroyed) return;
            response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "text/plain" });
            response.end(upstreamBody);
          })().catch(() => {
            if (!response.destroyed) response.writeHead(502).end();
          });
        });
        await new Promise<void>((resolve, reject) => {
          proxy!.once("error", reject);
          proxy!.listen(0, "127.0.0.1", resolve);
        });
        const proxyPort = (proxy.address() as { port: number }).port;
        const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
        const loader = `${serverRoot}/node_modules/tsx/dist/loader.mjs`;
        const workerScript = [
          'import { createDb } from "@paperclipai/db";',
          'import { DataSourceIngestionWorker } from "./src/services/data-source-ingestion-worker.ts";',
          'import { DataSourceDatabaseConfigService } from "./src/services/data-source-database-config.ts";',
          'const external = new URL(process.env.DATASOURCE_TEST_EXTERNAL_DATABASE_URL);',
          'DataSourceDatabaseConfigService.prototype.resolve = async () => ({',
          '  type: "postgres", host: external.hostname, port: Number(external.port),',
          '  database: decodeURIComponent(external.pathname.slice(1)), username: decodeURIComponent(external.username),',
          '  password: decodeURIComponent(external.password), ssl: false,',
          '  allowedSchemas: [process.env.DATASOURCE_TEST_SCHEMA], allowedTables: ["orders"],',
          '});',
          'const db = createDb(process.env.DATABASE_URL);',
          'const worker = new DataSourceIngestionWorker(db, "external_db_snapshot");',
          'let stopping = false;',
          'process.once("SIGTERM", () => { stopping = true; worker.stop(); });',
          'while (!stopping) { await worker.tick(); if (!stopping) await new Promise(resolve => setTimeout(resolve, 50)); }',
          'await db.$client.end({ timeout: 2 });',
        ].join("\n");
        const spawnWorker = (workerClickhouseUrl: string) => {
          const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", workerScript], {
            cwd: serverRoot,
            env: {
              ...process.env,
              DATABASE_URL: temporary.connectionString,
              DATASOURCE_TEST_EXTERNAL_DATABASE_URL: temporary.connectionString,
              DATASOURCE_TEST_SCHEMA: schemaName,
              CLICKHOUSE_URL: workerClickhouseUrl,
              CLICKHOUSE_USER: clickhouseUser,
              CLICKHOUSE_PASSWORD: clickhousePassword,
              CLICKHOUSE_DATABASE: "default",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout?.on("data", (chunk: Buffer) => workerOutput.push(String(chunk)));
          child.stderr?.on("data", (chunk: Buffer) => workerOutput.push(String(chunk)));
          return child;
        };

        firstWorker = spawnWorker(`http://127.0.0.1:${proxyPort}`);
        const insertAccepted = await Promise.race([
          firstInsertAccepted.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
        ]);
        expect(insertAccepted, `the first worker never reached a real ClickHouse insert; child output: ${workerOutput.join("").slice(-4000)}`).toBe(true);
        const [stagingTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        const stagingModel = stagingTable.semanticModel as Record<string, any>;
        const firstTarget = stagingModel.pendingExternalSnapshot.pendingTargetTable as string;
        const firstStage = stagingModel.pendingExternalSnapshot.pendingStageTable as string;
        expect(stagingModel).toMatchObject({ clickhouseTable: activeTable, pendingExternalSnapshot: { status: "staging", attempt: 1 } });
        const stagedCount = await clickhouse.query<{ rows: number | string }>(`SELECT count() AS rows FROM \`${firstStage}\``, companyDatabase);
        expect(Number(stagedCount.rows[0]?.rows)).toBeGreaterThan(0);
        const oldSnapshotCount = await clickhouse.query<{ rows: number | string }>(`SELECT count() AS rows FROM \`${activeTable}\``, companyDatabase);
        expect(Number(oldSnapshotCount.rows[0]?.rows)).toBe(1);

        const killed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => firstWorker!.once("exit", (code, signal) => resolve({ code, signal })));
        firstWorker.kill("SIGKILL");
        expect(await killed).toEqual({ code: null, signal: "SIGKILL" });
        await db.update(dataSourceJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(dataSourceJobs.id, jobId));

        retryWorker = spawnWorker(clickhouseUrl);
        let completedJob: typeof dataSourceJobs.$inferSelect | undefined;
        for (let attempt = 0; attempt < 900; attempt += 1) {
          [completedJob] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, jobId));
          if (completedJob?.status === "succeeded" || completedJob?.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(completedJob?.status, completedJob?.lastError || "replacement worker did not finish the snapshot").toBe("succeeded");
        expect(completedJob?.attempt).toBe(2);
        const [publishedTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
        expect(publishedTable.rowCount).toBe(20_000);
        expect(publishedTable.semanticModel).not.toHaveProperty("pendingExternalSnapshot");
        const tables = await clickhouse.listTables(companyId);
        expect(tables).toContain(publishedTable.semanticModel?.clickhouseTable);
        expect(tables).not.toContain(firstTarget);
        expect(tables).not.toContain(firstStage);
        const visibleRows = await new DataSourcesService(db).queryTable(companyId, tableId, { mode: "snapshot", limit: 3 });
        expect(visibleRows.totalRows).toBe(20_000);
        expect(visibleRows.rows).toHaveLength(3);

        const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => retryWorker!.once("exit", (code, signal) => resolve({ code, signal })));
        retryWorker.kill("SIGTERM");
        expect(await stopped).toEqual({ code: 0, signal: null });
      } finally {
        await stopChild(firstWorker, "SIGKILL");
        await stopChild(retryWorker, "SIGTERM");
        if (proxy) {
          proxy.closeAllConnections();
          await new Promise<void>((resolve) => proxy!.close(() => resolve()));
        }
        await clickhouse.execute(`DROP DATABASE IF EXISTS \`${companyDatabase}\``).catch(() => {});
        if (schemaCreated) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)).catch(() => {});
      }
    },
    180_000,
  );

  it("fences a ClickHouse table exchange, records its receipt, and skips completed tables after retry", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    const owner = `snapshot-test-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Snapshot test", issuePrefix: `S${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready",
    });
    await db.insert(dataSourceTables).values({
      id: tableId,
      companyId,
      dataSourceId: sourceId,
      tableName: "orders",
      rowCount: 0,
      columnCount: 2,
      schemaDefinition: [
        { name: "id", dataType: "number", isPrimaryKey: true, clickhouseType: "UInt64" },
        { name: "amount", dataType: "number", clickhouseType: "Float64" },
      ],
      semanticModel: {
        sourceSchema: "reporting",
        clickhouseTable: "ds_orders",
        externalSnapshot: {
          engine: "merge_delta_v1", status: "ready", deltaTables: ["ds_orders__d_old_12345678"], rowCount: 0,
        },
      },
    });
    const service = new DataSourcesService(db);
    const enqueued = await service.enqueueExternalDatabaseSnapshot(companyId, sourceId, {
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    await db.update(dataSourceJobs).set({
      status: "running", attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000),
    }).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));

    const databaseConfig = {
      type: "postgres" as const, host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    };
    vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue(databaseConfig);
    const readPage = vi.spyOn(DatabaseIntegrationService.prototype, "queryKeysetPage").mockResolvedValue({
      columns: ["id", "amount"], rows: [{ id: 1, amount: 8 }], rowCount: 1, executionTimeMs: 2, sql: "",
    });
    vi.spyOn(ClickhouseService.prototype, "query").mockResolvedValue({
      columns: ["row_count"], rows: [{ row_count: 1 }], rowCount: 1, executionTimeMs: 1, meta: [],
    } as any);
    const clickhouseExecute = vi.spyOn(ClickhouseService.prototype, "execute").mockResolvedValue(undefined);
    let exchangeCalls = 0;
    const exchange = vi.spyOn(ClickhouseService.prototype, "syncTableFromStream").mockImplementation(async (
      _tableName, _ddl, rows, _companyId, onProgress, publicationFence,
    ) => {
      let insertedCount = 0;
      for await (const _row of rows) insertedCount++;
      await onProgress?.(insertedCount);
      await publicationFence?.(insertedCount, async () => { exchangeCalls++; });
      return { created: true, insertedCount, dbName: "paperclip_test" };
    });
    const lease = { jobId: enqueued.ingestionJob.id, owner, attempt: 1 };
    await service.runExternalDatabaseSnapshot(companyId, sourceId, enqueued.ingestionJob.progress, lease);

    expect(exchangeCalls).toBe(1);
    expect(readPage).toHaveBeenCalledTimes(1);
    const [publishedTable] = await db.select().from(dataSourceTables).where(and(
      eq(dataSourceTables.id, tableId), eq(dataSourceTables.companyId, companyId),
    ));
    expect(publishedTable.rowCount).toBe(1);
    expect(publishedTable.semanticModel).toMatchObject({
      externalSnapshot: { status: "ready", engine: "merge_delta_v1", consistency: "best_effort_keyset", rowCount: 1, primaryKey: "id", deltaTables: [] },
    });
    expect(clickhouseExecute).toHaveBeenCalledWith(
      "DROP TABLE IF EXISTS `ds_orders__d_old_12345678`",
      expect.any(String),
    );
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    expect(job.progress).toMatchObject({ publishedTableIds: [tableId], completedTables: 1, stage: "snapshot_publish" });

    await service.runExternalDatabaseSnapshot(companyId, sourceId, job.progress, lease);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(readPage).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("keeps the active snapshot through a failed receipt and isolates retry attempts", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    const owner = `snapshot-retry-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Snapshot retry", issuePrefix: `R${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready" });
    await db.insert(dataSourceTables).values({
      id: tableId,
      companyId,
      dataSourceId: sourceId,
      tableName: "orders",
      rowCount: 1,
      columnCount: 2,
      schemaDefinition: [
        { name: "id", dataType: "number", isPrimaryKey: true, clickhouseType: "UInt64" },
        { name: "amount", dataType: "number", clickhouseType: "Float64" },
      ],
      semanticModel: {
        sourceSchema: "reporting",
        clickhouseTable: "ds_orders_live",
        externalSnapshot: { engine: "merge_delta_v1", status: "ready", deltaTables: [], rowCount: 1 },
      },
    });
    const service = new DataSourcesService(db);
    const enqueued = await service.enqueueExternalDatabaseSnapshot(companyId, sourceId, {
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    await db.update(dataSourceJobs).set({
      status: "running", attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000),
    }).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    });
    vi.spyOn(DatabaseIntegrationService.prototype, "queryKeysetPage").mockResolvedValue({
      columns: ["id", "amount"], rows: [{ id: 2, amount: 12 }], rowCount: 1, executionTimeMs: 2, sql: "",
    });
    const query = vi.spyOn(ClickhouseService.prototype, "query")
      .mockRejectedValueOnce(new Error("synthetic receipt failure"))
      .mockResolvedValue({
        columns: ["row_count"], rows: [{ row_count: 1 }], rowCount: 1, executionTimeMs: 1, meta: [],
      } as any);
    const cleanup = vi.spyOn(ClickhouseService.prototype, "execute").mockResolvedValue(undefined);
    const targets: string[] = [];
    const publishedClickHouseTargets: string[] = [];
    vi.spyOn(ClickhouseService.prototype, "syncTableFromStream").mockImplementation(async (
      tableName, _ddl, rows, _companyId, _onProgress, publicationFence,
    ) => {
      targets.push(tableName);
      let insertedCount = 0;
      for await (const _row of rows) insertedCount += 1;
      await publicationFence?.(insertedCount, async () => { publishedClickHouseTargets.push(tableName); });
      return { created: true, insertedCount, dbName: "paperclip_test" };
    });
    const lease = { jobId: enqueued.ingestionJob.id, owner, attempt: 1 };
    const [initialTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));

    await expect(service.runExternalDatabaseSnapshot(companyId, sourceId, enqueued.ingestionJob.progress, lease))
      .rejects.toThrow("synthetic receipt failure");
    const [pending] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
    expect(pending.updatedAt.toISOString()).toBe(initialTable.updatedAt.toISOString());
    expect(pending.semanticModel?.clickhouseTable).toBe("ds_orders_live");
    expect(pending.semanticModel?.externalSnapshot).toMatchObject({ status: "ready", rowCount: 1 });
    expect(pending.semanticModel?.pendingExternalSnapshot).toMatchObject({ status: "publishing", pendingTargetTable: targets[0], attempt: 1 });
    expect(targets[0]).toMatch(/^ds_orders_live__g_[a-f0-9]{10}_[a-z0-9]+_[a-f0-9]{8}$/);
    expect(publishedClickHouseTargets).toEqual([targets[0]]);

    await db.update(dataSourceJobs).set({ attempt: 2, leaseOwner: `${owner}-successor` })
      .where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    await service.runExternalDatabaseSnapshot(companyId, sourceId, job.progress, {
      jobId: job.id, owner: `${owner}-successor`, attempt: 2,
    });
    const [ready] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
    expect(query).toHaveBeenCalledTimes(2);
    expect(targets).toHaveLength(2);
    expect(targets[1]).not.toBe(targets[0]);
    expect(publishedClickHouseTargets[1]).toBe(targets[1]);
    expect(cleanup).toHaveBeenCalledWith(`DROP TABLE IF EXISTS \`${targets[0]}\``, expect.any(String));
    expect(ready.semanticModel?.clickhouseTable).toBe(targets[1]);
    expect(ready.semanticModel).not.toHaveProperty("pendingExternalSnapshot");
    expect(ready.semanticModel?.externalSnapshot).toMatchObject({
      status: "ready", deltaTables: [], rowCount: 1,
    });
    expect(publishedClickHouseTargets).toEqual([targets[0], targets[1]]);
  }, 30_000);

  it("publishes incremental upserts and tombstones as an atomic ClickHouse delta pointer", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    const owner = `incremental-test-${randomUUID()}`;
    const oldWatermark = BigInt(new Date("2026-10-01T00:00:00.000Z").getTime()) * 1_000n;
    const updateAt = new Date("2026-10-01T00:00:05.000Z");
    const tombstoneAt = new Date("2026-10-01T00:00:06.000Z");
    await db.insert(companies).values({ id: companyId, name: "Incremental snapshot", issuePrefix: `I${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready" });
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId: sourceId, tableName: "orders", rowCount: 1, columnCount: 4,
      schemaDefinition: [
        { name: "id", dataType: "number", role: "identifier", isPrimaryKey: true, clickhouseType: "UInt64" },
        { name: "updated_at", dataType: "date", role: "timestamp", clickhouseType: "DateTime64(3)" },
        { name: "deleted_at", dataType: "date", role: "timestamp", clickhouseType: "Nullable(DateTime64(3))" },
        { name: "amount", dataType: "number", role: "metric", clickhouseType: "Float64" },
      ],
      semanticModel: {
        sourceSchema: "reporting", clickhouseTable: "ds_orders",
        externalSnapshot: {
          mode: "snapshot", engine: "merge_delta_v1", status: "ready", primaryKey: "id",
          updatedAtColumn: "updated_at", watermarkMicros: oldWatermark.toString(), syncGeneration: 4,
          deltaTables: [], rowCount: 1, completedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
    const service = new DataSourcesService(db);
    const enqueued = await service.enqueueExternalDatabaseSnapshot(companyId, sourceId, {
      mode: "incremental",
      tableIds: [tableId],
      tablePolicies: [{ tableId, updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at" }],
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    await db.update(dataSourceJobs).set({
      status: "running", attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000),
    }).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    });
    const readChanges = vi.spyOn(DatabaseIntegrationService.prototype, "queryUpdatedKeysetPage").mockResolvedValue({
      columns: ["id", "updated_at", "deleted_at", "amount"],
      rows: [
        { id: 1, updated_at: updateAt, deleted_at: null, amount: 12 },
        { id: 2, updated_at: new Date("2026-09-30T23:59:59.000Z"), deleted_at: tombstoneAt, amount: 0 },
      ],
      rowCount: 2, executionTimeMs: 2, sql: "",
    });
    vi.spyOn(ClickhouseService.prototype, "query").mockResolvedValue({
      columns: ["row_delta"], rows: [{ row_delta: 0 }], rowCount: 1, executionTimeMs: 1, meta: [],
    } as any);
    let publishedDelta = "";
    let streamedRows: Record<string, unknown>[] = [];
    vi.spyOn(ClickhouseService.prototype, "syncTableFromStream").mockImplementation(async (
      tableName, ddl, rows, _companyId, _onProgress, publicationFence,
    ) => {
      publishedDelta = tableName;
      expect(ddl).toContain("_paperclip_sync_version");
      expect(ddl).toContain("_paperclip_sync_deleted");
      streamedRows = [];
      for await (const row of rows) streamedRows.push(row);
      await publicationFence?.(streamedRows.length, async () => {});
      return { created: true, insertedCount: streamedRows.length, dbName: "paperclip_test" };
    });

    await service.runExternalDatabaseSnapshot(companyId, sourceId, enqueued.ingestionJob.progress, {
      jobId: enqueued.ingestionJob.id, owner, attempt: 1,
    });

    expect(publishedDelta).toMatch(/^ds_orders__d_/);
    expect(streamedRows).toHaveLength(2);
    expect(streamedRows[0]).toMatchObject({ id: 1, amount: 12, _paperclip_sync_deleted: 0 });
    expect(streamedRows[0]._paperclip_sync_version).toBe(String(BigInt(updateAt.getTime()) * 1_024n + 5n));
    expect(streamedRows[1]).toMatchObject({ id: 2, _paperclip_sync_deleted: 1 });
    expect(streamedRows[1]._paperclip_sync_version).toBe(String(BigInt(tombstoneAt.getTime()) * 1_024n + 5n));
    expect(readChanges).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at",
    }));
    const [publishedTable] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
    expect(publishedTable.rowCount).toBe(1);
    expect(publishedTable.semanticModel).toMatchObject({
      externalSnapshot: {
        status: "ready", syncMode: "incremental", consistency: "best_effort_updated_at",
        deleteSemantics: "soft_delete_column", updatedAtColumn: "updated_at", deletedAtColumn: "deleted_at",
        watermarkMicros: (BigInt(tombstoneAt.getTime()) * 1_000n).toString(), syncGeneration: 5,
        deltaTables: [publishedDelta], rowCount: 1,
      },
    });
    const queryCalls = vi.mocked(ClickhouseService.prototype.query).mock.calls;
    expect(queryCalls.some(([query]) => query.includes("LIMIT 1 BY `id`"))).toBe(true);
    expect(queryCalls.some(([query]) => query.includes("LEFT JOIN") && query.includes("AS row_delta") && query.includes("IN (SELECT `id`"))).toBe(true);
    const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    expect(job.progress).toMatchObject({ publishedTableIds: [tableId], completedTables: 1 });
  }, 30_000);

  it("bootstraps a first incremental request with a full snapshot before setting its watermark", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    const owner = `incremental-bootstrap-${randomUUID()}`;
    const updatedAt = new Date("2026-10-01T00:00:03.123Z");
    await db.insert(companies).values({ id: companyId, name: "Incremental bootstrap", issuePrefix: `B${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready" });
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId: sourceId, tableName: "orders", rowCount: 0, columnCount: 3,
      schemaDefinition: [
        { name: "id", dataType: "number", role: "identifier", isPrimaryKey: true, clickhouseType: "UInt64" },
        { name: "updated_at", dataType: "date", role: "timestamp", clickhouseType: "DateTime64(3)" },
        { name: "amount", dataType: "number", role: "metric", clickhouseType: "Float64" },
      ],
      semanticModel: { sourceSchema: "reporting", clickhouseTable: "ds_orders" },
    });
    const service = new DataSourcesService(db);
    const enqueued = await service.enqueueExternalDatabaseSnapshot(companyId, sourceId, {
      mode: "incremental",
      tableIds: [tableId],
      tablePolicies: [{ tableId, updatedAtColumn: "updated_at" }],
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    await db.update(dataSourceJobs).set({
      status: "running", attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000),
    }).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
      allowedSchemas: ["reporting"], allowedTables: ["orders"],
    });
    const readFull = vi.spyOn(DatabaseIntegrationService.prototype, "queryKeysetPage").mockResolvedValue({
      columns: ["id", "updated_at", "amount"], rows: [{ id: 1, updated_at: updatedAt, amount: 12 }],
      rowCount: 1, executionTimeMs: 1, sql: "",
    });
    const readIncremental = vi.spyOn(DatabaseIntegrationService.prototype, "queryUpdatedKeysetPage");
    vi.spyOn(ClickhouseService.prototype, "query").mockResolvedValue({
      columns: ["row_count"], rows: [{ row_count: 1 }], rowCount: 1, executionTimeMs: 1, meta: [],
    } as any);
    let streamedRow: Record<string, unknown> | undefined;
    let targetTable = "";
    vi.spyOn(ClickhouseService.prototype, "syncTableFromStream").mockImplementation(async (
      tableName, _ddl, rows, _companyId, _onProgress, publicationFence,
    ) => {
      targetTable = tableName;
      expect(tableName).toMatch(/^ds_orders__g_[a-f0-9]{10}_[a-z0-9]+_[a-f0-9]{8}$/);
      for await (const row of rows) streamedRow = row;
      await publicationFence?.(1, async () => {});
      return { created: true, insertedCount: 1, dbName: "paperclip_test" };
    });

    await service.runExternalDatabaseSnapshot(companyId, sourceId, enqueued.ingestionJob.progress, {
      jobId: enqueued.ingestionJob.id, owner, attempt: 1,
    });

    expect(readFull).toHaveBeenCalledTimes(1);
    expect(readIncremental).not.toHaveBeenCalled();
    expect(streamedRow?._paperclip_sync_version).toBe(String(BigInt(updatedAt.getTime()) * 1_024n + 1n));
    const [table] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
    expect(table.semanticModel?.clickhouseTable).toBe(targetTable);
    expect(table.semanticModel).toMatchObject({
      externalSnapshot: {
        status: "ready", syncMode: "incremental", consistency: "best_effort_keyset",
        watermarkMicros: (BigInt(updatedAt.getTime()) * 1_000n).toString(), deltaTables: [],
      },
    });
  }, 30_000);

  it("fails closed when the lease is lost before publishing a staged snapshot", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const owner = `snapshot-test-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Snapshot lease test", issuePrefix: `L${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "External reporting", sourceType: "postgres", status: "ready" });
    const tableId = randomUUID();
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId: sourceId, tableName: "orders", rowCount: 0, columnCount: 1,
      schemaDefinition: [{ name: "id", dataType: "number", isPrimaryKey: true, clickhouseType: "UInt64" }],
      semanticModel: { sourceSchema: "reporting", clickhouseTable: "ds_orders" },
    });
    const service = new DataSourcesService(db);
    const enqueued = await service.enqueueExternalDatabaseSnapshot(companyId, sourceId, {
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    await db.update(dataSourceJobs).set({
      status: "running", attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() - 1_000),
    }).where(eq(dataSourceJobs.id, enqueued.ingestionJob.id));
    vi.spyOn(DataSourceDatabaseConfigService.prototype, "resolve").mockResolvedValue({
      type: "postgres", host: "db.internal", port: 5432, database: "warehouse", username: "reader",
    });
    vi.spyOn(DatabaseIntegrationService.prototype, "queryKeysetPage").mockResolvedValue({
      columns: ["id"], rows: [{ id: 1 }], rowCount: 1, executionTimeMs: 1, sql: "",
    });
    let exchangeCalls = 0;
    vi.spyOn(ClickhouseService.prototype, "syncTableFromStream").mockImplementation(async (
      _tableName, _ddl, rows, _companyId, _onProgress, publicationFence,
    ) => {
      let insertedCount = 0;
      for await (const _row of rows) insertedCount++;
      await publicationFence?.(insertedCount, async () => { exchangeCalls++; });
      return { created: true, insertedCount, dbName: "paperclip_test" };
    });

    await expect(service.runExternalDatabaseSnapshot(companyId, sourceId, enqueued.ingestionJob.progress, {
      jobId: enqueued.ingestionJob.id, owner, attempt: 1,
    })).rejects.toThrow("ownership was lost");
    expect(exchangeCalls).toBe(0);
    const [table] = await db.select().from(dataSourceTables).where(eq(dataSourceTables.id, tableId));
    expect((table.semanticModel as any)?.externalSnapshot?.status).not.toBe("ready");
  }, 30_000);

  it("caches deterministic ClickHouse results by data revision and effective authorization scope", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const tableId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Query cache test", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: sourceId, companyId, name: "Sales CSV", sourceType: "csv", status: "ready",
    });
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId: sourceId, tableName: "orders", rowCount: 10, columnCount: 2,
      schemaDefinition: [
        { name: "id", dataType: "number" },
        { name: "amount", dataType: "number" },
      ],
      semanticModel: { clickhouseTable: "ds_orders" },
    });

    const service = new DataSourcesService(db);
    const memoryCache = new Map<string, unknown>();
    vi.spyOn((service as any).cache, "getOrComputeJson").mockImplementation(async (
      key: string, _validate: unknown, _ttl: number, compute: () => Promise<unknown>,
    ) => {
      if (memoryCache.has(key)) return memoryCache.get(key);
      const value = await compute();
      memoryCache.set(key, value);
      return value;
    });
    vi.spyOn(ClickhouseService.prototype, "getCompanyDatabase").mockReturnValue("company_test");
    vi.spyOn(ClickhouseService.prototype, "listTables").mockResolvedValue(["ds_orders"]);
    const query = vi.spyOn(ClickhouseService.prototype, "query").mockResolvedValue({
      columns: ["sum_amount", "total_rows"],
      rows: [{ sum_amount: 82, total_rows: 10 }],
      rowCount: 1,
      executionTimeMs: 4,
      sql: "SELECT sum(amount)",
    });

    const options = { aggregate: { column: "amount", fn: "sum" as const }, authzFingerprint: "scope-a" };
    const first = await service.queryTable(companyId, tableId, options);
    const warm = await service.queryTable(companyId, tableId, options);
    const separateScope = await service.queryTable(companyId, tableId, { ...options, authzFingerprint: "scope-b" });

    expect(first).toEqual(warm);
    expect(separateScope).toEqual(first);
    expect(query).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("keys RAG retrieval cache by authorized scope and current source revision", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RAG cache test", issuePrefix: `R${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: sourceId, companyId, name: "Revenue policy", sourceType: "rag_document", status: "ready",
    });
    await db.insert(dataSourceChunks).values({
      companyId,
      dataSourceId: sourceId,
      chunkIndex: 0,
      title: "Revenue",
      content: "Customer revenue increased in the latest reporting period.",
      tokenCount: 9,
      metadata: {},
      embedding: null,
    });
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.spyOn(RagModelService.prototype, "embed").mockResolvedValue({ vectors: null, space: null, generation: null, backend: null });

    const service = new DataSourcesService(db);
    const memo = new Map<string, unknown>();
    const cacheKeys: string[] = [];
    vi.spyOn((service as any).cache, "getOrComputeJson").mockImplementation(async (
      key: string, validate: (value: unknown) => boolean, _ttl: number, compute: () => Promise<unknown>,
    ) => {
      cacheKeys.push(key);
      const cached = memo.get(key);
      if (cached !== undefined && validate(cached)) return cached;
      const value = await compute();
      if (validate(value)) memo.set(key, value);
      return value;
    });

    const first = await service.searchKnowledge(companyId, "customer revenue", { authzFingerprint: "scope-a" });
    const warm = await service.searchKnowledge(companyId, "customer revenue", { authzFingerprint: "scope-a" });
    expect(first).toEqual(warm);
    expect(first).toHaveLength(1);
    expect(new Set(cacheKeys).size).toBe(2);

    await service.searchKnowledge(companyId, "customer revenue", { authzFingerprint: "scope-b" });
    expect(new Set(cacheKeys).size).toBe(3);
    await db.update(dataSources).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(dataSources.id, sourceId));
    await service.searchKnowledge(companyId, "customer revenue", { authzFingerprint: "scope-a" });
    expect(new Set(cacheKeys).size).toBe(4);
  }, 30_000);

  it("searches each datasource using its active embedding generation during model migration", async () => {
    const companyId = randomUUID();
    const bgeSourceId = randomUUID();
    const gatewaySourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Mixed embedding generations", issuePrefix: `M${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values([
      {
        id: bgeSourceId, companyId, name: "BGE policy", sourceType: "rag_document", status: "ready",
        metadata: {
          embeddingSpace: "bge-m3",
          embeddingGeneration: new RagModelService().embeddingGeneration("bge-m3"),
          embeddingStatus: "ready",
        },
      },
      {
        id: gatewaySourceId, companyId, name: "Gateway policy", sourceType: "rag_document", status: "ready",
        metadata: {
          embeddingSpace: "openrouter-text-embedding-3-small",
          embeddingGeneration: new RagModelService().embeddingGeneration("openrouter-text-embedding-3-small"),
          embeddingStatus: "ready",
        },
      },
    ]);
    const [bgeChunk] = await db.insert(dataSourceChunks).values({
      companyId, dataSourceId: bgeSourceId, chunkIndex: 0, content: "Layanan memakai jaringan radio generasi baru.",
      tokenCount: 7, metadata: { embeddingSpace: "bge-m3" }, embedding: null,
    }).returning({ id: dataSourceChunks.id });
    const [gatewayChunk] = await db.insert(dataSourceChunks).values({
      companyId, dataSourceId: gatewaySourceId, chunkIndex: 0, content: "Perangkat inti melayani koneksi wilayah timur.",
      tokenCount: 7, metadata: { embeddingSpace: "openrouter-text-embedding-3-small" }, embedding: null,
    }).returning({ id: dataSourceChunks.id });

    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "auto");
    const embed = vi.spyOn(RagModelService.prototype, "embed").mockImplementation(async (_texts, space) => ({
      vectors: [Array.from({ length: space === "bge-m3" ? 1_024 : 1_536 }, (_, index) => index === 0 ? 1 : 0)],
      space: space || "bge-m3",
      generation: new RagModelService().embeddingGeneration(space || "bge-m3"),
      backend: space === "bge-m3" ? "local-bge-m3" : "openrouter",
    }));
    const vectorSearch = vi.spyOn(DataSourceVectorStore.prototype, "search").mockImplementation(async (options) => {
      if (options.embeddingSpace === "bge-m3") return new Map([[bgeChunk.id, 0.91]]);
      return new Map([[gatewayChunk.id, 0.89]]);
    });

    const results = await new DataSourcesService(db).searchKnowledge(companyId, "unrelated retrieval probe", {
      bypassRetrievalCache: true,
    });

    expect(embed.mock.calls.map(([, space]) => space)).toEqual(["bge-m3", "openrouter-text-embedding-3-small"]);
    expect(vectorSearch.mock.calls.map(([options]) => [options.embeddingSpace, options.dataSourceIds])).toEqual([
      ["bge-m3", [bgeSourceId]],
      ["openrouter-text-embedding-3-small", [gatewaySourceId]],
    ]);
    expect(results.map((result) => result.dataSourceId)).toEqual(expect.arrayContaining([bgeSourceId, gatewaySourceId]));
  }, 30_000);

  it("keeps an old gateway alias lexical-only when the provider reports a new resolved model", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retargeted embedding alias", issuePrefix: `RA${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "Alias-indexed policy",
      sourceType: "rag_document",
      status: "ready",
      metadata: {
        embeddingSpace: "openrouter-text-embedding-3-small",
        embeddingGeneration: new RagModelService().embeddingGeneration("openrouter-text-embedding-3-small"),
        embeddingStatus: "ready",
      },
    });
    await db.insert(dataSourceChunks).values({
      companyId,
      dataSourceId: sourceId,
      chunkIndex: 0,
      content: "Jadwal perawatan jaringan tersedia setiap minggu.",
      tokenCount: 8,
      metadata: { embeddingSpace: "openrouter-text-embedding-3-small" },
      embedding: null,
    });
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.spyOn(RagModelService.prototype, "embed").mockResolvedValue({
      vectors: [Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0)],
      space: "openrouter-text-embedding-3-small",
      generation: "openrouter-text-embedding-3-small@openai/text-embedding-3-small",
      backend: "openrouter",
    });
    const vectorSearch = vi.spyOn(DataSourceVectorStore.prototype, "search");

    await new DataSourcesService(db).searchKnowledge(companyId, "jadwal perawatan jaringan", {
      bypassRetrievalCache: true,
    });

    expect(vectorSearch).not.toHaveBeenCalled();
  }, 30_000);

  it("invalidates all-source retrieval cache after one publication in a large catalogue", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Large datasource catalogue", issuePrefix: `L${companyId.slice(0, 8)}` });
    const sources = Array.from({ length: 512 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      name: `Knowledge source ${index}`,
      sourceType: "rag_document",
      status: "ready",
      metadata: { embeddingStatus: "unavailable" },
    }));
    await db.insert(dataSources).values(sources);
    const targetSource = sources[257]!;
    await db.insert(dataSourceChunks).values({
      companyId,
      dataSourceId: targetSource.id,
      chunkIndex: 0,
      title: "Fiber capacity",
      content: "The fiber capacity is eight ports per cabinet.",
      tokenCount: 9,
      metadata: {},
      embedding: null,
    });
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const service = new DataSourcesService(db);
    const memo = new Map<string, unknown>();
    const cacheKeys: string[] = [];
    vi.spyOn((service as any).cache, "getOrComputeJson").mockImplementation(async (
      key: string, validate: (value: unknown) => boolean, _ttl: number, run: () => Promise<unknown>,
    ) => {
      cacheKeys.push(key);
      const cached = memo.get(key);
      if (cached !== undefined && validate(cached)) return cached;
      const value = await run();
      if (validate(value)) memo.set(key, value);
      return value;
    });

    const options = { authzFingerprint: "all-company-sources" };
    const first = await service.searchKnowledge(companyId, "fiber capacity", options);
    const warm = await service.searchKnowledge(companyId, "fiber capacity", options);
    await db.update(dataSources).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(dataSources.id, sources[511]!.id));
    const afterPublication = await service.searchKnowledge(companyId, "fiber capacity", options);

    expect(first).toHaveLength(1);
    expect(warm).toEqual(first);
    expect(afterPublication).toEqual(first);
    expect(new Set(cacheKeys).size).toBe(2);
    expect(cacheKeys[0]).toBe(cacheKeys[1]);
    expect(cacheKeys[1]).not.toBe(cacheKeys[2]);
  }, 30_000);
});
