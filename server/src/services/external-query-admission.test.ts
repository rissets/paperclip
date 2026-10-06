import { describe, expect, it, vi } from "vitest";
import { ExternalQueryAdmission } from "./external-query-admission.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const localOnlyPermit = async () => undefined;

describe("external datasource query admission", () => {
  it("caps concurrency, queues a bounded waiter, and rejects excess work", async () => {
    const admission = new ExternalQueryAdmission(1, 1, 100, localOnlyPermit);
    const firstGate = deferred<void>();
    let active = 0;
    let peak = 0;

    const first = admission.run("company/source", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await firstGate.promise;
      active -= 1;
      return "first";
    });
    const second = admission.run("company/source", async () => {
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      return "second";
    });
    await expect(admission.run("company/source", async () => "third"))
      .rejects.toThrow("concurrent query limit");

    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(peak).toBe(1);
  });

  it("times out a queued query instead of allowing an unbounded wait", async () => {
    const admission = new ExternalQueryAdmission(1, 1, 5, localOnlyPermit);
    const gate = deferred<void>();
    const first = admission.run("company/source", () => gate.promise);

    await expect(admission.run("company/source", async () => "queued"))
      .rejects.toThrow("query queue is full");
    gate.resolve();
    await first;
  });

  it("removes a disconnected waiter so later work can use the queue slot", async () => {
    const admission = new ExternalQueryAdmission(1, 1, 100, localOnlyPermit);
    const gate = deferred<void>();
    const controller = new AbortController();
    let canceledOperationStarted = false;
    const first = admission.run("company/source", () => gate.promise);
    const canceled = admission.run("company/source", async () => {
      canceledOperationStarted = true;
      return "should not run";
    }, controller.signal);

    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });

    const next = admission.run("company/source", async () => "next");
    gate.resolve();
    await first;
    await expect(next).resolves.toBe("next");
    expect(canceledOperationStarted).toBe(false);
  });

  it("rejects an already disconnected request before acquiring capacity", async () => {
    const admission = new ExternalQueryAdmission(1, 1, 100, localOnlyPermit);
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => "should not run");

    await expect(admission.run("company/source", operation, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed when configured distributed admission is unavailable and releases local capacity", async () => {
    let attempts = 0;
    const acquirePermit = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Redis unavailable");
      return undefined;
    };
    const admission = new ExternalQueryAdmission(1, 1, 100, acquirePermit);

    await expect(admission.run("company/source", async () => "must not run"))
      .rejects.toThrow("Redis unavailable");
    await expect(admission.run("company/source", async () => "allowed after recovery"))
      .resolves.toBe("allowed after recovery");
  });
});
