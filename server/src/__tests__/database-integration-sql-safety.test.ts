import { describe, expect, it } from "vitest";
import { DatabaseIntegrationService, validateReadOnlySqlQuery } from "../services/database-integration.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("external SQL safety parser", () => {
  it("accepts one read-only SELECT or SELECT-backed CTE for each supported dialect", () => {
    expect(validateReadOnlySqlQuery(
      "WITH recent AS (SELECT id FROM orders WHERE created_at >= $1) SELECT id FROM recent",
      "postgresql",
    )).toContain("WITH recent");
    expect(validateReadOnlySqlQuery(
      "WITH recent AS (SELECT `id` FROM `orders`) SELECT `id` FROM recent",
      "mysql",
    )).toContain("WITH recent");
    expect(validateReadOnlySqlQuery("SELECT 'update; drop table' AS note FROM orders", "postgresql"))
      .toContain("SELECT 'update; drop table'");
  });

  it.each([
    ["top-level DML", "DELETE FROM orders", "postgresql"],
    ["DML inside a CTE", "WITH changed AS (DELETE FROM orders RETURNING id) SELECT id FROM changed", "postgresql"],
    ["SELECT INTO", "SELECT id INTO copied_orders FROM orders", "postgresql"],
    ["row-locking SELECT", "SELECT id FROM orders FOR UPDATE", "postgresql"],
    ["sequence mutation function", "SELECT nextval('order_id_seq')", "postgresql"],
    ["advisory lock function", "SELECT pg_advisory_lock(42)", "postgresql"],
    ["multiple statements", "SELECT 1; SELECT 2", "postgresql"],
    ["invalid SQL", "SELECT FROM", "postgresql"],
    ["MySQL file output", "SELECT id FROM orders INTO OUTFILE '/tmp/orders.csv'", "mysql"],
    ["MySQL row lock", "SELECT id FROM orders FOR UPDATE", "mysql"],
    ["MySQL named lock function", "SELECT GET_LOCK('datasource-query', 1)", "mysql"],
    ["MySQL sleep function", "SELECT SLEEP(10)", "mysql"],
  ])("rejects %s", (_label, query, dialect) => {
    expect(() => validateReadOnlySqlQuery(query, dialect as "postgresql" | "mysql"))
      .toThrow(/Security Violation/);
  });
});

const postgresSupport = await getEmbeddedPostgresTestSupport();
if (!postgresSupport.supported) console.warn(`SQL safety PostgreSQL integration unavailable: ${postgresSupport.reason}`);
(postgresSupport.supported ? describe : describe.skip)("external SQL result bounds", () => {
  it("caps the outer result when the user query has a LIMIT only inside a CTE", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-datasource-sql-bound-");
    try {
      const remote = new URL(temporary.connectionString);
      const result = await new DatabaseIntegrationService().queryDatabase({
        type: "postgres",
        host: remote.hostname,
        port: Number(remote.port),
        database: decodeURIComponent(remote.pathname.slice(1)),
        username: decodeURIComponent(remote.username),
        password: decodeURIComponent(remote.password),
        ssl: false,
      }, "WITH sample AS (SELECT generate_series(1, 100) AS id LIMIT 70) SELECT id FROM sample ORDER BY id", 5);

      expect(result.rowCount).toBe(5);
      expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await temporary.cleanup();
    }
  }, 90_000);
});
