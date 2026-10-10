import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSourceVectorStore } from "../services/data-source-vector-store.js";
import { coordinatorDeadlineSubmittedAt, EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { RagModelService } from "../services/rag-models.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Coordinator deadline timestamp", () => {
  it("starts a fresh budget when the caller timestamp predates coordinator work", () => {
    const now = 1_800_000_000_000;

    expect(coordinatorDeadlineSubmittedAt(now - 30_000, now)).toBeUndefined();
    expect(coordinatorDeadlineSubmittedAt(new Date(now - 5_000).toISOString(), now)).toBe(now - 5_000);
    expect(coordinatorDeadlineSubmittedAt("not-a-date", now)).toBeUndefined();
  });
});

describe("Package P4: Schema Vectors, Hybrid Retrieval & Selective Snapshot Routing", () => {
  const createQueryChain = (data: any[]) => {
    const promise = Promise.resolve(data);
    const chain: any = {
      where: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
    };
    return chain;
  };

  const createMockDb = (options: {
    tables?: any[];
  } = {}) => {
    const defaultTables = [
      {
        id: "table-1",
        dataSourceId: "source-1",
        companyId: "comp-1",
        tableName: "transaksi_penjualan",
        rowCount: 50000,
        semanticModel: {
          metrics: [{ name: "omzet", aggregation: "sum" }, { name: "total_laba", aggregation: "sum" }],
          dimensions: [{ name: "wilayah" }, { name: "kategori" }],
        },
      },
      {
        id: "table-2",
        dataSourceId: "source-1",
        companyId: "comp-1",
        tableName: "master_pelanggan",
        rowCount: 1200,
        semanticModel: {
          metrics: [{ name: "total_poin", aggregation: "sum" }],
          dimensions: [{ name: "nama_pelanggan" }, { name: "kota" }],
        },
      },
      {
        id: "table-foreign",
        dataSourceId: "source-unauthorized",
        companyId: "comp-1",
        tableName: "gaji_karyawan_rahasia",
        rowCount: 50,
        semanticModel: {
          metrics: [{ name: "gaji_pokok", aggregation: "sum" }],
          dimensions: [{ name: "nik" }],
        },
      },
    ];

    const tables = options.tables || defaultTables;

    const mockDb: any = {
      select: () => ({
        from: () => createQueryChain(tables),
      }),
      execute: async () => [
        { bgeAvailable: false, gatewayAvailable: false },
      ],
      transaction: async (cb: any) => cb(mockDb),
    };

    return mockDb;
  };

  describe("P4-01 & P4-02: Isolated Schema Vector Dimensions & Capability Handling", () => {
    it("validates vector dimensions strictly for BGE-M3 (1024) and OpenRouter (1536)", async () => {
      const mockDb: any = {
        execute: async () => [{ bgeAvailable: true, gatewayAvailable: true }],
      };
      const vectorStore = new DataSourceVectorStore(mockDb);

      // Wrong dimension for bge-m3 (expects 1024, gets 512)
      await expect(
        vectorStore.search({
          companyId: "comp-1",
          dataSourceIds: ["source-1"],
          embeddingSpace: "bge-m3",
          embeddingGeneration: "bge-m3",
          vector: new Array(512).fill(0.1),
          limit: 5,
        }),
      ).rejects.toThrow(/must contain 1024 finite numbers/);

      // Wrong dimension for gateway (expects 1536, gets 1024)
      await expect(
        vectorStore.search({
          companyId: "comp-1",
          dataSourceIds: ["source-1"],
          embeddingSpace: "openrouter-text-embedding-3-small",
          embeddingGeneration: "openrouter-text-embedding-3-small",
          vector: new Array(1024).fill(0.1),
          limit: 5,
        }),
      ).rejects.toThrow(/must contain 1536 finite numbers/);

      // Non-finite number rejection
      const nanVector = new Array(1024).fill(0.1);
      nanVector[5] = Number.NaN;
      await expect(
        vectorStore.search({
          companyId: "comp-1",
          dataSourceIds: ["source-1"],
          embeddingSpace: "bge-m3",
          embeddingGeneration: "bge-m3",
          vector: nanVector,
          limit: 5,
        }),
      ).rejects.toThrow(/must contain 1024 finite numbers/);
    });

    it("degrades gracefully to null when pgvector tables are absent without crashing", async () => {
      const mockDb: any = {
        execute: async () => [{ bgeAvailable: false, gatewayAvailable: false }],
      };
      const vectorStore = new DataSourceVectorStore(mockDb);

      const result = await vectorStore.search({
        companyId: "comp-1",
        dataSourceIds: ["source-1"],
        embeddingSpace: "bge-m3",
        embeddingGeneration: "bge-m3",
        vector: new Array(1024).fill(0.1),
        limit: 5,
      });

      expect(result).toBeNull();

      const schemaResult = await vectorStore.searchSchemaVectors({
        companyId: "comp-1",
        dataSourceIds: ["source-1"],
        embeddingSpace: "bge-m3",
        embeddingGeneration: "bge-m3",
        vector: new Array(1024).fill(0.1),
        limit: 5,
      });

      expect(schemaResult).toBeNull();
    });
  });

  describe("P4-03: Hybrid Schema Retriever & Selective Reranker", () => {
    it("bounds a stalled local BGE embedding call and returns to lexical retrieval", async () => {
      vi.stubEnv("RAG_EMBEDDING_PROVIDER", "auto");
      vi.stubEnv("RAG_BGE_EMBEDDING_URL", "http://127.0.0.1:18080");
      vi.stubEnv("OPENROUTER_API_KEY", "");
      const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      vi.stubGlobal("fetch", fetchMock);
      const startedAt = Date.now();

      const result = await new RagModelService().embed(["slow local embedding"], undefined, {
        localTimeoutMs: 20,
        gatewayTimeoutMs: 30,
      });

      expect(result.vectors).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it("includes authorized vector-only table matches with no lexical overlap", async () => {
      vi.spyOn(RagModelService.prototype, "embed").mockResolvedValue({
        vectors: [new Array(1_024).fill(0.1)],
        space: "bge-m3",
        generation: "bge-m3@test",
        backend: "local-bge-m3",
      });
      vi.spyOn(DataSourceVectorStore.prototype, "searchSchemaVectors").mockResolvedValue(
        new Map([["table-2", 0.92]]),
      );
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "churn anomaly cohort",
        ["source-1"],
      );

      expect(result.candidates[0]).toMatchObject({
        id: "table-2",
        tableName: "master_pelanggan",
        matchedBy: "hybrid",
      });
      expect(result.candidates[0]?.relevanceScore).toBeCloseTo(0.552);
    });

    it("passes the coordinator abort signal and short provider timeouts to semantic retrieval", async () => {
      const controller = new AbortController();
      const embed = vi.spyOn(RagModelService.prototype, "embed").mockResolvedValue({
        vectors: [new Array(1_024).fill(0.1)],
        space: "bge-m3",
        generation: "bge-m3@test",
        backend: "local-bge-m3",
      });
      vi.spyOn(DataSourceVectorStore.prototype, "searchSchemaVectors").mockResolvedValue(
        new Map([["table-2", 0.92]]),
      );
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      await orchestrator.hybridRetrieveSchema("comp-1", "unrelated operational concepts", ["source-1"], {
        signal: controller.signal,
      });

      expect(embed).toHaveBeenCalledWith(["unrelated operational concepts"], undefined, {
        signal: controller.signal,
        localTimeoutMs: 2_500,
        gatewayTimeoutMs: 4_500,
      });
    });

    it("skips BGE/OpenRouter calls when the onboarded semantic dimension has one lexical match", async () => {
      const embed = vi.spyOn(RagModelService.prototype, "embed");
      const orchestrator = new EnterpriseOrchestratorService(createMockDb({ tables: [{
        id: "province-summary",
        dataSourceId: "source-1",
        companyId: "comp-1",
        tableName: "customer_summary",
        rowCount: 250_000,
        schemaDefinition: [{ name: "province_code", dataType: "string", role: "dimension" }],
        semanticModel: { dimensions: [{ name: "Provinsi", column: "province_code" }] },
      }] }));

      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "Tampilkan sebaran berdasarkan provinsi",
        ["source-1"],
      );

      expect(result.candidates[0]?.id).toBe("province-summary");
      expect(result.candidates[0]?.matchedBy).toBe("lexical");
      expect(embed).not.toHaveBeenCalled();
    });

    it("skips vector reranker when an exact table name or metric is present to preserve low latency", async () => {
      const db = createMockDb();
      const orchestrator = new EnterpriseOrchestratorService(db);

      // Query has exact table name "transaksi_penjualan"
      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "Tolong tampilkan ringkasan transaksi_penjualan bulan ini",
        ["source-1"],
      );

      expect(result.exactMatchFound).toBe(true);
      expect(result.skippedVectorRerank).toBe(true);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].tableName).toBe("transaksi_penjualan");
      expect(result.candidates[0].matchedBy).toBe("exact_match");
      expect(result.reasoning).toContain("Exact table-name match");
    });

    it("uses an explicitly qualified schema table match ahead of same-named schemas", async () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb({ tables: [
        {
          id: "geo-provinsi", dataSourceId: "source-1", companyId: "comp-1", tableName: "provinsi",
          schemaDefinition: [{ name: "province_code", dataType: "string" }],
          semanticModel: { sourceSchema: "geo", dimensions: [{ name: "province_code" }] },
        },
        {
          id: "legacy-provinsi", dataSourceId: "source-1", companyId: "comp-1", tableName: "provinsi",
          schemaDefinition: [{ name: "province_code", dataType: "string" }],
          semanticModel: { sourceSchema: "legacy", dimensions: [{ name: "province_code" }] },
        },
      ] }));

      const result = await orchestrator.hybridRetrieveSchema("comp-1", "Baca geo.provinsi", ["source-1"]);

      expect(result.candidates.map((candidate) => candidate.id)).toEqual(["geo-provinsi"]);
      expect(result.candidates[0]).toMatchObject({
        tableName: "provinsi",
        schemaName: "geo",
        qualifiedTableName: "geo.provinsi",
      });
    });

    it("prioritizes an explicitly named table over common exact dimension columns", async () => {
      const distractors = Array.from({ length: 5 }, (_, index) => ({
        id: `domain-table-${index}`,
        dataSourceId: "source-1",
        companyId: "comp-1",
        tableName: `domain_table_${index}`,
        rowCount: 5,
        schemaDefinition: [{ name: "domain", dataType: "string", role: "dimension" }],
        semanticModel: { dimensions: [{ name: "domain" }] },
      }));
      const target = {
        id: "incident-truth-table",
        dataSourceId: "source-1",
        companyId: "comp-1",
        tableName: "22_demo_incident_scenarios_truth_table",
        rowCount: 5,
        schemaDefinition: [{ name: "domain", dataType: "string", role: "dimension" }],
        semanticModel: { dimensions: [{ name: "domain" }] },
      };
      const orchestrator = new EnterpriseOrchestratorService(createMockDb({ tables: [...distractors, target] }));

      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "Use only 22_demo_incident_scenarios_truth_table and count rows grouped by domain",
        ["source-1"],
      );

      expect(result.candidates.map((candidate) => candidate.id)).toEqual(["incident-truth-table"]);
      expect(result.candidates[0]?.tableName).toBe("22_demo_incident_scenarios_truth_table");
      expect(result.reasoning).toContain("Exact table-name match");
    });

    it("skips vector reranker when an exact metric name is present", async () => {
      const db = createMockDb();
      const orchestrator = new EnterpriseOrchestratorService(db);

      // Query has exact metric name "omzet"
      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "Berapa total omzet kita tahun 2026?",
        ["source-1"],
      );

      expect(result.exactMatchFound).toBe(true);
      expect(result.skippedVectorRerank).toBe(true);
      expect(result.candidates[0].tableName).toBe("transaksi_penjualan");
    });

    it("matches exact physical columns even when semantic metrics use display labels", async () => {
      const db = createMockDb({
        tables: [{
          id: "opex-table",
          dataSourceId: "file-source",
          companyId: "comp-1",
          tableName: "26_site_opex_cost",
          rowCount: 120,
          schemaDefinition: [
            { name: "month", dataType: "number", role: "temporal" },
            { name: "maintenance_cost_usd", dataType: "number", role: "metric" },
          ],
          semanticModel: { metrics: [{ name: "Maintenance Cost", aggregation: "sum" }] },
        }],
      });
      const orchestrator = new EnterpriseOrchestratorService(db);

      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "sum maintenance_cost_usd for August 2026",
        ["file-source"],
      );

      expect(result.exactMatchFound).toBe(true);
      expect(result.skippedVectorRerank).toBe(true);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(["opex-table"]);
    });

    it("enforces tenant ACL isolation and never returns tables from unauthorized sources", async () => {
      const db = createMockDb();
      const orchestrator = new EnterpriseOrchestratorService(db);

      // User asks for unauthorized table "gaji_karyawan_rahasia" but only has access to "source-1"
      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "Berapa gaji_karyawan_rahasia dan gaji_pokok?",
        ["source-1"], // only source-1 allowed
      );

      // The unauthorized table must NOT be returned!
      const leaked = result.candidates.find((c) => c.tableName === "gaji_karyawan_rahasia");
      expect(leaked).toBeUndefined();
    });

    it("caps top candidates to requested limit", async () => {
      const db = createMockDb();
      const orchestrator = new EnterpriseOrchestratorService(db);

      const result = await orchestrator.hybridRetrieveSchema(
        "comp-1",
        "tampilkan data penjualan dan pelanggan",
        ["source-1"],
        { limit: 1 },
      );

      expect(result.candidates.length).toBe(1);
    });
  });

  describe("P4-04: Selective Snapshot Routing Policy", () => {
    it("routes selective indexed lookups directly to live external database for real-time freshness", () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const decision = orchestrator.determineQueryExecutionRoute(
        {
          isSelectiveLookup: true,
          query: "SELECT * FROM users WHERE id = 'usr_123' LIMIT 1",
        },
        {
          isExternalDb: true,
          rowCount: 1000000,
          clickhouseDeployed: true,
          clickhouseRowCount: 990000,
        },
      );

      expect(decision.route).toBe("live_external");
      expect(decision.consistencyLevel).toBe("live_transactional");
      expect(decision.reason).toContain("Selective indexed lookup");
    });

    it("routes analytical aggregations to ClickHouse snapshot when ready", () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const decision = orchestrator.determineQueryExecutionRoute(
        {
          hasAggregation: true,
          query: "SELECT wilayah, SUM(omzet) FROM transaksi GROUP BY wilayah",
        },
        {
          isExternalDb: true,
          rowCount: 500000,
          clickhouseDeployed: true,
          clickhouseRowCount: 500000,
        },
      );

      expect(decision.route).toBe("clickhouse_snapshot");
      expect(decision.consistencyLevel).toBe("snapshot_read_committed");
      expect(decision.reason).toContain("ClickHouse snapshot");
    });

    it("refuses empty ClickHouse snapshot and falls back to live external database", () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const decision = orchestrator.determineQueryExecutionRoute(
        {
          hasAggregation: true,
          query: "SELECT SUM(omzet) FROM transaksi",
        },
        {
          isExternalDb: true,
          rowCount: 10000,
          clickhouseDeployed: true,
          clickhouseRowCount: 0, // Empty snapshot!
        },
      );

      expect(decision.route).toBe("live_external");
      expect(decision.consistencyLevel).toBe("live_transactional");
      expect(decision.reason).toContain("selected table has no verified ClickHouse snapshot");
    });

    it("does not treat another datasource's ClickHouse rows as this external table's published snapshot", () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const decision = orchestrator.determineQueryExecutionRoute(
        { hasAggregation: true, query: "SELECT SUM(maintenance_cost_usd) FROM table" },
        {
          isExternalDb: true,
          rowCount: 100_000,
          clickhouseDeployed: true,
          clickhouseRowCount: 50_000_000,
          publishedSnapshotReady: false,
        },
      );

      expect(decision.route).toBe("live_external");
      expect(decision.reason).toContain("selected table has no verified ClickHouse snapshot");
    });

    it("uses the selected file table's physical publication instead of external datasource presence", () => {
      const orchestrator = new EnterpriseOrchestratorService(createMockDb());

      const decision = orchestrator.determineQueryExecutionRoute(
        { hasAggregation: true, query: "SELECT SUM(maintenance_cost_usd) FROM 26_site_opex_cost" },
        {
          isExternalDb: false,
          rowCount: 120,
          clickhouseDeployed: true,
          clickhouseRowCount: 120,
          publishedSnapshotReady: true,
        },
      );

      expect(decision.route).toBe("clickhouse_snapshot");
    });
  });
});
