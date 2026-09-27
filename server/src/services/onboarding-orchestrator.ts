import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
} from "@paperclipai/db";
import type { DataSource, DataSourceType, DatabaseConnectionConfig } from "@paperclipai/shared";
import { StructuredIngestionService } from "./structured-ingestion.js";
import { KnowledgeIngestionService } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService } from "./database-integration.js";
import { TypeSafeJevService } from "./typesafe-jev.js";

export interface OnboardingFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size?: number;
}

export class OnboardingOrchestratorService {
  private jevService: TypeSafeJevService;

  constructor(private db: Db) {
    this.jevService = new TypeSafeJevService();
  }

  /**
   * Main entrypoint for onboarding data sources
   */
  async onboardSource(
    companyId: string,
    file: OnboardingFileInput,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
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

    // 1. Create initial Data Source entry with 'onboarding' status
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
        metadata: {
          startedAt: new Date().toISOString(),
          extension: ext,
        },
      })
      .returning();

    try {
      if (sourceType === "csv" || sourceType === "excel") {
        // --- STRUCTURED INGESTION PIPELINE ---
        const tables =
          sourceType === "csv"
            ? [StructuredIngestionService.parseCsv(file.buffer.toString("utf-8"), defaultName)]
            : StructuredIngestionService.parseExcel(file.buffer);

        let totalRows = 0;
        const createdTables: any[] = [];

        for (const tableData of tables) {
          totalRows += tableData.rows.length;

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
              semanticModel: tableData.semanticModel as any,
            })
            .returning();

          createdTables.push(tableRow);

          // Batch insert rows (100 rows per batch)
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

        // Update status to 'ready'
        const [updated] = await this.db
          .update(dataSources)
          .set({
            status: "ready",
            metadata: {
              completedAt: new Date().toISOString(),
              tableCount: tables.length,
              totalRows,
              sheetNames: tables.map((t) => t.tableName),
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        return {
          ...updated,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          tables: createdTables,
        };
      } else {
        // --- KNOWLEDGE / RAG INGESTION PIPELINE ---
        const { chunks, totalWords } = KnowledgeIngestionService.processDocument(
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

        // Update status to 'ready'
        const [updated] = await this.db
          .update(dataSources)
          .set({
            status: "ready",
            metadata: {
              completedAt: new Date().toISOString(),
              chunkCount: chunks.length,
              totalWords,
            },
            updatedAt: new Date(),
          })
          .where(eq(dataSources.id, initialDs.id))
          .returning();

        return {
          ...updated,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          chunks: chunks as any[],
        };
      }
    } catch (err: any) {
      // Mark as error if ingestion fails
      const [failed] = await this.db
        .update(dataSources)
        .set({
          status: "error",
          metadata: {
            failedAt: new Date().toISOString(),
            error: err?.message || String(err),
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id))
        .returning();

      throw new Error(`Onboarding failed for ${file.originalname}: ${err.message}`);
    }
  }

  /**
   * Onboard an external database (PostgreSQL, MariaDB, MySQL)
   * Connects via native driver, inspects tables/columns/relations, builds semantic models, and indexes metadata.
   */
  async onboardDatabase(
    companyId: string,
    config: DatabaseConnectionConfig,
    options: { name?: string; description?: string } = {},
  ): Promise<DataSource> {
    const dbIntegration = new DatabaseIntegrationService();

    // 1. Verify connection
    const testResult = await dbIntegration.testConnection(config);
    if (!testResult.success) {
      throw new Error(`Failed to connect to ${config.type} database: ${testResult.error}`);
    }

    const defaultName =
      options.name?.trim() ||
      `${config.type.toUpperCase()} - ${config.database} (${config.host}:${config.port})`;

    // Mask password in stored connectionConfig for display
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
        },
      })
      .returning();

    try {
      // 3. Inspect database: extract tables, columns, relations, semantic models
      const tables = await dbIntegration.inspectDatabase(config);

      let totalRows = 0;
      const createdTables: any[] = [];

      for (const tableData of tables) {
        totalRows += tableData.rowCount;

        const [tableRow] = await this.db
          .insert(dataSourceTables)
          .values({
            dataSourceId: initialDs.id,
            companyId,
            tableName: tableData.tableName,
            rowCount: tableData.rowCount,
            columnCount: tableData.columnCount,
            schemaDefinition: tableData.schemaDefinition as any,
            semanticModel: tableData.semanticModel as any,
          })
          .returning();

        createdTables.push(tableRow);
      }

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
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id))
        .returning();

      return {
        ...updated,
        sourceType: updated.sourceType as any,
        status: updated.status as any,
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
}

