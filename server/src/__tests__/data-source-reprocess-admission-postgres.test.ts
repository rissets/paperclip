import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, dataSourceJobs, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DataSourcesService } from "../services/data-sources.js";
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource admission PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource reprocess admission PostgreSQL integration", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-admission-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Admission test", issuePrefix: `A${id.slice(0, 8)}` });
    return id;
  }
  async function source(companyId: string, status = "ready", storagePath: string | null = "/tmp/test-datasource.csv") {
    const [value] = await db.insert(dataSources).values({ companyId, name: "CSV", sourceType: "csv", status, storagePath }).returning();
    return value;
  }
  it("serializes two concurrent requests into one job and one HTTP 409 conflict", async () => {
    const companyId = await company();
    const original = await source(companyId);
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(dataSources).where(eq(dataSources.id, original.id)).for("update");
      signalHeld();
      await released;
    });
    await held;
    const service = new DataSourcesService(db);
    const requests = Promise.allSettled([service.enqueueReprocess(companyId, original.id), service.enqueueReprocess(companyId, original.id)]);
    let waiting = 0;
    try {
      for (let retry = 0; retry < 100; retry++) {
        const rows = await db.execute(sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%data_sources%'`);
        waiting = Number(rows[0]?.count ?? 0);
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { release(); await blocker; }
    const results = await requests;
    expect(waiting).toBeGreaterThanOrEqual(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.status : null).toBe(409);
    const jobs = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.dataSourceId, original.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
  }, 30_000);

  it("queues orphaned processing files while skipping active jobs and sources without files", async () => {
    const companyId = await company();
    const orphan = await source(companyId, "processing");
    const active = await source(companyId);
    await source(companyId, "error", null);
    const service = new DataSourcesService(db);
    await service.enqueueReprocess(companyId, active.id);
    const queued = await service.reprocessStuck(companyId);
    expect(queued.map((item) => item.id)).toEqual([orphan.id]);
    expect(queued[0].ingestionJob?.status).toBe("queued");
    const jobs = await db.select().from(dataSourceJobs).where(eq(dataSourceJobs.companyId, companyId));
    expect(jobs).toHaveLength(2);
    await expect(service.enqueueReprocess(randomUUID(), orphan.id)).rejects.toMatchObject({ status: 404 });
  });
});
