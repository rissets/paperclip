import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { activityLog, companies, createDb, dataSourceJobs, dataSourceUploadSessions, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { dataSourceRoutes } from "../routes/data-sources.js";

const storage = vi.hoisted(() => ({
  create: vi.fn(),
  part: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  verify: vi.fn(),
  head: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../services/data-source-object-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/data-source-object-storage.js")>();
  return {
    ...actual,
    createDataSourceMultipartUpload: storage.create,
    uploadDataSourceMultipartPart: storage.part,
    completeDataSourceMultipartUpload: storage.complete,
    abortDataSourceMultipartUpload: storage.abort,
    verifyDataSourceObjectManifest: storage.verify,
    readDataSourceObjectHead: storage.head,
    deleteDataSourceFile: storage.remove,
  };
});

import { DataSourceUploadSessionsService } from "../services/data-source-upload-sessions.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource upload session PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource resumable upload session PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-upload-sessions-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("DATASOURCE_OBJECT_STORAGE_ENDPOINT", "http://minio.test");
    vi.stubEnv("DATASOURCE_MAX_COMPANY_FILE_BYTES", "1000");
    storage.create.mockImplementation(async ({ companyId, sessionId }: { companyId: string; sessionId: string }) => ({
      objectKey: `${companyId}/uploads/sessions/${sessionId}/orders.csv`, uploadId: `upload-${sessionId}`,
    }));
    storage.part.mockResolvedValue({ etag: "part-etag" });
    storage.complete.mockResolvedValue(undefined);
    storage.abort.mockResolvedValue(undefined);
    storage.verify.mockResolvedValue("a".repeat(64));
    storage.head.mockResolvedValue({ exists: true, contentLength: 3 });
    storage.remove.mockResolvedValue(undefined);
    await db.delete(activityLog);
    await db.delete(companies);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("reserves company quota, receives idempotent parts, verifies the object, and atomically queues ingestion", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Upload sessions", issuePrefix: `U${companyId.slice(0, 8)}` });
    const service = new DataSourceUploadSessionsService(db);
    const session = await service.create({
      companyId, fileName: "orders.csv", contentType: "text/csv", expectedBytes: 3,
      actor: { type: "user", id: "operator" },
    });
    expect(session).toMatchObject({ status: "uploading", expectedBytes: 3, partCount: 1, uploadedParts: [] });

    const first = await service.uploadPart(companyId, session.id, 1, Buffer.from("a,b"));
    const retry = await service.uploadPart(companyId, session.id, 1, Buffer.from("a,b"));
    const partSha256 = createHash("sha256").update("a,b").digest("hex");
    expect(first.uploadedParts).toEqual([{ partNumber: 1, byteSize: 3, sha256: partSha256 }]);
    expect(retry.uploadedParts).toEqual(first.uploadedParts);
    await expect(service.uploadPart(companyId, session.id, 1, Buffer.from("short"))).rejects.toThrow("exactly 3 bytes");

    await expect(service.complete(companyId, session.id, ["b".repeat(64)])).rejects.toThrow("contents differ");
    const completed = await service.complete(companyId, session.id, [partSha256]);
    const [source] = await db.select().from(dataSources).where(and(
      eq(dataSources.id, completed.dataSourceId), eq(dataSources.companyId, companyId),
    ));
    const [job] = await db.select().from(dataSourceJobs).where(and(
      eq(dataSourceJobs.companyId, companyId), eq(dataSourceJobs.dataSourceId, completed.dataSourceId),
    ));
    expect(source).toMatchObject({ status: "processing", sourceType: "csv", fileSize: 3, storagePath: expect.stringContaining(session.id) });
    expect(source.metadata).toMatchObject({ storageBackend: "s3", storageSha256: "a".repeat(64), uploadSessionId: session.id });
    expect(job).toMatchObject({ status: "queued", jobType: "ingest_file" });
    expect(completed.session.status).toBe("completed");
    await expect(service.complete(companyId, session.id, [partSha256])).resolves.toMatchObject({ dataSourceId: completed.dataSourceId });
    await expect(service.complete(companyId, session.id, ["b".repeat(64)])).rejects.toThrow("contents differ");
    expect(storage.complete).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ partNumber: 1, etag: "part-etag" }] }));
  }, 30_000);

  it("rejects incomplete completion and releases quota only after storage abort succeeds", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Upload session abort", issuePrefix: `A${companyId.slice(0, 8)}` });
    const service = new DataSourceUploadSessionsService(db);
    const session = await service.create({
      companyId, fileName: "orders.csv", contentType: "text/csv", expectedBytes: 3,
      actor: { type: "user", id: "operator" },
    });
    await expect(service.complete(companyId, session.id, ["a".repeat(64)])).rejects.toThrow("every part must be received");
    storage.abort.mockRejectedValueOnce(new Error("MinIO unavailable"));
    await expect(service.abort(companyId, session.id, { type: "user", id: "operator" })).rejects.toThrow("MinIO unavailable");
    await expect(service.get(companyId, session.id)).resolves.toMatchObject({ status: "uploading" });
    await service.abort(companyId, session.id, { type: "user", id: "operator" });
    await expect(service.get(companyId, session.id)).resolves.toMatchObject({ status: "aborted" });
    const [persisted] = await db.select().from(dataSourceUploadSessions).where(eq(dataSourceUploadSessions.id, session.id));
    expect(persisted.storageUploadId).toBeNull();
  }, 30_000);

  it("serializes concurrent writes to one S3 part so conflicting retries cannot replace its accepted bytes", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Concurrent upload parts", issuePrefix: `P${companyId.slice(0, 8)}` });
    const service = new DataSourceUploadSessionsService(db);
    const session = await service.create({
      companyId, fileName: "orders.csv", contentType: "text/csv", expectedBytes: 3,
      actor: { type: "user", id: "operator" },
    });

    const [first, second] = await Promise.allSettled([
      service.uploadPart(companyId, session.id, 1, Buffer.from("a,b")),
      service.uploadPart(companyId, session.id, 1, Buffer.from("c,d")),
    ]);

    expect([first.status, second.status].filter(status => status === "fulfilled")).toHaveLength(1);
    expect([first.status, second.status].filter(status => status === "rejected")).toHaveLength(1);
    expect(storage.part).toHaveBeenCalledOnce();
    const winner = first.status === "fulfilled" ? "a,b" : "c,d";
    const accepted = await service.get(companyId, session.id);
    expect(accepted.uploadedParts).toEqual([{
      partNumber: 1,
      byteSize: 3,
      sha256: createHash("sha256").update(winner).digest("hex"),
    }]);
  }, 30_000);

  it("serves create, raw part, resume status, and completion over the company-authorized HTTP routes", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Upload route integration", issuePrefix: `R${companyId.slice(0, 8)}` });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "operator", companyIds: [companyId], isInstanceAdmin: true };
      next();
    });
    app.use("/api", dataSourceRoutes(db));
    app.use(errorHandler);

    const created = await request(app)
      .post(`/api/companies/${companyId}/data-source-upload-sessions`)
      .send({ fileName: "orders.csv", contentType: "text/csv", expectedBytes: 3 })
      .expect(201);
    const sessionId = created.body.id as string;
    const partSha256 = createHash("sha256").update("a,b").digest("hex");

    await request(app)
      .put(`/api/companies/${companyId}/data-source-upload-sessions/${sessionId}/parts/1`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("a,b"))
      .expect(200)
      .expect(({ body }) => expect(body.uploadedParts).toEqual([{ partNumber: 1, byteSize: 3, sha256: partSha256 }]));

    await request(app)
      .get(`/api/companies/${companyId}/data-source-upload-sessions/${sessionId}`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe("uploading"));

    await request(app)
      .post(`/api/companies/${companyId}/data-source-upload-sessions/${sessionId}/complete`)
      .send({ partSha256s: [partSha256] })
      .expect(202)
      .expect(({ body }) => expect(body).toMatchObject({ sourceType: "csv", uploadSession: { status: "completed" } }));

    await request(app)
      .post(`/api/companies/${companyId}/data-source-upload-sessions/${sessionId}/complete`)
      .send({ partSha256s: ["b".repeat(64)] })
      .expect(409);
    await request(app)
      .get(`/api/companies/${randomUUID()}/data-source-upload-sessions/${sessionId}`)
      .expect(403);
  }, 30_000);
});
