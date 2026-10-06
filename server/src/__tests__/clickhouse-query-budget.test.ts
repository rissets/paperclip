import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickhouseService } from "../services/clickhouse.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ClickHouse analytical query budgets", () => {
  it("adds bounded execution, scan, memory, and result settings to each query", async () => {
    vi.stubEnv("DATASOURCE_CLICKHOUSE_QUERY_MAX_EXECUTION_SECONDS", "9999");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      meta: [{ name: "value", type: "UInt8" }],
      data: [{ value: 1 }],
      rows: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const clickhouse = new ClickhouseService({ url: "http://clickhouse.test:8123", database: "paperclip" });

    const result = await clickhouse.query("SELECT 1", "paperclip_company");

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("max_execution_time")).toBe("300");
    expect(requestUrl.searchParams.get("max_memory_usage")).toBe("1073741824");
    expect(requestUrl.searchParams.get("max_rows_to_read")).toBe("10000000");
    expect(requestUrl.searchParams.get("max_bytes_to_read")).toBe("1073741824");
    expect(requestUrl.searchParams.get("max_result_bytes")).toBe("67108864");
    expect(requestUrl.searchParams.get("read_overflow_mode")).toBe("throw");
    expect(result.rows).toEqual([{ value: 1 }]);
  });
});
