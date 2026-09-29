import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { DataSourcesService } from "../services/data-sources.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { DatabaseIntegrationService } from "../services/database-integration.js";
import { ClickhouseService } from "../services/clickhouse.js";
import { badRequest, notFound } from "../errors.js";

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

  // 1. List data sources for company
  router.get("/companies/:companyId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const list = await dsService.list(companyId);
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
      const tableId = req.params.tableId as string;
      await assertCompanyAccess(req, companyId);

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
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;

    const results = await dsService.searchKnowledge(companyId, query, {
      dataSourceId,
      limit,
    });

    res.json(results);
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
