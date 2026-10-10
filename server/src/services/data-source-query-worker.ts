import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { DataSourcesService } from "./data-sources.js";
import {
  DATA_SOURCE_QUERY_RESULT_MAX_BYTES,
  DATA_SOURCE_QUERY_RESULT_TTL_MS,
} from "./data-source-query-jobs.js";
import { isExternalQueryAbortError } from "./external-query-abort.js";
import { redactSensitiveText } from "../redaction.js";

type ClaimedQueryJob = {
  id: string;
  companyId: string;
  dataSourceId: string;
  queryText: string;
  queryParams: unknown[];
  rowLimit: number;
  statementTimeoutMs: number;
  queryFingerprint: string;
  leaseExpiresAt: Date;
};

type AbortKind = "cancelled" | "deadline" | "worker_stopping" | "lease_lost" | "control_unavailable" | null;

const QUERY_JOB_LEASE_MS = 120_000;
const QUERY_CONTROL_POLL_MS = 500;

function dateMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function safeFailure(error: unknown, abortKind: AbortKind): string {
  if (abortKind === "cancelled") return "Query was cancelled by request.";
  if (abortKind === "deadline") return "Query exceeded its execution deadline.";
  if (abortKind === "worker_stopping") return "Worker stopped before the query completed; submit a new job to retry.";
  if (abortKind === "lease_lost") return "Worker lease expired before the query completed; submit a new job to retry.";
  if (abortKind === "control_unavailable") return "Query was stopped because job control could not be confirmed.";
  if (isExternalQueryAbortError(error)) return "External database query was cancelled.";
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out|statement.*deadline|max_statement_time|max_execution_time/i.test(message)) {
    return "External query exceeded its execution deadline (max_statement_time exceeded). On large tables, avoid leading wildcards (e.g. LIKE '%term%') which cause full table scans; use prefix search (LIKE 'term%') or exact match instead.";
  }
  if (/concurrent query limit|admission is unavailable/i.test(message)) return "External datasource is busy; submit a new query job to retry.";
  return "External database rejected or failed to execute the query.";
}

function jsonSafeResult(value: unknown): string {
  const json = JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry);
  if (typeof json !== "string") throw new Error("Query result could not be serialized");
  return json;
}

export class DataSourceQueryWorker {
  private readonly owner = `datasource-query-${process.pid}-${randomUUID()}`;
  private readonly service: DataSourcesService;
  private running = false;
  private stopping = false;
  private activeController: AbortController | undefined;
  private abortKind: AbortKind = null;
  private lastFailureLog = "";
  private lastFailureLogAt = 0;
  private suppressedFailureLogs = 0;

  constructor(private readonly db: Db) {
    this.service = new DataSourcesService(db);
  }

  private async claim(): Promise<ClaimedQueryJob | null> {
    const result = await this.db.execute(sql<ClaimedQueryJob>`
      WITH expired_results AS (
        UPDATE data_source_query_jobs
        SET result = NULL, result_bytes = NULL, result_expires_at = NULL, updated_at = now()
        WHERE result_expires_at <= now() AND result IS NOT NULL
        RETURNING id
      ), expired_queued AS (
        UPDATE data_source_query_jobs
        SET status = 'failed', last_error = 'Query job expired before it was claimed',
            query_text = NULL, query_params = '[]'::jsonb, completed_at = now(), updated_at = now()
        WHERE status = 'queued' AND deadline_at <= now()
        RETURNING id
      ), expired_running AS (
        UPDATE data_source_query_jobs
        SET status = 'failed', last_error = 'Worker lease expired; query outcome is uncertain. Submit a new job to retry.',
            query_text = NULL, query_params = '[]'::jsonb,
            lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
        WHERE status IN ('running', 'cancel_requested') AND lease_expires_at <= now()
        RETURNING id
      ), next_job AS (
        SELECT id FROM data_source_query_jobs
        WHERE status = 'queued' AND deadline_at > now()
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE data_source_query_jobs AS job
      SET status = 'running', lease_owner = ${this.owner},
          lease_expires_at = now() + (${QUERY_JOB_LEASE_MS} * interval '1 millisecond'),
          heartbeat_at = now(), updated_at = now()
      FROM next_job
      WHERE job.id = next_job.id
      RETURNING job.id, job.company_id AS "companyId", job.data_source_id AS "dataSourceId",
        job.query_text AS "queryText", job.query_params AS "queryParams",
        job.row_limit AS "rowLimit", job.statement_timeout_ms AS "statementTimeoutMs",
        job.query_fingerprint AS "queryFingerprint", job.lease_expires_at AS "leaseExpiresAt"
    `);
    return Array.from(result as Iterable<ClaimedQueryJob>)[0] ?? null;
  }

  private async readControl(job: ClaimedQueryJob, controller: AbortController): Promise<void> {
    const result = await this.db.execute(sql<{
      status: string;
      cancelRequestedAt: Date | null;
      deadlineAt: Date;
      leaseExpiresAt: Date | null;
      leaseOwner: string | null;
    }>`
      SELECT status, cancel_requested_at AS "cancelRequestedAt", deadline_at AS "deadlineAt",
        lease_expires_at AS "leaseExpiresAt", lease_owner AS "leaseOwner"
      FROM data_source_query_jobs WHERE id = ${job.id}::uuid
    `);
    const row = Array.from(result as Iterable<{
      status: string;
      cancelRequestedAt: Date | null;
      deadlineAt: Date;
      leaseExpiresAt: Date | null;
      leaseOwner: string | null;
    }>)[0];
    if (!row || row.leaseOwner !== this.owner || !row.leaseExpiresAt || dateMillis(row.leaseExpiresAt) <= Date.now()) {
      this.abortKind = "lease_lost";
      controller.abort();
      return;
    }
    if (row.status === "cancel_requested" || row.cancelRequestedAt) {
      this.abortKind = "cancelled";
      controller.abort();
      return;
    }
    if (dateMillis(row.deadlineAt) <= Date.now()) {
      this.abortKind = "deadline";
      controller.abort();
    }
  }

  private async finishSuccess(job: ClaimedQueryJob, resultValue: unknown): Promise<void> {
    const json = jsonSafeResult(resultValue);
    const resultBytes = Buffer.byteLength(json, "utf8");
    if (resultBytes > DATA_SOURCE_QUERY_RESULT_MAX_BYTES) {
      throw new Error("Query result exceeds the 1 MiB durable result limit");
    }
    await this.db.execute(sql`
      UPDATE data_source_query_jobs
      SET status = 'succeeded', result = ${json}::jsonb, result_bytes = ${resultBytes},
          result_expires_at = now() + (${DATA_SOURCE_QUERY_RESULT_TTL_MS} * interval '1 millisecond'),
          query_text = NULL, query_params = '[]'::jsonb,
          last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
          completed_at = now(), updated_at = now()
      WHERE id = ${job.id}::uuid AND company_id = ${job.companyId}::uuid
        AND data_source_id = ${job.dataSourceId}::uuid AND status = 'running'
        AND lease_owner = ${this.owner} AND lease_expires_at > clock_timestamp()
    `);
  }

  private async finishAborted(job: ClaimedQueryJob, error?: unknown): Promise<void> {
    const cancelled = this.abortKind === "cancelled";
    const status = cancelled ? "cancelled" : "failed";
    const lastError = safeFailure(error, this.abortKind);
    await this.db.execute(sql`
      UPDATE data_source_query_jobs
      SET status = ${status}, last_error = ${lastError}, query_text = NULL,
          query_params = '[]'::jsonb, lease_owner = NULL, lease_expires_at = NULL,
          completed_at = now(), updated_at = now()
      WHERE id = ${job.id}::uuid AND company_id = ${job.companyId}::uuid
        AND data_source_id = ${job.dataSourceId}::uuid AND status IN ('running', 'cancel_requested')
        AND lease_owner = ${this.owner}
    `);
  }

  private logQueryFailure(error: unknown, timedOut: boolean): void {
    const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown query failure");
    const message = /\b53300\b|too many clients/i.test(rawMessage)
      ? "external PostgreSQL connection limit reached"
      : redactSensitiveText(rawMessage).replace(/\s+/g, " ").slice(0, 300) || "query failed";
    const logKey = `${timedOut ? "timeout" : "failure"}:${message}`;
    const now = Date.now();
    if (logKey === this.lastFailureLog && now - this.lastFailureLogAt < 60_000) {
      this.suppressedFailureLogs += 1;
      return;
    }
    const repeated = this.suppressedFailureLogs > 0
      ? ` (${this.suppressedFailureLogs} duplicate failures suppressed)`
      : "";
    const log = timedOut ? console.warn : console.error;
    log(`[DataSourceQueryWorker] ${timedOut ? "Query cancelled or timed out" : "Query failed"}: ${message}${repeated}`);
    this.lastFailureLog = logKey;
    this.lastFailureLogAt = now;
    this.suppressedFailureLogs = 0;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const job = await this.claim();
      if (!job) return;
      if (!job.queryText) {
        await this.finishAborted(job, new Error("Query text missing from claimed job"));
        return;
      }

      const controller = new AbortController();
      this.activeController = controller;
      this.abortKind = null;
      const poll = setInterval(() => {
        void this.readControl(job, controller).catch(() => {
          this.abortKind = "control_unavailable";
          controller.abort();
        });
      }, QUERY_CONTROL_POLL_MS);
      poll.unref?.();
      try {
        await this.readControl(job, controller);
        const result = await this.service.querySql(
          job.companyId,
          job.dataSourceId,
          job.queryText,
          job.rowLimit,
          controller.signal,
          { params: job.queryParams, statementTimeoutMs: job.statementTimeoutMs },
        );
        if (controller.signal.aborted) {
          await this.finishAborted(job);
          return;
        }
        const durableResult = {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: result.executionTimeMs,
        };
        await this.finishSuccess(job, durableResult);
      } catch (error) {
        const isTimeoutOrCancel = /cancel|timeout|timed out|statement.*deadline|max_statement_time|max_execution_time/i.test(
          error instanceof Error ? error.message : String(error),
        );
        if (isTimeoutOrCancel) {
          this.logQueryFailure(error, true);
        } else {
          this.logQueryFailure(error, false);
        }
        await this.finishAborted(job, error);
      } finally {
        clearInterval(poll);
        this.activeController = undefined;
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.activeController && !this.activeController.signal.aborted) {
      this.abortKind = "worker_stopping";
      this.activeController.abort();
    }
  }
}
