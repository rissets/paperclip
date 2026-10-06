import { beforeEach, describe, expect, it, vi } from "vitest";
const secrets = vi.hoisted(() => ({ create: vi.fn(), resolveSecretValue: vi.fn(), update: vi.fn(), getById: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => secrets }));
import { DataSourceDatabaseConfigService, databaseConfigWithoutPassword, publicDatabaseMetadata } from "../services/data-source-database-config.js";
import { databaseConnectionErrorMessage } from "../services/database-integration.js";

const config = { type: "postgres" as const, host: "db.test", port: 5432, database: "analytics", username: "reader", password: "synthetic-secret", allowedTables: ["orders"] };
beforeEach(() => vi.resetAllMocks());

describe("datasource database credential boundary", () => {
  it("redacts clear and URL-encoded passwords from provider failures", () => {
    const password = "synthetic/p@ss";
    const message = databaseConnectionErrorMessage(new Error(`Driver failed for ${password} and ${encodeURIComponent(password)}`), { ...config, password });
    expect(message).not.toContain(password);
    expect(message).not.toContain(encodeURIComponent(password));
    expect(message).toContain("[redacted]");
  });
  it("stores the password only through the encrypted provider and rejects arbitrary config fields", async () => {
    secrets.create.mockResolvedValue({ id: "credential-id" });
    const service = new DataSourceDatabaseConfigService({} as never);
    const metadata = await service.prepare("company-a", "source-a", { ...config, apiKey: "must-not-persist" } as typeof config);
    expect(metadata).toEqual({ rawConfig: databaseConfigWithoutPassword(config), connectionConfig: databaseConfigWithoutPassword(config), credentialSecretId: "credential-id" });
    expect(JSON.stringify(metadata)).not.toContain("synthetic-secret");
    expect(JSON.stringify(metadata)).not.toContain("must-not-persist");
    expect(secrets.create).toHaveBeenCalledWith("company-a", expect.objectContaining({ provider: "local_encrypted", value: JSON.stringify({ password: config.password }) }));
  });

  it("resolves a company-scoped reference with an audited system consumer", async () => {
    secrets.resolveSecretValue.mockResolvedValue(JSON.stringify({ password: " " }));
    const service = new DataSourceDatabaseConfigService({} as never);
    expect(await service.resolve("company-a", { id: "source-a", companyId: "company-a", metadata: { rawConfig: databaseConfigWithoutPassword(config), credentialSecretId: "credential-id" } })).toMatchObject({ password: " " });
    expect(secrets.resolveSecretValue).toHaveBeenCalledWith("company-a", "credential-id", "latest", expect.objectContaining({ accessContext: expect.objectContaining({ consumerType: "system", consumerId: "datasource:source-a" }) }));
  });

  it("denies a foreign-company source before resolving any secret", async () => {
    const service = new DataSourceDatabaseConfigService({} as never);
    await expect(service.resolve("company-b", { id: "source-a", companyId: "company-a", metadata: { rawConfig: config, credentialSecretId: "credential-id" } })).rejects.toThrow("another company");
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(secrets.create).not.toHaveBeenCalled();
  });

  it("migrates legacy credentials before use without writing the clear password back", async () => {
    secrets.create.mockResolvedValue({ id: "credential-id" });
    secrets.resolveSecretValue.mockResolvedValue(JSON.stringify({ password: config.password }));
    const returning = vi.fn().mockResolvedValue([{ id: "source-a" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) };
    const result = await new DataSourceDatabaseConfigService(db as never).resolve("company-a", { id: "source-a", companyId: "company-a", metadata: { rawConfig: config, semanticProfile: { domain: "sales" } } });
    expect(result.password).toBe(config.password);
    expect(set).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
    expect(secrets.resolveSecretValue).toHaveBeenCalledOnce();
  });

  it("redacts legacy and current connection metadata without modifying the stored object", () => {
    const metadata = { rawConfig: config, connectionConfig: config, credentialSecretId: "credential-id", tableCount: 5 };
    const visible = publicDatabaseMetadata(metadata);
    expect(JSON.stringify(visible)).not.toContain(config.password);
    expect(visible).not.toHaveProperty("rawConfig");
    expect(visible).not.toHaveProperty("credentialSecretId");
    expect(visible?.tableCount).toBe(5);
    expect(metadata.rawConfig.password).toBe(config.password);
    expect(publicDatabaseMetadata({ connectionConfig: { baseUrl: "https://api.test" } })).toEqual({ connectionConfig: { baseUrl: "https://api.test" } });
  });

  it("uses the winning credential after a concurrent migration and archives its unused secret", async () => {
    secrets.create.mockResolvedValue({ id: "unused-credential" });
    secrets.update.mockResolvedValue({});
    secrets.resolveSecretValue.mockResolvedValue(JSON.stringify({ password: "new-password" }));
    const current = { id: "source-a", companyId: "company-a", metadata: { rawConfig: databaseConfigWithoutPassword(config), credentialSecretId: "winning-credential" } };
    const db = {
      update: vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
    };
    const result = await new DataSourceDatabaseConfigService(db as never).resolve("company-a", { id: "source-a", companyId: "company-a", metadata: { rawConfig: config } });
    expect(result.password).toBe("new-password");
    expect(secrets.update).toHaveBeenCalledWith("unused-credential", { status: "archived" });
    expect(secrets.resolveSecretValue).toHaveBeenCalledWith("company-a", "winning-credential", "latest", expect.anything());
  });

  it("hides migration SQL parameters and archives the unused secret when its metadata commit fails", async () => {
    secrets.create.mockResolvedValue({ id: "unused-credential" });
    secrets.update.mockResolvedValue({});
    const db = { update: () => ({ set: () => ({ where: () => ({ returning: async () => { throw new Error(`SQL parameters: ${config.password}`); } }) }) }) };
    const service = new DataSourceDatabaseConfigService(db as never);
    await expect(service.resolve("company-a", { id: "source-a", companyId: "company-a", metadata: { rawConfig: config } })).rejects.toThrow("could not be committed");
    expect(secrets.update).toHaveBeenCalledWith("unused-credential", { status: "archived" });
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
  });
});
