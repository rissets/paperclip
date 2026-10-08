import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { eq, ne, and, or, ilike, desc, sql, isNull, inArray, lt, gt, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceCollections,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
  dataSourceJobs,
  activityLog,
  agents,
} from "@paperclipai/db";
import type {
  DataSource,
  DataSourceIngestionJob,
  DataSourceTable,
  KnowledgeSearchResult,
  StructuredQueryResult,
  DatabaseConnectionConfig,
  SqlQueryResult,
  ColumnDefinition,
  TableRelation,
  DataSourceSemanticProfile,
  TableSemanticMappingCoverage,
} from "@paperclipai/shared";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";
import { aiReasoningService, loadAgentReasoningInstructions } from "./ai-reasoning.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import {
  buildClickhouseTableAliasMap,
  buildClickhouseTableAliasTargets,
  ClickhouseService,
  clickhouseSourceTableName,
  extractClickhouseCteNames,
  rewriteClickhouseCreateTableName,
  rewriteClickhouseTableReferences,
} from "./clickhouse.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { DataSourceCollectionsService } from "./data-source-collections.js";
import { deleteDataSourceFile, downloadDataSourceFileToPath, readDataSourceFile } from "./data-source-object-storage.js";
import { RagModelService, type EmbeddingSpace } from "./rag-models.js";
import { parseDataSourceModelConfig } from "./data-source-model-config.js";
import {
  DataSourceVectorStore,
  type EmbeddingCoverage,
  type PrunableEmbeddingGeneration,
  type ReindexVectorInput,
} from "./data-source-vector-store.js";
import { DataSourceCacheService, makeDataSourceCacheKey } from "./data-source-cache.js";
import { externalQueryAdmission } from "./external-query-admission.js";
import { DataSourceDatabaseConfigService, publicDatabaseMetadata } from "./data-source-database-config.js";
import { analyzeExternalDatabaseSchemaBatch } from "./external-database-schema-mapping.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { assertDataSourceJobLease, completeDataSourceJobLease, DataSourceLeaseLostError, type DataSourceJobLease } from "./data-source-job-lease.js";
import { StructuredIngestionService } from "./structured-ingestion.js";
import {
  EXTERNAL_SCHEMA_MAPPING_BATCH_SIZE,
  EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS,
  ExternalDatabaseMappingCheckpointSizeError,
  ExternalDatabaseMappingCheckpointStore,
  externalSchemaMappingBatchTimeoutMs,
  fingerprintExternalDatabaseMappingBatch,
  fingerprintExternalDatabaseSchema,
} from "./external-database-mapping-checkpoints.js";

type StructuredColumn = { name: string; dataType?: string; role?: string; clickhouseType?: string };
export type QueryFilterDialect = "postgres" | "mysql" | "clickhouse";
type SnapshotActor = { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null; runId?: string | null };
export type StructuredAggregateFunction = "sum" | "avg" | "count" | "min" | "max";

export function semanticMappingEmbeddingGeneration(modelGeneration: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Semantic mapping revision must be a positive integer");
  }
  const suffix = `:semantic-${revision}:${createHash("sha256").update(modelGeneration).digest("hex").slice(0, 12)}`;
  return `${modelGeneration.slice(0, 256 - suffix.length)}${suffix}`;
}

function semanticMappingRevisionFromGeneration(generation: string): number | null {
  const match = generation.match(/:semantic-(\d+):[a-f0-9]{12}$/);
  const revision = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function isTemporalStructuredColumn(column: StructuredColumn): boolean {
  const normalizedType = column.dataType?.toLowerCase();
  return normalizedType === "date"
    || normalizedType === "time"
    || normalizedType === "datetime"
    || normalizedType === "timestamp"
    || column.role === "timestamp"
    || /(^|[_\s])(date|time|timestamp|datetime|created|updated|modified|period|tanggal|waktu)([_\s]|$)/i.test(column.name);
}

export function validateStructuredAggregationColumn(
  column: StructuredColumn,
  fn: StructuredAggregateFunction,
): void {
  if (fn === "count") return;
  if ((fn === "sum" || fn === "avg") && column.dataType !== "number") {
    throw unprocessable(`${fn} requires a numeric column: ${column.name}`);
  }
  if ((fn === "min" || fn === "max") && column.dataType !== "number" && !isTemporalStructuredColumn(column)) {
    throw unprocessable(`${fn} requires a numeric or date/time column: ${column.name}`);
  }
}

export function clickhouseAggregateColumnExpression(column: StructuredColumn, fn: StructuredAggregateFunction): string {
  const quoted = quoteDataIdentifier(column.name, "`");
  if ((fn !== "min" && fn !== "max") || !isTemporalStructuredColumn(column)) return quoted;
  const clickhouseType = column.clickhouseType || "";
  const nativeClickhouseDate = /\bdate(?:32|time(?:64)?)\b/i.test(clickhouseType);
  const numericColumn = column.dataType === "number"
    || /\b(?:u?int(?:8|16|32|64|128|256)|float(?:32|64)|decimal(?:32|64|128|256))\b/i.test(clickhouseType);
  return nativeClickhouseDate || numericColumn ? quoted : `parseDateTimeBestEffortOrNull(${quoted})`;
}

function calculateStructuredAggregate(
  values: unknown[],
  fn: StructuredAggregateFunction,
  temporal: boolean,
): number | unknown {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);
  if (fn === "count") return nonNullValues.length;

  const comparable = nonNullValues.flatMap((value) => {
    if (temporal) {
      const orderValue = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
          ? value
          : Date.parse(String(value));
      return Number.isFinite(orderValue) ? [{ orderValue, value }] : [];
    }
    const orderValue = Number(value);
    return Number.isFinite(orderValue) ? [{ orderValue, value: orderValue }] : [];
  });

  if (fn === "min" || fn === "max") {
    if (comparable.length === 0) return temporal ? null : 0;
    const ordered = comparable.reduce((best, item) =>
      fn === "min"
        ? item.orderValue < best.orderValue ? item : best
        : item.orderValue > best.orderValue ? item : best,
    );
    return temporal ? ordered.value : Number(ordered.orderValue.toFixed(2));
  }

  const numericValues = comparable.map((item) => item.orderValue);
  const total = numericValues.reduce((sum, value) => sum + value, 0);
  const result = fn === "avg" ? numericValues.length ? total / numericValues.length : 0 : total;
  return Number(result.toFixed(2));
}

export function isCountAllAggregate(fn: StructuredAggregateFunction, column: string): boolean {
  return fn === "count" && column === "*";
}

export function structuredAggregateAlias(fn: StructuredAggregateFunction, column: string): string {
  return `${fn}_${isCountAllAggregate(fn, column) ? "all" : column}`;
}

export function structuredAggregateSqlExpression(
  fn: StructuredAggregateFunction,
  columnExpression: string,
  countAll: boolean,
  dialect: "ansi" | "clickhouse",
): string {
  if (countAll) {
    if (fn !== "count") throw new Error("COUNT(*) requires the count aggregation function");
    return dialect === "clickhouse" ? "count()" : "COUNT(*)";
  }
  return `${fn.toUpperCase()}(${columnExpression})`;
}

const EXTERNAL_SNAPSHOT_PAGE_SIZE = 2_000;
const MAX_SNAPSHOT_TABLES_PER_JOB = 100;
const MAX_EXTERNAL_SNAPSHOT_DELTAS = 32;
const EXTERNAL_SNAPSHOT_LOOKBACK_MS = 1_000;
const SNAPSHOT_SYNC_VERSION_COLUMN = "_paperclip_sync_version";
const SNAPSHOT_SYNC_DELETED_COLUMN = "_paperclip_sync_deleted";
const SNAPSHOT_SYNC_CHANGE_CURSOR_COLUMN = "_paperclip_sync_change_cursor";
const EMBEDDING_REINDEX_BATCH_SIZE = 32;
const EMBEDDING_GENERATION_RETENTION_DAYS = 90;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function snapshotPrimaryKey(table: typeof dataSourceTables.$inferSelect): string | null {
  const primaryKeys = ((table.schemaDefinition || []) as ColumnDefinition[]).filter((column) => column.isPrimaryKey);
  return primaryKeys.length === 1 ? primaryKeys[0].name : null;
}

function snapshotClickhouseDdl(table: typeof dataSourceTables.$inferSelect, tableName: string): string {
  const columns = (table.schemaDefinition || []) as ColumnDefinition[];
  if (columns.length === 0) throw unprocessable(`External table '${table.tableName}' has no inspected columns`);
  if (columns.some((column) => [SNAPSHOT_SYNC_VERSION_COLUMN, SNAPSHOT_SYNC_DELETED_COLUMN, SNAPSHOT_SYNC_CHANGE_CURSOR_COLUMN].includes(column.name))) {
    throw unprocessable(`External table '${table.tableName}' uses a reserved Paperclip synchronization column`);
  }
  const fallbackTypes: Record<string, string> = {
    number: "Float64", date: "String", boolean: "UInt8", string: "String", json: "String", unknown: "String",
  };
  const ddlColumns = columns.map((column) => {
    const name = column.name.replaceAll("`", "``");
    const type = column.clickhouseType || fallbackTypes[column.dataType] || "String";
    return `  \`${name}\` ${type}`;
  });
  ddlColumns.push(`  \`${SNAPSHOT_SYNC_VERSION_COLUMN}\` UInt64`);
  ddlColumns.push(`  \`${SNAPSHOT_SYNC_DELETED_COLUMN}\` UInt8`);
  const primaryKey = snapshotPrimaryKey(table);
  const orderBy = primaryKey ? `\`${primaryKey.replaceAll("`", "``")}\`` : "tuple()";
  return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n${ddlColumns.join(",\n")}\n) ENGINE = MergeTree()\nORDER BY (${orderBy});`;
}

function timestampEpochMicros(value: unknown): bigint {
  if (value instanceof Date && Number.isFinite(value.getTime())) return BigInt(value.getTime()) * 1_000n;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value)) * (Math.abs(value) < 100_000_000_000 ? 1_000_000n : 1_000n);
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("Incremental sync timestamp is null or invalid");
  const input = value.trim().replace(" ", "T");
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(input);
  if (!match) throw new Error("Incremental sync timestamps must be ISO-like date-time values");
  const rawOffset = match[3] || "Z";
  const offset = /^[+-]\d{2}$/i.test(rawOffset) ? `${rawOffset}:00` : rawOffset;
  const wholeSecondMs = Date.parse(`${match[1]}.000${offset}`);
  if (!Number.isFinite(wholeSecondMs)) throw new Error("Incremental sync timestamp is invalid");
  const fraction = (match[2] || "").slice(0, 6).padEnd(6, "0");
  return BigInt(wholeSecondMs) * 1_000n + BigInt(fraction || "0");
}

function incrementalRowVersion(updatedAt: unknown, generation: number): string {
  const millis = timestampEpochMicros(updatedAt) / 1_000n;
  return (millis * 1_024n + BigInt(generation % 1_024)).toString();
}

function effectiveChangeTimestamp(updatedAt: unknown, deletedAt?: unknown): unknown {
  if (updatedAt === undefined || updatedAt === null || updatedAt === "") {
    if (deletedAt === undefined || deletedAt === null || deletedAt === "") return updatedAt;
    return deletedAt;
  }
  if (deletedAt === undefined || deletedAt === null || deletedAt === "") return updatedAt;
  return timestampEpochMicros(deletedAt) > timestampEpochMicros(updatedAt) ? deletedAt : updatedAt;
}

function watermarkMicrosToIso(value: string): string {
  const micros = BigInt(value);
  const seconds = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0");
  const milliseconds = Number(seconds * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Incremental watermark is outside the supported date range");
  return `${new Date(milliseconds).toISOString().slice(0, 19)}.${fraction}Z`;
}

function sourceRowIsDeleted(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

function snapshotDeltaTableName(baseName: string, jobId: string, tableId: string, attempt: number): string {
  const jobHash = createHash("sha256").update(jobId).digest("hex").slice(0, 10);
  const tableHash = createHash("sha256").update(tableId).digest("hex").slice(0, 8);
  return `${baseName.slice(0, 31)}__d_${jobHash}_${attempt.toString(36)}_${tableHash}`;
}

/** A full snapshot gets an immutable ClickHouse identity so a failed PG receipt cannot replace live data. */
function snapshotGenerationTableName(baseName: string, jobId: string, tableId: string, attempt: number): string {
  const jobHash = createHash("sha256").update(jobId).digest("hex").slice(0, 10);
  const tableHash = createHash("sha256").update(tableId).digest("hex").slice(0, 8);
  return `${baseName.slice(0, 31)}__g_${jobHash}_${attempt.toString(36)}_${tableHash}`;
}

function snapshotQuerySource(table: typeof dataSourceTables.$inferSelect): string {
  const schema = (Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) as ColumnDefinition[];
  const semanticModel = (table.semanticModel || {}) as Record<string, any>;
  const snapshot = semanticModel.externalSnapshot || {};
  const primaryKey = snapshotPrimaryKey(table);
  if (!primaryKey) throw new Error(`External snapshot table '${table.tableName}' has no single-column primary key`);
  const tableNames = [sourceClickhouseTableName(table), ...(Array.isArray(snapshot.deltaTables) ? snapshot.deltaTables : [])];
  const safeNames = tableNames.map((name) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_]{1,120}$/.test(name)) {
      throw new Error("External snapshot metadata contains an invalid ClickHouse delta table name");
    }
    return `\`${name}\``;
  });
  if (safeNames.length > MAX_EXTERNAL_SNAPSHOT_DELTAS + 1) {
    throw new Error("External snapshot has too many un-compacted deltas; run a full snapshot");
  }
  const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``;
  const visibleColumns = schema.map((column) => quote(column.name)).join(", ");
  const unionColumns = `${visibleColumns}, ${quote(SNAPSHOT_SYNC_VERSION_COLUMN)}, ${quote(SNAPSHOT_SYNC_DELETED_COLUMN)}`;
  const union = safeNames.map((name) => `SELECT ${unionColumns} FROM ${name}`).join(" UNION ALL ");
  return `(SELECT ${visibleColumns} FROM (SELECT ${unionColumns} FROM (${union}) ORDER BY ${quote(primaryKey)}, ${quote(SNAPSHOT_SYNC_VERSION_COLUMN)} DESC LIMIT 1 BY ${quote(primaryKey)}) WHERE ${quote(SNAPSHOT_SYNC_DELETED_COLUMN)} = 0) AS _paperclip_snapshot`;
}

function quoteDataIdentifier(identifier: string, quote: string): string {
  return `${quote}${identifier.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

function sourceClickhouseTableName(table: typeof dataSourceTables.$inferSelect): string {
  const storedName = (table.semanticModel as any)?.clickhouseTable;
  return typeof storedName === "string" && storedName.length > 0
    ? storedName
    : clickhouseSourceTableName(table.id, table.tableName);
}

export function shouldApplyClickhouseFinalDeduplication(semanticModel: unknown): boolean {
  if (!semanticModel || typeof semanticModel !== "object" || Array.isArray(semanticModel)) return false;
  const model = semanticModel as Record<string, any>;
  const schema = model.clickhouseSchema && typeof model.clickhouseSchema === "object"
    ? model.clickhouseSchema as Record<string, unknown>
    : {};
  const engine = typeof schema.engine === "string" ? schema.engine.toLowerCase() : "";
  const strategy = typeof schema.deduplicationStrategy === "string"
    ? schema.deduplicationStrategy.toLowerCase()
    : "";
  return model.useDeduplication === true || engine.includes("replacingmergetree") || strategy === "final";
}

function reprocessingCutoff(metadata: unknown): Date | null {
  const value = (metadata as Record<string, unknown> | null)?.reprocessingStartedAt;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function throwIfIngestionAborted(lease: DataSourceJobLease): void {
  if (lease.signal?.aborted) throw new Error("Datasource ingestion was cancelled or stopped");
}

export function mergeExternalDatabaseTableProfileBatches(
  current: Record<string, any> | undefined,
  incoming: Record<string, any>,
): Record<string, any> {
  const previous = current || {};
  const mergeItems = (field: string, identity: (value: any) => string) => {
    const merged = new Map<string, any>();
    for (const item of [...(Array.isArray(previous[field]) ? previous[field] : []), ...(Array.isArray(incoming[field]) ? incoming[field] : [])]) {
      const key = identity(item);
      if (key) merged.set(key, item);
    }
    return [...merged.values()];
  };
  const identity = (value: any) => typeof value === "string" ? value.trim().toLowerCase() : "";

  return {
    ...previous,
    ...incoming,
    context: [...new Set([previous.context, incoming.context].filter((value) => typeof value === "string" && value.trim()))].join("\n\n"),
    topics: mergeItems("topics", identity),
    entities: mergeItems("entities", identity),
    decisionSpecRefs: mergeItems("decisionSpecRefs", identity),
    metrics: mergeItems("metrics", (value) => `${String(value?.name || "").toLowerCase()}|${String(value?.column || "").toLowerCase()}|${String(value?.aggregation || "").toLowerCase()}`),
    dimensions: mergeItems("dimensions", (value) => `${String(value?.name || "").toLowerCase()}|${String(value?.column || "").toLowerCase()}`),
    relationships: mergeItems("relationships", (value) => `${String(value?.sourceTable || "").toLowerCase()}.${String(value?.sourceColumn || "").toLowerCase()}->${String(value?.targetTable || "").toLowerCase()}.${String(value?.targetColumn || "").toLowerCase()}`),
    suggestedQueries: mergeItems("suggestedQueries", (value) => `${String(value?.title || "").toLowerCase()}|${String(value?.query || value?.sqlSnippet || "").trim().toLowerCase()}`),
  };
}

export function compileStructuredFilters(
  filter: Record<string, unknown> | undefined,
  columns: StructuredColumn[],
  dialect: QueryFilterDialect,
): { whereSql: string; values: unknown[]; clickhouseParams: Record<string, { type: "String" | "Float64" | "Int64" | "UInt8"; value: string | number }> } {
  const predicates: string[] = [];
  const values: unknown[] = [];
  const clickhouseParams: Record<string, { type: "String" | "Float64" | "Int64" | "UInt8"; value: string | number }> = {};
  const quote = dialect === "postgres" ? '"' : "`";
  const knownColumns = new Map(columns.map((column) => [column.name, column]));
  let filterIndex = 0;

  for (const [name, value] of Object.entries(filter || {})) {
    if (value === undefined || value === null || value === "") continue;
    const rangeValue = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const rangeOperators = ["gt", "gte", "lt", "lte"] as const;
    if (rangeValue && (Object.keys(rangeValue).length === 0
      || Object.keys(rangeValue).some((operator) => !rangeOperators.includes(operator as typeof rangeOperators[number])))) {
      throw new Error(`Unsupported range filter for column ${name}`);
    }
    if (!rangeValue && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Unsupported filter value for column ${name}`);
    }
    if (!rangeValue && typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Filter value for column ${name} must be finite`);
    }

    const column = knownColumns.get(name);
    if (!column) throw new Error(`Unknown filter column: ${name}`);
    const identifier = quoteDataIdentifier(column.name, quote);
    const dataType = (column.dataType || "unknown").toLowerCase();

    if (rangeValue) {
      const sqlOperator: Record<(typeof rangeOperators)[number], string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
      const isTemporal = column.role === "temporal" || (column as any).semanticCategory === "temporal";
      for (const operator of rangeOperators) {
        if (!(operator in rangeValue)) continue;
        const bound = rangeValue[operator];
        if (typeof bound !== "string" && typeof bound !== "number" && typeof bound !== "boolean") {
          throw new Error(`Range bound for column ${name} must be a scalar`);
        }
        if (typeof bound === "number" && !Number.isFinite(bound)) {
          throw new Error(`Range bound for column ${name} must be finite`);
        }
        const index = filterIndex++;
        if (dialect === "clickhouse") {
          const parameterName = `ds_filter_${index}`;
          if (dataType === "number") {
            const numericValue = typeof bound === "number" ? bound : Number(bound);
            if (!Number.isFinite(numericValue)) throw new Error(`Range bound for ${name} must be numeric`);
            const type = Number.isSafeInteger(numericValue) ? "Int64" : "Float64";
            clickhouseParams[parameterName] = { type, value: numericValue };
            predicates.push(`${identifier} ${sqlOperator[operator]} {${parameterName}:${type}}`);
          } else {
            if (typeof bound === "boolean") throw new Error(`Range bound for ${name} must be a date or string`);
            clickhouseParams[parameterName] = { type: "String", value: bound };
            if (isTemporal) {
              predicates.push(`parseDateTimeBestEffortOrNull(toString(${identifier})) ${sqlOperator[operator]} parseDateTimeBestEffortOrNull({${parameterName}:String})`);
            } else {
              predicates.push(`toString(${identifier}) ${sqlOperator[operator]} {${parameterName}:String}`);
            }
          }
        } else {
          values.push(bound);
          const placeholder = dialect === "postgres" ? `$${values.length}` : "?";
          predicates.push(`${identifier} ${sqlOperator[operator]} ${placeholder}`);
        }
      }
      continue;
    }

    const isTextSearch = dataType === "string" && typeof value === "string";
    const index = filterIndex++;

    if (dialect === "clickhouse") {
      const parameterName = `ds_filter_${index}`;
      if (isTextSearch) {
        clickhouseParams[parameterName] = { type: "String", value };
        predicates.push(`positionCaseInsensitiveUTF8(toString(${identifier}), {${parameterName}:String}) > 0`);
      } else if (dataType === "number") {
        const numericValue = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numericValue)) throw new Error(`Filter value for ${name} must be numeric`);
        const type = Number.isSafeInteger(numericValue) ? "Int64" : "Float64";
        clickhouseParams[parameterName] = { type, value: numericValue };
        predicates.push(`${identifier} = {${parameterName}:${type}}`);
      } else if (dataType === "boolean") {
        const boolValue = typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : null;
        if (boolValue === null) throw new Error(`Filter value for ${name} must be boolean`);
        clickhouseParams[parameterName] = { type: "UInt8", value: boolValue ? 1 : 0 };
        predicates.push(`${identifier} = {${parameterName}:UInt8}`);
      } else {
        clickhouseParams[parameterName] = { type: "String", value: String(value) };
        predicates.push(`toString(${identifier}) = {${parameterName}:String}`);
      }
      continue;
    }

    values.push(value);
    const placeholder = dialect === "postgres" ? `$${values.length}` : "?";
    if (isTextSearch) {
      predicates.push(
        dialect === "postgres"
          ? `strpos(lower(${identifier}), lower(${placeholder})) > 0`
          : `INSTR(LOWER(${identifier}), LOWER(${placeholder})) > 0`,
      );
    } else {
      predicates.push(`${identifier} = ${placeholder}`);
    }
  }

  return {
    whereSql: predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "",
    values,
    clickhouseParams,
  };
}

export class DataSourcesService {
  private collectionsService: DataSourceCollectionsService;
  private vectorStore: DataSourceVectorStore;
  private embeddingReindexStore: Pick<DataSourceVectorStore,
    "hasEmbeddingSpace" | "embeddingCoverage" | "upsertChunkEmbeddings" | "listPrunableGenerations" | "deleteGenerationRows"
  >;
  private embeddingReindexModels: Pick<RagModelService, "embed" | "embeddingGeneration">;
  private cache: DataSourceCacheService;

  constructor(private db: Db, dependencies?: {
    embeddingReindexStore?: Pick<DataSourceVectorStore,
      "hasEmbeddingSpace" | "embeddingCoverage" | "upsertChunkEmbeddings" | "listPrunableGenerations" | "deleteGenerationRows"
    >;
    embeddingReindexModels?: Pick<RagModelService, "embed" | "embeddingGeneration">;
  }) {
    this.collectionsService = new DataSourceCollectionsService(db);
    this.vectorStore = new DataSourceVectorStore(db);
    this.embeddingReindexStore = dependencies?.embeddingReindexStore || this.vectorStore;
    this.embeddingReindexModels = dependencies?.embeddingReindexModels || new RagModelService();
    this.cache = new DataSourceCacheService();
  }

  /**
   * List all data sources for a company, with optional collection filtering
   */
  async list(companyId: string, collectionId?: string): Promise<DataSource[]> {
    const whereConditions = [eq(dataSources.companyId, companyId)];
    if (collectionId) {
      whereConditions.push(eq(dataSources.collectionId, collectionId));
    }

    const list = await this.db
      .select()
      .from(dataSources)
      .where(and(...whereConditions))
      .orderBy(desc(dataSources.createdAt));

    // Fetch collections map for names
    const collections = await this.db
      .select({ id: dataSourceCollections.id, name: dataSourceCollections.name })
      .from(dataSourceCollections)
      .where(eq(dataSourceCollections.companyId, companyId));

    const colNameMap = new Map(collections.map((c) => [c.id, c.name]));

    const jobs = list.length === 0
      ? []
      : await this.db
          .select({
            id: dataSourceJobs.id,
            dataSourceId: dataSourceJobs.dataSourceId,
            jobType: dataSourceJobs.jobType,
            status: dataSourceJobs.status,
            stage: dataSourceJobs.stage,
            attempt: dataSourceJobs.attempt,
            maxAttempts: dataSourceJobs.maxAttempts,
            progress: dataSourceJobs.progress,
            lastError: dataSourceJobs.lastError,
            createdAt: dataSourceJobs.createdAt,
            updatedAt: dataSourceJobs.updatedAt,
            completedAt: dataSourceJobs.completedAt,
          })
          .from(dataSourceJobs)
          .where(and(eq(dataSourceJobs.companyId, companyId), inArray(dataSourceJobs.dataSourceId, list.map((ds) => ds.id))))
          .orderBy(desc(dataSourceJobs.createdAt));
    const latestJobBySource = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (!latestJobBySource.has(job.dataSourceId)) latestJobBySource.set(job.dataSourceId, job);
    }

    // Attach tables summary
    const results: DataSource[] = [];
    for (const ds of list) {
      const processingCutoff = reprocessingCutoff(ds.metadata);
      const tables = await this.db
        .select()
        .from(dataSourceTables)
        .where(processingCutoff
          ? and(eq(dataSourceTables.dataSourceId, ds.id), lt(dataSourceTables.createdAt, processingCutoff))
          : eq(dataSourceTables.dataSourceId, ds.id));

      results.push({
        ...ds,
        metadata: publicDatabaseMetadata(ds.metadata),
        collectionId: ds.collectionId || null,
        collectionName: ds.collectionId ? colNameMap.get(ds.collectionId) || null : null,
        sourceType: ds.sourceType as any,
        status: ds.status as any,
        semanticProfile: (ds.metadata as any)?.semanticProfile || null,
        tables: tables as any[],
        ingestionJob: (latestJobBySource.get(ds.id) as DataSourceIngestionJob | undefined) || null,
      });
    }

    return results;
  }

  /**
   * Get single data source with its tables and sample chunks
   */
  async getById(companyId: string, id: string): Promise<DataSource | null> {
    const [ds] = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));

    if (!ds) return null;

    let collectionName: string | null = null;
    if (ds.collectionId) {
      const [col] = await this.db
        .select({ name: dataSourceCollections.name })
        .from(dataSourceCollections)
        .where(and(eq(dataSourceCollections.id, ds.collectionId), eq(dataSourceCollections.companyId, companyId)));
      collectionName = col?.name || null;
    }

    const processingCutoff = reprocessingCutoff(ds.metadata);
    const tables = await this.db
      .select()
      .from(dataSourceTables)
      .where(processingCutoff
        ? and(eq(dataSourceTables.dataSourceId, ds.id), lt(dataSourceTables.createdAt, processingCutoff))
        : eq(dataSourceTables.dataSourceId, ds.id));

    const chunks = await this.db
      .select()
      .from(dataSourceChunks)
      .where(processingCutoff
        ? and(eq(dataSourceChunks.dataSourceId, ds.id), lt(dataSourceChunks.createdAt, processingCutoff))
        : eq(dataSourceChunks.dataSourceId, ds.id))
      .orderBy(dataSourceChunks.chunkIndex)
      .limit(50);

    const [latestJob] = await this.db
      .select({
        id: dataSourceJobs.id,
        jobType: dataSourceJobs.jobType,
        status: dataSourceJobs.status,
        stage: dataSourceJobs.stage,
        attempt: dataSourceJobs.attempt,
        maxAttempts: dataSourceJobs.maxAttempts,
        progress: dataSourceJobs.progress,
        lastError: dataSourceJobs.lastError,
        createdAt: dataSourceJobs.createdAt,
        updatedAt: dataSourceJobs.updatedAt,
        completedAt: dataSourceJobs.completedAt,
      })
      .from(dataSourceJobs)
      .where(and(eq(dataSourceJobs.companyId, companyId), eq(dataSourceJobs.dataSourceId, ds.id)))
      .orderBy(desc(dataSourceJobs.createdAt))
      .limit(1);

    return {
      ...ds,
      metadata: publicDatabaseMetadata(ds.metadata),
      collectionId: ds.collectionId || null,
      collectionName,
      sourceType: ds.sourceType as any,
      status: ds.status as any,
      semanticProfile: (ds.metadata as any)?.semanticProfile || null,
      tables: tables as any[],
      chunks: chunks as any[],
      ingestionJob: (latestJob as DataSourceIngestionJob | undefined) || null,
    };
  }

  /**
   * Move or assign data source to a collection
   */
  async assignCollection(companyId: string, id: string, collectionId: string | null): Promise<DataSource | null> {
    await this.db
      .update(dataSources)
      .set({
        collectionId,
        updatedAt: new Date(),
      })
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));

    return this.getById(companyId, id);
  }

  /**
   * Automatically backfill missing semantic profiles for existing data sources
   * and ensure the full 17-agent enterprise roster is registered.
   */
  async backfillSemanticProfiles(companyId: string, force: boolean = false): Promise<number> {
    const { EnterpriseAgentRosterService } = await import("./enterprise-agent-roster.js");
    const rosterService = new EnterpriseAgentRosterService(this.db);
    await rosterService.ensureEnterpriseRoster(companyId);

    const list = await this.db
      .select()
      .from(dataSources)
      .where(eq(dataSources.companyId, companyId));

    let updatedCount = 0;
    const { TypeSafeJevService } = await import("./typesafe-jev.js");
    const jev = new TypeSafeJevService();

    for (const ds of list) {
      const existingProfile = (ds.metadata as any)?.semanticProfile;
      const hasTopics = existingProfile?.primaryTopics?.length > 0 || existingProfile?.topics?.length > 0;

      if (!force && existingProfile && hasTopics) continue;

      if (ds.sourceType === "rag_document") {
        const chunks = await this.db
          .select({ content: dataSourceChunks.content, chunkIndex: dataSourceChunks.chunkIndex })
          .from(dataSourceChunks)
          .where(eq(dataSourceChunks.dataSourceId, ds.id))
          .limit(20);

        const sampleText = chunks.map((c) => c.content).join("\n\n") || ds.name;
        const domainResult = await jev.evaluateDocumentDomain(
          ds.name,
          sampleText,
          chunks.map((c) => ({ chunkIndex: c.chunkIndex, content: c.content }))
        );

        const profile = {
          version: "1.0.0",
          onboardedBy: "KnowledgeIngestionAgent",
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.target_agent_affinity.v1", "rag.passage_relevance.v1"],
          domain: domainResult.domain,
          targetAgentAffinity: domainResult.targetAgentAffinity,
          entities: domainResult.entities,
          primaryTopics: domainResult.primaryTopics,
          topics: domainResult.primaryTopics,
          summary: domainResult.summary,
          documentProfiles: domainResult.documentProfiles,
          onboardedAt: new Date().toISOString(),
        };

        await this.db
          .update(dataSources)
          .set({
            metadata: {
              ...((ds.metadata as any) || {}),
              onboardedBy: "KnowledgeIngestionAgent",
              semanticProfile: profile,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, ds.id));

        updatedCount++;
      } else if (ds.sourceType === "postgres" || ds.sourceType === "mariadb" || ds.sourceType === "mysql") {
        const tables = await this.db
          .select()
          .from(dataSourceTables)
          .where(eq(dataSourceTables.dataSourceId, ds.id));

        const tableSummaries = tables.map((t) => ({
          name: t.tableName,
          columns: ((t.schemaDefinition as any[]) || []).map((c: any) => c.name),
          rowCount: t.rowCount,
        }));

        const dbSemanticRes = await jev.evaluateDatabaseTables(tableSummaries);
        const tableNames = tables.map((t) => t.tableName);

        // Update each table's semanticModel with per-table context, role, and topics
        for (const tbl of tables) {
          const tProfile = dbSemanticRes.tableProfiles?.[tbl.tableName];
          const currentModel = (tbl.semanticModel as any) || {};
          const tableRels = dbSemanticRes.relationships.filter(
            (r) =>
              r.sourceTable.toLowerCase() === tbl.tableName.toLowerCase() ||
              r.targetTable.toLowerCase() === tbl.tableName.toLowerCase()
          );
          await this.db
            .update(dataSourceTables)
            .set({
              semanticModel: {
                ...currentModel,
                tableRole: tProfile?.tableRole || currentModel.tableRole,
                context: tProfile?.context || currentModel.context,
                topics: tProfile?.topics || currentModel.topics,
                decisionSpecs: tProfile?.decisionSpecRefs || currentModel.decisionSpecs,
                relationships: tableRels,
              } as any,
            })
            .where(eq(dataSourceTables.id, tbl.id));
        }

        const profile = {
          version: "1.0.0",
          onboardedBy: "DatabaseIntegrationAgent",
          decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1", "db.json_structure.v1"],
          domain: "relational_database",
          targetAgentAffinity: "data_agent",
          entities: dbSemanticRes.entities.length > 0 ? dbSemanticRes.entities : tableNames,
          tableRoles: dbSemanticRes.tableRoles,
          relationships: dbSemanticRes.relationships,
          primaryTopics: dbSemanticRes.primaryTopics,
          topics: dbSemanticRes.topics,
          tableProfiles: dbSemanticRes.tableProfiles,
          crossTableClusters: dbSemanticRes.crossTableClusters,
          summary: existingProfile?.summary || `Database ${ds.sourceType} dengan ${tableNames.length} tabel relasional terhubung.`,
          onboardedAt: new Date().toISOString(),
          suggestedQueries: dbSemanticRes.suggestedQueries,
          reasoningSteps: dbSemanticRes.reasoningSteps,
          jsonStructures: existingProfile?.jsonStructures || {},
        };

        await this.db
          .update(dataSources)
          .set({
            metadata: {
              ...((ds.metadata as any) || {}),
              onboardedBy: "DatabaseIntegrationAgent",
              semanticProfile: profile,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, ds.id));

        updatedCount++;
      } else if (ds.sourceType === "csv" || ds.sourceType === "excel") {
        const tables = await this.db
          .select()
          .from(dataSourceTables)
          .where(eq(dataSourceTables.dataSourceId, ds.id));

        const existingTables = await this.db
          .select({
            id: dataSourceTables.id,
            tableName: dataSourceTables.tableName,
            schemaDefinition: dataSourceTables.schemaDefinition,
            semanticModel: dataSourceTables.semanticModel,
          })
          .from(dataSourceTables)
          .where(eq(dataSourceTables.companyId, companyId));

        const candidateTables = existingTables.map((et) => ({
          id: et.id,
          tableName: et.tableName,
          columns: ((et.schemaDefinition as any[]) || []).map((c: any) =>
            typeof c === "string" ? { name: c } : { name: c?.name || "", role: c?.role, dataType: c?.dataType }
          ),
        }));

        const { relationships: crossRelationships } = await jev.evaluateCrossTableRelations(
          tables.map((t) => ({
            tableName: t.tableName,
            columns: ((t.schemaDefinition as any[]) || []).map((c: any) =>
              typeof c === "string" ? { name: c } : { name: c?.name || "", role: c?.role, dataType: c?.dataType }
            ),
          })),
          candidateTables,
        );

        const tableNames = tables.map((t) => t.tableName);
        const allEntities = existingProfile?.entities || tableNames;
        const allMetrics = existingProfile?.metrics || [];
        const allDimensions = existingProfile?.dimensions || [];

        const topicRes = await jev.evaluateDatasetTopics(
          tables.map((t) => ({
            tableName: t.tableName,
            columns: (t.schemaDefinition as any[]) || [],
          })),
          allEntities,
          allMetrics,
          allDimensions,
          undefined,
          crossRelationships,
        );

        // Update each table's semanticModel with per-table topics, context, role, and relationships
        for (const tbl of tables) {
          const tProfile = topicRes.tableProfiles?.[tbl.tableName];
          const tableRels = crossRelationships.filter(
            (r) =>
              r.sourceTable.toLowerCase() === tbl.tableName.toLowerCase() ||
              r.targetTable.toLowerCase() === tbl.tableName.toLowerCase()
          );
          const currentModel = (tbl.semanticModel as any) || {};
          await this.db
            .update(dataSourceTables)
            .set({
              semanticModel: {
                ...currentModel,
                tableRole: tProfile?.tableRole || currentModel.tableRole,
                context: tProfile?.context || currentModel.context,
                topics: tProfile?.topics || currentModel.topics,
                decisionSpecs: tProfile?.decisionSpecRefs || currentModel.decisionSpecs,
                relationships: tableRels,
              } as any,
            })
            .where(eq(dataSourceTables.id, tbl.id));
        }

        const profile = {
          version: "1.0.0",
          onboardedBy: "StructuredIngestionAgent",
          decisionSpecRefs: [
            "struct.column_role.v1",
            "struct.entity_metric_mapping.v1",
            "struct.sync_strategy.v1",
            "struct.relation_discovery.v1",
            "struct.topic_synthesis.v1",
          ],
          domain: existingProfile?.domain || ds.name,
          targetAgentAffinity: existingProfile?.targetAgentAffinity || "data_agent",
          entities: allEntities,
          metrics: allMetrics,
          dimensions: allDimensions,
          relationships: crossRelationships,
          primaryTopics: topicRes.topics,
          topics: topicRes.topics,
          tableProfiles: topicRes.tableProfiles,
          crossTableClusters: topicRes.crossTableClusters,
          summary: existingProfile?.summary || `Dataset terstruktur berisikan tabel [${tableNames.join(", ")}].`,
          onboardedAt: existingProfile?.onboardedAt || new Date().toISOString(),
          suggestedQueries: existingProfile?.suggestedQueries,
          reasoningSteps: existingProfile?.reasoningSteps,
        };

        await this.db
          .update(dataSources)
          .set({
            metadata: {
              ...((ds.metadata as any) || {}),
              onboardedBy: "StructuredIngestionAgent",
              semanticProfile: profile,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, ds.id));

        // Ensure activity log is present for StructuredIngestionAgent
        const agentRecords = await this.db
          .select({ id: agents.id, name: agents.name, metadata: agents.metadata })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

        const agentRecord = agentRecords.find((a) => {
          const marker = readBuiltInAgentMarker(a.metadata);
          return (
            marker?.key === "structured-ingestion" ||
            a.name === "Structured Ingestion Agent" ||
            a.name === "StructuredIngestionAgent"
          );
        });

        if (agentRecord) {
          const existingLogs = await this.db
            .select({ id: activityLog.id })
            .from(activityLog)
            .where(
              and(
                eq(activityLog.companyId, companyId),
                eq(activityLog.entityId, ds.id),
                eq(activityLog.action, "data_source.onboarded.structured"),
              )
            )
            .limit(1);

          if (existingLogs.length === 0) {
            await this.db.insert(activityLog).values({
              companyId,
              actorType: "agent",
              actorId: agentRecord.id,
              agentId: agentRecord.id,
              action: "data_source.onboarded.structured",
              entityType: "data_source",
              entityId: ds.id,
              details: {
                name: ds.name,
                dataSourceName: ds.name,
                kind: "structured",
                sourceType: ds.sourceType,
                description: `StructuredIngestionAgent successfully onboarded and semantically mapped data source '${ds.name}' using TypeSafe JEV System One DecisionSpecs (struct.column_role.v1, struct.entity_metric_mapping.v1, struct.sync_strategy.v1).`,
                domain: profile.domain,
                entities: profile.entities,
                decisionSpecRefs: profile.decisionSpecRefs,
                targetAgentAffinity: profile.targetAgentAffinity,
              },
            });
          } else {
            await this.db
              .update(activityLog)
              .set({
                actorId: agentRecord.id,
                agentId: agentRecord.id,
                details: {
                  ...((existingLogs[0] as any)?.details || {}),
                  name: ds.name,
                  dataSourceName: ds.name,
                  kind: "structured",
                  sourceType: ds.sourceType,
                },
              })
              .where(eq(activityLog.id, existingLogs[0].id));
          }
        }

        updatedCount++;
      }
    }

    // General historical fix for any activity logs that had string actorId and null agentId
    try {
      const enterpriseAgents = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      for (const ag of enterpriseAgents) {
        await this.db
          .update(activityLog)
          .set({
            actorId: ag.id,
            agentId: ag.id,
          })
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.actorId, ag.name),
              isNull(activityLog.agentId),
            )
          );
      }
    } catch {
      // Non-blocking
    }

    return updatedCount;
  }

  /**
   * Delete data source and its cascade data
   */
  async delete(companyId: string, id: string): Promise<boolean> {
    const [existing] = await this.db
      .select({ storagePath: dataSources.storagePath, metadata: dataSources.metadata })
      .from(dataSources)
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
    if (existing?.metadata?.credentialSecretId) {
      await new DataSourceDatabaseConfigService(this.db).archivePrepared(companyId, existing.metadata);
    }
    const [deleted] = await this.db
      .delete(dataSources)
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
      .returning();
    if (deleted && existing?.storagePath && (existing.metadata as any)?.storageBackend === "s3") {
      try {
        await deleteDataSourceFile(companyId, existing.storagePath);
      } catch (error) {
        // Source metadata is already deleted. Keep the control-plane deletion
        // successful and leave the object for the storage reconciliation job.
        console.warn(`[DataSourcesService] Could not delete source object for ${id}:`, error instanceof Error ? error.message : error);
      }
    }
    return !!deleted;
  }

  /** Queue a full, keyset-paginated external-table snapshot without blocking the API request. */
  async enqueueExternalDatabaseSnapshot(
    companyId: string,
    id: string,
    input: {
      mode?: "full" | "incremental";
      tableIds?: string[];
      tablePolicies?: Array<{ tableId: string; updatedAtColumn: string; deletedAtColumn?: string }>;
      actor: SnapshotActor;
    },
  ): Promise<{ id: string; status: string; tableCount: number; skippedTableCount: number; ingestionJob: DataSourceIngestionJob }> {
    return this.db.transaction(async (tx) => {
      const mode = input.mode || "full";
      if (mode !== "full" && mode !== "incremental") throw unprocessable("Snapshot mode must be full or incremental");
      const policies = input.tablePolicies || [];
      const policyByTableId = new Map(policies.map((policy) => [policy.tableId, policy]));
      const [source] = await tx.select().from(dataSources).where(and(
        eq(dataSources.id, id), eq(dataSources.companyId, companyId),
      )).limit(1).for("update");
      if (!source) throw notFound(`Data source not found: ${id}`);
      if (!(["postgres", "mysql", "mariadb"] as string[]).includes(source.sourceType)) {
        throw unprocessable("External snapshots currently support PostgreSQL, MySQL, and MariaDB data sources");
      }
      if (source.status !== "ready") throw conflict("External datasource must finish onboarding before a snapshot can be queued");

      const [activeJob] = await tx.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
        eq(dataSourceJobs.companyId, companyId),
        eq(dataSourceJobs.dataSourceId, id),
        inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
      )).limit(1);
      if (activeJob) throw conflict("This datasource already has an active ingestion or snapshot job");

      const tables = await tx.select().from(dataSourceTables).where(and(
        eq(dataSourceTables.companyId, companyId), eq(dataSourceTables.dataSourceId, id),
      ));
      if (input.tableIds && (!Array.isArray(input.tableIds) || input.tableIds.length === 0)) {
        throw unprocessable("tableIds must contain at least one table when provided");
      }
      if (input.tableIds && input.tableIds.length > MAX_SNAPSHOT_TABLES_PER_JOB) {
        throw unprocessable(`A snapshot job can include at most ${MAX_SNAPSHOT_TABLES_PER_JOB} tables`);
      }
      const requestedIds = input.tableIds || (mode === "incremental" ? policies.map((policy) => policy.tableId) : undefined);
      const selected = requestedIds
        ? tables.filter((table) => requestedIds.includes(table.id))
        : tables;
      if (requestedIds && selected.length !== new Set(requestedIds).size) {
        throw notFound("One or more selected tables do not belong to this datasource");
      }
      if (mode === "incremental" && selected.some((table) => !policyByTableId.has(table.id))) {
        throw unprocessable("Incremental sync requires an updated-at policy for each selected table");
      }
      for (const [tableId, policy] of policyByTableId) {
        const table = selected.find((candidate) => candidate.id === tableId);
        if (!table) throw notFound("A sync policy refers to a table outside the selected datasource tables");
        const columns = (Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) as ColumnDefinition[];
        const updatedAt = columns.find((column) => column.name === policy.updatedAtColumn);
        if (!updatedAt) throw unprocessable(`Updated-at column '${policy.updatedAtColumn}' is not part of table '${table.tableName}'`);
        if (updatedAt.dataType !== "date" && updatedAt.role !== "timestamp") {
          throw unprocessable(`Updated-at column '${policy.updatedAtColumn}' must be inspected as a date or timestamp`);
        }
        if (policy.deletedAtColumn) {
          const deletedAt = columns.find((column) => column.name === policy.deletedAtColumn);
          if (!deletedAt) throw unprocessable(`Deleted-at column '${policy.deletedAtColumn}' is not part of table '${table.tableName}'`);
          if (deletedAt.dataType !== "date" && deletedAt.role !== "timestamp") {
            throw unprocessable(`Deleted-at column '${policy.deletedAtColumn}' must be inspected as a date or timestamp`);
          }
        }
      }
      const eligible = selected.filter((table) => snapshotPrimaryKey(table) !== null);
      const skippedTableCount = selected.length - eligible.length;
      if (eligible.length === 0) {
        throw unprocessable("No selected table has exactly one inspected primary key; keyset snapshot requires a single-column primary key");
      }
      if (eligible.length > MAX_SNAPSHOT_TABLES_PER_JOB) {
        throw unprocessable(`A snapshot job can include at most ${MAX_SNAPSHOT_TABLES_PER_JOB} eligible tables`);
      }
      if (mode === "incremental" && eligible.some((table) => {
        const snapshot = ((table.semanticModel || {}) as Record<string, any>).externalSnapshot;
        const deltas = Array.isArray(snapshot?.deltaTables) ? snapshot.deltaTables : [];
        return snapshot?.engine === "merge_delta_v1" && deltas.length >= MAX_EXTERNAL_SNAPSHOT_DELTAS;
      })) {
        throw conflict("An external snapshot reached its delta-table limit; run a full snapshot to compact it before syncing again");
      }

      const [job] = await tx.insert(dataSourceJobs).values({
        companyId,
        dataSourceId: id,
        jobType: "external_db_snapshot",
        status: "queued",
        stage: "queued",
        progress: {
          tableIds: eligible.map((table) => table.id),
          syncMode: mode,
          tablePolicies: eligible.flatMap((table) => {
            const policy = policyByTableId.get(table.id);
            return policy ? [policy] : [];
          }),
          totalTables: eligible.length,
          skippedTableCount,
          consistency: mode === "incremental" ? "best_effort_updated_at" : "best_effort_keyset",
        },
        idempotencyKey: `external-snapshot:${id}:${randomUUID()}`,
      }).returning();

      await tx.insert(activityLog).values({
        companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        action: "data_source.external_snapshot.queued",
        entityType: "data_source",
        entityId: id,
        agentId: input.actor.agentId || null,
        runId: input.actor.runId || null,
        details: {
          jobId: job.id,
          mode,
          tableCount: eligible.length,
          skippedTableCount,
          consistency: mode === "incremental" ? "best_effort_updated_at" : "best_effort_keyset",
        },
      });

      return {
        id,
        status: "queued",
        tableCount: eligible.length,
        skippedTableCount,
        ingestionJob: job as DataSourceIngestionJob,
      };
    });
  }

  /** Remove stale immutable snapshot targets only when PostgreSQL proves they are no longer active. */
  async reconcilePendingExternalSnapshotTargets(limit = 8): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(32, Math.trunc(limit)));
    return this.db.transaction(async (tx) => {
      const lockResult = await tx.execute(sql<{ acquired: boolean }>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('paperclip:datasource-snapshot-orphan-reconcile', 0)) AS acquired
      `);
      if (!Array.from(lockResult as Iterable<{ acquired: boolean }>)[0]?.acquired) return 0;

      const result = await tx.execute(sql<{
        tableId: string;
        companyId: string;
        semanticModel: Record<string, unknown> | null;
      }>`
        SELECT table_row.id::text AS "tableId", table_row.company_id::text AS "companyId",
               table_row.semantic_model AS "semanticModel"
        FROM data_source_tables AS table_row
        LEFT JOIN data_source_jobs AS job
          ON job.id::text = table_row.semantic_model #>> '{pendingExternalSnapshot,jobId}'
        WHERE jsonb_typeof(table_row.semantic_model->'pendingExternalSnapshot') = 'object'
          AND CASE
                WHEN COALESCE(
                  table_row.semantic_model #>> '{pendingExternalSnapshot,publishStartedAt}',
                  table_row.semantic_model #>> '{pendingExternalSnapshot,startedAt}'
                ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                THEN COALESCE(
                  table_row.semantic_model #>> '{pendingExternalSnapshot,publishStartedAt}',
                  table_row.semantic_model #>> '{pendingExternalSnapshot,startedAt}'
                )::timestamptz
                     < clock_timestamp() - interval '5 minutes'
                ELSE FALSE
              END
          AND (
            job.id IS NULL OR job.status IN ('failed', 'cancelled', 'succeeded')
            OR (
              job.status = 'running'
              AND table_row.semantic_model #>> '{pendingExternalSnapshot,attempt}' ~ '^[0-9]+$'
              AND (table_row.semantic_model #>> '{pendingExternalSnapshot,attempt}')::integer < job.attempt
            )
          )
          AND table_row.semantic_model->>'clickhouseTable'
              IS DISTINCT FROM table_row.semantic_model #>> '{pendingExternalSnapshot,pendingTargetTable}'
          AND table_row.semantic_model->>'clickhouseTable'
              IS DISTINCT FROM table_row.semantic_model #>> '{pendingExternalSnapshot,pendingStageTable}'
          AND NOT COALESCE(
            (table_row.semantic_model #> '{externalSnapshot,deltaTables}')
              @> jsonb_build_array(table_row.semantic_model #>> '{pendingExternalSnapshot,pendingTargetTable}'),
            FALSE
          )
          AND NOT COALESCE(
            (table_row.semantic_model #> '{externalSnapshot,deltaTables}')
              @> jsonb_build_array(table_row.semantic_model #>> '{pendingExternalSnapshot,pendingStageTable}'),
            FALSE
          )
        ORDER BY table_row.updated_at ASC
        LIMIT ${boundedLimit}
        FOR UPDATE OF table_row SKIP LOCKED
      `);

      let reconciled = 0;
      const cleanupDeadline = Date.now() + 8_000;
      for (const candidate of Array.from(result as Iterable<{
        tableId: string;
        companyId: string;
        semanticModel: Record<string, unknown> | null;
      }>)) {
        const model = candidate.semanticModel || {};
        const pending = model.pendingExternalSnapshot && typeof model.pendingExternalSnapshot === "object"
          ? model.pendingExternalSnapshot as Record<string, unknown>
          : {};
        const activeTable = typeof model.clickhouseTable === "string" ? model.clickhouseTable : "";
        const externalSnapshot = model.externalSnapshot && typeof model.externalSnapshot === "object"
          ? model.externalSnapshot as Record<string, unknown>
          : {};
        const activeDeltas = Array.isArray(externalSnapshot.deltaTables) ? externalSnapshot.deltaTables : [];
        const prefix = `${activeTable.slice(0, 31)}__`;
        const targets = [pending.pendingTargetTable, pending.pendingStageTable,
          ...(Array.isArray(pending.cleanupTargets) ? pending.cleanupTargets : [])]
          .filter((value, index, values): value is string => typeof value === "string"
            && /^[A-Za-z0-9_]{1,120}$/.test(value)
            && value.startsWith(prefix)
            && value !== activeTable
            && !activeDeltas.includes(value)
            && values.indexOf(value) === index);
        if (targets.length === 0) continue;

        const clickhouse = new ClickhouseService();
        let allTargetsRemoved = true;
        for (const target of targets) {
          const remainingMs = cleanupDeadline - Date.now();
          if (remainingMs <= 0) {
            allTargetsRemoved = false;
            break;
          }
          try {
            await clickhouse.execute(
              `DROP TABLE IF EXISTS \`${target}\``,
              clickhouse.getCompanyDatabase(candidate.companyId),
              AbortSignal.timeout(Math.min(2_500, remainingMs)),
            );
          } catch {
            allTargetsRemoved = false;
          }
        }
        if (!allTargetsRemoved) {
          console.warn("[DataSourcesService] Pending ClickHouse snapshot target cleanup failed; the next sweep will retry");
          continue;
        }

        const pendingJobId = typeof pending.jobId === "string" ? pending.jobId : "";
        const pendingTarget = typeof pending.pendingTargetTable === "string" ? pending.pendingTargetTable : "";
        const cleared = await tx.execute(sql<{ id: string }>`
          UPDATE data_source_tables
          SET semantic_model = semantic_model - 'pendingExternalSnapshot', updated_at = now()
          WHERE id = ${candidate.tableId}::uuid AND company_id = ${candidate.companyId}::uuid
            AND semantic_model #>> '{pendingExternalSnapshot,jobId}' = ${pendingJobId}
            AND semantic_model #>> '{pendingExternalSnapshot,pendingTargetTable}' = ${pendingTarget}
          RETURNING id
        `);
        if (Array.from(cleared as Iterable<{ id: string }>).length === 1) reconciled += 1;
      }
      return reconciled;
    });
  }

  /** Build a full external snapshot or publish a bounded updated-at delta. */
  async runExternalDatabaseSnapshot(
    companyId: string,
    id: string,
    progress: Record<string, unknown>,
    lease: DataSourceJobLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const tableIds = Array.isArray(progress.tableIds)
      ? progress.tableIds.filter((tableId): tableId is string => typeof tableId === "string")
      : [];
    if (tableIds.length === 0 || tableIds.length > MAX_SNAPSHOT_TABLES_PER_JOB) {
      throw new Error("External snapshot job is missing its bounded table selection");
    }
    const [source] = await this.db.select().from(dataSources).where(and(
      eq(dataSources.id, id), eq(dataSources.companyId, companyId),
    )).limit(1);
    if (!source || !["postgres", "mysql", "mariadb"].includes(source.sourceType)) {
      throw new Error("External snapshot source is unavailable or has an unsupported type");
    }
    const config = await new DataSourceDatabaseConfigService(this.db).resolve(companyId, source);
    const tables = await this.db.select().from(dataSourceTables).where(and(
      eq(dataSourceTables.companyId, companyId), eq(dataSourceTables.dataSourceId, id), inArray(dataSourceTables.id, tableIds),
    ));
    if (tables.length !== tableIds.length) throw new Error("External snapshot table selection changed after enqueue");

    const syncMode = progress.syncMode === "incremental" ? "incremental" : "full";
    const tablePolicies = Array.isArray(progress.tablePolicies)
      ? progress.tablePolicies.filter((value): value is { tableId: string; updatedAtColumn: string; deletedAtColumn?: string } =>
        !!value && typeof value === "object" && typeof (value as any).tableId === "string"
          && typeof (value as any).updatedAtColumn === "string"
          && ((value as any).deletedAtColumn === undefined || typeof (value as any).deletedAtColumn === "string"))
      : [];
    const policyByTableId = new Map(tablePolicies.map((policy) => [policy.tableId, policy]));
    if (syncMode === "incremental" && tableIds.some((tableId) => !policyByTableId.has(tableId))) {
      throw new Error("Incremental snapshot job is missing a table updated-at policy");
    }
    const clickhouse = new ClickhouseService();
    const dbIntegration = new DatabaseIntegrationService();
    const publishedTableIds = new Set(
      Array.isArray(progress.publishedTableIds)
        ? progress.publishedTableIds.filter((tableId): tableId is string => typeof tableId === "string" && tableIds.includes(tableId))
        : [],
    );
    let completedTables = publishedTableIds.size;

    for (const table of tables) {
      if (publishedTableIds.has(table.id)) continue;
      const columns = (Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) as ColumnDefinition[];
      const primaryKey = snapshotPrimaryKey(table);
      if (!primaryKey) throw new Error(`Table '${table.tableName}' no longer has exactly one inspected primary key`);
      const semanticModel = (table.semanticModel || {}) as Record<string, any>;
      const previousSnapshot = (semanticModel.externalSnapshot || {}) as Record<string, any>;
      const policy = policyByTableId.get(table.id);
      const updatedAtColumn = policy?.updatedAtColumn;
      const deletedAtColumn = policy?.deletedAtColumn;
      if (syncMode === "incremental" && (!updatedAtColumn || !columns.some((column) => column.name === updatedAtColumn))) {
        throw new Error(`Incremental snapshot policy for '${table.tableName}' no longer matches its inspected schema`);
      }
      if (deletedAtColumn && !columns.some((column) => column.name === deletedAtColumn)) {
        throw new Error(`Deleted-at column '${deletedAtColumn}' no longer matches table '${table.tableName}'`);
      }
      const savedDeltaTables = Array.isArray(previousSnapshot.deltaTables)
        ? previousSnapshot.deltaTables.filter((name: unknown): name is string => typeof name === "string")
        : [];
      const canUseDelta = syncMode === "incremental"
        && previousSnapshot.engine === "merge_delta_v1"
        && previousSnapshot.updatedAtColumn === updatedAtColumn
        && typeof previousSnapshot.watermarkMicros === "string"
        && Number.isSafeInteger(table.rowCount)
        && table.rowCount >= 0
        && savedDeltaTables.length <= MAX_EXTERNAL_SNAPSHOT_DELTAS;
      const bootstrap = syncMode === "incremental" && !canUseDelta;
      if (canUseDelta && savedDeltaTables.length >= MAX_EXTERNAL_SNAPSHOT_DELTAS) {
        throw new Error("External snapshot reached its delta-table limit; run a full snapshot to compact the source before syncing again");
      }
      const generation = Math.max(0, Number(previousSnapshot.syncGeneration) || 0) + 1;
      const sourceSchema = typeof semanticModel.sourceSchema === "string" && semanticModel.sourceSchema
        ? semanticModel.sourceSchema
        : await dbIntegration.resolveTableSchema(config, table.tableName);
      const clickhouseTable = sourceClickhouseTableName(table);
      const fullSnapshotTable = snapshotGenerationTableName(clickhouseTable, lease.jobId, table.id, lease.attempt);
      const ddl = snapshotClickhouseDdl(table, clickhouseTable);
      const startedAt = new Date();
      let scannedRows = 0;
      let cursor: unknown;
      let incrementalCursor: { updatedAt: unknown; primaryKey: unknown } | undefined;
      let maximumWatermarkMicros = canUseDelta ? BigInt(previousSnapshot.watermarkMicros as string) : 0n;
      const useDelta = canUseDelta && !bootstrap;
      const deltaTableName = snapshotDeltaTableName(clickhouseTable, lease.jobId, table.id, lease.attempt);
      const targetTable = useDelta ? deltaTableName : fullSnapshotTable;
      const stagingTableName = `${targetTable}__s_stage`;
      const pendingPublication = (semanticModel.pendingExternalSnapshot || {}) as Record<string, unknown>;
      const pendingTarget = pendingPublication.pendingTargetTable;
      const pendingAttempt = Number(pendingPublication.attempt);
      const targetPrefixes = [`${clickhouseTable.slice(0, 31)}__g_`, `${clickhouseTable.slice(0, 31)}__d_`];
      const supersedesPendingAttempt = pendingPublication.jobId !== lease.jobId
        || (Number.isSafeInteger(pendingAttempt) && pendingAttempt < lease.attempt);
      const stalePendingTargets = [pendingTarget, pendingPublication.pendingStageTable]
        .filter((value): value is string => typeof value === "string"
          && /^[A-Za-z0-9_]{1,120}$/.test(value)
          && value !== clickhouseTable
          && targetPrefixes.some((prefix) => value.startsWith(prefix))
          && supersedesPendingAttempt);
      const carriedCleanupTargets = [
        ...(Array.isArray(pendingPublication.cleanupTargets) ? pendingPublication.cleanupTargets : []),
        ...stalePendingTargets,
      ].filter((value, index, values): value is string => typeof value === "string"
        && /^[A-Za-z0-9_]{1,120}$/.test(value)
        && targetPrefixes.some((prefix) => value.startsWith(prefix))
        && value !== clickhouseTable
        && values.indexOf(value) === index)
        .slice(-8);
      for (const staleTarget of carriedCleanupTargets) {
        await clickhouse.execute(`DROP TABLE IF EXISTS \`${staleTarget}\``, clickhouse.getCompanyDatabase(companyId))
          .catch(() => {});
      }

      const stagingSemanticModel = {
        ...semanticModel,
        pendingExternalSnapshot: {
          mode: useDelta ? "incremental" : "snapshot",
          status: "staging",
          attempt: lease.attempt,
          pendingTargetTable: targetTable,
          pendingStageTable: stagingTableName,
          cleanupTargets: carriedCleanupTargets,
          startedAt: startedAt.toISOString(),
          jobId: lease.jobId,
        },
      };
      await this.db.transaction(async (tx) => {
        await assertDataSourceJobLease(tx, companyId, id, lease);
        await tx.update(dataSourceTables).set({ semanticModel: stagingSemanticModel })
          .where(and(eq(dataSourceTables.id, table.id), eq(dataSourceTables.dataSourceId, id), eq(dataSourceTables.companyId, companyId)));
      });

      await lease.reportProgress?.("snapshot_read", {
        tableName: table.tableName,
        completedTables,
        totalTables: tables.length,
        rowsScanned: 0,
        syncMode,
        bootstrap,
      });

      const rowStream = async function* (): AsyncGenerator<Record<string, unknown>> {
        while (true) {
          const page = await externalQueryAdmission.run(`${companyId}:${id}`, () => useDelta
            ? dbIntegration.queryUpdatedKeysetPage(config, {
                schemaName: sourceSchema,
                tableName: table.tableName,
                columns: columns.map((column) => column.name),
                primaryKey,
                updatedAtColumn: updatedAtColumn!,
                deletedAtColumn,
                since: watermarkMicrosToIso((BigInt(previousSnapshot.watermarkMicros as string) - BigInt(EXTERNAL_SNAPSHOT_LOOKBACK_MS) * 1_000n > 0n
                  ? BigInt(previousSnapshot.watermarkMicros as string) - BigInt(EXTERNAL_SNAPSHOT_LOOKBACK_MS) * 1_000n
                  : 0n).toString()),
                after: incrementalCursor,
                pageSize: EXTERNAL_SNAPSHOT_PAGE_SIZE,
                signal,
              })
            : dbIntegration.queryKeysetPage(config, {
                schemaName: sourceSchema,
                tableName: table.tableName,
                columns: columns.map((column) => column.name),
                primaryKey,
                after: cursor,
                pageSize: EXTERNAL_SNAPSHOT_PAGE_SIZE,
                signal,
              }));
          if (page.rows.length === 0) return;
          for (const row of page.rows) {
            const sourceRow = row as Record<string, unknown>;
            const normalized: Record<string, unknown> = {};
            for (const column of columns) {
              const value = sourceRow[column.name];
              if (value instanceof Date) normalized[column.name] = value.toISOString();
              else if (typeof value === "bigint") normalized[column.name] = value.toString();
              else if (Buffer.isBuffer(value)) normalized[column.name] = value.toString("base64");
              else normalized[column.name] = value ?? null;
            }
            if (updatedAtColumn) {
              const changedAt = sourceRow[SNAPSHOT_SYNC_CHANGE_CURSOR_COLUMN]
                ?? effectiveChangeTimestamp(sourceRow[updatedAtColumn], deletedAtColumn ? sourceRow[deletedAtColumn] : undefined);
              const watermarkMicros = timestampEpochMicros(changedAt);
              if (watermarkMicros > maximumWatermarkMicros) maximumWatermarkMicros = watermarkMicros;
              normalized[SNAPSHOT_SYNC_VERSION_COLUMN] = incrementalRowVersion(changedAt, generation);
            } else {
              normalized[SNAPSHOT_SYNC_VERSION_COLUMN] = 0;
            }
            normalized[SNAPSHOT_SYNC_DELETED_COLUMN] = deletedAtColumn && sourceRowIsDeleted(sourceRow[deletedAtColumn]) ? 1 : 0;
            yield normalized;
          }
          const lastRow = page.rows[page.rows.length - 1] as Record<string, unknown>;
          if (useDelta) incrementalCursor = {
            updatedAt: lastRow[SNAPSHOT_SYNC_CHANGE_CURSOR_COLUMN]
              ?? effectiveChangeTimestamp(lastRow[updatedAtColumn!], deletedAtColumn ? lastRow[deletedAtColumn] : undefined),
            primaryKey: lastRow[primaryKey],
          };
          else cursor = lastRow[primaryKey];
          scannedRows += page.rows.length;
          if (page.rows.length < EXTERNAL_SNAPSHOT_PAGE_SIZE) return;
        }
      };

      const publishProgress = async (insertedRows: number) => {
        await lease.reportProgress?.(useDelta ? "snapshot_delta_insert" : "snapshot_insert", {
          tableName: table.tableName,
          completedTables,
          totalTables: tables.length,
          rowsScanned: insertedRows,
          insertedRows,
          syncMode,
        });
      };
      const publicationFence = async (insertedRows: number, publish: () => Promise<void>) => {
        if (!Number.isSafeInteger(insertedRows) || insertedRows < 0) {
          throw new Error("Snapshot row count exceeds the safe integer range supported by datasource metadata");
        }
        const completedAt = new Date();
        const nextPublishedIds = [...publishedTableIds, table.id];
        const consistency = useDelta ? "best_effort_updated_at" : "best_effort_keyset";
        await lease.reportProgress?.("snapshot_publish", {
          tableName: table.tableName,
          completedTables,
          totalTables: tables.length,
          insertedRows,
          syncMode,
          bootstrap: !useDelta,
        });

        if (useDelta) {
          const pendingSemanticModel = {
            ...semanticModel,
            pendingExternalSnapshot: {
              mode: "incremental",
              status: "publishing",
              attempt: lease.attempt,
              pendingTargetTable: targetTable,
              pendingStageTable: stagingTableName,
              cleanupTargets: carriedCleanupTargets,
              startedAt: startedAt.toISOString(),
              publishStartedAt: completedAt.toISOString(),
              jobId: lease.jobId,
            },
          };
          await this.db.transaction(async (tx) => {
            await assertDataSourceJobLease(tx, companyId, id, lease);
            await tx.update(dataSourceTables).set({ semanticModel: pendingSemanticModel })
              .where(and(eq(dataSourceTables.id, table.id), eq(dataSourceTables.dataSourceId, id), eq(dataSourceTables.companyId, companyId)));
          });
          await this.db.transaction(async (tx) => {
            await assertDataSourceJobLease(tx, companyId, id, lease);
            await publish();
            await assertDataSourceJobLease(tx, companyId, id, lease);
            const nextDeltaTables = insertedRows > 0
              ? [...savedDeltaTables, deltaTableName]
              : savedDeltaTables;
            let rowCount = table.rowCount;
            if (insertedRows > 0) {
              const quotedPrimaryKey = `\`${primaryKey.replaceAll("`", "``")}\``;
              const quotedDelta = `\`${deltaTableName}\``;
              // Keep the exact logical row count without rescanning the entire
              // snapshot: only changed keys from this delta are joined to the
              // prior deduplicated state. The base table is ordered by PK.
              const countResult = await clickhouse.query<{ row_delta: number | string }>(
                `SELECT sum(multiIf(d.\`${SNAPSHOT_SYNC_DELETED_COLUMN}\` = 0 AND old._paperclip_row_exists = 0, 1, d.\`${SNAPSHOT_SYNC_DELETED_COLUMN}\` = 1 AND old._paperclip_row_exists = 1, -1, 0)) AS row_delta FROM ${quotedDelta} AS d LEFT JOIN (SELECT ${quotedPrimaryKey} AS ${quotedPrimaryKey}, toUInt8(1) AS _paperclip_row_exists FROM ${snapshotQuerySource(table)} WHERE ${quotedPrimaryKey} IN (SELECT ${quotedPrimaryKey} FROM ${quotedDelta})) AS old USING (${quotedPrimaryKey})`,
                clickhouse.getCompanyDatabase(companyId),
              );
              const rowDelta = Number(countResult.rows[0]?.row_delta ?? 0);
              if (!Number.isSafeInteger(rowDelta)) throw new Error("ClickHouse returned an invalid incremental snapshot row delta");
              rowCount = table.rowCount + rowDelta;
            }
            if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
              throw new Error("ClickHouse returned an invalid logical row count for the external snapshot");
            }
            await assertDataSourceJobLease(tx, companyId, id, lease);
            const nextSemanticModel = {
              ...pendingSemanticModel,
              clickhouseTable,
              clickhouseSchema: { ...(semanticModel.clickhouseSchema || {}), createTableDdl: ddl },
              externalSnapshot: {
                mode: "snapshot",
                engine: "merge_delta_v1",
                status: "ready",
                syncMode: "incremental",
                consistency,
                deleteSemantics: deletedAtColumn ? "soft_delete_column" : "full_reconciliation_required",
                primaryKey,
                updatedAtColumn,
                deletedAtColumn: deletedAtColumn || null,
                watermarkMicros: maximumWatermarkMicros.toString(),
                syncGeneration: insertedRows > 0 ? generation : Math.max(0, Number(previousSnapshot.syncGeneration) || 0),
                deltaTables: nextDeltaTables,
                rowCount,
                startedAt: previousSnapshot.startedAt || startedAt.toISOString(),
                completedAt: previousSnapshot.completedAt || completedAt.toISOString(),
                lastIncrementalAt: completedAt.toISOString(),
                jobId: lease.jobId,
              },
            };
            delete (nextSemanticModel as Record<string, unknown>).pendingExternalSnapshot;
            await tx.update(dataSourceTables).set({
              rowCount,
              semanticModel: nextSemanticModel,
              updatedAt: completedAt,
            }).where(and(
              eq(dataSourceTables.id, table.id),
              eq(dataSourceTables.dataSourceId, id),
              eq(dataSourceTables.companyId, companyId),
            ));
            const jobUpdate = await tx.execute(sql<{ id: string }>`
              UPDATE data_source_jobs
              SET progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
                    'stage', 'snapshot_publish'::text, 'completedTables', ${completedTables + 1}::integer,
                    'rowsScanned', ${insertedRows}::integer, 'lastPublishedTableId', ${table.id}::text,
                    'publishedTableIds', ${JSON.stringify(nextPublishedIds)}::text::jsonb,
                    'lastSnapshotAt', ${completedAt.toISOString()}::text
                  ),
                  lease_expires_at = now() + (${30 * 60 * 1000}::integer * interval '1 millisecond'),
                  updated_at = now()
              WHERE id = ${lease.jobId} AND company_id = ${companyId} AND data_source_id = ${id}
                AND status = 'running' AND lease_owner = ${lease.owner} AND attempt = ${lease.attempt}
                AND lease_expires_at > clock_timestamp()
              RETURNING id
            `);
            if (Array.from(jobUpdate).length !== 1) throw new DataSourceLeaseLostError();
          });
          if (insertedRows === 0) {
            await clickhouse.execute(`DROP TABLE IF EXISTS \`${deltaTableName}\``, clickhouse.getCompanyDatabase(companyId)).catch(() => {});
          }
          publishedTableIds.add(table.id);
          return;
        }

        const pendingSemanticModel = {
          ...semanticModel,
          clickhouseSchema: { ...(semanticModel.clickhouseSchema || {}), createTableDdl: ddl },
          pendingExternalSnapshot: {
            mode: "snapshot",
            status: "publishing",
            attempt: lease.attempt,
            pendingTargetTable: targetTable,
            pendingStageTable: stagingTableName,
            cleanupTargets: carriedCleanupTargets,
            startedAt: startedAt.toISOString(),
            publishStartedAt: completedAt.toISOString(),
            jobId: lease.jobId,
          },
        };
        await this.db.transaction(async (tx) => {
          await assertDataSourceJobLease(tx, companyId, id, lease);
          await tx.update(dataSourceTables).set({ semanticModel: pendingSemanticModel })
            .where(and(eq(dataSourceTables.id, table.id), eq(dataSourceTables.dataSourceId, id), eq(dataSourceTables.companyId, companyId)));
        });
        await this.db.transaction(async (tx) => {
          await assertDataSourceJobLease(tx, companyId, id, lease);
          await publish();
          await assertDataSourceJobLease(tx, companyId, id, lease);
          const deletedRows = await clickhouse.query<{ row_count: number | string }>(
            `SELECT count() AS row_count FROM \`${fullSnapshotTable}\` WHERE \`${SNAPSHOT_SYNC_DELETED_COLUMN}\` = 0`,
            clickhouse.getCompanyDatabase(companyId),
          );
          const rowCount = Number(deletedRows.rows[0]?.row_count ?? 0);
          if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("ClickHouse returned an invalid snapshot row count");
          await assertDataSourceJobLease(tx, companyId, id, lease);
          const nextSemanticModel = {
            ...pendingSemanticModel,
            clickhouseTable: fullSnapshotTable,
            externalSnapshot: {
              mode: "snapshot",
              engine: "merge_delta_v1",
              status: "ready",
              syncMode,
              consistency,
              deleteSemantics: deletedAtColumn ? "soft_delete_column" : "full_reconciliation_required",
              primaryKey,
              updatedAtColumn: updatedAtColumn || null,
              deletedAtColumn: deletedAtColumn || null,
              watermarkMicros: updatedAtColumn ? maximumWatermarkMicros.toString() : null,
              syncGeneration: syncMode === "incremental" ? generation : 0,
              deltaTables: [],
              rowCount,
              startedAt: previousSnapshot.startedAt || startedAt.toISOString(),
              jobId: lease.jobId,
              completedAt: completedAt.toISOString(),
              lastFullSnapshotAt: completedAt.toISOString(),
            },
          };
          delete (nextSemanticModel as Record<string, unknown>).pendingExternalSnapshot;
          await tx.update(dataSourceTables).set({ rowCount, semanticModel: nextSemanticModel, updatedAt: completedAt })
            .where(and(eq(dataSourceTables.id, table.id), eq(dataSourceTables.dataSourceId, id), eq(dataSourceTables.companyId, companyId)));
          const jobUpdate = await tx.execute(sql<{ id: string }>`
            UPDATE data_source_jobs
            SET progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
                  'stage', 'snapshot_publish'::text, 'completedTables', ${completedTables + 1}::integer,
                  'rowsScanned', ${insertedRows}::integer, 'lastPublishedTableId', ${table.id}::text,
                  'publishedTableIds', ${JSON.stringify(nextPublishedIds)}::text::jsonb,
                  'lastSnapshotAt', ${completedAt.toISOString()}::text
                ),
                lease_expires_at = now() + (${30 * 60 * 1000}::integer * interval '1 millisecond'),
                updated_at = now()
            WHERE id = ${lease.jobId} AND company_id = ${companyId} AND data_source_id = ${id}
              AND status = 'running' AND lease_owner = ${lease.owner} AND attempt = ${lease.attempt}
              AND lease_expires_at > clock_timestamp()
            RETURNING id
          `);
          if (Array.from(jobUpdate).length !== 1) throw new DataSourceLeaseLostError();
        });
        publishedTableIds.add(table.id);
      };

      const synced = await clickhouse.syncTableFromStream(
        targetTable,
        ddl,
        rowStream(),
        companyId,
        publishProgress,
        publicationFence,
        undefined,
        { stagingTableName, signal },
      );
      if (synced.insertedCount !== scannedRows) {
        throw new Error(`ClickHouse received ${synced.insertedCount} rows; external scan counted ${scannedRows}`);
      }
      if (!useDelta && savedDeltaTables.length > 0) {
        const deltaPrefix = `${clickhouseTable.slice(0, 31)}__d_`;
        const safeDeltaTables = savedDeltaTables.filter((name) =>
          /^[A-Za-z0-9_]+$/.test(name) && name.startsWith(deltaPrefix),
        );
        for (const oldDeltaTable of safeDeltaTables) {
          await clickhouse.execute(`DROP TABLE IF EXISTS \`${oldDeltaTable}\``, clickhouse.getCompanyDatabase(companyId)).catch((error) => {
            console.warn(`[DataSourcesService] Could not remove compacted external snapshot delta ${oldDeltaTable}:`,
              error instanceof Error ? error.message : error);
          });
        }
      }
      if (!useDelta && clickhouseTable !== fullSnapshotTable && /^[A-Za-z0-9_]+$/.test(clickhouseTable)) {
        await clickhouse.execute(`DROP TABLE IF EXISTS \`${clickhouseTable}\``, clickhouse.getCompanyDatabase(companyId)).catch((error) => {
          console.warn(`[DataSourcesService] Could not remove compacted external snapshot base ${clickhouseTable}:`,
            error instanceof Error ? error.message : error);
        });
      }
      if (useDelta && synced.insertedCount === 0) {
        await clickhouse.execute(`DROP TABLE IF EXISTS \`${deltaTableName}\``, clickhouse.getCompanyDatabase(companyId)).catch(() => {});
      }
      for (const staleTarget of carriedCleanupTargets) {
        await clickhouse.execute(`DROP TABLE IF EXISTS \`${staleTarget}\``, clickhouse.getCompanyDatabase(companyId))
          .catch(() => {});
      }
      completedTables += 1;
      await lease.reportProgress?.("snapshot_table_done", {
        tableName: table.tableName,
        completedTables,
        totalTables: tables.length,
        rowsScanned: synced.insertedCount,
        syncMode,
        bootstrap: !useDelta,
      });
    }
    await lease.reportProgress?.("snapshot_done", { completedTables, totalTables: tables.length });
  }

  /** Queue an offline, resumable migration between the two supported RAG vector spaces. */
  async enqueueEmbeddingReindex(
    companyId: string,
    id: string,
    targetSpace: EmbeddingSpace,
    actor: SnapshotActor,
    requestedGeneration?: string,
    requestedModelGeneration?: string,
  ): Promise<DataSourceIngestionJob> {
    const result = await this.db.transaction(async (tx) => {
      const [source] = await tx.select().from(dataSources).where(and(
        eq(dataSources.id, id), eq(dataSources.companyId, companyId),
      )).limit(1).for("update");
      if (!source) throw notFound(`Data source not found: ${id}`);
      const isStructured = ["csv", "excel", "postgres", "mysql", "mariadb", "clickhouse"].includes(source.sourceType);
      if (source.sourceType !== "rag_document" && !isStructured) {
        throw unprocessable("Embedding reindex is only available for RAG documents and structured database/tabular sources");
      }
      if (source.status !== "ready") throw conflict("Only a ready datasource can change its active embedding space");
      if (!await this.embeddingReindexStore.hasEmbeddingSpace(targetSpace)) {
        throw unprocessable(`The pgvector sidecar for ${targetSpace} is unavailable; run this job on the configured PostgreSQL data plane`);
      }

      let [chunkCountRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(dataSourceChunks).where(and(
        eq(dataSourceChunks.companyId, companyId), eq(dataSourceChunks.dataSourceId, id),
      ));
      let chunkCount = Number(chunkCountRow?.count || 0);

      // If structured source and no schema chunks yet, synthesize schema corpus chunks from tables
      if (chunkCount < 1 && isStructured) {
        const tables = await tx.select().from(dataSourceTables).where(and(
          eq(dataSourceTables.companyId, companyId),
          eq(dataSourceTables.dataSourceId, id),
        ));
        if (tables.length > 0) {
          let chunkIdx = 0;
          for (const t of tables) {
            const cols = (t.schemaDefinition as any[]) || [];
            const sem = (t.semanticModel as any) || {};
            const colText = cols.map((c: any) => `${c.name} (${c.dataType || "string"}${c.role ? `, role: ${c.role}` : ""})`).join(", ");
            const metricText = (sem.metrics || []).slice(0, 100).map((m: any) =>
              `${m.name || m} [${m.aggregation || "unknown"} · ${m.column || m.physicalColumn || "unbound"}]${m.description ? `: ${m.description}` : ""}`,
            ).join("; ");
            const dimensionText = (sem.dimensions || []).slice(0, 100).map((dimension: any) =>
              `${dimension.name || dimension} [${dimension.column || "unbound"}]${dimension.description ? `: ${dimension.description}` : ""}`,
            ).join("; ");
            const content = [
              `Table: ${t.tableName}`,
              `Role: ${sem.tableRole || "table"}`,
              `Columns: ${colText}`,
              metricText ? `Metrics: ${metricText}` : "",
              dimensionText ? `Dimensions: ${dimensionText}` : "",
            ].filter(Boolean).join("\n").slice(0, 24_000);
            await tx.insert(dataSourceChunks).values({
              companyId,
              dataSourceId: id,
              chunkIndex: chunkIdx++,
              title: `Schema: ${t.tableName}`,
              content,
              metadata: {
                corpusKind: "schema",
                tableId: t.id,
                tableName: t.tableName,
              },
            });
          }
          chunkCount = tables.length;
        }
      }

      if (chunkCount < 1) throw unprocessable("This datasource has no published chunks or schema tables to re-embed");

      const [activeJob] = await tx.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
        eq(dataSourceJobs.companyId, companyId), eq(dataSourceJobs.dataSourceId, id),
        inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
      )).limit(1);
      if (activeJob) throw conflict(`Data source ${id} already has an active datasource job`);

      const sourceMetadata = (source.metadata || {}) as Record<string, unknown>;
      const fromSpace = sourceMetadata.embeddingSpace === "bge-m3"
        || sourceMetadata.embeddingSpace === "openrouter-text-embedding-3-small"
        ? sourceMetadata.embeddingSpace as EmbeddingSpace
        : null;
      const fromGeneration = typeof sourceMetadata.embeddingGeneration === "string"
        ? sourceMetadata.embeddingGeneration
        : fromSpace;
      const targetGeneration = requestedGeneration || this.embeddingReindexModels.embeddingGeneration(targetSpace);
      const targetModelGeneration = requestedModelGeneration
        || (requestedGeneration ? requestedGeneration : this.embeddingReindexModels.embeddingGeneration(targetSpace));
      if (!/^[a-zA-Z0-9._:/@-]{1,256}$/.test(targetGeneration)) {
        throw unprocessable("Target embedding generation must be a short model or revision identifier");
      }
      if (!/^[a-zA-Z0-9._:/@-]{1,256}$/.test(targetModelGeneration)) {
        throw unprocessable("Target embedding model generation must be a short model identifier");
      }
      if (requestedGeneration && fromSpace === targetSpace && fromGeneration === targetGeneration) {
        throw conflict(`Datasource already uses embedding generation ${targetGeneration}`);
      }
      const targetCoverage = await this.embeddingReindexStore.embeddingCoverage(companyId, id, targetSpace, targetGeneration, tx);
      const reuseExistingVectors = requestedGeneration !== undefined
        && targetCoverage.chunkCount === chunkCount
        && targetCoverage.embeddingCount === chunkCount;

      const [job] = await tx.insert(dataSourceJobs).values({
        companyId,
        dataSourceId: id,
        jobType: "embedding_reindex",
        status: "queued",
        stage: "queued",
        progress: {
          fromSpace,
          fromGeneration,
          targetSpace,
          targetGeneration,
          targetModelGeneration,
          targetGenerationResolved: requestedGeneration !== undefined,
          totalChunks: chunkCount,
          processedChunks: 0,
          nextChunkId: null,
          reuseExistingVectors,
        },
        idempotencyKey: `embedding-reindex:${id}:${targetSpace}:${randomUUID()}`,
      }).returning();

      await tx.insert(activityLog).values({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "data_source.embedding_reindex.queued",
        entityType: "data_source",
        entityId: id,
        agentId: actor.agentId || null,
        runId: actor.runId || null,
        details: { jobId: job.id, fromSpace, fromGeneration, targetSpace, targetGeneration, chunkCount, reuseExistingVectors },
      });
      await tx.update(dataSources).set({
        metadata: {
          ...sourceMetadata,
          // Keep the previous published generation active during a reindex;
          // first-time indexing has no usable pointer and remains pending.
          embeddingStatus: fromSpace
            ? (typeof sourceMetadata.embeddingStatus === "string" ? sourceMetadata.embeddingStatus : "ready")
            : "pending",
          embeddingReindexStatus: "pending",
          embeddingTargetSpace: targetSpace,
          embeddingTargetGeneration: targetGeneration,
        },
        updatedAt: new Date(),
      }).where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
      return job;
    });
    return result as DataSourceIngestionJob;
  }

  /**
   * Queue missing schema embeddings for ready structured sources. This is run
   * by the durable embedding worker, so a restart between onboarding and
   * indexing cannot silently leave a source permanently lexical-only.
   */
  async reconcilePendingStructuredEmbeddingJobs(limit = 8): Promise<number> {
    const sourceTypes = ["csv", "excel", "postgres", "mysql", "mariadb", "clickhouse"] as const;
    const sources = await this.db.select({
      id: dataSources.id,
      companyId: dataSources.companyId,
      metadata: dataSources.metadata,
    }).from(dataSources).where(and(
      eq(dataSources.status, "ready"),
      inArray(dataSources.sourceType, [...sourceTypes]),
    )).orderBy(dataSources.updatedAt).limit(50);

    const modelConfig = parseDataSourceModelConfig();
    const preferredSpace: EmbeddingSpace = modelConfig.embeddingProvider === "openrouter"
      ? "openrouter-text-embedding-3-small"
      : "bge-m3";
    const fallbackSpace: EmbeddingSpace = preferredSpace === "bge-m3"
      ? "openrouter-text-embedding-3-small"
      : "bge-m3";
    const hasPreferredSpace = await this.embeddingReindexStore.hasEmbeddingSpace(preferredSpace);
    const targetSpace = hasPreferredSpace
      ? preferredSpace
      : modelConfig.embeddingProvider === "auto"
        && await this.embeddingReindexStore.hasEmbeddingSpace(fallbackSpace)
        ? fallbackSpace
        : null;
    if (!targetSpace) return 0;

    let queued = 0;
    for (const source of sources) {
      if (queued >= Math.max(1, Math.min(50, limit))) break;
      const metadata = (source.metadata || {}) as Record<string, unknown>;
      const hasPublishedGeneration = (metadata.embeddingSpace === "bge-m3"
          || metadata.embeddingSpace === "openrouter-text-embedding-3-small")
        && typeof metadata.embeddingGeneration === "string";
      if (metadata.embeddingStatus === "unavailable"
        || metadata.embeddingReindexStatus === "failed"
        || metadata.embeddingReindexStatus === "cancelled"
        || (metadata.embeddingStatus === "ready" && hasPublishedGeneration)) continue;

      const [activeJob] = await this.db.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
        eq(dataSourceJobs.companyId, source.companyId),
        eq(dataSourceJobs.dataSourceId, source.id),
        inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
      )).limit(1);
      if (activeJob) continue;

      try {
        const semanticRevision = Number(metadata.semanticMappingRevision);
        const modelGeneration = this.embeddingReindexModels.embeddingGeneration(targetSpace);
        const requestedGeneration = Number.isSafeInteger(semanticRevision) && semanticRevision > 0
          ? semanticMappingEmbeddingGeneration(modelGeneration, semanticRevision)
          : undefined;
        await this.enqueueEmbeddingReindex(source.companyId, source.id, targetSpace, {
          actorType: "system",
          actorId: "datasource-embedding-scheduler",
        }, requestedGeneration, requestedGeneration ? modelGeneration : undefined);
        queued += 1;
      } catch (error) {
        // Another worker may win the same source between the active-job check
        // and enqueue's transactional lock. Treat that as successful recovery.
        if (error instanceof Error && error.message.includes("already has an active datasource job")) continue;
        if (error instanceof Error && error.message.includes("no published chunks or schema tables")) {
          await this.db.update(dataSources).set({
            metadata: { ...metadata, embeddingStatus: "unavailable" },
            updatedAt: new Date(),
          }).where(and(eq(dataSources.id, source.id), eq(dataSources.companyId, source.companyId)));
          continue;
        }
        throw error;
      }
    }
    return queued;
  }

  /** Preview or delete stale sidecar vectors while protecting active and rollback generations. */
  async pruneEmbeddingGenerations(
    companyId: string,
    id: string,
    actor: SnapshotActor,
    confirm: boolean,
    expectedGenerations?: Array<{ embeddingSpace: EmbeddingSpace; embeddingGeneration: string }>,
  ): Promise<{
    dryRun: boolean;
    retentionDays: number;
    cutoff: string;
    candidates: PrunableEmbeddingGeneration[];
    candidateVectorRows: number;
    deletedGenerations: Array<PrunableEmbeddingGeneration & { deletedRows: number }>;
    deletedRows: number;
  }> {
    return this.db.transaction(async (tx) => {
      const [source] = await tx.select().from(dataSources).where(and(
        eq(dataSources.id, id), eq(dataSources.companyId, companyId),
      )).limit(1).for("update");
      if (!source) throw notFound(`Data source not found: ${id}`);
      if (source.sourceType !== "rag_document") throw unprocessable("Embedding cleanup is only available for RAG document sources");
      if (source.status !== "ready") throw conflict("Only a ready RAG datasource can prune retained embedding generations");

      const [activeJob] = await tx.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
        eq(dataSourceJobs.companyId, companyId), eq(dataSourceJobs.dataSourceId, id),
        inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
      )).limit(1);
      if (activeJob) throw conflict(`Data source ${id} has an active datasource job; retry embedding cleanup after it finishes`);
      if (confirm && (!expectedGenerations || expectedGenerations.length === 0)) {
        throw unprocessable("Confirmed embedding cleanup must include the generation identities returned by preview");
      }

      const metadata = (source.metadata || {}) as Record<string, unknown>;
      const pinned: Array<{ embeddingSpace: EmbeddingSpace; embeddingGeneration: string }> = [];
      const addPinned = (spaceValue: unknown, generationValue: unknown) => {
        if (spaceValue !== "bge-m3" && spaceValue !== "openrouter-text-embedding-3-small") return;
        const generation = typeof generationValue === "string" && generationValue.length > 0
          ? generationValue
          : spaceValue;
        if (!pinned.some((entry) => entry.embeddingSpace === spaceValue && entry.embeddingGeneration === generation)) {
          pinned.push({ embeddingSpace: spaceValue, embeddingGeneration: generation });
        }
      };
      addPinned(metadata.embeddingSpace, metadata.embeddingGeneration);
      addPinned(metadata.previousEmbeddingSpace, metadata.previousEmbeddingGeneration);

      const cutoffDate = new Date(Date.now() - EMBEDDING_GENERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const eligible = await this.embeddingReindexStore.listPrunableGenerations(
        companyId, id, cutoffDate, pinned, tx,
      );
      const expectedKeys = new Set((expectedGenerations || []).map((entry) => `${entry.embeddingSpace}\0${entry.embeddingGeneration}`));
      const candidates = confirm
        ? eligible.filter((entry) => expectedKeys.has(`${entry.embeddingSpace}\0${entry.embeddingGeneration}`))
        : eligible;
      const candidateVectorRows = candidates.reduce((total, generation) => total + generation.rowCount, 0);
      const deletedGenerations: Array<PrunableEmbeddingGeneration & { deletedRows: number }> = [];
      let deletedRows = 0;
      if (confirm) {
        for (const generation of candidates) {
          const count = await this.embeddingReindexStore.deleteGenerationRows(companyId, id, generation, cutoffDate, tx);
          deletedGenerations.push({ ...generation, deletedRows: count });
          deletedRows += count;
        }
        await tx.insert(activityLog).values({
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "data_source.embedding_generations.pruned",
          entityType: "data_source",
          entityId: id,
          agentId: actor.agentId || null,
          runId: actor.runId || null,
          details: {
            retentionDays: EMBEDDING_GENERATION_RETENTION_DAYS,
            cutoff: cutoffDate.toISOString(),
            candidateVectorRows,
            deletedRows,
            generations: deletedGenerations.map(({ embeddingSpace, embeddingGeneration, deletedRows: rows }) => ({
              embeddingSpace,
              embeddingGeneration,
              deletedRows: rows,
            })),
          },
        });
      }
      return {
        dryRun: !confirm,
        retentionDays: EMBEDDING_GENERATION_RETENTION_DAYS,
        cutoff: cutoffDate.toISOString(),
        candidates,
        candidateVectorRows,
        deletedGenerations,
        deletedRows,
      };
    });
  }

  /** Re-embed a datasource in bounded, lease-fenced batches and publish with one metadata-pointer update. */
  async runEmbeddingReindex(
    companyId: string,
    id: string,
    progress: Record<string, unknown>,
    lease: DataSourceJobLease,
  ): Promise<void> {
    throwIfIngestionAborted(lease);
    let targetSpace = progress.targetSpace as EmbeddingSpace;
    let targetGeneration = typeof progress.targetGeneration === "string" ? progress.targetGeneration : "";
    let targetModelGeneration = typeof progress.targetModelGeneration === "string"
      ? progress.targetModelGeneration
      : targetGeneration;
    let targetGenerationResolved = progress.targetGenerationResolved !== false;
    const fromSpace = progress.fromSpace;
    const fromGeneration = progress.fromGeneration;
    const expectedChunkCount = Number(progress.totalChunks);
    if ((targetSpace !== "bge-m3" && targetSpace !== "openrouter-text-embedding-3-small")
      || !/^[a-zA-Z0-9._:/@-]{1,256}$/.test(targetGeneration)
      || (fromSpace !== null && fromSpace !== "bge-m3" && fromSpace !== "openrouter-text-embedding-3-small")
      || (fromGeneration !== null && (typeof fromGeneration !== "string" || !/^[a-zA-Z0-9._:/@-]{1,256}$/.test(fromGeneration)))
      || !Number.isSafeInteger(expectedChunkCount) || expectedChunkCount < 1) {
      throw new Error("Embedding reindex job checkpoint is invalid");
    }
    if (!await this.embeddingReindexStore.hasEmbeddingSpace(targetSpace)) {
      throw new Error(`The pgvector sidecar for ${targetSpace} is unavailable`);
    }

    const [source] = await this.db.select().from(dataSources).where(and(
      eq(dataSources.id, id), eq(dataSources.companyId, companyId),
    )).limit(1);
    if (!source) throw new Error(`Data source not found: ${id}`);
    const isSupported = source.sourceType === "rag_document" || ["csv", "excel", "postgres", "mysql", "mariadb", "clickhouse"].includes(source.sourceType);
    if (!isSupported || source.status !== "ready") {
      throw new Error("Embedding reindex requires a ready RAG document or structured datasource");
    }
    const sourceMetadata = (source.metadata || {}) as Record<string, unknown>;
    const currentSpace = sourceMetadata.embeddingSpace === "bge-m3"
      || sourceMetadata.embeddingSpace === "openrouter-text-embedding-3-small"
      ? sourceMetadata.embeddingSpace
      : null;
    const currentGeneration = typeof sourceMetadata.embeddingGeneration === "string"
      ? sourceMetadata.embeddingGeneration
      : currentSpace;
    if (currentSpace !== fromSpace || currentGeneration !== fromGeneration) throw new DataSourceLeaseLostError();

    let cursor = typeof progress.nextChunkId === "string" && UUID_PATTERN.test(progress.nextChunkId)
      ? progress.nextChunkId
      : null;
    let processedChunks = Number.isSafeInteger(progress.processedChunks) ? Number(progress.processedChunks) : 0;
    let modelBackend = typeof progress.modelBackend === "string" ? progress.modelBackend : null;
    const initiallyCovered = progress.reuseExistingVectors === true;
    const startingCoverage = initiallyCovered
      ? await this.embeddingReindexStore.embeddingCoverage(companyId, id, targetSpace, targetGeneration)
      : null;
    const reuseCompleteGeneration = Boolean(startingCoverage
      && startingCoverage.chunkCount === expectedChunkCount
      && startingCoverage.embeddingCount === expectedChunkCount);
    if (initiallyCovered && !reuseCompleteGeneration) {
      cursor = null;
      processedChunks = 0;
    }

    if (!reuseCompleteGeneration) {
      while (true) {
        throwIfIngestionAborted(lease);
        const predicates = [
          eq(dataSourceChunks.companyId, companyId),
          eq(dataSourceChunks.dataSourceId, id),
        ];
        if (cursor) predicates.push(gt(dataSourceChunks.id, cursor));
        const batch = await this.db.select({
          id: dataSourceChunks.id,
          content: dataSourceChunks.content,
        }).from(dataSourceChunks).where(and(...predicates)).orderBy(dataSourceChunks.id).limit(EMBEDDING_REINDEX_BATCH_SIZE);
        if (batch.length === 0) break;

        const generated = await this.embeddingReindexModels.embed(batch.map((chunk) => chunk.content), targetSpace);
        if (generated.space === null && !generated.vectors) {
          // Neither local BGE nor external gateway is configured on this host.
          // Lexical retrieval is active; mark embedding status as unavailable and complete the job.
          await lease.reportProgress?.("embedding_reindex_unavailable", {
            reason: "No embedding provider is configured; instance operates in lexical-only mode",
          });
          const sourceMetadata = (source.metadata || {}) as Record<string, unknown>;
          await this.db.update(dataSources).set({
            metadata: {
              ...sourceMetadata,
              embeddingStatus: "unavailable",
              embeddingReindexStatus: "unavailable",
              embeddingSpace: null,
              embeddingGeneration: null,
            },
            updatedAt: new Date(),
          }).where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
          return;
        }
        if (targetSpace === "bge-m3" && generated.space === "openrouter-text-embedding-3-small"
          && parseDataSourceModelConfig().embeddingProvider === "auto"
          && generated.generation && /^[a-zA-Z0-9._:/@-]{1,256}$/.test(generated.generation)) {
          // If local BGE is unavailable, restart this generation in the gateway
          // space. Any partial BGE rows remain unpublished and can be pruned.
          targetSpace = generated.space;
          const semanticRevision = semanticMappingRevisionFromGeneration(targetGeneration);
          targetGeneration = semanticRevision === null
            ? generated.generation
            : semanticMappingEmbeddingGeneration(generated.generation, semanticRevision);
          targetModelGeneration = generated.generation;
          targetGenerationResolved = true;
          cursor = null;
          processedChunks = 0;
          modelBackend = generated.backend || "openrouter";
          await lease.reportProgress?.("embedding_reindex_fallback", {
            targetSpace,
            targetGeneration,
            targetModelGeneration,
            targetGenerationResolved,
            nextChunkId: null,
            processedChunks: 0,
            totalChunks: expectedChunkCount,
            modelBackend,
          });
        }
        if (generated.space !== targetSpace || typeof generated.generation !== "string"
          || !/^[a-zA-Z0-9._:/@-]{1,256}$/.test(generated.generation)
          || (targetGenerationResolved && generated.generation !== targetModelGeneration)
          || !generated.vectors || generated.vectors.length !== batch.length) {
          throw new Error(`Embedding provider did not produce a complete ${targetSpace} batch`);
        }
        if (!targetGenerationResolved) {
          // The first provider response resolves gateway aliases to the model ID
          // actually used. Persist that identity before writing vectors so a
          // retried worker cannot silently switch models mid-generation.
          targetGeneration = generated.generation;
          targetModelGeneration = generated.generation;
          targetGenerationResolved = true;
          await lease.reportProgress?.("embedding_reindex_generation_resolved", {
            targetSpace,
            targetGeneration,
            targetModelGeneration,
            targetGenerationResolved,
            nextChunkId: cursor,
            processedChunks,
            totalChunks: expectedChunkCount,
            modelBackend: generated.backend || modelBackend || "unknown",
          });
        }
        modelBackend = generated.backend || modelBackend;
        const vectors: ReindexVectorInput[] = batch.map((chunk, index) => ({
          chunkId: chunk.id,
          companyId,
          dataSourceId: id,
          embeddingSpace: targetSpace,
          embeddingGeneration: targetGeneration,
          embedding: generated.vectors![index]!,
        }));
        await this.embeddingReindexStore.upsertChunkEmbeddings(vectors, { companyId, sourceId: id, lease });
        cursor = batch[batch.length - 1]!.id;
        processedChunks += batch.length;
        await lease.reportProgress?.("embedding_reindex_batch", {
          targetSpace,
          targetGeneration,
          targetModelGeneration,
          nextChunkId: cursor,
          processedChunks,
          totalChunks: expectedChunkCount,
          modelBackend: modelBackend || "unknown",
        });
      }
    }

    throwIfIngestionAborted(lease);
    const coverage = await this.embeddingReindexStore.embeddingCoverage(companyId, id, targetSpace, targetGeneration);
    if (coverage.chunkCount !== expectedChunkCount || coverage.embeddingCount !== expectedChunkCount) {
      throw new Error(`Target embedding generation is incomplete (${coverage.embeddingCount}/${coverage.chunkCount} chunks)`);
    }
    await lease.reportProgress?.("embedding_reindex_publish", {
      targetSpace,
      targetModelGeneration,
      processedChunks: expectedChunkCount,
      totalChunks: expectedChunkCount,
      modelBackend: modelBackend || "existing-vector-generation",
    });

    await this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, id, lease);
      const [lockedSource] = await tx.select().from(dataSources).where(and(
        eq(dataSources.id, id), eq(dataSources.companyId, companyId),
      )).limit(1).for("update");
      const isStructured = lockedSource
        && ["csv", "excel", "postgres", "mysql", "mariadb", "clickhouse"].includes(lockedSource.sourceType);
      if (!lockedSource || (lockedSource.sourceType !== "rag_document" && !isStructured) || lockedSource.status !== "ready") {
        throw new DataSourceLeaseLostError();
      }
      const lockedMetadata = (lockedSource.metadata || {}) as Record<string, unknown>;
      const lockedSpace = lockedMetadata.embeddingSpace === "bge-m3"
        || lockedMetadata.embeddingSpace === "openrouter-text-embedding-3-small"
        ? lockedMetadata.embeddingSpace
        : null;
      const lockedGeneration = typeof lockedMetadata.embeddingGeneration === "string"
        ? lockedMetadata.embeddingGeneration
        : lockedSpace;
      if (lockedSpace !== fromSpace || lockedGeneration !== fromGeneration) throw new DataSourceLeaseLostError();

      const finalCoverage: EmbeddingCoverage = await this.embeddingReindexStore.embeddingCoverage(
        companyId, id, targetSpace, targetGeneration, tx,
      );
      if (finalCoverage.chunkCount !== expectedChunkCount || finalCoverage.embeddingCount !== expectedChunkCount) {
        throw new Error("Target embedding generation changed before atomic publication");
      }
      const now = new Date();
      const publishedBackend = modelBackend
        || (targetSpace === "bge-m3" ? "local-bge-m3" : "openrouter");
      const publishedMetadata = { ...lockedMetadata };
      delete publishedMetadata.embeddingTargetSpace;
      delete publishedMetadata.embeddingTargetGeneration;
      publishedMetadata.embeddingReindexStatus = "complete";
      publishedMetadata.embeddingSpace = targetSpace;
      publishedMetadata.embeddingGeneration = targetGeneration;
      publishedMetadata.embeddingBackend = publishedBackend;
      publishedMetadata.embeddingStatus = "ready";
      publishedMetadata.previousEmbeddingSpace = fromSpace;
      publishedMetadata.previousEmbeddingGeneration = fromGeneration;
      publishedMetadata.embeddingReindexedAt = now.toISOString();
      await tx.update(dataSources).set({
        metadata: publishedMetadata,
        updatedAt: now,
      }).where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
      await tx.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "datasource-embedding-worker",
        action: "data_source.embedding_reindex.published",
        entityType: "data_source",
        entityId: id,
        details: {
          jobId: lease.jobId,
          fromSpace,
          targetSpace,
          targetGeneration,
          chunkCount: finalCoverage.chunkCount,
          modelBackend: publishedBackend,
        },
      });
      await completeDataSourceJobLease(tx, companyId, id, lease);
    });
  }

  async enqueueReprocess(companyId: string, id: string): Promise<DataSource> {
    const result = await this.db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(dataSources)
        .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
        .limit(1).for("update");
      if (!source) throw notFound(`Data source not found: ${id}`);
      if (!source.storagePath) throw unprocessable(`Data source ${id} has no persisted file to reprocess`);
      const [activeJob] = await tx.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
        eq(dataSourceJobs.companyId, companyId), eq(dataSourceJobs.dataSourceId, id),
        inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
      )).limit(1);
      if (activeJob) throw conflict(`Data source ${id} already has an active ingestion job`);
      const sourceMetadata = (source.metadata || {}) as Record<string, unknown>;
      const previousStatus = typeof sourceMetadata.reprocessingPreviousStatus === "string"
        ? sourceMetadata.reprocessingPreviousStatus
        : source.status;
      const queuedMetadata = { ...sourceMetadata, reprocessingPreviousStatus: previousStatus };
      const [updated] = await tx
        .update(dataSources)
        .set({ status: "processing", metadata: queuedMetadata, updatedAt: new Date() })
        .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
        .returning();
      const [job] = await tx
        .insert(dataSourceJobs)
        .values({
          companyId,
          dataSourceId: id,
          jobType: "ingest_file",
          status: "queued",
          stage: "queued",
          idempotencyKey: `reprocess:${id}:${randomUUID()}`,
        })
        .returning();
      return { updated, job };
    });

    return {
      ...(result.updated as any),
      sourceType: result.updated.sourceType as any,
      status: result.updated.status as any,
      ingestionJob: result.job,
    } as DataSource;
  }

  async cancelIngestionJob(
    companyId: string,
    sourceId: string,
    jobId: string,
    actor: SnapshotActor,
  ): Promise<DataSourceIngestionJob> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx.select().from(dataSourceJobs).where(and(
        eq(dataSourceJobs.id, jobId),
        eq(dataSourceJobs.companyId, companyId),
        eq(dataSourceJobs.dataSourceId, sourceId),
      )).limit(1).for("update");
      if (!job) throw notFound("Ingestion job not found");
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        throw conflict(`Cannot cancel an ingestion job in ${job.status} state`);
      }
      if (job.status === "cancel_requested") return job as DataSourceIngestionJob;
      if (["publishing", "snapshot_publish", "snapshot_done", "embedding_reindex_publish", "completed"].includes(job.stage)) {
        throw conflict("The datasource job is publishing its completed version and can no longer be cancelled");
      }

      const nextStatus = job.status === "queued" ? "cancelled" : "cancel_requested";
      const nextStage = job.status === "queued" ? "cancelled" : "cancel_requested";
      const now = new Date();
      const [updatedJob] = await tx.update(dataSourceJobs).set({
        status: nextStatus,
        stage: nextStage,
        progress: {
          ...(job.progress || {}),
          cancelRequestedAt: now.toISOString(),
          ...(job.status === "queued" ? { cancelledAt: now.toISOString() } : {}),
        },
        completedAt: job.status === "queued" ? now : null,
        updatedAt: now,
      }).where(and(
        eq(dataSourceJobs.id, jobId),
        eq(dataSourceJobs.companyId, companyId),
        eq(dataSourceJobs.dataSourceId, sourceId),
      )).returning();

      if (job.jobType === "ingest_file" && job.status === "queued") {
        const [source] = await tx.select().from(dataSources).where(and(
          eq(dataSources.id, sourceId), eq(dataSources.companyId, companyId),
        )).limit(1).for("update");
        if (source) {
          const metadata = (source.metadata || {}) as Record<string, unknown>;
          const priorStatus = metadata.reprocessingPreviousStatus;
          const restoredStatus = priorStatus === "ready" || priorStatus === "error" || priorStatus === "onboarding"
            ? priorStatus
            : "error";
          const restoredMetadata = { ...metadata };
          delete restoredMetadata.reprocessingPreviousStatus;
          await tx.update(dataSources).set({
            status: restoredStatus,
            metadata: restoredMetadata,
            updatedAt: now,
          }).where(and(eq(dataSources.id, sourceId), eq(dataSources.companyId, companyId)));
        }
      }

      if (job.jobType === "embedding_reindex") {
        const [source] = await tx.select().from(dataSources).where(and(
          eq(dataSources.id, sourceId), eq(dataSources.companyId, companyId),
        )).limit(1).for("update");
        if (source) {
          const metadata = (source.metadata || {}) as Record<string, unknown>;
          await tx.update(dataSources).set({
            metadata: {
              ...metadata,
              embeddingReindexStatus: "cancelled",
              embeddingStatus: metadata.embeddingSpace ? metadata.embeddingStatus || "ready" : "unavailable",
            },
            updatedAt: now,
          }).where(and(eq(dataSources.id, sourceId), eq(dataSources.companyId, companyId)));
        }
      }

      await tx.insert(activityLog).values({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId || null,
        runId: actor.runId || null,
        action: job.jobType === "embedding_reindex"
          ? (job.status === "queued" ? "data_source.embedding_reindex.cancelled" : "data_source.embedding_reindex.cancel_requested")
          : job.status === "queued" ? "data_source.ingestion.cancelled" : "data_source.ingestion.cancel_requested",
        entityType: "data_source",
        entityId: sourceId,
        details: { jobId, jobType: job.jobType, priorStage: job.stage },
      });
      return updatedJob as DataSourceIngestionJob;
    });
  }

  /**
   * Reprocess a single data source by re-running its onboarding pipeline
   */
  async reprocess(companyId: string, id: string, lease: DataSourceJobLease): Promise<DataSource> {
    throwIfIngestionAborted(lease);
    const ds = await this.getById(companyId, id);
    if (!ds) {
      throw new Error(`Data source not found: ${id}`);
    }

    const storageBackend = (ds.metadata as any)?.storageBackend;
    if (!ds.storagePath || (storageBackend !== "s3" && !fs.existsSync(ds.storagePath))) {
      throw new Error(`File sumber fisik tidak ditemukan di disk: ${ds.storagePath || "kosong"}`);
    }
    const loadedMetadata = (ds.metadata as Record<string, unknown> | null) || {};
    const previousCutoff = reprocessingCutoff(loadedMetadata);
    const originalMetadata = Object.fromEntries(
      Object.entries(loadedMetadata).filter(([key]) => !key.startsWith("reprocessing")),
    );
    const savedStatus = loadedMetadata.reprocessingPreviousStatus;
    const originalStatus = typeof savedStatus === "string" ? savedStatus : ds.status;
    const clockResult = await this.db.execute(sql<{ startedAt: Date | string }>`
      SELECT clock_timestamp() AS "startedAt"
    `);
    const clockRow = Array.from(clockResult as Iterable<{ startedAt: Date | string }>)[0];
    const processingCutoff = new Date(clockRow?.startedAt ?? Date.now());
    if (Number.isNaN(processingCutoff.getTime())) throw new Error("Could not establish a datasource reprocessing cutoff");
    const processingCutoffIso = processingCutoff.toISOString();
    const processingToken = randomUUID();
    let publishedCommitted = false;
    const dropClickhouseTables = async (tables: Array<{ semanticModel: unknown }>) => {
      const clickhouse = new ClickhouseService();
      const companyDb = clickhouse.getCompanyDatabase(companyId);
      for (const table of tables) {
        const tableName = (table.semanticModel as Record<string, unknown> | null)?.clickhouseTable;
        if (typeof tableName !== "string" || !/^[a-zA-Z0-9_]+$/.test(tableName)) continue;
        await clickhouse.execute(`DROP TABLE IF EXISTS \`${tableName}\``, companyDb).catch(() => {});
      }
    };

    const abandonedTables = previousCutoff
      ? await this.db.select({ semanticModel: dataSourceTables.semanticModel })
          .from(dataSourceTables)
          .where(and(eq(dataSourceTables.dataSourceId, id), gte(dataSourceTables.createdAt, previousCutoff)))
      : [];
    const stagedMetadata = {
      ...originalMetadata,
      reprocessingStartedAt: processingCutoffIso,
      reprocessingPreviousStatus: originalStatus,
      reprocessingToken: processingToken,
    };
    await this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, id, lease);
      const [current] = await tx.select({ id: dataSources.id }).from(dataSources)
        .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId))).for("update");
      if (!current) throw notFound("Datasource was removed before ingestion could start");
      if (previousCutoff) {
        await tx.delete(dataSourceTables).where(and(eq(dataSourceTables.dataSourceId, id), gte(dataSourceTables.createdAt, previousCutoff)));
        await tx.delete(dataSourceChunks).where(and(eq(dataSourceChunks.dataSourceId, id), gte(dataSourceChunks.createdAt, previousCutoff)));
      }
      await tx.update(dataSources)
        .set({ status: "processing", metadata: stagedMetadata, updatedAt: new Date() })
        .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
    });
    await dropClickhouseTables(abandonedTables);
    ds.metadata = stagedMetadata;

    const ext = path.extname(ds.fileName || "").toLowerCase().replace(".", "") || "csv";
    const streamingFormat = StructuredIngestionService.streamingFormatFor(ds.sourceType, ext);
    const streamCsv = streamingFormat === "csv";
    const streamExcel = streamingFormat === "xlsx";
    const streamStructuredFile = streamCsv || streamExcel;
    const streamingThreshold = Number(process.env.DATASOURCE_STREAMING_RAG_THRESHOLD_BYTES
      || process.env.DATASOURCE_STREAMING_CSV_THRESHOLD_BYTES
      || 8 * 1024 * 1024);
    const streamRagText = ds.sourceType === "rag_document"
      && KnowledgeIngestionService.isStreamableTextDocument(ds.fileName || `${ds.name}.${ext}`)
      && (ds.fileSize ?? 0) >= streamingThreshold;
    let temporaryPath: string | null = null;
    let csvSourceFingerprint = typeof originalMetadata.storageSha256 === "string"
      ? `sha256:${originalMetadata.storageSha256}`
      : undefined;

    try {
      let file: { buffer?: Buffer; filePath?: string; originalname: string; mimetype: string; size: number };
      await lease.reportProgress?.("source_download", { fileBytes: ds.fileSize ?? 0 });
      if (storageBackend === "s3" && (streamStructuredFile || streamRagText)) {
        temporaryPath = path.join(os.tmpdir(), `paperclip-datasource-reprocess-${randomUUID()}.${ext}`);
        const downloaded = await downloadDataSourceFileToPath(companyId, ds.storagePath, temporaryPath, lease.signal);
        throwIfIngestionAborted(lease);
        const expectedSha256 = originalMetadata.storageSha256;
        if (typeof expectedSha256 === "string" && expectedSha256 !== downloaded.sha256) {
          throw new Error("Datasource object checksum does not match its stored manifest");
        }
        if (ds.fileSize && ds.fileSize !== downloaded.byteSize) {
          throw new Error("Datasource object size does not match its stored manifest");
        }
        csvSourceFingerprint = `sha256:${downloaded.sha256}`;
        file = {
          filePath: temporaryPath,
          originalname: ds.fileName || `${ds.name}.${ext}`,
          mimetype: ds.mimeType || (streamCsv ? "text/csv" : streamExcel
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "text/plain"),
          size: downloaded.byteSize,
        };
      } else if (storageBackend !== "s3" && (streamStructuredFile || streamRagText)) {
        const stat = fs.statSync(ds.storagePath);
        csvSourceFingerprint ||= `stat:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        file = {
          filePath: ds.storagePath,
          originalname: ds.fileName || `${ds.name}.${ext}`,
          mimetype: ds.mimeType || (streamCsv ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
          size: stat.size,
        };
      } else {
        const fileBuffer = storageBackend === "s3"
          ? await readDataSourceFile(companyId, ds.storagePath, lease.signal)
          : fs.readFileSync(ds.storagePath);
        file = {
          buffer: fileBuffer,
          originalname: ds.fileName || `${ds.name}.${ext}`,
          mimetype: ds.mimeType || "application/octet-stream",
          size: ds.fileSize || fileBuffer.length,
        };
      }

      await lease.reportProgress?.("pipeline_start", { fileBytes: file.size });
      throwIfIngestionAborted(lease);
      const { OnboardingOrchestratorService } = await import("./onboarding-orchestrator.js");
      const orchestrator = new OnboardingOrchestratorService(this.db);
      const pipelineResult = await (orchestrator as any).executeOnboardingPipeline(
        companyId,
        ds,
        file,
        {
          collectionId: ds.collectionId ?? undefined,
          async: false,
          skipCorrelation: true,
          deferReady: true,
          jobLease: lease,
          csvSourceFingerprint: csvSourceFingerprint || `size:${file.size}`,
        },
        ds.name,
        ext,
        ds.sourceType,
      );

      throwIfIngestionAborted(lease);
      await lease.reportProgress?.("publishing");
      throwIfIngestionAborted(lease);
      const published = await this.db.transaction(async (tx) => {
        await assertDataSourceJobLease(tx, companyId, id, lease);
        const [ownedSource] = await tx.select({ metadata: dataSources.metadata }).from(dataSources)
          .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId))).for("update");
        if (ownedSource?.metadata?.reprocessingToken !== processingToken) throw new DataSourceLeaseLostError();
        // The reprocessing cutoff keeps readers on the old set until this one
        // transaction removes it and clears the cutoff. A failed replacement
        // therefore leaves the last complete version queryable.
        await tx.delete(dataSourceTables).where(and(
          eq(dataSourceTables.dataSourceId, id),
          lt(dataSourceTables.createdAt, processingCutoff),
        ));
        await tx.delete(dataSourceChunks).where(and(
          eq(dataSourceChunks.dataSourceId, id),
          lt(dataSourceChunks.createdAt, processingCutoff),
        ));
        const [current] = await tx
          .select({ metadata: dataSources.metadata })
          .from(dataSources)
          .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
          .limit(1);
        const pipelineMetadata = pipelineResult?.metadata && typeof pipelineResult.metadata === "object"
          ? pipelineResult.metadata as Record<string, unknown>
          : (current?.metadata as Record<string, unknown> | null) || {};
        const nextMetadata = { ...pipelineMetadata };
        delete nextMetadata.reprocessingStartedAt;
        delete nextMetadata.reprocessingPreviousStatus;
        delete nextMetadata.reprocessingToken;
        if (["csv", "excel"].includes(ds.sourceType)) {
          nextMetadata.embeddingStatus = "pending";
          nextMetadata.embeddingReindexStatus = "pending";
        }
        const [updated] = await tx
          .update(dataSources)
          .set({ status: "ready", metadata: nextMetadata, updatedAt: new Date() })
          .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
          .returning();
        await completeDataSourceJobLease(tx, companyId, id, lease);
        return updated;
      });
      publishedCommitted = true;
      const staleTables = (ds.tables || []).map((table) => ({ semanticModel: table.semanticModel }));
      await dropClickhouseTables(staleTables);
      if (ds.collectionId) {
        try {
          await this.collectionsService.correlateCollection(companyId, ds.collectionId);
        } catch (error) {
          console.warn(`[DataSourcesService] Collection recorrelation after reprocess failed for ${id}:`, error instanceof Error ? error.message : error);
        }
      }
      return (await this.getById(companyId, id)) || (published as any);
    } catch (error) {
      if (publishedCommitted) throw error;
      const cutoffFloor = gte(dataSourceTables.createdAt, processingCutoff);
      const stagedTables = await this.db
        .select({ semanticModel: dataSourceTables.semanticModel })
        .from(dataSourceTables)
        .where(and(eq(dataSourceTables.dataSourceId, id), cutoffFloor));
      await this.db.transaction(async (tx) => {
        await assertDataSourceJobLease(tx, companyId, id, lease, { allowCancelRequested: true });
        const [ownedSource] = await tx.select({ metadata: dataSources.metadata }).from(dataSources)
          .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId))).for("update");
        if (ownedSource?.metadata?.reprocessingToken !== processingToken) throw new DataSourceLeaseLostError();
        await tx.delete(dataSourceTables).where(and(eq(dataSourceTables.dataSourceId, id), gte(dataSourceTables.createdAt, processingCutoff)));
        await tx.delete(dataSourceChunks).where(and(eq(dataSourceChunks.dataSourceId, id), gte(dataSourceChunks.createdAt, processingCutoff)));
        await tx.update(dataSources)
          .set({ status: originalStatus, metadata: originalMetadata, updatedAt: new Date() })
          .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
      });
      await dropClickhouseTables(stagedTables);
      throw error;
    } finally {
      if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
    }
  }

  /**
   * Durable onboarding runner for external database data sources (PostgreSQL, MySQL, MariaDB).
   * Progresses through staged checkpoints: connectivity -> discovery -> column_profiling -> table_mapping -> relation_verification -> publication.
   */
  async runExternalDatabaseOnboarding(
    companyId: string,
    id: string,
    progress: Record<string, unknown>,
    lease: DataSourceJobLease,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfIngestionAborted(lease);
    if (signal?.aborted || lease.isCancellationRequested?.()) {
      throw new Error("Datasource onboarding was cancelled");
    }

    const [source] = await this.db.select().from(dataSources).where(and(
      eq(dataSources.id, id), eq(dataSources.companyId, companyId),
    )).limit(1);
    if (!source || !["postgres", "mysql", "mariadb"].includes(source.sourceType)) {
      throw new Error("External database source is unavailable or has an unsupported type");
    }

    const config = await new DataSourceDatabaseConfigService(this.db).resolve(companyId, source);
    const dbIntegration = new DatabaseIntegrationService();

    // Stage 1: Connectivity check
    await lease.reportProgress?.("connectivity", { schemaVersion: 1, startedAt: new Date().toISOString() });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    const testResult = await dbIntegration.testConnection(config);
    if (!testResult.success) {
      throw new Error(`Failed to connect to ${config.type} database: ${testResult.error}`);
    }

    // Stage 2: Discovery
    await lease.reportProgress?.("discovery", { schemaVersion: 1 });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    const tables = await dbIntegration.inspectDatabase(config);
    const totalColumns = tables.reduce((acc, t) => acc + t.columnCount, 0);
    const totalRows = tables.reduce((acc, t) => acc + t.rowCount, 0);

    // Stage 3: Column profiling
    await lease.reportProgress?.("column_profiling", {
      tablesCount: tables.length,
      columnsCount: totalColumns,
      profiledTablesCount: tables.length,
    });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    // Stage 4: Mapping results are checkpointed by schema-qualified table and column batch.
    const specialistAgentName = (progress.specialistAgentName as string) || "Database Ingestion Agent";
    const agentModel = (progress.agentModel as string) || undefined;
    const agentInstructions = (progress.agentInstructions as string) || undefined;
    const adapterType = (progress.adapterType as string) || undefined;
    // Freeze one bounded instruction read across every batch in this job. This
    // keeps both model behavior and checkpoint identity stable if the agent's
    // instruction file changes while a large schema is being mapped.
    const mappingInstructions = loadAgentReasoningInstructions(agentInstructions, specialistAgentName);

    const schemaFingerprint = fingerprintExternalDatabaseSchema(tables.map((table) => ({
      schemaName: table.schemaName,
      tableName: table.tableName,
      rowCount: table.rowCount,
      schemaDefinition: table.schemaDefinition,
    })), {
      mappingVersion: "schema-qualified-3-bounded-observations",
      databaseType: config.type,
      databaseName: config.database,
      sourceHost: config.host,
      sourcePort: config.port,
      specialistAgentName,
      agentModel: agentModel || "default",
      instructionsPath: agentInstructions,
      instructionsFingerprint: mappingInstructions.sha256,
      adapterType,
    });

    // Mapping output is never trusted from the job's general progress JSON: it
    // is too easy to truncate or grow without bound. The checkpoint table is
    // the authoritative, schema-fingerprinted resume source.
    const completedTableMappings: Record<string, any> = {};
    const checkpointStore = new ExternalDatabaseMappingCheckpointStore(this.db);

    await lease.reportProgress?.("table_mapping", {
      tablesCount: tables.length,
      columnsCount: totalColumns,
      completedTablesCount: Object.keys(completedTableMappings).length,
      completedBatchesCount: 0,
      schemaFingerprint,
    });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    let finalDomain = `${config.type.toUpperCase()} Relational Database`;
    let hasValidatedDomain = false;
    let finalEntities: string[] = [];
    let finalTopics: string[] = [];
    let tableRoles: Record<string, string> = {};
    let relationships: any[] = [];
    let suggestedQueries: any[] = [];
    let summary = `Basis data relasional (${config.type}) dengan ${tables.length} tabel terhubung dan dipetakan.`;
    let tableProfiles: Record<string, any> = {};
    let crossTableClusters: any[] = [];
    const reasoningSteps: any[] = [];
    const tableMappingCoverage: Record<string, TableSemanticMappingCoverage> = {};
    const seenEntities = new Set<string>();
    const seenTopics = new Set<string>();
    const seenRelationships = new Set<string>();
    const seenSuggestedQueries = new Set<string>();
    const seenCrossTableClusters = new Set<string>();
    const appendUnique = <T,>(target: T[], seen: Set<string>, values: T[] | undefined, identity: (value: T) => string) => {
      for (const value of values || []) {
        const key = identity(value).trim().toLocaleLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        target.push(value);
      }
    };

    // Filter tables that haven't been checkpointed yet by schema-qualified name
    const pendingTables = tables.filter((t) => {
      const qName = `${t.schemaName || "public"}.${t.tableName}`;
      const checkpoint = completedTableMappings[qName] || completedTableMappings[t.tableName];
      return !checkpoint || checkpoint.schemaFingerprint !== schemaFingerprint;
    });

    let completedBatchesCount = 0;
    for (const pt of pendingTables) {
      if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");
      const qualifiedName = `${pt.schemaName || "public"}.${pt.tableName}`;

      // Bounded column batching: if columns > 20, batch columns into chunks
      const allCols = pt.schemaDefinition || [];
      const colBatches: Array<typeof allCols> = [];
      for (let i = 0; i < allCols.length; i += EXTERNAL_SCHEMA_MAPPING_BATCH_SIZE) {
        colBatches.push(allCols.slice(i, i + EXTERNAL_SCHEMA_MAPPING_BATCH_SIZE));
      }
      const tableStartedAt = Date.now();

      const applyBatchResult = (result: NonNullable<Awaited<ReturnType<typeof aiReasoningService.analyzeDatabaseSchema>>["result"]>) => {
        if (!hasValidatedDomain && result.domain) {
          finalDomain = result.domain;
          hasValidatedDomain = true;
        }
        appendUnique(finalEntities, seenEntities, result.entities, (entity) => entity);
        appendUnique(finalTopics, seenTopics, result.primaryTopics, (topic) => topic);
        const tableRole = result.tableRoles?.[qualifiedName] || result.tableRoles?.[pt.tableName];
        if (tableRole) tableRoles[qualifiedName] = tableRole;
        appendUnique(relationships, seenRelationships, result.relationships, (relationship) => JSON.stringify(relationship));
        appendUnique(suggestedQueries, seenSuggestedQueries, result.suggestedQueries, (query) => query.sqlSnippet || query.query || query.title);
        const tableProfile = result.tableProfiles?.[qualifiedName] || result.tableProfiles?.[pt.tableName];
        if (tableProfile) {
          tableProfiles[qualifiedName] = mergeExternalDatabaseTableProfileBatches(
            tableProfiles[qualifiedName],
            tableProfile,
          );
        }
        appendUnique(crossTableClusters, seenCrossTableClusters, result.crossTableClusters, (cluster) => cluster.clusterName);
      };

      for (let batchIndex = 0; batchIndex < colBatches.length; batchIndex += 1) {
        const colBatch = colBatches[batchIndex]!;
        const checkpointKey = fingerprintExternalDatabaseMappingBatch(qualifiedName, colBatch);
        const checkpointResult = await checkpointStore.load(companyId, id, lease, schemaFingerprint, checkpointKey);
        if (checkpointResult) {
          applyBatchResult(checkpointResult);
          tableMappingCoverage[qualifiedName] ??= {
            status: "complete", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: false,
          };
          tableMappingCoverage[qualifiedName].validatedBatches += 1;
          completedBatchesCount += 1;
          continue;
        }

        const timeoutMs = externalSchemaMappingBatchTimeoutMs(tableStartedAt);
        if (timeoutMs <= 0) {
          const remainingBatches = colBatches.length - batchIndex;
          tableMappingCoverage[qualifiedName] ??= {
            status: "fallback", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: true,
          };
          tableMappingCoverage[qualifiedName].fallbackBatches += remainingBatches;
          tableMappingCoverage[qualifiedName].timeBudgetExceeded = true;
          await lease.reportProgress?.("table_mapping", {
            currentTable: qualifiedName,
            currentBatchIndex: batchIndex + 1,
            batchCount: colBatches.length,
            checkpointStage: "table_budget_exhausted",
            tableBudgetMs: EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS,
            statusSummary: "Per-table semantic mapping budget exhausted; remaining batches retain deterministic metadata",
          });
          break;
        }
        const batchTimeout = AbortSignal.timeout(timeoutMs);
        const batchSignal = signal ? AbortSignal.any([signal, batchTimeout]) : batchTimeout;
        let aiDbRes: Awaited<ReturnType<typeof aiReasoningService.analyzeDatabaseSchema>>;
        const mappingReasoningSteps: any[] = [];
        try {
          await lease.reportProgress?.("table_mapping", {
            tablesCount: tables.length,
            columnsCount: totalColumns,
            completedTablesCount: Object.keys(completedTableMappings).length,
            completedBatchesCount,
            currentTable: qualifiedName,
            currentBatchIndex: batchIndex + 1,
            batchCount: colBatches.length,
            checkpointStage: "mapping_batch",
            schemaFingerprint,
          });
          const mappingTable = {
            tableName: qualifiedName,
            rowCount: pt.rowCount,
            columns: colBatch.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              isPrimary: c.isPrimaryKey,
              isForeign: c.isForeignKey,
              references: c.foreignKeyTarget
                ? `${c.foreignKeyTarget.schema ? `${c.foreignKeyTarget.schema}.` : ""}${c.foreignKeyTarget.table}.${c.foreignKeyTarget.column}`
                : undefined,
              sampleValues: c.sampleValues.slice(0, 3),
              distinctCount: c.distinctCount,
              nullRatio: c.nullRatio,
              role: c.role,
            })),
          };
          aiDbRes = await analyzeExternalDatabaseSchemaBatch({
            databaseType: config.type,
            databaseName: config.database,
            table: mappingTable,
            options: {
              agentName: specialistAgentName,
              model: agentModel,
              instructionsPath: agentInstructions,
              instructionsContent: mappingInstructions.content,
              adapterType,
              maxRetries: 2,
              signal: batchSignal,
            },
            analyze: (databaseType, databaseName, schemaTables, options) => aiReasoningService.analyzeDatabaseSchema(
              databaseType,
              databaseName,
              schemaTables,
              options,
            ),
            observe: (columns) => dbIntegration.observeExternalTableColumns(config, {
              schemaName: pt.schemaName || "public",
              tableName: pt.tableName,
              columns,
              signal: batchSignal,
            }),
            onObservationRequested: async (requests) => lease.reportProgress?.("table_mapping", {
              currentTable: qualifiedName,
              currentBatchIndex: batchIndex + 1,
              batchCount: colBatches.length,
              checkpointStage: "observation_requested",
              observationCount: requests.length,
              statusSummary: "Mapper requested bounded samples for ambiguous non-sensitive columns",
            }),
            onObservationCompleted: async (requests, observed) => lease.reportProgress?.("table_mapping", {
              currentTable: qualifiedName,
              currentBatchIndex: batchIndex + 1,
              batchCount: colBatches.length,
              checkpointStage: "observation_completed",
              observationCount: requests.length,
              observedRows: observed.rowCount,
              observationQueryMs: observed.executionTimeMs,
              statusSummary: "Bounded read-only sample completed; mapper is validating its semantic conclusions",
            }),
          });
          mappingReasoningSteps.push(...(aiDbRes.reasoningSteps || []));
        } catch (error) {
          if (signal?.aborted || lease.signal?.aborted || lease.isCancellationRequested?.()) {
            throw new Error("Datasource onboarding was cancelled");
          }
          const timedOut = batchTimeout.aborted;
          const tableBudgetExpired = externalSchemaMappingBatchTimeoutMs(tableStartedAt) <= 0;
          tableMappingCoverage[qualifiedName] ??= {
            status: "fallback", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: false,
          };
          tableMappingCoverage[qualifiedName].fallbackBatches += 1;
          if (tableBudgetExpired) {
            tableMappingCoverage[qualifiedName].fallbackBatches += colBatches.length - batchIndex - 1;
            tableMappingCoverage[qualifiedName].timeBudgetExceeded = true;
          }
          await lease.reportProgress?.("table_mapping", {
            currentTable: qualifiedName,
            currentBatchIndex: batchIndex + 1,
            batchCount: colBatches.length,
            checkpointStage: tableBudgetExpired ? "table_budget_exhausted" : timedOut ? "batch_timeout" : "batch_fallback",
            tableBudgetMs: EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS,
            statusSummary: tableBudgetExpired
              ? "Per-table semantic mapping budget exhausted; remaining batches retain deterministic metadata"
              : timedOut ? "Semantic mapping batch timed out; deterministic metadata retained" : "Semantic mapping unavailable; deterministic metadata retained",
          });
          // Fall through to deterministic processing
          if (tableBudgetExpired) break;
          continue;
        }

        if (!aiDbRes?.result || aiDbRes.validationStatus !== "validated") {
          tableMappingCoverage[qualifiedName] ??= {
            status: "fallback", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: false,
          };
          tableMappingCoverage[qualifiedName].fallbackBatches += 1;
          await lease.reportProgress?.("table_mapping", {
            currentTable: qualifiedName,
            currentBatchIndex: batchIndex + 1,
            batchCount: colBatches.length,
            checkpointStage: "batch_validation_fallback",
            statusSummary: "Semantic mapping failed validation; deterministic metadata retained",
          });
          continue;
        }

        // Persist the validated model result before using it so a worker
        // takeover cannot repeat this batch or publish a result it cannot resume.
        try {
          await checkpointStore.save(companyId, id, lease, schemaFingerprint, checkpointKey, aiDbRes.result);
        } catch (error) {
          if (!(error instanceof ExternalDatabaseMappingCheckpointSizeError)) throw error;
          tableMappingCoverage[qualifiedName] ??= {
            status: "fallback", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: false,
          };
          tableMappingCoverage[qualifiedName].fallbackBatches += 1;
          await lease.reportProgress?.("table_mapping", {
            currentTable: qualifiedName,
            currentBatchIndex: batchIndex + 1,
            batchCount: colBatches.length,
            checkpointStage: "batch_result_too_large",
            statusSummary: "Batch semantic result exceeded checkpoint size limit; deterministic metadata retained",
          });
          continue;
        }

        tableMappingCoverage[qualifiedName] ??= {
          status: "complete", expectedBatches: colBatches.length, validatedBatches: 0, fallbackBatches: 0, timeBudgetExceeded: false,
        };
        tableMappingCoverage[qualifiedName].validatedBatches += 1;
        completedBatchesCount += 1;
        applyBatchResult(aiDbRes.result);
        if (mappingReasoningSteps.length > 0) reasoningSteps.push(...mappingReasoningSteps);
        await lease.reportProgress?.("table_mapping", {
          tablesCount: tables.length,
          columnsCount: totalColumns,
          completedTablesCount: Object.keys(completedTableMappings).length,
          completedBatchesCount,
          currentTable: qualifiedName,
          currentBatchIndex: batchIndex + 1,
          batchCount: colBatches.length,
          checkpointStage: "batch_checkpointed",
          schemaFingerprint,
        });
      }

      // Checkpoint immediately per table
      completedTableMappings[qualifiedName] = {
        schemaFingerprint,
        tableRole: tableRoles[qualifiedName] || "dimension_table",
        profile: tableProfiles[qualifiedName],
        columnsCount: pt.columnCount,
        semanticMapping: tableMappingCoverage[qualifiedName] || {
          status: "fallback", expectedBatches: colBatches.length, validatedBatches: 0,
          fallbackBatches: colBatches.length, timeBudgetExceeded: false,
        },
      };
      tableMappingCoverage[qualifiedName] ??= completedTableMappings[qualifiedName].semanticMapping;
      tableMappingCoverage[qualifiedName].status = tableMappingCoverage[qualifiedName].fallbackBatches === 0
        ? "complete"
        : tableMappingCoverage[qualifiedName].validatedBatches > 0 ? "partial" : "fallback";

      await lease.reportProgress?.("table_mapping", {
        tablesCount: tables.length,
        columnsCount: totalColumns,
        completedTablesCount: Object.keys(completedTableMappings).length,
        completedBatchesCount,
        currentTable: qualifiedName,
        checkpointStage: tableMappingCoverage[qualifiedName].timeBudgetExceeded ? "table_budget_exhausted" : "table_mapping_complete",
        tableBudgetMs: EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS,
        schemaFingerprint,
      });
    }

    // Restore tableRoles and profiles for previously checkpointed tables
    for (const t of tables) {
      const qName = `${t.schemaName || "public"}.${t.tableName}`;
      const cp = completedTableMappings[qName] || completedTableMappings[t.tableName];
      if (cp) {
        if (!tableRoles[qName] && cp.tableRole) {
          tableRoles[qName] = cp.tableRole;
        }
        if (!tableProfiles[qName] && cp.profile) {
          tableProfiles[qName] = cp.profile;
        }
      }
    }

    if (finalEntities.length === 0) {
      const jevService = new TypeSafeJevService();
      const tableSummaries = tables.map((t) => ({
        name: `${t.schemaName || "public"}.${t.tableName}`,
        columns: t.schemaDefinition.map((c) => c.name),
        rowCount: t.rowCount,
      }));
      const jevRes = await jevService.evaluateDatabaseTables(tableSummaries);
      finalEntities = jevRes.entities;
      tableRoles = jevRes.tableRoles;
      relationships = jevRes.relationships;
      finalTopics = jevRes.primaryTopics;
      suggestedQueries = jevRes.suggestedQueries;
      tableProfiles = jevRes.tableProfiles || {};
    }

    // Stage 5: Relation verification
    const allTableRelationships: TableRelation[] = [];
    for (const t of tables) {
      if (Array.isArray(t.semanticModel?.relationships)) {
        allTableRelationships.push(...t.semanticModel.relationships);
      }
    }
    const connectedComponentsCount = new Set(
      tables.map((t) => t.semanticModel?.connectedComponentId).filter(Boolean),
    ).size;

    await lease.reportProgress?.("relation_verification", {
      tablesCount: tables.length,
      relationsCount: allTableRelationships.length,
      connectedComponentCount: connectedComponentsCount,
    });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    // Collect JSON structures
    const jsonStructures: Record<string, any> = {};
    for (const t of tables) {
      for (const col of t.schemaDefinition) {
        if (col.isJson && col.jsonStructure) {
          jsonStructures[`${t.schemaName || "public"}.${t.tableName}.${col.name}`] = col.jsonStructure;
        }
      }
    }

    const mappingCoverageValues = Object.values(tableMappingCoverage);
    const semanticMappingSummary = {
      tablesCount: tables.length,
      completeTables: mappingCoverageValues.filter((coverage) => coverage.status === "complete").length,
      partialTables: mappingCoverageValues.filter((coverage) => coverage.status === "partial").length,
      fallbackTables: mappingCoverageValues.filter((coverage) => coverage.status === "fallback").length,
      expectedBatches: mappingCoverageValues.reduce((sum, coverage) => sum + coverage.expectedBatches, 0),
      validatedBatches: mappingCoverageValues.reduce((sum, coverage) => sum + coverage.validatedBatches, 0),
      fallbackBatches: mappingCoverageValues.reduce((sum, coverage) => sum + coverage.fallbackBatches, 0),
      budgetExceededTables: mappingCoverageValues.filter((coverage) => coverage.timeBudgetExceeded).length,
    };

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: specialistAgentName,
      decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1", "db.json_structure.v1"],
      domain: finalDomain,
      targetAgentAffinity: "data_agent",
      entities: finalEntities,
      tableRoles,
      relationships: allTableRelationships.length > 0 ? allTableRelationships : relationships,
      primaryTopics: finalTopics,
      topics: finalTopics,
      tableProfiles,
      semanticMappingSummary,
      crossTableClusters,
      summary,
      onboardedAt: new Date().toISOString(),
      suggestedQueries,
      reasoningSteps,
      jsonStructures,
    };

    // Stage 6: Atomic publication gate
    await lease.reportProgress?.("publication", { tablesCount: tables.length });
    if (signal?.aborted || lease.isCancellationRequested?.()) throw new Error("Datasource onboarding was cancelled");

    const rejectedTables = tables.filter((t) => t.semanticModel?.publicationGateStatus === "rejected");
    if (rejectedTables.length > 0) {
      const details = rejectedTables.map((t) => `${t.schemaName || "public"}.${t.tableName}: ${(t.semanticModel?.unresolvedDefinitions || []).join(", ")}`).join("; ");
      throw new Error(`Datasource publication gate rejected: ${details}`);
    }

    await this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, id, lease, { allowCancelRequested: false });

      // Clean atomic swap for tables
      await tx.delete(dataSourceTables).where(and(
        eq(dataSourceTables.dataSourceId, id),
        eq(dataSourceTables.companyId, companyId),
      ));

      for (const tableData of tables) {
        const qualifiedTableName = `${tableData.schemaName || "public"}.${tableData.tableName}`;
        const tableSemantic = {
          ...tableData.semanticModel,
          sourceSchema: tableData.schemaName,
          tableRole: tableRoles[qualifiedTableName] || tableRoles[tableData.tableName] || tableData.semanticModel?.tableRole || "dimension_table",
          semanticMapping: tableMappingCoverage[qualifiedTableName],
          mappedBy: specialistAgentName,
          decisionSpecs: ["db.table_role.v1", "db.join_candidates.v1"],
        };

        const [tableRow] = await tx.insert(dataSourceTables).values({
          dataSourceId: id,
          companyId,
          tableName: tableData.tableName,
          rowCount: tableData.rowCount,
          columnCount: tableData.columnCount,
          schemaDefinition: tableData.schemaDefinition as any,
          semanticModel: tableSemantic as any,
        }).returning();

        // Synthesize structured schema chunk for vector store retrieval
        const cols = (tableData.schemaDefinition as any[]) || [];
        const colText = cols.map((c: any) => `${c.name} (${c.dataType || "string"}${c.role ? `, role: ${c.role}` : ""})`).join(", ");
        const metricText = ((tableData.semanticModel as any)?.metrics || []).map((m: any) => `${m.name || m}`).join(", ");
        const content = `Table: ${qualifiedTableName}\nRole: ${tableSemantic.tableRole}\nColumns: ${colText}${metricText ? `\nMetrics: ${metricText}` : ""}`;
        await tx.insert(dataSourceChunks).values({
          companyId,
          dataSourceId: id,
          chunkIndex: tables.indexOf(tableData),
          title: `Schema: ${qualifiedTableName}`,
          content,
          // Schema embeddings are generated in bounded batches by the durable
          // embedding_reindex worker after publication, never inside this
          // all-table transaction.
          embedding: null,
          metadata: {
            corpusKind: "schema",
            tableId: tableRow?.id,
            tableName: tableData.tableName,
            sourceSchema: tableData.schemaName || "public",
            qualifiedTableName,
          },
        });
      }

      await tx.update(dataSources)
        .set({
          status: "ready",
            metadata: {
              ...source.metadata,
              embeddingStatus: "pending",
              embeddingReindexStatus: "pending",
              serverVersion: testResult.version,
            tableCount: tables.length,
            totalRows,
            tables: tables.map((t) => `${t.schemaName || "public"}.${t.tableName}`),
            onboardedBy: specialistAgentName,
            semanticProfile,
            onboardingReasoning: reasoningSteps,
            suggestedQueries,
            jsonStructures,
            completedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));
    });

    await this.cache.invalidateDataSourceCache(companyId, id);

    if (source.collectionId) {
      try {
        await this.collectionsService.correlateCollection(companyId, source.collectionId);
      } catch (error) {
        console.warn(`[DataSourcesService] Collection recorrelation after DB onboarding failed for ${id}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  /**
   * Reprocess all data sources in a company that are currently stuck or in error status
   */
  async reprocessStuck(companyId: string): Promise<DataSource[]> {
    const stuck = await this.db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(
        and(
          eq(dataSources.companyId, companyId),
          or(eq(dataSources.status, "processing"), eq(dataSources.status, "error")),
          sql`${dataSources.storagePath} IS NOT NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM data_source_jobs AS active
            WHERE active.company_id = ${dataSources.companyId} AND active.data_source_id = ${dataSources.id}
              AND active.status IN ('queued', 'running', 'cancel_requested')
          )`,
        ),
      );

    const results: DataSource[] = [];
    for (const item of stuck) {
      try {
        const res = await this.enqueueReprocess(companyId, item.id);
        results.push(res);
      } catch (err: any) {
        console.error(`[DataSourcesService] Failed to reprocess ${item.id}:`, err.message);
      }
    }
    return results;
  }

  /**
   * Query records from a structured table
   */
  async queryTable(
    companyId: string,
    tableId: string,
    options: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
      aggregate?: {
        column: string;
        fn: "sum" | "avg" | "count" | "min" | "max";
        groupBy?: string;
      };
      mode?: "live" | "snapshot";
      /** Effective authorization scope supplied by the route after it checks grants. */
      authzFingerprint?: string;
      /** Internal recursion guard for cache miss computation. */
      bypassResultCache?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<StructuredQueryResult> {
    const [table] = await this.db
      .select()
      .from(dataSourceTables)
      .where(and(eq(dataSourceTables.id, tableId), eq(dataSourceTables.companyId, companyId)));

    if (!table) throw new Error(`Table not found: ${tableId}`);

    const requestedLimit = options.limit ?? 50;
    const requestedOffset = options.offset ?? 0;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error("Query limit must be a positive integer");
    }
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) {
      throw new Error("Query offset must be a non-negative integer");
    }
    const limit = Math.min(requestedLimit, 500);
    const offset = requestedOffset;
    const schema = (Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) as StructuredColumn[];
    const [ds] = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.id, table.dataSourceId), eq(dataSources.companyId, companyId)));
    const processingCutoff = reprocessingCutoff(ds?.metadata);
    if (processingCutoff && table.createdAt >= processingCutoff) {
      throw new Error(`Table not found: ${tableId}`);
    }

    const aggregation = options.aggregate;
    const allowedAggregations = new Set(["sum", "avg", "count", "min", "max"]);
    if (aggregation) {
      if (!allowedAggregations.has(aggregation.fn)) throw unprocessable("Unsupported aggregation function");
      const countAll = isCountAllAggregate(aggregation.fn, aggregation.column);
      const metricColumn = countAll ? undefined : schema.find((column) => column.name === aggregation.column);
      if (!metricColumn) {
        if (!countAll) throw unprocessable(`Unknown aggregation column: ${aggregation.column}`);
      } else {
        validateStructuredAggregationColumn(metricColumn, aggregation.fn);
      }
      if (aggregation.groupBy && !schema.some((column) => column.name === aggregation.groupBy)) {
        throw unprocessable(`Unknown group-by column: ${aggregation.groupBy}`);
      }
    }
    // Validate filter keys/values even on the local compatibility path.
    compileStructuredFilters(options.filter, schema, "postgres");

    const externalDatabase = ds && ["postgres", "mariadb", "mysql"].includes(ds.sourceType);
    const externalSnapshot = (table.semanticModel as any)?.externalSnapshot;
    const useExternalSnapshot = externalDatabase && options.mode === "snapshot";
    const deduplicateTables = shouldApplyClickhouseFinalDeduplication(table.semanticModel)
      ? [sourceClickhouseTableName(table)]
      : [];
    if (useExternalSnapshot && externalSnapshot?.status !== "ready") {
      throw conflict("A published ClickHouse snapshot is not available for this table");
    }
    const cacheableResult = ds?.status === "ready" && (
      ds.sourceType === "csv" || ds.sourceType === "excel" || useExternalSnapshot
    );
    if (cacheableResult && !options.bypassResultCache) {
      const sourceRevision = [
        ds.updatedAt.toISOString(),
        table.updatedAt.toISOString(),
        String(table.rowCount),
        sourceClickhouseTableName(table),
        useExternalSnapshot ? String(externalSnapshot.completedAt || "") : "file",
      ].join(":");
      const cacheKey = makeDataSourceCacheKey([
        "structured-query-result",
        companyId,
        options.authzFingerprint || "internal-company-scope",
        table.id,
        sourceRevision,
        JSON.stringify({
          mode: useExternalSnapshot ? "snapshot" : "file",
          filter: options.filter || null,
          aggregate: options.aggregate || null,
          limit,
          offset,
        }),
      ]);
      const ttlSeconds = Math.max(1, Math.min(300, Number(process.env.DATASOURCE_QUERY_RESULT_CACHE_TTL_SECONDS || 60)));
      const isStructuredResult = (value: unknown): value is StructuredQueryResult => {
        if (!value || typeof value !== "object") return false;
        const result = value as Partial<StructuredQueryResult>;
        return Array.isArray(result.columns) && Array.isArray(result.rows)
          && typeof result.totalRows === "number" && Number.isFinite(result.totalRows);
      };
      const result = await this.cache.getOrComputeJson(
        cacheKey,
        isStructuredResult,
        ttlSeconds,
        () => this.queryTable(companyId, tableId, { ...options, bypassResultCache: true }),
      );

      // A refresh can start while Redis returns a warm value. Re-read the
      // publication metadata and reject that old key instead of serving it.
      const [latestTable] = await this.db.select({ semanticModel: dataSourceTables.semanticModel, updatedAt: dataSourceTables.updatedAt })
        .from(dataSourceTables)
        .where(and(eq(dataSourceTables.id, tableId), eq(dataSourceTables.companyId, companyId)));
      const [latestSource] = await this.db.select({ status: dataSources.status, updatedAt: dataSources.updatedAt })
        .from(dataSources)
        .where(and(eq(dataSources.id, table.dataSourceId), eq(dataSources.companyId, companyId)));
      const latestSnapshot = (latestTable?.semanticModel as any)?.externalSnapshot;
      const publicationStillCurrent = latestTable?.updatedAt?.getTime() === table.updatedAt.getTime()
        && latestSource?.updatedAt?.getTime() === ds.updatedAt.getTime()
        && latestSource?.status === "ready"
        && (!useExternalSnapshot || latestSnapshot?.status === "ready");
      if (!publicationStillCurrent) {
        throw conflict("Datasource data changed while this query was running; retry against the latest published version");
      }
      return result;
    }
    if (externalDatabase && !useExternalSnapshot) {
      const config = await new DataSourceDatabaseConfigService(this.db).resolve(companyId, ds);
      const dialect = ds.sourceType === "postgres" ? "postgres" : "mysql";
      const quote = dialect === "postgres" ? '"' : "`";
      const quotedTable = quoteDataIdentifier(table.tableName, quote);
      const filters = compileStructuredFilters(options.filter, schema, dialect);
      const dbIntegration = new DatabaseIntegrationService();
      const runExternalQuery = (querySql: string, queryLimit: number, values: unknown[]) =>
        externalQueryAdmission.run(
          `${companyId}:${ds.id}`,
          () => dbIntegration.queryDatabase(config, querySql, queryLimit, values, options.signal),
          options.signal,
        );

      if (aggregation) {
        const { column, fn, groupBy } = aggregation;
        const countAll = isCountAllAggregate(fn, column);
        const quotedColumn = countAll ? "*" : quoteDataIdentifier(column, quote);
        const aggregateExpression = structuredAggregateSqlExpression(fn, quotedColumn, countAll, "ansi");
        const alias = quoteDataIdentifier(structuredAggregateAlias(fn, column), quote);
        let query: string;
        if (groupBy) {
          const quotedGroup = quoteDataIdentifier(groupBy, quote);
          query = `SELECT ${quotedGroup}, ${aggregateExpression} AS ${alias}, COUNT(*) AS ${quote}row_count${quote} FROM ${quotedTable}${filters.whereSql} GROUP BY ${quotedGroup} ORDER BY ${alias} DESC LIMIT ${limit} OFFSET ${offset}`;
        } else {
          query = `SELECT ${aggregateExpression} AS ${alias}, COUNT(*) AS ${quote}total_rows${quote} FROM ${quotedTable}${filters.whereSql}`;
        }
        const queryResult = await runExternalQuery(query, limit, filters.values);
        return {
          tableId,
          tableName: table.tableName,
          columns: queryResult.columns,
          rows: queryResult.rows,
          totalRows: queryResult.rowCount,
        };
      }

      // Window count keeps filtered row totals aligned with the same remote query snapshot.
      let hiddenTotalColumn = "__paperclip_filtered_total";
      while (schema.some((column) => column.name === hiddenTotalColumn)) hiddenTotalColumn += "_";
      const query = `SELECT *, COUNT(*) OVER() AS ${quoteDataIdentifier(hiddenTotalColumn, quote)} FROM ${quotedTable}${filters.whereSql} LIMIT ${limit} OFFSET ${offset}`;
      const queryResult = await runExternalQuery(query, limit, filters.values);
      let totalRows = Number((queryResult.rows[0] as any)?.[hiddenTotalColumn] ?? 0);
      let rows = queryResult.rows.map((row: any) => {
        const { [hiddenTotalColumn]: _ignored, ...visibleRow } = row;
        return visibleRow;
      });
      const columns = queryResult.columns.filter((column) => column !== hiddenTotalColumn);
      if (rows.length === 0 && offset > 0) {
        const countQuery = `SELECT COUNT(*) AS ${quoteDataIdentifier(hiddenTotalColumn, quote)} FROM ${quotedTable}${filters.whereSql}`;
        const countResult = await runExternalQuery(countQuery, 1, filters.values);
        totalRows = Number((countResult.rows[0] as any)?.[hiddenTotalColumn] ?? 0);
      }
      return { tableId, tableName: table.tableName, columns, rows, totalRows };
    }

    let clickhouseError: unknown;
    if (aggregation) {
      try {
        const clickhouse = new ClickhouseService();
        const sanitizedName = sourceClickhouseTableName(table);
        const companyDb = clickhouse.getCompanyDatabase(companyId);
        const chTables = await clickhouse.listTables(companyId);
        if (chTables.includes(sanitizedName)) {
          const { column, fn, groupBy } = aggregation;
          const countAll = isCountAllAggregate(fn, column);
          const filters = compileStructuredFilters(options.filter, schema, "clickhouse");
          const metricColumn = countAll ? undefined : schema.find((item) => item.name === column)!;
          const aggregateColumn = countAll ? "*" : clickhouseAggregateColumnExpression(metricColumn!, fn);
          const aggregateExpression = structuredAggregateSqlExpression(fn, aggregateColumn, countAll, "clickhouse");
          const alias = quoteDataIdentifier(structuredAggregateAlias(fn, column), "`");
          const selectGroup = groupBy ? `${quoteDataIdentifier(groupBy, "`")}, ` : "";
          const groupByClause = groupBy ? ` GROUP BY ${quoteDataIdentifier(groupBy, "`")}` : "";
          const orderClause = groupBy ? ` ORDER BY ${alias} DESC LIMIT ${limit} OFFSET ${offset}` : "";
          const fromSql = useExternalSnapshot ? snapshotQuerySource(table) : quoteDataIdentifier(sanitizedName, "`");
          const query = `SELECT ${selectGroup}${aggregateExpression} AS ${alias}, count(*) AS ${quoteDataIdentifier(groupBy ? "row_count" : "total_rows", "`")} FROM ${fromSql}${filters.whereSql}${groupByClause}${orderClause}`;
          const chResult = await clickhouse.query(query, companyDb, filters.clickhouseParams, {
            deduplicateTables,
            signal: options.signal,
          });
          return {
            tableId,
            tableName: table.tableName,
            columns: chResult.columns,
            rows: chResult.rows,
            totalRows: chResult.rowCount,
            ...(useExternalSnapshot ? {
              querySource: {
                mode: "snapshot" as const,
                snapshotAt: externalSnapshot.lastIncrementalAt || externalSnapshot.completedAt,
                consistency: externalSnapshot.consistency,
                syncMode: externalSnapshot.syncMode === "incremental" ? "incremental" as const : "full" as const,
                watermarkMicros: externalSnapshot.watermarkMicros || null,
                deleteSemantics: externalSnapshot.deleteSemantics,
              },
            } : {}),
          };
        }
      } catch (error) {
        clickhouseError = error;
      }
    }

    const hasFilters = Object.entries(options.filter || {}).some(
      ([, value]) => value !== undefined && value !== null && value !== "",
    );
    if (!aggregation && ds && (ds.sourceType === "csv" || ds.sourceType === "excel" || useExternalSnapshot)) {
      try {
        const clickhouse = new ClickhouseService();
        const sanitizedName = sourceClickhouseTableName(table);
        const companyDb = clickhouse.getCompanyDatabase(companyId);
        const allCompanyTables = await this.db
          .select({ tableName: dataSourceTables.tableName })
          .from(dataSourceTables)
          .where(eq(dataSourceTables.companyId, companyId));
        const usesStableIdentity = typeof (table.semanticModel as any)?.clickhouseTable === "string";
        const hasLegacyNameCollision = !usesStableIdentity && allCompanyTables.filter(
          (item) => item.tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() === sanitizedName,
        ).length > 1;
        const chTables = await clickhouse.listTables(companyId);

        if (chTables.includes(sanitizedName) && !hasLegacyNameCollision) {
          const filters = compileStructuredFilters(options.filter, schema, "clickhouse");
          let hiddenTotalColumn = "__paperclip_filtered_total";
          while (schema.some((column) => column.name === hiddenTotalColumn)) hiddenTotalColumn += "_";
          const quote = String.fromCharCode(96);
          const hiddenTotal = quoteDataIdentifier(hiddenTotalColumn, quote);
          const orderColumn = (table.semanticModel as any)?.primaryKey as string | undefined;
          const orderClause =
            orderColumn && schema.some((column) => column.name === orderColumn)
              ? " ORDER BY " + quoteDataIdentifier(orderColumn, quote)
              : "";
          const fromSql = useExternalSnapshot
            ? snapshotQuerySource(table)
            : quoteDataIdentifier(sanitizedName, quote);
          const projection = useExternalSnapshot
            ? schema.map((column) => quoteDataIdentifier(column.name, quote)).join(", ")
            : "*";
          const query =
            "SELECT " + projection +
            (hasFilters ? ", count() OVER() AS " + hiddenTotal : "") +
            " FROM " +
            fromSql +
            filters.whereSql +
            orderClause +
            " LIMIT " +
            limit +
            " OFFSET " +
            offset;
          const chResult = await clickhouse.query(query, companyDb, filters.clickhouseParams, {
            deduplicateTables,
            signal: options.signal,
          });
          let totalRows = hasFilters
            ? Number((chResult.rows[0] as any)?.[hiddenTotalColumn] ?? 0)
            : table.rowCount;
          const rows = chResult.rows.map((row: any) => {
            const { [hiddenTotalColumn]: _ignored, ...visibleRow } = row;
            return visibleRow;
          });
          const columns = rows.length > 0 ? Object.keys(rows[0] as object) : schema.map((column) => column.name);
          if (hasFilters && rows.length === 0 && offset > 0) {
            const countQuery =
              "SELECT count() AS " +
              hiddenTotal +
              " FROM " +
              fromSql +
              filters.whereSql;
            const countResult = await clickhouse.query(countQuery, companyDb, filters.clickhouseParams, {
              deduplicateTables,
              signal: options.signal,
            });
            totalRows = Number((countResult.rows[0] as any)?.[hiddenTotalColumn] ?? 0);
          }
          return {
            tableId,
            tableName: table.tableName,
            columns,
            rows,
            totalRows,
            ...(useExternalSnapshot ? {
              querySource: {
                mode: "snapshot" as const,
                snapshotAt: externalSnapshot.lastIncrementalAt || externalSnapshot.completedAt,
                consistency: externalSnapshot.consistency,
                syncMode: externalSnapshot.syncMode === "incremental" ? "incremental" as const : "full" as const,
                watermarkMicros: externalSnapshot.watermarkMicros || null,
                deleteSemantics: externalSnapshot.deleteSemantics,
              },
            } : {}),
          };
        }
        if (hasLegacyNameCollision) {
          clickhouseError = new Error("ClickHouse table name collision for " + table.tableName);
        } else if (!chTables.includes(sanitizedName)) {
          clickhouseError = new Error("ClickHouse table is not synchronized for " + table.tableName);
        }
      } catch (error) {
        clickhouseError = error;
      }
    }

    if (useExternalSnapshot) {
      const reason = clickhouseError instanceof Error ? `: ${clickhouseError.message}` : "";
      throw new Error(`Published snapshot is unavailable for ${table.tableName}; ClickHouse must be healthy${reason}`);
    }

    if ((table.semanticModel as any)?.queryStore === "clickhouse_primary") {
      const reason = clickhouseError instanceof Error ? `: ${clickhouseError.message}` : "";
      throw new Error(`Complete query is unavailable for ${table.tableName}; ClickHouse must be healthy${reason}`);
    }

    // PostgreSQL records are a compatibility fallback, never a source for a partial aggregate.
    if (aggregation && table.rowCount > 1000) {
      const reason = clickhouseError instanceof Error ? `: ${clickhouseError.message}` : "";
      throw new Error(`Complete aggregation is unavailable for ${table.tableName}; ClickHouse must be healthy${reason}`);
    }
    if (!aggregation && hasFilters && table.rowCount > 1000 && clickhouseError) {
      const reason = clickhouseError instanceof Error ? clickhouseError.message : "query failed";
      throw new Error("Complete filtered query is unavailable for " + table.tableName + "; ClickHouse must be healthy: " + reason);
    }
    const pageFromLocalStorage = !aggregation && !hasFilters && table.rowCount > 1000;
    const records = await this.db
      .select()
      .from(dataSourceRecords)
      .where(and(eq(dataSourceRecords.tableId, tableId), eq(dataSourceRecords.companyId, companyId)))
      .orderBy(dataSourceRecords.rowIndex)
      .limit(aggregation ? 1001 : pageFromLocalStorage ? limit : 1000)
      .offset(pageFromLocalStorage ? offset : 0);

    if (aggregation && (records.length > 1000 || records.length !== table.rowCount)) {
      throw new Error(`Cannot aggregate ${table.tableName} from an incomplete PostgreSQL record snapshot`);
    }

    let rows = records.map((record) => record.data);
    if (options.filter && Object.keys(options.filter).length > 0) {
      rows = rows.filter((row) => {
        for (const [key, value] of Object.entries(options.filter!)) {
          if (value === undefined || value === null || value === "") continue;
          const rowValue = row[key];
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            for (const [operator, bound] of Object.entries(value as Record<string, unknown>)) {
              const numericActual = typeof rowValue === "number" ? rowValue : Number.NaN;
              const numericBound = typeof bound === "number" ? bound : Number.NaN;
              const dateActual = rowValue instanceof Date ? rowValue.getTime() : typeof rowValue === "string" ? Date.parse(rowValue) : Number.NaN;
              const dateBound = bound instanceof Date ? bound.getTime() : typeof bound === "string" ? Date.parse(bound) : Number.NaN;
              const actual = Number.isFinite(numericActual) && typeof bound === "number"
                ? numericActual
                : Number.isFinite(dateActual) && Number.isFinite(dateBound)
                  ? dateActual
                  : String(rowValue ?? "");
              const expected = typeof actual === "number"
                ? (typeof bound === "number" ? bound : Number(bound))
                : String(bound ?? "");
              const matches = operator === "gt" ? actual > expected
                : operator === "gte" ? actual >= expected
                  : operator === "lt" ? actual < expected
                    : operator === "lte" ? actual <= expected
                      : false;
              if (!matches) return false;
            }
            continue;
          }
          if (typeof value === "string" && typeof rowValue === "string") {
            if (!rowValue.toLowerCase().includes(value.toLowerCase())) return false;
          } else if (rowValue !== value) {
            return false;
          }
        }
        return true;
      });
    }

    const totalRows = pageFromLocalStorage ? table.rowCount : rows.length;
    if (aggregation) {
      const { column, fn, groupBy } = aggregation;
      const countAll = isCountAllAggregate(fn, column);
      const metricColumn = countAll ? undefined : schema.find((item) => item.name === column)!;
      const temporalMetric = metricColumn ? isTemporalStructuredColumn(metricColumn) : false;
      const alias = structuredAggregateAlias(fn, column);
      const grouped = new Map<string, { rows: number; values: unknown[] }>();
      if (groupBy) {
        for (const row of rows) {
          const groupKey = String(row[groupBy] ?? "Unknown");
          const state = grouped.get(groupKey) || { rows: 0, values: [] };
          state.rows++;
          state.values.push(countAll ? 1 : row[column]);
          grouped.set(groupKey, state);
        }
        const aggregatedRows = [...grouped.entries()].map(([groupKey, state]) => {
          const aggregateValue = calculateStructuredAggregate(state.values, fn, temporalMetric);
          return {
            [groupBy]: groupKey,
            [alias]: aggregateValue,
            row_count: state.rows,
          };
        });
        const comparableGroupValue = (value: unknown) => {
          if (temporalMetric && (fn === "min" || fn === "max")) {
            const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
            return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
          }
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
        };
        aggregatedRows.sort((a, b) =>
          comparableGroupValue(b[alias]) - comparableGroupValue(a[alias]),
        );
        return {
          tableId,
          tableName: table.tableName,
          columns: [groupBy, alias, "row_count"],
          rows: aggregatedRows.slice(offset, offset + limit),
          totalRows: aggregatedRows.length,
        };
      }

      const selectedValues = rows.map((row) => countAll ? 1 : row[column]);
      const aggregateValue = calculateStructuredAggregate(selectedValues, fn, temporalMetric);
      return {
        tableId,
        tableName: table.tableName,
        columns: [alias, "total_rows"],
        rows: [{ [alias]: aggregateValue, total_rows: selectedValues.filter((value) => value !== null && value !== undefined).length }],
        totalRows: 1,
        ...(typeof aggregateValue === "number" ? { summary: { metrics: { [alias]: aggregateValue } } } : {}),
      };
    }

    const columns = schema.map((column) => column.name);
    return {
      tableId,
      tableName: table.tableName,
      columns,
      rows: rows.slice(offset, offset + limit),
      totalRows,
    };
  }

  /**
   * Search knowledge base across RAG document chunks
   */
  async searchKnowledge(
    companyId: string,
    query: string,
    options: {
      dataSourceId?: string;
      dataSourceIds?: string[];
      collectionId?: string;
      agentId?: string;
      limit?: number;
      /** Effective authorization scope supplied by the route after it checks grants. */
      authzFingerprint?: string;
      /** Internal recursion guard for cache miss computation. */
      bypassRetrievalCache?: boolean;
    } = {},
  ): Promise<KnowledgeSearchResult[]> {
    if (options.dataSourceIds && options.dataSourceIds.length === 0) return [];
    const requestedLimit = options.limit ?? 5;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error("Knowledge search limit must be a positive integer");
    }
    const limit = Math.min(20, requestedLimit);

    let allowedDataSourceIds: string[] | null = null;
    if (options.agentId) {
      const access = await this.getAgentDataSources(companyId, options.agentId);
      if (access.mode === "none") {
        return [];
      }
      if (access.mode === "selected") {
        if (!access.effectiveDataSourceIds || access.effectiveDataSourceIds.length === 0) return [];
        allowedDataSourceIds = access.effectiveDataSourceIds;
      }
    }

    if (options.collectionId) {
      // Find collection by id or slug
      let colId = options.collectionId;
      const [col] = await this.db
        .select({ id: dataSourceCollections.id })
        .from(dataSourceCollections)
        .where(
          and(
            eq(dataSourceCollections.companyId, companyId),
            or(eq(dataSourceCollections.id, options.collectionId), eq(dataSourceCollections.slug, options.collectionId)),
          ),
        )
        .limit(1);
      if (col) {
        colId = col.id;
      }

      const colSources = await this.db
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(and(eq(dataSources.companyId, companyId), eq(dataSources.collectionId, colId)));
      const colSourceIds = colSources.map((s) => s.id);
      if (colSourceIds.length === 0) return [];

      if (allowedDataSourceIds) {
        allowedDataSourceIds = allowedDataSourceIds.filter((id) => colSourceIds.includes(id));
        if (allowedDataSourceIds.length === 0) return [];
      } else {
        allowedDataSourceIds = colSourceIds;
      }
    }

    if (options.dataSourceId) {
      if (allowedDataSourceIds && !allowedDataSourceIds.includes(options.dataSourceId)) {
        return [];
      }
      allowedDataSourceIds = [options.dataSourceId];
    }

    if (options.dataSourceIds && options.dataSourceIds.length > 0) {
      if (allowedDataSourceIds) {
        allowedDataSourceIds = options.dataSourceIds.filter((id) => allowedDataSourceIds!.includes(id));
        if (allowedDataSourceIds.length === 0) return [];
      } else {
        allowedDataSourceIds = options.dataSourceIds;
      }
    }

    type QueryEmbeddingBatch = Awaited<ReturnType<RagModelService["embed"]>>;
    const modelConfig = parseDataSourceModelConfig();
    const providerFingerprint = [
      modelConfig.embeddingProvider,
      modelConfig.bgeEmbeddingRevision,
      modelConfig.openRouterBaseUrl,
      modelConfig.openRouterEmbeddingModel,
    ].join(":");
    const normalizedQuery = query;
    const versionConditions = [eq(dataSources.companyId, companyId)];
    if (allowedDataSourceIds) {
      if (allowedDataSourceIds.length === 0) return [];
      versionConditions.push(inArray(dataSources.id, allowedDataSourceIds));
    }
    const sourceVersions = await this.db.select({
      id: dataSources.id,
      status: dataSources.status,
      updatedAt: dataSources.updatedAt,
      metadata: dataSources.metadata,
    }).from(dataSources).where(and(...versionConditions));
    const activeSpaceBySourceId = new Map<string, EmbeddingSpace>();
    const activeGenerationBySourceId = new Map<string, string>();
    const sourceIdsByGeneration = new Map<string, { space: EmbeddingSpace; sourceIds: string[] }>();
    const unversionedEmbeddingSourceIds: string[] = [];
    for (const source of sourceVersions) {
      const metadata = (source.metadata || {}) as Record<string, unknown>;
      const space = metadata.embeddingSpace;
      if (space === "bge-m3" || space === "openrouter-text-embedding-3-small") {
        const generation = typeof metadata.embeddingGeneration === "string" ? metadata.embeddingGeneration : space;
        const entry = sourceIdsByGeneration.get(generation) || { space, sourceIds: [] };
        entry.sourceIds.push(source.id);
        sourceIdsByGeneration.set(generation, entry);
        activeSpaceBySourceId.set(source.id, space);
        activeGenerationBySourceId.set(source.id, generation);
      } else if (metadata.embeddingStatus !== "unavailable") {
        // Older sources may predate source-level generation metadata. Keep
        // their vector sidecars searchable through the configured providers.
        unversionedEmbeddingSourceIds.push(source.id);
      }
    }
    const configuredSpaces: EmbeddingSpace[] = modelConfig.embeddingProvider === "openrouter"
      ? ["openrouter-text-embedding-3-small"]
      : modelConfig.embeddingProvider === "bge"
        ? ["bge-m3"]
        : ["bge-m3", "openrouter-text-embedding-3-small"];
    const modelService = new RagModelService();
    const querySourcesByGeneration = new Map<string, { space: EmbeddingSpace; sourceIds: string[] }>();
    for (const space of configuredSpaces) {
      for (const [generation, entry] of sourceIdsByGeneration) {
        if (entry.space === space) {
          querySourcesByGeneration.set(generation, entry);
        }
      }
      if (unversionedEmbeddingSourceIds.length > 0) {
        const existingLegacy = querySourcesByGeneration.get(space);
        querySourcesByGeneration.set(space, {
          space,
          sourceIds: [...new Set([...(existingLegacy?.sourceIds || []), ...unversionedEmbeddingSourceIds])],
        });
      }
    }
    const isEmbeddingBatch = (space: EmbeddingSpace) => (value: unknown): value is QueryEmbeddingBatch => {
      if (!value || typeof value !== "object") return false;
      const batch = value as Partial<QueryEmbeddingBatch>;
      if (batch.space !== space || typeof batch.generation !== "string"
        || !/^[a-zA-Z0-9._:/@-]{1,256}$/.test(batch.generation)) return false;
      const expectedDimensions = space === "bge-m3" ? 1024 : 1536;
      return Array.isArray(batch.vectors) && batch.vectors.length === 1 && batch.vectors.every((vector) =>
        Array.isArray(vector) && vector.length === expectedDimensions
          && vector.every((entry) => typeof entry === "number" && Number.isFinite(entry)));
    };
    const queryEmbeddingBatches = new Map<string, QueryEmbeddingBatch>();
    const embeddingErrors: unknown[] = [];
    for (const space of configuredSpaces) {
      const targetGenerations = [...querySourcesByGeneration.entries()]
        .filter(([, entry]) => entry.space === space)
        .map(([generation]) => generation);
      if (targetGenerations.length === 0) continue;
      const currentGeneration = modelService.embeddingGeneration(space);
      const cacheKey = makeDataSourceCacheKey([
        "query-embedding",
        companyId,
        providerFingerprint,
        currentGeneration,
        normalizedQuery,
      ]);
      try {
        const ttlSeconds = Number(process.env.DATASOURCE_QUERY_EMBEDDING_CACHE_TTL_SECONDS || 3600);
        const generated = await this.cache.getOrComputeJson(
          cacheKey,
          isEmbeddingBatch(space),
          ttlSeconds,
          () => modelService.embed([query], space),
        );
        if (generated.vectors?.length && generated.space === space && typeof generated.generation === "string") {
          // A gateway alias can resolve to a different upstream model over time.
          // Only query sidecars written by the exact model identity returned now;
          // unknown/legacy generations stay lexical until explicitly reindexed.
          for (const generation of targetGenerations) {
            if (generation === generated.generation) queryEmbeddingBatches.set(generation, generated);
          }
        }
      } catch (error) {
        embeddingErrors.push(error);
      }
    }
    if (queryEmbeddingBatches.size === 0 && embeddingErrors.length > 0) {
      console.warn(
        "[DataSourcesService] Query embedding unavailable; continuing with lexical retrieval:",
        embeddingErrors[0] instanceof Error ? embeddingErrors[0].message : embeddingErrors[0],
      );
    }

    if (!options.bypassRetrievalCache) {
      const versionFingerprint = sourceVersions
        .map((source) => `${source.id}:${source.status}:${source.updatedAt.toISOString()}`)
        .sort()
        .join("|");
      const authzFingerprint = options.authzFingerprint || makeDataSourceCacheKey([
        "rag-effective-access",
        options.agentId || "internal-company-scope",
        ...(allowedDataSourceIds ? [...allowedDataSourceIds].sort() : ["all-company-sources"]),
      ]);
      const cacheKey = makeDataSourceCacheKey([
        "rag-retrieval",
        companyId,
        authzFingerprint,
        options.dataSourceId || "all-sources",
        options.collectionId || "all-collections",
        options.dataSourceIds ? [...options.dataSourceIds].sort().join(",") : "all-requested-sources",
        versionFingerprint,
        providerFingerprint,
        [...queryEmbeddingBatches.keys()].sort().join(",") || "lexical-only",
        normalizedQuery,
        String(limit),
      ]);
      const isKnowledgeResultList = (value: unknown): value is KnowledgeSearchResult[] => Array.isArray(value)
        && value.every((item) => item && typeof item === "object"
          && typeof item.chunkId === "string" && typeof item.dataSourceId === "string"
          && typeof item.content === "string" && typeof item.score === "number");
      const ttlSeconds = Math.max(1, Math.min(300, Number(process.env.DATASOURCE_RETRIEVAL_CACHE_TTL_SECONDS || 60)));
      const result = await this.cache.getOrComputeJson(
        cacheKey,
        isKnowledgeResultList,
        ttlSeconds,
        () => this.searchKnowledge(companyId, query, { ...options, bypassRetrievalCache: true }),
      );
      const latestVersions = await this.db.select({
        id: dataSources.id,
        status: dataSources.status,
        updatedAt: dataSources.updatedAt,
      }).from(dataSources).where(and(...versionConditions));
      const latestFingerprint = latestVersions
        .map((source) => `${source.id}:${source.status}:${source.updatedAt.toISOString()}`)
        .sort()
        .join("|");
      if (latestFingerprint !== versionFingerprint) {
        throw conflict("Knowledge sources changed while retrieval was running; retry against the latest published content");
      }
      return result;
    }

    const stopWords = new Set([
      "dan", "di", "ke", "dari", "yang", "untuk", "pada", "dengan", "ini", "itu",
      "ada", "apa", "siapa", "aja", "saja", "cek", "isinya", "bisa", "tolong",
      "the", "and", "is", "of", "in", "to", "what", "who", "where", "how",
      "menurut", "dalam", "atau", "jika", "adalah", "sebagai", "oleh", "serta",
      "halaman", "gambar", "bab"
    ]);
    const cleanTerms = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1 || /^\d+$/.test(t));
    const contentTerms = cleanTerms.filter((t) => !stopWords.has(t));

    // Strip document name boilerplate tokens when searching within a specific data source
    const sourceNameTokens = new Set<string>();
    if (options.dataSourceId) {
      const [matchedDs] = await this.db
        .select({ name: dataSources.name })
        .from(dataSources)
        .where(eq(dataSources.id, options.dataSourceId))
        .limit(1);
      if (matchedDs?.name) {
        matchedDs.name
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .forEach((w) => {
            if (w.length > 2) sourceNameTokens.add(w);
          });
      }
    }

    const substantiveTerms = contentTerms.filter((t) => !sourceNameTokens.has(t));
    const effectiveTerms = substantiveTerms.length >= 2 ? substantiveTerms : contentTerms;
    const queryTerms = effectiveTerms.length > 0 ? effectiveTerms : cleanTerms;

    // Fetch candidate chunks
    const activeChunkDuringReprocess = sql`(
      ${dataSources.metadata}->>'reprocessingStartedAt' IS NULL
      OR ${dataSourceChunks.createdAt} < (${dataSources.metadata}->>'reprocessingStartedAt')::timestamptz
    )`;
    let whereClause = and(eq(dataSourceChunks.companyId, companyId), activeChunkDuringReprocess) as any;
    if (options.dataSourceId) {
      if (allowedDataSourceIds && !allowedDataSourceIds.includes(options.dataSourceId)) {
        return [];
      }
      whereClause = and(whereClause, eq(dataSourceChunks.dataSourceId, options.dataSourceId)) as any;
    } else if (allowedDataSourceIds && allowedDataSourceIds.length > 0) {
      whereClause = and(whereClause, inArray(dataSourceChunks.dataSourceId, allowedDataSourceIds)) as any;
    }

    // Keyword predicates for candidate filtering
    const termPredicates = queryTerms.slice(0, 5).map((term) =>
      or(
        ilike(dataSourceChunks.content, `%${term}%`),
        ilike(dataSourceChunks.title, `%${term}%`),
        ilike(dataSources.name, `%${term}%`),
      )
    );

    let candidateWhere = whereClause;
    if (termPredicates.length > 0) {
      candidateWhere = and(whereClause, or(...termPredicates)) as any;
    }

    let chunks = await this.db
      .select({
        chunkId: dataSourceChunks.id,
        dataSourceId: dataSourceChunks.dataSourceId,
        title: dataSourceChunks.title,
        content: dataSourceChunks.content,
        tokenCount: dataSourceChunks.tokenCount,
        embedding: dataSourceChunks.embedding,
        metadata: dataSourceChunks.metadata,
        dataSourceName: dataSources.name,
      })
      .from(dataSourceChunks)
      .innerJoin(dataSources, eq(dataSourceChunks.dataSourceId, dataSources.id))
      .where(candidateWhere)
      .limit(300);

    const vectorScoresBySpace = new Map<string, Map<string, number>>();
    for (const [generation, embeddingBatch] of queryEmbeddingBatches) {
      const generationScope = querySourcesByGeneration.get(generation);
      const sourceIds = generationScope?.sourceIds || [];
      const vector = embeddingBatch.vectors?.[0];
      if (!vector || !generationScope) continue;
      const scores = await this.vectorStore.search({
        companyId,
        dataSourceIds: sourceIds,
        embeddingSpace: generationScope.space,
        embeddingGeneration: generation,
        vector,
        limit: 300,
      });
      if (scores) vectorScoresBySpace.set(generation, scores);
    }
    const existingChunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
    const vectorOnlyIds = [...new Set([...vectorScoresBySpace.values()].flatMap((scores) => [...scores.keys()]))]
      .filter((id) => !existingChunkIds.has(id))
      .slice(0, 500);
    if (vectorOnlyIds.length > 0) {
      const vectorChunks = await this.db
        .select({
          chunkId: dataSourceChunks.id,
          dataSourceId: dataSourceChunks.dataSourceId,
          title: dataSourceChunks.title,
          content: dataSourceChunks.content,
          tokenCount: dataSourceChunks.tokenCount,
          embedding: dataSourceChunks.embedding,
          metadata: dataSourceChunks.metadata,
          dataSourceName: dataSources.name,
        })
        .from(dataSourceChunks)
        .innerJoin(dataSources, eq(dataSourceChunks.dataSourceId, dataSources.id))
        .where(and(whereClause, inArray(dataSourceChunks.id, vectorOnlyIds)))
        .limit(500);
      chunks.push(...vectorChunks);
    }

    // If candidate filtering returned fewer than limit, also pull general chunks
    if (chunks.length < limit && termPredicates.length > 0) {
      const generalChunks = await this.db
        .select({
          chunkId: dataSourceChunks.id,
          dataSourceId: dataSourceChunks.dataSourceId,
          title: dataSourceChunks.title,
          content: dataSourceChunks.content,
          tokenCount: dataSourceChunks.tokenCount,
          embedding: dataSourceChunks.embedding,
          metadata: dataSourceChunks.metadata,
          dataSourceName: dataSources.name,
        })
        .from(dataSourceChunks)
        .innerJoin(dataSources, eq(dataSourceChunks.dataSourceId, dataSources.id))
        .where(whereClause)
        .limit(300);

      const existingIds = new Set(chunks.map((c) => c.chunkId));
      for (const gc of generalChunks) {
        if (!existingIds.has(gc.chunkId)) {
          chunks.push(gc);
        }
      }
    }

    const scoredResults: KnowledgeSearchResult[] = [];
    const lexicalScores = new Map<string, number>();
    const denseScoresBySpace = new Map<string, Map<string, number>>();
    for (const generation of queryEmbeddingBatches.keys()) denseScoresBySpace.set(generation, new Map());

    for (const chunk of chunks) {
      const contentLower = chunk.content.toLowerCase();
      const titleLower = (chunk.title || "").toLowerCase();
      const dsNameLower = (chunk.dataSourceName || "").toLowerCase();

      // 1. Lexical score
      let lexicalScore = 0;
      let matchedContentTerms = 0;

      for (const term of queryTerms) {
        if (dsNameLower.includes(term)) lexicalScore += 1.5;
        if (titleLower.includes(term)) lexicalScore += 2.0;
        if (contentLower.includes(term)) {
          matchedContentTerms++;
          const matches = contentLower.split(term).length - 1;
          lexicalScore += Math.min(matches, 5) * 2.5;
        }
      }

      // Coverage boost: prioritize passages containing multiple query keywords together
      if (queryTerms.length > 1 && matchedContentTerms >= 2) {
        lexicalScore += (matchedContentTerms / queryTerms.length) * 12.0;
      }

      // Exact phrase match boost if multi-word query exists
      if (contentTerms.length >= 2) {
        const fullPhrase = contentTerms.join(" ");
        if (contentLower.includes(fullPhrase)) {
          lexicalScore += 15.0;
        }
        if (dsNameLower.includes(fullPhrase)) {
          lexicalScore += 5.0;
        }
      }

      // 2. Dense semantic score (cosine similarity)
      let denseScore = 0;
      const storedEmbeddingSpace = (chunk.metadata as any)?.embeddingSpace as EmbeddingSpace | null | undefined;
      const storedGeneration = (chunk.metadata as any)?.embeddingGeneration as string | null | undefined;
      const activeGeneration = activeGenerationBySourceId.get(chunk.dataSourceId) || storedGeneration || storedEmbeddingSpace;
      const denseScores = denseScoresBySpace.get(activeGeneration || "");
      const indexedScore = vectorScoresBySpace.get(activeGeneration || "")?.get(chunk.chunkId);
      if (typeof indexedScore === "number") {
        denseScore = indexedScore;
      } else if ((storedGeneration || storedEmbeddingSpace) === activeGeneration) {
        const queryVector = queryEmbeddingBatches.get(activeGeneration || "")?.vectors?.[0];
        if (queryVector && chunk.embedding && Array.isArray(chunk.embedding)) {
          denseScore = KnowledgeIngestionService.cosineSimilarity(queryVector, chunk.embedding);
        }
      }
      if (denseScores && denseScore > 0) denseScores.set(chunk.chunkId, denseScore);

      lexicalScores.set(chunk.chunkId, lexicalScore);

      // Keep candidates from either retrieval path. Final ordering below uses
      // reciprocal-rank fusion so lexical and cosine score scales are never
      // treated as directly comparable probabilities.
      const combinedScore = denseScore * 0.3 + Math.min(lexicalScore / 35, 1.0) * 0.7;

      if (denseScore > 0 || lexicalScore > 0) {
        // Snippet extraction around highest term match density
        let snippet = chunk.content.slice(0, 500) + "...";
        const substantiveTerms = queryTerms.filter((t) => !stopWords.has(t) && t.length > 2);
        const searchTerms = substantiveTerms.length > 0 ? substantiveTerms : queryTerms;

        if (searchTerms.length > 0 && chunk.content.length > 0) {
          let bestPos = 0;
          let maxWindowScore = -1;
          const windowSize = Math.min(550, chunk.content.length);

          for (let pos = 0; pos <= chunk.content.length - Math.min(windowSize, 200); pos += 80) {
            const windowText = contentLower.slice(pos, pos + windowSize);
            let windowScore = 0;
            for (const term of searchTerms) {
              if (windowText.includes(term)) {
                windowScore += 5.0;
                const cnt = windowText.split(term).length - 1;
                windowScore += Math.min(cnt, 3) * 1.5;
              }
            }
            if (windowScore > maxWindowScore) {
              maxWindowScore = windowScore;
              bestPos = pos;
            }
          }

          if (maxWindowScore > 0) {
            const start = bestPos;
            const end = Math.min(chunk.content.length, bestPos + windowSize);
            snippet = (start > 0 ? "..." : "") + chunk.content.slice(start, end).trim() + (end < chunk.content.length ? "..." : "");
          }
        }

        let displayTitle = chunk.title;
        if (!displayTitle || /^\d+$/.test(displayTitle.trim())) {
          displayTitle = chunk.dataSourceName;
        }

        scoredResults.push({
          chunkId: chunk.chunkId,
          dataSourceId: chunk.dataSourceId,
          dataSourceName: chunk.dataSourceName,
          title: displayTitle,
          content: chunk.content,
          score: Number(combinedScore.toFixed(4)),
          snippet,
          tokenCount: chunk.tokenCount,
        });
      }
    }

    const rankScores = (scores: Map<string, number>): Map<string, number> => {
      const ranked = [...scores.entries()]
        .filter(([, score]) => score > 0)
        .sort((left, right) => right[1] - left[1]);
      return new Map(ranked.map(([id], index) => [id, index + 1]));
    };
    const lexicalRanks = rankScores(lexicalScores);
    const denseRanksBySpace = new Map([...denseScoresBySpace].map(([space, scores]) => [space, rankScores(scores)]));
    const rrfScale = (1 + denseRanksBySpace.size) / 61;
    for (const result of scoredResults) {
      const lexicalRank = lexicalRanks.get(result.chunkId);
      const reciprocalRank = (lexicalRank ? 1 / (60 + lexicalRank) : 0)
        + [...denseRanksBySpace.values()].reduce((sum, ranks) => {
          const denseRank = ranks.get(result.chunkId);
          return sum + (denseRank ? 1 / (60 + denseRank) : 0);
        }, 0);
      result.score = Number((reciprocalRank / rrfScale).toFixed(4));
    }

    // Sort by reciprocal-rank fusion score descending
    scoredResults.sort((a, b) => b.score - a.score);

    // Deduplicate near-identical chunks (e.g. duplicate uploads or overlapping windows)
    const deduplicatedResults: KnowledgeSearchResult[] = [];
    const seenContents = new Set<string>();

    for (const res of scoredResults) {
      const normalizedPrefix = res.content.trim().toLowerCase().slice(0, 160).replace(/\s+/g, " ");
      if (seenContents.has(normalizedPrefix)) {
        continue;
      }
      seenContents.add(normalizedPrefix);
      deduplicatedResults.push(res);
      if (deduplicatedResults.length >= limit) {
        break;
      }
    }

    return deduplicatedResults;
  }

  /**
   * Resolve a data source by UUID or name
   */
  async resolveDataSource(companyId: string, idOrName: string): Promise<DataSource | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
    const whereCondition = and(
      eq(dataSources.companyId, companyId),
      isUuid ? eq(dataSources.id, idOrName) : or(eq(dataSources.name, idOrName), ilike(dataSources.name, idOrName)),
    );
    const [found] = await this.db.select().from(dataSources).where(whereCondition).limit(1);
    return (found as any) || null;
  }

  /**
   * Run a direct read-only SQL query on an external database data source
   */
  async querySql(
    companyId: string,
    dataSourceId: string,
    sqlQuery: string,
    limit?: number,
    signal?: AbortSignal,
    options: { params?: unknown[]; statementTimeoutMs?: number } = {},
  ): Promise<SqlQueryResult> {
    const ds = await this.resolveDataSource(companyId, dataSourceId);

    if (!ds) {
      throw new Error(`Data source not found: ${dataSourceId}`);
    }

    if (ds.sourceType === "clickhouse" || ds.sourceType === "csv" || ds.sourceType === "excel") {
      return this.queryClickhouse(companyId, sqlQuery, limit, signal);
    }

    if (ds.sourceType !== "postgres" && ds.sourceType !== "mariadb" && ds.sourceType !== "mysql") {
      throw new Error(
        `Direct SQL queries are only supported on external database data sources or ClickHouse, not ${ds.sourceType}`,
      );
    }

    const config = await new DataSourceDatabaseConfigService(this.db).resolve(companyId, ds);

    const dbIntegration = new DatabaseIntegrationService();
    return externalQueryAdmission.run(
      `${companyId}:${ds.id}`,
      () => dbIntegration.queryDatabase(config, sqlQuery, limit, options.params ?? [], signal, {
        statementTimeoutMs: options.statementTimeoutMs,
      }),
      signal,
    );
  }

  /**
   * Run a direct read-only SQL query on ClickHouse OLAP storage
   */
  async queryClickhouse(
    companyId: string,
    sqlQuery: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SqlQueryResult> {
    const clickhouse = new ClickhouseService();
    const companyDb = clickhouse.getCompanyDatabase(companyId);

    let queryToRun = sqlQuery.trim();
    if (limit && !/\bLIMIT\s+\d+/i.test(queryToRun)) {
      queryToRun += ` LIMIT ${limit}`;
    }

    let deduplicateTargets: string[] = [];
    let replacingTables: Array<{
      id: string;
      tableName: string;
      semanticModel: Record<string, unknown> | null;
    }> = [];
    try {
      replacingTables = await this.db
        .select({ id: dataSourceTables.id, tableName: dataSourceTables.tableName, semanticModel: dataSourceTables.semanticModel })
        .from(dataSourceTables)
        .where(eq(dataSourceTables.companyId, companyId));
    } catch {
      // In-memory or test fallback
    }
    const aliasInputs = replacingTables.map((table) => {
      const semanticModel = (table.semanticModel || {}) as Record<string, unknown>;
      return {
        id: table.id,
        tableName: table.tableName,
        sourceSchema: typeof semanticModel.sourceSchema === "string" ? semanticModel.sourceSchema : "public",
        clickhouseTable: typeof semanticModel.clickhouseTable === "string" ? semanticModel.clickhouseTable : undefined,
      };
    });
    const aliasTargets = buildClickhouseTableAliasTargets(aliasInputs);
    const tableNameAliases = buildClickhouseTableAliasMap(aliasInputs);
    const ambiguousTableAliases = new Map(
      [...aliasTargets].filter(([, physicalNames]) => physicalNames.length > 1),
    );
    queryToRun = rewriteClickhouseTableReferences(
      queryToRun,
      tableNameAliases,
      extractClickhouseCteNames(queryToRun),
      ambiguousTableAliases,
    );
    deduplicateTargets = replacingTables
      .filter((t) => {
        const sem = (t.semanticModel as any) || {};
        return shouldApplyClickhouseFinalDeduplication(sem);
      })
      .map((t) => (t.semanticModel as any)?.clickhouseTable || clickhouseSourceTableName(t.id, t.tableName));

    const result = await clickhouse.query(
      queryToRun,
      companyDb,
      {},
      { deduplicateTables: deduplicateTargets, signal },
    );

    return {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionTimeMs: result.executionTimeMs,
      sql: queryToRun,
    };
  }

  /**
   * Sync a data source or all data sources for a company to ClickHouse OLAP engine
   */
  async syncToClickhouse(
    companyId: string,
    dataSourceId?: string,
  ): Promise<{
    syncedTables: Array<{ tableName: string; rowCount: number; clickhouseTable: string }>;
    totalRows: number;
    companyDatabase: string;
  }> {
    const clickhouse = new ClickhouseService();
    const companyDb = await clickhouse.ensureCompanyDatabase(companyId);

    const dsWhere = dataSourceId
      ? and(eq(dataSources.id, dataSourceId), eq(dataSources.companyId, companyId))
      : eq(dataSources.companyId, companyId);

    const dsList = await this.db.select().from(dataSources).where(dsWhere);

    const syncedTables: Array<{ tableName: string; rowCount: number; clickhouseTable: string }> = [];
    let totalRows = 0;

    for (const ds of dsList) {
      const tables = await this.db
        .select()
        .from(dataSourceTables)
        .where(and(eq(dataSourceTables.dataSourceId, ds.id), eq(dataSourceTables.companyId, companyId)));

      for (const tbl of tables) {
        const sanitizedName = sourceClickhouseTableName(tbl);
        const sModel: any = tbl.semanticModel || {};
        let ddl = sModel.clickhouseSchema?.createTableDdl;

        // If DDL is missing, synthesize it from schemaDefinition
        if (!ddl) {
          const cols = (tbl.schemaDefinition || []) as ColumnDefinition[];
          const chTypes: Record<string, string> = {
            number: "Float64",
            date: "String",
            boolean: "UInt8",
            string: "String",
            json: "String",
            unknown: "String",
          };
          const ddlCols = cols
            .map((c) => `  \`${c.name}\` ${c.clickhouseType || chTypes[c.dataType] || "String"}`)
            .join(",\n");
          const pk = sModel.primaryKey || (cols.length > 0 ? cols[0].name : "");
          const orderClause = pk ? `\`${pk}\`` : "tuple()";
          ddl = `CREATE TABLE IF NOT EXISTS \`${sanitizedName}\` (\n${ddlCols}\n) ENGINE = MergeTree()\nORDER BY (${orderClause});`;
        }
        ddl = rewriteClickhouseCreateTableName(ddl, sanitizedName);

        // Clean any unquoted tuple identifiers in existing DDL (e.g. Tuple(0 Float64, 1 Float64))
        ddl = ddl.replace(/Tuple\(([^)]+)\)/g, (_match: string, inner: string) => {
          const parts = inner.split(",").map((part: string) => {
            const trimmed = part.trim();
            return trimmed.replace(/^`?([a-zA-Z0-9_]+)`?\s+([A-Za-z0-9_()', ]+)$/, "`$1` $2");
          });
          return `Tuple(${parts.join(", ")})`;
        });

        // Fetch records if available (CSV/Excel)
        const records = await this.db
          .select({ data: dataSourceRecords.data })
          .from(dataSourceRecords)
          .where(and(eq(dataSourceRecords.tableId, tbl.id), eq(dataSourceRecords.companyId, companyId)));

        const rows = records.map((r) => r.data as Record<string, unknown>);

        const isStructuredFile = ds.sourceType === "csv" || ds.sourceType === "excel";
        await clickhouse.syncTable(sanitizedName, ddl, isStructuredFile ? rows : rows.length > 0 ? rows : undefined, companyId);
        if (sModel.primaryKey) {
          try {
            const uniqCheck = await clickhouse.query(
              `SELECT count() AS total, uniqExact(\`${sModel.primaryKey}\`) AS unique_count FROM \`${sanitizedName}\``,
              clickhouse.getCompanyDatabase(companyId),
            );
            if (uniqCheck.rows?.[0]) {
              const total = Number((uniqCheck.rows[0] as any).total || 0);
              const uniqueCount = Number((uniqCheck.rows[0] as any).unique_count || 0);
              const duplicateKeyRows = Math.max(0, total - uniqueCount);
              sModel.qualityCounters = {
                ...(sModel.qualityCounters || {}),
                totalRows: total,
                duplicateKeyRows,
              };
            }
          } catch {
            // Non-blocking in mocks
          }
        }
        if (sModel.clickhouseSchema?.projectionDdl) {
          try {
            await clickhouse.execute(sModel.clickhouseSchema.projectionDdl, clickhouse.getCompanyDatabase(companyId));
          } catch {
            // Projection may already exist
          }
        }
        if ((sModel.clickhouseTable as string | undefined) !== sanitizedName
          || sModel.clickhouseSchema?.createTableDdl !== ddl) {
          await this.db
            .update(dataSourceTables)
            .set({
              semanticModel: {
                ...sModel,
                clickhouseTable: sanitizedName,
                clickhouseSchema: { ...(sModel.clickhouseSchema || {}), createTableDdl: ddl },
              } as any,
              updatedAt: new Date(),
            })
            .where(and(eq(dataSourceTables.id, tbl.id), eq(dataSourceTables.companyId, companyId)));
        }

        syncedTables.push({
          tableName: tbl.tableName,
          rowCount: rows.length || tbl.rowCount,
          clickhouseTable: sanitizedName,
        });
        totalRows += rows.length || tbl.rowCount;
      }
    }

    return {
      syncedTables,
      totalRows,
      companyDatabase: companyDb,
    };
  }

  /**
   * Get assigned data sources for a specific agent
   */
  /**
   * Get assigned data sources for a specific agent
   */
  async getAgentDataSources(companyId: string, agentId: string) {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const availableDataSources = await this.list(companyId);
    const availableCollections = await this.collectionsService.list(companyId);
    const access = (agent.metadata as any)?.dataSourceAccess;

    let mode: "all" | "selected" | "none" = "none";
    let dataSourceIds: string[] = [];
    let collectionIds: string[] = [];

    if (access && typeof access === "object") {
      mode = access.mode || "none";
      dataSourceIds = Array.isArray(access.dataSourceIds) ? access.dataSourceIds : [];
      collectionIds = Array.isArray(access.collectionIds) ? access.collectionIds : [];
    } else {
      // Default heuristics: built-in knowledge & data agents default to "all"
      const marker = readBuiltInAgentMarker(agent.metadata);
      const isKnowledge = marker?.key === "knowledge-agent" || agent.name.toLowerCase().includes("knowledge");
      const isData = marker?.key === "data-agent" || agent.name.toLowerCase().includes("data agent");
      const isIngestion = agent.name.toLowerCase().includes("ingestion");

      if (isKnowledge || isData || isIngestion) {
        mode = "all";
      } else {
        mode = "none";
      }
    }

    const selectedColSet = new Set(collectionIds);
    const selectedDsSet = new Set(dataSourceIds);

    // Compute effective allowed data source IDs:
    // Direct dataSourceIds PLUS all dataSources whose collectionId is in collectionIds
    const effectiveAllowedSet = new Set<string>();
    if (mode === "all") {
      for (const ds of availableDataSources) {
        effectiveAllowedSet.add(ds.id);
      }
    } else if (mode === "selected") {
      for (const ds of availableDataSources) {
        if (selectedDsSet.has(ds.id)) {
          effectiveAllowedSet.add(ds.id);
        } else if (ds.collectionId && selectedColSet.has(ds.collectionId)) {
          effectiveAllowedSet.add(ds.id);
        }
      }
    }

    const assignedDataSources = availableDataSources.filter((ds) => effectiveAllowedSet.has(ds.id));
    const orchestrationConfig = (agent.metadata as any)?.datasourceOrchestration;
    const orchestrationMode: "auto" | "off" = orchestrationConfig?.mode === "off" ? "off" : "auto";

    return {
      agentId,
      companyId,
      agentName: agent.name,
      mode,
      dataSourceIds,
      collectionIds,
      orchestrationMode,
      effectiveDataSourceIds: Array.from(effectiveAllowedSet),
      assignedDataSources,
      availableDataSources,
      availableCollections,
    };
  }

  /**
   * Update assigned data sources for a specific agent
   */
  async updateAgentDataSources(
    companyId: string,
    agentId: string,
    input: {
      mode: "all" | "selected" | "none";
      dataSourceIds?: string[];
      collectionIds?: string[];
      orchestrationMode?: "auto" | "off";
    },
  ) {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const currentMetadata = (agent.metadata as Record<string, unknown>) || {};
    const nextOrchMode = input.orchestrationMode || (currentMetadata.datasourceOrchestration as any)?.mode || "auto";
    const nextMetadata = {
      ...currentMetadata,
      dataSourceAccess: {
        mode: input.mode,
        dataSourceIds: input.mode === "selected" ? (input.dataSourceIds || []) : [],
        collectionIds: input.mode === "selected" ? (input.collectionIds || []) : [],
        updatedAt: new Date().toISOString(),
      },
      datasourceOrchestration: {
        mode: nextOrchMode,
        updatedAt: new Date().toISOString(),
      },
    };

    await this.db
      .update(agents)
      .set({
        metadata: nextMetadata,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    // Audit activity log
    await this.db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "agent.update_data_sources",
      entityType: "agent",
      entityId: agentId,
      details: {
        mode: input.mode,
        assignedCount: input.mode === "selected" ? (input.dataSourceIds || []).length : input.mode === "all" ? "all" : 0,
        collectionCount: input.mode === "selected" ? (input.collectionIds || []).length : 0,
      },
    });

    for (const dsId of input.dataSourceIds || []) {
      await this.cache.invalidateDataSourceCache(companyId, dsId);
    }

    return this.getAgentDataSources(companyId, agentId);
  }
}
