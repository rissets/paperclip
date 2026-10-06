import { createExternalQueryAbortError } from "./external-query-abort.js";
import { acquireDataSourceQueryPermit } from "./data-source-cache.js";

type PermitRelease = () => Promise<void>;
type DistributedPermitAcquire = (
  key: string,
  maxConcurrent: number,
  waitMs: number,
  signal?: AbortSignal,
) => Promise<PermitRelease | undefined>;

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type AdmissionState = {
  active: number;
  waiters: Waiter[];
};

export class ExternalQueryAdmission {
  private readonly states = new Map<string, AdmissionState>();

  constructor(
    private readonly maxConcurrentPerSource = 4,
    private readonly maxQueuedPerSource = 8,
    private readonly maxQueueWaitMs = 2_500,
    private readonly acquireDistributedPermit: DistributedPermitAcquire = acquireDataSourceQueryPermit,
  ) {}

  async run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const enqueuedAt = Date.now();
    const release = await this.acquire(key, signal);
    let releaseDistributed: PermitRelease | undefined;
    try {
      if (signal?.aborted) throw createExternalQueryAbortError();
      const remainingWaitMs = Math.max(0, this.maxQueueWaitMs - (Date.now() - enqueuedAt));
      releaseDistributed = await this.acquireDistributedPermit(
        key,
        this.maxConcurrentPerSource,
        remainingWaitMs,
        signal,
      );
      if (signal?.aborted) throw createExternalQueryAbortError();
      return await operation();
    } finally {
      try {
        await releaseDistributed?.();
      } finally {
        release();
      }
    }
  }

  private async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw createExternalQueryAbortError();

    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, waiters: [] };
      this.states.set(key, state);
    }

    if (state.active < this.maxConcurrentPerSource) {
      state.active += 1;
      return this.makeRelease(key, state);
    }
    if (state.waiters.length >= this.maxQueuedPerSource) {
      throw new Error("External datasource is at its concurrent query limit; retry shortly");
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          const index = state!.waiters.indexOf(waiter);
          if (index >= 0) state!.waiters.splice(index, 1);
          this.detachWaiter(waiter);
          this.cleanup(key, state!);
          reject(new Error("External datasource query queue is full; retry shortly"));
        }, this.maxQueueWaitMs),
      };
      if (signal) {
        waiter.abortListener = () => {
          const index = state!.waiters.indexOf(waiter);
          if (index < 0) return;
          state!.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          this.detachWaiter(waiter);
          this.cleanup(key, state!);
          reject(createExternalQueryAbortError());
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      waiter.timer.unref?.();
      state!.waiters.push(waiter);
      // Close the race where the signal aborts immediately before registration.
      if (signal?.aborted) waiter.abortListener?.();
    });
  }

  private makeRelease(key: string, state: AdmissionState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        this.detachWaiter(next);
        if (next.signal?.aborted) {
          next.reject(createExternalQueryAbortError());
          this.makeRelease(key, state)();
          return;
        }
        next.resolve(this.makeRelease(key, state));
        return;
      }
      state.active = Math.max(0, state.active - 1);
      this.cleanup(key, state);
    };
  }

  private detachWaiter(waiter: Waiter): void {
    if (waiter.abortListener) waiter.signal?.removeEventListener("abort", waiter.abortListener);
    waiter.abortListener = undefined;
  }

  private cleanup(key: string, state: AdmissionState): void {
    if (state.active === 0 && state.waiters.length === 0 && this.states.get(key) === state) {
      this.states.delete(key);
    }
  }
}

export const externalQueryAdmission = new ExternalQueryAdmission();
