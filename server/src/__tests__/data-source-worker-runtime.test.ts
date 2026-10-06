import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSourceWorkerRuntime } from "../services/data-source-worker-runtime.js";

afterEach(() => vi.useRealTimers());

describe("datasource worker process lifecycle", () => {
  it("never overlaps ticks and drains the active job before stopping", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = new DataSourceWorkerRuntime(tick, 100, vi.fn());
    runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    runtime.start();
    expect(tick).toHaveBeenCalledOnce();
    expect(runtime.health()).toMatchObject({ ready: true, busy: true });
    let drained = false;
    const stopping = runtime.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(runtime.health().ready).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(drained).toBe(true);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("reports poll failure and recovers on the next successful poll", async () => {
    vi.useFakeTimers();
    const tick = vi.fn().mockRejectedValueOnce(new Error("db offline")).mockResolvedValue(undefined);
    const errors = vi.fn();
    const runtime = new DataSourceWorkerRuntime(tick, 100, errors);
    expect(runtime.health().ready).toBe(false);
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.health().ready).toBe(false);
    expect(errors).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.health()).toMatchObject({ ready: true, busy: false });
    expect(tick).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });
});
