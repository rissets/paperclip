import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, dataSourceJobs, dataSources } from "@paperclipai/db";
import { DataSourcesService } from "../services/data-sources.js";
import { DataSourceIngestionWorker } from "../services/data-source-ingestion-worker.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource ingestion cancellation PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource ingestion cancellation PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-cancel-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(companies);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await temporary?.cleanup();
  });

  async function seed(filePath: string) {
    const companyId = randomUUID();
    const dataSourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ingestion cancellation test", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: dataSourceId,
      companyId,
      name: "Cancellation fixture",
      sourceType: "csv",
      status: "ready",
      fileName: "records.csv",
      storagePath: filePath,
      metadata: { storageBackend: "local", fixtureRevision: 1 },
    });
    return { companyId, dataSourceId };
  }

  it("cancels a queued reprocess and restores the previously published source status", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-cancel-queued-"));
    const filePath = path.join(dir, "records.csv");
    await fs.writeFile(filePath, "id,value\n1,one\n");
    try {
      const { companyId, dataSourceId } = await seed(filePath);
      const service = new DataSourcesService(db);
      const queued = await service.enqueueReprocess(companyId, dataSourceId);
      expect(queued.status).toBe("processing");

      const job = await service.cancelIngestionJob(companyId, dataSourceId, queued.ingestionJob!.id, {
        actorType: "user", actorId: "cancel-operator",
      });

      expect(job).toMatchObject({ status: "cancelled", stage: "cancelled" });
      const [source] = await db.select().from(dataSources).where(and(
        eq(dataSources.id, dataSourceId), eq(dataSources.companyId, companyId),
      ));
      expect(source.status).toBe("ready");
      expect(source.metadata).toEqual({ storageBackend: "local", fixtureRevision: 1 });
      const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, dataSourceId));
      expect(audit).toMatchObject([{
        action: "data_source.ingestion.cancelled",
        actorType: "user",
        actorId: "cancel-operator",
      }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("aborts a running reprocess, rolls back staged state, and records a cancelled receipt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-cancel-running-"));
    const filePath = path.join(dir, "records.csv");
    await fs.writeFile(filePath, "id,value\n1,one\n");
    let markPipelineStarted!: () => void;
    const pipelineStarted = new Promise<void>((resolve) => { markPipelineStarted = resolve; });
    vi.spyOn(OnboardingOrchestratorService.prototype as any, "executeOnboardingPipeline").mockImplementation(
      async (_companyId: string, _source: unknown, _file: unknown, options: any) => {
        markPipelineStarted();
        await new Promise<void>((resolve, reject) => {
          const signal = options.jobLease.signal as AbortSignal;
          const abort = () => reject(new Error("pipeline observed cancellation"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    try {
      const { companyId, dataSourceId } = await seed(filePath);
      const service = new DataSourcesService(db);
      const queued = await service.enqueueReprocess(companyId, dataSourceId);
      const processing = new DataSourceIngestionWorker(db).tick();
      await Promise.race([
        pipelineStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Ingestion pipeline did not start")), 10_000)),
      ]);

      const requested = await service.cancelIngestionJob(companyId, dataSourceId, queued.ingestionJob!.id, {
        actorType: "user", actorId: "cancel-operator",
      });
      expect(requested.status).toBe("cancel_requested");
      await processing;

      const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, queued.ingestionJob!.id));
      const [source] = await db.select().from(dataSources).where(eq(dataSources.id, dataSourceId));
      expect(job).toMatchObject({ status: "cancelled", stage: "cancelled" });
      expect(source.status).toBe("ready");
      expect(source.metadata).toEqual({ storageBackend: "local", fixtureRevision: 1 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("finalizes a cancellation requested before a worker process died after its lease expires", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-cancel-recovery-"));
    const filePath = path.join(dir, "records.csv");
    await fs.writeFile(filePath, "id,value\n1,one\n");
    try {
      const { companyId, dataSourceId } = await seed(filePath);
      const queued = await new DataSourcesService(db).enqueueReprocess(companyId, dataSourceId);
      await db.update(dataSourceJobs).set({
        status: "cancel_requested",
        stage: "cancel_requested",
        leaseOwner: "worker-that-stopped",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }).where(eq(dataSourceJobs.id, queued.ingestionJob!.id));

      await new DataSourceIngestionWorker(db).tick();

      const [job] = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.id, queued.ingestionJob!.id));
      const [source] = await db.select().from(dataSources).where(eq(dataSources.id, dataSourceId));
      expect(job).toMatchObject({ status: "cancelled", stage: "cancelled", leaseOwner: null });
      expect(source.status).toBe("ready");
      expect(source.metadata).toEqual({ storageBackend: "local", fixtureRevision: 1 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
