import { createHash } from "node:crypto";
import postgres from "postgres";
import mysql from "mysql2/promise";
import { init as initializeSqlParser, parse as parseSql } from "@guanmingchiu/sqlparser-ts";
import { redactSensitiveText } from "../redaction.js";
import {
  createExternalQueryAbortError,
  throwIfExternalQueryAborted,
} from "./external-query-abort.js";
import type {
  DatabaseConnectionConfig,
  DatabaseConnectionTestResult,
  ColumnDefinition,
  TableSemanticModel,
  TableRelation,
  SqlQueryResult,
  JsonSubField,
  JsonColumnStructure,
  NestedSemanticDimension,
  ClickhouseSchemaDefinition,
  SuggestedQueryTemplate,
  TableIndexDefinition,
} from "@paperclipai/shared";
import { isSensitiveDatabaseSchemaColumn } from "./ai-reasoning.js";

export interface InspectedTableResult {
  tableName: string;
  schemaName?: string;
  rowCount: number;
  columnCount: number;
  schemaDefinition: ColumnDefinition[];
  semanticModel: TableSemanticModel;
}

type ExternalSqlDialect = "postgresql" | "mysql";

// Initialize once before accepting datasource SQL. Parsing is local; no SQL is
// sent to a third party and parser failures are handled closed below.
await initializeSqlParser();

const FORBIDDEN_SQL_AST_NODES = new Set([
  "AlterTable", "AttachDatabase", "Call", "Commit", "Copy", "CreateDatabase", "CreateFunction",
  "CreateIndex", "CreateSchema", "CreateTable", "CreateTrigger", "CreateView", "Deallocate",
  "Delete", "DetachDatabase", "Do", "Drop", "Execute", "Grant", "Insert", "Install",
  "Kill", "LoadData", "Lock", "LockTables", "Merge", "Pragma", "Prepare", "RefreshMaterializedView",
  "Replace", "Revoke", "Rollback", "Set", "Shutdown", "Transaction", "Truncate", "Uninstall",
  "UnlockTables", "Update", "Use", "Vacuum",
]);
const FORBIDDEN_SQL_FUNCTIONS = new Set([
  "benchmark", "get_lock", "last_insert_id", "load_file", "lo_export", "lo_import", "nextval",
  "pg_advisory_lock", "pg_advisory_lock_shared", "pg_advisory_unlock", "pg_advisory_unlock_all",
  "pg_advisory_unlock_shared", "pg_advisory_xact_lock", "pg_advisory_xact_lock_shared",
  "pg_cancel_backend", "pg_logical_emit_message", "pg_notify", "pg_reload_conf", "pg_rotate_logfile",
  "pg_terminate_backend", "pg_try_advisory_lock", "pg_try_advisory_lock_shared", "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared", "pg_write_binary_file", "pg_write_file", "release_all_locks",
  "release_lock", "setval", "sleep", "sys_eval", "sys_exec",
]);

function sqlFunctionName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const lastPart = value[value.length - 1];
  if (!lastPart || typeof lastPart !== "object") return null;
  const identifier = (lastPart as Record<string, unknown>).Identifier;
  if (!identifier || typeof identifier !== "object") return null;
  const name = (identifier as Record<string, unknown>).value;
  return typeof name === "string" ? name.toLowerCase() : null;
}

function astContainsForbiddenSql(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => astContainsForbiddenSql(entry, seen));

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_SQL_AST_NODES.has(key)) return true;
    if (key === "Function" && record[key] && typeof record[key] === "object") {
      const functionName = sqlFunctionName((record[key] as Record<string, unknown>).name);
      if (functionName && FORBIDDEN_SQL_FUNCTIONS.has(functionName)) return true;
    }
    if ((key === "into" || key === "locking_read") && record[key] != null) return true;
    if (key === "locks" && Array.isArray(record[key]) && record[key].length > 0) return true;
    if (astContainsForbiddenSql(record[key], seen)) return true;
  }
  return false;
}

function isReadOnlyQueryStatement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const statement = value as Record<string, unknown>;
  const query = statement.Query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return false;
  const body = (query as Record<string, unknown>).body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const queryBody = body as Record<string, unknown>;
  return Object.hasOwn(queryBody, "Select") || Object.hasOwn(queryBody, "SetOperation");
}

export function databaseConnectionErrorMessage(error: unknown, config: DatabaseConnectionConfig): string {
  let message = error instanceof Error ? error.message : "Database adapter failed";
  if (config.password) {
    message = message.replaceAll(config.password, "[redacted]");
    const encoded = encodeURIComponent(config.password);
    if (encoded !== config.password) message = message.replaceAll(encoded, "[redacted]");
  }
  return redactSensitiveText(message).slice(0, 2000);
}

export function validateReadOnlySqlQuery(sqlQuery: string, dialect: ExternalSqlDialect = "postgresql"): string {
  const cleanedSql = sqlQuery.trim();
  if (!cleanedSql) throw new Error("SQL query cannot be empty");
  if (Buffer.byteLength(cleanedSql, "utf8") > 64 * 1024) throw new Error("SQL query exceeds the 64 KiB limit");
  const normalizedSql = cleanedSql.replace(/;+$/, "");
  let parsed: unknown;
  try {
    parsed = parseSql(normalizedSql, dialect);
  } catch {
    throw new Error("Security Violation: SQL must be a valid single read-only SELECT query for the connected database.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isReadOnlyQueryStatement(parsed[0]) || astContainsForbiddenSql(parsed)) {
    throw new Error("Security Violation: Only a single read-only SELECT query is permitted.");
  }
  return normalizedSql;
}

export class DatabaseIntegrationService {
  /**
   * 1. Test database connection
   */
  async testConnection(config: DatabaseConnectionConfig): Promise<DatabaseConnectionTestResult> {
    const start = Date.now();
    try {
      if (config.type === "postgres") {
        const sql = this.createSinglePostgresConnection(config, 5);

        const rows = await sql`SELECT 1 as connected, current_database() as db, version() as version`;
        const latencyMs = Date.now() - start;
        await sql.end({ timeout: 2 });

        return {
          success: true,
          latencyMs,
          database: (rows[0] as any)?.db ?? config.database,
          version: (rows[0] as any)?.version ?? "PostgreSQL",
          serverType: "postgres",
        };
      } else if (config.type === "mariadb" || config.type === "mysql") {
        const conn = await this.createMysqlConnection(config, 8000);

        const [rows] = await conn.query("SELECT 1 as connected, DATABASE() as db, VERSION() as version");
        const latencyMs = Date.now() - start;
        await conn.end();

        const row = Array.isArray(rows) && rows.length > 0 ? (rows[0] as any) : {};
        return {
          success: true,
          latencyMs,
          database: row.db ?? config.database,
          version: row.version ?? "MariaDB/MySQL",
          serverType: config.type,
        };
      } else {
        return {
          success: false,
          error: `Unsupported database engine: ${config.type}`,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        error: databaseConnectionErrorMessage(err, config) || "Failed to connect to database",
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * 2. Inspect database tables, columns, relations, and build semantic models
   */
  async inspectDatabase(config: DatabaseConnectionConfig): Promise<InspectedTableResult[]> {
    if (config.type === "postgres") {
      return this.inspectPostgres(config);
    } else {
      return this.inspectMariaDb(config);
    }
  }

  /**
   * PostgreSQL Schema & Relation Inspector
   */
  private async inspectPostgres(config: DatabaseConnectionConfig): Promise<InspectedTableResult[]> {
    const sql = this.getPostgresSql(config, 2, 10);

    try {
      // 1. Get user tables
      const tablesQuery = await sql`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;

      const allowedTables = config.allowedTables?.map((t) => t.toLowerCase());
      const allowedSchemas = config.allowedSchemas?.map((schema) => schema.toLowerCase());
      const selectedTables = tablesQuery.filter((t: any) => {
        if (allowedSchemas && allowedSchemas.length > 0 && !allowedSchemas.includes(String(t.table_schema).toLowerCase())) {
          return false;
        }
        if (allowedTables && allowedTables.length > 0) {
          return allowedTables.includes(t.table_name.toLowerCase());
        }
        return true;
      });

      // 2. Get Foreign Keys across database
      const fksQuery = await sql`
        SELECT
          tc.table_name as source_table,
          kcu.column_name as source_column,
          ccu.table_name AS target_table,
          ccu.column_name AS target_column,
          tc.table_schema AS source_schema,
          ccu.table_schema AS target_schema
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.constraint_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('information_schema', 'pg_catalog')
      `;

      const allRelations: TableRelation[] = fksQuery.map((r: any) => ({
        sourceTable: r.source_table,
        sourceColumn: r.source_column,
        targetTable: r.target_table,
        targetColumn: r.target_column,
        sourceSchema: r.source_schema,
        targetSchema: r.target_schema,
        relationType: "many_to_one",
      }));

      const results: InspectedTableResult[] = [];

      for (const t of selectedTables) {
        const schema = t.table_schema;
        const tableName = t.table_name;

        // Get column details with native type
        const colsQuery = await sql`
          SELECT
            c.column_name,
            c.data_type,
            c.udt_name,
            c.is_nullable,
            c.column_default,
            (
              SELECT COUNT(1) > 0
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
              WHERE tc.table_schema = c.table_schema
                AND tc.table_name = c.table_name
                AND kcu.column_name = c.column_name
                AND tc.constraint_type = 'PRIMARY KEY'
            ) as is_pk
          FROM information_schema.columns c
          WHERE c.table_schema = ${schema} AND c.table_name = ${tableName}
          ORDER BY c.ordinal_position
        `;

        // Extract table indexes with columns, order, expressions, index type, and capability failure
        let tableIndexes: TableIndexDefinition[] = [];
        try {
          const idxQuery = await sql`
            SELECT
              i.relname as index_name,
              ix.indisunique as is_unique,
              ix.indisprimary as is_primary,
              pg_get_expr(ix.indpred, ix.indrelid) as predicate,
              pg_get_indexdef(ix.indexrelid) as index_def,
              am.amname as index_type,
              ARRAY(
                SELECT pg_get_indexdef(ix.indexrelid, k.n, true)
                FROM generate_subscripts(ix.indkey, 1) as k(n)
              ) as index_columns
            FROM pg_index ix
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_am am ON am.oid = i.relam
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = ${schema} AND t.relname = ${tableName}
          `;
          tableIndexes = idxQuery.map((row: any) => {
            const rawCols = Array.isArray(row.index_columns) ? row.index_columns.map(String) : [];
            const cleanCols = rawCols.map((c: string) => c.replace(/^"|"$/g, ""));
            const hasExpression = rawCols.some((c: string) => c.includes("(") || c.includes(" ") || c.includes("::"));
            return {
              name: String(row.index_name),
              columns: cleanCols,
              isUnique: Boolean(row.is_unique),
              isPrimary: Boolean(row.is_primary),
              predicate: row.predicate ? String(row.predicate) : null,
              expression: hasExpression ? rawCols.join(", ") : null,
              indexType: String(row.index_type || "btree"),
              capabilityFailure: null,
            };
          });
        } catch (idxErr: any) {
          // Record capability failure gracefully
          tableIndexes = [
            {
              name: `${tableName}_idx_fallback`,
              columns: [],
              isUnique: false,
              capabilityFailure: idxErr?.message || "Index inspection capability restricted",
            },
          ];
        }

        // Estimate row count & samples with error resilience
        let totalRows = 0;
        let rowCountEstimated = false;
        let sampleRows: any[] = [];
        try {
          const approxRes = await sql`
            SELECT c.reltuples::bigint as approx_total
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${schema} AND c.relname = ${tableName}
          `;
          const approx = Number(approxRes[0]?.approx_total ?? -1);
          if (approx >= 0) {
            totalRows = approx;
            rowCountEstimated = true;
          } else {
            const countRes = await sql`
              SELECT count(1)::int as total FROM ${sql(`${schema}.${tableName}`)}
            `;
            totalRows = Number(countRes[0]?.total ?? 0);
          }

          sampleRows = await sql`
            SELECT * FROM ${sql(`${schema}.${tableName}`)} LIMIT 10
          `;
          if (rowCountEstimated && totalRows === 0 && sampleRows.length > 0) {
            totalRows = sampleRows.length;
          }
        } catch (err: any) {
          console.warn(`[database-integration] Could not query rows for table ${tableName}:`, databaseConnectionErrorMessage(err, config));
        }

        // Match table foreign keys
        const tableRelations = allRelations.filter(
          (r) => (r.sourceTable === tableName && r.sourceSchema === schema)
            || (r.targetTable === tableName && r.targetSchema === schema),
        );

        const columnProfiles: ColumnDefinition[] = colsQuery.map((col: any) => {
          const colName = col.column_name;
          const isPk = Boolean(col.is_pk);
          const colFk = allRelations.find(
            (r) => r.sourceTable === tableName && r.sourceSchema === schema && r.sourceColumn === colName,
          );

          const samples = sampleRows.map((r: any) => r[colName] ?? null);
          const nullCount = samples.filter((v: any) => v === null || v === undefined).length;
          const nullRatio = samples.length > 0 ? nullCount / samples.length : 0;
          const distinctCount = new Set(samples.filter((v: any) => v !== null)).size;

          const inspection = this.inspectColumn(colName, col.data_type, samples);
          const role = this.determineRole(colName, inspection.dataType, isPk, Boolean(colFk));
          const semanticCategory = this.determineSemanticCategory(colName, inspection.dataType, inspection.isJson, isPk);
          const humanLabel = this.humanizeLabel(colName);
          const isSearchable = this.isSearchableColumn(colName, role, semanticCategory);

          let min: any = null;
          let max: any = null;
          if (inspection.dataType === "number") {
            const numVals = samples.filter((v: any) => typeof v === "number");
            if (numVals.length > 0) {
              min = Math.min(...numVals);
              max = Math.max(...numVals);
            }
          }

          return {
            name: colName,
            dataType: inspection.dataType,
            nativeType: col.udt_name || col.data_type,
            nullCount,
            nullRatio,
            distinctCount,
            min,
            max,
            sampleValues: samples.slice(0, 5),
            role,
            semanticCategory,
            humanLabel,
            isSearchable,
            isPrimaryKey: isPk,
            isForeignKey: Boolean(colFk),
            foreignKeyTarget: colFk
              ? { schema: colFk.targetSchema, table: colFk.targetTable, column: colFk.targetColumn }
              : undefined,
            isJson: inspection.isJson,
            jsonStructure: inspection.jsonStructure,
            clickhouseType: inspection.clickhouseType,
          };
        });

        // Generate semantic model
        const primaryKey = columnProfiles.find((c) => c.isPrimaryKey)?.name;
        const semanticModel = this.buildSemanticModel(tableName, columnProfiles, tableRelations, primaryKey);
        semanticModel.indexes = tableIndexes;
        semanticModel.rowCountEstimated = rowCountEstimated;
        semanticModel.sourceSchema = schema;

        results.push({
          tableName,
          schemaName: schema,
          rowCount: totalRows,
          columnCount: columnProfiles.length,
          schemaDefinition: columnProfiles,
          semanticModel,
        });
      }

      synthesizeDatabaseRelationsAndComponents(results, allRelations);

      await sql.end({ timeout: 2 });
      return results;
    } catch (err: any) {
      await sql.end({ timeout: 1 }).catch(() => {});
      throw new Error(databaseConnectionErrorMessage(err, config));
    }
  }

  /**
   * MariaDB / MySQL Schema & Relation Inspector
   */
  private async inspectMariaDb(config: DatabaseConnectionConfig): Promise<InspectedTableResult[]> {
    const conn = await this.createMysqlConnection(config, 8000);

    try {
      // 1. Get Tables with metadata row counts
      const [tableRows] = await conn.query(`
        SELECT table_name, table_rows
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `, [config.database]);

      const allowedTables = config.allowedTables?.map((t) => t.toLowerCase());
      const selectedTables = (tableRows as any[]).filter((t: any) => {
        const name = (t.table_name || t.TABLE_NAME || "").toString();
        if (allowedTables && allowedTables.length > 0) {
          return allowedTables.includes(name.toLowerCase());
        }
        return Boolean(name);
      });

      // 2. Get Foreign Keys
      const [fkRows] = await conn.query(`
        SELECT
          table_name as source_table,
          column_name as source_column,
          referenced_table_name as target_table,
          referenced_column_name as target_column
        FROM information_schema.key_column_usage
        WHERE table_schema = ?
          AND referenced_table_name IS NOT NULL
      `, [config.database]);

      const allRelations: TableRelation[] = (fkRows as any[]).map((r: any) => ({
        sourceTable: (r.source_table || r.SOURCE_TABLE || "").toString(),
        sourceColumn: (r.source_column || r.SOURCE_COLUMN || "").toString(),
        targetTable: (r.target_table || r.TARGET_TABLE || "").toString(),
        targetColumn: (r.target_column || r.TARGET_COLUMN || "").toString(),
        sourceSchema: config.database,
        targetSchema: config.database,
        relationType: "many_to_one",
      }));

      const results: InspectedTableResult[] = [];

      for (const t of selectedTables) {
        const tableName = (t.table_name || t.TABLE_NAME || "").toString();
        if (!tableName) continue;

        // Get Columns with native type
        const [colRows] = await conn.query(`
          SELECT
            column_name,
            data_type,
            column_type,
            is_nullable,
            column_key,
            column_default
          FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ordinal_position
        `, [config.database, tableName]);

        // Extract table indexes
        let tableIndexes: TableIndexDefinition[] = [];
        try {
          const [indexRows] = await conn.query(`
            SHOW INDEX FROM \`${config.database}\`.\`${tableName}\`
          `);
          const indexMap = new Map<string, { columns: string[]; isUnique: boolean; isPrimary: boolean }>();
          for (const row of (indexRows as any[])) {
            const keyName = (row.Key_name || row.KEY_NAME || "").toString();
            const colName = (row.Column_name || row.COLUMN_NAME || "").toString();
            const nonUnique = Number(row.Non_unique ?? row.NON_UNIQUE ?? 1);
            if (!indexMap.has(keyName)) {
              indexMap.set(keyName, {
                columns: [],
                isUnique: nonUnique === 0,
                isPrimary: keyName === "PRIMARY",
              });
            }
            indexMap.get(keyName)!.columns.push(colName);
          }
          tableIndexes = Array.from(indexMap.entries()).map(([name, data]) => ({
            name,
            columns: data.columns,
            isUnique: data.isUnique,
            isPrimary: data.isPrimary,
          }));
        } catch {
          // Permissive fallback
        }

        // Row count from information_schema metadata & samples with error resilience
        let totalRows = Number(t.table_rows ?? t.TABLE_ROWS ?? 0);
        const rowCountEstimated = true;
        let sampleRows: any[] = [];
        try {
          const samplePromise = conn.query(
            `SELECT * FROM \`${config.database}\`.\`${tableName}\` LIMIT 10`,
          );
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Sample query timeout")), 3000),
          );
          const [samples] = (await Promise.race([samplePromise, timeoutPromise])) as any;
          sampleRows = Array.isArray(samples) ? (samples as any[]) : [];
          if (totalRows === 0 && sampleRows.length > 0) {
            totalRows = sampleRows.length;
          }
        } catch (err: any) {
          console.warn(`[database-integration] Could not query sample rows for table ${tableName}:`, databaseConnectionErrorMessage(err, config));
        }

        const tableRelations = allRelations.filter(
          (r) => (r.sourceTable === tableName && r.sourceSchema === config.database)
            || (r.targetTable === tableName && r.targetSchema === config.database),
        );

        const columnProfiles: ColumnDefinition[] = (colRows as any[]).map((col: any) => {
          const colName = (col.column_name || col.COLUMN_NAME || "").toString();
          const colKey = (col.column_key || col.COLUMN_KEY || "").toString();
          const rawDataType = (col.data_type || col.DATA_TYPE || "").toString();
          const nativeType = (col.column_type || col.COLUMN_TYPE || rawDataType).toString();
          const isPk = colKey === "PRI";
          const colFk = allRelations.find(
            (r) => r.sourceTable === tableName && r.sourceSchema === config.database && r.sourceColumn === colName,
          );

          const samples = sampleRows.map((r: any) => r[colName] ?? null);
          const nullCount = samples.filter((v: any) => v === null || v === undefined).length;
          const nullRatio = samples.length > 0 ? nullCount / samples.length : 0;
          const distinctCount = new Set(samples.filter((v: any) => v !== null)).size;

          const inspection = this.inspectColumn(colName, rawDataType, samples);
          const role = this.determineRole(colName, inspection.dataType, isPk, Boolean(colFk));
          const semanticCategory = this.determineSemanticCategory(colName, inspection.dataType, inspection.isJson, isPk);
          const humanLabel = this.humanizeLabel(colName);
          const isSearchable = this.isSearchableColumn(colName, role, semanticCategory);

          let min: any = null;
          let max: any = null;
          if (inspection.dataType === "number") {
            const numVals = samples.filter((v: any) => typeof v === "number");
            if (numVals.length > 0) {
              min = Math.min(...numVals);
              max = Math.max(...numVals);
            }
          }

          return {
            name: colName,
            dataType: inspection.dataType,
            nativeType,
            nullCount,
            nullRatio,
            distinctCount,
            min,
            max,
            sampleValues: samples.slice(0, 5),
            role,
            semanticCategory,
            humanLabel,
            isSearchable,
            isPrimaryKey: isPk,
            isForeignKey: Boolean(colFk),
            foreignKeyTarget: colFk
              ? { schema: colFk.targetSchema, table: colFk.targetTable, column: colFk.targetColumn }
              : undefined,
            isJson: inspection.isJson,
            jsonStructure: inspection.jsonStructure,
            clickhouseType: inspection.clickhouseType,
          };
        });

        const primaryKey = columnProfiles.find((c) => c.isPrimaryKey)?.name;
        const semanticModel = this.buildSemanticModel(tableName, columnProfiles, tableRelations, primaryKey);
        semanticModel.indexes = tableIndexes;
        semanticModel.rowCountEstimated = rowCountEstimated;
        semanticModel.sourceSchema = config.database;

        results.push({
          tableName,
          schemaName: config.database,
          rowCount: totalRows,
          columnCount: columnProfiles.length,
          schemaDefinition: columnProfiles,
          semanticModel,
        });
      }

      synthesizeDatabaseRelationsAndComponents(results, allRelations);

      await conn.end();
      return results;
    } catch (err: any) {
      await conn.end().catch(() => {});
      throw new Error(databaseConnectionErrorMessage(err, config));
    }
  }

  /**
   * 3. Safe Read-Only SQL Query Runner (Controlled Direct Query)
   * Strictly enforces read-only operations, statement timeouts, and row limits.
   */
  async queryDatabase(
    config: DatabaseConnectionConfig,
    sqlQuery: string,
    limit: number = 100,
    params: unknown[] = [],
    signal?: AbortSignal,
    options: { statementTimeoutMs?: number } = {},
  ): Promise<SqlQueryResult> {
    const dialect = config.type === "postgres" ? "postgresql" : "mysql";
    const cleanedSql = validateReadOnlySqlQuery(sqlQuery, dialect);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Query limit must be an integer between 1 and 10000");
    }
    const requestedTimeoutMs = options.statementTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1_000 || requestedTimeoutMs > 60_000) {
      throw new Error("Statement timeout must be between 1000 and 60000 milliseconds");
    }

    // Bound the outer result even when a nested CTE/subquery has its own LIMIT.
    // The parser rejects trailing statements and write-bearing SELECT forms;
    // this wrapper guarantees the driver never buffers more than `limit` rows.
    const finalSql = `SELECT * FROM (${cleanedSql}\n) AS _paperclip_bounded_query LIMIT ${limit}`;

    const start = Date.now();

    throwIfExternalQueryAborted(signal);

    if (config.type === "postgres") {
      const sql = this.getPostgresSql(config, 5, 5);
      let activeQuery: { cancel(): void } | undefined;
      const cancelActiveQuery = () => activeQuery?.cancel();
      signal?.addEventListener("abort", cancelActiveQuery, { once: true });

      try {
        // Enforce transaction read only in session
        const rows = await sql.begin(async (tx) => {
          throwIfExternalQueryAborted(signal);
          await tx`SET TRANSACTION READ ONLY`;
          await tx.unsafe(`SET LOCAL statement_timeout = '${requestedTimeoutMs}ms'`);
          await tx`SET LOCAL lock_timeout = '1000ms'`;
          throwIfExternalQueryAborted(signal);
          const query = tx.unsafe(finalSql, params as any[]);
          activeQuery = query;
          if (signal?.aborted) activeQuery.cancel();
          try {
            return await query;
          } finally {
            if (activeQuery === query) activeQuery = undefined;
          }
        });

        throwIfExternalQueryAborted(signal);
        const executionTimeMs = Date.now() - start;

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return {
          columns,
          rows: rows as any[],
          rowCount: rows.length,
          executionTimeMs,
          sql: finalSql,
        };
      } catch (err: any) {
        if (signal?.aborted) throw createExternalQueryAbortError();
        throw new Error(`PostgreSQL execution error: ${databaseConnectionErrorMessage(err, config)}`);
      } finally {
        signal?.removeEventListener("abort", cancelActiveQuery);
        activeQuery = undefined;
      }
    } else {
      const pool = this.getMysqlPool(config, 5, 8000);
      const conn = await pool.getConnection();
      let isDestroyed = false;
      const cancelQuery = () => {
        isDestroyed = true;
        conn.destroy();
      };
      signal?.addEventListener("abort", cancelQuery, { once: true });

      try {
        throwIfExternalQueryAborted(signal);
        // Fail closed if the selected engine cannot enforce its execution deadline.
        await conn.query("SET SESSION TRANSACTION READ ONLY").catch(() => {
          return conn.query("SET TRANSACTION READ ONLY").catch(() => {});
        });
        if (config.type === "mariadb") {
          await conn.query("SET SESSION max_statement_time = ?", [requestedTimeoutMs / 1000]);
        } else {
          await conn.query("SET SESSION max_execution_time = ?", [requestedTimeoutMs]);
        }
        const [rows, fields] = await conn.query(finalSql, params as any[]);
        throwIfExternalQueryAborted(signal);
        const executionTimeMs = Date.now() - start;

        const resultRows = Array.isArray(rows) ? (rows as any[]) : [];
        const columns = Array.isArray(fields) ? fields.map((f: any) => f.name) : (resultRows.length > 0 ? Object.keys(resultRows[0]) : []);

        return {
          columns,
          rows: resultRows,
          rowCount: resultRows.length,
          executionTimeMs,
          sql: finalSql,
        };
      } catch (err: any) {
        if (signal?.aborted) throw createExternalQueryAbortError();
        const errMsg = databaseConnectionErrorMessage(err, config);
        if (/max_statement_time|max_execution_time|interrupted/i.test(errMsg)) {
          isDestroyed = true;
          try { conn.destroy(); } catch {}
        }
        throw new Error(`MariaDB/MySQL execution error: ${errMsg}`);
      } finally {
        signal?.removeEventListener("abort", cancelQuery);
        if (!isDestroyed) {
          conn.release();
        }
      }
    }
  }

  /**
   * Run a small, read-only observation requested by the onboarding mapper.
   * Identifiers must come from the already-inspected catalog; the model never
   * supplies SQL, and PII-like columns are not fetched for semantic samples.
   */
  async observeExternalTableColumns(
    config: DatabaseConnectionConfig,
    input: {
      schemaName: string;
      tableName: string;
      columns: string[];
      signal?: AbortSignal;
    },
  ): Promise<{ valuesByColumn: Record<string, unknown[]>; rowCount: number; executionTimeMs: number }> {
    if (!["postgres", "mysql", "mariadb"].includes(config.type)) {
      throw new Error("Bounded schema observations support PostgreSQL, MySQL, and MariaDB only");
    }
    if (!input.schemaName.trim() || !input.tableName.trim()) {
      throw new Error("A schema-qualified table is required for onboarding observations");
    }
    if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 4) {
      throw new Error("An onboarding observation must request between one and four columns");
    }
    if (new Set(input.columns).size !== input.columns.length
      || input.columns.some((column) => !column.trim() || column.length > 255)) {
      throw new Error("Onboarding observation column identities are invalid");
    }
    if (config.allowedTables?.length
      && !config.allowedTables.some((name) => name.toLowerCase() === input.tableName.toLowerCase())) {
      throw new Error("Onboarding observation table is outside the configured table allowlist");
    }
    if (config.allowedSchemas?.length
      && !config.allowedSchemas.some((name) => name.toLowerCase() === input.schemaName.toLowerCase())) {
      throw new Error("Onboarding observation schema is outside the configured schema allowlist");
    }
    if (input.columns.some(isSensitiveDatabaseSchemaColumn)) {
      throw new Error("Sensitive columns cannot be queried for onboarding semantic observations");
    }

    const quote = config.type === "postgres" ? '"' : "`";
    const quoteIdentifier = (name: string) => `${quote}${name.replaceAll(quote, `${quote}${quote}`)}${quote}`;
    const table = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)}`;
    const projection = input.columns.map(quoteIdentifier).join(", ");
    const result = await this.queryDatabase(
      config,
      `SELECT ${projection} FROM ${table} LIMIT 8`,
      8,
      [],
      input.signal,
      { statementTimeoutMs: 5_000 },
    );
    const valuesByColumn = Object.fromEntries(input.columns.map((column) => [
      column,
      result.rows.map((row) => (row as Record<string, unknown>)[column] ?? null),
    ]));
    return { valuesByColumn, rowCount: result.rowCount, executionTimeMs: result.executionTimeMs };
  }

  /** Read one bounded keyset page for a configured source-table snapshot. */
  async queryKeysetPage(
    config: DatabaseConnectionConfig,
    input: {
      schemaName: string;
      tableName: string;
      columns: string[];
      primaryKey: string;
      after?: unknown;
      pageSize: number;
      signal?: AbortSignal;
    },
  ): Promise<SqlQueryResult> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 5_000) {
      throw new Error("Snapshot page size must be an integer between 1 and 5000");
    }
    if (!input.columns.length || input.columns.length > 500 || !input.columns.includes(input.primaryKey)) {
      throw new Error("Snapshot requires a bounded column list containing its primary key");
    }
    if (config.allowedTables?.length && !config.allowedTables.some((name) => name.toLowerCase() === input.tableName.toLowerCase())) {
      throw new Error("Snapshot table is outside the configured table allowlist");
    }
    if (config.allowedSchemas?.length && !config.allowedSchemas.some((name) => name.toLowerCase() === input.schemaName.toLowerCase())) {
      throw new Error("Snapshot schema is outside the configured schema allowlist");
    }
    if (config.type !== "postgres" && config.type !== "mysql" && config.type !== "mariadb") {
      throw new Error("Keyset snapshots support PostgreSQL, MySQL, and MariaDB sources only");
    }

    const quote = config.type === "postgres" ? '"' : "`";
    const quoteIdentifier = (name: string) => `${quote}${name.replaceAll(quote, `${quote}${quote}`)}${quote}`;
    const table = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)}`;
    const projection = input.columns.map(quoteIdentifier).join(", ");
    const primaryKey = quoteIdentifier(input.primaryKey);
    const where = input.after === undefined ? "" : ` WHERE ${primaryKey} > ${config.type === "postgres" ? "$1" : "?"}`;
    const query = `SELECT ${projection} FROM ${table}${where} ORDER BY ${primaryKey} ASC LIMIT ${input.pageSize}`;
    return this.queryDatabase(
      config,
      query,
      input.pageSize,
      input.after === undefined ? [] : [input.after],
      input.signal,
      { statementTimeoutMs: 30_000 },
    );
  }

  /** Read changed rows in updated-at/primary-key order for an explicitly configured incremental policy. */
  async queryUpdatedKeysetPage(
    config: DatabaseConnectionConfig,
    input: {
      schemaName: string;
      tableName: string;
      columns: string[];
      primaryKey: string;
      updatedAtColumn: string;
      deletedAtColumn?: string;
      since: string;
      after?: { updatedAt: unknown; primaryKey: unknown };
      pageSize: number;
      signal?: AbortSignal;
    },
  ): Promise<SqlQueryResult> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 5_000) {
      throw new Error("Incremental page size must be an integer between 1 and 5000");
    }
    if (!input.columns.length || input.columns.length > 500
      || !input.columns.includes(input.primaryKey) || !input.columns.includes(input.updatedAtColumn)
      || (input.deletedAtColumn !== undefined && !input.columns.includes(input.deletedAtColumn))) {
      throw new Error("Incremental sync requires a bounded projection containing its primary and updated-at columns");
    }
    if (config.allowedTables?.length && !config.allowedTables.some((name) => name.toLowerCase() === input.tableName.toLowerCase())) {
      throw new Error("Incremental table is outside the configured allowlist");
    }
    if (config.allowedSchemas?.length && !config.allowedSchemas.some((name) => name.toLowerCase() === input.schemaName.toLowerCase())) {
      throw new Error("Incremental schema is outside the configured allowlist");
    }
    if (config.type !== "postgres" && config.type !== "mysql" && config.type !== "mariadb") {
      throw new Error("Incremental sync supports PostgreSQL, MySQL, and MariaDB sources only");
    }

    const quote = config.type === "postgres" ? '"' : "`";
    const quoteIdentifier = (name: string) => `${quote}${name.replaceAll(quote, `${quote}${quote}`)}${quote}`;
    const table = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(input.tableName)}`;
    const projection = input.columns.map(quoteIdentifier).join(", ");
    const updatedAt = quoteIdentifier(input.updatedAtColumn);
    const changeTimestamp = input.deletedAtColumn
      ? `GREATEST(COALESCE(${updatedAt}, ${quoteIdentifier(input.deletedAtColumn)}), COALESCE(${quoteIdentifier(input.deletedAtColumn)}, ${updatedAt}))`
      : updatedAt;
    const primaryKey = quoteIdentifier(input.primaryKey);
    const firstParameter = config.type === "postgres" ? "$1" : "?";
    const where = input.after
      ? config.type === "postgres"
        ? ` WHERE ${changeTimestamp} >= ${firstParameter} AND (${changeTimestamp} > $2 OR (${changeTimestamp} = $3 AND ${primaryKey} > $4))`
        : ` WHERE ${changeTimestamp} >= ${firstParameter} AND (${changeTimestamp} > ? OR (${changeTimestamp} = ? AND ${primaryKey} > ?))`
      : ` WHERE ${changeTimestamp} >= ${firstParameter}`;
    const cursorCast = config.type === "postgres" ? "TEXT" : "CHAR";
    const query = `SELECT ${projection}, CAST(${changeTimestamp} AS ${cursorCast}) AS _paperclip_sync_change_cursor FROM ${table}${where} ORDER BY ${changeTimestamp} ASC, ${primaryKey} ASC LIMIT ${input.pageSize}`;
    const params = input.after
      ? [input.since, input.after.updatedAt, input.after.updatedAt, input.after.primaryKey]
      : [input.since];
    return this.queryDatabase(config, query, input.pageSize, params, input.signal, { statementTimeoutMs: 30_000 });
  }

  async resolveTableSchema(config: DatabaseConnectionConfig, tableName: string): Promise<string> {
    if (config.type !== "postgres") return config.database;
    const allowedSchemas = config.allowedSchemas?.filter(Boolean);
    const schemaFilter = allowedSchemas?.length ? "AND table_schema = ANY($2::text[])" : "";
    const result = await this.queryDatabase(config, `
      SELECT table_schema
      FROM information_schema.tables
      WHERE table_name = $1
        AND table_type = 'BASE TABLE'
        AND table_schema NOT IN ('information_schema', 'pg_catalog')
        ${schemaFilter}
      ORDER BY table_schema
      LIMIT 2
    `, 2, allowedSchemas?.length ? [tableName, allowedSchemas] : [tableName]);
    const allowed = allowedSchemas?.map((schema) => schema.toLowerCase());
    const matches = result.rows
      .map((row) => String((row as Record<string, unknown>).table_schema || ""))
      .filter((schema) => schema && (!allowed?.length || allowed.includes(schema.toLowerCase())));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Table '${tableName}' was not found in the configured schemas`
        : `Table '${tableName}' exists in multiple schemas; reconnect with an explicit schema allowlist`);
    }
    return matches[0];
  }

  // --- Helper Methods ---

  /**
   * Inspect a column by checking its raw database type and the top 5 sample rows.
   * If the column contains JSON (native JSON type or JSON string), it parses the
   * structures across the sample rows, extracts nested sub-fields, determines the
   * structure kind, and generates a corresponding ClickHouse data type and nested dimensions.
   */
  public inspectColumn(
    colName: string,
    rawDataType: string,
    samples: any[],
  ): {
    dataType: "string" | "number" | "boolean" | "date" | "json" | "unknown";
    isJson: boolean;
    jsonStructure?: JsonColumnStructure;
    clickhouseType: string;
  } {
    const rawLower = (rawDataType || "").toLowerCase();
    const isDeclaredJson = rawLower.includes("json");

    // Take top 5 non-null/non-undefined sample values
    const nonNullSamples = samples.filter((v) => v !== null && v !== undefined && v !== "");
    const top5Samples = nonNullSamples.slice(0, 5);

    // Check if values are JSON strings or objects
    const parsedSamples: any[] = [];
    let isJson = isDeclaredJson;

    for (const val of top5Samples) {
      if (typeof val === "object" && val !== null) {
        parsedSamples.push(val);
        isJson = true;
      } else if (typeof val === "string") {
        const trimmed = val.trim();
        if (
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && parsed !== null) {
              parsedSamples.push(parsed);
              isJson = true;
            }
          } catch {
            // Not valid JSON string
          }
        }
      }
    }

    if (isJson && parsedSamples.length > 0) {
      // Determine kind: array_of_objects, primitive_array, object, or scalar
      let kind: "object" | "array_of_objects" | "primitive_array" | "scalar" = "object";
      const firstSample = parsedSamples[0];

      if (Array.isArray(firstSample)) {
        const firstItem = firstSample.find((item) => item !== null && item !== undefined);
        if (firstItem && typeof firstItem === "object") {
          kind = "array_of_objects";
        } else {
          kind = "primitive_array";
        }
      } else if (typeof firstSample === "object") {
        kind = "object";
      }

      // Collect union of subfields across top 5 samples
      const subFieldsMap = new Map<string, JsonSubField>();

      for (const sample of parsedSamples) {
        if (kind === "array_of_objects" && Array.isArray(sample)) {
          for (const item of sample) {
            if (!item || typeof item !== "object") continue;

            // Handle nested wrapper like AHU_DB: [ { id: 1, data: [ { sub_field: "..." } ] } ]
            const targets: any[] = Array.isArray(item.data) ? [item, ...item.data] : [item];

            for (const target of targets) {
              if (!target || typeof target !== "object") continue;
              for (const [k, v] of Object.entries(target)) {
                if (
                  !k ||
                  k === "data" ||
                  k === "mxyplyzyk" ||
                  k.startsWith("dummy") ||
                  k === "FormDataPerseroanDummy"
                ) {
                  continue;
                }
                const subType = this.inferValueType(v);
                if (!subFieldsMap.has(k)) {
                  subFieldsMap.set(k, {
                    name: k,
                    dataType: subType,
                    sampleValues: [],
                    description: `Sub-field '${k}' in ${colName}`,
                  });
                }
                const sf = subFieldsMap.get(k)!;
                if (v !== null && v !== undefined && v !== "" && sf.sampleValues.length < 3) {
                  sf.sampleValues.push(typeof v === "object" ? JSON.stringify(v) : (v as any));
                }
              }
            }
          }
        } else if (kind === "object" && typeof sample === "object") {
          for (const [k, v] of Object.entries(sample)) {
            if (!k) continue;
            const subType = this.inferValueType(v);
            if (!subFieldsMap.has(k)) {
              subFieldsMap.set(k, {
                name: k,
                dataType: subType,
                sampleValues: [],
                description: `Sub-field '${k}' in ${colName}`,
              });
            }
            const sf = subFieldsMap.get(k)!;
            if (v !== null && v !== undefined && v !== "" && sf.sampleValues.length < 3) {
              sf.sampleValues.push(typeof v === "object" ? JSON.stringify(v) : (v as any));
            }
          }
        }
      }

      const subFields = Array.from(subFieldsMap.values());

      // Generate ClickHouse type for the JSON column
      let clickhouseType = "String";
      if (kind === "primitive_array") {
        clickhouseType = "Array(String)";
      } else if (kind === "array_of_objects" && subFields.length > 0) {
        const tupleElements = subFields
          .slice(0, 15)
          .map((sf) => `\`${this.sanitizeChIdentifier(sf.name)}\` ${this.mapSubFieldToChType(sf.dataType)}`)
          .join(", ");
        clickhouseType = `Array(Tuple(${tupleElements}))`;
      } else if (kind === "object" && subFields.length > 0) {
        const tupleElements = subFields
          .slice(0, 15)
          .map((sf) => `\`${this.sanitizeChIdentifier(sf.name)}\` ${this.mapSubFieldToChType(sf.dataType)}`)
          .join(", ");
        clickhouseType = `Tuple(${tupleElements})`;
      }

      return {
        dataType: "json",
        isJson: true,
        jsonStructure: {
          isJson: true,
          kind,
          subFields,
          clickhouseType,
        },
        clickhouseType,
      };
    }

    // Not JSON - map to ClickHouse standard type
    const standardChType = this.mapStandardToClickhouseType(rawDataType);
    const genericType = this.mapRawTypeToGeneric(rawDataType);

    return {
      dataType: genericType,
      isJson: false,
      clickhouseType: standardChType,
    };
  }

  private sanitizeChIdentifier(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  private mapSubFieldToChType(dataType: string): string {
    switch (dataType) {
      case "number":
        return "Float64";
      case "boolean":
        return "UInt8";
      case "date":
        return "DateTime64(3, 'UTC')";
      case "string":
      default:
        return "String";
    }
  }

  private mapStandardToClickhouseType(rawDataType: string): string {
    const t = (rawDataType || "").toLowerCase();
    if (t.includes("bigint") || t === "int8") return "Int64";
    if (t.includes("tinyint(1)") || t === "boolean" || t === "bool") return "UInt8";
    if (t.includes("smallint") || t.includes("tinyint") || t === "int2") return "Int32";
    if (t.includes("int") || t === "serial") return "Int64";
    if (
      t.includes("numeric") ||
      t.includes("decimal") ||
      t.includes("float") ||
      t.includes("double") ||
      t.includes("real")
    ) {
      return "Float64";
    }
    if (t === "date") return "Date32";
    if (t.includes("time") || t.includes("date")) return "DateTime64(3, 'UTC')";
    if (t.includes("uuid")) return "UUID";
    return "String";
  }

  private mapRawTypeToGeneric(rawType: string): "string" | "number" | "boolean" | "date" | "unknown" {
    const t = (rawType || "").toLowerCase();
    if (
      t.includes("int") ||
      t.includes("numeric") ||
      t.includes("decimal") ||
      t.includes("real") ||
      t.includes("double") ||
      t.includes("float")
    ) {
      return "number";
    }
    if (t.includes("bool") || t === "tinyint(1)") {
      return "boolean";
    }
    if (t.includes("date") || t.includes("time") || t.includes("year")) {
      return "date";
    }
    if (t.includes("char") || t.includes("text") || t.includes("blob") || t.includes("uuid") || t.includes("enum")) {
      return "string";
    }
    return "unknown";
  }

  private inferValueType(val: any): "string" | "number" | "boolean" | "date" | "unknown" {
    if (typeof val === "boolean") return "boolean";
    if (typeof val === "number") return "number";
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) || /^\d{2}-\d{2}-\d{4}/.test(trimmed)) {
        return "date";
      }
      if (!isNaN(Number(trimmed)) && trimmed !== "" && !trimmed.startsWith("0")) {
        return "number";
      }
      return "string";
    }
    return "string";
  }

  private mapPostgresType(pgType: string): "string" | "number" | "boolean" | "date" | "unknown" {
    return this.mapRawTypeToGeneric(pgType);
  }

  private mapMysqlType(myType: string): "string" | "number" | "boolean" | "date" | "unknown" {
    return this.mapRawTypeToGeneric(myType);
  }

  private determineRole(
    name: string,
    dataType: string,
    isPk: boolean,
    isFk: boolean,
  ): "dimension" | "metric" | "identifier" | "timestamp" | "attribute" {
    if (isPk || isFk || name.toLowerCase().endsWith("_id") || name.toLowerCase() === "id") {
      return "identifier";
    }
    if (
      dataType === "date" ||
      name.toLowerCase().includes("date") ||
      name.toLowerCase().includes("time") ||
      name.toLowerCase().includes("_at")
    ) {
      return "timestamp";
    }
    if (dataType === "number") {
      return "metric";
    }
    return "dimension";
  }

  public determineSemanticCategory(
    colName: string,
    dataType: string,
    isJson: boolean,
    isPk: boolean,
  ): "identity" | "location" | "financial" | "contact" | "temporal" | "status" | "classification" | "nested_structure" | "content" | "general" {
    if (isJson || dataType === "json") return "nested_structure";
    const lower = colName.toLowerCase();

    if (
      isPk ||
      /(^id$|_id$|^id_|nomor|no_|sk_|code|kode|sku|npwp|nik|reg|uuid|passport)/i.test(lower) ||
      /(^nama$|^name$|nama_|name_|_name|_nama|title|judul)/i.test(lower)
    ) {
      return "identity";
    }
    if (/(status|state|kondisi|active|aktif|flag|is_|enabled|valid)/i.test(lower)) {
      return "status";
    }
    if (
      /(alamat|address|street|jalan|kelurahan|desa|kecamatan|kabupaten|kota|city|provinsi|province|state|country|negara|pos|zip|postal|region|wilayah|latitude|longitude|lat|lon|lng)/i.test(
        lower,
      )
    ) {
      return "location";
    }
    if (
      /(modal|harga|price|nilai|total|amount|nominal|biaya|cost|omset|pendapatan|revenue|saldo|fee|tax|pajak|tarif|disetor|balance|salary|gaji|uang)/i.test(
        lower,
      )
    ) {
      return "financial";
    }
    if (/(email|mail|phone|telepon|telp|hp|handphone|fax|mobile|kontak|contact|website|url)/i.test(lower)) {
      return "contact";
    }
    if (
      dataType === "date" ||
      /(tanggal|date|tgl|created|updated|waktu|time|tahun|year|bulan|month|period|periode|timestamp)/i.test(lower)
    ) {
      return "temporal";
    }
    if (
      /(jenis|tipe|type|category|kategori|kelompok|group|divisi|division|departemen|department|sektor|sector|role|jabatan|kbli)/i.test(
        lower,
      )
    ) {
      return "classification";
    }
    if (/(keterangan|deskripsi|description|catatan|notes|remark|memo|detail|bio|summary)/i.test(lower)) {
      return "content";
    }
    if (dataType === "number") return "financial";
    return "general";
  }

  public humanizeLabel(name: string): string {
    return name
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(" ")
      .map((word) => {
        const lower = word.toLowerCase();
        if (lower === "sk") return "SK";
        if (lower === "npwp") return "NPWP";
        if (lower === "id") return "ID";
        if (lower === "cv") return "CV";
        if (lower === "pt") return "PT";
        if (lower === "kbli") return "KBLI";
        if (lower === "tgl") return "Tanggal";
        if (lower === "no") return "Nomor";
        if (lower === "pk") return "PK";
        if (lower === "fk") return "FK";
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  public isSearchableColumn(colName: string, role: string, semanticCategory: string): boolean {
    if (role === "identifier") return true;
    if (semanticCategory === "identity") return true;
    return /^(nama_|nama$|name$|_name|title|judul|kode_|code|label)/i.test(colName);
  }

  private buildSemanticModel(
    tableName: string,
    columns: ColumnDefinition[],
    relations: TableRelation[],
    primaryKey?: string,
  ): TableSemanticModel {
    const dimensions = columns
      .filter((c) => c.role === "dimension" || c.role === "timestamp")
      .map((c) => ({
        name: c.name,
        description: `Dimension column ${c.name} in table ${tableName}`,
        sampleValues: c.sampleValues.map((v) => String(v)),
      }));

    // Extract nested dimensions from JSON columns
    const nestedDimensions: NestedSemanticDimension[] = [];
    for (const c of columns) {
      if (c.isJson && c.jsonStructure?.subFields) {
        for (const sf of c.jsonStructure.subFields) {
          nestedDimensions.push({
            parentColumn: c.name,
            fieldPath: sf.name,
            name: `${c.name}.${sf.name}`,
            description: sf.description || `Nested attribute '${sf.name}' inside JSON column '${c.name}'`,
            dataType: sf.dataType,
            sampleValues: sf.sampleValues.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))),
          });
        }
      }
    }

    const metrics = columns
      .filter((c) => c.role === "metric")
      .map((c) => ({
        name: c.name,
        expression: `SUM("${c.name}")`,
        aggregation: "sum" as const,
        description: `Total sum of ${c.name}`,
      }));

    const foreignKeys = columns
      .filter((c) => c.isForeignKey && c.foreignKeyTarget)
      .map((c) => ({
        column: c.name,
        foreignTable: c.foreignKeyTarget!.table,
        foreignColumn: c.foreignKeyTarget!.column,
      }));

    // Build ClickHouse Schema Definition
    const columnTypes: Record<string, string> = {};
    for (const c of columns) {
      columnTypes[c.name] = c.clickhouseType || "String";
    }

    const ddlColumns = columns
      .map((c) => {
        const chType = c.clickhouseType || "String";
        const comment = c.isJson ? ` COMMENT 'JSON nested: ${c.jsonStructure?.kind}'` : "";
        return `  \`${c.name}\` ${chType}${comment}`;
      })
      .join(",\n");

    const orderBy = primaryKey ? [primaryKey] : [];
    const orderByClause = orderBy.length > 0 ? `\`${orderBy.join("`, `")}\`` : "tuple()";

    const createTableDdl = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n${ddlColumns}\n) ENGINE = MergeTree()\nORDER BY (${orderByClause});`;

    const clickhouseSchema: ClickhouseSchemaDefinition = {
      createTableDdl,
      engine: "MergeTree",
      orderBy,
      columnTypes,
    };

    // Comprehensive Bilingual Synonyms Dictionary
    const synonyms: Record<string, string[]> = {};
    const bilingualMapping: Record<string, string[]> = {
      user: ["user", "pengguna", "akun", "pelanggan", "member", "customer"],
      users: ["users", "daftar pengguna", "list customer", "kumpulan akun"],
      customer: ["customer", "pelanggan", "klien", "buyer", "pembeli"],
      customers: ["customers", "daftar pelanggan", "database klien"],
      order: ["order", "pesanan", "transaksi", "pembelian", "invoice"],
      orders: ["orders", "daftar pesanan", "riwayat transaksi", "penjualan"],
      item: ["item", "barang", "produk", "part"],
      product: ["product", "produk", "barang", "item", "layanan", "service"],
      products: ["products", "katalog produk", "daftar barang", "inventory"],
      price: ["price", "harga", "tarif", "biaya", "cost"],
      amount: ["amount", "total", "jumlah", "omset", "revenue", "omzet", "nominal"],
      total: ["total", "keseluruhan", "grand total", "jumlah"],
      quantity: ["quantity", "qty", "jumlah unit", "volume", "banyaknya"],
      status: ["status", "kondisi", "keadaan", "posisi"],
      date: ["date", "tanggal", "waktu", "periode", "hari"],
      created_at: ["created_at", "tanggal pembuatan", "dibuat pada", "waktu input"],
      region: ["region", "wilayah", "area", "lokasi", "cabang", "zone"],
      category: ["category", "kategori", "golongan", "jenis", "tipe"],
      payment: ["payment", "pembayaran", "metode bayar", "pelunasan"],
      revenue: ["revenue", "pendapatan", "omzet", "penjualan", "omset"],
      profit: ["profit", "laba", "keuntungan", "margin"],
      discount: ["discount", "diskon", "potongan harga", "promo"],
    };

    // Table synonyms
    const tableLower = tableName.toLowerCase();
    synonyms[tableName] = [tableName, ...(bilingualMapping[tableLower] ?? [])];

    // Column synonyms
    for (const col of columns) {
      const colLower = col.name.toLowerCase();
      const matchedSynonyms = new Set<string>([col.name]);

      for (const [key, list] of Object.entries(bilingualMapping)) {
        if (colLower.includes(key)) {
          list.forEach((s) => matchedSynonyms.add(s));
        }
      }

      synonyms[col.name] = Array.from(matchedSynonyms);
    }

    // Nested dimensions synonyms
    for (const nd of nestedDimensions) {
      const matched = new Set<string>([nd.name, nd.fieldPath]);
      const fieldLower = nd.fieldPath.toLowerCase();

      for (const [key, list] of Object.entries(bilingualMapping)) {
        if (fieldLower.includes(key)) {
          list.forEach((s) => matched.add(`${nd.parentColumn}.${s}`));
          list.forEach((s) => matched.add(s));
        }
      }

      // Legal & corporate entity specific synonyms
      if (
        fieldLower.includes("badan_hukum") ||
        fieldLower.includes("pemegangsaham") ||
        fieldLower.includes("pemegang_saham")
      ) {
        ["pemegang saham", "nama pemegang saham", "owner", "shareholder", "pemilik saham"].forEach((s) =>
          matched.add(s),
        );
      }
      if (fieldLower.includes("jabatan") || fieldLower.includes("direksi")) {
        ["jabatan", "direktur", "komisaris", "posisi", "direksi", "pengurus"].forEach((s) => matched.add(s));
      }
      if (fieldLower.includes("harga_per_lembar") || fieldLower.includes("harga_perlembar")) {
        ["harga per lembar", "nominal saham", "nilai saham per lembar"].forEach((s) => matched.add(s));
      }
      if (fieldLower.includes("jumlah_saham") || fieldLower.includes("jumlah_lembar")) {
        ["jumlah saham", "total lembar saham", "banyaknya lembar saham"].forEach((s) => matched.add(s));
      }
      if (fieldLower.includes("maksud") || fieldLower.includes("tujuan")) {
        ["maksud perseroan", "kegiatan usaha", "bidang bisnis", "sektor usaha"].forEach((s) => matched.add(s));
      }

      synonyms[nd.name] = Array.from(matched);
    }

    // Collect JSON structures
    const jsonStructures: Record<string, JsonColumnStructure> = {};
    for (const c of columns) {
      if (c.isJson && c.jsonStructure) {
        jsonStructures[c.name] = c.jsonStructure;
      }
    }

    // Generate dynamically tailored suggested queries based purely on inspected columns and JSON structures
    const suggestedQueries: SuggestedQueryTemplate[] = [];

    // Identify key columns dynamically from schema inspection
    const idCol = columns.find((c) => c.isPrimaryKey || c.name.toLowerCase() === "id" || c.name.toLowerCase().startsWith("id_"))?.name || primaryKey;
    const nameCol = columns.find((c) => /^(nama_|nama$|name$|_name|title|judul|kode_|label)/i.test(c.name))?.name;
    const jsonCols = columns.filter((c) => c.isJson);
    const metricCols = columns.filter((c) => ["number", "integer", "bigint", "float", "double", "decimal"].includes(c.dataType.toLowerCase()));
    const statusCol = columns.find((c) => /^(status|state|kondisi|aktif)/i.test(c.name))?.name;

    // 1. Dynamic Search / Lookup Queries
    if (nameCol) {
      suggestedQueries.push({
        title: `Pencarian Entitas '${tableName}' Berdasarkan ${nameCol} (Exact Match)`,
        query: `Cari data lengkap dalam tabel ${tableName} berdasarkan ${nameCol}`,
        category: "filtering",
        sqlSnippet: `SELECT * FROM \`${tableName}\` WHERE \`${nameCol}\` = '{SEARCH_VALUE}' LIMIT 1;`,
        description: `Pencarian exact match cepat pada kolom ${nameCol}`,
      });

      suggestedQueries.push({
        title: `Pencarian Awalan '${tableName}' (Prefix Match)`,
        query: `Daftar record dalam tabel ${tableName} dengan awalan ${nameCol} tertentu`,
        category: "filtering",
        sqlSnippet: `SELECT * FROM \`${tableName}\` WHERE \`${nameCol}\` LIKE '{PREFIX}%' LIMIT 10;`,
        description: `Pencarian prefix cepat memanfaatkan indeks pada ${nameCol}`,
      });
    } else if (idCol) {
      suggestedQueries.push({
        title: `Lookup ${tableName} Berdasarkan ${idCol}`,
        query: `Cari record ${tableName} berdasarkan ID`,
        category: "filtering",
        sqlSnippet: `SELECT * FROM \`${tableName}\` WHERE \`${idCol}\` = '{ID_VALUE}' LIMIT 1;`,
        description: `Direct primary key lookup pada ${tableName}`,
      });
    }

    // 2. Dynamic JSON Extraction Queries
    for (const jc of jsonCols) {
      const displayCol = nameCol ? `\`${nameCol}\`` : (idCol ? `\`${idCol}\`` : "*");
      suggestedQueries.push({
        title: `Ekstraksi Kolom Terstruktur (${jc.name}) pada ${tableName}`,
        query: `Ambil data terperinci dari kolom JSON ${jc.name} pada tabel ${tableName}`,
        category: "json_extraction",
        sqlSnippet: `SELECT ${displayCol}, \`${jc.name}\` FROM \`${tableName}\` ${nameCol ? `WHERE \`${nameCol}\` = '{SEARCH_VALUE}'` : ""} LIMIT 1;`,
        description: `Mengambil data terstruktur dan sub-field dari kolom JSON ${jc.name}`,
      });
    }

    // 3. Dynamic Metric Aggregation
    if (metricCols.length > 0) {
      const mCol = metricCols[0].name;
      suggestedQueries.push({
        title: `Total & Rata-rata ${mCol} pada ${tableName}`,
        query: `Hitung agregasi metrik ${mCol} dari tabel ${tableName}`,
        category: "aggregation",
        sqlSnippet: `SELECT COUNT(*) as total_records, SUM(\`${mCol}\`) as sum_${mCol}, AVG(\`${mCol}\`) as avg_${mCol} FROM \`${tableName}\`;`,
        description: `Perhitungan total dan rata-rata metrik ${mCol}`,
      });
    }

    // 4. Dynamic Categorical Grouping
    if (statusCol) {
      suggestedQueries.push({
        title: `Distribusi Berdasarkan ${statusCol} pada ${tableName}`,
        query: `Berapa banyak record untuk setiap status ${statusCol} di tabel ${tableName}?`,
        category: "aggregation",
        sqlSnippet: `SELECT \`${statusCol}\`, COUNT(*) as jumlah FROM \`${tableName}\` GROUP BY \`${statusCol}\` ORDER BY jumlah DESC;`,
        description: `Analisis pengelompokan frekuensi berdasarkan ${statusCol}`,
      });
    }

    const cleanTableName = tableName.replace(/^(tbl_|table_|tb_|m_|t_)/i, "").toLowerCase();
    const tableWords = cleanTableName.split(/[\s_\-]+/).filter((w) => w.length > 2);
    const humanEntity = this.humanizeLabel(cleanTableName);
    const entities = Array.from(
      new Set([
        humanEntity,
        ...tableWords.map((w) => this.humanizeLabel(w)),
      ]),
    );

    const searchableColumns = columns
      .filter((c) => c.isSearchable || c.role === "identifier" || c.semanticCategory === "identity")
      .map((c) => c.name);

    const colNames = columns.map((c) => c.name.toLowerCase());
    const tableTopics: string[] = [];

    // Derive topics from table identity & column semantics
    tableTopics.push(`${humanEntity} Master Record & Core Attributes`);
    if (colNames.some((c) => /(total|harga|price|modal|nominal|jumlah|amount|omset|revenue|biaya|tarif|billing|saldo|pembayaran|payment|paid)/i.test(c))) {
      tableTopics.push(`${humanEntity} Financial Accounting & Monetary Aggregation`);
    }
    if (colNames.some((c) => /(status|state|kondisi|is_active|aktif|valid|flag|verified|is_)/i.test(c))) {
      tableTopics.push(`${humanEntity} Verification State & Status Auditing`);
    }
    if (colNames.some((c) => /(provinsi|kabupaten|kota|kecamatan|kelurahan|wilayah|region|alamat|address|latitude|longitude|geo|postal)/i.test(c))) {
      tableTopics.push(`${humanEntity} Geographic Distribution & Regional Routing`);
    }
    if (colNames.some((c) => /(tanggal|date|created_at|updated_at|waktu|time|period|periode|tahun|bulan|sk_date)/i.test(c))) {
      tableTopics.push(`${humanEntity} Timeline Tracking & Historical Trends`);
    }
    if (colNames.some((c) => /(json|meta|payload|config|items|detail|extra|attributes|properties)/i.test(c))) {
      tableTopics.push(`${humanEntity} Semi-Structured & JSON Payload Extraction`);
    }
    if (colNames.some((c) => /(notaris|pejabat|petugas|officer|author|creator|user|pengguna|actor|admin)/i.test(c))) {
      tableTopics.push(`${humanEntity} Operational Authority & Actor Attribution`);
    }

    const uniqueTopics = Array.from(new Set(tableTopics));
    const tableRole = foreignKeys.length >= 2 ? "bridge_table" : (metrics.length > 0 ? "fact_table" : "dimension_table");
    const roleDesc = tableRole === "fact_table" ? "Tabel Fakta Transaksional" : (tableRole === "bridge_table" ? "Tabel Penjembatan Asosiatif" : "Tabel Master Dimensi");
    const context = `${roleDesc} untuk entitas '${humanEntity}' dalam skema basis data relasional. Merekam ${columns.length} atribut dengan ${relations.length} relasi foreign key antartabel.`;

    return {
      tableName,
      description: `External database table '${tableName}' with ${columns.length} columns, ${relations.length} relationships, and ${nestedDimensions.length} nested JSON attributes.`,
      context,
      topics: uniqueTopics,
      tableRole,
      decisionSpecs: ["db.table_role.v1", "db.join_candidates.v1"],
      entities,
      searchableColumns,
      dimensions,
      nestedDimensions,
      metrics,
      primaryKey,
      foreignKeys,
      relationships: relations,
      synonyms,
      clickhouseSchema,
      suggestedQueries,
      jsonStructures,
    };
  }

  private postgresPools = new Map<string, { sql: ReturnType<typeof postgres>; credentialHash: string; lastUsedAt: number; max: number }>();
  private mysqlPools = new Map<string, { pool: mysql.Pool; credentialHash: string; lastUsedAt: number }>();

  getPoolKey(config: DatabaseConnectionConfig): string {
    const parts = [
      config.type,
      config.host,
      String(config.port),
      config.database,
      config.username,
      String(Boolean(config.ssl)),
    ];
    return parts.join(":");
  }

  getCredentialHash(config: DatabaseConnectionConfig): string {
    return createHash("sha256").update(config.password || "").digest("hex");
  }

  private createSinglePostgresConnection(config: DatabaseConnectionConfig, timeout = 5) {
    const opts: any = {
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      ssl: config.ssl ? "require" : false,
      connect_timeout: timeout,
      max: 1,
    };
    if (config.password && config.password.length > 0) {
      opts.password = config.password;
    }
    return postgres(opts);
  }

  getPostgresSql(config: DatabaseConnectionConfig, max = 5, timeout = 5) {
    const key = this.getPoolKey(config);
    const currentHash = this.getCredentialHash(config);
    const cached = this.postgresPools.get(key);
    if (cached) {
      if (cached.credentialHash !== currentHash) {
        // Credential rotated - invalidate old pool
        cached.sql.end({ timeout: 1 }).catch(() => {});
        this.postgresPools.delete(key);
      } else {
        cached.lastUsedAt = Date.now();
        return cached.sql;
      }
    }

    const boundedMax = Math.min(Math.max(1, max), 10);
    const opts: any = {
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      ssl: config.ssl ? "require" : false,
      connect_timeout: timeout,
      max: boundedMax,
    };
    if (config.password && config.password.length > 0) {
      opts.password = config.password;
    }
    const sql = postgres(opts);
    this.postgresPools.set(key, { sql, credentialHash: currentHash, lastUsedAt: Date.now(), max: boundedMax });
    return sql;
  }

  getMysqlPool(config: DatabaseConnectionConfig, max = 5, timeout = 5000): mysql.Pool {
    const key = this.getPoolKey(config);
    const currentHash = this.getCredentialHash(config);
    const cached = this.mysqlPools.get(key);
    if (cached) {
      if (cached.credentialHash !== currentHash) {
        // Credential rotated - invalidate old pool
        cached.pool.end().catch(() => {});
        this.mysqlPools.delete(key);
      } else {
        cached.lastUsedAt = Date.now();
        return cached.pool;
      }
    }

    const boundedMax = Math.min(Math.max(1, max), 10);
    const opts = {
      ...this.getMysqlConfig(config, timeout),
      connectionLimit: boundedMax,
    };
    const pool = mysql.createPool(opts);
    this.mysqlPools.set(key, { pool, credentialHash: currentHash, lastUsedAt: Date.now() });
    return pool;
  }

  invalidatePool(config: DatabaseConnectionConfig): void {
    const key = this.getPoolKey(config);
    const pg = this.postgresPools.get(key);
    if (pg) {
      pg.sql.end({ timeout: 1 }).catch(() => {});
      this.postgresPools.delete(key);
    }
    const my = this.mysqlPools.get(key);
    if (my) {
      my.pool.end().catch(() => {});
      this.mysqlPools.delete(key);
    }
  }

  evictIdlePools(maxIdleMs = 300_000): void {
    const now = Date.now();
    for (const [key, entry] of this.postgresPools.entries()) {
      if (now - entry.lastUsedAt > maxIdleMs) {
        entry.sql.end({ timeout: 1 }).catch(() => {});
        this.postgresPools.delete(key);
      }
    }
    for (const [key, entry] of this.mysqlPools.entries()) {
      if (now - entry.lastUsedAt > maxIdleMs) {
        entry.pool.end().catch(() => {});
        this.mysqlPools.delete(key);
      }
    }
  }

  private async createMysqlConnection(config: DatabaseConnectionConfig, timeout = 8000): Promise<mysql.Connection> {
    try { return await mysql.createConnection(this.getMysqlConfig(config, timeout)); }
    catch (error) { throw new Error(databaseConnectionErrorMessage(error, config)); }
  }

  private getMysqlConfig(config: DatabaseConnectionConfig, timeout = 5000) {
    const opts: any = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: timeout,
      // Snapshot keyset cursors must preserve BIGINT values exactly across pages.
      supportBigNumbers: true,
      bigNumberStrings: true,
    };
    if (config.password && config.password.length > 0) {
      opts.password = config.password;
    }
    return opts;
  }
}

export function synthesizeDatabaseRelationsAndComponents(
  tables: InspectedTableResult[],
  rawRelations: TableRelation[],
): {
  enrichedRelations: TableRelation[];
  connectedComponents: Array<{ id: string; tableNames: string[] }>;
} {
  const identityOf = (table: InspectedTableResult) => `${table.schemaName || "public"}.${table.tableName}`;
  const tablesByName = new Map<string, InspectedTableResult[]>();
  const tablesByIdentity = new Map<string, InspectedTableResult>();
  for (const t of tables) {
    const identity = identityOf(t);
    tablesByIdentity.set(identity, t);
    const name = t.tableName.toLowerCase();
    const matches = tablesByName.get(name) || [];
    matches.push(t);
    tablesByName.set(name, matches);
  }

  const resolveEndpoint = (tableName: string, schemaName?: string) => {
    if (schemaName) return tablesByIdentity.get(`${schemaName}.${tableName}`);
    const matches = tablesByName.get(tableName.toLowerCase()) || [];
    return matches.length === 1 ? matches[0] : undefined;
  };

  // 1. Mark explicit foreign keys
  const enrichedRelations: TableRelation[] = rawRelations.map((r) => {
    const source = resolveEndpoint(r.sourceTable, r.sourceSchema);
    const target = resolveEndpoint(r.targetTable, r.targetSchema);
    return {
      ...r,
      sourceSchema: r.sourceSchema || source?.schemaName,
      targetSchema: r.targetSchema || target?.schemaName,
      provenance: "foreign_key" as const,
      confidence: 1.0,
    };
  });

  const existingRelKeys = new Set(
    enrichedRelations.map(
      (r) => `${(r.sourceSchema || "").toLowerCase()}.${r.sourceTable.toLowerCase()}.${r.sourceColumn.toLowerCase()}->${(r.targetSchema || "").toLowerCase()}.${r.targetTable.toLowerCase()}.${r.targetColumn.toLowerCase()}`,
    ),
  );

  // 2. Discover inferred candidate relations
  for (const sourceTable of tables) {
    for (const col of sourceTable.schemaDefinition) {
      if (col.isPrimaryKey || col.isForeignKey) continue;
      const colNameLower = col.name.toLowerCase();

      let targetCandidateName = "";
      if (colNameLower.endsWith("_id") && colNameLower.length > 3) {
        targetCandidateName = colNameLower.slice(0, -3);
      } else if (colNameLower.startsWith("id_") && colNameLower.length > 3) {
        targetCandidateName = colNameLower.slice(3);
      }

      if (!targetCandidateName) continue;

      const candidateNames = [targetCandidateName, `${targetCandidateName}s`, `${targetCandidateName}es`];
      const candidates = Array.from(new Map(candidateNames
        .flatMap((name) => tablesByName.get(name) || [])
        .filter((candidate) => identityOf(candidate) !== identityOf(sourceTable))
        .map((candidate) => [identityOf(candidate), candidate])).values());
      const sameSchemaCandidates = candidates.filter(
        (candidate) => (candidate.schemaName || "public") === (sourceTable.schemaName || "public"),
      );
      const targetTable = sameSchemaCandidates.length === 1
        ? sameSchemaCandidates[0]
        : sameSchemaCandidates.length === 0 && candidates.length === 1 ? candidates[0] : undefined;

      if (targetTable) {
        const targetPk =
          targetTable.schemaDefinition.find((c) => c.isPrimaryKey) ||
          targetTable.schemaDefinition.find((c) => c.name.toLowerCase() === "id");

        if (targetPk) {
          const relKey = `${(sourceTable.schemaName || "public").toLowerCase()}.${sourceTable.tableName.toLowerCase()}.${col.name.toLowerCase()}->${(targetTable.schemaName || "public").toLowerCase()}.${targetTable.tableName.toLowerCase()}.${targetPk.name.toLowerCase()}`;
          if (!existingRelKeys.has(relKey)) {
            existingRelKeys.add(relKey);
            const typeMatch = col.dataType === targetPk.dataType;
            const confidence = typeMatch ? 0.85 : 0.6;
            const provenance = typeMatch ? ("inferred" as const) : ("candidate" as const);

            enrichedRelations.push({
              sourceTable: sourceTable.tableName,
              sourceColumn: col.name,
              sourceSchema: sourceTable.schemaName,
              targetTable: targetTable.tableName,
              targetColumn: targetPk.name,
              targetSchema: targetTable.schemaName,
              relationType: "many_to_one",
              provenance,
              confidence,
              cardinalityEvidence: {
                sourceDistinctCount: col.distinctCount,
                targetDistinctCount: targetPk.distinctCount,
                sampleMatchRatio: typeMatch ? 0.85 : 0.5,
              },
            });
          }
        }
      }
    }
  }

  // 3. Partition into connected components using Disjoint-Set / Union-Find
  const parent = new Map<string, string>();
  const findRoot = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, findRoot(parent.get(x)!));
    return parent.get(x)!;
  };
  const unionNodes = (x: string, y: string) => {
    const rx = findRoot(x);
    const ry = findRoot(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const t of tables) {
    findRoot(identityOf(t));
  }
  for (const rel of enrichedRelations) {
    const source = resolveEndpoint(rel.sourceTable, rel.sourceSchema);
    const target = resolveEndpoint(rel.targetTable, rel.targetSchema);
    if (source && target) unionNodes(identityOf(source), identityOf(target));
  }

  const componentGroups = new Map<string, string[]>();
  for (const t of tables) {
    const identity = identityOf(t);
    const root = findRoot(identity);
    if (!componentGroups.has(root)) componentGroups.set(root, []);
    componentGroups.get(root)!.push(identity);
  }

  const connectedComponents: Array<{ id: string; tableNames: string[] }> = [];
  let compIdx = 1;
  const tableToCompId = new Map<string, string>();
  for (const [, memberTableNames] of componentGroups.entries()) {
    const compId = `cc_${compIdx++}`;
    connectedComponents.push({ id: compId, tableNames: memberTableNames });
    for (const tbl of memberTableNames) {
      tableToCompId.set(tbl, compId);
    }
  }

  // 4. Update semantic models of each table with connectedComponentId and enriched relationships
  for (const t of tables) {
    const identity = identityOf(t);
    const compId = tableToCompId.get(identity);
    if (compId) {
      t.semanticModel.connectedComponentId = compId;
    }
    const tableRels = enrichedRelations.filter(
      (r) => (r.sourceTable === t.tableName && (!r.sourceSchema || r.sourceSchema === t.schemaName || r.sourceSchema === "public" && !t.schemaName))
        || (r.targetTable === t.tableName && (!r.targetSchema || r.targetSchema === t.schemaName || r.targetSchema === "public" && !t.schemaName)),
    );
    t.semanticModel.relationships = tableRels;
  }

  return { enrichedRelations, connectedComponents };
}
