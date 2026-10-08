import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { dataSourceRoutes } from "../routes/data-sources.js";
import { DataSourcesService } from "../services/data-sources.js";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";

const companyId = "company-1";
const ownerAgentId = "agent-owner";
const execution = {
  id: "exec-1",
  companyId,
  agentId: ownerAgentId,
  dataSourceIds: ["datasource-1"],
  query: "Show private result",
  status: "completed" as const,
  data: [{ value: "private" }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", dataSourceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("datasource query execution read authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not expose another agent's query or result payload", async () => {
    vi.spyOn(EnterpriseOrchestratorService.prototype, "getQueryExecution").mockResolvedValue(execution);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: "agent-other" });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-executions/${execution.id}`)
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("own query executions"));
  });

  it("allows the owning agent to read its query execution", async () => {
    vi.spyOn(EnterpriseOrchestratorService.prototype, "getQueryExecution").mockResolvedValue(execution);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-executions/${execution.id}`)
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual([{ value: "private" }]));
  });

  it("denies the owner after one source used by the result is revoked", async () => {
    vi.spyOn(EnterpriseOrchestratorService.prototype, "getQueryExecution").mockResolvedValue(execution);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: [],
    } as any);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-executions/${execution.id}`)
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("no longer assigned"));
  });

  it("fails closed for legacy execution rows without datasource provenance", async () => {
    vi.spyOn(EnterpriseOrchestratorService.prototype, "getQueryExecution").mockResolvedValue({
      ...execution,
      dataSourceIds: undefined,
    });
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "all",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-executions/${execution.id}`)
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("cannot be verified"));
  });

  it("lists only currently assigned source executions for the requesting agent", async () => {
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const list = vi.spyOn(EnterpriseOrchestratorService.prototype, "listQueryExecutions").mockResolvedValue([]);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-executions?dataSourceId=datasource-1`)
      .expect(200)
      .expect({ executions: [] });

    expect(list).toHaveBeenCalledWith(companyId, expect.objectContaining({
      agentId: ownerAgentId,
      dataSourceId: "datasource-1",
      allowedDataSourceIds: ["datasource-1"],
    }));
  });

  it("lists query experiences only for a datasource assigned to the requesting agent", async () => {
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const list = vi.spyOn(EnterpriseOrchestratorService.prototype, "listExperiences").mockResolvedValue([]);
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-experiences?dataSourceId=datasource-1`)
      .expect(200)
      .expect({ experiences: [] });

    expect(list).toHaveBeenCalledWith(companyId, expect.objectContaining({
      dataSourceId: "datasource-1",
      allowedDataSourceIds: ["datasource-1"],
    }));
  });

  it("rejects query experiences from a datasource not assigned to the requesting agent", async () => {
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const list = vi.spyOn(EnterpriseOrchestratorService.prototype, "listExperiences");
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .get(`/api/companies/${companyId}/orchestrator/query-experiences?dataSourceId=private-source`)
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("not assigned"));

    expect(list).not.toHaveBeenCalled();
  });

  it("promotes a query experience only through the board-scoped datasource endpoint", async () => {
    vi.spyOn(DataSourcesService.prototype, "getById").mockResolvedValue({ id: "datasource-1" } as any);
    vi.spyOn(EnterpriseOrchestratorService.prototype, "listExperiences").mockResolvedValue([{
      id: "exp-1",
      referencedDataSourceIds: ["datasource-1"],
    }] as any);
    const promote = vi.spyOn(EnterpriseOrchestratorService.prototype, "promoteExperience").mockResolvedValue({ id: "exp-1" } as any);
    const app = makeApp({
      type: "board",
      source: "session",
      companyId,
      companyIds: [companyId],
      userId: "board-user",
      isInstanceAdmin: true,
    });

    await request(app)
      .post(`/api/companies/${companyId}/orchestrator/query-experiences/exp-1/promote`)
      .send({
        dataSourceId: "datasource-1",
        targetStatus: "user_approved",
        evidence: { reviewNote: "Reviewed in datasource detail" },
      })
      .expect(200)
      .expect(({ body }) => expect(body.experience.id).toBe("exp-1"));

    expect(promote).toHaveBeenCalledWith(companyId, "exp-1", "user_approved", {
      reviewNote: "Reviewed in datasource detail",
      reviewedBy: "board-user",
    });
  });

  it("accepts feedback through the orchestrator endpoint only when the source grant remains active", async () => {
    vi.spyOn(EnterpriseOrchestratorService.prototype, "getQueryExecution").mockResolvedValue(execution);
    vi.spyOn(DataSourcesService.prototype, "getAgentDataSources").mockResolvedValue({
      mode: "selected",
      effectiveDataSourceIds: ["datasource-1"],
    } as any);
    const submit = vi.spyOn(EnterpriseOrchestratorService.prototype, "submitQueryFeedback").mockResolvedValue();
    const app = makeApp({ type: "agent", source: "api_key", companyId, agentId: ownerAgentId });

    await request(app)
      .post(`/api/companies/${companyId}/orchestrator/query-executions/${execution.id}/feedback`)
      .send({ dataSourceId: "datasource-1", verdict: "needs_correction", correctionNote: "Wrong metric" })
      .expect(200)
      .expect({ ok: true });

    expect(submit).toHaveBeenCalledWith(companyId, execution.id, expect.objectContaining({
      dataSourceId: "datasource-1",
      verdict: "needs_correction",
    }), ownerAgentId, "agent");
  });
});
