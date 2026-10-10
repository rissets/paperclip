import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { activityLog, agents, dataSources, heartbeatRuns, type Db } from "@paperclipai/db";
import { DataSourcesService } from "./data-sources.js";
import { EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE } from "./external-database-mapping-checkpoints.js";
import { DataSourceDatabaseConfigService } from "./data-source-database-config.js";
import { DataSourceUploadSessionsService } from "./data-source-upload-sessions.js";
import { DataSourceLeaseLostError } from "./data-source-job-lease.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

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

type ResolvedDatabaseIngestionAgent = {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

type DatabaseIngestionRun = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string;
  sourceName: string;
  sourceType: string;
  model?: string;
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
  private lastDatabaseIngestionRunReconcileAt = 0;
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
      } else if (key === "ingestionRunId" && typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) {
        safeDetails.ingestionRunId = value;
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
    Object.assign(job.progress, safeDetails, { stage });
  }

  private async resolveDatabaseIngestionAgent(job: ClaimedDataSourceJob): Promise<ResolvedDatabaseIngestionAgent> {
    const companyAgents = await this.db.select({
      id: agents.id,
      name: agents.name,
      metadata: agents.metadata,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    }).from(agents).where(sql`${agents.companyId} = ${job.companyId}`);
    const requestedId = typeof job.progress.specialistAgentId === "string" ? job.progress.specialistAgentId : null;
    const requested = requestedId ? companyAgents.find((agent) => agent.id === requestedId) : undefined;
    if (requestedId && (!requested || readBuiltInAgentMarker(requested.metadata)?.key !== "database-ingestion")) {
      throw new Error("External database onboarding is assigned to an agent other than the built-in Database Ingestion Agent");
    }
    const agent = requested ?? companyAgents.find((candidate) => readBuiltInAgentMarker(candidate.metadata)?.key === "database-ingestion");
    if (!agent) throw new Error("Required built-in Database Ingestion Agent is not provisioned for this company");
    return {
      id: agent.id,
      name: agent.name,
      metadata: agent.metadata,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
    };
  }

  private async startDatabaseIngestionRun(
    job: ClaimedDataSourceJob,
    agent: ResolvedDatabaseIngestionAgent,
  ): Promise<DatabaseIngestionRun | null> {
    const [source] = await this.db.select({ name: dataSources.name, sourceType: dataSources.sourceType })
      .from(dataSources)
      .where(sql`${dataSources.id} = ${job.dataSourceId} AND ${dataSources.companyId} = ${job.companyId}`)
      .limit(1);
    const agentMarker = readBuiltInAgentMarker(agent.metadata);
    if (!agentMarker || agentMarker.key !== "database-ingestion") {
      throw new Error("Resolved ingestion specialist is not marked as the built-in Database Ingestion Agent");
    }
    const adapterConfig = agent.adapterConfig;
    const model = typeof adapterConfig.model === "string" ? adapterConfig.model : undefined;
    const instructionsFilePath = typeof adapterConfig.instructionsFilePath === "string"
      ? adapterConfig.instructionsFilePath
      : undefined;
    const run: DatabaseIngestionRun = {
      id: randomUUID(),
      companyId: job.companyId,
      agentId: agent.id,
      agentName: agent.name,
      sourceName: source?.name ?? job.dataSourceId,
      sourceType: source?.sourceType ?? "postgres",
      model,
    };
    const now = new Date();
    try {
      await this.db.insert(heartbeatRuns).values({
        id: run.id,
        companyId: job.companyId,
        agentId: run.agentId,
        invocationSource: "on_demand",
        triggerDetail: `datasource-onboarding:${job.id}:attempt:${job.attempt}`,
        status: "running",
        runtimeMode: "builtin_ingestion",
        startedAt: now,
        resultJson: {
          dataSourceId: job.dataSourceId,
          dataSourceName: run.sourceName,
          sourceType: run.sourceType,
          jobId: job.id,
          attempt: job.attempt,
          builtInAgentKey: "database-ingestion",
          model,
          stage: "starting",
        },
      });
    } catch (error) {
      // Run telemetry should not stop ingestion, but the agent assignment still
      // must be valid before any external database request is made.
      console.warn(`[DataSourceIngestionWorker] Could not create Database Ingestion Agent run: ${safeErrorMessage(error)}`);
      return null;
    }

    Object.assign(job.progress, {
      specialistAgentId: run.agentId,
      specialistAgentName: run.agentName,
      agentModel: model,
      agentInstructions: instructionsFilePath,
      adapterType: agent.adapterType,
    });
    await this.db.update(agents).set({ lastHeartbeatAt: now }).where(sql`${agents.id} = ${run.agentId} AND ${agents.companyId} = ${job.companyId}`)
      .catch((error) => console.warn(`[DataSourceIngestionWorker] Could not update specialist activity time: ${safeErrorMessage(error)}`));
    await this.appendDatabaseIngestionRunEvent(run, "info", `[START] ${run.agentName} started external database onboarding`, {
      jobId: job.id,
      attempt: job.attempt,
      sourceType: run.sourceType,
      model,
    });
    return run;
  }

  private async appendDatabaseIngestionRunEvent(
    run: DatabaseIngestionRun,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await appendHeartbeatRunEvent(this.db, {
        companyId: run.companyId,
        runId: run.id,
        agentId: run.agentId,
        eventType: "log",
        level,
        message: message.slice(0, 1000),
        payload: payload ?? null,
      });
    } catch (error) {
      console.warn(`[DataSourceIngestionWorker] Could not append ingestion run event: ${safeErrorMessage(error)}`);
    }
  }

  private async recordDatabaseIngestionProgress(
    run: DatabaseIngestionRun,
    stage: string,
    details: Record<string, unknown> | undefined,
    emitted: Set<string>,
  ): Promise<void> {
    const checkpointStage = typeof details?.checkpointStage === "string" ? details.checkpointStage : "";
    const currentTable = typeof details?.currentTable === "string"
      ? details.currentTable.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128)
      : "";
    let key: string | null = null;
    let level: "info" | "warn" = "info";
    let message = "";
    if (stage === "connectivity") {
      key = stage;
      message = "Checking the external database connection with the configured read-only credentials";
    } else if (stage === "discovery") {
      key = stage;
      message = "Connection verified; discovering schemas, tables, columns, row counts, and declared relations";
    } else if (stage === "column_profiling") {
      key = stage;
      message = `Catalog profiling completed for ${Number(details?.tablesCount ?? 0)} tables and ${Number(details?.columnsCount ?? 0)} columns`;
    } else if (stage === "table_mapping" && checkpointStage === "mapping_batch") {
      key = "ai_mapping_started";
      message = `Database Ingestion Agent is semantically mapping ${currentTable || "the discovered schema"}${run.model ? ` with ${run.model}` : ""}`;
    } else if (stage === "table_mapping" && ["batch_timeout", "batch_fallback", "batch_validation_fallback", "table_budget_exhausted", "batch_result_too_large"].includes(checkpointStage)) {
      key = `${checkpointStage}:${currentTable}`;
      level = "warn";
      message = `Semantic mapping used deterministic JEV metadata for ${currentTable || "a database table"} (${checkpointStage})`;
    } else if (stage === "relation_verification") {
      key = stage;
      message = "Verifying declared and evidence-backed relationships between discovered tables";
    } else if (stage === "publication") {
      key = stage;
      message = "Publishing the validated schema map and preparing schema-vector indexing";
    }
    if (!key || emitted.has(key) || emitted.size >= 200) return;
    emitted.add(key);
    await this.appendDatabaseIngestionRunEvent(run, level, `[${stage.toUpperCase()}] ${message}`, {
      stage,
      ...(checkpointStage ? { checkpointStage } : {}),
      ...(currentTable ? { currentTable } : {}),
    });
  }

  private async finishDatabaseIngestionRun(
    job: ClaimedDataSourceJob,
    run: DatabaseIngestionRun,
    status: "succeeded" | "failed" | "cancelled",
    error?: unknown,
  ): Promise<void> {
    const finishedAt = new Date();
    const failure = error === undefined ? null : safeErrorMessage(error);
    try {
      const updated = await this.db.update(heartbeatRuns).set({
        status,
        finishedAt,
        error: failure,
        resultJson: {
          dataSourceId: job.dataSourceId,
          dataSourceName: run.sourceName,
          sourceType: run.sourceType,
          jobId: job.id,
          attempt: job.attempt,
          builtInAgentKey: "database-ingestion",
          model: run.model,
          stage: status,
          ...(failure ? { error: failure } : {}),
        },
        updatedAt: finishedAt,
      }).where(sql`${heartbeatRuns.id} = ${run.id} AND ${heartbeatRuns.companyId} = ${job.companyId} AND ${heartbeatRuns.agentId} = ${run.agentId} AND ${heartbeatRuns.status} = 'running'`)
        .returning({ id: heartbeatRuns.id });
      if (updated.length === 0) return;

      if (status === "succeeded") {
        await this.appendDatabaseIngestionRunEvent(run, "info", `[COMPLETE] ${run.agentName} finished database onboarding for '${run.sourceName}'`, {
          dataSourceId: job.dataSourceId,
          attempt: job.attempt,
        });
        try {
          await this.db.insert(activityLog).values({
            companyId: job.companyId,
            actorType: "agent",
            actorId: run.agentId,
            agentId: run.agentId,
            runId: run.id,
            action: "data_source.onboarded.database",
            entityType: "data_source",
            entityId: job.dataSourceId,
            details: {
              name: run.sourceName,
              dataSourceName: run.sourceName,
              sourceType: run.sourceType,
              jobId: job.id,
              builtInAgentKey: "database-ingestion",
              description: `${run.agentName} onboarded and semantically mapped external database '${run.sourceName}'.`,
            },
          });
        } catch (activityError) {
          console.warn(`[DataSourceIngestionWorker] Could not write ingestion activity: ${safeErrorMessage(activityError)}`);
        }
      } else {
        await this.appendDatabaseIngestionRunEvent(run, status === "failed" ? "error" : "warn", `[${status.toUpperCase()}] ${failure || "Database onboarding did not complete"}`, {
          dataSourceId: job.dataSourceId,
          attempt: job.attempt,
        });
      }
    } catch (recordError) {
      console.warn(`[DataSourceIngestionWorker] Could not finalize Database Ingestion Agent run: ${safeErrorMessage(recordError)}`);
    }
  }

  private async reconcileDatabaseIngestionRuns(): Promise<number> {
    const restoreFalseProcessLoss = sql`run.status = 'failed' AND run.error_code = 'process_lost'
      AND job.status = 'running' AND job.lease_expires_at > now()
      AND CASE
        WHEN run.result_json->>'attempt' ~ '^[0-9]{1,9}$' THEN (run.result_json->>'attempt')::integer
        ELSE 0
      END = job.attempt`;
    const result = await this.db.execute(sql`
      UPDATE heartbeat_runs AS run
      SET status = CASE
            WHEN ${restoreFalseProcessLoss} THEN 'running'
            WHEN job.status = 'succeeded' THEN 'succeeded'
            WHEN job.status = 'cancelled'
              OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now()) THEN 'cancelled'
            WHEN job.status = 'failed'
              OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts) THEN 'failed'
            ELSE 'interrupted'
          END,
          finished_at = CASE
            WHEN ${restoreFalseProcessLoss} THEN NULL
            ELSE now()
          END,
          error = CASE
            WHEN ${restoreFalseProcessLoss} OR job.status = 'succeeded' THEN NULL
            WHEN job.status = 'cancelled'
              OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now())
              THEN 'Datasource ingestion job was cancelled before its agent run was finalized'
            WHEN job.status = 'failed'
              OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts)
              THEN 'Datasource ingestion job ended before its agent run was finalized'
            ELSE 'Datasource worker lease expired or was superseded by a later attempt'
          END,
          error_code = CASE
            WHEN ${restoreFalseProcessLoss} OR job.status = 'succeeded' THEN NULL
            WHEN job.status = 'cancelled'
              OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now()) THEN 'datasource_job_cancelled'
            WHEN job.status = 'failed'
              OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts) THEN 'datasource_job_failed'
            ELSE 'datasource_worker_lease_expired'
          END,
          liveness_state = CASE
            WHEN ${restoreFalseProcessLoss} THEN 'running'
            WHEN job.status = 'succeeded' THEN 'succeeded'
            WHEN job.status = 'failed'
              OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts) THEN 'failed'
            WHEN job.status = 'cancelled'
              OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now()) THEN 'cancelled'
            ELSE 'interrupted'
          END,
          liveness_reason = CASE
            WHEN ${restoreFalseProcessLoss} THEN NULL
            WHEN job.status = 'succeeded' THEN NULL
            ELSE 'datasource_job_reconciled'
          END,
          result_json = CASE
            WHEN ${restoreFalseProcessLoss} THEN
                (COALESCE(run.result_json, '{}'::jsonb) - 'processLossDiagnostic' - 'stopReason' - 'error')
                || jsonb_build_object(
                  'stage', COALESCE(job.progress->>'stage', run.result_json->>'stage', 'starting'),
                  'recoveredAfterDatasourceLeaseCheck', true
                )
            ELSE COALESCE(run.result_json, '{}'::jsonb) || jsonb_build_object(
            'stage', CASE
              WHEN job.status = 'succeeded' THEN 'succeeded'
              WHEN job.status = 'cancelled'
                OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now()) THEN 'cancelled'
              WHEN job.status = 'failed'
                OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts) THEN 'failed'
              ELSE 'interrupted'
            END,
            'stopReason', CASE
              WHEN job.status = 'succeeded' THEN NULL
              WHEN job.status = 'cancelled'
                OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now()) THEN 'datasource_job_cancelled'
              WHEN job.status = 'failed'
                OR (job.status = 'running' AND job.lease_expires_at <= now() AND job.attempt >= job.max_attempts) THEN 'datasource_job_failed'
              ELSE 'datasource_worker_lease_expired'
            END
          )
          END,
          updated_at = now()
      FROM data_source_jobs AS job
      WHERE run.runtime_mode = 'builtin_ingestion'
        AND run.result_json->>'jobId' = job.id::text
        AND (
          (run.status = 'running' AND (
            job.status IN ('succeeded', 'failed', 'cancelled', 'queued')
            OR (job.status = 'running' AND (
            job.lease_expires_at IS NULL OR job.lease_expires_at <= now()
            OR CASE
              WHEN run.result_json->>'attempt' ~ '^[0-9]{1,9}$' THEN (run.result_json->>'attempt')::integer
              ELSE 0
            END < job.attempt
          ))
            OR (job.status = 'cancel_requested' AND job.lease_expires_at <= now())
          ))
          OR (${restoreFalseProcessLoss})
        )
      RETURNING run.id
    `);
    return Array.from(result as Iterable<{ id: string }>).length;
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
      if (Array.from(completed).length !== 1) throw new DataSourceLeaseLostError();
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
      if (this.jobType === "external_db_onboarding" && Date.now() - this.lastDatabaseIngestionRunReconcileAt > 15_000) {
        this.lastDatabaseIngestionRunReconcileAt = Date.now();
        await this.reconcileDatabaseIngestionRuns().catch((error) => {
          console.warn("[DatasourceExternalDbWorker] Database Ingestion Agent run reconciliation failed; retrying later:", safeErrorMessage(error));
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
      let ingestionRun: DatabaseIngestionRun | null = null;
      const emittedRunProgress = new Set<string>();
      try {
        if (job.jobType === "external_db_onboarding") {
          const specialist = await this.resolveDatabaseIngestionAgent(job);
          const config = specialist.adapterConfig;
          Object.assign(job.progress, {
            specialistAgentId: specialist.id,
            specialistAgentName: specialist.name,
            agentModel: typeof config.model === "string" ? config.model : undefined,
            agentInstructions: typeof config.instructionsFilePath === "string" ? config.instructionsFilePath : undefined,
            adapterType: specialist.adapterType,
          });
          ingestionRun = await this.startDatabaseIngestionRun(job, specialist);
          if (ingestionRun) {
            await this.reportProgress(job, "agent_run_started", { ingestionRunId: ingestionRun.id });
          }
        }
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
            if (ingestionRun) {
              await this.recordDatabaseIngestionProgress(ingestionRun, stage, details, emittedRunProgress);
            }
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
        if (ingestionRun) await this.finishDatabaseIngestionRun(job, ingestionRun, "succeeded");
      } catch (error) {
        if (!this.cancellationRequested) {
          await this.pollCancellation(job, controller).catch(() => undefined);
        }
        if (this.cancellationRequested) {
          if (ingestionRun) await this.finishDatabaseIngestionRun(job, ingestionRun, "cancelled", error);
          await this.finishCancelled(job);
        } else {
          if (ingestionRun) await this.finishDatabaseIngestionRun(job, ingestionRun, "failed", error);
          if (leaseOwned) await this.fail(job, error);
        }
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
