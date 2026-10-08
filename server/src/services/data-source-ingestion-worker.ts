import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { DataSourcesService } from "./data-sources.js";
import { EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE } from "./external-database-mapping-checkpoints.js";
import { DataSourceDatabaseConfigService } from "./data-source-database-config.js";
import { DataSourceUploadSessionsService } from "./data-source-upload-sessions.js";
import { DataSourceLeaseLostError } from "./data-source-job-lease.js";

type ClaimedDataSourceJob = {
  id: string;
  companyId: string;
  dataSourceId: string;
  jobType: string;
  attempt: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
};

type DurableCsvCheckpoint = {
  version: 1 | 2;
  identityHash: string;
  tableId: string;
  byteOffset: number;
  committedRows: number;
  sourceRowsCommitted?: number;
  insertedRows?: number;
  nextBatchIndex: number;
  delimiter: string | null;
};

const LEASE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}

export class DataSourceIngestionWorker {
  private readonly owner = `datasource-${process.pid}-${randomUUID()}`;
  private readonly service: DataSourcesService;
  private readonly uploadSessions: DataSourceUploadSessionsService;
  private lastUploadSessionSweepAt = 0;
  private lastSnapshotOrphanSweepAt = 0;
  private lastPendingEmbeddingSweepAt = 0;
  private running = false;
  private activeController: AbortController | undefined;
  private cancellationRequested = false;

  constructor(private readonly db: Db, private readonly jobType = "ingest_file") {
    this.service = new DataSourcesService(db);
    this.uploadSessions = new DataSourceUploadSessionsService(db);
  }

  stop(): void {
    this.activeController?.abort();
  }

  private async pollCancellation(job: ClaimedDataSourceJob, controller: AbortController): Promise<void> {
    const result = await this.db.execute(sql<{ status: string }>`
      SELECT status FROM data_source_jobs
      WHERE id = ${job.id} AND company_id = ${job.companyId} AND data_source_id = ${job.dataSourceId}
        AND lease_owner = ${this.owner} AND attempt = ${job.attempt}
        AND status IN ('running', 'cancel_requested')
      LIMIT 1
    `);
    const row = Array.from(result as Iterable<{ status: string }>)[0];
    if (row?.status === "cancel_requested") {
      this.cancellationRequested = true;
      controller.abort();
    }
  }

  /** Claim one durable job; PostgreSQL row locks make this safe across replicas. */
  private async claim(): Promise<ClaimedDataSourceJob | null> {
    const result = await this.db.execute(sql<ClaimedDataSourceJob>`
      WITH expired_final_attempts AS (
        UPDATE data_source_jobs
        SET status = 'failed', stage = 'failed', last_error = 'Worker lease expired after final attempt',
            lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
        WHERE status = 'running' AND lease_expires_at < now() AND attempt >= max_attempts
          AND job_type = ${this.jobType}
        RETURNING data_source_id, company_id, job_type
      ), expired_cancellations AS (
        UPDATE data_source_jobs
        SET status = 'cancelled', stage = 'cancelled',
            progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('cancelledAt', now()),
            completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status = 'cancel_requested' AND lease_expires_at < now() AND job_type = ${this.jobType}
        RETURNING data_source_id, company_id, job_type
      ), expired_sources AS (
        UPDATE data_sources AS source
        SET status = 'error', updated_at = now()
        FROM expired_final_attempts AS expired
        WHERE source.id = expired.data_source_id AND source.company_id = expired.company_id
          AND expired.job_type IN ('ingest_file', 'external_db_onboarding')
        RETURNING source.id
      ), cancelled_sources AS (
        UPDATE data_sources AS source
        SET status = CASE
              WHEN source.metadata->>'reprocessingPreviousStatus' IN ('ready', 'error', 'onboarding')
                THEN source.metadata->>'reprocessingPreviousStatus'
              ELSE 'error'
            END,
            metadata = source.metadata - 'reprocessingPreviousStatus', updated_at = now()
        FROM expired_cancellations AS cancelled
        WHERE source.id = cancelled.data_source_id AND source.company_id = cancelled.company_id
          AND cancelled.job_type IN ('ingest_file', 'external_db_onboarding')
        RETURNING source.id
      ), next_job AS (
        SELECT id
        FROM data_source_jobs
        WHERE ((status = 'queued' AND available_at <= now())
           OR (status = 'running' AND lease_expires_at < now() AND attempt < max_attempts))
          AND job_type = ${this.jobType}
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE data_source_jobs AS job
      SET status = 'running',
          stage = 'starting',
          attempt = job.attempt + 1,
          lease_owner = ${this.owner},
          lease_expires_at = now() + (${LEASE_MS} * interval '1 millisecond'),
          heartbeat_at = now(),
          progress = COALESCE(job.progress, '{}'::jsonb) || jsonb_build_object('startedAt', now(), 'stage', 'starting'),
          last_error = NULL,
          updated_at = now()
      FROM next_job
      WHERE job.id = next_job.id
      RETURNING job.id, job.company_id AS "companyId", job.data_source_id AS "dataSourceId",
                job.job_type AS "jobType", job.attempt, job.max_attempts AS "maxAttempts", job.progress
    `);
    return Array.from(result as Iterable<ClaimedDataSourceJob>)[0] ?? null;
  }

  private async renew(job: ClaimedDataSourceJob): Promise<boolean> {
    const result = await this.db.execute(sql<{ id: string }>`
      UPDATE data_source_jobs
      SET lease_expires_at = now() + (${LEASE_MS} * interval '1 millisecond'),
          heartbeat_at = now(),
          updated_at = now()
      WHERE id = ${job.id} AND status IN ('running', 'cancel_requested') AND lease_owner = ${this.owner}
        AND attempt = ${job.attempt} AND lease_expires_at > clock_timestamp()
      RETURNING id
    `);
    return Array.from(result).length === 1;
  }

  private async reportProgress(
    job: ClaimedDataSourceJob,
    stage: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(stage)) throw new Error("Invalid datasource ingestion stage");
    const safeDetails: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        safeDetails[key] = value;
      } else if (key === "tableName" && typeof value === "string") {
        safeDetails.tableName = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128);
      } else if (key === "csvCheckpoint" && this.isDurableCsvCheckpoint(value)) {
        safeDetails.csvCheckpoint = value;
      } else if ((key === "targetSpace" || key === "fromSpace")
        && (value === "bge-m3" || value === "openrouter-text-embedding-3-small" || value === null)) {
        safeDetails[key] = value;
      } else if (key === "nextChunkId" && typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) {
        safeDetails.nextChunkId = value;
      } else if ((key === "targetGeneration" || key === "fromGeneration")
        && typeof value === "string" && /^[a-z0-9._:/@-]{1,256}$/i.test(value)) {
        safeDetails[key] = value;
      } else if (key === "schemaFingerprint" && typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) {
        safeDetails.schemaFingerprint = value;
      } else if (key === "modelBackend" && typeof value === "string" && /^[a-z0-9._/-]{1,80}$/i.test(value)) {
        safeDetails.modelBackend = value;
      } else if (
        (key === "schemaVersion" || key === "tablesCount" || key === "columnsCount"
          || key === "profiledTablesCount" || key === "relationsCount" || key === "connectedComponentCount")
        && typeof value === "number" && Number.isFinite(value)
      ) {
        safeDetails[key] = value;
      } else if ((key === "currentTable" || key === "checkpointStage" || key === "statusSummary") && typeof value === "string") {
        safeDetails[key] = value.slice(0, 128);
      }
    }
    const result = await this.db.execute(sql<{ id: string }>`
      UPDATE data_source_jobs
      SET stage = ${stage},
          progress = COALESCE(progress, '{}'::jsonb)
            || ${JSON.stringify(safeDetails)}::jsonb
            || jsonb_build_object('stage', ${stage}::text, 'updatedAt', now()),
          lease_expires_at = now() + (${LEASE_MS} * interval '1 millisecond'),
          heartbeat_at = now(),
          updated_at = now()
      WHERE id = ${job.id} AND company_id = ${job.companyId} AND data_source_id = ${job.dataSourceId}
        AND status = 'running' AND lease_owner = ${this.owner}
        AND attempt = ${job.attempt} AND lease_expires_at > clock_timestamp()
      RETURNING id
    `);
    if (Array.from(result).length !== 1) throw new DataSourceLeaseLostError();
  }

  private isDurableCsvCheckpoint(value: unknown): value is DurableCsvCheckpoint {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const checkpoint = value as Partial<DurableCsvCheckpoint>;
    return (checkpoint.version === 1 || checkpoint.version === 2)
      && typeof checkpoint.identityHash === "string" && /^[a-f0-9]{64}$/.test(checkpoint.identityHash)
      && typeof checkpoint.tableId === "string" && /^[0-9a-f-]{36}$/i.test(checkpoint.tableId)
      && Number.isSafeInteger(checkpoint.byteOffset) && checkpoint.byteOffset! >= 0
      && Number.isSafeInteger(checkpoint.committedRows) && checkpoint.committedRows! >= 0
      && (checkpoint.version === 1 || (Number.isSafeInteger(checkpoint.sourceRowsCommitted)
        && checkpoint.sourceRowsCommitted! >= 0 && Number.isSafeInteger(checkpoint.insertedRows)
        && checkpoint.insertedRows! >= 0))
      && Number.isSafeInteger(checkpoint.nextBatchIndex) && checkpoint.nextBatchIndex! >= 0
      && (checkpoint.delimiter === null
        || (typeof checkpoint.delimiter === "string" && [",", ";", "\t", "|"].includes(checkpoint.delimiter)));
  }

  private async finish(job: ClaimedDataSourceJob): Promise<void> {
    await this.db.transaction(async (tx) => {
      const completed = await tx.execute(sql<{ id: string }>`
        UPDATE data_source_jobs
        SET status = 'succeeded', stage = 'completed',
            progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('completedAt', now(), 'stage', 'completed'),
            completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${job.id} AND company_id = ${job.companyId} AND data_source_id = ${job.dataSourceId}
          AND status = 'running' AND lease_owner = ${this.owner}
          AND attempt = ${job.attempt} AND lease_expires_at > clock_timestamp()
        RETURNING id
      `);
      // Mapping outputs are needed for worker retries, but become dead weight
      // once the success receipt is committed. Delete them atomically with that
      // receipt so a stale worker cannot purge another attempt's recovery data.
      if (Array.from(completed).length === 1 && job.jobType === "external_db_onboarding") {
        await tx.execute(sql`
          DELETE FROM data_source_job_checkpoints
          WHERE job_id = ${job.id} AND checkpoint_type = ${EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE}
        `);
      }
    });
  }

  private async finishCancelled(job: ClaimedDataSourceJob): Promise<void> {
    await this.db.execute(sql`
      UPDATE data_source_jobs
      SET status = 'cancelled', stage = 'cancelled',
          progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('cancelledAt', now()),
          completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${job.id} AND company_id = ${job.companyId} AND data_source_id = ${job.dataSourceId}
        AND status = 'cancel_requested' AND lease_owner = ${this.owner} AND attempt = ${job.attempt}
    `);
  }

  private async fail(job: ClaimedDataSourceJob, error: unknown): Promise<void> {
    const message = safeErrorMessage(error);
    const retry = job.attempt < job.maxAttempts;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, job.attempt - 1));
    await this.db.execute(sql`
      WITH owned_failure AS (
        UPDATE data_source_jobs
        SET status = ${retry ? "queued" : "failed"},
          stage = ${retry ? "retry_wait" : "failed"},
          available_at = CASE WHEN ${retry} THEN now() + (${delaySeconds} * interval '1 second') ELSE available_at END,
          progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object('errorAt', now()),
          last_error = ${message},
          completed_at = CASE WHEN ${retry} THEN NULL ELSE now() END,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${job.id} AND company_id = ${job.companyId}
          AND data_source_id = ${job.dataSourceId} AND status = 'running' AND lease_owner = ${this.owner}
          AND attempt = ${job.attempt} AND lease_expires_at > clock_timestamp()
        RETURNING data_source_id, company_id, job_type
      )
      UPDATE data_sources AS source
      SET status = CASE WHEN owned.job_type IN ('ingest_file', 'external_db_onboarding') THEN ${retry ? "processing" : "error"} ELSE source.status END,
          metadata = CASE
            WHEN owned.job_type = 'embedding_reindex' AND NOT ${retry}
              THEN COALESCE(source.metadata, '{}'::jsonb) || jsonb_build_object(
                'embeddingStatus', CASE
                  WHEN source.metadata->>'embeddingSpace' IN ('bge-m3', 'openrouter-text-embedding-3-small')
                    AND source.metadata->>'embeddingGeneration' IS NOT NULL
                    THEN COALESCE(source.metadata->>'embeddingStatus', 'ready')
                  ELSE 'unavailable'
                END,
                'embeddingReindexStatus', 'failed',
                'embeddingFailedAt', now()
              )
            ELSE source.metadata
          END,
          updated_at = now()
      FROM owned_failure AS owned
      WHERE source.id = owned.data_source_id AND source.company_id = owned.company_id
    `);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.jobType === "ingest_file" && Date.now() - this.lastUploadSessionSweepAt > 60_000) {
        this.lastUploadSessionSweepAt = Date.now();
        await this.uploadSessions.expire(50).catch(() => {
          console.warn("[DataSourceIngestionWorker] Expired upload-session cleanup failed; retrying later");
        });
      }
      if (this.jobType === "external_db_snapshot" && Date.now() - this.lastSnapshotOrphanSweepAt > 60_000) {
        this.lastSnapshotOrphanSweepAt = Date.now();
        await this.service.reconcilePendingExternalSnapshotTargets(8).catch(() => {
          console.warn("[DataSourceSnapshotWorker] Pending ClickHouse target reconciliation failed; retrying later");
        });
      }
      await new DataSourceDatabaseConfigService(this.db).migrateLegacyBatch();
      if (this.jobType === "embedding_reindex" && Date.now() - this.lastPendingEmbeddingSweepAt > 60_000) {
        this.lastPendingEmbeddingSweepAt = Date.now();
        await this.service.reconcilePendingStructuredEmbeddingJobs(8).catch((error) => {
          console.warn("[DataSourceEmbeddingWorker] Pending schema embedding reconciliation failed; retrying later:", safeErrorMessage(error));
        });
      }
      const job = await this.claim();
      if (!job) return;
      if (
        job.jobType !== "ingest_file"
        && job.jobType !== "external_db_snapshot"
        && job.jobType !== "embedding_reindex"
        && job.jobType !== "external_db_onboarding"
      ) {
        await this.fail(job, new Error(`Unsupported datasource job type: ${job.jobType}`));
        return;
      }

      let leaseOwned = true;
      const controller = new AbortController();
      this.activeController = controller;
      this.cancellationRequested = false;
      const cancellationPoll = setInterval(() => {
        void this.pollCancellation(job, controller).catch((error) => {
          console.warn("[DataSourceIngestionWorker] Cancellation poll failed:", safeErrorMessage(error));
        });
      }, 500);
      cancellationPoll.unref?.();
      const heartbeat = setInterval(() => {
        void this.renew(job).then((renewed) => {
          if (!renewed) {
            leaseOwned = false;
            controller.abort();
          }
        }).catch((error) => {
          console.warn("[DataSourceIngestionWorker] Lease renewal failed:", safeErrorMessage(error));
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        const lease = {
          jobId: job.id,
          owner: this.owner,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          progress: job.progress,
          signal: controller.signal,
          isCancellationRequested: () => this.cancellationRequested,
          reportProgress: async (stage: string, details?: Record<string, unknown>) => {
            if (controller.signal.aborted && this.cancellationRequested) {
              throw new Error("Datasource ingestion was cancelled");
            }
            await this.reportProgress(job, stage, details);
          },
        };
        if (job.jobType === "ingest_file") {
          await this.service.reprocess(job.companyId, job.dataSourceId, lease);
        } else if (job.jobType === "external_db_snapshot") {
          await this.service.runExternalDatabaseSnapshot(job.companyId, job.dataSourceId, job.progress, lease, controller.signal);
        } else if (job.jobType === "external_db_onboarding") {
          await this.service.runExternalDatabaseOnboarding(job.companyId, job.dataSourceId, job.progress, lease, controller.signal);
        } else {
          await this.service.runEmbeddingReindex(job.companyId, job.dataSourceId, job.progress, lease);
        }
        await this.finish(job);
      } catch (error) {
        if (!this.cancellationRequested) {
          await this.pollCancellation(job, controller).catch(() => undefined);
        }
        if (this.cancellationRequested) await this.finishCancelled(job);
        else if (leaseOwned) await this.fail(job, error);
        console.error(`[DataSourceIngestionWorker] Attempt ${job.attempt} for job ${job.id} failed:`, safeErrorMessage(error));
      } finally {
        clearInterval(heartbeat);
        clearInterval(cancellationPoll);
        if (this.activeController === controller) this.activeController = undefined;
      }
    } finally {
      this.running = false;
    }
  }
}
