import fs from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
  activityLog,
  agents,
  heartbeatRuns,
  heartbeatRunEvents,
} from "@paperclipai/db";
import type {
  DataSource,
  DataSourceType,
  DataSourceSemanticProfile,
  DatabaseConnectionConfig,
  ApiConnectionConfig,
  IotConnectionConfig,
  CctvConnectionConfig,
  SemanticMetric,
  SemanticDimension,
  TableRelation,
} from "@paperclipai/shared";
import { StructuredIngestionService } from "./structured-ingestion.js";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { EnterpriseAgentRosterService } from "./enterprise-agent-roster.js";
import { aiReasoningService } from "./ai-reasoning.js";

export interface OnboardingFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size?: number;
}

export class OnboardingOrchestratorService {
  private jevService: TypeSafeJevService;
  private rosterService: EnterpriseAgentRosterService;

  constructor(private db: Db) {
    this.jevService = new TypeSafeJevService();
    this.rosterService = new EnterpriseAgentRosterService(db);
  }

  /**
   * Main entrypoint for onboarding file data sources (Structured & RAG)
   */
  async onboardSource(
    companyId: string,
    file: OnboardingFileInput,
    options: { name?: string; description?: string; async?: boolean } = {},
  ): Promise<DataSource> {
    // 0. Ensure enterprise agent roster exists
    await this.rosterService.ensureEnterpriseRoster(companyId);

    const ext = file.originalname.split(".").pop()?.toLowerCase() || "";
    let sourceType: DataSourceType = "rag_document";

    if (ext === "csv" || ext === "tsv") {
      sourceType = "csv";
    } else if (ext === "xlsx" || ext === "xls") {
      sourceType = "excel";
    } else if (ext === "md" || ext === "pdf" || ext === "txt" || ext === "docx") {
      sourceType = "rag_document";
    } else {
      // Ambiguous or unusual format: classify with TypeSafe Jev System One
      try {
        const preview = file.buffer.slice(0, 800).toString("utf-8");
        const classification = await this.jevService.systemOne(
          { fileName: file.originalname, snippet: preview },
          {
            format_triage: {
              type: "choice",
              instructions: "Klasifikasikan format data source ini berdasarkan cuplikan konten.",
              criteria: {
                csv: "Format tabular dengan delimitasi koma/titik-koma/baris teratur",
                rag_document: "Dokumen teks naratif / deskriptif / manual / kebijakan",
              },
            },
          },
        );
        const ans = classification.answers["format_triage"] as any;
        if (ans?.choice === "csv") {
          sourceType = "csv";
        } else {
          sourceType = "rag_document";
        }
      } catch {
        sourceType = "rag_document";
      }
    }

    const defaultName = options.name?.trim() || file.originalname.replace(/\.[^/.]+$/, "");

    // 1. Physical storage backup
    let storagePath: string | null = null;
    try {
      const uploadDir = path.resolve(process.cwd(), "data", "uploads", companyId);
      fs.mkdirSync(uploadDir, { recursive: true });
      const targetPath = path.join(uploadDir, `${Date.now()}_${file.originalname}`);
      fs.writeFileSync(targetPath, file.buffer);
      storagePath = targetPath;
    } catch {
      // Non-critical if filesystem writes fail
    }

    // 2. Insert initial entry
    const [initialDs] = await this.db
      .insert(dataSources)
      .values({
        companyId,
        name: defaultName,
        description: options.description || `Ingested from ${file.originalname}`,
        sourceType,
        status: "processing",
        fileName: file.originalname,
        fileSize: file.size || file.buffer.length,
        mimeType: file.mimetype || "application/octet-stream",
        storagePath,
        metadata: {
          startedAt: new Date().toISOString(),
          extension: ext,
        },
      })
      .returning();

    const pipelinePromise = this.executeOnboardingPipeline(
      companyId,
      initialDs,
      file,
      options,
      defaultName,
      ext,
      sourceType,
    );

    if (options.async) {
      pipelinePromise.catch((err) => {
        console.error(`[OnboardingOrchestrator] Async onboarding failed for ${initialDs.id}:`, err);
      });
      return {
        ...initialDs,
        sourceType: initialDs.sourceType as any,
        status: initialDs.status as any,
        tables: [],
        chunks: [],
      } as DataSource;
    }

    return await pipelinePromise;
  }

  private async executeOnboardingPipeline(
    companyId: string,
    initialDs: typeof dataSources.$inferSelect,
    file: OnboardingFileInput,
    options: { name?: string; description?: string; async?: boolean },
    defaultName: string,
    ext: string,
    sourceType: DataSourceType,
  ): Promise<DataSource> {
    try {
      if (sourceType === "csv" || sourceType === "excel") {
        // --- 3. STRUCTURED INGESTION SPECIALIST PIPELINE ---
        // Look up the real built-in Structured Ingestion Agent by its metadata key,
        // along with its configured adapterType and adapterConfig (model, instructions)
        const allCompanyAgents = await this.db
          .select({
            id: agents.id,
            name: agents.name,
            metadata: agents.metadata,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId));

        const structuredIngestionAgent = allCompanyAgents.find(
          (a) => (a.metadata as any)?.paperclipBuiltInAgent?.key === "structured-ingestion",
        );

        const specialistAgentId = structuredIngestionAgent?.id ?? null;
        const specialistAgentName = structuredIngestionAgent?.name ?? "Structured Ingestion Agent";
        const agentModel = (structuredIngestionAgent?.adapterConfig as any)?.model;
        const agentInstructions = (structuredIngestionAgent?.adapterConfig as any)?.instructionsFilePath;

        // Fetch existing tables in the company to allow cross-table relationship discovery
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
          tableName: et.tableName,
          columns: ((et.schemaDefinition as any[]) || []).map((c: any) =>
            typeof c === "string" ? { name: c } : { name: c?.name || "", role: c?.role, dataType: c?.dataType },
          ),
        }));

        // Build catalogMap from existing database-type datasource tables so the CSV/Excel
        // parser can resolve headerless files without any hardcoded column arrays.
        const dbTypeSources = await this.db
          .select({ id: dataSources.id, sourceType: dataSources.sourceType })
          .from(dataSources)
          .where(and(eq(dataSources.companyId, companyId)));

        const dbSourceIds = dbTypeSources
          .filter((s) => ["mariadb", "mysql", "postgresql", "sqlite", "mssql", "oracle"].includes(s.sourceType))
          .map((s) => s.id);

        const catalogMap = new Map<string, string[]>();
        if (dbSourceIds.length > 0) {
          for (const dbt of existingTables) {
            const cols = ((dbt.schemaDefinition as any[]) || []).map((c: any) =>
              typeof c === "string" ? c : (c?.name ?? ""),
            ).filter(Boolean);
            if (cols.length > 0) {
              const normalizedName = dbt.tableName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
              catalogMap.set(normalizedName, cols);
            }
          }
        }

        const tables =
          sourceType === "csv"
            ? [StructuredIngestionService.parseCsv(file.buffer.toString("utf-8"), defaultName, { catalogMap })]
            : StructuredIngestionService.parseExcel(file.buffer, { catalogMap });

        let totalRows = 0;
        const createdTables: any[] = [];
        const allEntities = new Set<string>();
        const allMetrics: SemanticMetric[] = [];
        const allDimensions: SemanticDimension[] = [];
        const allSuggestedQueries: any[] = [];
        const allReasoningSteps: any[] = [];
        const allDiscoveredRelationships: TableRelation[] = [];
        let inferredDomain: string | null = null;
        let inferredTopics: string[] = [];

        let hasAiReasoned = false;

        for (const tableData of tables) {
          totalRows += tableData.rows.length;

          // 3a. Execute Autonomous Semantic Analysis via Structured Ingestion Agent
          const aiLoopRes = await aiReasoningService.analyzeTable(
            tableData.tableName,
            tableData.columns.map((c) => ({
              name: c.name,
              sampleValues: c.sampleValues,
              distinctCount: c.distinctCount,
              nullRatio: c.nullRatio,
              dataType: c.dataType,
            })),
            tableData.rows.slice(0, 5),
            candidateTables,
            {
              agentName: specialistAgentName,
              model: agentModel,
              instructionsPath: agentInstructions,
              adapterType: structuredIngestionAgent?.adapterType,
            },
          );

          const aiAnalysis = aiLoopRes.result;
          if (aiLoopRes.reasoningSteps.length > 0) {
            allReasoningSteps.push(...aiLoopRes.reasoningSteps);
          }

          let entities: string[] = [];
          let primaryMetrics: Array<{ name: string; column: string; aggregation: "sum" | "avg" | "count" | "min" | "max"; format?: string }> = [];
          let syncStrategy: "replace" | "append" | "upsert" = "replace";
          let suggestedQueries: any[] = [];
          let primaryKey: string[] = [];

          if (aiAnalysis) {
            hasAiReasoned = true;
            inferredDomain = aiAnalysis.domain || inferredDomain;
            if (aiAnalysis.primaryTopics && aiAnalysis.primaryTopics.length > 0) {
              inferredTopics = Array.from(new Set([...inferredTopics, ...aiAnalysis.primaryTopics]));
            }

            // Update column roles from AI analysis
            for (const col of tableData.columns) {
              if (aiAnalysis.columnRoles[col.name]) {
                col.role = aiAnalysis.columnRoles[col.name] as any;
              }
            }

            entities = aiAnalysis.entities;
            primaryMetrics = aiAnalysis.metrics;
            primaryKey = aiAnalysis.primaryKey;
            syncStrategy = primaryKey.length > 0 ? "upsert" : "replace";
            suggestedQueries = aiAnalysis.suggestedQueries;
            if (aiAnalysis.relationships && aiAnalysis.relationships.length > 0) {
              allDiscoveredRelationships.push(...aiAnalysis.relationships);
            }
          } else {
            // Fallback to TypeSafe JEV System One if AI reasoning is offline
            const columnRoles = await this.jevService.evaluateColumnRoles(
              tableData.tableName,
              tableData.columns.map((c) => ({
                name: c.name,
                sampleValues: c.sampleValues,
                distinctCount: c.distinctCount,
                nullRatio: c.nullRatio,
              })),
            );

            for (const col of tableData.columns) {
              if (columnRoles[col.name]) {
                col.role = columnRoles[col.name];
              }
            }

            const metricCols = tableData.columns.filter((c) => c.role === "metric").map((c) => c.name);
            const colNames = tableData.columns.map((c) => c.name);

            const jevResult = await this.jevService.evaluateEntityAndMetrics(
              tableData.tableName,
              colNames,
              metricCols,
            );

            entities = jevResult.entities;
            primaryMetrics = jevResult.primaryMetrics;
            syncStrategy = jevResult.syncStrategy;
            suggestedQueries = jevResult.suggestedQueries || [];
            if (jevResult.reasoningSteps) allReasoningSteps.push(...jevResult.reasoningSteps);
          }

          entities.forEach((e) => allEntities.add(e));
          allMetrics.push(...primaryMetrics);
          if (suggestedQueries) allSuggestedQueries.push(...suggestedQueries);

          for (const col of tableData.columns.filter((c) => c.role === "dimension")) {
            allDimensions.push({
              name: col.name,
              column: col.name,
              type: col.dataType,
              sampleValues: col.sampleValues.map(String).slice(0, 4),
            });
          }

          // Build table semantic model
          const tableSemanticModel = {
            ...tableData.semanticModel,
            entities,
            primaryKey: primaryKey.length > 0 ? primaryKey : undefined,
            metrics: primaryMetrics.map((m) => ({
              name: m.name,
              expression: m.column,
              description: (m as any).description || `Metric ${m.name} aggregated via ${m.aggregation}`,
              aggregation: m.aggregation,
            })),
            dimensions: tableData.columns
              .filter((c) => c.role === "dimension")
              .map((c) => ({ name: c.name, description: `Dimension ${c.name}`, sampleValues: c.sampleValues.map(String).slice(0, 4) })),
            syncStrategy,
            mappedBy: specialistAgentName,
            decisionSpecs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1", "struct.sync_strategy.v1"],
            suggestedQueries,
          };

          // Insert table definition
          const [tableRow] = await this.db
            .insert(dataSourceTables)
            .values({
              dataSourceId: initialDs.id,
              companyId,
              tableName: tableData.tableName,
              rowCount: tableData.rows.length,
              columnCount: tableData.columns.length,
              schemaDefinition: tableData.columns as any,
              semanticModel: tableSemanticModel as any,
            })
            .returning();

          createdTables.push(tableRow);

          // Batch insert records
          const batchSize = 100;
          for (let i = 0; i < tableData.rows.length; i += batchSize) {
            const slice = tableData.rows.slice(i, i + batchSize);
            const values = slice.map((row, idx) => ({
              tableId: tableRow.id,
              dataSourceId: initialDs.id,
              companyId,
              rowIndex: i + idx,
              data: row,
            }));

            if (values.length > 0) {
              await this.db.insert(dataSourceRecords).values(values);
            }
          }

          // Sync to ClickHouse OLAP engine if DDL is present
          try {
            const chDdl = (tableSemanticModel as any)?.clickhouseSchema?.createTableDdl;
            if (chDdl) {
              const { ClickhouseService } = await import("./clickhouse.js");
              const clickhouse = new ClickhouseService();
              const sanitizedName = tableData.tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
              await clickhouse.syncTable(sanitizedName, chDdl, tableData.rows, companyId);
            }
          } catch (chErr: any) {
            console.warn(`[ClickhouseSync] Optional OLAP sync skipped: ${chErr.message}`);
          }
        }

        // Cross-Table Relationship Discovery fallback if AI reasoning was not available
        if (!hasAiReasoned && allDiscoveredRelationships.length === 0 && candidateTables.length > 0) {
          const { relationships: crossRelationships, reasoningSteps: relReasoningSteps } =
            await this.jevService.evaluateCrossTableRelations(
              tables.map((t) => ({
                tableName: t.tableName,
                columns: t.columns.map((c) => ({
                  name: c.name,
                  role: c.role,
                  dataType: c.dataType,
                  sampleValues: c.sampleValues,
                })),
              })),
              candidateTables.map((ct) => ({
                tableName: ct.tableName,
                columns: ct.columns.map((c) => ({ name: c.name, role: c.role, dataType: c.dataType })),
              })),
            );

          allDiscoveredRelationships.push(...crossRelationships);
          if (relReasoningSteps) allReasoningSteps.push(...relReasoningSteps);
        }

        // Update created tables with their relationships in semanticModel
        for (const createdTable of createdTables) {
          const tableRels = allDiscoveredRelationships.filter(
            (r) =>
              r.sourceTable.toLowerCase() === createdTable.tableName.toLowerCase() ||
              r.targetTable.toLowerCase() === createdTable.tableName.toLowerCase(),
          );
          if (tableRels.length > 0) {
            const currentModel = (createdTable.semanticModel as any) || {};
            await this.db
              .update(dataSourceTables)
              .set({
                semanticModel: {
                  ...currentModel,
                  relationships: tableRels,
                } as any,
              })
              .where(eq(dataSourceTables.id, createdTable.id));
          }
        }

        // 3d. Synthesize Topics: Use AI-inferred topics if available, or fall back to JEV
        const { topics, reasoningSteps: topicReasoningSteps, tableProfiles, crossTableClusters } =
          await this.jevService.evaluateDatasetTopics(
            tables,
            Array.from(allEntities),
            allMetrics,
            allDimensions,
            inferredTopics.length > 0 ? inferredTopics : undefined,
            allDiscoveredRelationships,
          );
        const finalTopics = topics;
        if (topicReasoningSteps) allReasoningSteps.push(...topicReasoningSteps);

        const semanticProfile: DataSourceSemanticProfile = {
          version: "1.0.0",
          onboardedBy: specialistAgentName,
          decisionSpecRefs: [
            "struct.column_role.v1",
            "struct.entity_metric_mapping.v1",
            "struct.sync_strategy.v1",
            "struct.relation_discovery.v1",
            "struct.topic_synthesis.v1",
          ],
          domain: inferredDomain || Array.from(allEntities).join(", ") || defaultName,
          targetAgentAffinity: "data_agent",
          entities: Array.from(allEntities),
          metrics: allMetrics,
          dimensions: allDimensions.slice(0, 10),
          primaryTopics: finalTopics,
          topics: finalTopics,
          tableProfiles,
          crossTableClusters,
          relationships: allDiscoveredRelationships,
          summary: `Dataset terstruktur berisikan ${tables.length} tabel dengan total ${totalRows.toLocaleString()} baris. Dianalisis dan dipetakan oleh ${specialistAgentName} (${inferredDomain || "Structured Data"}).`,
          onboardedAt: new Date().toISOString(),
          suggestedQueries: allSuggestedQueries,
          reasoningSteps: allReasoningSteps,
        };

        // Update status to 'ready' with semantic profile
        const [updated] = await this.db
          .update(dataSources)
          .set({
            status: "ready",
            metadata: {
              completedAt: new Date().toISOString(),
              tableCount: tables.length,
              totalRows,
              sheetNames: tables.map((t) => t.tableName),
              onboardedBy: specialistAgentName,
              semanticProfile,
              onboardingReasoning: allReasoningSteps,
              suggestedQueries: allSuggestedQueries,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        // 3e. Record heartbeat run + events so the agent's "Latest Run" is visible in the UI.
        //     Only records if we found the real built-in agent — no orphan run rows.
        const runId = await this.recordIngestionRun(
          companyId,
          specialistAgentId,
          "structured",
          defaultName,
          initialDs.id,
          semanticProfile,
          allReasoningSteps,
        );

        // 3f. Record Agent Activity Log (linked to the run we just created)
        await this.logOnboardingActivity(
          companyId,
          "structured-ingestion",
          specialistAgentId,
          runId,
          initialDs.id,
          defaultName,
          "structured",
          semanticProfile,
        );

        return {
          ...updated,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          semanticProfile,
          tables: createdTables,
        };
      } else {
        // --- 4. KNOWLEDGE / RAG INGESTION SPECIALIST PIPELINE ---
        // Look up the real built-in Knowledge Ingestion Agent by its metadata key.
        const allCompanyAgentsK = await this.db
          .select({
            id: agents.id,
            name: agents.name,
            metadata: agents.metadata,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId));

        const knowledgeIngestionAgent = allCompanyAgentsK.find(
          (a) => (a.metadata as any)?.paperclipBuiltInAgent?.key === "knowledge-ingestion",
        );

        const specialistAgentId = knowledgeIngestionAgent?.id ?? null;
        const specialistAgentName = knowledgeIngestionAgent?.name ?? "Knowledge Ingestion Agent";
        const agentModel = (knowledgeIngestionAgent?.adapterConfig as any)?.model;
        const agentInstructions = (knowledgeIngestionAgent?.adapterConfig as any)?.instructionsFilePath;

        const { chunks, totalWords } = await KnowledgeIngestionService.processDocument(
          file.originalname,
          file.buffer,
          file.mimetype,
        );

        if (chunks.length > 0) {
          const chunkValues = chunks.map((c) => ({
            dataSourceId: initialDs.id,
            companyId,
            chunkIndex: c.chunkIndex,
            title: c.title,
            content: c.content,
            tokenCount: c.tokenCount,
            metadata: c.metadata,
            embedding: c.embedding,
          }));

          const batchSize = 50;
          for (let i = 0; i < chunkValues.length; i += batchSize) {
            await this.db.insert(dataSourceChunks).values(chunkValues.slice(i, i + batchSize));
          }
        }

        // 4a. Execute Autonomous Semantic Document Analysis via Knowledge Ingestion Agent
        const aiDocRes = await aiReasoningService.analyzeDocument(
          file.originalname,
          chunks.slice(0, 10).map((c) => ({
            chunkIndex: c.chunkIndex,
            title: c.title,
            content: c.content,
          })),
          totalWords,
          {
            agentName: specialistAgentName,
            model: agentModel,
            instructionsPath: agentInstructions,
            adapterType: knowledgeIngestionAgent?.adapterType,
          },
        );

        const docAnalysis = aiDocRes.result;
        const reasoningSteps: any[] = [...aiDocRes.reasoningSteps];

        let finalDomain = docAnalysis?.domain;
        let finalEntities = docAnalysis?.entities || [];
        let finalTopics = docAnalysis?.primaryTopics || [];
        let finalSummary = docAnalysis?.summary;
        let finalAffinity = docAnalysis?.targetAgentAffinity || "rag_agent";
        let finalQueries = docAnalysis?.suggestedQueries || [];

        let docProfiles = docAnalysis?.documentProfiles || [];
        // Fallback to TypeSafe JEV System One if AI reasoning is offline
        if (!docAnalysis) {
          const sampleText = chunks.slice(0, 3).map((c) => c.content).join("\n\n") || file.originalname;
          const domainResult = await this.jevService.evaluateDocumentDomain(
            file.originalname,
            sampleText,
            chunks.map((c, idx) => ({ id: `chunk-${idx}`, title: c.title || undefined, content: c.content }))
          );
          finalDomain = domainResult.domain;
          finalEntities = domainResult.entities;
          finalTopics = domainResult.primaryTopics;
          finalSummary = domainResult.summary;
          finalAffinity = domainResult.targetAgentAffinity;
          finalQueries = domainResult.suggestedQueries || [];
          docProfiles = domainResult.documentProfiles || [];
          if (domainResult.reasoningSteps) reasoningSteps.push(...domainResult.reasoningSteps);
        } else if (docProfiles.length === 0) {
          docProfiles = this.jevService.deriveDocumentSemanticProfiles(
            chunks.map((c, idx) => ({ id: `chunk-${idx}`, title: c.title || undefined, content: c.content })),
            file.originalname
          );
        }

        // 4b. Synthesize Knowledge Semantic Profile
        const semanticProfile: DataSourceSemanticProfile = {
          version: "1.0.0",
          onboardedBy: specialistAgentName,
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.target_agent_affinity.v1", "rag.passage_relevance.v1"],
          domain: finalDomain || "Unstructured Knowledge",
          targetAgentAffinity: finalAffinity,
          entities: finalEntities,
          primaryTopics: finalTopics,
          documentProfiles: docProfiles,
          summary: finalSummary || `Dokumen '${file.originalname}' (${chunks.length} chunks, ${totalWords} kata) dipetakan ke dalam basis pengetahuan RAG oleh ${specialistAgentName}.`,
          onboardedAt: new Date().toISOString(),
          suggestedQueries: finalQueries,
          reasoningSteps,
        };

        // Update status to 'ready' with semantic profile
        const [updated] = await this.db
          .update(dataSources)
          .set({
            status: "ready",
            metadata: {
              completedAt: new Date().toISOString(),
              chunkCount: chunks.length,
              totalWords,
              onboardedBy: specialistAgentName,
              semanticProfile,
              onboardingReasoning: reasoningSteps,
              suggestedQueries: finalQueries,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        // 4c. Record heartbeat run so the agent's "Latest Run" is visible in the UI.
        const runId = await this.recordIngestionRun(
          companyId,
          specialistAgentId,
          "knowledge",
          defaultName,
          initialDs.id,
          semanticProfile,
          reasoningSteps,
        );

        // 4d. Record Agent Activity Log (linked to the run)
        await this.logOnboardingActivity(
          companyId,
          "knowledge-ingestion",
          specialistAgentId,
          runId,
          initialDs.id,
          defaultName,
          "knowledge",
          semanticProfile,
        );

        return {
          ...updated,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          semanticProfile,
          chunks: chunks as any[],
        };
      }
    } catch (err: any) {
      await this.db
        .update(dataSources)
        .set({
          status: "error",
          metadata: {
            failedAt: new Date().toISOString(),
            error: err?.message || String(err),
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id));

      throw new Error(`Onboarding failed for ${file.originalname}: ${err.message}`);
    }
  }

  /**
   * Onboard an external database (PostgreSQL, MariaDB, MySQL, etc.)
   * Handled by DatabaseIntegrationAgent with JEV System One DecisionSpecs ('db.table_role', 'db.join_candidates')
   */
  async onboardDatabase(
    companyId: string,
    config: DatabaseConnectionConfig,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
    await this.rosterService.ensureEnterpriseRoster(companyId);

    // Look up the real built-in Database Ingestion Agent by its metadata key.
    const allCompanyAgentsDb = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        metadata: agents.metadata,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const databaseIngestionAgent = allCompanyAgentsDb.find(
      (a) => (a.metadata as any)?.paperclipBuiltInAgent?.key === "database-ingestion",
    );

    const specialistAgentId = databaseIngestionAgent?.id ?? null;
    const specialistAgentName = databaseIngestionAgent?.name ?? "Database Ingestion Agent";
    const agentModel = (databaseIngestionAgent?.adapterConfig as any)?.model;
    const agentInstructions = (databaseIngestionAgent?.adapterConfig as any)?.instructionsFilePath;

    const dbIntegration = new DatabaseIntegrationService();

    // 1. Verify connection
    const testResult = await dbIntegration.testConnection(config);
    if (!testResult.success) {
      throw new Error(`Failed to connect to ${config.type} database: ${testResult.error}`);
    }

    const defaultName =
      options.name?.trim() ||
      `${config.type.toUpperCase()} - ${config.database} (${config.host}:${config.port})`;

    const sanitizedConfig = {
      ...config,
      password: config.password ? "••••••••" : "",
    };

    // 2. Create initial data source record
    const [initialDs] = await this.db
      .insert(dataSources)
      .values({
        companyId,
        name: defaultName,
        description:
          options.description ||
          `External ${config.type.toUpperCase()} database connection to ${config.database} on ${config.host}`,
        sourceType: config.type,
        status: "processing",
        metadata: {
          startedAt: new Date().toISOString(),
          connectionConfig: sanitizedConfig,
          rawConfig: config,
          serverVersion: testResult.version,
          onboardedBy: specialistAgentName,
        },
      })
      .returning();

    // 3. Launch autonomous introspection & reasoning via Database Ingestion Agent in background
    this.processDatabaseAsync(
      initialDs,
      companyId,
      config,
      sanitizedConfig,
      defaultName,
      testResult.version,
      specialistAgentId,
      specialistAgentName,
      agentModel,
      agentInstructions,
      databaseIngestionAgent?.adapterType,
    ).catch((err) => {
      console.error(`[onboarding-orchestrator] Background database onboarding failed for ${defaultName}:`, err);
    });

    return {
      ...initialDs,
      sourceType: initialDs.sourceType as any,
      status: initialDs.status as any,
    };
  }

  /**
   * Background runner for Database Ingestion Agent onboarding
   */
  private async processDatabaseAsync(
    initialDs: any,
    companyId: string,
    config: DatabaseConnectionConfig,
    sanitizedConfig: any,
    defaultName: string,
    serverVersion: string | undefined,
    specialistAgentId: string | null,
    specialistAgentName: string,
    agentModel?: string,
    agentInstructions?: string,
    adapterType?: string,
  ): Promise<void> {
    const dbIntegration = new DatabaseIntegrationService();
    console.log(`[onboarding-orchestrator] Background database onboarding started for ${defaultName}`);

    try {
      // 1. Inspect database: extract tables, columns, relations
      const tables = await dbIntegration.inspectDatabase(config);
      console.log(`[onboarding-orchestrator] Inspected ${tables.length} tables from ${config.database}. Triggering autonomous schema analysis via ${specialistAgentName}...`);

      let totalRows = 0;
      const createdTables: any[] = [];

      // 2. Execute Autonomous Relational Schema Analysis via Database Ingestion Agent
      const aiDbRes = await aiReasoningService.analyzeDatabaseSchema(
        config.type,
        config.database,
        tables.map((t) => ({
          tableName: t.tableName,
          rowCount: t.rowCount,
          columns: t.schemaDefinition.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            isPrimary: c.isPrimaryKey,
            isForeign: c.isForeignKey,
          })),
        })),
        {
          agentName: specialistAgentName,
          model: agentModel,
          instructionsPath: agentInstructions,
          adapterType,
        },
      );
      console.log(`[onboarding-orchestrator] Autonomous analysis completed in ${aiDbRes.iterations} iterations. Entities: ${aiDbRes.result?.entities?.join(", ")}`);

      const dbAnalysis = aiDbRes.result;
      const reasoningSteps: any[] = [...aiDbRes.reasoningSteps];

      let finalDomain = dbAnalysis?.domain || `${config.type.toUpperCase()} Relational Database`;
      let finalEntities = dbAnalysis?.entities || [];
      let finalTopics = dbAnalysis?.primaryTopics || [];
      let tableRoles: Record<string, string> = dbAnalysis?.tableRoles || {};
      let relationships: any[] = dbAnalysis?.relationships || [];
      let suggestedQueries: any[] = dbAnalysis?.suggestedQueries || [];
      let summary =
        dbAnalysis?.reasoningSummary ||
        `Basis data relasional (${config.type}) dengan ${tables.length} tabel terhubung dan dipetakan oleh ${specialistAgentName}.`;

      // Fallback to TypeSafe JEV System One if AI reasoning is offline
      let tableProfiles: Record<string, any> = dbAnalysis?.tableProfiles || {};
      let crossTableClusters: any[] = dbAnalysis?.crossTableClusters || [];

      if (!dbAnalysis) {
        const tableSummaries = tables.map((t) => ({
          name: t.tableName,
          columns: t.schemaDefinition.map((c) => c.name),
          rowCount: t.rowCount,
        }));
        const dbSemanticRes = await this.jevService.evaluateDatabaseTables(tableSummaries);
        finalEntities = dbSemanticRes.entities;
        tableRoles = dbSemanticRes.tableRoles;
        relationships = dbSemanticRes.relationships;
        finalTopics = dbSemanticRes.primaryTopics;
        suggestedQueries = dbSemanticRes.suggestedQueries;
        tableProfiles = dbSemanticRes.tableProfiles || {};
        crossTableClusters = dbSemanticRes.crossTableClusters || [];
        if (dbSemanticRes.reasoningSteps) reasoningSteps.push(...dbSemanticRes.reasoningSteps);
      }

      for (const tableData of tables) {
        totalRows += tableData.rowCount;

        const tProf = tableProfiles[tableData.tableName];
        // Enhance table semantic model with agent's analyzed table role and per-table topics
        const tableSemantic = {
          ...tableData.semanticModel,
          tableRole: tableRoles[tableData.tableName] || "dimension_table",
          context: tProf?.context || tableData.semanticModel?.context,
          topics: tProf?.topics || tableData.semanticModel?.topics || [],
          mappedBy: specialistAgentName,
          decisionSpecs: ["db.table_role.v1", "db.join_candidates.v1"],
        };

        const [tableRow] = await this.db
          .insert(dataSourceTables)
          .values({
            dataSourceId: initialDs.id,
            companyId,
            tableName: tableData.tableName,
            rowCount: tableData.rowCount,
            columnCount: tableData.columnCount,
            schemaDefinition: tableData.schemaDefinition as any,
            semanticModel: tableSemantic as any,
          })
          .returning();

        createdTables.push(tableRow);

        // Sync table schema to ClickHouse
        try {
          const chDdl = (tableSemantic as any)?.clickhouseSchema?.createTableDdl;
          if (chDdl) {
            const { ClickhouseService } = await import("./clickhouse.js");
            const clickhouse = new ClickhouseService();
            const sanitizedName = tableData.tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
            await clickhouse.syncTable(sanitizedName, chDdl, undefined, companyId);
          }
        } catch (chErr: any) {
          console.warn(`[ClickhouseSync] Optional DB schema sync skipped: ${chErr.message}`);
        }
      }

      // Collect JSON structures across all tables
      const jsonStructures: Record<string, any> = {};
      for (const t of tables) {
        for (const col of t.schemaDefinition) {
          if (col.isJson && col.jsonStructure) {
            jsonStructures[`${t.tableName}.${col.name}`] = col.jsonStructure;
          }
        }
      }

      // 3. Synthesize Database Semantic Profile
      const semanticProfile: DataSourceSemanticProfile = {
        version: "1.0.0",
        onboardedBy: specialistAgentName,
        decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1", "db.json_structure.v1"],
        domain: finalDomain,
        targetAgentAffinity: "data_agent",
        entities: finalEntities,
        tableRoles,
        relationships,
        primaryTopics: finalTopics,
        topics: finalTopics,
        tableProfiles,
        crossTableClusters,
        summary,
        onboardedAt: new Date().toISOString(),
        suggestedQueries,
        reasoningSteps,
        jsonStructures,
      };

      // 4. Update data source status to 'ready'
      await this.db
        .update(dataSources)
        .set({
          status: "ready",
          metadata: {
            completedAt: new Date().toISOString(),
            connectionConfig: sanitizedConfig,
            rawConfig: config,
            serverVersion,
            tableCount: tables.length,
            totalRows,
            tables: tables.map((t) => t.tableName),
            onboardedBy: specialistAgentName,
            semanticProfile,
            onboardingReasoning: reasoningSteps,
            suggestedQueries,
            jsonStructures,
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id));

      // 5. Record heartbeat run so the agent's "Latest Run" is visible in the UI
      const runId = await this.recordIngestionRun(
        companyId,
        specialistAgentId,
        "database",
        defaultName,
        initialDs.id,
        semanticProfile,
        reasoningSteps,
      );

      // 6. Record Activity Log
      await this.logOnboardingActivity(
        companyId,
        "database-ingestion",
        specialistAgentId,
        runId,
        initialDs.id,
        defaultName,
        "database",
        semanticProfile,
      );
      console.log(`[onboarding-orchestrator] Database onboarding successfully completed for ${defaultName}. RunId: ${runId}`);
    } catch (err: any) {
      await this.db
        .update(dataSources)
        .set({
          status: "error",
          metadata: {
            failedAt: new Date().toISOString(),
            error: err?.message || String(err),
            connectionConfig: sanitizedConfig,
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id));

      console.error(`[onboarding-orchestrator] Error during database onboarding for ${defaultName}:`, err);
    }
  }

  /**
   * Onboard an external API / SaaS source
   * Handled by ApiIntegrationAgent with DecisionSpec 'api.operation_class.v1'
   */
  async onboardApi(
    companyId: string,
    config: ApiConnectionConfig,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
    await this.rosterService.ensureEnterpriseRoster(companyId);

    const defaultName = options.name?.trim() || `API - ${new URL(config.baseUrl).hostname}`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: "API Integration",
      decisionSpecRefs: ["api.operation_class.v1", "api.intent_to_tool.v1"],
      domain: "rest_api",
      targetAgentAffinity: "action_agent",
      entities: [defaultName],
      summary: `REST API endpoint '${config.baseUrl}' dipetakan menggunakan TypeSafe JEV System One.`,
      onboardedAt: new Date().toISOString(),
    };

    const [created] = await this.db
      .insert(dataSources)
      .values({
        companyId,
        name: defaultName,
        description: options.description || `Enterprise API connection to ${config.baseUrl}`,
        sourceType: "api_rest",
        status: "ready",
        metadata: {
          completedAt: new Date().toISOString(),
          apiConfig: {
            ...config,
            apiKey: config.apiKey ? "••••••••" : undefined,
          },
          onboardedBy: "API Integration",
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, "api-integration", null, null, created.id, defaultName, "api", semanticProfile);

    return {
      ...created,
      sourceType: created.sourceType as any,
      status: created.status as any,
      semanticProfile,
    };
  }

  /**
   * Onboard an IoT Telemetry broker
   * Handled by IotIntegrationAgent with DecisionSpec 'iot.topic_classification.v1'
   */
  async onboardIot(
    companyId: string,
    config: IotConnectionConfig,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
    await this.rosterService.ensureEnterpriseRoster(companyId);

    const defaultName = options.name?.trim() || `MQTT Broker (${config.brokerUrl})`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: "IoT Integration",
      decisionSpecRefs: ["iot.topic_classification.v1", "iot.quarantined_triage.v1"],
      domain: "iot_telemetry",
      targetAgentAffinity: "data_agent",
      entities: config.topics,
      summary: `MQTT IoT stream dengan ${config.topics.length} topik dipetakan menggunakan TypeSafe JEV System One.`,
      onboardedAt: new Date().toISOString(),
    };

    const [created] = await this.db
      .insert(dataSources)
      .values({
        companyId,
        name: defaultName,
        description: options.description || `Industrial IoT MQTT broker stream (${config.topics.join(", ")})`,
        sourceType: "mqtt_iot",
        status: "ready",
        metadata: {
          completedAt: new Date().toISOString(),
          iotConfig: {
            ...config,
            password: config.password ? "••••••••" : undefined,
          },
          onboardedBy: "IoT Integration",
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, "iot-integration", null, null, created.id, defaultName, "iot", semanticProfile);

    return {
      ...created,
      sourceType: created.sourceType as any,
      status: created.status as any,
      semanticProfile,
    };
  }

  /**
   * Onboard a CCTV surveillance feed
   * Handled by CctvIntegrationAgent with DecisionSpec 'cctv.event_severity.v1'
   */
  async onboardCctv(
    companyId: string,
    config: CctvConnectionConfig,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
    await this.rosterService.ensureEnterpriseRoster(companyId);

    const defaultName = options.name?.trim() || `CCTV - ${config.cameraName}`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: "CCTV Integration",
      decisionSpecRefs: ["cctv.event_severity.v1", "cctv.escalation_action.v1"],
      domain: "cctv_surveillance",
      targetAgentAffinity: "vision_agent",
      entities: [config.cameraName, config.location || "Perimeter"],
      summary: `Feed kamera CCTV '${config.cameraName}' dipetakan menggunakan TypeSafe JEV System One.`,
      onboardedAt: new Date().toISOString(),
    };

    const [created] = await this.db
      .insert(dataSources)
      .values({
        companyId,
        name: defaultName,
        description: options.description || `CCTV RTSP stream for ${config.cameraName} at ${config.location || "Premises"}`,
        sourceType: "cctv_feed",
        status: "ready",
        metadata: {
          completedAt: new Date().toISOString(),
          cctvConfig: config,
          onboardedBy: "CCTV Integration",
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, "cctv-integration", null, null, created.id, defaultName, "cctv", semanticProfile);

    return {
      ...created,
      sourceType: created.sourceType as any,
      status: created.status as any,
      semanticProfile,
    };
  }

  /**
   * Record a heartbeat_runs row + run events for a built-in ingestion agent so its
   * "Latest Run" is visible on the Agent Overview page. Safely skips if agentId is null.
   * Returns the new run's UUID (or null on failure).
   */
  private async recordIngestionRun(
    companyId: string,
    agentId: string | null,
    kind: string,
    dataSourceName: string,
    dataSourceId: string,
    semanticProfile: DataSourceSemanticProfile,
    reasoningSteps: any[],
  ): Promise<string | null> {
    if (!agentId) return null;
    try {
      const now = new Date();
      const [run] = await this.db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: `onboarding:${kind}:${dataSourceId}`,
          status: "succeeded",
          runtimeMode: "builtin_ingestion",
          startedAt: now,
          finishedAt: now,
          resultJson: {
            dataSourceId,
            dataSourceName,
            kind,
            entities: semanticProfile.entities ?? [],
            topics: semanticProfile.primaryTopics ?? semanticProfile.topics ?? [],
            decisionSpecRefs: semanticProfile.decisionSpecRefs ?? [],
            stepCount: reasoningSteps.length,
          },
        })
        .returning({ id: heartbeatRuns.id });

      if (!run?.id) return null;

      // Insert run events documenting the agentic reasoning stages
      let seq = 1;
      await this.db.insert(heartbeatRunEvents).values({
        companyId,
        runId: run.id,
        agentId,
        seq: seq++,
        eventType: "log",
        level: "info",
        message: `[START] Starting autonomous ${kind} ingestion for '${dataSourceName}'`,
      });

      if (reasoningSteps.length > 0) {
        for (const step of reasoningSteps.slice(0, 15)) {
          const title = step.name || "Reasoning Step";
          const body = step.thought || (typeof step === "string" ? step : JSON.stringify(step));
          await this.db.insert(heartbeatRunEvents).values({
            companyId,
            runId: run.id,
            agentId,
            seq: seq++,
            eventType: "log",
            level: step.error ? "warn" : "info",
            message: `[${title}] ${body.slice(0, 400)}`,
          });
        }
      } else {
        const defaultStages = [
          `[SEMANTIC] Entities identified: ${(semanticProfile.entities ?? []).slice(0, 5).join(", ") || "none"}`,
          `[TOPICS] Topics: ${(semanticProfile.primaryTopics ?? semanticProfile.topics ?? []).slice(0, 3).join(", ") || "none"}`,
        ];
        for (const msg of defaultStages) {
          await this.db.insert(heartbeatRunEvents).values({
            companyId,
            runId: run.id,
            agentId,
            seq: seq++,
            eventType: "log",
            level: "info",
            message: msg,
          });
        }
      }

      await this.db.insert(heartbeatRunEvents).values({
        companyId,
        runId: run.id,
        agentId,
        seq: seq++,
        eventType: "log",
        level: "info",
        message: `[COMPLETE] Autonomous ${kind} ingestion finished. Entities: ${(semanticProfile.entities ?? []).join(", ") || "none"}. Domain: ${semanticProfile.domain || "N/A"}.`,
      });

      // Update the agent's lastHeartbeatAt timestamp so the overview shows recent activity.
      await this.db
        .update(agents)
        .set({ lastHeartbeatAt: now })
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

      return run.id;
    } catch (e: any) {
      console.warn(`[OnboardingOrchestrator] Non-blocking heartbeat run recording failed: ${e?.message}`);
      return null;
    }
  }

  /**
   * Insert an activity_log entry for a completed ingestion, linked to the heartbeat run.
   * builtInKey is the paperclipBuiltInAgent.key string (e.g. "structured-ingestion").
   * agentId and runId must already be resolved by the caller.
   */
  private async logOnboardingActivity(
    companyId: string,
    builtInKey: string,
    agentId: string | null,
    runId: string | null,
    dataSourceId: string,
    name: string,
    kind: string,
    semanticProfile: DataSourceSemanticProfile,
  ) {
    try {
      const actorId = agentId ?? builtInKey;
      const agentLabel = semanticProfile.onboardedBy ?? builtInKey;

      await this.db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId,
        agentId,
        ...(runId ? { runId } : {}),
        action: `data_source.onboarded.${kind}`,
        entityType: "data_source",
        entityId: dataSourceId,
        details: {
          name,
          dataSourceName: name,
          kind,
          sourceType: kind,
          description: `${agentLabel} successfully onboarded and semantically mapped data source '${name}' using TypeSafe JEV System One DecisionSpecs (${(semanticProfile.decisionSpecRefs ?? []).join(", ")}).`,
          domain: semanticProfile.domain,
          entities: semanticProfile.entities,
          decisionSpecRefs: semanticProfile.decisionSpecRefs,
          targetAgentAffinity: semanticProfile.targetAgentAffinity,
        },
      });
    } catch (e: any) {
      console.warn(`[OnboardingOrchestrator] Non-blocking activity log failed: ${e?.message}`);
    }
  }
}
