import { describe, expect, it, vi } from "vitest";
import { agents, dataSources, dataSourceTables, dataSourceQueryExecutions } from "@paperclipai/db";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { buildDatasourceOrchestrationGuidance } from "../services/datasource-orchestration-guidance.js";

describe("P1-01 & P1-02: Enterprise Orchestrator Fast-Path Resolver & Query Executions", () => {
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
    agentOrchestrationMode?: "auto" | "off";
    agentAccessMode?: "all" | "selected" | "none";
    assignedDataSourceIds?: string[];
    sourceType?: string;
    rowCount?: number;
    sources?: any[];
    tables?: any[];
  } = {}) => {
    const insertedValues: Array<{ table: any; value: any }> = [];
    const mockAgent = {
      id: "agent-1",
      companyId: "comp-1",
      name: "Custom Data Agent",
      adapterType: "pi-cli",
      metadata: {
        datasourceOrchestration: {
          mode: options.agentOrchestrationMode || "auto",
        },
        dataSourceAccess: {
          mode: options.agentAccessMode || "all",
          dataSourceIds: options.assignedDataSourceIds || ["source-1"],
        },
      },
    };

    const mockSource = {
      id: "source-1",
      companyId: "comp-1",
      name: "Penjualan 2026",
      sourceType: options.sourceType || "csv",
      status: "ready",
    };

    const mockTable = {
      id: "table-1",
      dataSourceId: "source-1",
      companyId: "comp-1",
      tableName: "transaksi_penjualan",
      rowCount: options.rowCount ?? 1000,
      schemaDefinition: [
        { name: "id", dataType: "number", role: "identifier" },
        { name: "omzet", dataType: "number", role: "metric" },
        { name: "wilayah", dataType: "string", role: "dimension" },
      ],
      semanticModel: {
        tableName: "transaksi_penjualan",
        entities: ["penjualan", "transaksi"],
        metrics: [{ name: "omzet", expression: "omzet", aggregation: "sum" }],
        dimensions: [{ name: "wilayah", description: "wilayah penjualan" }],
      },
    };
    const mockSources = options.sources || [mockSource];
    const mockTables = options.tables || [mockTable];

    const mockDb: any = {
      select: () => ({
        from: (table: any) => {
          if (table === agents) {
            return createQueryChain([mockAgent]);
          }
          if (table === dataSources) {
            return createQueryChain(mockSources);
          }
          if (table === dataSourceTables) {
            return createQueryChain(mockTables);
          }
          if (table === dataSourceQueryExecutions) {
            return createQueryChain([
              {
                id: "exec-prev-123",
                companyId: "comp-1",
                agentId: "agent-1",
                dataSourceIds: ["source-1"],
                status: "completed",
                query: "Berapa total omzet?",
                resultsSummary: "Total omzet Rp 500jt",
                createdAt: new Date(),
              },
            ]);
          }
          return createQueryChain([]);
        },
      }),
      insert: (table: any) => ({
        values: (val: any) => {
          insertedValues.push({ table, value: val });
          return {
            returning: async () => [{ id: "fb-1", ...val, createdAt: new Date(), updatedAt: new Date() }],
          };
        },
      }),
      update: (table: any) => ({
        set: (val: any) => {
          const chain: any = {
            where: () => chain,
            returning: async () => [{ id: "exp-1", ...val }],
            then: (resolve: any) => Promise.resolve([{ id: "exp-1", ...val }]).then(resolve),
            catch: (reject: any) => Promise.resolve([{ id: "exp-1", ...val }]).catch(reject),
          };
          return chain;
        },
      }),
    };

    return { mockDb, mockAgent, mockSource, mockTable, insertedValues };
  };

  it("P1-01: resolves effective orchestration state for custom agent", async () => {
    const { mockDb } = createMockDb({ agentOrchestrationMode: "auto", agentAccessMode: "all" });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const state = await orchestrator.resolveEffectiveOrchestrationState("comp-1", "agent-1");
    expect(state.mode).toBe("auto");
    expect(state.enabled).toBe(true);
    expect(state.assignmentScope).toBe("all");
    expect(state.adapterSupported).toBe(true);
  });

  it("P1-01: disables orchestration when mode is explicitly off or scope is none", async () => {
    const { mockDb: dbOff } = createMockDb({ agentOrchestrationMode: "off" });
    const orchOff = new EnterpriseOrchestratorService(dbOff);
    const stateOff = await orchOff.resolveEffectiveOrchestrationState("comp-1", "agent-1");
    expect(stateOff.mode).toBe("off");
    expect(stateOff.enabled).toBe(false);

    const { mockDb: dbNone } = createMockDb({ agentOrchestrationMode: "auto", agentAccessMode: "none" });
    const orchNone = new EnterpriseOrchestratorService(dbNone);
    const stateNone = await orchNone.resolveEffectiveOrchestrationState("comp-1", "agent-1");
    expect(stateNone.enabled).toBe(false);
    expect(stateNone.assignmentScope).toBe("none");
  });

  it("P1-02 Fast-Path: routes conversational greeting to fast_path_non_data lane", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "Halo selamat pagi! Apa kabar?",
    });

    expect(context.lane).toBe("fast_path_non_data");
    expect(context.traceId).toBeDefined();
    expect(context.reasoning).toContain("Conversational non-data query");
  });

  it("routes an Indonesian capability greeting from a custom agent to the non-data fast path", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "hallo apa yang bisa kamu lakukan ?",
    });

    expect(context.lane).toBe("fast_path_non_data");
    expect(context.availableTables).toEqual([]);
    const guidance = buildDatasourceOrchestrationGuidance(context);
    expect(guidance).toContain("[Conversational Non-Data Fast Path]");
    expect(guidance).toContain("Do not call query_structured.py or query_database.py");
  });

  it("routes a real data question with greeting words through orchestration", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "Halo, berapa total omzet penjualan bulan ini?",
    });

    expect(context.lane).toBe("orchestrated");
  });

  it("keeps template and presentation fast paths on the Enterprise Orchestrator contract", () => {
    const templateGuidance = buildDatasourceOrchestrationGuidance({
      lane: "fast_path_template",
      traceId: "trace-template",
      candidateTemplateId: "template-1",
      availableTables: [],
    } as any);
    expect(templateGuidance).toContain("[Enterprise Datasource Orchestration Active]");
    expect(templateGuidance).toContain("--orchestrate");
    expect(templateGuidance).not.toContain("query_structured.py --sql");

    const reuseGuidance = buildDatasourceOrchestrationGuidance({
      lane: "fast_path_presentation_reuse",
      traceId: "trace-reuse",
      previousResultReference: "execution-1",
      availableTables: [],
    } as any);
    expect(reuseGuidance).toContain("[Enterprise Datasource Orchestration Active]");
    expect(reuseGuidance).toContain("do not query again");
  });

  it("P1-02 Fast-Path: routes presentation formatting follow-up to fast_path_presentation_reuse lane", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "Tampilkan dalam bentuk tabel markdown",
      previousResultId: "exec-prev-123",
    });

    expect(context.lane).toBe("fast_path_presentation_reuse");
    expect(context.previousResultReference).toBe("exec-prev-123");
    expect(context.traceId).toBeDefined();
  });

  it("P1-02: routes relevant metric query to orchestrated lane with available tables", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "Berapa total omzet penjualan di wilayah Jakarta?",
    });

    expect(context.lane).toBe("orchestrated");
    expect(context.availableTables).toHaveLength(1);
    expect(context.availableTables[0].tableName).toBe("transaksi_penjualan");
    expect(context.availableTables[0].metrics).toContain("omzet");
  });

  it("provides source, physical table, and verified column identities for duplicate ClickHouse labels", async () => {
    const sharedTableName = "14_subscriber_master_360";
    const sources = [
      { id: "source-a", companyId: "comp-1", name: "CRM snapshot", sourceType: "postgres", status: "ready" },
      { id: "source-b", companyId: "comp-1", name: "Billing snapshot", sourceType: "postgres", status: "ready" },
    ];
    const table = (id: string, dataSourceId: string, physicalName: string) => ({
      id,
      companyId: "comp-1",
      dataSourceId,
      tableName: sharedTableName,
      rowCount: 10,
      schemaDefinition: [
        { name: "customer_type", dataType: "string", role: "dimension" },
        { name: "avg_arpu_usd", dataType: "number", role: "metric" },
        { name: "tenure_months", dataType: "number", role: "metric" },
      ],
      semanticModel: {
        clickhouseTable: physicalName,
        metrics: [{ name: "avg_arpu_usd", column: "avg_arpu_usd", aggregation: "avg" }],
        dimensions: [{ name: "customer_type", column: "customer_type" }],
      },
    });
    const tables = [
      table("table-a", "source-a", "ds_source_a_subscriber_master"),
      table("table-b", "source-b", "ds_source_b_subscriber_master"),
    ];
    const { mockDb } = createMockDb({ sources, tables });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      query: `Analyze ${sharedTableName} by customer_type`,
    });

    expect(context.availableTables).toHaveLength(2);
    expect(context.availableTables.map((candidate) => candidate.id)).toEqual(["table-a", "table-b"]);
    expect(context.availableTables[0]).toMatchObject({
      sourceName: "CRM snapshot",
      sourceType: "postgres",
      clickhouseTable: "ds_source_a_subscriber_master",
      columns: expect.arrayContaining([
        { name: "avg_arpu_usd", dataType: "number", role: "metric" },
        { name: "customer_type", dataType: "string", role: "dimension" },
      ]),
    });

    const guidance = buildDatasourceOrchestrationGuidance(context);
    expect(guidance).toContain("ds_source_a_subscriber_master");
    expect(guidance).toContain("ds_source_b_subscriber_master");
    expect(guidance).toContain("avg_arpu_usd");
    expect(guidance).toContain("--list-tables or --describe-table only when required metadata is missing");
    expect(guidance).toContain("Do not use --aggregate or direct --sql in Auto");
    expect(guidance).toContain("do not choose an arbitrary physical table");
    expect(guidance).not.toContain("arpus_usd");
  });

  it("P1-02: routes catalog overview inquiry to orchestrated lane with candidate tables", async () => {
    const { mockDb } = createMockDb();
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    const context = await orchestrator.resolveQueryContext("comp-1", {
      agentId: "agent-1",
      query: "Data apa saja yang anda punya?",
    });

    expect(context.lane).toBe("orchestrated");
    expect(context.availableTables.length).toBeGreaterThan(0);
    expect(context.reasoning).toContain("Catalog overview inquiry");
  });

  it("P1-01 & P1-04: creates, tracks, and cancels query execution with feedback support", async () => {
    const { mockDb } = createMockDb({ sourceType: "postgres" });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    // Spy on dataAgent.answer to isolate coordinator execution lifecycle from external clickhouse
    (orchestrator as any).dataAgent.answer = async () => ({
      agent: "data_agent",
      task: "Analisis Data (transaksi_penjualan)",
      resultsSummary: "Total omzet transaksi penjualan adalah Rp 1.500.000.000.",
      dataPreview: [{ total_omzet: 1_500_000_000 }],
      traceId: "orch-exec-trace-123",
      stageTimings: {
        preflightMs: 5,
        retrievalMs: 15,
        planningMs: 30,
        validationMs: 10,
        databaseExecutionMs: 45,
        synthesisMs: 20,
        totalMs: 125,
      },
    });

    // Create execution
    const execution = await orchestrator.createQueryExecution("comp-1", {
      agentId: "agent-1",
      query: "Berapa total omzet transaksi penjualan?",
      deadlineMs: 30000,
    });

    expect(execution.id).toMatch(/^exec-/);
    expect(execution.status).toBe("completed");
    expect(execution.stageTimings).toBeDefined();
    expect(execution.dataSourceIds).toEqual(["source-1"]);
    expect(execution.traceId).toBeDefined();
    expect(execution.resultsSummary).toContain("Rp 1.500.000.000");

    // Retrieve execution
    const fetched = await orchestrator.getQueryExecution("comp-1", execution.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(execution.id);
    expect(fetched?.dataSourceIds).toEqual(["source-1"]);

    // Feedback submission
    await orchestrator.submitQueryFeedback("comp-1", execution.id, {
      verdict: "correct",
      comment: "Angka omzet cocok dengan laporan akuntansi",
    });

    // Test cancellation on another running execution
    let resolveDelayed: any;
    const delayedPromise = new Promise((resolve) => {
      resolveDelayed = resolve;
    });
    (orchestrator as any).dataAgent.answer = async () => {
      await delayedPromise;
      return { agent: "data_agent", task: "Delayed", resultsSummary: "Done" };
    };

    const cancelPromise = orchestrator.createQueryExecution("comp-1", {
      agentId: "agent-1",
      query: "Query yang akan dibatalkan",
      deadlineMs: 30000,
    });

    // Active execution ID can be cancelled
    const activeId = Array.from((orchestrator as any).activeExecutions.keys()).find(
      (id) => id !== execution.id,
    );
    expect(activeId).toBeDefined();

    const cancelled = await orchestrator.cancelQueryExecution("comp-1", activeId!);
    expect(cancelled).toBe(true);

    resolveDelayed();
    const cancelledRecord = await cancelPromise;
    expect(cancelledRecord.status).toBe("cancelled");
  });

  it("lists bounded execution summaries only for the allowed datasource scope", async () => {
    const rows = [
      {
        id: "exec-visible",
        companyId: "comp-1",
        agentId: "agent-1",
        runId: null,
        sessionId: null,
        dataSourceIds: ["source-1"],
        query: "Visible query",
        planHash: "visible-hash",
        engine: "clickhouse",
        status: "completed",
        stageTimings: { totalMs: 10 },
        resultsSummary: "Visible summary",
        dataPreview: [{ secret: "result rows are omitted" }],
        errorMessage: null,
        traceId: "trace-visible",
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: "exec-revoked",
        companyId: "comp-1",
        agentId: "agent-1",
        runId: null,
        sessionId: null,
        dataSourceIds: ["source-2"],
        query: "Revoked query",
        planHash: "revoked-hash",
        engine: "clickhouse",
        status: "completed",
        stageTimings: { totalMs: 20 },
        resultsSummary: "Revoked summary",
        dataPreview: [{ secret: "not visible" }],
        errorMessage: null,
        traceId: "trace-revoked",
        createdAt: new Date(Date.now() - 1000),
        updatedAt: new Date(Date.now() - 1000),
        completedAt: new Date(Date.now() - 1000),
      },
    ];
    const chain: any = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: any[]) => unknown) => Promise.resolve(rows).then(resolve),
      catch: (reject: (error: unknown) => unknown) => Promise.resolve(rows).catch(reject),
    };
    const db: any = { select: () => ({ from: () => chain }) };
    const orchestrator = new EnterpriseOrchestratorService(db);

    const executions = await orchestrator.listQueryExecutions("comp-1", {
      allowedDataSourceIds: ["source-1"],
      limit: 10,
    });

    expect(executions).toHaveLength(1);
    expect(executions[0].id).toBe("exec-visible");
    expect(executions[0]).not.toHaveProperty("data");
    expect(executions[0]).not.toHaveProperty("dataPreview");
  });

  it("does not trust requested source IDs when a selected agent has no effective grants", async () => {
    const { mockDb, insertedValues } = createMockDb({
      agentAccessMode: "selected",
      assignedDataSourceIds: [],
    });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);
    const answer = vi.fn(async () => {
      throw new Error("No authorized datasource");
    });
    (orchestrator as any).dataAgent.answer = answer;

    const execution = await orchestrator.createQueryExecution("comp-1", {
      agentId: "agent-1",
      dataSourceIds: ["source-1"],
      query: "Berapa total omzet?",
      deadlineMs: 30_000,
    });

    expect(answer).not.toHaveBeenCalled();
    expect(execution.dataSourceIds).toEqual([]);
    expect(execution.status).toBe("failed");
    expect(insertedValues.find((row) => row.table === dataSourceQueryExecutions)?.value.dataSourceIds).toEqual([]);
  });

  it("records the actual live MySQL engine for external database queries", async () => {
    const { mockDb } = createMockDb({ sourceType: "mysql" });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);
    (orchestrator as any).dataAgent.answer = async () => ({
      agent: "data_agent",
      task: "MySQL result",
      query: "SELECT SUM(omzet) FROM transaksi_penjualan",
      resultsSummary: "Query completed",
      dataPreview: [{ total: 10 }],
    });

    const execution = await orchestrator.createQueryExecution("comp-1", {
      agentId: "agent-1",
      query: "total omzet transaksi penjualan",
      deadlineMs: 30_000,
    });

    expect(execution.status).toBe("completed");
    expect(execution.engine).toBe("mysql");
  });

  it("abstains on an unpublished file table instead of calling the query agent", async () => {
    const { mockDb } = createMockDb({ sourceType: "csv" });
    const orchestrator = new EnterpriseOrchestratorService(mockDb);
    const answer = vi.fn();
    (orchestrator as any).dataAgent.answer = answer;

    const execution = await orchestrator.createQueryExecution("comp-1", {
      agentId: "agent-1",
      query: "sum omzet transaksi penjualan",
      deadlineMs: 30_000,
    });

    expect(execution.status).toBe("completed");
    expect(execution.engine).toBe("fast_path");
    expect(execution.resultsSummary).toContain("Sinkronkan atau pulihkan publikasi ClickHouse");
    expect(answer).not.toHaveBeenCalled();
  });
});
