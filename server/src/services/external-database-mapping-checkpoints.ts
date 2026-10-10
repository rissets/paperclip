import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dataSourceJobCheckpoints } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { AiDatabaseAnalysisResult } from "./ai-reasoning.js";
import { assertDataSourceJobLease, type DataSourceJobLease } from "./data-source-job-lease.js";

export const EXTERNAL_SCHEMA_MAPPING_BATCH_SIZE = 20;
// One grouped mapping may include a local Pi attempt, router fallback, and
// one bounded observation/validation follow-up without cancelling inference.
export const EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS = 180_000;
export const EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS = 90_000;
export const EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_MAX_BYTES = 128 * 1024;

export const EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE = "external_schema_mapping";

export class ExternalDatabaseMappingCheckpointSizeError extends Error {
  constructor() {
    super("External database mapping batch result exceeds the durable checkpoint limit");
  }
}

export type ExternalSchemaColumnFingerprint = {
  name: string;
  dataType: string;
  nativeType?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyTarget?: { schema?: string; table: string; column: string };
};

export type ExternalSchemaTableFingerprint = {
  schemaName?: string;
  tableName: string;
  rowCount?: number;
  schemaDefinition: ExternalSchemaColumnFingerprint[];
};

export type ExternalSchemaMappingContextFingerprint = {
  mappingVersion?: string;
  databaseType?: string;
  databaseName?: string;
  sourceHost?: string;
  sourcePort?: number;
  specialistAgentName?: string;
  agentModel?: string;
  instructionsPath?: string;
  instructionsFingerprint?: string;
  adapterType?: string;
};

export type ExternalSchemaMappingCheckpoint = {
  checkpointKey: string;
  result: AiDatabaseAnalysisResult;
};

export function fingerprintExternalDatabaseSchema(
  tables: ExternalSchemaTableFingerprint[],
  context: ExternalSchemaMappingContextFingerprint = {},
): string {
  const canonical = tables
    .map((table) => {
      const columns = table.schemaDefinition
        .map((column) => [
          column.name,
          column.dataType,
          column.nativeType || "",
          column.isPrimaryKey ? "PK" : "",
          column.isForeignKey ? "FK" : "",
          column.foreignKeyTarget?.schema || "",
          column.foreignKeyTarget?.table || "",
          column.foreignKeyTarget?.column || "",
        ].join("\u0001"))
        .sort();
      return `${table.schemaName || "public"}.${table.tableName}\u0000rows=${table.rowCount ?? "unknown"}\u0000${columns.join("\u0000")}`;
    })
    .sort()
    .join("\u0002");
  const contextSignature = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\u0000");
  return createHash("sha256").update(`external-db-mapping:v2\u0000${contextSignature}\u0000${canonical}`).digest("hex");
}

export function fingerprintExternalDatabaseMappingBatch(
  qualifiedTableName: string,
  columns: ExternalSchemaColumnFingerprint[],
): string {
  const signature = columns.map((column) => [
    column.name,
    column.dataType,
    column.nativeType || "",
    column.isPrimaryKey ? "PK" : "",
    column.isForeignKey ? "FK" : "",
    column.foreignKeyTarget?.schema || "",
    column.foreignKeyTarget?.table || "",
    column.foreignKeyTarget?.column || "",
  ].join("\u0001")).join("\u0000");
  return createHash("sha256").update(`${qualifiedTableName}\u0000${signature}`).digest("hex");
}

export function externalSchemaMappingBatchTimeoutMs(tableStartedAt: number, now = Date.now()): number {
  return Math.max(0, Math.min(EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS, EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS - (now - tableStartedAt)));
}

function isDatabaseAnalysisResult(value: unknown): value is AiDatabaseAnalysisResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<AiDatabaseAnalysisResult>;
  return typeof result.domain === "string"
    && Array.isArray(result.entities)
    && Array.isArray(result.primaryTopics)
    && Boolean(result.tableRoles && typeof result.tableRoles === "object" && !Array.isArray(result.tableRoles))
    && Array.isArray(result.relationships)
    && Array.isArray(result.suggestedQueries)
    && typeof result.reasoningSummary === "string";
}

export class ExternalDatabaseMappingCheckpointStore {
  constructor(private readonly db: Db) {}

  async load(
    companyId: string,
    dataSourceId: string,
    lease: DataSourceJobLease,
    schemaFingerprint: string,
    checkpointKey: string,
  ): Promise<AiDatabaseAnalysisResult | null> {
    return this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, dataSourceId, lease);
      const [row] = await tx.select({
        payload: dataSourceJobCheckpoints.payload,
      }).from(dataSourceJobCheckpoints).where(and(
        eq(dataSourceJobCheckpoints.jobId, lease.jobId),
        eq(dataSourceJobCheckpoints.checkpointType, EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE),
        eq(dataSourceJobCheckpoints.inputFingerprint, schemaFingerprint),
        eq(dataSourceJobCheckpoints.checkpointKey, checkpointKey),
      )).limit(1);

      const candidate = row?.payload.result;
      return isDatabaseAnalysisResult(candidate) ? candidate : null;
    });
  }

  async save(
    companyId: string,
    dataSourceId: string,
    lease: DataSourceJobLease,
    schemaFingerprint: string,
    checkpointKey: string,
    result: AiDatabaseAnalysisResult,
  ): Promise<void> {
    const payload = { result };
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, "utf8") > EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_MAX_BYTES) {
      throw new ExternalDatabaseMappingCheckpointSizeError();
    }

    await this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, dataSourceId, lease);
      await tx.insert(dataSourceJobCheckpoints).values({
        jobId: lease.jobId,
        checkpointType: EXTERNAL_SCHEMA_MAPPING_CHECKPOINT_TYPE,
        checkpointKey,
        inputFingerprint: schemaFingerprint,
        payload,
      }).onConflictDoUpdate({
        target: [
          dataSourceJobCheckpoints.jobId,
          dataSourceJobCheckpoints.checkpointType,
          dataSourceJobCheckpoints.checkpointKey,
        ],
        set: {
          inputFingerprint: schemaFingerprint,
          payload,
          updatedAt: new Date(),
        },
      });
    });
  }
}
