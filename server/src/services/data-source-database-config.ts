import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dataSources, type Db } from "@paperclipai/db";
import type { DatabaseConnectionConfig } from "@paperclipai/shared";
import { secretService } from "./secrets.js";

type SourceConnection = { id: string; companyId: string; metadata: Record<string, unknown> | null };

/** Persist only the driver contract, never arbitrary request fields. */
export function databaseConfigWithoutPassword(input: DatabaseConnectionConfig): DatabaseConnectionConfig {
  return {
    type: input.type, host: input.host, port: input.port, database: input.database, username: input.username,
    ...(input.ssl !== undefined ? { ssl: input.ssl } : {}),
    ...(input.allowedSchemas ? { allowedSchemas: [...input.allowedSchemas] } : {}),
    ...(input.allowedTables ? { allowedTables: [...input.allowedTables] } : {}),
  };
}

export function publicDatabaseMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const { rawConfig, credentialSecretId: _secretId, ...visible } = metadata;
  const config = metadata.connectionConfig ?? rawConfig;
  if (config && typeof config === "object" && typeof (config as DatabaseConnectionConfig).host === "string") {
    visible.connectionConfig = databaseConfigWithoutPassword(config as DatabaseConnectionConfig);
  }
  return visible;
}

export class DataSourceDatabaseConfigService {
  private readonly secrets;
  constructor(private readonly db: Db) { this.secrets = secretService(db); }

  async archivePrepared(companyId: string, metadata: Record<string, unknown>): Promise<void> {
    if (typeof metadata.credentialSecretId !== "string") return;
    const secret = await this.secrets.getById(metadata.credentialSecretId);
    if (secret?.companyId === companyId) await this.secrets.update(secret.id, { status: "archived" });
  }

  async prepare(companyId: string, sourceId: string, config: DatabaseConnectionConfig): Promise<Record<string, unknown>> {
    const safeConfig = databaseConfigWithoutPassword(config);
    if (config.password === undefined) return { rawConfig: safeConfig, connectionConfig: safeConfig };
    if (typeof config.password !== "string") throw new Error("Database password must be a string");
    // An envelope preserves empty/whitespace passwords without violating the secret provider's nonempty-value contract.
    const secret = await this.secrets.create(companyId, {
      name: `Datasource ${sourceId} password ${randomUUID()}`,
      provider: "local_encrypted",
      value: JSON.stringify({ password: config.password }),
      description: "External datasource database credential; resolved only by the server adapter",
      providerMetadata: { dataSourceId: sourceId },
    });
    return { rawConfig: safeConfig, connectionConfig: safeConfig, credentialSecretId: secret.id };
  }

  async resolve(companyId: string, source: SourceConnection, retry = true): Promise<DatabaseConnectionConfig> {
    if (source.companyId !== companyId) throw new Error("Datasource connection belongs to another company");
    const metadata = source.metadata || {};
    const raw = metadata.rawConfig as DatabaseConnectionConfig | undefined;
    if (!raw) throw new Error(`Database connection configuration is missing for data source ${source.id}`);
    const safeConfig = databaseConfigWithoutPassword(raw);
    if (typeof metadata.credentialSecretId === "string") {
      const value = await this.secrets.resolveSecretValue(companyId, metadata.credentialSecretId, "latest", {
        accessContext: { consumerType: "system", consumerId: `datasource:${source.id}`, configPath: "connection.password", actorType: "system" },
      });
      let envelope: unknown;
      try { envelope = JSON.parse(value); } catch { throw new Error("Datasource credential has an invalid envelope"); }
      const password = (envelope as { password?: unknown } | null)?.password;
      if (typeof password !== "string") throw new Error("Datasource credential has an invalid password");
      return { ...safeConfig, password };
    }
    if (raw.password === undefined) return safeConfig;

    // Migrate legacy plaintext before using it. Compare-and-set avoids overwriting a concurrent credential change.
    const prepared = await this.prepare(companyId, source.id, raw);
    const changed = await this.db.update(dataSources).set({
      metadata: sql`coalesce(${dataSources.metadata}, '{}'::jsonb) || ${JSON.stringify(prepared)}::jsonb`,
      updatedAt: new Date(),
    }).where(and(
      eq(dataSources.id, source.id), eq(dataSources.companyId, companyId),
      sql`${dataSources.metadata}->'rawConfig'->>'password' = ${raw.password}`,
      sql`${dataSources.metadata}->>'credentialSecretId' IS NULL`,
    )).returning({ id: dataSources.id }).catch(async () => {
      let cleanupFailed = false;
      await this.secrets.update(prepared.credentialSecretId as string, { status: "archived" }).catch(() => { cleanupFailed = true; });
      // Driver errors may include the legacy password bound in the CAS predicate.
      throw new Error(cleanupFailed
        ? "Datasource credential migration failed; its unused managed secret requires cleanup"
        : "Datasource credential migration could not be committed");
    });
    if (changed.length) return this.resolve(companyId, { ...source, metadata: { ...metadata, ...prepared } }, false);
    await this.secrets.update(prepared.credentialSecretId as string, { status: "archived" });
    if (!retry) throw new Error("Datasource connection changed during credential migration; retry the request");
    const [current] = await this.db.select().from(dataSources).where(and(eq(dataSources.id, source.id), eq(dataSources.companyId, companyId))).limit(1);
    if (!current) throw new Error("Datasource was removed during credential migration");
    return this.resolve(companyId, current, false);
  }

  async migrateLegacyBatch(limit = 10): Promise<void> {
    const sources = await this.db.select().from(dataSources).where(and(
      inArray(dataSources.sourceType, ["postgres", "mysql", "mariadb"]),
      sql`${dataSources.metadata}->'rawConfig' ? 'password'`,
      sql`${dataSources.metadata}->>'credentialSecretId' IS NULL`,
    )).limit(limit);
    for (const source of sources) {
      try { await this.resolve(source.companyId, source); }
      catch { console.warn(`[DataSourceCredentials] Migration failed for datasource ${source.id}; retrying on a later sweep`); }
    }
  }
}
