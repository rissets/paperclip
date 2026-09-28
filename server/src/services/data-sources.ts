import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
} from "@paperclipai/db";
import type {
  DataSource,
  DataSourceTable,
  KnowledgeSearchResult,
  StructuredQueryResult,
  DatabaseConnectionConfig,
  SqlQueryResult,
} from "@paperclipai/shared";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";

export class DataSourcesService {
  constructor(private db: Db) {}

  /**
   * List all data sources for a company
   */
  async list(companyId: string): Promise<DataSource[]> {
    const list = await this.db
      .select()
      .from(dataSources)
      .where(eq(dataSources.companyId, companyId))
      .orderBy(desc(dataSources.createdAt));

    // Attach tables summary
    const results: DataSource[] = [];
    for (const ds of list) {
      const tables = await this.db
        .select()
        .from(dataSourceTables)
        .where(eq(dataSourceTables.dataSourceId, ds.id));

      results.push({
        ...ds,
        sourceType: ds.sourceType as any,
        status: ds.status as any,
        semanticProfile: (ds.metadata as any)?.semanticProfile || null,
        tables: tables as any[],
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

    const tables = await this.db
      .select()
      .from(dataSourceTables)
      .where(eq(dataSourceTables.dataSourceId, ds.id));

    const chunks = await this.db
      .select()
      .from(dataSourceChunks)
      .where(eq(dataSourceChunks.dataSourceId, ds.id))
      .orderBy(dataSourceChunks.chunkIndex)
      .limit(50);

    return {
      ...ds,
      sourceType: ds.sourceType as any,
      status: ds.status as any,
      semanticProfile: (ds.metadata as any)?.semanticProfile || null,
      tables: tables as any[],
      chunks: chunks as any[],
    };
  }

  /**
   * Automatically backfill missing semantic profiles for existing data sources
   * and ensure the full 17-agent enterprise roster is registered.
   */
  async backfillSemanticProfiles(companyId: string): Promise<number> {
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
      if (existingProfile) continue;

      if (ds.sourceType === "rag_document") {
        const chunks = await this.db
          .select({ content: dataSourceChunks.content })
          .from(dataSourceChunks)
          .where(eq(dataSourceChunks.dataSourceId, ds.id))
          .limit(3);

        const sampleText = chunks.map((c) => c.content).join("\n\n") || ds.name;
        const domainResult = await jev.evaluateDocumentDomain(ds.name, sampleText);

        const profile = {
          version: "1.0.0",
          onboardedBy: "KnowledgeIngestionAgent",
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.target_agent_affinity.v1", "rag.passage_relevance.v1"],
          domain: domainResult.domain,
          targetAgentAffinity: domainResult.targetAgentAffinity,
          entities: domainResult.entities,
          primaryTopics: domainResult.primaryTopics,
          summary: domainResult.summary,
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

        const tableNames = tables.map((t) => t.tableName);
        const profile = {
          version: "1.0.0",
          onboardedBy: "DatabaseIntegrationAgent",
          decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1"],
          domain: "relational_database",
          targetAgentAffinity: "data_agent",
          entities: tableNames.length > 0 ? tableNames : [ds.name],
          tableRoles: Object.fromEntries(tableNames.map((n) => [n, "dimension_table"])),
          summary: `Database ${ds.sourceType} dengan tabel [${tableNames.join(", ")}].`,
          onboardedAt: new Date().toISOString(),
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

        const tableNames = tables.map((t) => t.tableName);
        const profile = {
          version: "1.0.0",
          onboardedBy: "StructuredIngestionAgent",
          decisionSpecRefs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1", "struct.sync_strategy.v1"],
          domain: ds.name,
          targetAgentAffinity: "data_agent",
          entities: tableNames.length > 0 ? tableNames : [ds.name],
          summary: `Dataset terstruktur berisikan tabel [${tableNames.join(", ")}].`,
          onboardedAt: new Date().toISOString(),
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

        updatedCount++;
      }
    }

    return updatedCount;
  }

  /**
   * Delete data source and its cascade data
   */
  async delete(companyId: string, id: string): Promise<boolean> {
    const [deleted] = await this.db
      .delete(dataSources)
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
      .returning();
    return !!deleted;
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
    } = {},
  ): Promise<StructuredQueryResult> {
    const [table] = await this.db
      .select()
      .from(dataSourceTables)
      .where(and(eq(dataSourceTables.id, tableId), eq(dataSourceTables.companyId, companyId)));

    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }

    const limit = Math.min(options.limit || 50, 500);
    const offset = options.offset || 0;

    // Check if table belongs to an external database data source
    const [ds] = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.id, table.dataSourceId), eq(dataSources.companyId, companyId)));

    if (ds && (ds.sourceType === "postgres" || ds.sourceType === "mariadb" || ds.sourceType === "mysql")) {
      const config = (ds.metadata as any)?.rawConfig as DatabaseConnectionConfig;
      if (config) {
        const dbIntegration = new DatabaseIntegrationService();
        const quote = ds.sourceType === "postgres" ? `"` : "`";
        const quotedTable = `${quote}${table.tableName}${quote}`;

        let query = "";
        if (options.aggregate) {
          const { column, fn, groupBy } = options.aggregate;
          const quotedCol = `${quote}${column}${quote}`;
          const aggFn = fn.toUpperCase();
          if (groupBy) {
            const quotedGroup = `${quote}${groupBy}${quote}`;
            query = `SELECT ${quotedGroup}, ${aggFn}(${quotedCol}) AS ${quote}${fn}_${column}${quote}, COUNT(*) AS ${quote}row_count${quote} FROM ${quotedTable} GROUP BY ${quotedGroup} ORDER BY ${quote}${fn}_${column}${quote} DESC LIMIT ${limit} OFFSET ${offset}`;
          } else {
            query = `SELECT ${aggFn}(${quotedCol}) AS ${quote}${fn}_${column}${quote}, COUNT(*) AS ${quote}total_rows${quote} FROM ${quotedTable}`;
          }
        } else {
          query = `SELECT * FROM ${quotedTable} LIMIT ${limit} OFFSET ${offset}`;
        }

        const queryResult = await dbIntegration.queryDatabase(config, query, limit);
        return {
          tableId,
          tableName: table.tableName,
          columns: queryResult.columns,
          rows: queryResult.rows,
          totalRows: table.rowCount || queryResult.rowCount,
        };
      }
    }

    // Fetch raw records from local storage (CSV/Excel ingestion)
    const records = await this.db
      .select()
      .from(dataSourceRecords)
      .where(and(eq(dataSourceRecords.tableId, tableId), eq(dataSourceRecords.companyId, companyId)))
      .orderBy(dataSourceRecords.rowIndex)
      .limit(1000);

    let rows = records.map((r) => r.data);

    // Apply filtering if provided
    if (options.filter && Object.keys(options.filter).length > 0) {
      rows = rows.filter((row) => {
        for (const [key, val] of Object.entries(options.filter!)) {
          if (val === undefined || val === null || val === "") continue;
          const rowVal = row[key];
          if (typeof val === "string" && typeof rowVal === "string") {
            if (!rowVal.toLowerCase().includes(val.toLowerCase())) return false;
          } else if (rowVal !== val) {
            return false;
          }
        }
        return true;
      });
    }

    const totalRows = rows.length;

    // Apply aggregation if requested
    if (options.aggregate) {
      const { column, fn, groupBy } = options.aggregate;
      if (groupBy) {
        const groups: Record<string, { count: number; sum: number; min: number; max: number }> = {};
        for (const row of rows) {
          const groupKey = String(row[groupBy] ?? "Unknown");
          const val = Number(row[column]) || 0;
          if (!groups[groupKey]) {
            groups[groupKey] = { count: 0, sum: 0, min: val, max: val };
          }
          groups[groupKey].count++;
          groups[groupKey].sum += val;
          if (val < groups[groupKey].min) groups[groupKey].min = val;
          if (val > groups[groupKey].max) groups[groupKey].max = val;
        }

        const aggregatedRows = Object.entries(groups).map(([grp, stats]) => {
          let aggVal = stats.count;
          if (fn === "sum") aggVal = stats.sum;
          else if (fn === "avg") aggVal = stats.count > 0 ? stats.sum / stats.count : 0;
          else if (fn === "min") aggVal = stats.min;
          else if (fn === "max") aggVal = stats.max;

          return {
            [groupBy]: grp,
            [`${fn}_${column}`]: Number(aggVal.toFixed(2)),
            row_count: stats.count,
          };
        });

        // Sort descending by aggregated value
        aggregatedRows.sort((a, b) => (b[`${fn}_${column}`] as number) - (a[`${fn}_${column}`] as number));

        return {
          tableId,
          tableName: table.tableName,
          columns: [groupBy, `${fn}_${column}`, "row_count"],
          rows: aggregatedRows.slice(offset, offset + limit),
          totalRows: aggregatedRows.length,
        };
      } else {
        // Global aggregation
        let sum = 0;
        let count = 0;
        let min = Infinity;
        let max = -Infinity;

        for (const row of rows) {
          const val = Number(row[column]);
          if (!isNaN(val)) {
            sum += val;
            count++;
            if (val < min) min = val;
            if (val > max) max = val;
          }
        }

        let metricVal = count;
        if (fn === "sum") metricVal = sum;
        else if (fn === "avg") metricVal = count > 0 ? sum / count : 0;
        else if (fn === "min") metricVal = min === Infinity ? 0 : min;
        else if (fn === "max") metricVal = max === -Infinity ? 0 : max;

        return {
          tableId,
          tableName: table.tableName,
          columns: [`${fn}_${column}`, "total_rows"],
          rows: [
            {
              [`${fn}_${column}`]: Number(metricVal.toFixed(2)),
              total_rows: count,
            },
          ],
          totalRows: 1,
          summary: {
            metrics: {
              [`${fn}_${column}`]: Number(metricVal.toFixed(2)),
            },
          },
        };
      }
    }

    const columns = (table.schemaDefinition as any[]).map((c) => c.name);
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
    options: { dataSourceId?: string; limit?: number } = {},
  ): Promise<KnowledgeSearchResult[]> {
    const limit = options.limit || 5;
    const queryEmbedding = KnowledgeIngestionService.generateEmbedding(query);

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
    let whereClause = eq(dataSourceChunks.companyId, companyId);
    if (options.dataSourceId) {
      whereClause = and(whereClause, eq(dataSourceChunks.dataSourceId, options.dataSourceId)) as any;
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
        dataSourceName: dataSources.name,
      })
      .from(dataSourceChunks)
      .innerJoin(dataSources, eq(dataSourceChunks.dataSourceId, dataSources.id))
      .where(candidateWhere)
      .limit(300);

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
      if (chunk.embedding && Array.isArray(chunk.embedding)) {
        denseScore = KnowledgeIngestionService.cosineSimilarity(queryEmbedding, chunk.embedding);
      }

      // Combined hybrid score (reciprocal fusion weighted)
      const combinedScore = denseScore * 0.3 + Math.min(lexicalScore / 35, 1.0) * 0.7;

      if (combinedScore > 0.05 || lexicalScore > 0) {
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

        scoredResults.push({
          chunkId: chunk.chunkId,
          dataSourceId: chunk.dataSourceId,
          dataSourceName: chunk.dataSourceName,
          title: chunk.title,
          content: chunk.content,
          score: Number(combinedScore.toFixed(4)),
          snippet,
          tokenCount: chunk.tokenCount,
        });
      }
    }

    // Sort by relevance score descending
    scoredResults.sort((a, b) => b.score - a.score);

    return scoredResults.slice(0, limit);
  }

  /**
   * Run a direct read-only SQL query on an external database data source
   */
  async querySql(
    companyId: string,
    dataSourceId: string,
    sqlQuery: string,
    limit?: number,
  ): Promise<SqlQueryResult> {
    const [ds] = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.id, dataSourceId), eq(dataSources.companyId, companyId)));

    if (!ds) {
      throw new Error(`Data source not found: ${dataSourceId}`);
    }

    if (ds.sourceType !== "postgres" && ds.sourceType !== "mariadb" && ds.sourceType !== "mysql") {
      throw new Error(
        `Direct SQL queries are only supported on external database data sources, not ${ds.sourceType}`,
      );
    }

    const config = (ds.metadata as any)?.rawConfig as DatabaseConnectionConfig;
    if (!config) {
      throw new Error(`Database connection configuration is missing for data source ${dataSourceId}`);
    }

    const dbIntegration = new DatabaseIntegrationService();
    return dbIntegration.queryDatabase(config, sqlQuery, limit);
  }
}

