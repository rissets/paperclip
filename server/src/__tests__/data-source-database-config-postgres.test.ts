import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecretVersions, createDb, dataSources, secretAccessEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DataSourceDatabaseConfigService } from "../services/data-source-database-config.js";
import { verifyDataSourceRestore } from "../services/data-source-restore-verifier.js";
import { secretService } from "../services/secrets.js";
import { DataSourcesService } from "../services/data-sources.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Datasource credential PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("datasource encrypted credential PostgreSQL integration", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let keyDirectory: string | undefined;
  let restoredMasterKeyPath: string;
  beforeAll(async () => {
    keyDirectory = mkdtempSync(path.join(tmpdir(), "paperclip-datasource-restore-key-"));
    restoredMasterKeyPath = path.join(keyDirectory, "master.key");
    writeFileSync(restoredMasterKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", restoredMasterKeyPath);
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-credentials-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => {
    await temporary?.cleanup();
    vi.unstubAllEnvs();
    if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true });
  });

  it("migrates plaintext into encrypted material, preserves source metadata, records resolution, and respects revocation", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Credential migration test", issuePrefix: `C${companyId.slice(0, 8)}` });
    const config = { type: "postgres" as const, host: "db.test", port: 5432, database: "analytics", username: "reader", password: "synthetic-integration-password" };
    await db.insert(dataSources).values({ id: sourceId, companyId, name: "Orders", sourceType: "postgres", status: "ready", metadata: { rawConfig: config, semanticProfile: { domain: "sales" } } });
    const service = new DataSourceDatabaseConfigService(db);
    await service.migrateLegacyBatch();
    const [source] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(JSON.stringify(source.metadata)).not.toContain(config.password);
    expect(source.metadata?.semanticProfile).toEqual({ domain: "sales" });
    const secretId = source.metadata?.credentialSecretId as string;
    expect(secretId).toBeTruthy();
    const [version] = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId));
    expect(version.material).toMatchObject({ scheme: "local_encrypted_v1" });
    expect(JSON.stringify(version.material)).not.toContain(config.password);
    expect((await service.resolve(companyId, source)).password).toBe(config.password);
    const events = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secretId));
    expect(events.some((event) => event.consumerId === `datasource:${sourceId}` && event.outcome === "success")).toBe(true);

    // Model a restore where PostgreSQL came back but the mounted master key did not.
    // The verifier must report only a fixed diagnostic, then pass when the backed-up
    // key file is restored. It must never expose the decrypted password.
    const mismatchedMasterKeyPath = path.join(keyDirectory!, "wrong-master.key");
    writeFileSync(mismatchedMasterKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", mismatchedMasterKeyPath);
    const mismatchReport = await verifyDataSourceRestore(db, { batchSize: 1 });
    expect(mismatchReport.checked.credentials).toBe(1);
    expect(mismatchReport.issues).toEqual([{
      severity: "error",
      sourceId,
      check: "database_credential",
      code: "managed_credential_unavailable",
    }]);
    expect(JSON.stringify(mismatchReport)).not.toContain(config.password);

    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", restoredMasterKeyPath);
    const restoredReport = await verifyDataSourceRestore(db, { batchSize: 1 });
    expect(restoredReport.checked.credentials).toBe(1);
    expect(restoredReport.issues).toEqual([]);

    await secretService(db).update(secretId, { status: "disabled" });
    await expect(service.resolve(companyId, source)).rejects.toThrow("not active");
    await expect(service.resolve(randomUUID(), source)).rejects.toThrow("another company");
    const datasourceService = new DataSourcesService(db);
    expect(await datasourceService.delete(randomUUID(), sourceId)).toBe(false);
    expect((await secretService(db).getById(secretId))?.status).toBe("disabled");
    expect(await datasourceService.delete(companyId, sourceId)).toBe(true);
    expect((await secretService(db).getById(secretId))?.status).toBe("archived");
  }, 30_000);
});
