import { randomUUID } from "node:crypto";
import type { DataSourceQueryTrace, DataSourceStageTimings } from "@paperclipai/shared";

export class DataSourceQueryTracer {
  private startTime: number;
  private preflightMs?: number;
  private retrievalMs?: number;
  private planningMs?: number;
  private validationMs?: number;
  private databaseExecutionMs?: number;
  private synthesisMs?: number;

  public readonly traceId: string;
  public readonly companyId: string;
  public readonly query: string;
  public readonly agentId?: string;
  public readonly runId?: string;
  public readonly sessionId?: string;

  constructor(input: {
    companyId: string;
    query: string;
    traceId?: string;
    agentId?: string;
    runId?: string;
    sessionId?: string;
  }) {
    this.startTime = Date.now();
    this.traceId = input.traceId || `ds-trace-${randomUUID()}`;
    this.companyId = input.companyId;
    this.query = input.query;
    this.agentId = input.agentId;
    this.runId = input.runId;
    this.sessionId = input.sessionId;
  }

  markPreflight(durationMs: number): this {
    this.preflightMs = durationMs;
    return this;
  }

  markRetrieval(durationMs: number): this {
    this.retrievalMs = durationMs;
    return this;
  }

  markPlanning(durationMs: number): this {
    this.planningMs = durationMs;
    return this;
  }

  markValidation(durationMs: number): this {
    this.validationMs = durationMs;
    return this;
  }

  markExecution(durationMs: number): this {
    this.databaseExecutionMs = durationMs;
    return this;
  }

  markSynthesis(durationMs: number): this {
    this.synthesisMs = durationMs;
    return this;
  }

  buildTimings(): DataSourceStageTimings {
    const totalMs = Date.now() - this.startTime;
    return {
      preflightMs: this.preflightMs,
      retrievalMs: this.retrievalMs,
      planningMs: this.planningMs,
      validationMs: this.validationMs,
      databaseExecutionMs: this.databaseExecutionMs,
      synthesisMs: this.synthesisMs,
      totalMs,
    };
  }

  finish(input: {
    engine?: DataSourceQueryTrace["engine"];
    cacheHit?: boolean;
    outcome: DataSourceQueryTrace["outcome"];
    errorMessage?: string;
  }): DataSourceQueryTrace {
    const trace: DataSourceQueryTrace = {
      traceId: this.traceId,
      companyId: this.companyId,
      query: this.query,
      agentId: this.agentId,
      runId: this.runId,
      sessionId: this.sessionId,
      engine: input.engine || "fast_path",
      cacheHit: input.cacheHit ?? false,
      timings: this.buildTimings(),
      outcome: input.outcome,
      errorMessage: input.errorMessage,
      createdAt: new Date().toISOString(),
    };
    dataSourceTraceStore.record(trace);
    return trace;
  }
}

class DataSourceTraceStore {
  private traces: DataSourceQueryTrace[] = [];
  private maxTraces = 1000;

  record(trace: DataSourceQueryTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
  }

  getTraces(companyId: string, limit = 50): DataSourceQueryTrace[] {
    return this.traces
      .filter((t) => t.companyId === companyId)
      .slice(-limit)
      .reverse();
  }

  getTrace(traceId: string): DataSourceQueryTrace | undefined {
    return this.traces.find((t) => t.traceId === traceId);
  }

  clear(): void {
    this.traces = [];
  }
}

export const dataSourceTraceStore = new DataSourceTraceStore();
