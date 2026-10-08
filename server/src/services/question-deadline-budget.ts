export interface QuestionDeadlineBudgetOptions {
  totalBudgetMs?: number; // default 55_000 (55s)
  reserveMs?: number; // default 12_000 (12s for queue, network, formatting)
  maxDatabaseTimeoutMs?: number; // default 20_000 (20s)
  minRetryRemainingMs?: number; // default 15_000 (15s minimum remaining to allow retry)
  submittedAt?: number; // timestamp when request was submitted
}

export interface StageBudgetAllocation {
  retrieval: number; // 3_000
  planning: number; // 10_000
  validation: number; // 2_000
  database: number; // 20_000
  synthesis: number; // 8_000
  reserve: number; // 12_000
}

export const DEFAULT_STAGE_ALLOCATION: StageBudgetAllocation = {
  retrieval: 3_000,
  planning: 10_000,
  validation: 2_000,
  database: 20_000,
  synthesis: 8_000,
  reserve: 12_000,
};

export class QuestionDeadlineBudget {
  readonly startTime: number;
  readonly totalBudgetMs: number;
  readonly reserveMs: number;
  readonly maxDatabaseTimeoutMs: number;
  readonly minRetryRemainingMs: number;
  private abortController: AbortController;
  private timer: NodeJS.Timeout | null = null;
  private stageTimings: Map<string, number> = new Map();
  private retryCount = 0;

  constructor(options?: QuestionDeadlineBudgetOptions) {
    this.startTime = options?.submittedAt ?? Date.now();
    this.totalBudgetMs = options?.totalBudgetMs ?? 55_000;
    this.reserveMs = options?.reserveMs ?? 12_000;
    this.maxDatabaseTimeoutMs = options?.maxDatabaseTimeoutMs ?? 20_000;
    this.minRetryRemainingMs = options?.minRetryRemainingMs ?? 15_000;
    this.abortController = new AbortController();

    const elapsedSoFar = Date.now() - this.startTime;
    const remainingInitialMs = Math.max(0, this.totalBudgetMs - elapsedSoFar);

    if (remainingInitialMs <= 0) {
      this.abortController.abort(new Error(`Whole-question budget exceeded ${this.totalBudgetMs}ms deadline before execution began`));
    } else {
      this.timer = setTimeout(() => {
        this.abortController.abort(new Error(`Whole-question budget exceeded ${this.totalBudgetMs}ms deadline`));
      }, remainingInitialMs);
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  getRemainingBudgetMs(): number {
    const remaining = this.totalBudgetMs - this.getElapsedMs();
    return Math.max(0, remaining);
  }

  isBudgetExceeded(): boolean {
    return this.getRemainingBudgetMs() <= 0 || this.abortController.signal.aborted;
  }

  /**
   * Derive safe statement timeout for a database query from remaining question budget,
   * preserving the reserve for subsequent synthesis and network formatting.
   */
  getDatabaseStatementTimeoutMs(): number {
    const remaining = this.getRemainingBudgetMs();
    const availableForDb = remaining - this.reserveMs;
    if (availableForDb <= 1_000) {
      return 1_000;
    }
    return Math.min(this.maxDatabaseTimeoutMs, availableForDb);
  }

  /**
   * P5-03: At most one corrective retry, and ONLY if remaining budget > 15s.
   * If remaining budget <= 15s, retry is refused to prevent cascading queue exhaustion.
   */
  canRetry(): boolean {
    if (this.retryCount >= 1) {
      return false;
    }
    if (this.isBudgetExceeded()) {
      return false;
    }
    return this.getRemainingBudgetMs() > this.minRetryRemainingMs;
  }

  consumeRetry(): boolean {
    if (!this.canRetry()) {
      return false;
    }
    this.retryCount += 1;
    return true;
  }

  getRetriesAttempted(): number {
    return this.retryCount;
  }

  recordStage(stageName: string, durationMs?: number): void {
    const duration = durationMs ?? this.getElapsedMs();
    this.stageTimings.set(stageName, duration);
  }

  getStageTimings(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [k, v] of this.stageTimings.entries()) {
      result[k] = v;
    }
    return result;
  }

  /**
   * P5-03: Uncertain replay guard.
   * Do not replay SQL whose outcome was uncertain after worker crash or statement timeout.
   */
  shouldReplayExternalOperation(isTimeoutOrCrash: boolean): boolean {
    if (isTimeoutOrCrash) {
      return false;
    }
    return this.canRetry();
  }

  cancel(reason = "Query cancelled"): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error(reason));
    }
  }

  finish(): { elapsedMs: number; stageTimings: Record<string, number> } {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return {
      elapsedMs: this.getElapsedMs(),
      stageTimings: this.getStageTimings(),
    };
  }
}
