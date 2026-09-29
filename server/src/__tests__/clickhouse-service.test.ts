import { describe, it, expect, beforeAll } from "vitest";
import { ClickhouseService } from "../services/clickhouse.js";

describe("ClickhouseService", () => {
  const clickhouse = new ClickhouseService();
  const testCompanyId = "test-comp-123e4567-e89b-12d3-a456-426614174000";
  const expectedDb = clickhouse.getCompanyDatabase(testCompanyId);

  it("checks health status against live ClickHouse server", async () => {
    const health = await clickhouse.isHealthy();
    expect(health.ok).toBe(true);
    expect(health.version).toBeDefined();
  });

  it("isolates company database correctly", async () => {
    const dbName = await clickhouse.ensureCompanyDatabase(testCompanyId);
    expect(dbName).toBe(expectedDb);
  });

  it("creates table, inserts rows via JSONEachRow, and executes analytical queries", async () => {
    const tableName = "test_analytics_metrics";
    const ddl = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (
      \`id\` String,
      \`category\` String,
      \`amount\` Float64
    ) ENGINE = MergeTree() ORDER BY (\`id\`);`;

    const sampleRows = [
      { id: "row-1", category: "Hardware", amount: 1500000.5 },
      { id: "row-2", category: "Software", amount: 2500000.0 },
      { id: "row-3", category: "Hardware", amount: 750000.0 },
    ];

    const syncResult = await clickhouse.syncTable(tableName, ddl, sampleRows, testCompanyId);
    expect(syncResult.created).toBe(true);
    expect(syncResult.insertedCount).toBe(3);
    expect(syncResult.dbName).toBe(expectedDb);

    // List tables in company database
    const tables = await clickhouse.listTables(testCompanyId);
    expect(tables).toContain(tableName);

    // Query aggregated metrics
    const queryRes = await clickhouse.query<{ category: string; total_amount: number; count: number }>(
      `SELECT category, sum(amount) AS total_amount, count(*) AS count FROM \`${tableName}\` GROUP BY category ORDER BY total_amount DESC`,
      expectedDb,
    );

    expect(queryRes.rows.length).toBe(2);
    expect(queryRes.rows[0].category).toBe("Software");
    expect(queryRes.rows[0].total_amount).toBe(2500000);
    expect(queryRes.rows[1].category).toBe("Hardware");
    expect(queryRes.rows[1].total_amount).toBe(2250000.5);
    expect(queryRes.executionTimeMs).toBeGreaterThanOrEqual(0);

    // Clean up test table
    await clickhouse.execute(`DROP TABLE IF EXISTS \`${tableName}\``, expectedDb);
  });
});
