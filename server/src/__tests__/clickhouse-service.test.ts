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

  it("auto-heals and auto-casts String timestamp columns when Date/DateTime functions like toHour are used", async () => {
    const tableName = "test_string_timestamps";
    const ddl = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (
      \`id\` String,
      \`timestamp\` String,
      \`scenario_note\` String
    ) ENGINE = MergeTree() ORDER BY (\`id\`);`;

    const sampleRows = [
      { id: "row-1", timestamp: "2026-09-01 14:00:00", scenario_note: "congestion peak" },
      { id: "row-2", timestamp: "2026-09-01 14:30:00", scenario_note: "congestion normal" },
      { id: "row-3", timestamp: "2026-09-01 15:00:00", scenario_note: "recovered" },
    ];

    await clickhouse.syncTable(tableName, ddl, sampleRows, testCompanyId);

    // This query calls `toHour(timestamp)` directly on a String column, which ClickHouse natively rejects with Code 43.
    // Our ClickhouseService automatically recovers with parseDateTimeBestEffortOrNull(timestamp) and succeeds.
    const queryRes = await clickhouse.query<{ hour: number; total: number }>(
      `SELECT toHour(timestamp) AS hour, count(*) AS total FROM \`${tableName}\` WHERE scenario_note LIKE '%congestion%' GROUP BY hour ORDER BY hour ASC`,
      expectedDb,
    );

    expect(queryRes.rows.length).toBe(1);
    expect(Number(queryRes.rows[0].hour)).toBe(14);
    expect(Number(queryRes.rows[0].total)).toBe(2);

    await clickhouse.execute(`DROP TABLE IF EXISTS \`${tableName}\``, expectedDb);
  });
});
