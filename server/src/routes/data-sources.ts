import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { DataSourcesService } from "../services/data-sources.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { DatabaseIntegrationService } from "../services/database-integration.js";
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
  const orchestrator = new EnterpriseOrchestratorService(db);

  // 1. List data sources for company
  router.get("/companies/:companyId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const list = await dsService.list(companyId);
    res.json(list);
  });

  // 2. Upload file & trigger Onboarding Orchestrator
  router.post(
    "/companies/:companyId/data-sources/upload",
    upload.single("file"),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(req, companyId);

      const file = req.file;
      if (!file) {
        throw badRequest("No file provided in request");
      }

      const name = req.body?.name as string | undefined;
      const description = req.body?.description as string | undefined;

      const result = await onboardingOrchestrator.onboardSource(
        companyId,
        {
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
        },
        { name, description },
      );

      res.status(201).json(result);
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

      res.status(201).json(result);
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
