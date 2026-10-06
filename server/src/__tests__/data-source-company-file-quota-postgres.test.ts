import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, dataSources, dataSourceTables } from "@paperclipai/db";
import { EnterpriseAgentRosterService } from "../services/enterprise-agent-roster.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource company file quota PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource company file quota PostgreSQL integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let uploadDirectory: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-quota-");
    db = createDb(temporary.connectionString);
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-datasource-quota-files-"));
    vi.stubEnv("DATASOURCE_MAX_COMPANY_FILE_BYTES", "10");
    vi.stubEnv("DATASOURCE_LOCAL_UPLOAD_DIRECTORY", uploadDirectory);
    vi.stubEnv("DATASOURCE_OBJECT_STORAGE_ENDPOINT", "");
    vi.spyOn(EnterpriseAgentRosterService.prototype, "ensureEnterpriseRoster").mockResolvedValue(undefined);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(uploadDirectory, { recursive: true, force: true });
    await temporary?.cleanup();
  });

  it("serializes concurrent uploads and removes the object rejected by the company quota", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Datasource quota test",
      issuePrefix: `Q${companyId.slice(0, 8)}`,
    });
    const service = new OnboardingOrchestratorService(db);
    const uploads = await Promise.allSettled([
      service.onboardSource(companyId, {
        originalname: "first.csv",
        mimetype: "text/csv",
        buffer: Buffer.from("id\n1234\n"),
      }, { async: true }),
      service.onboardSource(companyId, {
        originalname: "second.csv",
        mimetype: "text/csv",
        buffer: Buffer.from("id\n5678\n"),
      }, { async: true }),
    ]);

    expect(uploads.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = uploads.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.status : null).toBe(413);

    const sources = await db.select().from(dataSources).where(eq(dataSources.companyId, companyId));
    expect(sources).toHaveLength(1);
    const retainedObjects = await fs.readdir(path.join(uploadDirectory, companyId));
    expect(retainedObjects).toHaveLength(1);

    const largeFileCompanyId = randomUUID();
    const largeFileSourceId = randomUUID();
    await db.insert(companies).values({
      id: largeFileCompanyId,
      name: "Datasource large-file size test",
      issuePrefix: `L${largeFileCompanyId.slice(0, 8)}`,
    });
    await db.insert(dataSources).values({
      id: largeFileSourceId,
      companyId: largeFileCompanyId,
      name: "Large CSV",
      sourceType: "csv",
      fileName: "large.csv",
      fileSize: 3 * 1024 * 1024 * 1024,
    });
    const [largeFile] = await db.select({ fileSize: dataSources.fileSize })
      .from(dataSources)
      .where(eq(dataSources.id, largeFileSourceId));
    expect(largeFile.fileSize).toBe(3 * 1024 * 1024 * 1024);

    await db.insert(dataSourceTables).values({
      companyId: largeFileCompanyId,
      dataSourceId: largeFileSourceId,
      tableName: "wide_count",
      schemaDefinition: [],
      rowCount: 3_000_000_000,
    });
    const [largeTable] = await db.select({ rowCount: dataSourceTables.rowCount })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.dataSourceId, largeFileSourceId));
    expect(largeTable.rowCount).toBe(3_000_000_000);
  }, 30_000);
});
