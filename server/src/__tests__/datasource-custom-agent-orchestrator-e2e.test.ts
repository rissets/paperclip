import { describe, expect, it } from "vitest";
import { agents, dataSources, dataSourceTables } from "@paperclipai/db";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";

describe("P1-06: Custom Agent Enterprise Orchestrator Integration Contract", () => {
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

  it("P1-06: new custom agent -> one source assigned -> query shows coordinator trace -> revoke & off cases pass", async () => {
    const companyId = "company-eval-1";
    const agentId = "agent-custom-99";
    const sourceId = "source-sales-csv";

    // 1. Initial State: Custom agent with 1 source assigned and orchestration mode: "auto"
    let currentAgentState = {
      id: agentId,
      companyId,
      name: "Custom Analytics Specialist",
      adapterType: "pi_local",
      metadata: {
        datasourceOrchestration: { mode: "auto" },
        dataSourceAccess: {
          mode: "selected",
          dataSourceIds: [sourceId],
          collectionIds: [],
        },
      },
    };

    const mockSource = {
      id: sourceId,
      companyId,
      name: "Monthly Orders 2026",
      sourceType: "postgres",
      status: "ready",
      updatedAt: new Date(),
    };

    const mockTable = {
      id: "table-orders",
      dataSourceId: sourceId,
      companyId,
      tableName: "orders",
      rowCount: 5000,
      updatedAt: new Date(),
      semanticModel: {
        tableName: "orders",
        metrics: [{ name: "revenue", expression: "revenue", aggregation: "sum" }],
        dimensions: [{ name: "customer_region", description: "region" }],
      },
    };

    const mockDb: any = {
      select: () => ({
        from: (table: any) => {
          if (table === agents) {
            return createQueryChain([currentAgentState]);
          }
          if (table === dataSources) {
            return createQueryChain([mockSource]);
          }
          if (table === dataSourceTables) {
            return createQueryChain([mockTable]);
          }
          return createQueryChain([]);
        },
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            if (vals.metadata) {
              currentAgentState = { ...currentAgentState, metadata: vals.metadata };
            }
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({
        values: () => Promise.resolve(),
      }),
    };

    const orchestrator = new EnterpriseOrchestratorService(mockDb);

    // Mock internal dataAgent.answer to isolate coordinator pipeline from database daemon
    (orchestrator as any).dataAgent.answer = async () => ({
      agent: "data_agent",
      task: "Analisis Data (orders)",
      resultsSummary: "Total omzet revenue adalah Rp 350.000.000",
      dataPreview: [{ total_revenue: 350_000_000 }],
      traceId: "ds-trace-contract-eval",
      stageTimings: {
        preflightMs: 8,
        retrievalMs: 20,
        planningMs: 40,
        validationMs: 12,
        databaseExecutionMs: 65,
        synthesisMs: 25,
        totalMs: 170,
      },
    });

    // Step A: Verify effective state
    const stateA = await orchestrator.resolveEffectiveOrchestrationState(companyId, agentId);
    expect(stateA.mode).toBe("auto");
    expect(stateA.enabled).toBe(true);
    expect(stateA.assignmentScope).toBe("selected");
    expect(stateA.effectiveDataSourceIds).toEqual([sourceId]);

    // Step B: Query context preflight
    const preflightA = await orchestrator.resolveQueryContext(companyId, {
      agentId,
      query: "Berapa total revenue dari tabel orders?",
    });
    expect(preflightA.lane).toBe("orchestrated");
    expect(preflightA.allowedDataSourceIds).toContain(sourceId);
    expect(preflightA.availableTables[0].tableName).toBe("orders");

    // Step C: Execute query through coordinator
    const executionA = await orchestrator.createQueryExecution(companyId, {
      agentId,
      query: "Berapa total revenue dari tabel orders?",
      dataSourceIds: [sourceId],
    });
    expect(executionA.status).toBe("completed");
    expect(executionA.resultsSummary).toContain("Rp 350.000.000");
    expect(executionA.stageTimings?.totalMs).toBe(170);

    // Step D: Revoke data source access (scope: "none")
    currentAgentState.metadata.dataSourceAccess = {
      mode: "none",
      dataSourceIds: [],
      collectionIds: [],
    };

    const stateRevoked = await orchestrator.resolveEffectiveOrchestrationState(companyId, agentId);
    expect(stateRevoked.enabled).toBe(false);
    expect(stateRevoked.assignmentScope).toBe("none");

    const preflightRevoked = await orchestrator.resolveQueryContext(companyId, {
      agentId,
      query: "Berapa total revenue dari tabel orders?",
    });
    expect(preflightRevoked.lane).toBe("abstained");
    expect(preflightRevoked.allowedDataSourceIds).toHaveLength(0);

    // Step E: Set mode explicitly to "off"
    currentAgentState.metadata.datasourceOrchestration.mode = "off";
    currentAgentState.metadata.dataSourceAccess = {
      mode: "selected",
      dataSourceIds: [sourceId],
      collectionIds: [],
    };

    const stateOff = await orchestrator.resolveEffectiveOrchestrationState(companyId, agentId);
    expect(stateOff.mode).toBe("off");
    expect(stateOff.enabled).toBe(false);

    const preflightOff = await orchestrator.resolveQueryContext(companyId, {
      agentId,
      query: "Berapa total revenue dari tabel orders?",
    });
    expect(preflightOff.lane).toBe("abstained");
    expect(preflightOff.reasoning).toContain("Orchestration mode is explicitly set to Off");
  });
});
