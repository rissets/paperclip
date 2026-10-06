import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickhouseService, type ClickhouseStreamResumeOptions } from "../services/clickhouse.js";
import { attachCsvSourceRowCheckpoint, getCsvSourceRowCheckpoint } from "../services/data-source-stream-checkpoint.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resumable ClickHouse stream ingestion", () => {
  it("skips acknowledged batches and replaces a partial retry batch before publishing", async () => {
    vi.stubEnv("DATASOURCE_CLICKHOUSE_INSERT_MAX_BATCH_ROWS", "1000");
    const tables = new Map<string, Record<string, unknown>[]>();
    const batchInsertAttempts = new Map<string, number>();
    const mergeTablesPerRequest: number[] = [];
    let failOnce = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") || String(init?.body || "");
      const body = String(init?.body || "");

      if (/^SHOW TABLES/i.test(query)) {
        return Response.json({ meta: [{ name: "name", type: "String" }], data: [...tables.keys()].map((name) => ({ name })) });
      }
      const count = query.match(/^SELECT count\(\) AS row_count FROM `([^`]+)`/i);
      if (count) {
        return Response.json({ meta: [{ name: "row_count", type: "UInt64" }], data: [{ row_count: tables.get(count[1])?.length || 0 }] });
      }
      const jsonEachRow = query.match(/^INSERT INTO `([^`]+)` FORMAT JSONEachRow/i);
      if (jsonEachRow) {
        const tableName = jsonEachRow[1];
        const attempt = (batchInsertAttempts.get(tableName) || 0) + 1;
        batchInsertAttempts.set(tableName, attempt);
        if (tableName.includes("__b_") && tableName.endsWith("_1") && failOnce) {
          failOnce = false;
          return new Response("synthetic insert interruption", { status: 500 });
        }
        const values = body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        tables.set(tableName, [...(tables.get(tableName) || []), ...values]);
        return new Response("", { status: 200 });
      }
      const merge = query.match(/^INSERT INTO `([^`]+)` (SELECT \* FROM .+)$/i);
      if (merge) {
        const sourceNames = [...merge[2].matchAll(/SELECT \* FROM `([^`]+)`/gi)].map((match) => match[1]);
        mergeTablesPerRequest.push(sourceNames.length);
        tables.set(merge[1], [...(tables.get(merge[1]) || []), ...sourceNames.flatMap((name) => tables.get(name) || [])]);
        return new Response("", { status: 200 });
      }
      const create = query.match(/^CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`/i);
      if (create) {
        if (!tables.has(create[1])) tables.set(create[1], []);
        return new Response("", { status: 200 });
      }
      const drop = query.match(/^DROP TABLE IF EXISTS (?:`[^`]+`\.)?`([^`]+)`/i);
      if (drop) {
        tables.delete(drop[1]);
        return new Response("", { status: 200 });
      }
      const exchange = query.match(/^EXCHANGE TABLES `[^`]+`\.`([^`]+)` AND `[^`]+`\.`([^`]+)`/i);
      if (exchange) {
        const current = tables.get(exchange[1]);
        const staged = tables.get(exchange[2]);
        if (staged) tables.set(exchange[1], staged);
        if (current) tables.set(exchange[2], current);
        else tables.delete(exchange[2]);
        return new Response("", { status: 200 });
      }
      const rename = query.match(/^RENAME TABLE `[^`]+`\.`([^`]+)` TO `[^`]+`\.`([^`]+)`/i);
      if (rename) {
        tables.set(rename[2], tables.get(rename[1]) || []);
        tables.delete(rename[1]);
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const clickhouse = new ClickhouseService({ url: "http://clickhouse.test:8123", database: "paperclip" });
    const companyId = "00000000-0000-4000-8000-000000000001";
    const jobId = "00000000-0000-4000-8000-000000000002";
    let durableCheckpoint = {
      byteOffset: 0,
      committedRows: 0,
      nextBatchIndex: 0,
      delimiter: ",",
    };
    async function* rows(start = 0) {
      for (let index = start; index < 101_001; index += 1) {
        yield attachCsvSourceRowCheckpoint({ id: index }, {
          byteOffset: index + 1,
          rowNumber: index + 1,
          delimiter: ",",
        });
      }
    }
    const ddl = "CREATE TABLE `events` (`id` UInt64) ENGINE = MergeTree ORDER BY id";
    const resumeOptions: ClickhouseStreamResumeOptions = {
      jobId,
      keepBatchTablesOnFailure: () => true,
      getRowCheckpoint: getCsvSourceRowCheckpoint,
      onBatchCommitted: async (insertedRows: number, nextBatchIndex: number, checkpoint: unknown) => {
        const parsed = checkpoint as ReturnType<typeof getCsvSourceRowCheckpoint>;
        if (!parsed) throw new Error("Missing test row checkpoint");
        durableCheckpoint = {
          byteOffset: parsed.byteOffset,
          committedRows: insertedRows,
          nextBatchIndex,
          delimiter: parsed.delimiter,
        };
      },
    };

    await expect(clickhouse.syncTableFromStream("events", ddl, rows(), companyId, undefined, undefined, resumeOptions))
      .rejects.toThrow("synthetic insert interruption");
    const firstAttemptNames = [...tables.keys()].filter((name) => name.includes("__b_"));
    expect(firstAttemptNames).toHaveLength(2);
    expect(tables.get(firstAttemptNames[0])).toHaveLength(1_000);
    expect(tables.get(firstAttemptNames[1])).toHaveLength(0);

    resumeOptions.startBatchIndex = durableCheckpoint.nextBatchIndex;
    resumeOptions.startInsertedCount = durableCheckpoint.committedRows;
    const result = await clickhouse.syncTableFromStream(
      "events", ddl, rows(durableCheckpoint.committedRows), companyId, undefined, undefined, resumeOptions,
    );

    expect(result.insertedCount).toBe(101_001);
    expect(tables.get("events")).toHaveLength(101_001);
    expect(new Set(tables.get("events")?.map((row) => row.id)).size).toBe(101_001);
    expect(batchInsertAttempts.get(firstAttemptNames[0])).toBe(1);
    expect(batchInsertAttempts.get(firstAttemptNames[1])).toBe(2);
    expect([...tables.keys()].filter((name) => name.includes("__b_"))).toHaveLength(0);
    expect(mergeTablesPerRequest).toEqual([100, 2]);
  });
});
