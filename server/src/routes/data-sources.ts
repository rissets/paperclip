import { Router, type Request, type Response } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { DataSourcesService } from "../services/data-sources.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { DatabaseIntegrationService } from "../services/database-integration.js";
import { ClickhouseService } from "../services/clickhouse.js";
import { badRequest, forbidden, notFound } from "../errors.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
});

export function dataSourceRoutes(db: Db) {
  const router = Router();
  const dsService = new DataSourcesService(db);
  const onboardingOrchestrator = new OnboardingOrchestratorService(db);
  const dbIntegration = new DatabaseIntegrationService();
  const clickhouse = new ClickhouseService();
  const orchestrator = new EnterpriseOrchestratorService(db);

  const getRequestingAgentId = (req: Request): string | null => {
    if (req.actor.type === "agent" && req.actor.agentId) {
      return req.actor.agentId;
    }
    const queryAgentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : null;
    if (queryAgentId) return queryAgentId;
    const headerAgentId =
      (typeof req.headers["x-agent-id"] === "string" ? req.headers["x-agent-id"].trim() : null) ??
      (typeof req.headers["x-paperclip-agent-id"] === "string" ? req.headers["x-paperclip-agent-id"].trim() : null);
    if (headerAgentId) return headerAgentId;
    return null;
  };

  // 1. List data sources for company (filtered by agent access when invoked by or for an agent)
  router.get("/companies/:companyId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    let list = await dsService.list(companyId);

    const agentId = getRequestingAgentId(req);
    if (agentId) {
      const access = await dsService.getAgentDataSources(companyId, agentId);
      if (access.mode === "none") {
        return res.json([]);
      }
      if (access.mode === "selected") {
        const allowed = new Set(access.dataSourceIds);
        list = list.filter((ds: any) => allowed.has(ds.id));
      }
    }
    res.json(list);
  });

  // 2. Upload file(s) & trigger Onboarding Orchestrator (supports single and batch uploads)
  router.post(
    "/companies/:companyId/data-sources/upload",
    upload.any(),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const files: Express.Multer.File[] = [];
      if (req.file) {
        files.push(req.file);
      }
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else if (req.files && typeof req.files === "object") {
        for (const list of Object.values(req.files)) {
          if (Array.isArray(list)) files.push(...list);
        }
      }

      if (files.length === 0) {
        throw badRequest("No file provided in request");
      }

      const name = req.body?.name as string | undefined;
      const description = req.body?.description as string | undefined;

      const results = [];
      for (const file of files) {
        const result = await onboardingOrchestrator.onboardSource(
          companyId,
          {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
          {
            name: files.length === 1 ? name : undefined,
            description,
            async: true,
          },
        );
        results.push(result);
      }

      if (results.length === 1) {
        res.status(202).json({
          ...results[0],
          dataSources: results,
          count: 1,
        });
      } else {
        res.status(202).json({
          id: results[0]?.id,
          dataSources: results,
          count: results.length,
          message: `${results.length} data sources queued for autonomous onboarding`,
        });
      }
    },
  );

  // 2b. Test database connection
  router.post(
    "/companies/:companyId/data-sources/test-connection",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const config = req.body;
      if (!config || !config.host || !config.database || !config.username || !config.type) {
        throw badRequest("Database type, host, database, and username are required");
      }

      const result = await dbIntegration.testConnection(config);
      res.json(result);
    },
  );

  // 2c. Connect external database & run Database Integration Agent onboarding
  router.post(
    "/companies/:companyId/data-sources/connect-database",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const { config, name, description } = req.body || {};
      if (!config || !config.host || !config.database || !config.username || !config.type) {
        throw badRequest("Database type, host, database, and username are required in config");
      }

      const result = await onboardingOrchestrator.onboardDatabase(
        companyId,
        config,
        { name, description },
      );

      res.status(202).json(result);
    },
  );

  // 2d. Connect external REST / OpenAPI & run ApiIntegrationAgent onboarding
  router.post(
    "/companies/:companyId/data-sources/connect-api",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const { config, name, description } = req.body || {};
      if (!config || !config.baseUrl) {
        throw badRequest("Base URL is required in API config");
      }

      const result = await onboardingOrchestrator.onboardApi(companyId, config, { name, description });
      res.status(201).json(result);
    },
  );

  // 2e. Connect IoT MQTT broker & run IotIntegrationAgent onboarding
  router.post(
    "/companies/:companyId/data-sources/connect-iot",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const { config, name, description } = req.body || {};
      if (!config || !config.brokerUrl || !config.topics) {
        throw badRequest("Broker URL and topics are required in IoT config");
      }

      const result = await onboardingOrchestrator.onboardIot(companyId, config, { name, description });
      res.status(201).json(result);
    },
  );

  // 2f. Connect CCTV RTSP feed & run CctvIntegrationAgent onboarding
  router.post(
    "/companies/:companyId/data-sources/connect-cctv",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const { config, name, description } = req.body || {};
      if (!config || !config.streamUrl || !config.cameraName) {
        throw badRequest("Stream URL and cameraName are required in CCTV config");
      }

      const result = await onboardingOrchestrator.onboardCctv(companyId, config, { name, description });
      res.status(201).json(result);
    },
  );

  // 2g. Backfill missing semantic profiles for existing data sources
  router.post(
    "/companies/:companyId/data-sources/backfill-profiles",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const force = req.query?.force === "true" || req.body?.force === true;
      const count = await dsService.backfillSemanticProfiles(companyId, force);
      res.json({ success: true, updatedCount: count });
    },
  );

  // 3. Get single data source detail
  router.get("/companies/:companyId/data-sources/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(req, companyId);

    const agentId = getRequestingAgentId(req);
    if (agentId) {
      const access = await dsService.getAgentDataSources(companyId, agentId);
      if (access.mode === "none") {
        throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke data source apa pun");
      }
      if (access.mode === "selected" && !access.dataSourceIds.includes(id)) {
        throw forbidden(`Akses ditolak: Data source '${id}' tidak ditugaskan ke agen ini`);
      }
    }

    const ds = await dsService.getById(companyId, id);
    if (!ds) throw notFound(`Data source not found: ${id}`);
    res.json(ds);
  });

  // 4. Delete data source
  router.delete("/companies/:companyId/data-sources/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(req, companyId);
    const ok = await dsService.delete(companyId, id);
    if (!ok) throw notFound(`Data source not found: ${id}`);
    res.json({ success: true, id });
  });

  // 5. Query structured table
  router.post(
    "/companies/:companyId/data-sources/:id/tables/:tableId/query",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const tableId = req.params.tableId as string;
      await assertCompanyAccess(req, companyId);

      const agentId = getRequestingAgentId(req);
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        if (access.mode === "none") {
          throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke data source apa pun");
        }
        if (access.mode === "selected" && !access.dataSourceIds.includes(id)) {
          throw forbidden(`Akses ditolak: Data source '${id}' tidak ditugaskan ke agen ini`);
        }
      }

      const filter = req.body?.filter;
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const offset = req.body?.offset ? Number(req.body.offset) : undefined;
      const aggregate = req.body?.aggregate;

      const result = await dsService.queryTable(companyId, tableId, {
        filter,
        limit,
        offset,
        aggregate,
      });

      res.json(result);
    },
  );

  // 5b. Direct read-only SQL execution on external database
  router.post(
    "/companies/:companyId/data-sources/:id/query-sql",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(req, companyId);

      const agentId = getRequestingAgentId(req);
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        if (access.mode === "none") {
          throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke database apa pun");
        }
        if (access.mode === "selected" && !access.dataSourceIds.includes(id)) {
          throw forbidden(`Akses ditolak: Database '${id}' tidak ditugaskan ke agen ini`);
        }
      }

      const sqlQuery = req.body?.sql as string;
      if (!sqlQuery || !sqlQuery.trim()) {
        throw badRequest("SQL query is required");
      }

      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      try {
        const result = await dsService.querySql(companyId, id, sqlQuery, limit);
        res.json(result);
      } catch (err: any) {
        throw badRequest(err.message || "SQL query execution failed");
      }
    },
  );

  // 5c. ClickHouse: Health status & tables in isolated company database
  router.get(
    "/companies/:companyId/data-sources/clickhouse/status",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const health = await clickhouse.isHealthy();
      const companyDatabase = clickhouse.getCompanyDatabase(companyId);
      let tables: string[] = [];
      if (health.ok) {
        try {
          tables = await clickhouse.listTables(companyId);
        } catch {
          tables = [];
        }
      }

      res.json({
        ok: health.ok,
        version: health.version,
        error: health.error,
        companyDatabase,
        tables,
      });
    },
  );

  // 5d. ClickHouse: Execute read-only analytical SQL query
  router.post(
    "/companies/:companyId/data-sources/clickhouse/query",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const sqlQuery = req.body?.sql as string;
      if (!sqlQuery || !sqlQuery.trim()) {
        throw badRequest("SQL query is required");
      }

      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      try {
        const result = await dsService.queryClickhouse(companyId, sqlQuery, limit);
        res.json(result);
      } catch (err: any) {
        throw badRequest(err.message || "ClickHouse query execution failed");
      }
    },
  );

  // 5e. ClickHouse: Sync single data source
  router.post(
    "/companies/:companyId/data-sources/:id/clickhouse-sync",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(req, companyId);

      try {
        const result = await dsService.syncToClickhouse(companyId, id);
        res.json({ success: true, ...result });
      } catch (err: any) {
        throw badRequest(err.message || "ClickHouse sync failed");
      }
    },
  );

  // 5f. ClickHouse: Sync all company data sources
  router.post(
    "/companies/:companyId/data-sources/clickhouse/sync-all",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      try {
        const result = await dsService.syncToClickhouse(companyId);
        res.json({ success: true, ...result });
      } catch (err: any) {
        throw badRequest(err.message || "ClickHouse sync-all failed");
      }
    },
  );

  // 6. Search RAG Knowledge base
  router.post("/companies/:companyId/data-sources/search-knowledge", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);

    const query = req.body?.query as string;
    if (!query || !query.trim()) {
      throw badRequest("Search query is required");
    }

    const dataSourceId = req.body?.dataSourceId as string | undefined;
    const dataSourceIds = Array.isArray(req.body?.dataSourceIds) ? req.body.dataSourceIds : undefined;
    const rawAgentId = (req.body?.agentId as string | undefined) || (req.headers["x-paperclip-agent-id"] as string | undefined);
    const agentId = rawAgentId || getRequestingAgentId(req);
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;

    const results = await dsService.searchKnowledge(companyId, query, {
      dataSourceId,
      dataSourceIds,
      agentId: agentId || undefined,
      limit,
    });

    res.json(results);
  });

  // 6b. Get Agent Assigned Data Sources
  router.get("/companies/:companyId/agents/:agentId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyAccess(req, companyId);
    const result = await dsService.getAgentDataSources(companyId, agentId);
    res.json(result);
  });

  // 6c. Update Agent Assigned Data Sources
  router.put("/companies/:companyId/agents/:agentId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyAccess(req, companyId);
    const mode = req.body?.mode || "all";
    const dataSourceIds = Array.isArray(req.body?.dataSourceIds) ? req.body.dataSourceIds : [];
    const result = await dsService.updateAgentDataSources(companyId, agentId, {
      mode,
      dataSourceIds,
    });
    res.json(result);
  });

  // Shorthand routes without companyId in path
  router.get("/agents/:agentId/data-sources", async (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) throw notFound("Agent not found");
    await assertCompanyAccess(req, agent.companyId);
    const result = await dsService.getAgentDataSources(agent.companyId, agentId);
    res.json(result);
  });

  router.put("/agents/:agentId/data-sources", async (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) throw notFound("Agent not found");
    await assertCompanyAccess(req, agent.companyId);
    const mode = req.body?.mode || "all";
    const dataSourceIds = Array.isArray(req.body?.dataSourceIds) ? req.body.dataSourceIds : [];
    const result = await dsService.updateAgentDataSources(agent.companyId, agentId, {
      mode,
      dataSourceIds,
    });
    res.json(result);
  });

  // 7. Orchestrator: List sessions
  router.get("/companies/:companyId/orchestrator/sessions", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const sessions = await orchestrator.listSessions(companyId);
    res.json(sessions);
  });

  // 8. Orchestrator: Create session
  router.post("/companies/:companyId/orchestrator/sessions", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const title = req.body?.title as string | undefined;
    const session = await orchestrator.createSession(companyId, title);
    res.status(201).json(session);
  });

  // 9. Orchestrator: Get session messages
  router.get(
    "/companies/:companyId/orchestrator/sessions/:sessionId/messages",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      await assertCompanyAccess(req, companyId);
      const messages = await orchestrator.getMessages(companyId, sessionId);
      res.json(messages);
    },
  );

  // 10. Orchestrator: Chat with Main Enterprise Agent
  router.post(
    "/companies/:companyId/orchestrator/sessions/:sessionId/chat",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      await assertCompanyAccess(req, companyId);

      const query = req.body?.message as string;
      if (!query || !query.trim()) {
        throw badRequest("Chat message is required");
      }

      const responseMessage = await orchestrator.chat(companyId, sessionId, query);
      res.json(responseMessage);
    },
  );

  return router;
}
