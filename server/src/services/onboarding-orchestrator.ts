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
} from "@paperclipai/shared";
import { StructuredIngestionService } from "./structured-ingestion.js";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { EnterpriseAgentRosterService } from "./enterprise-agent-roster.js";

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
    options: { name?: string; description?: string } = {},
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

    try {
      if (sourceType === "csv" || sourceType === "excel") {
        // --- 3. STRUCTURED INGESTION SPECIALIST PIPELINE ---
        const specialistAgent = "StructuredIngestionAgent";

        const tables =
          sourceType === "csv"
            ? [StructuredIngestionService.parseCsv(file.buffer.toString("utf-8"), defaultName)]
            : StructuredIngestionService.parseExcel(file.buffer);

        let totalRows = 0;
        const createdTables: any[] = [];
        const allEntities = new Set<string>();
        const allMetrics: SemanticMetric[] = [];
        const allDimensions: SemanticDimension[] = [];

        for (const tableData of tables) {
          totalRows += tableData.rows.length;

          // 3a. TypeSafe JEV System One DecisionSpec: struct.column_role
          const columnRoles = await this.jevService.evaluateColumnRoles(
            tableData.tableName,
            tableData.columns.map((c) => ({
              name: c.name,
              sampleValues: c.sampleValues,
              distinctCount: c.distinctCount,
              nullRatio: c.nullRatio,
            })),
          );

          // Update column roles in schema definition
          for (const col of tableData.columns) {
            if (columnRoles[col.name]) {
              col.role = columnRoles[col.name];
            }
          }

          // 3b. TypeSafe JEV System One DecisionSpec: struct.entity_metric_mapping
          const metricCols = tableData.columns.filter((c) => c.role === "metric").map((c) => c.name);
          const colNames = tableData.columns.map((c) => c.name);

          const { entities, primaryMetrics, syncStrategy } = await this.jevService.evaluateEntityAndMetrics(
            tableData.tableName,
            colNames,
            metricCols,
          );

          entities.forEach((e) => allEntities.add(e));
          allMetrics.push(...primaryMetrics);

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
            metrics: primaryMetrics.map((m) => ({
              name: m.name,
              expression: m.column,
              description: `Metric ${m.name} aggregated via ${m.aggregation}`,
              aggregation: m.aggregation,
            })),
            dimensions: tableData.columns
              .filter((c) => c.role === "dimension")
              .map((c) => ({ name: c.name, description: `Dimension ${c.name}`, sampleValues: c.sampleValues.map(String).slice(0, 4) })),
            syncStrategy,
            mappedBy: specialistAgent,
            decisionSpecs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1", "struct.sync_strategy.v1"],
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
        }

        // 3c. Synthesize Top-Level DataSource Semantic Profile
        const semanticProfile: DataSourceSemanticProfile = {
          version: "1.0.0",
          onboardedBy: specialistAgent,
          decisionSpecRefs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1", "struct.sync_strategy.v1"],
          domain: Array.from(allEntities).join(", ") || defaultName,
          targetAgentAffinity: "data_agent",
          entities: Array.from(allEntities),
          metrics: allMetrics,
          dimensions: allDimensions.slice(0, 10),
          summary: `Dataset terstruktur berisikan ${tables.length} tabel dengan total ${totalRows.toLocaleString()} baris. Dipetakan oleh ${specialistAgent} menggunakan TypeSafe JEV System One.`,
          onboardedAt: new Date().toISOString(),
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
              onboardedBy: specialistAgent,
              semanticProfile,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        // 3d. Record Agent Activity Log
        await this.logOnboardingActivity(companyId, specialistAgent, initialDs.id, defaultName, "structured", semanticProfile);

        return {
          ...updated,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          semanticProfile,
          tables: createdTables,
        };
      } else {
        // --- 4. KNOWLEDGE / RAG INGESTION SPECIALIST PIPELINE ---
        const specialistAgent = "KnowledgeIngestionAgent";

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

        // 4a. TypeSafe JEV System One DecisionSpecs: rag.domain_classify, rag.target_agent_affinity, rag.key_topics
        const sampleText = chunks.slice(0, 3).map((c) => c.content).join("\n\n") || file.originalname;
        const domainResult = await this.jevService.evaluateDocumentDomain(file.originalname, sampleText);

        // 4b. Synthesize Knowledge Semantic Profile
        const semanticProfile: DataSourceSemanticProfile = {
          version: "1.0.0",
          onboardedBy: specialistAgent,
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.target_agent_affinity.v1", "rag.passage_relevance.v1"],
          domain: domainResult.domain,
          targetAgentAffinity: domainResult.targetAgentAffinity,
          entities: domainResult.entities,
          primaryTopics: domainResult.primaryTopics,
          summary: domainResult.summary,
          onboardedAt: new Date().toISOString(),
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
              onboardedBy: specialistAgent,
              semanticProfile,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        // 4c. Record Agent Activity Log
        await this.logOnboardingActivity(companyId, specialistAgent, initialDs.id, defaultName, "knowledge", semanticProfile);

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
    const specialistAgent = "DatabaseIntegrationAgent";

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
          onboardedBy: specialistAgent,
        },
      })
      .returning();

    try {
      // 3. Inspect database: extract tables, columns, relations
      const tables = await dbIntegration.inspectDatabase(config);

      let totalRows = 0;
      const createdTables: any[] = [];

      // 3a. TypeSafe JEV System One: db.table_role & db.join_candidates
      const tableSummaries = tables.map((t) => ({
        name: t.tableName,
        columns: t.schemaDefinition.map((c) => c.name),
        rowCount: t.rowCount,
      }));

      const dbSemanticRes = await this.jevService.evaluateDatabaseTables(tableSummaries);

      for (const tableData of tables) {
        totalRows += tableData.rowCount;

        // Enhance table semantic model
        const tableSemantic = {
          ...tableData.semanticModel,
          tableRole: dbSemanticRes.tableRoles[tableData.tableName] || "dimension_table",
          mappedBy: specialistAgent,
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
      }

      // 3b. Synthesize Database Semantic Profile
      const semanticProfile: DataSourceSemanticProfile = {
        version: "1.0.0",
        onboardedBy: specialistAgent,
        decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1"],
        domain: "relational_database",
        targetAgentAffinity: "data_agent",
        entities: dbSemanticRes.entities,
        tableRoles: dbSemanticRes.tableRoles,
        relationships: dbSemanticRes.relationships,
        summary: `Basis data relasional (${config.type}) dengan ${tables.length} tabel terhubung dan dipetakan oleh ${specialistAgent} menggunakan TypeSafe JEV System One.`,
        onboardedAt: new Date().toISOString(),
      };

      // 4. Update data source status to 'ready'
      const [updated] = await this.db
        .update(dataSources)
        .set({
          status: "ready",
          metadata: {
            completedAt: new Date().toISOString(),
            connectionConfig: sanitizedConfig,
            rawConfig: config,
            serverVersion: testResult.version,
            tableCount: tables.length,
            totalRows,
            tables: tables.map((t) => t.tableName),
            onboardedBy: specialistAgent,
            semanticProfile,
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id))
        .returning();

      // 5. Record Activity Log
      await this.logOnboardingActivity(companyId, specialistAgent, initialDs.id, defaultName, "database", semanticProfile);

      return {
        ...updated,
        sourceType: updated.sourceType as any,
        status: updated.status as any,
        semanticProfile,
        tables: createdTables,
      };
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

      throw new Error(`Database onboarding failed: ${err.message}`);
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
    const specialistAgent = "ApiIntegrationAgent";

    const defaultName = options.name?.trim() || `API - ${new URL(config.baseUrl).hostname}`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: specialistAgent,
      decisionSpecRefs: ["api.operation_class.v1", "api.intent_to_tool.v1"],
      domain: "rest_api",
      targetAgentAffinity: "action_agent",
      entities: [defaultName],
      summary: `REST API endpoint '${config.baseUrl}' dipetakan oleh ${specialistAgent} menggunakan TypeSafe JEV System One.`,
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
          onboardedBy: specialistAgent,
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, specialistAgent, created.id, defaultName, "api", semanticProfile);

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
    const specialistAgent = "IotIntegrationAgent";

    const defaultName = options.name?.trim() || `MQTT Broker (${config.brokerUrl})`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: specialistAgent,
      decisionSpecRefs: ["iot.topic_classification.v1", "iot.quarantined_triage.v1"],
      domain: "iot_telemetry",
      targetAgentAffinity: "data_agent",
      entities: config.topics,
      summary: `MQTT IoT stream dengan ${config.topics.length} topik dipetakan oleh ${specialistAgent} menggunakan TypeSafe JEV System One.`,
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
          onboardedBy: specialistAgent,
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, specialistAgent, created.id, defaultName, "iot", semanticProfile);

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
    const specialistAgent = "CctvIntegrationAgent";

    const defaultName = options.name?.trim() || `CCTV - ${config.cameraName}`;

    const semanticProfile: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: specialistAgent,
      decisionSpecRefs: ["cctv.event_severity.v1", "cctv.escalation_action.v1"],
      domain: "cctv_surveillance",
      targetAgentAffinity: "vision_agent",
      entities: [config.cameraName, config.location || "Perimeter"],
      summary: `Feed kamera CCTV '${config.cameraName}' dipetakan oleh ${specialistAgent} menggunakan TypeSafe JEV System One.`,
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
          onboardedBy: specialistAgent,
          semanticProfile,
        },
      })
      .returning();

    await this.logOnboardingActivity(companyId, specialistAgent, created.id, defaultName, "cctv", semanticProfile);

    return {
      ...created,
      sourceType: created.sourceType as any,
      status: created.status as any,
      semanticProfile,
    };
  }

  private async logOnboardingActivity(
    companyId: string,
    agentName: string,
    dataSourceId: string,
    name: string,
    kind: string,
    semanticProfile: DataSourceSemanticProfile,
  ) {
    try {
      await this.db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentName,
        action: `data_source.onboarded.${kind}`,
        entityType: "data_source",
        entityId: dataSourceId,
        details: {
          description: `${agentName} successfully onboarded and semantically mapped data source '${name}' using TypeSafe JEV System One DecisionSpecs (${semanticProfile.decisionSpecRefs.join(", ")}).`,
          domain: semanticProfile.domain,
          entities: semanticProfile.entities,
          decisionSpecRefs: semanticProfile.decisionSpecRefs,
          targetAgentAffinity: semanticProfile.targetAgentAffinity,
        },
      });
    } catch {
      // Activity logging is non-blocking
    }
  }
}
