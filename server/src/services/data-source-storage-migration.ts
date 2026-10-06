import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, dataSourceJobs, dataSources } from "@paperclipai/db";
import { storeDataSourceFile } from "./data-source-object-storage.js";

type LegacySource = Pick<typeof dataSources.$inferSelect,
  "id" | "companyId" | "sourceType" | "fileName" | "fileSize" | "mimeType" | "storagePath" | "metadata">;

export type DataSourceStorageMigrationSummary = {
  scanned: number;
  planned: number;
  migrated: number;
  skipped: number;
  conflicted: number;
  failed: number;
  issues: Array<{ sourceId: string; stage: string; reason: string; objectKey?: string }>;
};

type StoredObject = { objectKey: string; sha256: string } | null;
type StoreObject = (input: {
  companyId: string;
  fileName: string;
  contentType: string;
  filePath: string;
  objectKey: string;
  sha256: string;
}) => Promise<StoredObject>;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function allowedRoots(input: string[]): string[] {
  if (input.length === 0) throw new Error("At least one --root path is required");
  return [...new Set(input.map((root) => {
    const resolved = realpathSync(root);
    if (!statSync(resolved).isDirectory()) throw new Error("Every allowed migration root must be a directory");
    return resolved;
  }))];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function deterministicObjectKey(source: LegacySource, sha256: string): string {
  return `${source.companyId}/legacy-migration/${source.id}/${sha256}`;
}

function safeIssue(error: unknown): string {
  const candidate = error as { message?: unknown; cause?: { message?: unknown; code?: unknown }; code?: unknown };
  const detail = typeof candidate?.cause?.message === "string" ? candidate.cause.message : candidate?.message;
  const code = candidate?.cause?.code ?? candidate?.code;
  const message = `${typeof code === "string" ? `${code}: ` : ""}${typeof detail === "string" ? detail : "Unknown migration error"}`;
  return message
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(?:\/[^/\s]+){2,}/g, "[path]")
    .slice(0, 240);
}

function isLegacyLocalSource(source: LegacySource): boolean {
  if (!source.storagePath || !["csv", "excel", "rag_document"].includes(source.sourceType)) return false;
  const metadata = source.metadata as Record<string, unknown> | null;
  if (metadata?.storageBackend === "s3") return false;
  if (metadata?.storageBackend === "local_disk") return true;
  return metadata?.storageBackend == null && path.isAbsolute(source.storagePath);
}

/**
 * Copy persisted local datasource files to deterministic, verified S3 keys and
 * atomically switch only the pointer that still references the inspected file.
 * The original file is deliberately retained so operators can roll back.
 */
export class DataSourceStorageMigrationService {
  private readonly storeObject: StoreObject;

  constructor(private readonly db: Db, storeObject?: StoreObject) {
    this.storeObject = storeObject ?? (async (input) => storeDataSourceFile(input));
  }

  async run(input: { roots: string[]; apply?: boolean; limit?: number }): Promise<DataSourceStorageMigrationSummary> {
    const roots = allowedRoots(input.roots);
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit > 0))) {
      throw new Error("Migration limit must be a positive safe integer");
    }
    const summary: DataSourceStorageMigrationSummary = {
      scanned: 0, planned: 0, migrated: 0, skipped: 0, conflicted: 0, failed: 0, issues: [],
    };
    let cursor: string | undefined;
    let candidates = 0;

    while (candidates < limit) {
      const rows = await this.db.select({
        id: dataSources.id,
        companyId: dataSources.companyId,
        sourceType: dataSources.sourceType,
        fileName: dataSources.fileName,
        fileSize: dataSources.fileSize,
        mimeType: dataSources.mimeType,
        storagePath: dataSources.storagePath,
        metadata: dataSources.metadata,
      }).from(dataSources)
        .where(and(
          isNotNull(dataSources.storagePath),
          sql`${dataSources.status} IN ('ready', 'error')`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${dataSourceJobs}
            WHERE ${dataSourceJobs.companyId} = ${dataSources.companyId}
              AND ${dataSourceJobs.dataSourceId} = ${dataSources.id}
              AND ${dataSourceJobs.jobType} = 'ingest_file'
              AND ${dataSourceJobs.status} IN ('queued', 'running', 'cancel_requested')
          )`,
          cursor ? gt(dataSources.id, cursor) : undefined,
        ))
        .orderBy(asc(dataSources.id))
        .limit(100);
      if (rows.length === 0) break;

      for (const source of rows) {
        cursor = source.id;
        summary.scanned += 1;
        if (!isLegacyLocalSource(source as LegacySource)) {
          summary.skipped += 1;
          continue;
        }
        if (candidates >= limit) break;
        candidates += 1;

        let stage = "file-validation";
        let migrationObjectKey: string | undefined;
        try {
          const originalPath = source.storagePath!;
          if (!path.isAbsolute(originalPath)) throw new Error("Legacy upload path must be absolute");
          const entry = lstatSync(originalPath);
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Legacy upload must be a regular non-symlink file");
          const canonicalPath = realpathSync(originalPath);
          if (!roots.some((root) => isWithin(root, canonicalPath))) throw new Error("Legacy upload is outside the approved migration roots");
          const file = statSync(canonicalPath);
          if (file.size <= 0 || !Number.isSafeInteger(file.size)) throw new Error("Legacy upload has an invalid byte size");
          if (source.fileSize !== null && source.fileSize !== file.size) throw new Error("Legacy upload size differs from the recorded datasource size");
          const checksum = await sha256File(canonicalPath);
          const objectKey = deterministicObjectKey(source as LegacySource, checksum);
          migrationObjectKey = objectKey;
          summary.planned += 1;
          if (!input.apply) continue;

          stage = "object-upload-and-verification";
          const stored = await this.storeObject({
            companyId: source.companyId,
            fileName: source.fileName || path.basename(originalPath),
            contentType: source.mimeType || "application/octet-stream",
            filePath: canonicalPath,
            objectKey,
            sha256: checksum,
          });
          if (!stored || stored.objectKey !== objectKey || stored.sha256 !== checksum) {
            throw new Error("Object storage did not return the expected key and checksum");
          }

          stage = "database-pointer-publication";
          const changed = await this.db.transaction(async (tx) => {
            const result = await tx.execute(sql<{ id: string }>`
              UPDATE data_sources
              SET storage_path = ${objectKey},
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'storageBackend', 's3',
                    'storageSha256', ${checksum}::text,
                    'storageMigratedAt', now()
                  ),
                  updated_at = now()
              WHERE id = ${source.id}::uuid
                AND company_id = ${source.companyId}::uuid
                AND storage_path = ${originalPath}
                AND (
                  metadata->>'storageBackend' = 'local_disk'
                  OR (NOT (COALESCE(metadata, '{}'::jsonb) ? 'storageBackend') AND storage_path LIKE '/%')
                )
              RETURNING id
            `);
            const [updated] = Array.from(result as Iterable<{ id: string }>);
            if (!updated) return false;
            await tx.insert(activityLog).values({
              companyId: source.companyId,
              actorType: "system",
              actorId: "datasource-storage-migrator",
              action: "datasource.storage_migrated_to_s3",
              entityType: "data_source",
              entityId: source.id,
              details: { provider: "s3", byteSize: file.size, sha256: checksum },
            });
            return true;
          });
          if (changed) {
            summary.migrated += 1;
            continue;
          }

          const [current] = await this.db.select({ storagePath: dataSources.storagePath, metadata: dataSources.metadata })
            .from(dataSources).where(and(eq(dataSources.id, source.id), eq(dataSources.companyId, source.companyId)));
          const currentMetadata = current?.metadata as Record<string, unknown> | null;
          if (current?.storagePath === objectKey && currentMetadata?.storageBackend === "s3" && currentMetadata.storageSha256 === checksum) {
            summary.migrated += 1;
          } else {
            // Do not delete here: a concurrent migrator may still publish this key.
            summary.conflicted += 1;
            if (summary.issues.length < 100) {
              summary.issues.push({
                sourceId: source.id,
                stage: "database-pointer-publication",
                reason: "Datasource pointer changed during migration; deterministic object retained for review",
                objectKey,
              });
            }
          }
        } catch (error) {
          summary.failed += 1;
          if (summary.issues.length < 100) {
            summary.issues.push({
              sourceId: source.id,
              stage,
              reason: safeIssue(error),
              ...(migrationObjectKey ? { objectKey: migrationObjectKey } : {}),
            });
          }
        }
      }
      if (rows.length < 100) break;
    }
    return summary;
  }
}
