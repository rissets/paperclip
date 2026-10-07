import express, { Router, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, dataSourceTables, dataSourceCollections } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { DataSourcesService } from "../services/data-sources.js";
import { DataSourceQueryJobsService } from "../services/data-source-query-jobs.js";
import { DataSourceUploadSessionsService } from "../services/data-source-upload-sessions.js";
import { DataSourceCollectionsService } from "../services/data-source-collections.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { EnterpriseOrchestratorService } from "../services/enterprise-orchestrator.js";
import { DatabaseIntegrationService } from "../services/database-integration.js";
import { isExternalQueryAbortError } from "../services/external-query-abort.js";
import {
  ClickhouseService,
  clickhouseSourceTableName,
  rewriteClickhouseTableReferences,
} from "../services/clickhouse.js";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { userRbacService } from "../services/user-rbac-service.js";
import { makeDataSourceCacheKey } from "../services/data-source-cache.js";
import {
  completeDataSourceUploadSessionSchema,
  createDataSourceUploadSessionSchema,
  dataSourceQueryJobRequestSchema,
  dataSourceSnapshotRequestSchema,
  dataSourceEmbeddingReindexRequestSchema,
  dataSourceEmbeddingPruneRequestSchema,
} from "@paperclipai/shared";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DEFAULT_CSV_UPLOAD_BYTES = GiB;
const DEFAULT_FILE_UPLOAD_BYTES = 100 * MiB;
const DEFAULT_REQUEST_UPLOAD_BYTES = GiB;

function configuredByteLimit(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Math.min(value, max);
}

const uploadLimits = {
  csvFileBytes: configuredByteLimit("DATASOURCE_MAX_CSV_UPLOAD_BYTES", DEFAULT_CSV_UPLOAD_BYTES, 2 * GiB),
  otherFileBytes: configuredByteLimit("DATASOURCE_MAX_FILE_UPLOAD_BYTES", DEFAULT_FILE_UPLOAD_BYTES, DEFAULT_FILE_UPLOAD_BYTES),
  requestBytes: configuredByteLimit("DATASOURCE_MAX_UPLOAD_REQUEST_BYTES", DEFAULT_REQUEST_UPLOAD_BYTES, 2 * GiB),
};

function requestAbortController(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfResponseIncomplete = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", abortIfResponseIncomplete);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abortIfResponseIncomplete);
    },
  };
}

const uploadDirectory = path.join(os.tmpdir(), "paperclip-data-source-uploads");

const upload = multer({
  storage: {
    _handleFile(req, file, callback) {
      fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
      const filename = randomUUID();
      const filePath = path.join(uploadDirectory, filename);
      const extension = path.extname(file.originalname).toLowerCase();
      const isStreamableCsv = extension === ".csv" || extension === ".tsv";
      const maxFileBytes = isStreamableCsv ? uploadLimits.csvFileBytes : uploadLimits.otherFileBytes;
      let fileBytes = 0;
      const requestState = req as Request & { dataSourceUploadBytes?: number };
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          fileBytes += chunk.length;
          requestState.dataSourceUploadBytes = (requestState.dataSourceUploadBytes || 0) + chunk.length;
          if (fileBytes > maxFileBytes) {
            done(new Error(isStreamableCsv
              ? `CSV/TSV upload exceeds the ${Math.floor(maxFileBytes / MiB)} MiB file limit`
              : `This file type exceeds the ${Math.floor(maxFileBytes / MiB)} MiB file limit`));
            return;
          }
          if (requestState.dataSourceUploadBytes > uploadLimits.requestBytes) {
            done(new Error(`Combined upload exceeds the ${Math.floor(uploadLimits.requestBytes / MiB)} MiB request limit`));
            return;
          }
          done(null, chunk);
        },
      });

      void pipeline(file.stream, meter, fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 }))
        .then(() => callback(null, {
          destination: uploadDirectory,
          filename,
          path: filePath,
          size: fileBytes,
        }))
        .catch((error: unknown) => {
          fs.rmSync(filePath, { force: true });
          callback(error as Error);
        });
    },
    _removeFile(_req, file, callback) {
      const filePath = (file as Express.Multer.File).path;
      if (filePath) fs.rm(filePath, { force: true }, callback);
      else callback(null);
    },
  },
  limits: {
    // The storage engine applies the stricter extension-specific limit while
    // the parser-level limit bounds Multer/Busboy before its custom engine runs.
    fileSize: Math.max(uploadLimits.csvFileBytes, uploadLimits.otherFileBytes),
    files: 8,
    fields: 20,
    fieldSize: 1024 * 1024,
  },
});

function cleanupUploadedRequestFiles(req: Request, res: Response, next: (error?: unknown) => void): void {
  res.once("finish", () => {
    const uploaded = req.file
      ? [req.file]
      : Array.isArray(req.files)
        ? req.files
        : req.files && typeof req.files === "object"
          ? Object.values(req.files).flat()
          : [];
    for (const file of uploaded) {
      if (file.path) fs.rmSync(file.path, { force: true });
    }
  });
  next();
}

export function dataSourceRoutes(db: Db) {
  const router = Router();
  const dsService = new DataSourcesService(db);
  const queryJobsService = new DataSourceQueryJobsService(db);
  const uploadSessionsService = new DataSourceUploadSessionsService(db);
  const collectionsService = new DataSourceCollectionsService(db);
  const onboardingOrchestrator = new OnboardingOrchestratorService(db);
  const dbIntegration = new DatabaseIntegrationService();
  const clickhouse = new ClickhouseService();
  const orchestrator = new EnterpriseOrchestratorService(db);
  const rbac = userRbacService(db);

  const uploadSessionActor = (req: Request) => req.actor.type === "agent"
    ? { type: "agent" as const, id: req.actor.agentId || "unknown-agent", agentId: req.actor.agentId, runId: req.actor.runId }
    : { type: "user" as const, id: req.actor.userId || "local-board" };

  router.post("/companies/:companyId/data-source-upload-sessions", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    const parsed = createDataSourceUploadSessionSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest("Upload session input is invalid", parsed.error.flatten());
    const { fileName, contentType, expectedBytes, name, description, collectionId } = parsed.data;
    const session = await uploadSessionsService.create({
      companyId, fileName, contentType, expectedBytes,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(collectionId ? { collectionId } : {}),
      actor: uploadSessionActor(req),
    });
    res.status(201).json(session);
  });

  router.get("/companies/:companyId/data-source-upload-sessions/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    res.json(await uploadSessionsService.get(companyId, req.params.id as string));
  });

  router.put(
    "/companies/:companyId/data-source-upload-sessions/:id/parts/:partNumber",
    async (req, _res, next) => {
      await assertCanManageDataSources(req, req.params.companyId as string);
      next();
    },
    express.raw({ type: "application/octet-stream", limit: "17mb" }),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const partNumber = Number(req.params.partNumber);
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body) throw badRequest("Upload part must use application/octet-stream");
      res.json(await uploadSessionsService.uploadPart(companyId, req.params.id as string, partNumber, body));
    },
  );

  router.post("/companies/:companyId/data-source-upload-sessions/:id/complete", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    const parsed = completeDataSourceUploadSessionSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest("Upload completion manifest is invalid", parsed.error.flatten());
    const result = await uploadSessionsService.complete(companyId, req.params.id as string, parsed.data.partSha256s);
    const source = await dsService.getById(companyId, result.dataSourceId);
    if (!source) throw notFound("Data source not found after upload completion");
    res.status(202).json({ ...source, uploadSession: result.session, dataSources: [source], count: 1 });
  });

  router.delete("/companies/:companyId/data-source-upload-sessions/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    const session = await uploadSessionsService.abort(companyId, req.params.id as string, uploadSessionActor(req));
    res.json({ success: true, data: session });
  });

  async function assertCanManageDataSources(req: Request, companyId: string) {
    await assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      const canManage = await rbac.canUserAddDataSource(
        companyId,
        req.actor.userId || "local-board",
        req.actor.isInstanceAdmin,
      );
      if (!canManage) {
        throw forbidden("Akses ditolak: Hanya Owner atau Admin yang dapat menambahkan atau mengelola data source");
      }
    }
  }

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

  async function assertAgentCanUseDataSource(req: Request, companyId: string, dataSourceId: string) {
    const agentId = getRequestingAgentId(req);
    if (!agentId) return;
    const access = await dsService.getAgentDataSources(companyId, agentId);
    if (access.mode === "none") {
      throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke data source apa pun");
    }
    const allowedIds = access.effectiveDataSourceIds || access.dataSourceIds || [];
    if (access.mode === "selected" && !allowedIds.includes(dataSourceId)) {
      throw forbidden(`Akses ditolak: Data source '${dataSourceId}' tidak ditugaskan ke agen ini`);
    }
  }

  function queryJobActor(req: Request) {
    return req.actor.type === "agent"
      ? { type: "agent" as const, id: req.actor.agentId || "unknown-agent" }
      : { type: "board" as const, id: req.actor.userId || "local-board" };
  }

  // 1. List data sources for company (filtered by agent access when invoked by or for an agent)
  router.get("/companies/:companyId/data-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const collectionId = typeof req.query.collectionId === "string" ? req.query.collectionId : undefined;
    let list = await dsService.list(companyId, collectionId);

    const agentId = getRequestingAgentId(req);
    if (agentId) {
      const access = await dsService.getAgentDataSources(companyId, agentId);
      if (access.mode === "none") {
        return res.json([]);
      }
      if (access.mode === "selected") {
        const allowed = new Set(access.effectiveDataSourceIds || access.dataSourceIds || []);
        list = list.filter((ds: any) => allowed.has(ds.id));
      }
    } else if (req.actor.type === "board" && req.actor.userId && !req.actor.isInstanceAdmin) {
      const isOwnerOrAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId);
      if (!isOwnerOrAdmin) {
        const allowedIds = await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
        const allowed = new Set(allowedIds);
        list = list.filter((ds: any) => allowed.has(ds.id));
      }
    }
    res.json(list);
  });

  // 2. Upload file(s) & trigger Onboarding Orchestrator (supports single and batch uploads, plus ZIP archives)
  router.post(
    "/companies/:companyId/data-sources/upload",
    async (req, _res, next) => {
      await assertCanManageDataSources(req, req.params.companyId as string);
      next();
    },
    upload.any(),
    cleanupUploadedRequestFiles,
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;

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
      const collectionId = req.body?.collectionId as string | undefined;

      const results = [];
      for (const file of files) {
        const result = await onboardingOrchestrator.onboardSource(
          companyId,
          {
            filePath: file.path,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
          {
            name: files.length === 1 ? name : undefined,
            description,
            collectionId,
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
      await assertCanManageDataSources(req, companyId);

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
      await assertCanManageDataSources(req, companyId);

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
      await assertCanManageDataSources(req, companyId);

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
      await assertCanManageDataSources(req, companyId);

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
      await assertCanManageDataSources(req, companyId);

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
      await assertCanManageDataSources(req, companyId);

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
      const allowedIds = access.effectiveDataSourceIds || access.dataSourceIds || [];
      if (access.mode === "selected" && !allowedIds.includes(id)) {
        throw forbidden(`Akses ditolak: Data source '${id}' tidak ditugaskan ke agen ini`);
      }
    } else if (req.actor.type === "board" && req.actor.userId && !req.actor.isInstanceAdmin) {
      const isOwnerOrAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId);
      if (!isOwnerOrAdmin) {
        const canAccess = await rbac.canUserAccessDataSource(companyId, req.actor.userId, id);
        if (!canAccess) {
          throw forbidden("Akses ditolak: Anda tidak memiliki izin akses ke data source ini");
        }
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
    await assertCanManageDataSources(req, companyId);
    const ok = await dsService.delete(companyId, id);
    if (!ok) throw notFound(`Data source not found: ${id}`);
    res.json({ success: true, id });
  });

  // 4b. Reprocess single data source
  router.post("/companies/:companyId/data-sources/:id/reprocess", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const result = await dsService.enqueueReprocess(companyId, id);
    res.status(202).json({ success: true, data: result });
  });

  // Stage a complete target vector index, then atomically switch the datasource's active space.
  router.post("/companies/:companyId/data-sources/:id/embedding-reindex", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only a board operator can change a datasource embedding space");
    const parsed = dataSourceEmbeddingReindexRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Embedding reindex input is invalid", parsed.error.flatten());
    const actor = getActorInfo(req);
    const job = await dsService.enqueueEmbeddingReindex(companyId, id, parsed.data.targetSpace, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    }, parsed.data.targetGeneration);
    res.status(202).json({ success: true, data: job });
  });

  // Preview stale vectors first; deletion requires a separate explicit confirmation request.
  router.post("/companies/:companyId/data-sources/:id/embedding-generations/prune", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only a board operator can prune retained embedding generations");
    const parsed = dataSourceEmbeddingPruneRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Embedding cleanup input is invalid", parsed.error.flatten());
    const actor = getActorInfo(req);
    const result = await dsService.pruneEmbeddingGenerations(companyId, id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    }, parsed.data.confirm, parsed.data.expectedGenerations);
    res.json({ success: true, data: result });
  });

  router.post("/companies/:companyId/data-sources/:id/ingestion-jobs/:jobId/cancel", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only a board operator can cancel datasource ingestion");
    const actor = getActorInfo(req);
    const job = await dsService.cancelIngestionJob(companyId, id, req.params.jobId as string, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    });
    res.status(202).json({ success: true, data: job });
  });

  // 4c. Queue a bounded keyset snapshot of an external database into ClickHouse.
  router.post("/companies/:companyId/data-sources/:id/snapshot", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only a board operator can start an external database snapshot");
    const parsed = dataSourceSnapshotRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message || "Invalid external snapshot request");
    const actor = getActorInfo(req);
    const result = await dsService.enqueueExternalDatabaseSnapshot(companyId, id, {
      mode: parsed.data.mode,
      tableIds: parsed.data.tableIds,
      tablePolicies: parsed.data.tablePolicies,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
    });
    res.status(202).json({ success: true, data: result });
  });

  // 4c. Reprocess all stuck/error data sources
  router.post("/companies/:companyId/data-sources/reprocess-stuck", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    const results = await dsService.reprocessStuck(companyId);
    res.status(202).json({ success: true, count: results.length, data: results });
  });

  // 5. Query structured table
  router.post(
    "/companies/:companyId/data-sources/:id/tables/:tableId/query",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      const tableId = req.params.tableId as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });

      const agentId = req.actor.type === "agent" ? req.actor.agentId : null;
      let authzFingerprint: string;
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        if (access.mode === "none") {
          throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke data source apa pun");
        }
        const allowedIds = access.effectiveDataSourceIds || access.dataSourceIds || [];
        if (access.mode === "selected" && !allowedIds.includes(id)) {
          throw forbidden(`Akses ditolak: Data source '${id}' tidak ditugaskan ke agen ini`);
        }
        authzFingerprint = makeDataSourceCacheKey([
          "structured-query-acl", "agent", agentId, access.mode,
          ...[...allowedIds].sort(), "collections", ...[...(access.collectionIds || [])].sort(),
        ]);
      } else if (req.actor.type === "board" && req.actor.userId) {
        const isCompanyAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId, req.actor.isInstanceAdmin);
        const hasSourceAccess = await rbac.canUserAccessDataSource(
          companyId,
          req.actor.userId,
          id,
          req.actor.isInstanceAdmin,
        );
        if (!hasSourceAccess) throw forbidden(`Akses ditolak: Data source '${id}' tidak ditugaskan ke pengguna ini`);
        const allowedIds = isCompanyAdmin
          ? ["*"]
          : await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
        authzFingerprint = makeDataSourceCacheKey([
          "structured-query-acl", "board", req.actor.userId, isCompanyAdmin ? "admin" : "member",
          ...[...allowedIds].sort(),
        ]);
      } else {
        authzFingerprint = makeDataSourceCacheKey(["structured-query-acl", req.actor.type, "company-operator"]);
      }

      const filter = req.body?.filter;
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const offset = req.body?.offset ? Number(req.body.offset) : undefined;
      const aggregate = req.body?.aggregate;
      const mode = req.body?.mode;
      if (mode !== undefined && mode !== "live" && mode !== "snapshot") {
        throw badRequest("mode must be either 'live' or 'snapshot'");
      }

      const clientRequest = requestAbortController(req, res);
      try {
        const result = await dsService.queryTable(companyId, tableId, {
          filter,
          limit,
          offset,
          aggregate,
          mode,
          authzFingerprint,
          signal: clientRequest.signal,
        });
        if (agentId) {
          const currentAccess = await dsService.getAgentDataSources(companyId, agentId);
          const currentAllowedIds = currentAccess.effectiveDataSourceIds || currentAccess.dataSourceIds || [];
          const currentFingerprint = makeDataSourceCacheKey([
            "structured-query-acl", "agent", agentId, currentAccess.mode,
            ...[...currentAllowedIds].sort(), "collections", ...[...(currentAccess.collectionIds || [])].sort(),
          ]);
          if (currentAccess.mode === "none"
            || (currentAccess.mode === "selected" && !currentAllowedIds.includes(id))
            || currentFingerprint !== authzFingerprint) {
            throw forbidden("Akses data source berubah saat query berlangsung; ulangi query setelah akses diperbarui.");
          }
        } else if (req.actor.type === "board" && req.actor.userId) {
          const stillHasSourceAccess = await rbac.canUserAccessDataSource(
            companyId, req.actor.userId, id, req.actor.isInstanceAdmin,
          );
          if (!stillHasSourceAccess) {
            throw forbidden("Akses data source berubah saat query berlangsung; ulangi query setelah akses diperbarui.");
          }
          const isCompanyAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId, req.actor.isInstanceAdmin);
          const allowedIds = isCompanyAdmin
            ? ["*"]
            : await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
          const currentFingerprint = makeDataSourceCacheKey([
            "structured-query-acl", "board", req.actor.userId, isCompanyAdmin ? "admin" : "member",
            ...[...allowedIds].sort(),
          ]);
          if (currentFingerprint !== authzFingerprint) {
            throw forbidden("Akses data source berubah saat query berlangsung; ulangi query setelah akses diperbarui.");
          }
        }
        if (!clientRequest.signal.aborted && !res.destroyed) res.json(result);
      } catch (err) {
        if (clientRequest.signal.aborted || isExternalQueryAbortError(err)) return;
        throw err;
      } finally {
        clientRequest.cleanup();
      }
    },
  );

  // 5b. Direct read-only SQL execution on external database
  router.post(
    "/companies/:companyId/data-sources/:id/query-sql",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const idOrName = req.params.id as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });

      const targetDs = await dsService.resolveDataSource(companyId, idOrName);
      if (!targetDs) {
        throw notFound(`Data source '${idOrName}' tidak ditemukan`);
      }
      const id = targetDs.id;

      const agentId = getRequestingAgentId(req);
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        if (access.mode === "none") {
          throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke database apa pun");
        }
        const allowedIds = access.effectiveDataSourceIds || access.dataSourceIds || [];
        if (access.mode === "selected" && !allowedIds.includes(id)) {
          throw forbidden(`Akses ditolak: Database '${idOrName}' tidak ditugaskan ke agen ini`);
        }
      }

      const sqlQuery = req.body?.sql as string;
      if (!sqlQuery || !sqlQuery.trim()) {
        throw badRequest("SQL query is required");
      }

      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const clientRequest = requestAbortController(req, res);
      try {
        const result = await dsService.querySql(companyId, id, sqlQuery, limit, clientRequest.signal);
        if (!clientRequest.signal.aborted && !res.destroyed) res.json(result);
      } catch (err: any) {
        if (clientRequest.signal.aborted || isExternalQueryAbortError(err)) return;
        throw badRequest(err.message || "SQL query execution failed");
      } finally {
        clientRequest.cleanup();
      }
    },
  );

  // 5d. Durable read-only query jobs for external databases.
  router.post(
    "/companies/:companyId/data-sources/:id/query-jobs",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const idOrName = req.params.id as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });
      const source = await dsService.resolveDataSource(companyId, idOrName);
      if (!source) throw notFound(`Data source '${idOrName}' tidak ditemukan`);
      await assertAgentCanUseDataSource(req, companyId, source.id);
      const parsedBody = dataSourceQueryJobRequestSchema.safeParse(req.body);
      if (!parsedBody.success) throw badRequest("Invalid durable query job request", parsedBody.error.issues);
      try {
        const job = await queryJobsService.enqueue({
          companyId,
          dataSourceId: source.id,
          ...parsedBody.data,
          actor: queryJobActor(req),
        });
        const location = `/api/companies/${companyId}/data-sources/${source.id}/query-jobs/${job.id}`;
        res.location(location).status(202).json({ success: true, data: job, resultUrl: `${location}/result` });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof Error) throw badRequest(error.message);
        throw error;
      }
    },
  );

  router.get(
    "/companies/:companyId/data-sources/:id/query-jobs/:jobId",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const idOrName = req.params.id as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });
      const source = await dsService.resolveDataSource(companyId, idOrName);
      if (!source) throw notFound(`Data source '${idOrName}' tidak ditemukan`);
      await assertAgentCanUseDataSource(req, companyId, source.id);
      const job = await queryJobsService.get(companyId, source.id, req.params.jobId as string);
      res.json({ success: true, data: job });
    },
  );

  router.get(
    "/companies/:companyId/data-sources/:id/query-jobs/:jobId/result",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const idOrName = req.params.id as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });
      const source = await dsService.resolveDataSource(companyId, idOrName);
      if (!source) throw notFound(`Data source '${idOrName}' tidak ditemukan`);
      await assertAgentCanUseDataSource(req, companyId, source.id);
      const result = await queryJobsService.getResult(companyId, source.id, req.params.jobId as string);
      res.json({ success: true, data: result });
    },
  );

  router.post(
    "/companies/:companyId/data-sources/:id/query-jobs/:jobId/cancel",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const idOrName = req.params.id as string;
      await assertCompanyAccess(req, companyId, { readOnly: true });
      const source = await dsService.resolveDataSource(companyId, idOrName);
      if (!source) throw notFound(`Data source '${idOrName}' tidak ditemukan`);
      await assertAgentCanUseDataSource(req, companyId, source.id);
      const job = await queryJobsService.cancel(companyId, source.id, req.params.jobId as string, queryJobActor(req));
      res.status(202).json({ success: true, data: job });
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
      await assertCompanyAccess(req, companyId, { readOnly: true });

      const sqlQuery = req.body?.sql as string;
      if (!sqlQuery || !sqlQuery.trim()) {
        throw badRequest("SQL query is required");
      }

      const agentId = getRequestingAgentId(req);
      let sqlToRun = sqlQuery;
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        if (access.mode === "none") {
          throw forbidden("Akses ditolak: Agen ini tidak memiliki izin akses ke data analitik apa pun");
        }
        if (access.mode === "selected") {
          const effectiveIds = access.effectiveDataSourceIds || access.dataSourceIds || [];
          if (effectiveIds.length === 0) {
            throw forbidden("Akses ditolak: Agen ini tidak memiliki data source yang ditugaskan");
          }

          // Fetch allowed tables for assigned data sources
          const allowedTablesResult = await db
            .select({ id: dataSourceTables.id, tableName: dataSourceTables.tableName, semanticModel: dataSourceTables.semanticModel })
            .from(dataSourceTables)
            .where(
              and(
                eq(dataSourceTables.companyId, companyId),
                inArray(dataSourceTables.dataSourceId, effectiveIds),
              ),
            );

          const aliasTargets = new Map<string, Set<string>>();
          const addTableAlias = (alias: string, physicalName: string) => {
            const normalizedAlias = alias.trim().toLowerCase();
            if (!normalizedAlias) return;
            const targets = aliasTargets.get(normalizedAlias) ?? new Set<string>();
            targets.add(physicalName);
            aliasTargets.set(normalizedAlias, targets);
          };
          for (const t of allowedTablesResult) {
            const identity = (t.semanticModel as any)?.clickhouseTable || clickhouseSourceTableName(t.id, t.tableName);
            const sanitizedName = t.tableName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
            addTableAlias(t.tableName, String(identity));
            addTableAlias(sanitizedName, String(identity));
            addTableAlias(`ds_${sanitizedName}`, String(identity));
            addTableAlias(String(identity), String(identity));
          }

          // Also allow collection unified ClickHouse views
          if (access.collectionIds && access.collectionIds.length > 0) {
            const collections = await db
              .select({ semanticProfile: dataSourceCollections.semanticProfile })
              .from(dataSourceCollections)
              .where(
                and(
                  eq(dataSourceCollections.companyId, companyId),
                  inArray(dataSourceCollections.id, access.collectionIds),
                ),
              );
            for (const col of collections) {
              const views = (col.semanticProfile as any)?.unifiedClickhouseViews || [];
              for (const v of views) {
                if (v.viewName && v.deploymentStatus === "deployed") {
                  addTableAlias(v.viewName, v.viewName);
                }
              }
            }
          }
          const tableNameAliases = new Map<string, string>();
          for (const [alias, targets] of aliasTargets) {
            // Identical logical labels can exist in separate sources. Only
            // resolve an alias automatically when it identifies one table.
            if (targets.size === 1) tableNameAliases.set(alias, [...targets][0]!);
          }
          const allowedTableNames = new Set(tableNameAliases.keys());

          function stripSqlCommentsAndStrings(sql: string): string {
            let result = "";
            let i = 0;
            const len = sql.length;
            while (i < len) {
              if (sql[i] === "-" && sql[i + 1] === "-") {
                while (i < len && sql[i] !== "\n") i++;
                result += " ";
              } else if (sql[i] === "/" && sql[i + 1] === "*") {
                i += 2;
                while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
                i += 2;
                result += " ";
              } else if (sql[i] === "'") {
                i++;
                while (i < len) {
                  if (sql[i] === "'" && sql[i + 1] === "'") {
                    i += 2;
                  } else if (sql[i] === "'") {
                    i++;
                    break;
                  } else if (sql[i] === "\\") {
                    i += 2;
                  } else {
                    i++;
                  }
                }
                result += " 'str' ";
              } else {
                result += sql[i];
                i++;
              }
            }
            return result;
          }

          const cleanSql = stripSqlCommentsAndStrings(sqlQuery);

          const reservedKeywords = new Set([
            "select", "from", "where", "group", "order", "by", "limit", "offset", "having",
            "union", "join", "inner", "left", "right", "full", "cross", "outer", "on", "as",
            "and", "or", "not", "case", "when", "then", "else", "end", "window", "qualify",
          ]);

          // Extract CTE names defined in WITH clauses (e.g. "WITH aggregation AS (...)")
          const cteNames = new Set<string>();
          const withMatches = Array.from(
            cleanSql.matchAll(/(?:with|,)\s*[`"']?([a-zA-Z0-9_]+)[`"']?\s+as\s*\(/gi),
          );
          for (const m of withMatches) {
            const name = m[1].toLowerCase();
            if (!reservedKeywords.has(name)) {
              cteNames.add(name);
            }
          }

          // Extract subquery aliases from FROM or JOIN (e.g. "FROM (...) AS subq")
          const fromSubqueryMatches = Array.from(
            cleanSql.matchAll(/\)\s*(?:as\s+)?([a-zA-Z0-9_]+)/gi),
          );
          for (const m of fromSubqueryMatches) {
            const name = m[1].toLowerCase();
            if (!reservedKeywords.has(name)) {
              cteNames.add(name);
            }
          }

          const builtInClickhouseNames = new Set([
            "system",
            "tables",
            "columns",
            "databases",
            "parts",
            "parts_columns",
            "query_log",
            "settings",
            "functions",
            "metrics",
            "events",
            "asynchronous_metrics",
            "numbers",
            "numbers_mt",
            "zeros",
            "zeros_mt",
            "view",
            "null",
          ]);

          // Extract table names referenced in FROM or JOIN clauses (ignoring database prefix if present, e.g. "FROM default.tbl" -> tbl)
          const rawTableMatches = Array.from(
            cleanSql.matchAll(/(?:from|join)\s+[`"']?([a-zA-Z0-9_]+)[`"']?(?:\.[`"']?([a-zA-Z0-9_]+)[`"']?)?/gi),
          );

          for (const m of rawTableMatches) {
            const dbPrefix = m[2] ? m[1].toLowerCase() : null;
            const tbl = (m[2] || m[1]).toLowerCase();

            if (reservedKeywords.has(tbl)) continue;
            // System and information_schema introspection is read-only and always permitted
            if (dbPrefix === "system" || dbPrefix === "information_schema") continue;
            if (dbPrefix && dbPrefix !== clickhouse.getCompanyDatabase(companyId).toLowerCase()) {
              throw forbidden(`Akses ditolak: Database '${dbPrefix}' bukan milik company ini`);
            }
            if (builtInClickhouseNames.has(tbl)) continue;
            if (cteNames.has(tbl)) continue;
            if (!allowedTableNames.has(tbl)) {
              throw forbidden(`Akses ditolak: Tabel '${tbl}' tidak termasuk dalam data source yang ditugaskan ke agen ini`);
            }
          }
          sqlToRun = rewriteClickhouseTableReferences(sqlQuery, tableNameAliases, cteNames);
        }
      }

      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      try {
        const result = await dsService.queryClickhouse(companyId, sqlToRun, limit);
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
    await assertCompanyAccess(req, companyId, { readOnly: true });

    const query = req.body?.query as string;
    if (!query || !query.trim()) {
      throw badRequest("Search query is required");
    }

    const dataSourceId = req.body?.dataSourceId as string | undefined;
    let dataSourceIds = Array.isArray(req.body?.dataSourceIds) ? req.body.dataSourceIds : undefined;
    const collectionId = (req.body?.collectionId as string | undefined) || (req.body?.collection as string | undefined);
    const agentId = req.actor.type === "agent" ? req.actor.agentId : null;
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;
    let authzFingerprint: string;

    if (agentId) {
      const access = await dsService.getAgentDataSources(companyId, agentId);
      const allowedIds = access.effectiveDataSourceIds || [];
      if (access.mode === "none" || (access.mode === "selected" && allowedIds.length === 0)) {
        return res.json([]);
      }
      if (dataSourceId && !allowedIds.includes(dataSourceId)) {
        throw forbidden(`Akses ditolak: Data source '${dataSourceId}' tidak ditugaskan ke agen ini`);
      }
      if (dataSourceIds) dataSourceIds = dataSourceIds.filter((id: string) => allowedIds.includes(id));
      authzFingerprint = makeDataSourceCacheKey([
        "rag-acl", "agent", agentId, access.mode,
        ...[...allowedIds].sort(), "collections", ...[...(access.collectionIds || [])].sort(),
      ]);
    } else if (req.actor.type === "board" && req.actor.userId) {
      const isCompanyAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId, req.actor.isInstanceAdmin);
      const allowedIds = isCompanyAdmin
        ? null
        : await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
      if (allowedIds) {
        if (dataSourceId && !allowedIds.includes(dataSourceId)) {
          throw forbidden(`Akses ditolak: Data source '${dataSourceId}' tidak ditugaskan ke pengguna ini`);
        }
        if (dataSourceIds) dataSourceIds = dataSourceIds.filter((id: string) => allowedIds.includes(id));
        else dataSourceIds = allowedIds;
        if (dataSourceIds.length === 0) return res.json([]);
      }
      authzFingerprint = makeDataSourceCacheKey([
        "rag-acl", "board", req.actor.userId, isCompanyAdmin ? "admin" : "member",
        ...(allowedIds ? [...allowedIds].sort() : ["all-company-sources"]),
      ]);
    } else {
      authzFingerprint = makeDataSourceCacheKey(["rag-acl", req.actor.type, "company-operator"]);
    }

    const results = await dsService.searchKnowledge(companyId, query, {
      dataSourceId,
      dataSourceIds,
      collectionId,
      agentId: agentId || undefined,
      authzFingerprint,
      limit,
    });

    if (agentId) {
      const currentAccess = await dsService.getAgentDataSources(companyId, agentId);
      const currentAllowedIds = currentAccess.effectiveDataSourceIds || [];
      const currentFingerprint = makeDataSourceCacheKey([
        "rag-acl", "agent", agentId, currentAccess.mode,
        ...[...currentAllowedIds].sort(), "collections", ...[...(currentAccess.collectionIds || [])].sort(),
      ]);
      if (currentAccess.mode === "none"
        || (dataSourceId && currentAccess.mode === "selected" && !currentAllowedIds.includes(dataSourceId))
        || currentFingerprint !== authzFingerprint) {
        throw forbidden("Akses knowledge source berubah saat retrieval berlangsung; ulangi setelah akses diperbarui.");
      }
    } else if (req.actor.type === "board" && req.actor.userId) {
      const isCompanyAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId, req.actor.isInstanceAdmin);
      const allowedIds = isCompanyAdmin
        ? null
        : await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
      if (dataSourceId && allowedIds && !allowedIds.includes(dataSourceId)) {
        throw forbidden("Akses knowledge source berubah saat retrieval berlangsung; ulangi setelah akses diperbarui.");
      }
      const currentFingerprint = makeDataSourceCacheKey([
        "rag-acl", "board", req.actor.userId, isCompanyAdmin ? "admin" : "member",
        ...(allowedIds ? [...allowedIds].sort() : ["all-company-sources"]),
      ]);
      if (currentFingerprint !== authzFingerprint) {
        throw forbidden("Akses knowledge source berubah saat retrieval berlangsung; ulangi setelah akses diperbarui.");
      }
    }

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
    const collectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds : [];
    const result = await dsService.updateAgentDataSources(companyId, agentId, {
      mode,
      dataSourceIds,
      collectionIds,
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
    const collectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds : [];
    const result = await dsService.updateAgentDataSources(agent.companyId, agentId, {
      mode,
      dataSourceIds,
      collectionIds,
    });
    res.json(result);
  });

  // --- Data Source Collections Routes ---

  // List all collections for company
  router.get("/companies/:companyId/data-source-collections", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const collections = await collectionsService.list(companyId);
    res.json(collections);
  });

  // Create a new collection
  router.post("/companies/:companyId/data-source-collections", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCanManageDataSources(req, companyId);
    const { name, description, color, icon } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      throw badRequest("Collection name is required");
    }
    const collection = await collectionsService.create(companyId, {
      name: name.trim(),
      description,
      color,
      icon,
    });
    res.status(201).json(collection);
  });

  // Get a collection by ID or slug
  router.get("/companies/:companyId/data-source-collections/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(req, companyId);

    let collection = await collectionsService.getById(companyId, id);
    if (!collection) {
      collection = await collectionsService.getBySlug(companyId, id);
    }
    if (!collection) throw notFound("Collection not found");
    res.json(collection);
  });

  // Update collection metadata
  router.patch("/companies/:companyId/data-source-collections/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const { name, description, color, icon } = req.body || {};
    const updated = await collectionsService.update(companyId, id, {
      name,
      description,
      color,
      icon,
    });
    if (!updated) throw notFound("Collection not found");
    res.json(updated);
  });

  // Delete collection
  router.delete("/companies/:companyId/data-source-collections/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const success = await collectionsService.delete(companyId, id);
    if (!success) throw notFound("Collection not found");
    res.json({ success: true });
  });

  // Re-correlate collection (cross-table FKs, cross-document topics, clickhouse views)
  router.post("/companies/:companyId/data-source-collections/:id/correlate", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const profile = await collectionsService.correlateCollection(companyId, id);
    res.json(profile);
  });

  // Add existing data sources into collection
  router.post("/companies/:companyId/data-source-collections/:id/add-sources", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const { dataSourceIds } = req.body || {};
    if (!Array.isArray(dataSourceIds) || dataSourceIds.length === 0) {
      throw badRequest("dataSourceIds array is required");
    }
    await collectionsService.addSourcesToCollection(companyId, id, dataSourceIds);
    const updated = await collectionsService.getById(companyId, id);
    res.json(updated);
  });

  // Remove a data source from collection
  router.post("/companies/:companyId/data-source-collections/:id/remove-source", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanManageDataSources(req, companyId);
    const { dataSourceId } = req.body || {};
    if (!dataSourceId || typeof dataSourceId !== "string") {
      throw badRequest("dataSourceId string is required");
    }
    await collectionsService.removeSourceFromCollection(companyId, id, dataSourceId);
    const updated = await collectionsService.getById(companyId, id);
    res.json(updated);
  });

  // Upload file(s) or ZIP directly into a collection
  router.post(
    "/companies/:companyId/data-source-collections/:id/upload",
    async (req, _res, next) => {
      await assertCanManageDataSources(req, req.params.companyId as string);
      next();
    },
    upload.any(),
    cleanupUploadedRequestFiles,
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      const collectionId = req.params.id as string;

      const collection = await collectionsService.getById(companyId, collectionId);
      if (!collection) throw notFound("Collection not found");

      const files: Express.Multer.File[] = [];
      if (req.file) files.push(req.file);
      if (Array.isArray(req.files)) files.push(...req.files);
      else if (req.files && typeof req.files === "object") {
        for (const list of Object.values(req.files)) {
          if (Array.isArray(list)) files.push(...list);
        }
      }

      if (files.length === 0) throw badRequest("No file provided in request");

      const description = req.body?.description as string | undefined;
      const results = [];

      for (const file of files) {
        const isZip =
          file.mimetype === "application/zip" ||
          file.mimetype === "application/x-zip-compressed" ||
          file.originalname.toLowerCase().endsWith(".zip");

        if (isZip) {
          const extracted = await collectionsService.extractZipEntries({ filePath: file.path });
          try {
            for (const item of extracted.entries) {
              const result = await onboardingOrchestrator.onboardSource(
                companyId,
                {
                  filePath: item.filePath,
                  originalname: item.originalname,
                  mimetype: item.mimetype,
                  size: item.size,
                },
                {
                  description,
                  collectionId,
                  async: true,
                },
              );
              results.push(result);
            }
          } finally {
            fs.rmSync(extracted.directory, { recursive: true, force: true });
          }
        } else {
          const result = await onboardingOrchestrator.onboardSource(
            companyId,
            {
              filePath: file.path,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
            },
            {
              description,
              collectionId,
              async: true,
            },
          );
          results.push(result);
        }
      }

      res.status(202).json({
        collectionId,
        count: results.length,
        dataSources: results,
        message: `${results.length} file(s) queued for onboarding into collection ${collection.name}`,
      });
    },
  );

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

      let dataSourceIds: string[] | undefined;
      let authzFingerprint: string;
      const agentId = req.actor.type === "agent" ? req.actor.agentId : null;
      if (agentId) {
        const access = await dsService.getAgentDataSources(companyId, agentId);
        dataSourceIds = access.mode === "none" ? [] : access.effectiveDataSourceIds || [];
        authzFingerprint = makeDataSourceCacheKey([
          "orchestrator-acl", "agent", agentId, access.mode, ...[...dataSourceIds].sort(),
        ]);
      } else if (req.actor.type === "board" && req.actor.userId) {
        const isCompanyAdmin = await rbac.isOwnerOrAdmin(companyId, req.actor.userId, req.actor.isInstanceAdmin);
        dataSourceIds = isCompanyAdmin ? undefined : await rbac.getAllowedDataSourcesForUser(companyId, req.actor.userId);
        authzFingerprint = makeDataSourceCacheKey([
          "orchestrator-acl", "board", req.actor.userId, isCompanyAdmin ? "admin" : "member",
          ...(dataSourceIds ? [...dataSourceIds].sort() : ["all-company-sources"]),
        ]);
      } else {
        authzFingerprint = makeDataSourceCacheKey(["orchestrator-acl", req.actor.type, "company-operator"]);
      }

      const responseMessage = await orchestrator.chat(companyId, sessionId, query, { dataSourceIds, authzFingerprint });
      res.json(responseMessage);
    },
  );

  return router;
}
