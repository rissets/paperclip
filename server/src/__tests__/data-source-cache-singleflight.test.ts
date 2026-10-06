import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSourceCacheService, dataSourceCacheMetrics, makeDataSourceCacheKey } from "../services/data-source-cache.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("datasource embedding cache single-flight", () => {
  it("coalesces concurrent local misses and computes when Redis is unavailable", async () => {
    vi.stubEnv("REDIS_HOST", "");
    vi.stubEnv("REDIS_URL", "");
    const before = dataSourceCacheMetrics();
    const key = makeDataSourceCacheKey(["single-flight-test", String(Date.now())]);
    const cache = new DataSourceCacheService();
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const validate = (value: unknown): value is { vectors: number[][] } =>
      Boolean(value && typeof value === "object" && Array.isArray((value as { vectors?: unknown }).vectors));
    const compute = async () => {
      calls += 1;
      await wait;
      return { vectors: [[1, 2, 3]] };
    };
    const requests = Array.from({ length: 12 }, () => cache.getOrComputeJson(key, validate, 60, compute));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    release();
    const results = await Promise.all(requests);
    expect(results).toHaveLength(12);
    expect(results.every((value) => value.vectors[0].join(",") === "1,2,3")).toBe(true);
    const metrics = dataSourceCacheMetrics();
    expect(metrics.coalesced - before.coalesced).toBe(11);
    expect(metrics.localFlights).toBe(0);
  });

  it("does not cache invalid values and preserves computation errors", async () => {
    vi.stubEnv("REDIS_HOST", "");
    vi.stubEnv("REDIS_URL", "");
    const cache = new DataSourceCacheService();
    const validate = (value: unknown): value is { vectors: number[][] } => Boolean(value && typeof value === "object" && Array.isArray((value as { vectors?: unknown }).vectors));
    const invalid = await cache.getOrComputeJson(makeDataSourceCacheKey(["single-flight-invalid"]), validate, 60, async () => ({ vectors: [] }));
    expect(invalid.vectors).toEqual([]);
    await expect(cache.getOrComputeJson(makeDataSourceCacheKey(["single-flight-error"]), validate, 60, async () => { throw new Error("model failed"); })).rejects.toThrow("model failed");
  });
});
