import fs from "node:fs";
import path from "node:path";
import { eq, ne, and, or, ilike, desc, sql, isNull, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceCollections,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
  activityLog,
  agents,
} from "@paperclipai/db";
import type {
  DataSource,
  DataSourceTable,
  KnowledgeSearchResult,
  StructuredQueryResult,
  DatabaseConnectionConfig,
  SqlQueryResult,
  ColumnDefinition,
  TableRelation,
} from "@paperclipai/shared";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";
import { ClickhouseService } from "./clickhouse.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { DataSourceCollectionsService } from "./data-source-collections.js";

export class DataSourcesService {
  private collectionsService: DataSourceCollectionsService;

  constructor(private db: Db) {
    this.collectionsService = new DataSourceCollectionsService(db);
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

    // Attach tables summary
    const results: DataSource[] = [];
    for (const ds of list) {
      const tables = await this.db
        .select()
        .from(dataSourceTables)
        .where(eq(dataSourceTables.dataSourceId, ds.id));

      results.push({
        ...ds,
        collectionId: ds.collectionId || null,
        collectionName: ds.collectionId ? colNameMap.get(ds.collectionId) || null : null,
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

    let collectionName: string | null = null;
    if (ds.collectionId) {
      const [col] = await this.db
        .select({ name: dataSourceCollections.name })
        .from(dataSourceCollections)
        .where(and(eq(dataSourceCollections.id, ds.collectionId), eq(dataSourceCollections.companyId, companyId)));
      collectionName = col?.name || null;
    }

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
      collectionId: ds.collectionId || null,
      collectionName,
      sourceType: ds.sourceType as any,
      status: ds.status as any,
      semanticProfile: (ds.metadata as any)?.semanticProfile || null,
      tables: tables as any[],
      chunks: chunks as any[],
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
    const [deleted] = await this.db
      .delete(dataSources)
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)))
      .returning();
    return !!deleted;
  }

  /**
   * Reprocess a single data source by re-running its onboarding pipeline
   */
  async reprocess(companyId: string, id: string): Promise<DataSource> {
    const ds = await this.getById(companyId, id);
    if (!ds) {
      throw new Error(`Data source not found: ${id}`);
    }

    if (!ds.storagePath || !fs.existsSync(ds.storagePath)) {
      throw new Error(`File sumber fisik tidak ditemukan di disk: ${ds.storagePath || "kosong"}`);
    }

    // Clean up existing tables, records, chunks
    await this.db.delete(dataSourceRecords).where(eq(dataSourceRecords.dataSourceId, id));
    await this.db.delete(dataSourceTables).where(eq(dataSourceTables.dataSourceId, id));
    await this.db.delete(dataSourceChunks).where(eq(dataSourceChunks.dataSourceId, id));

    // Reset status to processing
    await this.db
      .update(dataSources)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(dataSources.id, id), eq(dataSources.companyId, companyId)));

    const fileBuffer = fs.readFileSync(ds.storagePath);
    const file = {
      buffer: fileBuffer,
      originalname: ds.fileName || `${ds.name}.csv`,
      mimetype: ds.mimeType || "application/octet-stream",
      size: ds.fileSize || fileBuffer.length,
    };

    const ext = path.extname(ds.fileName || "").toLowerCase().replace(".", "") || "csv";

    const { OnboardingOrchestratorService } = await import("./onboarding-orchestrator.js");
    const orchestrator = new OnboardingOrchestratorService(this.db);

    const reprocessed = await (orchestrator as any).executeOnboardingPipeline(
      companyId,
      ds,
      file,
      { collectionId: ds.collectionId ?? undefined, async: false, skipCorrelation: false },
      ds.name,
      ext,
      ds.sourceType,
    );

    return reprocessed;
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
        ),
      );

    const results: DataSource[] = [];
    for (const item of stuck) {
      try {
        const res = await this.reprocess(companyId, item.id);
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

    // Try executing aggregated queries on ClickHouse OLAP engine if table is present
    if (options.aggregate) {
      try {
        const clickhouse = new ClickhouseService();
        const sanitizedName = table.tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
        const companyDb = clickhouse.getCompanyDatabase(companyId);
        const chTables = await clickhouse.listTables(companyId);

        if (chTables.includes(sanitizedName)) {
          const { column, fn, groupBy } = options.aggregate;
          const aggFn = fn.toUpperCase();
          let chQuery = "";
          if (groupBy) {
            chQuery = `SELECT \`${groupBy}\`, ${aggFn}(\`${column}\`) AS \`${fn}_${column}\`, count(*) AS \`row_count\` FROM \`${sanitizedName}\` GROUP BY \`${groupBy}\` ORDER BY \`${fn}_${column}\` DESC LIMIT ${limit} OFFSET ${offset}`;
          } else {
            chQuery = `SELECT ${aggFn}(\`${column}\`) AS \`${fn}_${column}\`, count(*) AS \`total_rows\` FROM \`${sanitizedName}\``;
          }

          const chResult = await clickhouse.query(chQuery, companyDb);
          return {
            tableId,
            tableName: table.tableName,
            columns: chResult.columns,
            rows: chResult.rows,
            totalRows: chResult.rowCount,
          };
        }
      } catch {
        // Fall back gracefully to local row processing
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
    options: {
      dataSourceId?: string;
      dataSourceIds?: string[];
      collectionId?: string;
      agentId?: string;
      limit?: number;
    } = {},
  ): Promise<KnowledgeSearchResult[]> {
    const limit = options.limit || 5;
    const queryEmbedding = KnowledgeIngestionService.generateEmbedding(query);

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

    // Sort by relevance score descending
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
  ): Promise<SqlQueryResult> {
    const ds = await this.resolveDataSource(companyId, dataSourceId);

    if (!ds) {
      throw new Error(`Data source not found: ${dataSourceId}`);
    }

    if (ds.sourceType === "clickhouse" || ds.sourceType === "csv" || ds.sourceType === "excel") {
      return this.queryClickhouse(companyId, sqlQuery, limit);
    }

    if (ds.sourceType !== "postgres" && ds.sourceType !== "mariadb" && ds.sourceType !== "mysql") {
      throw new Error(
        `Direct SQL queries are only supported on external database data sources or ClickHouse, not ${ds.sourceType}`,
      );
    }

    const config = (ds.metadata as any)?.rawConfig as DatabaseConnectionConfig;
    if (!config) {
      throw new Error(`Database connection configuration is missing for data source ${dataSourceId}`);
    }

    const dbIntegration = new DatabaseIntegrationService();
    return dbIntegration.queryDatabase(config, sqlQuery, limit);
  }

  /**
   * Run a direct read-only SQL query on ClickHouse OLAP storage
   */
  async queryClickhouse(
    companyId: string,
    sqlQuery: string,
    limit?: number,
  ): Promise<SqlQueryResult> {
    const clickhouse = new ClickhouseService();
    const companyDb = clickhouse.getCompanyDatabase(companyId);

    let queryToRun = sqlQuery.trim();
    if (limit && !/\bLIMIT\s+\d+/i.test(queryToRun)) {
      queryToRun += ` LIMIT ${limit}`;
    }

    const result = await clickhouse.query(queryToRun, companyDb);

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
        const sanitizedName = tbl.tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
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
        } else {
          // Ensure table name in DDL is sanitized
          ddl = ddl.replace(
            /CREATE TABLE IF NOT EXISTS `([^`]+)`/i,
            `CREATE TABLE IF NOT EXISTS \`${sanitizedName}\``,
          );
        }

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

        await clickhouse.syncTable(sanitizedName, ddl, rows.length > 0 ? rows : undefined, companyId);

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

    return {
      agentId,
      companyId,
      agentName: agent.name,
      mode,
      dataSourceIds,
      collectionIds,
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
    input: { mode: "all" | "selected" | "none"; dataSourceIds?: string[]; collectionIds?: string[] },
  ) {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const currentMetadata = (agent.metadata as Record<string, unknown>) || {};
    const nextMetadata = {
      ...currentMetadata,
      dataSourceAccess: {
        mode: input.mode,
        dataSourceIds: input.mode === "selected" ? (input.dataSourceIds || []) : [],
        collectionIds: input.mode === "selected" ? (input.collectionIds || []) : [],
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

    return this.getAgentDataSources(companyId, agentId);
  }
}

