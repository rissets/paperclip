import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, dataSourceCollections, dataSourceJobs, dataSources, dataSourceUploadSessions } from "@paperclipai/db";
import type { DataSourceUploadSession, DataSourceUploadSessionStatus, DataSourceType } from "@paperclipai/shared";
import { abortDataSourceMultipartUpload, completeDataSourceMultipartUpload, createDataSourceMultipartUpload, deleteDataSourceFile, isDataSourceObjectStorageEnabled, readDataSourceObjectHead, uploadDataSourceMultipartPart, verifyDataSourceObjectManifest } from "./data-source-object-storage.js";
import { badRequest, conflict, notFound, payloadTooLarge, unprocessable } from "../errors.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const PART_SIZE = 16 * MiB;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["starting", "uploading", "completing", "verifying"] as const;
const DEFAULT_MAX_COMPANY_FILE_BYTES = 100 * GiB;

type UploadActor = { type: "user" | "agent"; id: string; agentId?: string | null; runId?: string | null };
type SessionRow = typeof dataSourceUploadSessions.$inferSelect;

function maxCompanyFileStorageBytes(): number {
  const raw = process.env.DATASOURCE_MAX_COMPANY_FILE_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_COMPANY_FILE_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("DATASOURCE_MAX_COMPANY_FILE_BYTES must be a non-negative safe integer");
  return parsed;
}

function maxFileBytes(fileName: string): number {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "csv" || ext === "tsv") {
    const raw = Number(process.env.DATASOURCE_MAX_CSV_UPLOAD_BYTES || GiB);
    if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error("DATASOURCE_MAX_CSV_UPLOAD_BYTES must be a positive safe integer");
    return Math.min(raw, 2 * GiB);
  }
  const raw = Number(process.env.DATASOURCE_MAX_FILE_UPLOAD_BYTES || 100 * MiB);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error("DATASOURCE_MAX_FILE_UPLOAD_BYTES must be a positive safe integer");
  return Math.min(raw, 100 * MiB);
}

function classifyFile(fileName: string): { sourceType: DataSourceType; extension: string } {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  if (extension === "csv" || extension === "tsv") return { sourceType: "csv", extension };
  if (extension === "xlsx" || extension === "xls") return { sourceType: "excel", extension };
  return { sourceType: "rag_document", extension };
}

function publicSession(session: SessionRow): DataSourceUploadSession {
  const parts = Array.isArray(session.parts) ? session.parts : [];
  return {
    id: session.id,
    companyId: session.companyId,
    fileName: session.fileName,
    expectedBytes: session.expectedBytes,
    partSize: session.partSize,
    partCount: Math.ceil(session.expectedBytes / session.partSize),
    uploadedParts: parts.map(({ partNumber, byteSize, sha256 }) => ({ partNumber, byteSize, sha256 })),
    status: session.status as DataSourceUploadSessionStatus,
    expiresAt: session.expiresAt.toISOString(),
    dataSourceId: session.dataSourceId,
  };
}

async function getReservedBytes(tx: Db, companyId: string, excludeSessionId?: string): Promise<number> {
  const result = await tx.execute(sql<{ usedBytes: string }>`
    SELECT (
      COALESCE((SELECT sum(file_size) FROM data_sources WHERE company_id = ${companyId}::uuid AND storage_path IS NOT NULL), 0)
      + COALESCE((SELECT sum(expected_bytes) FROM data_source_upload_sessions
          WHERE company_id = ${companyId}::uuid AND status IN ('starting','uploading','completing','verifying')
            AND (${excludeSessionId ?? null}::uuid IS NULL OR id <> ${excludeSessionId ?? null}::uuid)), 0)
    )::text AS "usedBytes"
  `);
  return Number(Array.from(result as Iterable<{ usedBytes: string }>)[0]?.usedBytes || 0);
}

export class DataSourceUploadSessionsService {
  constructor(private readonly db: Db) {}

  async create(input: {
    companyId: string;
    fileName: string;
    contentType: string;
    expectedBytes: number;
    name?: string;
    description?: string;
    collectionId?: string;
    actor: UploadActor;
  }): Promise<DataSourceUploadSession> {
    if (!isDataSourceObjectStorageEnabled()) {
      throw unprocessable("Resumable datasource uploads are unavailable because S3-compatible object storage is not configured");
    }
    const fileName = input.fileName.trim();
    const contentType = input.contentType.trim().slice(0, 255) || "application/octet-stream";
    if (!fileName || fileName.length > 512) throw badRequest("A filename between 1 and 512 characters is required");
    if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0) throw badRequest("expectedBytes must be a positive safe integer");
    if (input.expectedBytes > maxFileBytes(fileName)) {
      throw payloadTooLarge(`This file exceeds the ${Math.floor(maxFileBytes(fileName) / MiB)} MiB upload limit`);
    }

    const sessionId = randomUUID();
    const multipart = await createDataSourceMultipartUpload({
      companyId: input.companyId,
      sessionId,
      fileName,
      contentType,
    });
    try {
      const session = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'datasource-file-quota:' + input.companyId}, 0))`);
        if (input.collectionId) {
          const [collection] = await tx.select({ id: dataSourceCollections.id }).from(dataSourceCollections).where(and(
            eq(dataSourceCollections.id, input.collectionId), eq(dataSourceCollections.companyId, input.companyId),
          )).limit(1);
          if (!collection) throw notFound("Collection not found");
        }
        const usedBytes = await getReservedBytes(tx as unknown as Db, input.companyId);
        const maxBytes = maxCompanyFileStorageBytes();
        if (usedBytes + input.expectedBytes > maxBytes) {
          throw payloadTooLarge(`This company has reached its datasource file storage limit (${usedBytes} of ${maxBytes} bytes used)`, {
            usedBytes, requestedBytes: input.expectedBytes, maxBytes,
          });
        }
        const [created] = await tx.insert(dataSourceUploadSessions).values({
          id: sessionId,
          companyId: input.companyId,
          collectionId: input.collectionId || null,
          fileName,
          sourceName: input.name?.trim() || null,
          description: input.description?.trim() || null,
          contentType,
          expectedBytes: input.expectedBytes,
          objectKey: multipart.objectKey,
          storageUploadId: multipart.uploadId,
          partSize: PART_SIZE,
          status: "uploading",
          actorType: input.actor.type,
          actorId: input.actor.id,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        }).returning();
        await tx.insert(activityLog).values({
          companyId: input.companyId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: "data_source.upload.started",
          entityType: "data_source_upload_session",
          entityId: sessionId,
          agentId: input.actor.agentId || null,
          runId: input.actor.runId || null,
          details: { fileName, expectedBytes: input.expectedBytes, partSize: PART_SIZE },
        });
        return created;
      });
      return publicSession(session);
    } catch (error) {
      await abortDataSourceMultipartUpload({ companyId: input.companyId, ...multipart }).catch(() => {});
      throw error;
    }
  }

  async get(companyId: string, id: string): Promise<DataSourceUploadSession> {
    const [session] = await this.db.select().from(dataSourceUploadSessions).where(and(
      eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
    )).limit(1);
    if (!session) throw notFound("Datasource upload session not found");
    return publicSession(session);
  }

  async uploadPart(companyId: string, id: string, partNumber: number, body: Buffer): Promise<DataSourceUploadSession> {
    if (!Number.isSafeInteger(partNumber) || partNumber < 1) throw badRequest("partNumber must be a positive integer");
    if (!Buffer.isBuffer(body)) throw badRequest("Upload part must be a binary request body");
    const partSha256 = createHash("sha256").update(body).digest("hex");
    return this.db.transaction(async (tx) => {
      // Serialize retries for one S3 part number across API processes without
      // serializing distinct chunks of the same upload.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'datasource-upload-part:' + id + ':' + partNumber}, 0))`);
      const [session] = await tx.select().from(dataSourceUploadSessions).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).limit(1);
      if (!session) throw notFound("Datasource upload session not found");
      if (session.status !== "uploading" || !session.storageUploadId) throw conflict(`Upload session is ${session.status}`);
      if (session.expiresAt.getTime() <= Date.now()) throw conflict("Datasource upload session has expired");
      const partCount = Math.ceil(session.expectedBytes / session.partSize);
      if (partNumber > partCount) throw badRequest("partNumber exceeds this upload session's part count");
      const expectedLength = Math.min(session.partSize, session.expectedBytes - (partNumber - 1) * session.partSize);
      if (body.length !== expectedLength) throw badRequest(`Upload part ${partNumber} must contain exactly ${expectedLength} bytes`);
      const prior = session.parts.find((part) => part.partNumber === partNumber);
      if (prior) {
        if (prior.sha256 !== partSha256) throw conflict(`Upload part ${partNumber} was already stored with different bytes`);
        return publicSession(session);
      }
      const receipt = await uploadDataSourceMultipartPart({
        companyId, objectKey: session.objectKey, uploadId: session.storageUploadId, partNumber, body,
      });
      const [current] = await tx.select().from(dataSourceUploadSessions).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).limit(1).for("update");
      if (!current) throw notFound("Datasource upload session not found");
      if (current.status !== "uploading" || current.expiresAt.getTime() <= Date.now()) throw conflict(`Upload session is ${current.status}`);
      const parts = Array.isArray(current.parts) ? [...current.parts] : [];
      const concurrentReceipt = parts.find((part) => part.partNumber === partNumber);
      if (concurrentReceipt && concurrentReceipt.sha256 !== partSha256) {
        throw conflict(`Upload part ${partNumber} was concurrently stored with different bytes`);
      }
      const next = { partNumber, byteSize: body.length, sha256: partSha256, etag: receipt.etag };
      if (concurrentReceipt) {
        const priorIndex = parts.findIndex((part) => part.partNumber === partNumber);
        parts[priorIndex] = next;
      } else parts.push(next);
      parts.sort((a, b) => a.partNumber - b.partNumber);
      const [updated] = await tx.update(dataSourceUploadSessions).set({ parts, updatedAt: new Date() }).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "uploading"),
      )).returning();
      return publicSession(updated);
    });
  }

  async complete(companyId: string, id: string, partSha256s: string[]): Promise<{ session: DataSourceUploadSession; dataSourceId: string }> {
    const [initial] = await this.db.select().from(dataSourceUploadSessions).where(and(
      eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
    )).limit(1);
    if (!initial) throw notFound("Datasource upload session not found");
    const assertPartManifest = (session: SessionRow) => {
      const parts = Array.isArray(session.parts) ? session.parts : [];
      if (partSha256s.length !== Math.ceil(session.expectedBytes / session.partSize) || parts.length !== partSha256s.length) {
        throw conflict("Upload part manifest is incomplete");
      }
      if (parts.some((part, index) => part.partNumber !== index + 1 || part.sha256 !== partSha256s[index])) {
        throw conflict("Selected file contents differ from the bytes saved in this upload session");
      }
    };
    if (initial.status === "completed" && initial.dataSourceId) {
      assertPartManifest(initial);
      return { session: publicSession(initial), dataSourceId: initial.dataSourceId };
    }

    let session = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(dataSourceUploadSessions).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).limit(1).for("update");
      if (!current) throw notFound("Datasource upload session not found");
      if (current.status === "completed" && current.dataSourceId) {
        assertPartManifest(current);
        return current;
      }
      if (!["uploading", "completing", "verifying"].includes(current.status)) throw conflict(`Upload session is ${current.status}`);
      if (current.status === "uploading") {
        if (current.expiresAt.getTime() <= Date.now()) throw conflict("Datasource upload session has expired");
        const partCount = Math.ceil(current.expectedBytes / current.partSize);
        const parts = Array.isArray(current.parts) ? current.parts : [];
        if (parts.length !== partCount || parts.some((part, index) => part.partNumber !== index + 1)) {
          throw conflict("Upload is incomplete; every part must be received before completion");
        }
        assertPartManifest(current);
        const receivedBytes = parts.reduce((sum, part) => sum + part.byteSize, 0);
        if (receivedBytes !== current.expectedBytes) throw conflict("Uploaded parts do not match the declared file size");
        const [updated] = await tx.update(dataSourceUploadSessions).set({ status: "completing", updatedAt: new Date() }).where(and(
          eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "uploading"),
        )).returning();
        return updated;
      }
      assertPartManifest(current);
      return current;
    });
    if (session.status === "completed" && session.dataSourceId) return { session: publicSession(session), dataSourceId: session.dataSourceId };

    if (session.status === "completing") {
      try {
        await completeDataSourceMultipartUpload({
          companyId,
          objectKey: session.objectKey,
          uploadId: session.storageUploadId!,
          parts: session.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
        });
      } catch (error) {
        const [head] = await this.db.select({ objectKey: dataSourceUploadSessions.objectKey }).from(dataSourceUploadSessions).where(and(
          eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
        )).limit(1);
        if (!head) throw error;
        const object = await readDataSourceObjectHead(companyId, head.objectKey).catch(() => null);
        if (!object?.exists || object.contentLength !== session.expectedBytes) {
          await this.db.update(dataSourceUploadSessions).set({ status: "uploading", updatedAt: new Date() }).where(and(
            eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "completing"),
          ));
          throw error;
        }
      }
      const [updated] = await this.db.update(dataSourceUploadSessions).set({ status: "verifying", storageUploadId: null, updatedAt: new Date() }).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "completing"),
      )).returning();
      session = updated || session;
    }

    const sha256 = await verifyDataSourceObjectManifest({
      companyId, objectKey: session.objectKey, byteSize: session.expectedBytes,
      ...(session.expectedSha256 ? { sha256: session.expectedSha256 } : {}),
    });
    if (!session.expectedSha256) {
      const [updated] = await this.db.update(dataSourceUploadSessions).set({ expectedSha256: sha256, status: "verifying", updatedAt: new Date() }).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "verifying"),
      )).returning();
      if (updated) session = updated;
    }

    const result = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(dataSourceUploadSessions).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).limit(1).for("update");
      if (!current) throw notFound("Datasource upload session not found");
      if (current.status === "completed" && current.dataSourceId) return { dataSourceId: current.dataSourceId, session: current };
      if (current.status !== "verifying" || current.expectedSha256 !== sha256) throw conflict("Upload session changed while its object was being verified");

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'datasource-file-quota:' + companyId}, 0))`);
      const usedBytes = await getReservedBytes(tx as unknown as Db, companyId, id);
      const maxBytes = maxCompanyFileStorageBytes();
      if (usedBytes + current.expectedBytes > maxBytes) {
        throw payloadTooLarge(`This company has reached its datasource file storage limit (${usedBytes} of ${maxBytes} bytes used)`, {
          usedBytes, requestedBytes: current.expectedBytes, maxBytes,
        });
      }
      if (current.collectionId) {
        const [collection] = await tx.select({ id: dataSourceCollections.id }).from(dataSourceCollections).where(and(
          eq(dataSourceCollections.id, current.collectionId), eq(dataSourceCollections.companyId, companyId),
        )).limit(1);
        if (!collection) throw notFound("Collection not found");
      }
      const { sourceType, extension } = classifyFile(current.fileName);
      const name = current.sourceName?.trim() || current.fileName.replace(/\.[^/.]+$/, "");
      const now = new Date();
      const [source] = await tx.insert(dataSources).values({
        companyId,
        collectionId: current.collectionId,
        name,
        description: current.description || `Ingested from ${current.fileName}`,
        sourceType,
        status: "processing",
        fileName: current.fileName,
        fileSize: current.expectedBytes,
        mimeType: current.contentType,
        storagePath: current.objectKey,
        metadata: { startedAt: now.toISOString(), extension, storageBackend: "s3", storageSha256: sha256, uploadSessionId: id },
        createdAt: now,
        updatedAt: now,
      }).returning();
      const [job] = await tx.insert(dataSourceJobs).values({
        companyId,
        dataSourceId: source.id,
        jobType: "ingest_file",
        status: "queued",
        stage: "queued",
        idempotencyKey: `file-ingest:${source.id}`,
      }).returning();
      const [completed] = await tx.update(dataSourceUploadSessions).set({
        dataSourceId: source.id,
        expectedSha256: sha256,
        status: "completed",
        completedAt: now,
        updatedAt: now,
      }).where(and(eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId), eq(dataSourceUploadSessions.status, "verifying"))).returning();
      if (!completed) throw conflict("Upload session changed before the ingestion job was queued");
      await tx.insert(activityLog).values({
        companyId,
        actorType: current.actorType,
        actorId: current.actorId,
        action: "data_source.upload.completed",
        entityType: "data_source",
        entityId: source.id,
        details: { uploadSessionId: id, jobId: job.id, expectedBytes: current.expectedBytes, sha256 },
      });
      return { dataSourceId: source.id, session: completed };
    });
    return { session: publicSession(result.session), dataSourceId: result.dataSourceId };
  }

  async abort(companyId: string, id: string, actor: UploadActor): Promise<DataSourceUploadSession> {
    const session = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(dataSourceUploadSessions).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).limit(1).for("update");
      if (!current) throw notFound("Datasource upload session not found");
      if (current.status === "aborted") return current;
      if (!["starting", "uploading"].includes(current.status)) throw conflict(`Cannot abort an upload session in ${current.status} state`);
      if (current.storageUploadId) {
        await abortDataSourceMultipartUpload({ companyId, objectKey: current.objectKey, uploadId: current.storageUploadId });
      }
      const [updated] = await tx.update(dataSourceUploadSessions).set({ status: "aborted", storageUploadId: null, updatedAt: new Date() }).where(and(
        eq(dataSourceUploadSessions.id, id), eq(dataSourceUploadSessions.companyId, companyId),
      )).returning();
      await tx.insert(activityLog).values({
        companyId, actorType: actor.type, actorId: actor.id, action: "data_source.upload.aborted",
        entityType: "data_source_upload_session", entityId: id,
      });
      return updated;
    });
    return publicSession(session);
  }

  async expire(limit = 50): Promise<number> {
    const candidates = await this.db.select().from(dataSourceUploadSessions).where(and(
      sql`(${dataSourceUploadSessions.status} IN ('starting','uploading','completing','verifying') AND ${dataSourceUploadSessions.expiresAt} <= now())
        OR ${dataSourceUploadSessions.status} = 'cleanup_pending'
        OR (${dataSourceUploadSessions.status} = 'expired' AND ${dataSourceUploadSessions.storageUploadId} IS NOT NULL)`,
    )).limit(Math.min(Math.max(1, limit), 250));
    let expired = 0;
    for (const session of candidates) {
      const [claimed] = await this.db.update(dataSourceUploadSessions).set({
        status: sql`CASE WHEN ${dataSourceUploadSessions.status} IN ('completing','verifying') THEN 'cleanup_pending' ELSE ${dataSourceUploadSessions.status} END`,
        updatedAt: new Date(),
      }).where(and(
        eq(dataSourceUploadSessions.id, session.id), eq(dataSourceUploadSessions.companyId, session.companyId),
        sql`((${dataSourceUploadSessions.status} IN ('starting','uploading','completing','verifying') AND ${dataSourceUploadSessions.expiresAt} <= now())
          OR ${dataSourceUploadSessions.status} = 'cleanup_pending'
          OR (${dataSourceUploadSessions.status} = 'expired' AND ${dataSourceUploadSessions.storageUploadId} IS NOT NULL))`,
      )).returning();
      if (!claimed) continue;
      if (["completing", "verifying", "cleanup_pending"].includes(session.status)) {
        await deleteDataSourceFile(session.companyId, session.objectKey).then(async () => {
          await this.db.update(dataSourceUploadSessions).set({ status: "expired", storageUploadId: null, updatedAt: new Date() }).where(eq(dataSourceUploadSessions.id, session.id));
        }).catch(() => {});
      } else if (session.storageUploadId) {
        await abortDataSourceMultipartUpload({ companyId: session.companyId, objectKey: session.objectKey, uploadId: session.storageUploadId }).then(async () => {
          await this.db.update(dataSourceUploadSessions).set({ storageUploadId: null, updatedAt: new Date() }).where(eq(dataSourceUploadSessions.id, session.id));
        }).catch(() => {});
      }
      expired++;
    }
    return expired;
  }
}
