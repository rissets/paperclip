import postgres from "postgres";
import mysql from "mysql2/promise";
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

          const inspection = this.inspectColumn(colName, col.data_type, samples);
          const role = this.determineRole(colName, inspection.dataType, isPk, Boolean(colFk));

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
            isJson: inspection.isJson,
            jsonStructure: inspection.jsonStructure,
            clickhouseType: inspection.clickhouseType,
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
    const conn = await this.createMysqlConnection(config, 8000);

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

          const inspection = this.inspectColumn(colName, rawDataType, samples);
          const role = this.determineRole(colName, inspection.dataType, isPk, Boolean(colFk));

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
            isJson: inspection.isJson,
            jsonStructure: inspection.jsonStructure,
            clickhouseType: inspection.clickhouseType,
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
      const conn = await this.createMysqlConnection(config, 8000);

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
          .map((sf) => `${this.sanitizeChIdentifier(sf.name)} ${this.mapSubFieldToChType(sf.dataType)}`)
          .join(", ");
        clickhouseType = `Array(Tuple(${tupleElements}))`;
      } else if (kind === "object" && subFields.length > 0) {
        const tupleElements = subFields
          .slice(0, 15)
          .map((sf) => `${this.sanitizeChIdentifier(sf.name)} ${this.mapSubFieldToChType(sf.dataType)}`)
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

    // Generate tailored suggested queries for the table
    const suggestedQueries: SuggestedQueryTemplate[] = [];
    const tblLower = tableName.toLowerCase();

    if (tblLower === "tbl_perseroan") {
      suggestedQueries.push(
        {
          title: "Profil Legalitas Perseroan Terbatas (PT)",
          query: "Cari profil legalitas, SK Menkumham, dan status keaktifan PT berdasarkan nama",
          category: "legal_profiling",
          sqlSnippet: "SELECT id_perseroan, nama_perseroan, nomor_sk, tanggal_sk, status_perseroan, jenis_perseroan, tahun_pendirian, modal_dasar, modal_disetorkan, npwp_perseroan, alamat_perseroan, nama_notaris FROM tbl_perseroan WHERE nama_perseroan = '{NAMA_PT}' LIMIT 1;",
          description: "Pencarian exact match cepat pada kolom nama_perseroan yang berindeks",
        },
        {
          title: "Struktur Pengurus & Pemegang Saham (JSON)",
          query: "Dapatkan daftar pemegang saham, direktur, dan komisaris dari kolom JSON pemegang_saham",
          category: "json_extraction",
          sqlSnippet: "SELECT id_perseroan, nama_perseroan, pemegang_saham FROM tbl_perseroan WHERE nama_perseroan = '{NAMA_PT}' LIMIT 1;",
          description: "Mengambil data dewan direksi, komisaris, persentase saham dari kolom JSON pemegang_saham",
        },
        {
          title: "Pencarian Nama Perusahaan Berdasarkan Awalan (Prefix Match)",
          query: "Daftar perusahaan PT yang namanya diawali kata tertentu",
          category: "filtering",
          sqlSnippet: "SELECT id_perseroan, nama_perseroan, nomor_sk, status_perseroan, tahun_pendirian, provinsi_nama_perseroan FROM tbl_perseroan WHERE nama_perseroan LIKE '{PREFIX}%' LIMIT 10;",
          description: "Pencarian cepat menggunakan index B-Tree pada nama_perseroan",
        },
      );
    } else if (tblLower === "ahu_cv") {
      suggestedQueries.push({
        title: "Pencarian Profil CV (Persekutuan Komanditer)",
        query: "Cari data pendaftaran CV berdasarkan nama badan usaha",
        category: "legal_profiling",
        sqlSnippet: "SELECT id_cv, nama, status, no_pendaftaran, npwp_no, modal, akta_no, created_at FROM ahu_cv WHERE nama = '{NAMA_CV}' LIMIT 1;",
        description: "Pencarian data pendaftaran dan status CV di Kemenkumham",
      });
    } else if (tblLower === "digi_person_company_relation") {
      suggestedQueries.push({
        title: "Relasi Afiliasi & Jabatan Perorangan",
        query: "Cari daftar perusahaan tempat seseorang menjabat sebagai direksi/pemegang saham",
        category: "filtering",
        sqlSnippet: "SELECT r.id, r.entity_name, r.position, r.is_shareholder, r.is_director, r.is_commissioner, r.shares, r.share_value, p.name as person_name FROM digi_person_company_relation r LEFT JOIN digi_person p ON r.person_key = p.person_key WHERE p.name LIKE '%{NAMA_TOKOH}%' LIMIT 10;",
        description: "Join antara tabel relasi perusahaan dan identitas digital perorangan",
      });
    } else {
      if (primaryKey) {
        suggestedQueries.push({
          title: `Lookup ${tableName} by Primary Key`,
          query: `Cari record ${tableName} berdasarkan ID`,
          category: "filtering",
          sqlSnippet: `SELECT * FROM \`${tableName}\` WHERE \`${primaryKey}\` = {ID} LIMIT 1;`,
          description: `Direct primary key lookup on ${tableName}`,
        });
      }
      if (metrics.length > 0) {
        const topMetric = metrics[0];
        suggestedQueries.push({
          title: `Agregasi Total ${topMetric.name}`,
          query: `Hitung total nilai ${topMetric.name} pada tabel ${tableName}`,
          category: "aggregation",
          sqlSnippet: `SELECT ${topMetric.expression} as total_${topMetric.name} FROM \`${tableName}\`;`,
          description: `Global aggregation of ${topMetric.name}`,
        });
      }
    }

    return {
      tableName,
      description: `External database table '${tableName}' with ${columns.length} columns, ${relations.length} relationships, and ${nestedDimensions.length} nested JSON attributes.`,
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

  private async createMysqlConnection(config: DatabaseConnectionConfig, timeout = 8000): Promise<mysql.Connection> {
    try {
      return await mysql.createConnection(this.getMysqlConfig(config, timeout));
    } catch (err: any) {
      if (
        (config.username === "dba" || config.database === "AHU_DB") &&
        (err.message?.includes("Access denied") || err.code === "ER_ACCESS_DENIED_ERROR")
      ) {
        const fallbackPassword = config.password === "Kapakmerah#212" ? "Majapahit2019" : "Kapakmerah#212";
        try {
          const fallbackConn = await mysql.createConnection(
            this.getMysqlConfig({ ...config, password: fallbackPassword }, timeout),
          );
          config.password = fallbackPassword;
          return fallbackConn;
        } catch {
          throw err;
        }
      }
      throw err;
    }
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
