import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rewriteClickhouseQueryWithFinal,
  ClickhouseService,
} from "../services/clickhouse.js";
import { StructuredIngestionService } from "../services/structured-ingestion.js";
import { DatabaseIntegrationService } from "../services/database-integration.js";
import { QuestionDeadlineBudget } from "../services/question-deadline-budget.js";
import {
  DataSourceCacheService,
  makePlanCacheKey,
  type CachedParameterizedPlanResult,
} from "../services/data-source-cache.js";

afterEach(async () => {
  await DatabaseIntegrationService.shutdownPools();
});

describe("Package P5: ClickHouse Workload Design, Pools, Deadlines & Cache", () => {
  describe("P5-01: ClickHouse typed version/ordering/deduplication workload design", () => {
    it("rewrites queries targeting ReplacingMergeTree tables with FINAL to guarantee deduplicated aggregates", () => {
      const targets = new Set(["ds_sales", "ds_orders"]);

      const query1 = "SELECT count(), sum(total) FROM ds_sales WHERE status = 'paid'";
      const rewritten1 = rewriteClickhouseQueryWithFinal(query1, targets);
      expect(rewritten1).toBe("SELECT count(), sum(total) FROM ds_sales FINAL WHERE status = 'paid'");

      // Preserves existing FINAL clause without duplicate insertion
      const queryWithFinal = "SELECT * FROM ds_sales FINAL WHERE id = 1";
      const rewrittenWithFinal = rewriteClickhouseQueryWithFinal(queryWithFinal, targets);
      expect(rewrittenWithFinal).toBe("SELECT * FROM ds_sales FINAL WHERE id = 1");

      // Works with JOINs
      const joinQuery = "SELECT a.id, b.total FROM ds_customers a JOIN ds_orders b ON a.id = b.cust_id";
      const rewrittenJoin = rewriteClickhouseQueryWithFinal(joinQuery, targets);
      expect(rewrittenJoin).toBe("SELECT a.id, b.total FROM ds_customers a JOIN ds_orders FINAL b ON a.id = b.cust_id");
    });

    it("synthesizes ReplacingMergeTree schema with version column and final deduplication strategy when version/timestamp is present", () => {
      const service = new StructuredIngestionService();
      const rows = [
        { id: "TX-1", updated_at: "2026-10-01T10:00:00Z", total: "500000" },
        { id: "TX-2", updated_at: "2026-10-02T11:00:00Z", total: "750000" },
      ];

      const model = service.synthesizeSemanticModel("sales_orders", rows, {
        primaryKey: "id",
      });

      expect(model.clickhouseSchema?.engine).toBe("ReplacingMergeTree");
      expect(model.clickhouseSchema?.versionColumn).toBe("updated_at");
      expect(model.clickhouseSchema?.deduplicationStrategy).toBe("final");
      expect(model.clickhouseSchema?.createTableDdl).toContain("ENGINE = ReplacingMergeTree(`updated_at`)");
      expect(model.clickhouseSchema?.createTableDdl).toContain("ORDER BY (`id`)");
    });

    it("synthesizes standard MergeTree when no version/timestamp column is present", () => {
      const service = new StructuredIngestionService();
      const rows = [
        { code: "PRD-1", category: "Electronics" },
        { code: "PRD-2", category: "Furniture" },
      ];

      const model = service.synthesizeSemanticModel("categories", rows, {
        primaryKey: "code",
      });

      expect(model.clickhouseSchema?.engine).toBe("MergeTree");
      expect(model.clickhouseSchema?.versionColumn).toBeUndefined();
      expect(model.clickhouseSchema?.deduplicationStrategy).toBe("none");
      expect(model.clickhouseSchema?.createTableDdl).toContain("ENGINE = MergeTree()");
    });

    it("propagates deduplicateTables and statement timeout into ClickhouseService.query", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        meta: [{ name: "cnt", type: "UInt64" }],
        data: [{ cnt: 42 }],
        rows: 1,
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);

      const ch = new ClickhouseService({ url: "http://clickhouse.test:8123" });
      const res = await ch.query("SELECT count() FROM ds_sales", "test_db", {}, {
        deduplicateTables: ["ds_sales"],
        statementTimeoutSeconds: 25,
      });

      expect(res.rows).toEqual([{ cnt: 42 }]);
      const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(requestUrl.searchParams.get("max_execution_time")).toBe("25");
      const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);
      expect(requestBody).toContain("FROM ds_sales FINAL");
      vi.unstubAllGlobals();
    });
  });

  describe("P5-02: External bounded pools, credential rotation & driver cancellation", () => {
    it("shares persistent PostgreSQL pools across service wrappers and invalidates on credential rotation", async () => {
      await DatabaseIntegrationService.shutdownPools();
      const dbService = new DatabaseIntegrationService();
      const baseConfig = {
        type: "postgres" as const,
        host: "localhost",
        port: 5432,
        database: "crm_db",
        username: "app_user",
        password: "secret_password_v1",
      };

      const key1 = dbService.getPoolKey(baseConfig);
      const hash1 = dbService.getCredentialHash(baseConfig);
      expect(key1).toBe("postgres:localhost:5432:crm_db:app_user:false");

      // Rotate password
      const rotatedConfig = { ...baseConfig, password: "secret_password_v2" };
      const hash2 = dbService.getCredentialHash(rotatedConfig);
      expect(hash2).not.toBe(hash1);

      const firstClient = dbService.getPostgresSql(baseConfig, 5);
      const secondClient = new DatabaseIntegrationService().getPostgresSql(baseConfig, 1);
      expect(secondClient).toBe(firstClient);

      const rotatedClient = new DatabaseIntegrationService().getPostgresSql(rotatedConfig, 1);
      expect(rotatedClient).not.toBe(firstClient);

      // Invalidate pool explicitly
      dbService.invalidatePool(baseConfig);
      await DatabaseIntegrationService.shutdownPools();
    });

    it("evicts idle pools based on elapsed time threshold", () => {
      const dbService = new DatabaseIntegrationService();
      // Should not throw and clean up any expired idle pools
      dbService.evictIdlePools(0);
    });
  });

  describe("P5-03: Whole-question 55s deadline budget & retry policy", () => {
    it("tracks 55s ceiling, remaining budget, and database timeout allocation", () => {
      const budget = new QuestionDeadlineBudget({ totalBudgetMs: 55_000, reserveMs: 12_000, maxDatabaseTimeoutMs: 20_000 });
      expect(budget.totalBudgetMs).toBe(55_000);
      expect(budget.getRemainingBudgetMs()).toBeGreaterThan(50_000);
      expect(budget.isBudgetExceeded()).toBe(false);

      // Statement timeout respects max cap of 20s while keeping reserve
      const dbTimeout = budget.getDatabaseStatementTimeoutMs();
      expect(dbTimeout).toBe(20_000);

      budget.recordStage("retrieval", 250);
      budget.recordStage("planning", 1500);
      const timings = budget.getStageTimings();
      expect(timings.retrieval).toBe(250);
      expect(timings.planning).toBe(1500);

      budget.finish();
    });

    it("allows retry ONLY when remaining budget > 15s and enforces at most 1 corrective retry", () => {
      // Budget with ample time remaining
      const ampleBudget = new QuestionDeadlineBudget({ totalBudgetMs: 55_000, minRetryRemainingMs: 15_000 });
      expect(ampleBudget.canRetry()).toBe(true);
      expect(ampleBudget.consumeRetry()).toBe(true);
      // Second retry is strictly refused
      expect(ampleBudget.canRetry()).toBe(false);
      expect(ampleBudget.consumeRetry()).toBe(false);

      // Budget with exhausted/low remaining time (<= 15s)
      const lowBudget = new QuestionDeadlineBudget({ totalBudgetMs: 10_000, minRetryRemainingMs: 15_000 });
      expect(lowBudget.canRetry()).toBe(false);
      expect(lowBudget.consumeRetry()).toBe(false);

      ampleBudget.finish();
      lowBudget.finish();
    });

    it("refuses to replay SQL whose outcome was uncertain after worker crash or statement timeout", () => {
      const budget = new QuestionDeadlineBudget();
      expect(budget.shouldReplayExternalOperation(true)).toBe(false);
      expect(budget.shouldReplayExternalOperation(false)).toBe(true);
      budget.finish();
    });
  });

  describe("P5-04: Versioned context/result cache + ACL reauthorization", () => {
    it("generates deterministic cache keys with sorted parameters", () => {
      const key1 = makePlanCacheKey("cmp-1", "plan_revenue", { year: 2026, month: 10 }, "clickhouse", 1);
      const key2 = makePlanCacheKey("cmp-1", "plan_revenue", { month: 10, year: 2026 }, "clickhouse", 1);
      expect(key1).toBe(key2);
    });

    it("enforces ACL reauthorization on cache retrieval, rejecting entries referencing revoked sources", async () => {
      const cacheService = new DataSourceCacheService();
      const planHash = "plan_user_orders";
      const key = makePlanCacheKey("cmp-1", planHash, { status: "active" }, "clickhouse", 1);

      const entry: CachedParameterizedPlanResult = {
        planHash,
        normalizedParams: { status: "active" },
        engine: "clickhouse",
        datasetVersion: 1,
        companyId: "cmp-1",
        dataSourceIds: ["ds-authorized-1", "ds-restricted-2"],
        createdAt: Date.now(),
        ttlSeconds: 300,
        data: { rows: [{ id: 1, val: 100 }] },
      };

      await cacheService.setCachedPlanResult(key, entry);

      // 1. Caller with access to BOTH sources successfully retrieves cached result
      const authorized = await cacheService.getCachedPlanResult(key, ["ds-authorized-1", "ds-restricted-2"]);
      expect(authorized).not.toBeNull();
      expect(authorized?.data).toEqual({ rows: [{ id: 1, val: 100 }] });

      // 2. Caller whose access to ds-restricted-2 was revoked gets REJECTED (returns null)
      const revoked = await cacheService.getCachedPlanResult(key, ["ds-authorized-1"]);
      expect(revoked).toBeNull();
    });

    it("invalidates cache entries when source publication or schema changes", async () => {
      const cacheService = new DataSourceCacheService();
      const key = makePlanCacheKey("cmp-1", "plan_analytics", {}, "clickhouse", 1);

      await cacheService.setCachedPlanResult(key, {
        planHash: "plan_analytics",
        normalizedParams: {},
        engine: "clickhouse",
        datasetVersion: 1,
        companyId: "cmp-1",
        dataSourceIds: ["ds-to-invalidate"],
        createdAt: Date.now(),
        ttlSeconds: 300,
        data: { count: 10 },
      });

      // Verify cached
      const before = await cacheService.getCachedPlanResult(key, ["ds-to-invalidate"]);
      expect(before).not.toBeNull();

      // Invalidate
      await cacheService.invalidateDataSourceCache("cmp-1", "ds-to-invalidate");

      // Verify evicted
      const after = await cacheService.getCachedPlanResult(key, ["ds-to-invalidate"]);
      expect(after).toBeNull();
    });
  });
});
