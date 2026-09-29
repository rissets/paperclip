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
  async execute(sqlQuery: string, dbName?: string): Promise<void> {
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
      signal: AbortSignal.timeout(30000),
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
    await this.execute(ddl, dbName);

    let insertedCount = 0;
    if (rows && rows.length > 0) {
      const res = await this.insertJsonEachRow(tableName, rows, dbName);
      insertedCount = res.insertedCount;
    }

    return { created: true, insertedCount, dbName };
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
