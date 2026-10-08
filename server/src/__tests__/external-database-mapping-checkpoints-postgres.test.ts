import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, dataSourceJobCheckpoints, dataSourceJobs, dataSources } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { AiDatabaseAnalysisResult } from "../services/ai-reasoning.js";
import { DataSourceLeaseLostError } from "../services/data-source-job-lease.js";
import { ExternalDatabaseMappingCheckpointStore } from "../services/external-database-mapping-checkpoints.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource mapping checkpoint PostgreSQL test unavailable: ${support.reason}`);

(support.supported ? describe : describe.skip)("external database mapping checkpoint PostgreSQL contract", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-external-mapping-checkpoints-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  beforeEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const dataSourceId = randomUUID();
    const jobId = randomUUID();
    const owner = "mapping-worker-attempt-1";
    await db.insert(companies).values({ id: companyId, name: "Checkpoint Co", issuePrefix: `C${companyId.slice(0, 8)}` });
    await db.insert(dataSources).values({
      id: dataSourceId,
      companyId,
      name: "Sales database",
      sourceType: "postgres",
      status: "processing",
    });
    await db.insert(dataSourceJobs).values({
      id: jobId,
      companyId,
      dataSourceId,
      jobType: "external_db_onboarding",
      status: "running",
      stage: "table_mapping",
      attempt: 1,
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: randomUUID(),
    });
    return {
      companyId,
      dataSourceId,
      jobId,
      firstLease: { jobId, owner, attempt: 1 },
    };
  }

  const result: AiDatabaseAnalysisResult = {
    domain: "sales operations",
    entities: ["order"],
    primaryTopics: ["order volume", "fulfillment"],
    tableRoles: { orders: "fact_table" },
    relationships: [],
    suggestedQueries: [],
    reasoningSummary: "Sales orders are the source of order volume and fulfillment metrics.",
  };

  it("resumes saved batches across worker attempts and rejects results from a changed schema", async () => {
    const { companyId, dataSourceId, jobId, firstLease } = await seed();
    const store = new ExternalDatabaseMappingCheckpointStore(db);
    const oldSchema = "a".repeat(64);
    const batchKey = "b".repeat(64);

    await store.save(companyId, dataSourceId, firstLease, oldSchema, batchKey, result);
    expect(await store.load(companyId, dataSourceId, firstLease, oldSchema, batchKey)).toEqual(result);

    const secondOwner = "mapping-worker-attempt-2";
    await db.update(dataSourceJobs).set({
      attempt: 2,
      leaseOwner: secondOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(dataSourceJobs.id, jobId));
    const secondLease = { jobId, owner: secondOwner, attempt: 2 };
    const revisedResult = { ...result, domain: "verified sales operations" };

    expect(await store.load(companyId, dataSourceId, secondLease, oldSchema, batchKey)).toEqual(result);
    await store.save(companyId, dataSourceId, secondLease, oldSchema, batchKey, revisedResult);
    expect(await store.load(companyId, dataSourceId, secondLease, oldSchema, batchKey)).toEqual(revisedResult);
    expect(await store.load(companyId, dataSourceId, secondLease, "c".repeat(64), batchKey)).toBeNull();
    expect(await db.select().from(dataSourceJobCheckpoints).where(eq(dataSourceJobCheckpoints.jobId, jobId))).toHaveLength(1);
    await expect(store.save(companyId, dataSourceId, secondLease, oldSchema, "d".repeat(64), {
      ...revisedResult,
      reasoningSummary: "x".repeat(128 * 1024),
    })).rejects.toThrow("durable checkpoint limit");
    expect(await db.select().from(dataSourceJobCheckpoints).where(eq(dataSourceJobCheckpoints.jobId, jobId))).toHaveLength(1);
    await expect(store.save(companyId, dataSourceId, firstLease, oldSchema, batchKey, result))
      .rejects.toBeInstanceOf(DataSourceLeaseLostError);
  }, 30_000);
});
