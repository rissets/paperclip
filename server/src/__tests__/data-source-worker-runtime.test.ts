import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSourceWorkerRuntime } from "../services/data-source-worker-runtime.js";
import { DataSourceQueryWorker } from "../services/data-source-query-worker.js";

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

  it("backs off repeated poll failures and returns to the configured interval after recovery", async () => {
    vi.useFakeTimers();
    const firstError = new Error("database offline");
    const secondError = new Error("database still offline");
    const tick = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockResolvedValue(undefined);
    const errors = vi.fn();
    const runtime = new DataSourceWorkerRuntime(tick, 100, errors);

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenLastCalledWith(firstError);
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenLastCalledWith(secondError);

    await vi.advanceTimersByTimeAsync(199);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(runtime.health().ready).toBe(true);
    await runtime.stop();
  });

  it("summarizes repeated external database connection failures without logging stacks", () => {
    const worker = new DataSourceQueryWorker({} as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    (worker as any).logQueryFailure(new Error("PostgreSQL execution error: sorry, too many clients already"), false);
    (worker as any).logQueryFailure(new Error("PostgreSQL execution error: sorry, too many clients already"), false);

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("external PostgreSQL connection limit reached");
    expect(error.mock.calls[0]?.[0]).not.toContain("at DatabaseIntegrationService");
  });
});
