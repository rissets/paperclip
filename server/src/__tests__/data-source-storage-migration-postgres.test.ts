import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, dataSourceJobs, dataSources } from "@paperclipai/db";
import { DataSourceStorageMigrationService } from "../services/data-source-storage-migration.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource object migration PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource local-object migration PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let outside: string;
  let companyId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-object-migration-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-approved-root-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-outside-root-"));
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Object migration", issuePrefix: `OM${companyId.slice(0, 6)}` });
  }, 90_000);

  beforeEach(async () => {
    await db.delete(dataSources).where(eq(dataSources.companyId, companyId));
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    await Promise.all([
      root && rm(root, { recursive: true, force: true }),
      outside && rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("dry-runs then verifies and compare-and-set publishes a deterministic MinIO pointer without deleting the local original", async () => {
    const sourceId = randomUUID();
    const filePath = path.join(root, "orders.csv");
    const contents = Buffer.from("id,amount\n1,42\n");
    await writeFile(filePath, contents);
    await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "Orders",
      sourceType: "csv",
      status: "ready",
      fileName: "orders.csv",
      fileSize: contents.length,
      mimeType: "text/csv",
      storagePath: filePath,
      metadata: { storageBackend: "local_disk", semanticProfile: { retained: true } },
    });

    const writes: Array<{ objectKey: string; sha256: string; filePath: string }> = [];
    const service = new DataSourceStorageMigrationService(db, async (input) => {
      writes.push({ objectKey: input.objectKey, sha256: input.sha256, filePath: input.filePath });
      return { objectKey: input.objectKey, sha256: input.sha256 };
    });
    const preview = await service.run({ roots: [root] });
    expect(preview).toMatchObject({ planned: 1, migrated: 0, failed: 0 });
    expect(writes).toHaveLength(0);

    const applied = await service.run({ roots: [root], apply: true });
    expect(applied.issues).toEqual([]);
    expect(applied).toMatchObject({ planned: 1, migrated: 1, failed: 0, conflicted: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].objectKey).toBe(`${companyId}/legacy-migration/${sourceId}/${writes[0].sha256}`);
    expect(writes[0].filePath).toBe(realpathSync(filePath));
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.storagePath).toBe(writes[0].objectKey);
    expect(source.metadata).toMatchObject({
      storageBackend: "s3",
      storageSha256: writes[0].sha256,
      semanticProfile: { retained: true },
    });
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceId));
    expect(audit).toMatchObject({
      actorType: "system",
      actorId: "datasource-storage-migrator",
      action: "datasource.storage_migrated_to_s3",
      details: { provider: "s3", byteSize: contents.length, sha256: writes[0].sha256 },
    });
    await expect(readFile(filePath)).resolves.toEqual(contents);

    const retry = await service.run({ roots: [root], apply: true });
    expect(retry).toMatchObject({ migrated: 0, planned: 0, failed: 0 });
    expect(writes).toHaveLength(1);
  }, 30_000);

  it("rejects files outside approved roots and preserves a concurrent pointer update", async () => {
    const outsideId = randomUUID();
    const outsidePath = path.join(outside, "outside.txt");
    await writeFile(outsidePath, "outside");
    await db.insert(dataSources).values({
      id: outsideId, companyId, name: "Outside", sourceType: "rag_document", status: "ready", fileName: "outside.txt",
      fileSize: 7, storagePath: outsidePath, metadata: { storageBackend: "local_disk" },
    });

    const raceId = randomUUID();
    const racePath = path.join(root, "race.json");
    const bytes = Buffer.from("{\"revision\":1}");
    await writeFile(racePath, bytes);
    await db.insert(dataSources).values({
      id: raceId, companyId, name: "Concurrent", sourceType: "rag_document", status: "ready", fileName: "race.json",
      fileSize: bytes.length, storagePath: racePath, metadata: { storageBackend: "local_disk" },
    });
    const concurrentKey = `${companyId}/replacement/current`;
    let writes = 0;
    const service = new DataSourceStorageMigrationService(db, async (input) => {
      writes += 1;
      if (input.objectKey.includes(raceId)) {
        await db.update(dataSources).set({ storagePath: concurrentKey }).where(eq(dataSources.id, raceId));
      }
      return { objectKey: input.objectKey, sha256: input.sha256 };
    });

    const result = await service.run({ roots: [root], apply: true });
    expect(result).toMatchObject({ planned: 1, failed: 1, conflicted: 1, migrated: 0 });
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: outsideId, reason: "Legacy upload is outside the approved migration roots" }),
      expect.objectContaining({
        sourceId: raceId,
        stage: "database-pointer-publication",
        objectKey: expect.stringContaining(`/legacy-migration/${raceId}/`),
      }),
    ]));
    expect(writes).toBe(1);
    const [outsideSource] = await db.select().from(dataSources).where(eq(dataSources.id, outsideId));
    const [racedSource] = await db.select().from(dataSources).where(eq(dataSources.id, raceId));
    expect(outsideSource.storagePath).toBe(outsidePath);
    expect(racedSource.storagePath).toBe(concurrentKey);
    expect(racedSource.metadata?.storageBackend).toBe("local_disk");
  }, 30_000);

  it("rejects symlinks and recorded byte sizes that do not match the local file", async () => {
    const targetPath = path.join(outside, "target.pdf");
    const linkPath = path.join(root, "linked.pdf");
    await writeFile(targetPath, "pdf bytes");
    await symlink(targetPath, linkPath);
    const symlinkId = randomUUID();
    const mismatchId = randomUUID();
    const mismatchPath = path.join(root, "mismatch.pdf");
    await writeFile(mismatchPath, "actual");
    await db.insert(dataSources).values([
      {
        id: symlinkId, companyId, name: "Linked", sourceType: "rag_document", status: "ready", storagePath: linkPath,
        fileSize: 9, metadata: { storageBackend: "local_disk" },
      },
      {
        id: mismatchId, companyId, name: "Mismatch", sourceType: "rag_document", status: "ready", storagePath: mismatchPath,
        fileSize: 99, metadata: { storageBackend: "local_disk" },
      },
    ]);
    let writes = 0;
    const service = new DataSourceStorageMigrationService(db, async (input) => {
      writes += 1;
      return { objectKey: input.objectKey, sha256: input.sha256 };
    });

    const result = await service.run({ roots: [root], apply: true });
    expect(result).toMatchObject({ planned: 0, migrated: 0, failed: 2 });
    expect(writes).toBe(0);
  }, 30_000);

  it("leaves a source with an active ingestion job untouched", async () => {
    const sourceId = randomUUID();
    const filePath = path.join(root, "queued.csv");
    const bytes = Buffer.from("id\n1\n");
    await writeFile(filePath, bytes);
    await db.insert(dataSources).values({
      id: sourceId, companyId, name: "Queued", sourceType: "csv", status: "ready", fileName: "queued.csv",
      fileSize: bytes.length, storagePath: filePath, metadata: { storageBackend: "local_disk" },
    });
    await db.insert(dataSourceJobs).values({
      companyId, dataSourceId: sourceId, jobType: "ingest_file", status: "queued", idempotencyKey: `file-ingest:${sourceId}`,
    });
    let writes = 0;
    const service = new DataSourceStorageMigrationService(db, async (input) => {
      writes += 1;
      return { objectKey: input.objectKey, sha256: input.sha256 };
    });

    const result = await service.run({ roots: [root], apply: true });
    expect(result).toMatchObject({ scanned: 0, planned: 0, migrated: 0, failed: 0 });
    expect(writes).toBe(0);
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(source.storagePath).toBe(filePath);
  }, 30_000);
});
