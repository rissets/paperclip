/** Poll independently of the API scheduler; never overlap ingestion ticks. */
export class DataSourceWorkerRuntime {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private lastSuccess = 0;
  private failed = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly pollMs: number,
    private readonly onError: (error: unknown) => void,
  ) {
    if (!Number.isFinite(pollMs) || pollMs < 100 || pollMs > 60_000) {
      throw new Error("Datasource worker polling must be between 100 and 60000 milliseconds");
    }
  }

  start(): void {
    if (this.stopped || this.active || this.timer) return;
    this.active = Promise.resolve().then(this.tick).then(() => {
      this.lastSuccess = Date.now();
      this.failed = false;
      this.consecutiveFailures = 0;
    }).catch((error: unknown) => {
      this.failed = true;
      this.consecutiveFailures += 1;
      this.onError(error);
    }).finally(() => {
      this.active = undefined;
      if (!this.stopped) {
        const backoffMs = this.failed
          ? Math.min(this.pollMs * 2 ** Math.min(this.consecutiveFailures - 1, 6), 60_000)
          : this.pollMs;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.start();
        }, backoffMs);
      }
    });
  }

  health(): { ready: boolean; busy: boolean; lastSuccessfulPollAt: number | null } {
    return {
      ready: !this.stopped && !this.failed && (this.lastSuccess > 0 || !!this.active),
      busy: !!this.active,
      lastSuccessfulPollAt: this.lastSuccess || null,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
