import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dataSources, dataSourceTables } from "@paperclipai/db";
import { DataSourceDatabaseConfigService } from "./data-source-database-config.js";
import { DataSourcesService } from "./data-sources.js";
import { DataSourceVectorStore } from "./data-source-vector-store.js";
import { readDataSourceObjectHead } from "./data-source-object-storage.js";
import { stat } from "node:fs/promises";

export type DataSourceRestoreIssue = {
  severity: "error" | "warning";
  sourceId: string;
  check: "file_object" | "local_file" | "external_snapshot" | "database_credential" | "rag_vectors";
  code: string;
};

export type DataSourceRestoreReport = {
  checked: {
    sources: number;
    objects: number;
    localFiles: number;
    snapshots: number;
    credentials: number;
    ragIndexes: number;
  };
  skipped: number;
  issues: DataSourceRestoreIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function compareRestoredFile(input: {
  expectedBytes: number | null;
  expectedSha256?: string;
  actualBytes?: number;
  actualSha256?: string;
  exists: boolean;
}): string[] {
  const issues: string[] = [];
  if (!input.exists) return ["file_missing"];
  if (input.expectedBytes !== null && input.actualBytes !== undefined && input.expectedBytes !== input.actualBytes) {
    issues.push("file_size_mismatch");
  }
  if (input.expectedSha256) {
    if (!input.actualSha256) issues.push("file_checksum_unverifiable");
    else if (input.expectedSha256 !== input.actualSha256) issues.push("file_checksum_mismatch");
  }
  return issues;
}

export function compareRestoredRowCount(expected: unknown, actual: unknown): string[] {
  const parseCount = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const expectedCount = parseCount(expected);
  const actualCount = parseCount(actual);
  if (expectedCount === null || actualCount === null) {
    return ["snapshot_row_count_unavailable"];
  }
  return expectedCount === actualCount ? [] : ["snapshot_row_count_mismatch"];
}

export function compareRestoredEmbeddingCoverage(input: {
  chunkCount: number;
  embeddingCount: number;
  available: boolean;
}): string[] {
  if (input.chunkCount === 0) return [];
  if (!input.available) return ["rag_vector_store_unavailable"];
  return input.chunkCount === input.embeddingCount ? [] : ["rag_embedding_coverage_mismatch"];
}

/** Read-only application-level reconciliation after restoring PostgreSQL and data-plane volumes. */
export async function verifyDataSourceRestore(db: Db, options?: { batchSize?: number }): Promise<DataSourceRestoreReport> {
  const batchSize = Math.max(1, Math.min(500, Math.floor(options?.batchSize ?? 100)));
  const report: DataSourceRestoreReport = {
    checked: { sources: 0, objects: 0, localFiles: 0, snapshots: 0, credentials: 0, ragIndexes: 0 },
    skipped: 0,
    issues: [],
  };
  const dbConfigs = new DataSourceDatabaseConfigService(db);
  const dataSourceQueries = new DataSourcesService(db);
  const vectors = new DataSourceVectorStore(db);
  let afterId: string | undefined;

  while (true) {
    const page = await db.select().from(dataSources)
      .where(afterId
        ? and(gt(dataSources.id, afterId), inArray(dataSources.sourceType, ["csv", "excel", "rag_document", "postgres", "mysql", "mariadb"]))
        : inArray(dataSources.sourceType, ["csv", "excel", "rag_document", "postgres", "mysql", "mariadb"]))
      .orderBy(asc(dataSources.id))
      .limit(batchSize);
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;

    for (const source of page) {
      report.checked.sources += 1;
      const metadata = isRecord(source.metadata) ? source.metadata : {};
      const fileSource = ["csv", "excel", "rag_document"].includes(source.sourceType);
      if (fileSource) {
        if (!source.storagePath) {
          if (source.status === "ready") {
            report.issues.push({ severity: "error", sourceId: source.id, check: "local_file", code: "file_pointer_missing" });
          } else report.skipped += 1;
        } else if (metadata.storageBackend === "s3") {
          report.checked.objects += 1;
          try {
            const head = await readDataSourceObjectHead(source.companyId, source.storagePath);
            const codes = compareRestoredFile({
              exists: head.exists,
              expectedBytes: source.fileSize,
              expectedSha256: typeof metadata.storageSha256 === "string" ? metadata.storageSha256 : undefined,
              actualBytes: head.contentLength,
              actualSha256: head.sha256,
            });
            for (const code of codes) {
              report.issues.push({
                severity: code === "file_checksum_unverifiable" ? "warning" : "error",
                sourceId: source.id,
                check: "file_object",
                code,
              });
            }
          } catch {
            report.issues.push({ severity: "error", sourceId: source.id, check: "file_object", code: "object_storage_unavailable" });
          }
        } else {
          report.checked.localFiles += 1;
          try {
            const fileStat = await stat(source.storagePath);
            for (const code of compareRestoredFile({
              exists: fileStat.isFile(),
              expectedBytes: source.fileSize,
              actualBytes: fileStat.size,
            })) {
              report.issues.push({ severity: "error", sourceId: source.id, check: "local_file", code });
            }
          } catch {
            report.issues.push({ severity: "error", sourceId: source.id, check: "local_file", code: "file_missing" });
          }
        }
      }

      if (["postgres", "mysql", "mariadb"].includes(source.sourceType)) {
        const rawConfig = isRecord(metadata.rawConfig) ? metadata.rawConfig : {};
        if (typeof metadata.credentialSecretId === "string") {
          report.checked.credentials += 1;
          try {
            // The resolved password is intentionally held only in memory and never added to the report.
            await dbConfigs.resolve(source.companyId, source);
          } catch {
            report.issues.push({ severity: "error", sourceId: source.id, check: "database_credential", code: "managed_credential_unavailable" });
          }
        } else if (typeof rawConfig.password === "string") {
          report.checked.credentials += 1;
          report.issues.push({ severity: "error", sourceId: source.id, check: "database_credential", code: "legacy_inline_credential" });
        }
      }

      const tables = await db.select().from(dataSourceTables).where(and(
        eq(dataSourceTables.companyId, source.companyId),
        eq(dataSourceTables.dataSourceId, source.id),
      ));
      for (const table of tables) {
        const semanticModel = isRecord(table.semanticModel) ? table.semanticModel : {};
        const snapshot = isRecord(semanticModel.externalSnapshot) ? semanticModel.externalSnapshot : {};
        if (source.status === "ready" && snapshot.status === "ready" && ["postgres", "mysql", "mariadb"].includes(source.sourceType)) {
          report.checked.snapshots += 1;
          const primaryKeys = Array.isArray(table.schemaDefinition)
            ? table.schemaDefinition.filter((column) => isRecord(column) && column.isPrimaryKey === true)
            : [];
          const primaryKey = primaryKeys.length === 1 && typeof primaryKeys[0].name === "string" ? primaryKeys[0].name : null;
          if (!primaryKey) {
            report.issues.push({ severity: "error", sourceId: source.id, check: "external_snapshot", code: "snapshot_primary_key_unavailable" });
            continue;
          }
          try {
            const result = await dataSourceQueries.queryTable(source.companyId, table.id, {
              mode: "snapshot",
              aggregate: { column: primaryKey, fn: "count" },
              limit: 1,
              bypassResultCache: true,
              signal: AbortSignal.timeout(15_000),
            });
            const actual = result.rows[0]?.total_rows;
            for (const code of compareRestoredRowCount(snapshot.rowCount, actual)) {
              report.issues.push({ severity: "error", sourceId: source.id, check: "external_snapshot", code });
            }
          } catch {
            report.issues.push({ severity: "error", sourceId: source.id, check: "external_snapshot", code: "snapshot_query_unavailable" });
          }
        }
      }

      if (source.status === "ready" && source.sourceType === "rag_document") {
        const embeddingSpace = metadata.embeddingSpace;
        const embeddingGeneration = metadata.embeddingGeneration;
        if ((embeddingSpace === "bge-m3" || embeddingSpace === "openrouter-text-embedding-3-small") && typeof embeddingGeneration === "string") {
          report.checked.ragIndexes += 1;
          try {
            const coverage = await vectors.embeddingCoverage(source.companyId, source.id, embeddingSpace, embeddingGeneration);
            for (const code of compareRestoredEmbeddingCoverage(coverage)) {
              report.issues.push({ severity: "error", sourceId: source.id, check: "rag_vectors", code });
            }
          } catch {
            report.issues.push({ severity: "error", sourceId: source.id, check: "rag_vectors", code: "rag_vector_check_unavailable" });
          }
        }
      }
    }
  }

  return report;
}
