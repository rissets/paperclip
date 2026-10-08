import { describe, expect, it, vi } from "vitest";
import { agents, dataSources, dataSourceTables } from "@paperclipai/db";
import { DataSourceQueryTracer, dataSourceTraceStore } from "../services/data-source-query-trace.js";
import { DataAgentService } from "../services/data-agent.js";
import { DataSourcesService } from "../services/data-sources.js";

describe("P0-01 & P0-03: DataSource Query Trace, Stage Timings, and Correctness Guards", () => {
  it("P0-01: captures correlation ID and stage timings with accurate breakdown", () => {
    dataSourceTraceStore.clear();

    const tracer = new DataSourceQueryTracer({
      companyId: "comp-123",
      query: "Berapa total omzet bulan ini?",
      agentId: "agent-data-1",
      sessionId: "session-abc",
    });

    expect(tracer.traceId).toMatch(/^ds-trace-/);
    expect(tracer.companyId).toBe("comp-123");
    expect(tracer.query).toBe("Berapa total omzet bulan ini?");

    tracer.markPreflight(15);
    tracer.markRetrieval(40);
    tracer.markPlanning(120);
    tracer.markValidation(10);
    tracer.markExecution(250);
    tracer.markSynthesis(80);

    const trace = tracer.finish({
      engine: "clickhouse",
      cacheHit: false,
      outcome: "success",
    });

    expect(trace.traceId).toBe(tracer.traceId);
    expect(trace.engine).toBe("clickhouse");
    expect(trace.cacheHit).toBe(false);
    expect(trace.outcome).toBe("success");
    expect(trace.timings.preflightMs).toBe(15);
    expect(trace.timings.retrievalMs).toBe(40);
    expect(trace.timings.planningMs).toBe(120);
    expect(trace.timings.validationMs).toBe(10);
    expect(trace.timings.databaseExecutionMs).toBe(250);
    expect(trace.timings.synthesisMs).toBe(80);
    expect(trace.timings.totalMs).toBeGreaterThanOrEqual(0);

    // Verify stored in ring buffer
    const stored = dataSourceTraceStore.getTrace(trace.traceId);
    expect(stored).toBeDefined();
    expect(stored?.companyId).toBe("comp-123");

    const companyTraces = dataSourceTraceStore.getTraces("comp-123");
    expect(companyTraces.length).toBe(1);
    expect(companyTraces[0].traceId).toBe(trace.traceId);
  });

  it("P0-03: abstains when query has zero relevance to available tables and metrics", async () => {
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

    const mockDb: any = {
      select: () => ({
        from: (table: any) => {
          if (table === dataSources) {
            return createQueryChain([
              {
                id: "source-1",
                companyId: "comp-123",
                name: "Laporan Finansial",
                sourceType: "csv",
                status: "ready",
              },
            ]);
          }
          if (table === agents) {
            return createQueryChain([
              {
                id: "agent-data",
                companyId: "comp-123",
                name: "Data Agent",
                metadata: { dataSourceAccess: { mode: "all" } },
              },
            ]);
          }
          if (table === dataSourceTables) {
            return createQueryChain([
              {
                id: "table-1",
                dataSourceId: "source-1",
                companyId: "comp-123",
                tableName: "laporan_keuangan",
                rowCount: 500,
                schemaDefinition: [
                  { name: "id", dataType: "number", role: "identifier" },
                  { name: "revenue", dataType: "number", role: "metric" },
                ],
                semanticModel: {
                  tableName: "laporan_keuangan",
                  entities: ["keuangan", "finansial"],
                  metrics: [{ name: "revenue", expression: "revenue", aggregation: "sum" }],
                  dimensions: [{ name: "tahun", description: "tahun laporan" }],
                },
              },
            ]);
          }
          return createQueryChain([]);
        },
      }),
    };

    const dataAgent = new DataAgentService(mockDb);

    // Completely unrelated query: "Resep masakan rendang padang"
    const result = await dataAgent.answer("comp-123", "Resep masakan rendang padang", {
      agentId: "agent-data",
    });

    expect(result.resultsSummary).toContain("Pertanyaan tidak cocok dengan topik, tabel, atau metrik");
    expect(result.traceId).toBeDefined();
    expect(result.stageTimings).toBeDefined();

    // Verify trace recorded as abstained
    const trace = dataSourceTraceStore.getTrace(result.traceId!);
    expect(trace).toBeDefined();
    expect(trace?.outcome).toBe("abstained");
  });

  it("P0-03: abstains when table matches but requested metric does not exist", async () => {
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

    const mockDb: any = {
      select: () => ({
        from: (table: any) => {
          if (table === dataSources) {
            return createQueryChain([
              {
                id: "source-1",
                companyId: "comp-123",
                name: "Data Penjualan",
                sourceType: "csv",
                status: "ready",
              },
            ]);
          }
          if (table === agents) {
            return createQueryChain([
              {
                id: "agent-data",
                companyId: "comp-123",
                name: "Data Agent",
                metadata: { dataSourceAccess: { mode: "all" } },
              },
            ]);
          }
          if (table === dataSourceTables) {
            return createQueryChain([
              {
                id: "table-1",
                dataSourceId: "source-1",
                companyId: "comp-123",
                tableName: "penjualan",
                rowCount: 100,
                schemaDefinition: [
                  { name: "id", dataType: "number", role: "identifier" },
                  { name: "omzet", dataType: "number", role: "metric" },
                ],
                semanticModel: {
                  tableName: "penjualan",
                  entities: ["penjualan"],
                  metrics: [{ name: "omzet", expression: "omzet", aggregation: "sum" }],
                  dimensions: [],
                },
              },
            ]);
          }
          return createQueryChain([]);
        },
      }),
    };

    const dataAgent = new DataAgentService(mockDb);

    // Query matches table "penjualan", but asks for non-existent metric "temperatur cuaca":
    const result = await dataAgent.answer("comp-123", "Berapa rata-rata temperatur cuaca penjualan?", {
      agentId: "agent-data",
    });

    expect(result.resultsSummary).toContain("Metrik yang dimaksud dalam pertanyaan tidak ditemukan pada tabel penjualan");
    expect(result.resultsSummary).toContain("omzet");
    expect(result.traceId).toBeDefined();

    const trace = dataSourceTraceStore.getTrace(result.traceId!);
    expect(trace?.outcome).toBe("abstained");
  });

  it("keeps an orchestrator-selected snapshot route out of the early live entity lookup", async () => {
    const createQueryChain = (data: any[]) => {
      const promise = Promise.resolve(data);
      const chain: any = {
        where: () => chain,
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
      return chain;
    };
    const mockDb: any = {
      select: () => ({
        from: (table: any) => table === dataSources
          ? createQueryChain([{ id: "source-1", companyId: "comp-123", name: "Sales DB", sourceType: "postgres", status: "ready" }])
          : table === dataSourceTables
            ? createQueryChain([{
              id: "table-1",
              dataSourceId: "source-1",
              companyId: "comp-123",
              tableName: "penjualan",
              rowCount: 150_000,
              schemaDefinition: [
                { name: "omzet", dataType: "number", role: "metric" },
              ],
              semanticModel: {
                tableName: "penjualan",
                entities: ["penjualan"],
                metrics: [{ name: "omzet", expression: "omzet", aggregation: "sum" }],
                dimensions: [],
              },
            }])
            : createQueryChain([]),
      }),
    };
    const liveQuery = vi.spyOn(DataSourcesService.prototype, "querySql").mockResolvedValue({ rows: [] } as never);
    const snapshotQuery = vi.spyOn(DataSourcesService.prototype, "queryTable").mockResolvedValue({
      rows: [],
      columns: ["omzet"],
      totalRows: 0,
    } as never);

    await new DataAgentService(mockDb).answer("comp-123", "Berapa total omzet penjualan?", {
      dataSourceIds: ["source-1"],
      preferredMode: "snapshot",
    });

    expect(liveQuery).not.toHaveBeenCalled();
    expect(snapshotQuery).toHaveBeenCalledWith("comp-123", "table-1", expect.objectContaining({ mode: "snapshot" }));
  });
});
