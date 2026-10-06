import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dataSources, dataSourceQueryJobs } from "@paperclipai/db";
import type { DataSourceQueryJob, DataSourceQueryResult } from "@paperclipai/shared";
import { conflict, forbidden, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { validateReadOnlySqlQuery } from "./database-integration.js";

export const DATA_SOURCE_QUERY_MAX_ROWS = 1_000;
export const DATA_SOURCE_QUERY_MAX_TIMEOUT_MS = 60_000;
export const DATA_SOURCE_QUERY_RESULT_MAX_BYTES = 1024 * 1024;
export const DATA_SOURCE_QUERY_RESULT_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_QUERY_JOBS_PER_SOURCE = 10;
const MAX_ACTIVE_QUERY_JOBS_PER_COMPANY = 100;

type QueryJobStatus = DataSourceQueryJob["status"];
type QueryJobRow = typeof dataSourceQueryJobs.$inferSelect;

export interface DataSourceQueryJobActor {
  type: "board" | "agent";
  id: string;
}

function publicJob(job: QueryJobRow): DataSourceQueryJob {
  return {
    id: job.id,
    companyId: job.companyId,
    dataSourceId: job.dataSourceId,
    status: job.status as QueryJobStatus,
    queryFingerprint: job.queryFingerprint,
    rowLimit: job.rowLimit,
    statementTimeoutMs: job.statementTimeoutMs,
    lastError: job.lastError,
    resultBytes: job.resultBytes,
    resultExpiresAt: job.resultExpiresAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function validateQueryParams(params: unknown): unknown[] {
  if (params === undefined) return [];
  if (!Array.isArray(params) || params.length > 200) {
    throw unprocessable("Query parameters must be an array containing at most 200 values");
  }
  for (const value of params) {
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    throw unprocessable("Query parameters must be finite numbers, strings, booleans, or null");
  }
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 64 * 1024) {
    throw unprocessable("Serialized query parameters cannot exceed 64 KiB");
  }
  return params;
}

function validateQueryRowBound(queryText: string, rowLimit: number): void {
  const limits = [...queryText.matchAll(/\blimit\s+(\d+)\b/gi)].map((match) => Number(match[1]));
  if (/\blimit\b/i.test(queryText) && limits.length === 0) {
    throw unprocessable("Durable query jobs require numeric LIMIT values when a LIMIT clause is present");
  }
  if (limits.some((limit) => !Number.isSafeInteger(limit) || limit > rowLimit)) {
    throw unprocessable(`Every SQL LIMIT must be at most rowLimit (${rowLimit})`);
  }
}

export class DataSourceQueryJobsService {
  constructor(private readonly db: Db) {}

  async enqueue(input: {
    companyId: string;
    dataSourceId: string;
    sql: string;
    params?: unknown;
    rowLimit?: number;
    statementTimeoutMs?: number;
    actor: DataSourceQueryJobActor;
  }): Promise<DataSourceQueryJob> {
    const [source] = await this.db.select({ id: dataSources.id, sourceType: dataSources.sourceType, status: dataSources.status })
      .from(dataSources)
      .where(and(eq(dataSources.id, input.dataSourceId), eq(dataSources.companyId, input.companyId)))
      .limit(1);
    if (!source) throw notFound("Data source not found");
    if (source.status !== "ready") throw conflict("Data source must be ready before a durable query can be queued");
    if (!["postgres", "mysql", "mariadb"].includes(source.sourceType)) {
      throw unprocessable("Durable query jobs currently support external PostgreSQL, MySQL, and MariaDB sources");
    }

    const queryText = validateReadOnlySqlQuery(input.sql, source.sourceType === "postgres" ? "postgresql" : "mysql");
    const rowLimit = input.rowLimit ?? 100;
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > DATA_SOURCE_QUERY_MAX_ROWS) {
      throw unprocessable(`rowLimit must be an integer from 1 to ${DATA_SOURCE_QUERY_MAX_ROWS}`);
    }
    validateQueryRowBound(queryText, rowLimit);
    const statementTimeoutMs = input.statementTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > DATA_SOURCE_QUERY_MAX_TIMEOUT_MS) {
      throw unprocessable(`statementTimeoutMs must be an integer from 1000 to ${DATA_SOURCE_QUERY_MAX_TIMEOUT_MS}`);
    }
    const queryParams = validateQueryParams(input.params);
    if (!input.actor.id || input.actor.id.length > 255) throw unprocessable("Query actor identifier is invalid");
    const queryFingerprint = createHash("sha256")
      .update(JSON.stringify({ queryText, queryParams, rowLimit, statementTimeoutMs }))
      .digest("hex");
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + statementTimeoutMs + 5 * 60_000);
    const created = await this.db.transaction(async (tx) => {
      // Serialize submissions within the company so source and company queue caps
      // remain correct across API processes without a Redis correctness dependency.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.companyId}, 0))`);
      const counts = await tx.execute(sql<{ sourceCount: string; companyCount: string }>`
        SELECT
          count(*) FILTER (WHERE data_source_id = ${input.dataSourceId}::uuid) AS "sourceCount",
          count(*) AS "companyCount"
        FROM data_source_query_jobs
        WHERE company_id = ${input.companyId}::uuid
          AND status IN ('queued', 'running', 'cancel_requested')
      `);
      const [count] = Array.from(counts as Iterable<{ sourceCount: string; companyCount: string }>);
      if (Number(count?.sourceCount ?? 0) >= MAX_ACTIVE_QUERY_JOBS_PER_SOURCE) {
        throw tooManyRequests("This datasource already has 10 active query jobs; retry after a job finishes");
      }
      if (Number(count?.companyCount ?? 0) >= MAX_ACTIVE_QUERY_JOBS_PER_COMPANY) {
        throw tooManyRequests("This company already has 100 active datasource query jobs; retry after a job finishes");
      }
      const [createdJob] = await tx.insert(dataSourceQueryJobs).values({
        companyId: input.companyId,
        dataSourceId: input.dataSourceId,
        requestedByType: input.actor.type,
        requestedById: input.actor.id,
        queryText,
        queryParams,
        queryFingerprint,
        rowLimit,
        statementTimeoutMs,
        deadlineAt,
      }).returning();
      return createdJob;
    });
    return publicJob(created);
  }

  async get(companyId: string, dataSourceId: string, jobId: string): Promise<DataSourceQueryJob> {
    const job = await this.find(companyId, dataSourceId, jobId);
    return publicJob(job);
  }

  async getResult(companyId: string, dataSourceId: string, jobId: string): Promise<DataSourceQueryResult> {
    const job = await this.find(companyId, dataSourceId, jobId);
    if (job.status !== "succeeded" || !job.result) throw conflict("Query job has no completed result", { status: job.status });
    if (!job.resultExpiresAt || job.resultExpiresAt.getTime() <= Date.now()) {
      throw notFound("Query result has expired");
    }
    return job.result as unknown as DataSourceQueryResult;
  }

  async cancel(companyId: string, dataSourceId: string, jobId: string, actor: DataSourceQueryJobActor): Promise<DataSourceQueryJob> {
    const job = await this.find(companyId, dataSourceId, jobId);
    if (job.requestedByType !== actor.type || job.requestedById !== actor.id) {
      throw forbidden("Only the actor who submitted this query job can cancel it");
    }
    await this.db.execute(sql`
      UPDATE data_source_query_jobs
      SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
          cancel_requested_at = COALESCE(cancel_requested_at, now()),
          completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END,
          query_text = CASE WHEN status = 'queued' THEN NULL ELSE query_text END,
          query_params = CASE WHEN status = 'queued' THEN '[]'::jsonb ELSE query_params END,
          updated_at = now()
      WHERE id = ${jobId}::uuid AND company_id = ${companyId}::uuid AND data_source_id = ${dataSourceId}::uuid
        AND status IN ('queued', 'running')
    `);
    return this.get(companyId, dataSourceId, jobId);
  }

  private async find(companyId: string, dataSourceId: string, jobId: string): Promise<QueryJobRow> {
    const [job] = await this.db.select().from(dataSourceQueryJobs).where(and(
      eq(dataSourceQueryJobs.id, jobId),
      eq(dataSourceQueryJobs.companyId, companyId),
      eq(dataSourceQueryJobs.dataSourceId, dataSourceId),
    )).limit(1);
    if (!job) throw notFound("Query job not found");
    return job;
  }
}
