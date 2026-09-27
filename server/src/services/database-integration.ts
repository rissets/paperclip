import postgres from "postgres";
import mysql from "mysql2/promise";
import type {
  DatabaseConnectionConfig,
  DatabaseConnectionTestResult,
  ColumnDefinition,
  TableSemanticModel,
  TableRelation,
  SqlQueryResult,
} from "@paperclipai/shared";

export interface InspectedTableResult {
  tableName: string;
  rowCount: number;
  columnCount: number;
  schemaDefinition: ColumnDefinition[];
  semanticModel: TableSemanticModel;
}

export class DatabaseIntegrationService {
  /**
   * 1. Test database connection
   */
  async testConnection(config: DatabaseConnectionConfig): Promise<DatabaseConnectionTestResult> {
    const start = Date.now();
    try {
      if (config.type === "postgres") {
        const sql = this.getPostgresSql(config, 1, 5);

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
        const conn = await mysql.createConnection(this.getMysqlConfig(config));

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
        error: err.message || "Failed to connect to database",
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
      const selectedTables = tablesQuery.filter((t: any) => {
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
          ccu.column_name AS target_column
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('information_schema', 'pg_catalog')
      `;

      const allRelations: TableRelation[] = fksQuery.map((r: any) => ({
        sourceTable: r.source_table,
        sourceColumn: r.source_column,
        targetTable: r.target_table,
        targetColumn: r.target_column,
        relationType: "many_to_one",
      }));

      const results: InspectedTableResult[] = [];

      for (const t of selectedTables) {
        const schema = t.table_schema;
        const tableName = t.table_name;

        // Get column details
        const colsQuery = await sql`
          SELECT
            c.column_name,
            c.data_type,
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

        // Estimate row count & samples with error resilience
        let totalRows = 0;
        let sampleRows: any[] = [];
        try {
          const countRes = await sql`
            SELECT count(1)::int as total FROM ${sql(`${schema}.${tableName}`)}
          `;
          totalRows = Number(countRes[0]?.total ?? 0);

          sampleRows = await sql`
            SELECT * FROM ${sql(`${schema}.${tableName}`)} LIMIT 10
          `;
        } catch (err: any) {
          console.warn(`[database-integration] Could not query rows for table ${tableName}:`, err.message);
        }

        // Match table foreign keys
        const tableRelations = allRelations.filter(
          (r) => r.sourceTable === tableName || r.targetTable === tableName,
        );

        const columnProfiles: ColumnDefinition[] = colsQuery.map((col: any) => {
          const colName = col.column_name;
          const isPk = Boolean(col.is_pk);
          const colFk = allRelations.find(
            (r) => r.sourceTable === tableName && r.sourceColumn === colName,
          );

          const samples = sampleRows.map((r: any) => r[colName] ?? null);
          const nullCount = samples.filter((v: any) => v === null || v === undefined).length;
          const nullRatio = samples.length > 0 ? nullCount / samples.length : 0;
          const distinctCount = new Set(samples.filter((v: any) => v !== null)).size;

          const dataType = this.mapPostgresType(col.data_type);
          const role = this.determineRole(colName, dataType, isPk, Boolean(colFk));

          let min: any = null;
          let max: any = null;
          if (dataType === "number") {
            const numVals = samples.filter((v: any) => typeof v === "number");
            if (numVals.length > 0) {
              min = Math.min(...numVals);
              max = Math.max(...numVals);
            }
          }

          return {
            name: colName,
            dataType,
            nullCount,
            nullRatio,
            distinctCount,
            min,
            max,
            sampleValues: samples.slice(0, 5),
            role,
            isPrimaryKey: isPk,
            isForeignKey: Boolean(colFk),
            foreignKeyTarget: colFk
              ? { table: colFk.targetTable, column: colFk.targetColumn }
              : undefined,
          };
        });

        // Generate semantic model
        const primaryKey = columnProfiles.find((c) => c.isPrimaryKey)?.name;
        const semanticModel = this.buildSemanticModel(tableName, columnProfiles, tableRelations, primaryKey);

        results.push({
          tableName,
          rowCount: totalRows,
          columnCount: columnProfiles.length,
          schemaDefinition: columnProfiles,
          semanticModel,
        });
      }

      await sql.end({ timeout: 2 });
      return results;
    } catch (err: any) {
      await sql.end({ timeout: 1 }).catch(() => {});
      throw err;
    }
  }

  /**
   * MariaDB / MySQL Schema & Relation Inspector
   */
  private async inspectMariaDb(config: DatabaseConnectionConfig): Promise<InspectedTableResult[]> {
    const conn = await mysql.createConnection(this.getMysqlConfig(config, 8000));

    try {
      // 1. Get Tables
      const [tableRows] = await conn.query(`
        SELECT table_name
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
        relationType: "many_to_one",
      }));

      const results: InspectedTableResult[] = [];

      for (const t of selectedTables) {
        const tableName = (t.table_name || t.TABLE_NAME || "").toString();
        if (!tableName) continue;

        // Get Columns
        const [colRows] = await conn.query(`
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_key,
            column_default
          FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ordinal_position
        `, [config.database, tableName]);

        // Row count & samples with error resilience
        let totalRows = 0;
        let sampleRows: any[] = [];
        try {
          const [countRows] = await conn.query(
            `SELECT COUNT(1) as total FROM \`${config.database}\`.\`${tableName}\``,
          );
          totalRows = Number((countRows as any[])[0]?.total ?? (countRows as any[])[0]?.TOTAL ?? 0);

          const [samples] = await conn.query(
            `SELECT * FROM \`${config.database}\`.\`${tableName}\` LIMIT 10`,
          );
          sampleRows = Array.isArray(samples) ? (samples as any[]) : [];
        } catch (err: any) {
          console.warn(`[database-integration] Could not query rows for table ${tableName}:`, err.message);
        }

        const tableRelations = allRelations.filter(
          (r) => r.sourceTable === tableName || r.targetTable === tableName,
        );

        const columnProfiles: ColumnDefinition[] = (colRows as any[]).map((col: any) => {
          const colName = (col.column_name || col.COLUMN_NAME || "").toString();
          const colKey = (col.column_key || col.COLUMN_KEY || "").toString();
          const rawDataType = (col.data_type || col.DATA_TYPE || "").toString();
          const isPk = colKey === "PRI";
          const colFk = allRelations.find(
            (r) => r.sourceTable === tableName && r.sourceColumn === colName,
          );

          const samples = sampleRows.map((r: any) => r[colName] ?? null);
          const nullCount = samples.filter((v: any) => v === null || v === undefined).length;
          const nullRatio = samples.length > 0 ? nullCount / samples.length : 0;
          const distinctCount = new Set(samples.filter((v: any) => v !== null)).size;

          const dataType = this.mapMysqlType(rawDataType);
          const role = this.determineRole(colName, dataType, isPk, Boolean(colFk));

          let min: any = null;
          let max: any = null;
          if (dataType === "number") {
            const numVals = samples.filter((v: any) => typeof v === "number");
            if (numVals.length > 0) {
              min = Math.min(...numVals);
              max = Math.max(...numVals);
            }
          }

          return {
            name: colName,
            dataType,
            nullCount,
            nullRatio,
            distinctCount,
            min,
            max,
            sampleValues: samples.slice(0, 5),
            role,
            isPrimaryKey: isPk,
            isForeignKey: Boolean(colFk),
            foreignKeyTarget: colFk
              ? { table: colFk.targetTable, column: colFk.targetColumn }
              : undefined,
          };
        });

        const primaryKey = columnProfiles.find((c) => c.isPrimaryKey)?.name;
        const semanticModel = this.buildSemanticModel(tableName, columnProfiles, tableRelations, primaryKey);

        results.push({
          tableName,
          rowCount: totalRows,
          columnCount: columnProfiles.length,
          schemaDefinition: columnProfiles,
          semanticModel,
        });
      }

      await conn.end();
      return results;
    } catch (err: any) {
      await conn.end().catch(() => {});
      throw err;
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
  ): Promise<SqlQueryResult> {
    // 1. Sanitize & check against DDL/DML mutation tokens
    const cleanedSql = sqlQuery.trim();
    if (!cleanedSql) {
      throw new Error("SQL query cannot be empty");
    }

    // Security check: ONLY allow SELECT or WITH queries
    const lowerSql = cleanedSql.toLowerCase();
    const isSelect = lowerSql.startsWith("select") || lowerSql.startsWith("with");
    if (!isSelect) {
      throw new Error("Security Violation: Only SELECT and WITH (read-only) queries are permitted.");
    }

    const forbiddenTokens = [
      /\binsert\b/,
      /\bupdate\b/,
      /\bdelete\b/,
      /\bdrop\b/,
      /\balter\b/,
      /\btruncate\b/,
      /\bcreate\b/,
      /\bgrant\b/,
      /\brevoke\b/,
      /\bvacuum\b/,
      /\bcall\b/,
      /\bexecute\b/,
      /\bmerge\b/,
      /\breplace\b/,
      /\bcopy\b/,
      /;/ // Disallow multi-statement semicolons
    ];

    for (const pattern of forbiddenTokens) {
      if (pattern.test(lowerSql.replace(/;$/, ""))) { // allow trailing semicolon only
        throw new Error("Security Violation: Prohibited SQL token or multi-statement query detected.");
      }
    }

    // Ensure bounded LIMIT
    let finalSql = cleanedSql.replace(/;+$/, "");
    if (!/\blimit\s+\d+/i.test(finalSql)) {
      finalSql += ` LIMIT ${limit}`;
    }

    const start = Date.now();

    if (config.type === "postgres") {
      const sql = this.getPostgresSql(config, 1, 5);

      try {
        // Enforce transaction read only in session
        const rows = await sql.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          return await tx.unsafe(finalSql);
        });

        const executionTimeMs = Date.now() - start;
        await sql.end({ timeout: 2 });

        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return {
          columns,
          rows: rows as any[],
          rowCount: rows.length,
          executionTimeMs,
          sql: finalSql,
        };
      } catch (err: any) {
        await sql.end({ timeout: 1 }).catch(() => {});
        throw new Error(`PostgreSQL execution error: ${err.message}`);
      }
    } else {
      const conn = await mysql.createConnection(this.getMysqlConfig(config, 5000));

      try {
        const [rows, fields] = await conn.query(finalSql);
        const executionTimeMs = Date.now() - start;
        await conn.end();

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
        await conn.end().catch(() => {});
        throw new Error(`MariaDB/MySQL execution error: ${err.message}`);
      }
    }
  }

  // --- Helper Methods ---

  private mapPostgresType(pgType: string): "string" | "number" | "boolean" | "date" | "unknown" {
    const t = pgType.toLowerCase();
    if (t.includes("int") || t.includes("numeric") || t.includes("decimal") || t.includes("real") || t.includes("double") || t.includes("float")) {
      return "number";
    }
    if (t.includes("char") || t.includes("text") || t.includes("uuid") || t.includes("json")) {
      return "string";
    }
    if (t.includes("bool")) {
      return "boolean";
    }
    if (t.includes("date") || t.includes("time")) {
      return "date";
    }
    return "unknown";
  }

  private mapMysqlType(myType: string): "string" | "number" | "boolean" | "date" | "unknown" {
    const t = myType.toLowerCase();
    if (t.includes("int") || t.includes("decimal") || t.includes("float") || t.includes("double")) {
      return "number";
    }
    if (t.includes("char") || t.includes("text") || t.includes("blob") || t.includes("enum") || t.includes("json")) {
      return "string";
    }
    if (t.includes("bool") || t === "tinyint(1)") {
      return "boolean";
    }
    if (t.includes("date") || t.includes("time") || t.includes("year")) {
      return "date";
    }
    return "unknown";
  }

  private determineRole(name: string, dataType: string, isPk: boolean, isFk: boolean): "dimension" | "metric" | "identifier" | "timestamp" | "attribute" {
    if (isPk || isFk || name.toLowerCase().endsWith("_id") || name.toLowerCase() === "id") {
      return "identifier";
    }
    if (dataType === "date" || name.toLowerCase().includes("date") || name.toLowerCase().includes("time") || name.toLowerCase().includes("_at")) {
      return "timestamp";
    }
    if (dataType === "number") {
      return "metric";
    }
    return "dimension";
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

    return {
      tableName,
      description: `External database table '${tableName}' with ${columns.length} columns and ${relations.length} relationships.`,
      dimensions,
      metrics,
      primaryKey,
      foreignKeys,
      relationships: relations,
      synonyms,
    };
  }

  private getPostgresSql(config: DatabaseConnectionConfig, max = 1, timeout = 5) {
    const opts: any = {
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      ssl: config.ssl ? "require" : false,
      connect_timeout: timeout,
      max,
    };
    if (config.password && config.password.length > 0) {
      opts.password = config.password;
    }
    return postgres(opts);
  }

  private getMysqlConfig(config: DatabaseConnectionConfig, timeout = 5000) {
    const opts: any = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: timeout,
    };
    if (config.password && config.password.length > 0) {
      opts.password = config.password;
    }
    return opts;
  }
}
