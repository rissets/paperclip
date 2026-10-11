import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DECISION_TEST_REQUEST, updateDecisionModelSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { decisionModelService, settingsDecisionTest } from "../services/decision-models.js";
import { heartbeatService } from "../services/heartbeat.js";
import { listOpenRouterModels } from "../services/openrouter-models.js";
import { fetchModelsFromEndpoint } from "../services/custom-endpoint-models.js";
import { parseCostDateRange, parseCostLimit } from "./costs.js";

export function decisionModelRoutes(db: Db) {
  const router = Router();
  const service = decisionModelService(db, { budgetHooks: { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork } });
  router.get("/companies/:companyId/decision-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    if (!canManage) { res.json({ canManage, settings: null, choices: [] }); return; }
    res.json({ canManage, settings: await service.settings(companyId), choices: await service.choices(companyId, getActorInfo(req).actorId) });
  });
  router.put("/companies/:companyId/decision-model", validate(updateDecisionModelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    res.json(await service.configure(companyId, getActorInfo(req).actorId, req.body));
  });
  router.get("/companies/:companyId/decision-model/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    const choices = await service.choices(companyId, getActorInfo(req).actorId);
    const connection = choices.find((c) => c.id === req.query.connectionId);
    if (!connection) throw forbidden();
    if (connection.routing?.baseUrl) {
      try {
        const live = await fetchModelsFromEndpoint({ endpoint: connection.routing.baseUrl });
        if (live.length > 0) { res.json(live); return; }
      } catch { /* fallback */ }
      if (connection.routing?.models?.length) {
        res.json(connection.routing.models.map(m => ({ id: m.id, label: m.id })));
        return;
      }
    }
    if (connection.provider === "openrouter" || connection.routing?.kind === "openrouter") {
      const orModels = (await listOpenRouterModels()).map(m => ({ ...m, id: m.id.replace(/^openrouter\//, "") }));
      const hasJev = orModels.some(m => m.id === "typesafe/jev-1.13");
      const list = hasJev ? orModels : [{ id: "typesafe/jev-1.13", label: "TypeSafe Jev 1.13 (typesafe/jev-1.13)" }, ...orModels];
      res.json(list.map(m => m.id === "typesafe/jev-1.13" ? { ...m, label: "TypeSafe Jev 1.13 (typesafe/jev-1.13)" } : m));
      return;
    }
    if (connection.provider === "openai") {
      res.json([{ id: "gpt-6-luna", label: "GPT-6 Luna (gpt-6-luna)" }]);
      return;
    }
    res.json(connection.routing?.models?.map(m => ({ id: m.id, label: m.id })) ?? []);
  });
  router.post("/companies/:companyId/decision-model/sync-models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    const { connectionId, endpoint, apiKey } = req.body ?? {};
    if (endpoint) {
      const models = await fetchModelsFromEndpoint({ endpoint, apiKey });
      res.json({ models });
      return;
    }
    const choices = await service.choices(companyId, getActorInfo(req).actorId);
    const connection = choices.find((c) => c.id === connectionId);
    if (!connection) throw forbidden();
    if (connection.routing?.baseUrl) {
      const models = await fetchModelsFromEndpoint({ endpoint: connection.routing.baseUrl });
      res.json({ models });
      return;
    }
    if (connection.provider === "openrouter" || connection.routing?.kind === "openrouter") {
      const orModels = (await listOpenRouterModels()).map(m => ({ ...m, id: m.id.replace(/^openrouter\//, "") }));
      const hasJev = orModels.some(m => m.id === "typesafe/jev-1.13");
      const list = hasJev ? orModels : [{ id: "typesafe/jev-1.13", label: "TypeSafe Jev 1.13 (typesafe/jev-1.13)" }, ...orModels];
      res.json({ models: list.map(m => m.id === "typesafe/jev-1.13" ? { ...m, label: "TypeSafe Jev 1.13 (typesafe/jev-1.13)" } : m) });
      return;
    }
    if (connection.provider === "openai") {
      res.json({ models: [{ id: "gpt-6-luna", label: "GPT-6 Luna (gpt-6-luna)" }] });
      return;
    }
    res.json({ models: connection.routing?.models?.map(m => ({ id: m.id, label: m.id })) ?? [] });
  });
  router.get("/companies/:companyId/decision-model/availability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.availability({ companyId, actor: req.actor, feature: settingsDecisionTest }));
  });
  router.post("/companies/:companyId/decision-model/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    // The client cannot supply a prompt, model, identity, or background flag.
    res.json(await service.decide({ companyId, actor: req.actor, feature: settingsDecisionTest }, DECISION_TEST_REQUEST));
  });
  router.get("/companies/:companyId/decision-model/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.history(companyId, req.actor, { ...parseCostDateRange(req.query), limit: parseCostLimit(req.query) }));
  });
  return router;
}
