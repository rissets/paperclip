import { createHash, randomUUID } from "node:crypto";

export interface ClickhouseConfig {
  url?: string;
  user?: string;
  password?: string;
  database?: string;
}

export interface ClickhouseQueryResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
  rowCount: number;
  executionTimeMs: number;
  meta: Array<{ name: string; type: string }>;
  statistics?: {
    elapsed: number;
    rows_read: number;
    bytes_read: number;
  };
}

export interface ClickhouseQueryParameter {
  type: "String" | "Float64" | "Int64" | "UInt8";
  value: string | number;
}

export interface ClickhouseStreamResumeOptions {
  jobId: string;
  signal?: AbortSignal;
  /** Start after the last batch whose ClickHouse receipt was persisted by the job ledger. */
  startBatchIndex?: number;
  startInsertedCount?: number;
  getRowCheckpoint?: (row: Record<string, unknown>) => unknown;
  onBatchCommitted?: (insertedRows: number, nextBatchIndex: number, checkpoint: unknown) => Promise<void>;
  runFencedOperation?: (operation: () => Promise<void>) => Promise<void>;
  keepBatchTablesOnFailure?: (error: unknown) => boolean;
  beforePublish?: () => Promise<void>;
}

const syncQueues = new Map<string, Promise<void>>();
const DEFAULT_CLICKHOUSE_INSERT_MAX_BATCH_ROWS = 50_000;
const MIN_CLICKHOUSE_INSERT_MAX_BATCH_ROWS = 1_000;
const MAX_CLICKHOUSE_INSERT_MAX_BATCH_ROWS = 100_000;
const CLICKHOUSE_INSERT_MAX_BATCH_BYTES = 4 * 1024 * 1024;
const CLICKHOUSE_MERGE_MAX_BATCH_TABLES = 100;

function clickhouseInsertMaxBatchRows(): number {
  const raw = process.env.DATASOURCE_CLICKHOUSE_INSERT_MAX_BATCH_ROWS?.trim();
  if (!raw) return DEFAULT_CLICKHOUSE_INSERT_MAX_BATCH_ROWS;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_CLICKHOUSE_INSERT_MAX_BATCH_ROWS;
  }
  return Math.max(
    MIN_CLICKHOUSE_INSERT_MAX_BATCH_ROWS,
    Math.min(MAX_CLICKHOUSE_INSERT_MAX_BATCH_ROWS, configured),
  );
}

function boundedQuerySetting(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function clickhouseSourceTableName(tableId: string, displayName: string): string {
  const identity = createHash("sha256").update(tableId).digest("hex").slice(0, 24);
  const readable = displayName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().slice(0, 24) || "table";
  return `ds_${identity}_${readable}`;
}

/** Rewrite assigned logical/legacy table aliases to their published ClickHouse names. */
export function rewriteClickhouseTableReferences(
  sql: string,
  physicalNameByAlias: ReadonlyMap<string, string>,
  cteNames: ReadonlySet<string> = new Set(),
): string {
  type Identifier = { start: number; end: number; value: string };
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const lowerCtes = new Set([...cteNames].map((name) => name.toLowerCase()));

  const skipTrivia = (start: number): number => {
    let index = start;
    while (index < sql.length) {
      if (/\s/.test(sql[index]!)) {
        index++;
      } else if (sql[index] === "-" && sql[index + 1] === "-") {
        index += 2;
        while (index < sql.length && sql[index] !== "\n") index++;
      } else if (sql[index] === "/" && sql[index + 1] === "*") {
        index += 2;
        while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
        index = Math.min(sql.length, index + 2);
      } else {
        break;
      }
    }
    return index;
  };

  const readIdentifier = (start: number): Identifier | null => {
    const quote = sql[start];
    if (quote === "`" || quote === '"') {
      let value = "";
      let index = start + 1;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          value += quote;
          index += 2;
        } else if (sql[index] === quote) {
          return { start, end: index + 1, value };
        } else {
          value += sql[index];
          index++;
        }
      }
      return null;
    }
    const match = sql.slice(start).match(/^[A-Za-z0-9_]+/);
    return match ? { start, end: start + match[0].length, value: match[0] } : null;
  };

  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index = Math.min(sql.length, index + 2);
      continue;
    }
    if (sql[index] === "'") {
      index++;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
        else if (sql[index] === "'") { index++; break; }
        else if (sql[index] === "\\") index += 2;
        else index++;
      }
      continue;
    }

    const keywordMatch = sql.slice(index).match(/^(from|join)\b/i);
    if (keywordMatch && (index === 0 || !/[A-Za-z0-9_]/.test(sql[index - 1]!))) {
      const firstStart = skipTrivia(index + keywordMatch[0].length);
      const first = readIdentifier(firstStart);
      if (first) {
        let table = first;
        const dot = skipTrivia(first.end);
        if (sql[dot] === ".") {
          const qualified = readIdentifier(skipTrivia(dot + 1));
          if (qualified) table = qualified;
        }
        const normalized = table.value.toLowerCase();
        const physicalName = physicalNameByAlias.get(normalized);
        if (physicalName && !lowerCtes.has(normalized) && normalized !== physicalName.toLowerCase()) {
          replacements.push({ start: table.start, end: table.end, value: `\`${physicalName.replaceAll("`", "``")}\`` });
        }
        index = table.end;
        continue;
      }
    }

    if (sql[index] === "`" || sql[index] === '"') {
      const identifier = readIdentifier(index);
      index = identifier?.end ?? index + 1;
    } else {
      index++;
    }
  }

  let rewritten = sql;
  for (const replacement of replacements.reverse()) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
  }
  return rewritten;
}

export function rewriteClickhouseCreateTableName(ddl: string, tableName: string): string {
  const sanitized = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  if (!sanitized) throw new Error("Invalid ClickHouse table name");
  return ddl.replace(
    /(\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:`[^`]+`|"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)/i,
    `$1\`${sanitized}\``,
  );
}

export class ClickhouseService {
  private url: string;
  private user: string;
  private password: string;
  private defaultDb: string;

  constructor(config?: ClickhouseConfig) {
    this.url = (config?.url || process.env.CLICKHOUSE_URL || "http://localhost:8123").replace(/\/+$/, "");
    this.user = config?.user || process.env.CLICKHOUSE_USER || "default";
    this.password = config?.password || process.env.CLICKHOUSE_PASSWORD || "";
    this.defaultDb = config?.database || process.env.CLICKHOUSE_DATABASE || "paperclip";
  }

  /**
   * Derive isolated company database name to enforce company boundaries (Core Engineering Rule 1)
   */
  getCompanyDatabase(companyId: string): string {
    const cleanId = companyId.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    return `paperclip_${cleanId}`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.user) {
      headers["X-ClickHouse-User"] = this.user;
    }
    if (this.password) {
      headers["X-ClickHouse-Key"] = this.password;
    }
    return headers;
  }

  /**
   * Check if ClickHouse server is healthy and responding
   */
  async isHealthy(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${this.url}/?query=SELECT%20version()`, {
        method: "GET",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `ClickHouse returned ${res.status}: ${txt}` };
      }

      const version = (await res.text()).trim();
      return { ok: true, version };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to connect to ClickHouse" };
    }
  }

  /**
   * Ensure isolated company database exists
   */
  async ensureCompanyDatabase(companyId: string): Promise<string> {
    const dbName = this.getCompanyDatabase(companyId);
    await this.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    return dbName;
  }

  /**
   * Execute an arbitrary DDL or modifying SQL command in ClickHouse
   */
  async execute(sqlQuery: string, dbName?: string, signal?: AbortSignal): Promise<void> {
    const targetDb = dbName || this.defaultDb;
    const url = new URL(this.url);
    if (targetDb) {
      url.searchParams.set("database", targetDb);
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: sqlQuery.trim(),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(30000), signal]) : AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ClickHouse execution error (${res.status}): ${errText.trim()}`);
    }
  }

  /**
   * Run a read-only analytical query in ClickHouse and return parsed results
   */
  async query<T = Record<string, unknown>>(
    sqlQuery: string,
    dbName?: string,
    parameters: Record<string, ClickhouseQueryParameter> = {},
  ): Promise<ClickhouseQueryResult<T>> {
    const targetDb = dbName || this.defaultDb;
    let formattedSql = sqlQuery.trim();

    // Prevent unsafe multi-statement mutations via analytical query endpoint
    if (/^\s*(drop|alter|truncate|delete|insert|update|create)\b/i.test(formattedSql)) {
      throw new Error("Direct modifying queries are prohibited in analytical query mode. Use syncTable or execute.");
    }

    if (!/\bFORMAT\s+[A-Za-z0-9_]+$/i.test(formattedSql)) {
      // Remove trailing semicolon if present before adding FORMAT JSON
      formattedSql = formattedSql.replace(/;\s*$/, "") + " FORMAT JSON";
    }

    const startTime = Date.now();
    const url = new URL(this.url);
    if (targetDb) {
      url.searchParams.set("database", targetDb);
    }
    // Put hard read budgets on every analytical request. LIMIT bounds result
    // rows, while these server-side settings also stop unbounded scans and
    // memory use when the source has no selective index.
    url.searchParams.set("max_execution_time", String(boundedQuerySetting("DATASOURCE_CLICKHOUSE_QUERY_MAX_EXECUTION_SECONDS", 60, 300)));
    url.searchParams.set("max_memory_usage", String(boundedQuerySetting("DATASOURCE_CLICKHOUSE_QUERY_MAX_MEMORY_BYTES", 1_073_741_824, 8_589_934_592)));
    url.searchParams.set("max_rows_to_read", String(boundedQuerySetting("DATASOURCE_CLICKHOUSE_QUERY_MAX_ROWS", 10_000_000, 1_000_000_000)));
    url.searchParams.set("max_bytes_to_read", String(boundedQuerySetting("DATASOURCE_CLICKHOUSE_QUERY_MAX_BYTES", 1_073_741_824, 8_589_934_592)));
    url.searchParams.set("max_result_bytes", String(boundedQuerySetting("DATASOURCE_CLICKHOUSE_QUERY_MAX_RESULT_BYTES", 67_108_864, 536_870_912)));
    url.searchParams.set("read_overflow_mode", "throw");
    url.searchParams.set("result_overflow_mode", "throw");
    for (const [name, parameter] of Object.entries(parameters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid ClickHouse query parameter name: ${name}`);
      }
      url.searchParams.set(`param_${name}`, String(parameter.value));
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: formattedSql,
      signal: AbortSignal.timeout(60000),
    });

    const executionTimeMs = Date.now() - startTime;

    if (!res.ok) {
      const errText = await res.text();
      // Auto-heal ClickHouse Date/DateTime type mismatch on String columns:
      // e.g. "Code: 43. DB::Exception: Illegal type String of argument of function toHour. Should be Date, Date32, DateTime or DateTime64"
      const typeMismatchMatch = errText.match(/Illegal type String of argument of function (\w+)\. Should be Date/i);
      if (typeMismatchMatch) {
        const dateFuncs = "toHour|toDayOfWeek|toDayOfMonth|toDayOfYear|toMonth|toYear|toQuarter|toMinute|toSecond|toStartOfHour|toStartOfDay|toStartOfWeek|toStartOfMonth|toStartOfQuarter|toStartOfYear|toStartOfInterval|toDate|toDateTime|toUnixTimestamp";
        const replaceRegex = new RegExp(`\\b(${dateFuncs})\\s*\\(\\s*([a-zA-Z0-9_]+)\\s*\\)`, "gi");
        const rewrittenSql = formattedSql.replace(replaceRegex, (match, fn, col) => {
          if (/^(parseDateTime|toDateTime|toDate|now|today|yesterday)/i.test(col)) return match;
          return `${fn}(parseDateTimeBestEffortOrNull(${col}))`;
        });

        if (rewrittenSql !== formattedSql) {
          const retryRes = await fetch(url.toString(), {
            method: "POST",
            headers: {
              ...this.getHeaders(),
              "Content-Type": "text/plain; charset=utf-8",
            },
            body: rewrittenSql,
            signal: AbortSignal.timeout(60000),
          });

          if (retryRes.ok) {
            const json = await retryRes.json();
            const meta = (json.meta || []) as Array<{ name: string; type: string }>;
            const columns = meta.map((m) => m.name);
            const rows = (json.data || []) as T[];
            const rowCount = typeof json.rows === "number" ? json.rows : rows.length;

            return {
              columns,
              rows,
              rowCount,
              executionTimeMs: Date.now() - startTime,
              meta,
              statistics: json.statistics,
            };
          }
        }
      }
      throw new Error(`ClickHouse query error (${res.status}): ${errText.trim()}`);
    }

    const json = await res.json();
    const meta = (json.meta || []) as Array<{ name: string; type: string }>;
    const columns = meta.map((m) => m.name);
    const rows = (json.data || []) as T[];
    const rowCount = typeof json.rows === "number" ? json.rows : rows.length;

    return {
      columns,
      rows,
      rowCount,
      executionTimeMs,
      meta,
      statistics: json.statistics,
    };
  }

  /**
   * Batch insert rows into a ClickHouse table using JSONEachRow
   */
  async insertJsonEachRow(
    tableName: string,
    rows: Record<string, unknown>[],
    dbName?: string,
  ): Promise<{ insertedCount: number }> {
    if (rows.length === 0) return { insertedCount: 0 };

    const targetDb = dbName || this.defaultDb;
    const sanitizedTable = tableName.replace(/[`"]/g, "");
    const batchSize = 1000;
    let totalInserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const ndjson = batch.map((r) => JSON.stringify(r)).join("\n");

      const url = new URL(this.url);
      if (targetDb) {
        url.searchParams.set("database", targetDb);
      }
      url.searchParams.set("query", `INSERT INTO \`${sanitizedTable}\` FORMAT JSONEachRow`);

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          ...this.getHeaders(),
          "Content-Type": "application/x-ndjson",
        },
        body: ndjson,
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`ClickHouse insert error (${res.status}) on table '${sanitizedTable}': ${errText.trim()}`);
      }

      totalInserted += batch.length;
    }

    return { insertedCount: totalInserted };
  }

  /** Insert an async row stream using bounded row and byte batches. */
  async insertJsonEachRowStream(
    tableName: string,
    rows: AsyncIterable<Record<string, unknown>>,
    dbName?: string,
    onProgress?: (insertedRows: number) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ insertedCount: number }> {
    const targetDb = dbName || this.defaultDb;
    const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    if (!sanitizedTable) throw new Error("Invalid ClickHouse table name");
    const maxBatchRows = clickhouseInsertMaxBatchRows();
    const maxBatchBytes = CLICKHOUSE_INSERT_MAX_BATCH_BYTES;
    let batch: string[] = [];
    let batchBytes = 0;
    let insertedCount = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      if (signal?.aborted) throw signal.reason || new Error("ClickHouse stream was cancelled");
      const url = new URL(this.url);
      if (targetDb) url.searchParams.set("database", targetDb);
      url.searchParams.set("query", `INSERT INTO \`${sanitizedTable}\` FORMAT JSONEachRow`);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { ...this.getHeaders(), "Content-Type": "application/x-ndjson" },
        body: batch.join("\n"),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(60_000), signal]) : AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 2_000);
        throw new Error(`ClickHouse insert error (${response.status}) on table '${sanitizedTable}': ${errorText}`);
      }
      insertedCount += batch.length;
      batch = [];
      batchBytes = 0;
      await onProgress?.(insertedCount);
    };

    for await (const row of rows) {
      if (signal?.aborted) throw signal.reason || new Error("ClickHouse stream was cancelled");
      const encoded = JSON.stringify(row);
      const rowBytes = Buffer.byteLength(encoded) + 1;
      if (rowBytes > maxBatchBytes) throw new Error("ClickHouse row exceeds the 4 MiB ingestion row limit");
      if (batch.length >= maxBatchRows || (batch.length > 0 && batchBytes + rowBytes > maxBatchBytes)) {
        await flush();
      }
      batch.push(encoded);
      batchBytes += rowBytes;
    }
    await flush();
    return { insertedCount };
  }

  /**
   * Create table if not exists from DDL, and optionally insert rows
   */
  async syncTable(
    tableName: string,
    ddl: string,
    rows?: Record<string, unknown>[],
    companyId?: string,
  ): Promise<{ created: boolean; insertedCount: number; dbName: string }> {
    const dbName = companyId ? await this.ensureCompanyDatabase(companyId) : this.defaultDb;
    const finalName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const finalDdl = rewriteClickhouseCreateTableName(ddl, finalName);
    if (rows === undefined) {
      await this.execute(finalDdl, dbName);
      return { created: true, insertedCount: 0, dbName };
    }

    const lockKey = `${dbName}.${finalName}`;
    const previous = syncQueues.get(lockKey) || Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    syncQueues.set(lockKey, tail);
    await previous;

    const stageName = `${finalName}__s_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const stageDdl = rewriteClickhouseCreateTableName(ddl, stageName);
    const quote = (value: string) => `\`${value.replaceAll("`", "``")}\``;
    try {
      await this.execute(stageDdl, dbName);
      const insertedCount = rows.length > 0
        ? (await this.insertJsonEachRow(stageName, rows, dbName)).insertedCount
        : 0;
      const existingTables = await this.listTables(companyId);
      if (existingTables.includes(finalName)) {
        await this.execute(`EXCHANGE TABLES ${quote(dbName)}.${quote(finalName)} AND ${quote(dbName)}.${quote(stageName)}`, dbName);
      } else {
        await this.execute(`RENAME TABLE ${quote(dbName)}.${quote(stageName)} TO ${quote(dbName)}.${quote(finalName)}`, dbName);
      }
      try {
        await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName);
      } catch {
        // The old published table is now under the staging name. It is safe to
        // leave for a later ClickHouse orphan cleanup if DROP is unavailable.
      }
      return { created: true, insertedCount, dbName };
    } catch (error) {
      try {
        await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName);
      } catch {
        // Preserve the original load error; stale staging tables are observable.
      }
      throw error;
    } finally {
      release();
      if (syncQueues.get(lockKey) === tail) syncQueues.delete(lockKey);
    }
  }

  /** Stage, stream, then atomically exchange a large CSV table into its stable ClickHouse name. */
  async syncTableFromStream(
    tableName: string,
    ddl: string,
    rows: AsyncIterable<Record<string, unknown>>,
    companyId: string,
    onProgress?: (insertedRows: number) => void | Promise<void>,
    publicationFence?: (insertedRows: number, publish: () => Promise<void>) => Promise<void>,
    resumeOptions?: ClickhouseStreamResumeOptions,
    streamOptions?: { stagingTableName?: string; signal?: AbortSignal },
  ): Promise<{ created: boolean; insertedCount: number; dbName: string }> {
    if (resumeOptions) {
      return this.syncTableFromStreamResumable(
        tableName,
        ddl,
        rows,
        companyId,
        onProgress,
        publicationFence,
        resumeOptions,
      );
    }
    const dbName = await this.ensureCompanyDatabase(companyId);
    const finalName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const finalDdl = rewriteClickhouseCreateTableName(ddl, finalName);
    const lockKey = `${dbName}.${finalName}`;
    const previous = syncQueues.get(lockKey) || Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    syncQueues.set(lockKey, tail);
    await previous;

    const stagingTableName = streamOptions?.stagingTableName;
    const stageName = stagingTableName
      ? stagingTableName.replace(/[^a-zA-Z0-9_]/g, "")
      : `${finalName}__s_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!stageName || stageName === finalName
      || (stagingTableName && (stageName !== stagingTableName || !stageName.startsWith(`${finalName}__s_`)))) {
      release();
      if (syncQueues.get(lockKey) === tail) syncQueues.delete(lockKey);
      throw new Error("ClickHouse streaming stage table name is invalid");
    }
    const quote = (value: string) => `\`${value.replaceAll("`", "``")}\``;
    const stageDdl = rewriteClickhouseCreateTableName(finalDdl, stageName);
    try {
      await this.execute(stageDdl, dbName, streamOptions?.signal);
      const { insertedCount } = await this.insertJsonEachRowStream(stageName, rows, dbName, onProgress, streamOptions?.signal);
      const publish = async () => {
        const existingTables = await this.listTables(companyId);
        if (existingTables.includes(finalName)) {
          await this.execute(`EXCHANGE TABLES ${quote(dbName)}.${quote(finalName)} AND ${quote(dbName)}.${quote(stageName)}`, dbName);
        } else {
          await this.execute(`RENAME TABLE ${quote(dbName)}.${quote(stageName)} TO ${quote(dbName)}.${quote(finalName)}`, dbName);
        }
        await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName).catch(() => {});
      };
      if (publicationFence) await publicationFence(insertedCount, publish);
      else await publish();
      return { created: true, insertedCount, dbName };
    } catch (error) {
      await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName).catch(() => {});
      throw error;
    } finally {
      release();
      if (syncQueues.get(lockKey) === tail) syncQueues.delete(lockKey);
    }
  }

  private async countTableRows(tableName: string, dbName: string): Promise<number> {
    const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const result = await this.query<{ row_count: number | string }>(`SELECT count() AS row_count FROM \`${sanitizedTable}\``, dbName);
    const count = Number(result.rows[0]?.row_count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`ClickHouse returned an invalid row count for '${sanitizedTable}'`);
    return count;
  }

  private async insertJsonEachRowPayload(
    tableName: string,
    ndjson: string,
    dbName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    const url = new URL(this.url);
    url.searchParams.set("database", dbName);
    url.searchParams.set("query", `INSERT INTO \`${sanitizedTable}\` FORMAT JSONEachRow`);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...this.getHeaders(), "Content-Type": "application/x-ndjson" },
      body: ndjson,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(60_000), signal]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 2_000);
      throw new Error(`ClickHouse insert error (${response.status}) on table '${sanitizedTable}': ${errorText}`);
    }
  }

  /** Resume acknowledged ClickHouse insert batches after a worker retry. Each durable job gets an isolated namespace. */
  private async syncTableFromStreamResumable(
    tableName: string,
    ddl: string,
    rows: AsyncIterable<Record<string, unknown>>,
    companyId: string,
    onProgress: ((insertedRows: number) => void | Promise<void>) | undefined,
    publicationFence: ((insertedRows: number, publish: () => Promise<void>) => Promise<void>) | undefined,
    resume: ClickhouseStreamResumeOptions,
  ): Promise<{ created: boolean; insertedCount: number; dbName: string }> {
    const dbName = await this.ensureCompanyDatabase(companyId);
    const finalName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
    if (!finalName || !resume.jobId) throw new Error("Resumable ClickHouse ingestion requires a valid table and durable job id");
    const lockKey = `${dbName}.${finalName}`;
    const previous = syncQueues.get(lockKey) || Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    syncQueues.set(lockKey, tail);
    await previous;

    const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, "");
    const quote = (value: string) => `\`${safeName(value)}\``;
    const jobHash = createHash("sha256").update(resume.jobId).digest("hex").slice(0, 12);
    const tableHash = createHash("sha256").update(finalName).digest("hex").slice(0, 8);
    const batchPrefix = `${finalName.slice(0, 26)}__b_${jobHash}_${tableHash}_`;
    const tableNameSet = new Set(await this.listTables(companyId));
    const batchNames = new Set(Array.from(tableNameSet).filter((name) => name.startsWith(batchPrefix)));
    const stageName = `${finalName}__s_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const stageDdl = rewriteClickhouseCreateTableName(ddl, stageName);
    const batchRowsLimit = clickhouseInsertMaxBatchRows();
    const batchBytesLimit = CLICKHOUSE_INSERT_MAX_BATCH_BYTES;
    const allBatchNames = () => Array.from(batchNames);
    let insertedCount = resume.startInsertedCount ?? 0;
    let batchIndex = resume.startBatchIndex ?? 0;
    if (!Number.isSafeInteger(insertedCount) || insertedCount < 0
      || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
      throw new Error("Resumable ClickHouse ingestion checkpoint is invalid");
    }
    let batch: string[] = [];
    let batchBytes = 0;
    let batchCheckpoint: unknown;

    const runFenced = (operation: () => Promise<void>) => resume.runFencedOperation
      ? resume.runFencedOperation(operation)
      : operation();

    const flush = async () => {
      if (batch.length === 0) return;
      if (resume.signal?.aborted) throw new Error("Resumable ClickHouse ingestion was cancelled");
      const batchTable = `${batchPrefix}${batchIndex.toString(36)}`;
      const expectedRows = batch.length;
      const payload = batch.join("\n");
      // Record the deterministic table name before the network write. ClickHouse
      // may accept an insert even when the client sees a timeout/disconnect.
      batchNames.add(batchTable);
      const operation = async () => {
        const exists = tableNameSet.has(batchTable);
        const existingRows = exists ? await this.countTableRows(batchTable, dbName) : 0;
        if (existingRows !== expectedRows) {
          if (exists) await this.execute(`DROP TABLE IF EXISTS ${quote(batchTable)}`, dbName);
          await this.execute(rewriteClickhouseCreateTableName(ddl, batchTable), dbName);
          await this.insertJsonEachRowPayload(batchTable, payload, dbName, resume.signal);
        }
      };
      await runFenced(operation);
      tableNameSet.add(batchTable);
      batchNames.add(batchTable);
      batchIndex += 1;
      insertedCount += expectedRows;
      await resume.onBatchCommitted?.(insertedCount, batchIndex, batchCheckpoint);
      batch = [];
      batchBytes = 0;
      batchCheckpoint = undefined;
      await onProgress?.(insertedCount);
    };

    try {
      await this.execute(stageDdl, dbName, resume.signal);
      for await (const row of rows) {
        if (resume.signal?.aborted) throw new Error("Resumable ClickHouse ingestion was cancelled");
        const encoded = JSON.stringify(row);
        const rowBytes = Buffer.byteLength(encoded) + 1;
        if (rowBytes > batchBytesLimit) throw new Error("ClickHouse row exceeds the 4 MiB ingestion row limit");
        if (batch.length >= batchRowsLimit || (batch.length > 0 && batchBytes + rowBytes > batchBytesLimit)) {
          await flush();
        }
        batch.push(encoded);
        batchBytes += rowBytes;
        batchCheckpoint = resume.getRowCheckpoint?.(row);
      }
      await flush();

      const batchNamesForPublish = Array.from({ length: batchIndex }, (_, index) => `${batchPrefix}${index.toString(36)}`);
      for (let offset = 0; offset < batchNamesForPublish.length; offset += CLICKHOUSE_MERGE_MAX_BATCH_TABLES) {
        const mergeBatch = batchNamesForPublish.slice(offset, offset + CLICKHOUSE_MERGE_MAX_BATCH_TABLES);
        const union = mergeBatch.map((name) => `SELECT * FROM ${quote(name)}`).join(" UNION ALL ");
        await runFenced(() => this.execute(`INSERT INTO ${quote(stageName)} ${union}`, dbName, resume.signal));
      }

      await resume.beforePublish?.();
      const publish = async () => {
        const existingTables = await this.listTables(companyId);
        if (existingTables.includes(finalName)) {
          await this.execute(`EXCHANGE TABLES ${quote(dbName)}.${quote(finalName)} AND ${quote(dbName)}.${quote(stageName)}`, dbName);
        } else {
          await this.execute(`RENAME TABLE ${quote(dbName)}.${quote(stageName)} TO ${quote(dbName)}.${quote(finalName)}`, dbName);
        }
        await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName).catch(() => {});
      };
      if (publicationFence) await publicationFence(insertedCount, publish);
      else await publish();
      for (const batchName of allBatchNames()) {
        await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(batchName)}`, dbName).catch(() => {});
      }
      return { created: true, insertedCount, dbName };
    } catch (error) {
      await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(stageName)}`, dbName).catch(() => {});
      const keepBatches = resume.keepBatchTablesOnFailure?.(error) ?? true;
      if (!keepBatches) {
        for (const batchName of allBatchNames()) {
          await this.execute(`DROP TABLE IF EXISTS ${quote(dbName)}.${quote(batchName)}`, dbName).catch(() => {});
        }
      }
      throw error;
    } finally {
      release();
      if (syncQueues.get(lockKey) === tail) syncQueues.delete(lockKey);
    }
  }

  /**
   * List all tables in a company database or default database
   */
  async listTables(companyId?: string): Promise<string[]> {
    const dbName = companyId ? this.getCompanyDatabase(companyId) : this.defaultDb;
    try {
      const result = await this.query<{ name: string }>("SHOW TABLES", dbName);
      return result.rows.map((r) => r.name);
    } catch (err: any) {
      // If database does not exist yet, return empty array
      if (err.message?.includes("Database") && err.message?.includes("doesn't exist")) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Describe schema of a table in ClickHouse
   */
  async describeTable(
    tableName: string,
    companyId?: string,
  ): Promise<Array<{ name: string; type: string; comment: string }>> {
    const dbName = companyId ? this.getCompanyDatabase(companyId) : this.defaultDb;
    const sanitizedTable = tableName.replace(/[`"]/g, "");
    const result = await this.query<{ name: string; type: string; comment: string }>(
      `DESCRIBE TABLE \`${sanitizedTable}\``,
      dbName,
    );
    return result.rows;
  }
}
