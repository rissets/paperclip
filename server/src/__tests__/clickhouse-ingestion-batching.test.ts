import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickhouseService } from "../services/clickhouse.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ClickHouse streamed ingestion batches", () => {
  it("uses the configured row cap while keeping each request bounded", async () => {
    vi.stubEnv("DATASOURCE_CLICKHOUSE_INSERT_MAX_BATCH_ROWS", "1000");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const clickhouse = new ClickhouseService({ url: "http://clickhouse.test:8123", database: "paperclip" });
    async function* rows() {
      for (let index = 0; index < 1_001; index += 1) yield { index };
    }

    const result = await clickhouse.insertJsonEachRowStream("events", rows(), "paperclip_company");

    expect(result.insertedCount).toBe(1_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchSizes = fetchMock.mock.calls.map((call) =>
      String((call[1] as RequestInit).body).split("\n").length,
    );
    expect(batchSizes).toEqual([1_000, 1]);
  });

  it("flushes by bytes even when the row cap has not been reached", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const clickhouse = new ClickhouseService({ url: "http://clickhouse.test:8123", database: "paperclip" });
    async function* rows() {
      yield { payload: "a".repeat(2_500_000) };
      yield { payload: "b".repeat(2_500_000) };
    }

    const result = await clickhouse.insertJsonEachRowStream("events", rows(), "paperclip_company");

    expect(result.insertedCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(Buffer.byteLength(String((call[1] as RequestInit).body))).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it("aborts an active streamed insert when the datasource job is cancelled", async () => {
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      notifyStarted();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const clickhouse = new ClickhouseService({ url: "http://clickhouse.test:8123", database: "paperclip" });
    async function* rows() { yield { id: 1 }; }

    const pending = clickhouse.insertJsonEachRowStream("events", rows(), "paperclip_company", undefined, controller.signal);
    await requestStarted;
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("aborted");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toMatchObject({ aborted: true });
  });
});
