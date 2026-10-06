import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export interface DataSourceJobLease {
  jobId: string;
  owner: string;
  attempt: number;
  maxAttempts?: number;
  progress?: Record<string, unknown>;
  isCancellationRequested?: () => boolean;
  reportProgress?: (stage: string, details?: Record<string, unknown>) => Promise<void>;
  signal?: AbortSignal;
}

export class DataSourceLeaseLostError extends Error {
  constructor() { super("Datasource ingestion ownership was lost; stale publication and cleanup are denied"); }
}

/** Must run inside the same transaction as the protected source mutations. */
export async function assertDataSourceJobLease(
  tx: Pick<Db, "execute">,
  companyId: string,
  sourceId: string,
  lease: DataSourceJobLease,
  options: { allowCancelRequested?: boolean } = {},
): Promise<void> {
  if (!lease) throw new DataSourceLeaseLostError();
  const result = await tx.execute(sql<{ id: string }>`
    SELECT id FROM data_source_jobs
    WHERE id = ${lease.jobId} AND company_id = ${companyId} AND data_source_id = ${sourceId}
      AND status ${options.allowCancelRequested ? sql`IN ('running', 'cancel_requested')` : sql`= 'running'`}
      AND lease_owner = ${lease.owner} AND attempt = ${lease.attempt}
      AND lease_expires_at > clock_timestamp()
    FOR UPDATE
  `);
  if (Array.from(result).length !== 1) throw new DataSourceLeaseLostError();
}

/** Publication and the succeeded receipt commit together, preventing a takeover between them. */
export async function completeDataSourceJobLease(
  tx: Pick<Db, "execute">, companyId: string, sourceId: string, lease: DataSourceJobLease,
): Promise<void> {
  if (!lease) throw new DataSourceLeaseLostError();
  const result = await tx.execute(sql<{ id: string }>`
    UPDATE data_source_jobs
    SET status = 'succeeded', stage = 'completed',
        progress = progress || jsonb_build_object('completedAt', now(), 'stage', 'completed'), completed_at = now(),
        lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = ${lease.jobId} AND company_id = ${companyId} AND data_source_id = ${sourceId}
      AND status = 'running' AND lease_owner = ${lease.owner} AND attempt = ${lease.attempt}
      AND lease_expires_at > clock_timestamp()
    RETURNING id
  `);
  if (Array.from(result).length !== 1) throw new DataSourceLeaseLostError();
}
