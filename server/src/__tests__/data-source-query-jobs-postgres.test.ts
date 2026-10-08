import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companySecrets, createDb, dataSourceQueryJobs, dataSourceTables, dataSources } from "@paperclipai/db";
import { DataSourcesService } from "../services/data-sources.js";
import { DataSourceQueryJobsService } from "../services/data-source-query-jobs.js";
import { DataSourceQueryWorker } from "../services/data-source-query-worker.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataSourceRoutes } from "../routes/data-sources.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource query-job PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("durable datasource query jobs PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-query-jobs-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("hex"));
    await db.delete(activityLog);
    await db.delete(companySecrets);
    await db.delete(companies);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const dataSourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Query job test", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: dataSourceId,
      companyId,
      name: "External reporting database",
      sourceType: "postgres",
      status: "ready",
    });
    return { companyId, dataSourceId, service: new DataSourceQueryJobsService(db) };
  }

  it("accepts only bounded read-only work and exposes no submitted SQL in the job receipt", async () => {
    const { companyId, dataSourceId, service } = await seed();
    await expect(service.enqueue({
      companyId, dataSourceId, sql: "DELETE FROM orders", actor: { type: "board", id: "test-user" },
    })).rejects.toThrow("Only a single read-only SELECT");
    await expect(service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT * FROM orders",
      rowLimit: 1001,
      actor: { type: "board", id: "test-user" },
    })).rejects.toThrow("rowLimit");

    const job = await service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT * FROM orders WHERE account_id = $1",
      params: ["private-account-id"],
      rowLimit: 20,
      actor: { type: "board", id: "test-user" },
    });
    expect(job).toMatchObject({ status: "queued", rowLimit: 20, statementTimeoutMs: 30_000 });
    expect(JSON.stringify(job)).not.toContain("private-account-id");
    const [stored] = await db.select().from(dataSourceQueryJobs).where(eq(dataSourceQueryJobs.id, job.id));
    expect(stored.queryText).toContain("$1");
    expect(stored.queryParams).toEqual(["private-account-id"]);
    expect(stored.queryFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("queues an audited external snapshot only for single-primary-key tables", async () => {
    const { companyId, dataSourceId } = await seed();
    const keyedTableId = randomUUID();
    const unkeyedTableId = randomUUID();
    await db.insert(dataSourceTables).values([
      {
        id: keyedTableId, companyId, dataSourceId, tableName: "orders", rowCount: 20, columnCount: 2,
        schemaDefinition: [{ name: "id", dataType: "number", isPrimaryKey: true }, { name: "amount", dataType: "number" }],
        semanticModel: { sourceSchema: "reporting", clickhouseTable: "ds_orders" },
      },
      {
        id: unkeyedTableId, companyId, dataSourceId, tableName: "audit_log", rowCount: 2, columnCount: 1,
        schemaDefinition: [{ name: "message", dataType: "string" }], semanticModel: {},
      },
    ]);

    await expect(new DataSourcesService(db).enqueueExternalDatabaseSnapshot(companyId, dataSourceId, {
      tableIds: [unkeyedTableId],
      actor: { actorType: "user", actorId: "snapshot-operator" },
    })).rejects.toThrow("exactly one inspected primary key");

    const result = await new DataSourcesService(db).enqueueExternalDatabaseSnapshot(companyId, dataSourceId, {
      actor: { actorType: "user", actorId: "snapshot-operator" },
    });
    expect(result).toMatchObject({ status: "queued", tableCount: 1, skippedTableCount: 1 });
    expect(result.ingestionJob).toMatchObject({
      jobType: "external_db_snapshot",
      status: "queued",
      progress: { tableIds: [keyedTableId], totalTables: 1, skippedTableCount: 1, consistency: "best_effort_keyset" },
    });
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, dataSourceId));
    expect(source.status).toBe("ready");
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, dataSourceId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "data_source.external_snapshot.queued", actorType: "user", actorId: "snapshot-operator" });
  }, 30_000);

  it("serves enqueue, status, result, and cancellation routes behind company access", async () => {
    const { companyId, dataSourceId } = await seed();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "test-user", companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);

    const created = await request(app)
      .post(`/api/companies/${companyId}/data-sources/${dataSourceId}/query-jobs`)
      .send({ sql: "SELECT id FROM orders LIMIT 10", rowLimit: 20 })
      .expect(202);
    const jobId = created.body.data.id as string;
    expect(created.headers.location).toContain(`/query-jobs/${jobId}`);

    await request(app)
      .get(`/api/companies/${companyId}/data-sources/${dataSourceId}/query-jobs/${jobId}`)
      .expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ id: jobId, status: "queued" }));
    await request(app)
      .get(`/api/companies/${companyId}/data-sources/${dataSourceId}/query-jobs/${jobId}/result`)
      .expect(409);
    await request(app)
      .post(`/api/companies/${companyId}/data-sources/${dataSourceId}/query-jobs/${jobId}/cancel`)
      .expect(202)
      .expect(({ body }) => expect(body.data.status).toBe("cancelled"));
    await request(app)
      .get(`/api/companies/${randomUUID()}/data-sources/${dataSourceId}/query-jobs/${jobId}`)
      .expect(403);
  }, 30_000);

  it("denies structured queries immediately when the board user lacks the current source grant", async () => {
    const { companyId, dataSourceId } = await seed();
    const tableId = randomUUID();
    await db.insert(dataSourceTables).values({
      id: tableId,
      companyId,
      dataSourceId,
      tableName: "orders",
      rowCount: 1,
      columnCount: 1,
      schemaDefinition: [{ name: "amount", dataType: "number" }],
      semanticModel: { clickhouseTable: "ds_orders" },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "unassigned-user", companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/${dataSourceId}/tables/${tableId}/query`)
      .send({ aggregate: { column: "amount", fn: "sum" } })
      .expect(403);
  }, 30_000);

  it("rechecks agent authorization after a structured query before returning a cached result", async () => {
    const { companyId, dataSourceId } = await seed();
    const tableId = randomUUID();
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId, tableName: "orders", rowCount: 1, columnCount: 1,
      schemaDefinition: [{ name: "amount", dataType: "number" }], semanticModel: { clickhouseTable: "ds_orders" },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId: "agent-1", runId: "run-1" } as any;
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources")
      .mockResolvedValueOnce({ mode: "selected", dataSourceIds: [dataSourceId], effectiveDataSourceIds: [dataSourceId], collectionIds: [] } as any)
      .mockResolvedValueOnce({ mode: "none", dataSourceIds: [], effectiveDataSourceIds: [], collectionIds: [] } as any);
    const query = vi.spyOn(DataSourcesService.prototype, "queryTable").mockResolvedValue({
      tableId, tableName: "orders", columns: ["sum_amount"], rows: [{ sum_amount: 18 }], totalRows: 1,
    } as any);

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/${dataSourceId}/tables/${tableId}/query`)
      .send({ aggregate: { column: "amount", fn: "sum" } })
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("berubah saat query"));
    expect(query).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("authorizes a table against its owning datasource when a client puts the table ID in the datasource path", async () => {
    const { companyId, dataSourceId } = await seed();
    const tableId = randomUUID();
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId, tableName: "orders", rowCount: 1, columnCount: 1,
      schemaDefinition: [{ name: "amount", dataType: "number" }], semanticModel: { clickhouseTable: "ds_orders" },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId: "agent-1", runId: "run-1" } as any;
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources")
      .mockResolvedValueOnce({ mode: "selected", dataSourceIds: [dataSourceId], effectiveDataSourceIds: [dataSourceId], collectionIds: [] } as any)
      .mockResolvedValueOnce({ mode: "selected", dataSourceIds: [dataSourceId], effectiveDataSourceIds: [dataSourceId], collectionIds: [] } as any);
    const query = vi.spyOn(DataSourcesService.prototype, "queryTable").mockResolvedValue({
      tableId, tableName: "orders", columns: ["sum_amount"], rows: [{ sum_amount: 18 }], totalRows: 1,
    } as any);

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/${tableId}/tables/${tableId}/query`)
      .send({ aggregate: { column: "amount", fn: "sum" } })
      .expect(200)
      .expect(({ body }) => expect(body.tableId).toBe(tableId));

    expect(query).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("denies a table whose owning datasource is unassigned even when the URL names an assigned source", async () => {
    const { companyId, dataSourceId } = await seed();
    const unassignedSourceId = randomUUID();
    await db.insert(dataSources).values({
      id: unassignedSourceId,
      companyId,
      name: "Unassigned source",
      sourceType: "postgres",
      status: "ready",
    });
    const tableId = randomUUID();
    await db.insert(dataSourceTables).values({
      id: tableId, companyId, dataSourceId: unassignedSourceId, tableName: "private_orders", rowCount: 1, columnCount: 1,
      schemaDefinition: [{ name: "amount", dataType: "number" }], semanticModel: { clickhouseTable: "ds_private_orders" },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId: "agent-1", runId: "run-1" } as any;
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected", dataSourceIds: [dataSourceId], effectiveDataSourceIds: [dataSourceId], collectionIds: [],
    } as any);
    const query = vi.spyOn(DataSourcesService.prototype, "queryTable");

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/${dataSourceId}/tables/${tableId}/query`)
      .send({ aggregate: { column: "amount", fn: "sum" } })
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("pemilik tabel ini tidak ditugaskan"));

    expect(query).not.toHaveBeenCalled();
  }, 30_000);

  it("rechecks agent authorization after RAG lookup before returning cached candidates", async () => {
    const { companyId, dataSourceId } = await seed();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId: "agent-1", runId: "run-1" } as any;
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources")
      .mockResolvedValueOnce({ mode: "selected", dataSourceIds: [dataSourceId], effectiveDataSourceIds: [dataSourceId], collectionIds: [] } as any)
      .mockResolvedValueOnce({ mode: "none", dataSourceIds: [], effectiveDataSourceIds: [], collectionIds: [] } as any);
    const search = vi.spyOn(DataSourcesService.prototype, "searchKnowledge").mockResolvedValue([{
      chunkId: "chunk-1", dataSourceId, sourceName: "Revenue policy", content: "private source content", score: 0.9,
    }] as any);

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/search-knowledge`)
      .send({ query: "revenue", dataSourceId })
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("berubah saat retrieval"));
    expect(search).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("executes a queued job, stores a bounded result, and removes query text on completion", async () => {
    const { companyId, dataSourceId, service } = await seed();
    const job = await service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT id FROM orders LIMIT 10",
      actor: { type: "board", id: "test-user" },
    });
    vi.spyOn(DataSourcesService.prototype, "querySql").mockResolvedValue({
      columns: ["id"], rows: [{ id: "order-1" }], rowCount: 1, executionTimeMs: 4, sql: "SELECT id FROM orders LIMIT 10",
    });

    await new DataSourceQueryWorker(db).tick();

    const [stored] = await db.select().from(dataSourceQueryJobs).where(eq(dataSourceQueryJobs.id, job.id));
    expect(stored.status, stored.lastError || "missing job failure details").toBe("succeeded");
    expect(stored).toMatchObject({ queryText: null, queryParams: [], resultBytes: expect.any(Number) });
    expect(stored.result).toEqual({ columns: ["id"], rows: [{ id: "order-1" }], rowCount: 1, executionTimeMs: 4 });
    expect(JSON.stringify(stored.result)).not.toContain("SELECT id");
    expect((await service.getResult(companyId, dataSourceId, job.id)).rows).toEqual([{ id: "order-1" }]);
    await expect(service.get(randomUUID(), dataSourceId, job.id)).rejects.toThrow("Query job not found");
  }, 30_000);

  it("cancels the active driver signal when a running job is cancelled", async () => {
    const { companyId, dataSourceId, service } = await seed();
    const job = await service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT pg_sleep(10)",
      statementTimeoutMs: 10_000,
      actor: { type: "board", id: "test-user" },
    });
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.spyOn(DataSourcesService.prototype, "querySql").mockImplementation((_company, _source, _query, _limit, activeSignal) => {
      signal = activeSignal;
      markStarted();
      return new Promise((_resolve, reject) => {
        activeSignal!.addEventListener("abort", () => reject(Object.assign(new Error("driver cancelled"), { name: "AbortError" })), { once: true });
      });
    });

    const processing = new DataSourceQueryWorker(db).tick();
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("Worker never started query")), 5_000))]);
    await expect(service.cancel(companyId, dataSourceId, job.id, { type: "board", id: "someone-else" }))
      .rejects.toThrow("Only the actor who submitted");
    await service.cancel(companyId, dataSourceId, job.id, { type: "board", id: "test-user" });
    await processing;

    expect(signal?.aborted).toBe(true);
    expect((await service.get(companyId, dataSourceId, job.id)).status).toBe("cancelled");
  }, 30_000);

  it("cancels a live external PostgreSQL statement through the durable worker", async () => {
    const { companyId, dataSourceId, service } = await seed();
    const remoteUrl = new URL(temporary.connectionString);
    await db.update(dataSources).set({
      metadata: {
        rawConfig: {
          type: "postgres",
          host: remoteUrl.hostname,
          port: Number(remoteUrl.port),
          database: decodeURIComponent(remoteUrl.pathname.slice(1)),
          username: decodeURIComponent(remoteUrl.username),
          password: decodeURIComponent(remoteUrl.password),
          ssl: false,
        },
      },
    }).where(eq(dataSources.id, dataSourceId));
    const job = await service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT pg_sleep(20)",
      rowLimit: 1,
      statementTimeoutMs: 30_000,
      actor: { type: "board", id: "test-user" },
    });
    const worker = new DataSourceQueryWorker(db);
    const processing = worker.tick();
    let active = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db.execute(sql<{ active: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(20)%'
        ) AS active
      `);
      active = Array.from(rows as Iterable<{ active: boolean }>)[0]?.active === true;
      if (active) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(active).toBe(true);
    await service.cancel(companyId, dataSourceId, job.id, { type: "board", id: "test-user" });
    await processing;
    expect((await service.get(companyId, dataSourceId, job.id)).status).toBe("cancelled");
    const remaining = await db.execute(sql<{ count: string }>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(20)%'
    `);
    expect(Number(Array.from(remaining as Iterable<{ count: string }>)[0]?.count ?? 0)).toBe(0);
  }, 45_000);

  it("fails an expired running lease without automatically rerunning an uncertain remote query", async () => {
    const { companyId, dataSourceId, service } = await seed();
    const job = await service.enqueue({
      companyId,
      dataSourceId,
      sql: "SELECT 1",
      actor: { type: "board", id: "test-user" },
    });
    await db.update(dataSourceQueryJobs).set({
      status: "running",
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 1_000),
    }).where(and(eq(dataSourceQueryJobs.id, job.id), eq(dataSourceQueryJobs.companyId, companyId)));

    await new DataSourceQueryWorker(db).tick();

    const [stored] = await db.select().from(dataSourceQueryJobs).where(eq(dataSourceQueryJobs.id, job.id));
    expect(stored).toMatchObject({ status: "failed", queryText: null, leaseOwner: null });
    expect(stored.lastError).toContain("outcome is uncertain");
    expect(await service.get(companyId, dataSourceId, job.id)).toMatchObject({ status: "failed" });
  }, 30_000);
});
