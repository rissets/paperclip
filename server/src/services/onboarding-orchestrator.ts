import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
  dataSourceJobs,
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
  DataSourceCollection,
} from "@paperclipai/shared";
import { StructuredIngestionService } from "./structured-ingestion.js";
import { KnowledgeIngestionService, type ParsedChunk } from "./knowledge-ingestion.js";
import { DatabaseIntegrationService, databaseConnectionErrorMessage } from "./database-integration.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { EnterpriseAgentRosterService } from "./enterprise-agent-roster.js";
import { DataSourceCollectionsService } from "./data-source-collections.js";
import { aiReasoningService } from "./ai-reasoning.js";
import { deleteDataSourceFile, storeDataSourceFile } from "./data-source-object-storage.js";
import { RagModelService, type EmbeddingSpace } from "./rag-models.js";
import { DataSourceVectorStore } from "./data-source-vector-store.js";
import { DataSourceDatabaseConfigService, databaseConfigWithoutPassword, publicDatabaseMetadata } from "./data-source-database-config.js";
import { assertDataSourceJobLease, DataSourceLeaseLostError, type DataSourceJobLease } from "./data-source-job-lease.js";
import { payloadTooLarge } from "../errors.js";
import { getCsvSourceRowCheckpoint } from "./data-source-stream-checkpoint.js";

const DEFAULT_MAX_COMPANY_FILE_STORAGE_BYTES = 100 * 1024 * 1024 * 1024;

function maxCompanyFileStorageBytes(): number {
  const raw = process.env.DATASOURCE_MAX_COMPANY_FILE_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_COMPANY_FILE_STORAGE_BYTES;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured < 0) {
    throw new Error("DATASOURCE_MAX_COMPANY_FILE_BYTES must be a non-negative safe integer");
  }
  return configured;
}

function getOnboardingFileByteSize(file: OnboardingFileInput): number {
  const actual = file.buffer?.byteLength ?? (file.filePath ? fs.statSync(file.filePath).size : undefined);
  const size = actual ?? file.size ?? 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw payloadTooLarge("Datasource file size is invalid");
  }
  return size;
}

export interface OnboardingFileInput {
  buffer?: Buffer;
  filePath?: string;
  originalname: string;
  mimetype?: string;
  size?: number;
}

export interface OnboardingOptions {
  name?: string;
  description?: string;
  async?: boolean;
  collectionId?: string;
  skipCorrelation?: boolean;
  deferReady?: boolean;
  jobLease?: DataSourceJobLease;
  /** Immutable source identity used to reject an unsafe parser resume after file replacement. */
  csvSourceFingerprint?: string;
  enforcePublicationGate?: boolean;
}

function jobScopedTableId(companyId: string, sourceId: string, jobId: string, tableName: string): string {
  const bytes = createHash("sha256")
    .update(`paperclip-datasource-job-table:v1:${companyId}:${sourceId}:${jobId}:${tableName}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type DurableCsvCheckpoint = {
  version: 1 | 2;
  identityHash: string;
  tableId: string;
  byteOffset: number;
  committedRows: number;
  sourceRowsCommitted?: number;
  insertedRows?: number;
  nextBatchIndex: number;
  delimiter: string | null;
};

function readDurableCsvCheckpoint(value: unknown): DurableCsvCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Partial<DurableCsvCheckpoint>;
  if ((checkpoint.version !== 1 && checkpoint.version !== 2)
    || typeof checkpoint.identityHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.identityHash)
    || typeof checkpoint.tableId !== "string" || !/^[0-9a-f-]{36}$/i.test(checkpoint.tableId)
    || !Number.isSafeInteger(checkpoint.byteOffset) || checkpoint.byteOffset! < 0
    || !Number.isSafeInteger(checkpoint.committedRows) || checkpoint.committedRows! < 0
    || !Number.isSafeInteger(checkpoint.nextBatchIndex) || checkpoint.nextBatchIndex! < 0
    || (checkpoint.version === 2 && (!Number.isSafeInteger(checkpoint.sourceRowsCommitted)
      || checkpoint.sourceRowsCommitted! < 0 || !Number.isSafeInteger(checkpoint.insertedRows)
      || checkpoint.insertedRows! < 0))
    || !(checkpoint.delimiter === null
      || (typeof checkpoint.delimiter === "string" && [",", ";", "\t", "|"].includes(checkpoint.delimiter)))) return null;
  return checkpoint as DurableCsvCheckpoint;
}

export class OnboardingOrchestratorService {
  private jevService: TypeSafeJevService;
  private rosterService: EnterpriseAgentRosterService;
  private collectionsService: DataSourceCollectionsService;

  constructor(private db: Db) {
    this.jevService = new TypeSafeJevService();
    this.rosterService = new EnterpriseAgentRosterService(db);
    this.collectionsService = new DataSourceCollectionsService(db);
  }

  private readFileBuffer(file: OnboardingFileInput): Buffer {
    if (file.buffer) return file.buffer;
    if (file.filePath) return fs.readFileSync(file.filePath);
    throw new Error(`File content is unavailable for ${file.originalname}`);
  }

  private async mutateFileStage<T>(companyId: string, sourceId: string, options: OnboardingOptions, action: (db: Db) => Promise<T>): Promise<T> {
    if (!options.jobLease) return action(this.db);
    return this.db.transaction(async (tx) => {
      await assertDataSourceJobLease(tx, companyId, sourceId, options.jobLease!);
      return action(tx as unknown as Db);
    });
  }

  /**
   * Main entrypoint for onboarding file data sources (Structured & RAG)
   */
  async onboardSource(
    companyId: string,
    file: OnboardingFileInput,
    options: OnboardingOptions = {},
  ): Promise<DataSource> {
    // 0. Ensure enterprise agent roster exists
    await this.rosterService.ensureEnterpriseRoster(companyId);

    const ext = file.originalname.split(".").pop()?.toLowerCase() || "";

    // Handle ZIP archives containing multiple structured/RAG files
    if (ext === "zip") {
      const zipRes = await this.onboardZip(companyId, file, options);
      if (zipRes.dataSources.length > 0) {
        return zipRes.dataSources[0];
      }
      throw new Error(`No valid data files found in ZIP archive: ${file.originalname}`);
    }

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
        const preview = file.buffer
          ? file.buffer.subarray(0, 800).toString("utf-8")
          : file.filePath
            ? fs.openSync(file.filePath, "r")
            : null;
        let previewText: string;
        if (typeof preview === "number") {
          const previewBuffer = Buffer.alloc(800);
          const bytesRead = fs.readSync(preview, previewBuffer, 0, previewBuffer.length, 0);
          fs.closeSync(preview);
          previewText = previewBuffer.subarray(0, bytesRead).toString("utf-8");
        } else {
          previewText = preview || "";
        }
        const classification = await this.jevService.systemOne(
          { fileName: file.originalname, snippet: previewText },
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
    const fileByteSize = getOnboardingFileByteSize(file);

    // 1. Persist the original bytes before creating a source record. In the
    // Compose data plane this is a company-scoped MinIO object; local installs
    // retain their existing disk behavior until they opt into S3 storage.
    let storagePath: string | null = null;
    let storageBackend: "s3" | "local_disk" | null = null;
    let storageSha256: string | undefined;
    const storedObject = await storeDataSourceFile({
      companyId,
      fileName: file.originalname,
      contentType: file.mimetype || "application/octet-stream",
      buffer: file.buffer,
      filePath: file.filePath,
    });
    if (storedObject) {
      storagePath = storedObject.objectKey;
      storageBackend = "s3";
      storageSha256 = storedObject.sha256;
    } else {
      try {
        const uploadDir = path.resolve(process.env.DATASOURCE_LOCAL_UPLOAD_DIRECTORY || path.join(process.cwd(), "data", "uploads"), companyId);
        fs.mkdirSync(uploadDir, { recursive: true });
        const targetPath = path.join(uploadDir, `${Date.now()}_${randomUUID()}_${path.basename(file.originalname)}`);
        if (file.filePath) fs.copyFileSync(file.filePath, targetPath, fs.constants.COPYFILE_EXCL);
        else fs.writeFileSync(targetPath, this.readFileBuffer(file), { flag: "wx" });
        storagePath = targetPath;
        storageBackend = "local_disk";
      } catch (error) {
        throw new Error(`Could not persist source file ${file.originalname}: ${error instanceof Error ? error.message : "storage error"}`);
      }
    }

    // 2. Insert initial entry
    let created: {
      initialDs: typeof dataSources.$inferSelect;
      job: typeof dataSourceJobs.$inferSelect | null;
    };
    try {
      created = await this.db.transaction(async (tx) => {
      const maxCompanyBytes = maxCompanyFileStorageBytes();
      // Serialize quota checks per company so simultaneous uploads across API
      // processes cannot both consume the same remaining capacity.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'datasource-file-quota:' + companyId}, 0))`);
      const usageRows = await tx.execute(sql<{ totalBytes: string }>`
        SELECT (
          COALESCE((SELECT sum(file_size) FROM data_sources
            WHERE company_id = ${companyId}::uuid AND storage_path IS NOT NULL), 0)
          + COALESCE((SELECT sum(expected_bytes) FROM data_source_upload_sessions
            WHERE company_id = ${companyId}::uuid
              AND status IN ('starting','uploading','completing','verifying')), 0)
        )::text AS "totalBytes"
      `);
      const [usage] = Array.from(usageRows as Iterable<{ totalBytes: string }>);
      const usedBytes = Number(usage?.totalBytes ?? 0);
      if (usedBytes + fileByteSize > maxCompanyBytes) {
        throw payloadTooLarge(
          `This company has reached its datasource file storage limit (${usedBytes} of ${maxCompanyBytes} bytes used)`,
          { usedBytes, requestedBytes: fileByteSize, maxBytes: maxCompanyBytes },
        );
      }
      const [source] = await tx
        .insert(dataSources)
        .values({
          companyId,
          collectionId: options.collectionId || null,
          name: defaultName,
          description: options.description || `Ingested from ${file.originalname}`,
          sourceType,
          status: "processing",
          fileName: file.originalname,
          fileSize: fileByteSize,
          mimeType: file.mimetype || "application/octet-stream",
          storagePath,
          metadata: {
            startedAt: new Date().toISOString(),
            extension: ext,
            storageBackend,
            storageSha256,
          },
        })
        .returning();
      if (!options.async) return { initialDs: source, job: null };
      const [queuedJob] = await tx
        .insert(dataSourceJobs)
        .values({
          companyId,
          dataSourceId: source.id,
          jobType: "ingest_file",
          status: "queued",
          stage: "queued",
          idempotencyKey: `file-ingest:${source.id}`,
        })
        .returning();
        return { initialDs: source, job: queuedJob };
      });
    } catch (error) {
      if (storagePath && storageBackend === "s3") {
        await deleteDataSourceFile(companyId, storagePath).catch(() => {});
      } else if (storagePath && storageBackend === "local_disk") {
        fs.rmSync(storagePath, { force: true });
      }
      throw error;
    }
    const { initialDs, job } = created;

    if (options.async) {
      return {
        ...initialDs,
        collectionId: initialDs.collectionId,
        sourceType: initialDs.sourceType as any,
        status: initialDs.status as any,
        tables: [],
        chunks: [],
        ingestionJob: job ? {
          id: job.id,
          status: job.status as any,
          stage: job.stage,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          progress: job.progress || {},
          lastError: job.lastError,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
        } : null,
      } as DataSource;
    }

    const streamingFormat = StructuredIngestionService.streamingFormatFor(sourceType, ext);
    let cleanupStagedInput: (() => Promise<void>) | null = null;
    try {
      let pipelineFile: OnboardingFileInput;
      if (streamingFormat && !file.filePath) {
        const staged = await StructuredIngestionService.stageBufferForStreaming(this.readFileBuffer(file), ext);
        cleanupStagedInput = staged.cleanup;
        pipelineFile = { ...file, buffer: undefined, filePath: staged.filePath };
      } else if (file.filePath) {
        pipelineFile = { ...file, buffer: undefined };
      } else {
        pipelineFile = { ...file, buffer: this.readFileBuffer(file) };
      }

      return await this.executeOnboardingPipeline(
        companyId,
        initialDs,
        pipelineFile,
        options,
        defaultName,
        ext,
        sourceType,
      );
    } finally {
      await cleanupStagedInput?.();
    }
  }

  /**
   * Onboard a ZIP archive containing multiple structured and RAG documents into a Collection
   */
  async onboardZip(
    companyId: string,
    file: OnboardingFileInput,
    options: OnboardingOptions = {},
  ): Promise<{ collection: DataSourceCollection; dataSources: DataSource[] }> {
    await this.rosterService.ensureEnterpriseRoster(companyId);

    let collectionId = options.collectionId;
    let collection: DataSourceCollection | null = null;

    if (collectionId) {
      collection = await this.collectionsService.getById(companyId, collectionId);
    }

    if (!collection) {
      const collectionName = options.name?.trim() || file.originalname.replace(/\.zip$/i, "");
      collection = await this.collectionsService.create(companyId, {
        name: collectionName,
        description: options.description || `Extracted from ${file.originalname}`,
      });
      collectionId = collection.id;
    }

    const extracted = await this.collectionsService.extractZipEntries(
      file.filePath ? { filePath: file.filePath } : { buffer: this.readFileBuffer(file) },
    );
    let onboardedSources: DataSource[] = [];
    try {
      if (extracted.entries.length === 0) {
        throw new Error(
          `No supported files found in ${file.originalname}. Supported formats: CSV, TSV, Excel, PDF, DOCX, TXT, MD, JSON.`,
        );
      }

      for (const entry of extracted.entries) {
        try {
          const ds = await this.onboardSource(companyId, {
            filePath: entry.filePath,
            originalname: entry.originalname,
            mimetype: entry.mimetype,
            size: entry.size,
          }, {
            collectionId,
            skipCorrelation: true,
            async: true,
          });
          onboardedSources.push(ds);
        } catch (err) {
          console.error(`[OnboardingOrchestrator] Error onboarding extracted file ${entry.originalname}:`, err);
        }
      }
    } finally {
      fs.rmSync(extracted.directory, { recursive: true, force: true });
    }

    // Register the collection now; workers correlate it again as each queued file publishes.
    if (collectionId) {
      try {
        await this.collectionsService.correlateCollection(companyId, collectionId);
      } catch (err) {
        console.error(`[OnboardingOrchestrator] Failed to correlate collection ${collectionId}:`, err);
      }
      collection = await this.collectionsService.getById(companyId, collectionId);
    }

    return {
      collection: collection!,
      dataSources: onboardedSources,
    };
  }

  private async executeOnboardingPipeline(
    companyId: string,
    initialDs: typeof dataSources.$inferSelect,
    file: OnboardingFileInput,
    options: OnboardingOptions,
    defaultName: string,
    ext: string,
    sourceType: DataSourceType,
  ): Promise<DataSource> {
    try {
      if (sourceType === "csv" || sourceType === "excel") {
        const sourceFileSize = file.size ?? file.buffer?.length ?? (file.filePath ? fs.statSync(file.filePath).size : 0);
        const streamingFormat = file.filePath
          ? StructuredIngestionService.streamingFormatFor(sourceType, ext)
          : null;
        const isStreamingCsv = streamingFormat === "csv";
        const isStreamingExcel = streamingFormat === "xlsx";
        const isStreamingStructuredFile = isStreamingCsv || isStreamingExcel;
        await options.jobLease?.reportProgress?.(isStreamingCsv ? "csv_profile" : sourceType === "excel" ? "excel_parse" : "csv_parse", {
          fileBytes: sourceFileSize,
        });
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

        const tables = isStreamingCsv
          ? [await StructuredIngestionService.profileCsvFile(file.filePath!, defaultName, {
            catalogMap,
            onProgress: (rowsScanned) => options.jobLease?.reportProgress?.("csv_profile", {
              fileBytes: sourceFileSize,
              rowsScanned,
            }),
          })]
          : isStreamingExcel
            ? await StructuredIngestionService.profileExcelFile(file.filePath!, {
              catalogMap,
              onProgress: (rowsScanned) => options.jobLease?.reportProgress?.("excel_parse", {
                fileBytes: sourceFileSize,
                rowsScanned,
              }),
            })
          : sourceType === "csv"
            ? [StructuredIngestionService.parseCsv(this.readFileBuffer(file).toString("utf-8"), defaultName, { catalogMap })]
            : StructuredIngestionService.parseExcel(this.readFileBuffer(file), { catalogMap });
        await options.jobLease?.reportProgress?.("semantic_mapping", {
          tableCount: tables.length,
          totalRows: tables.reduce((total, table) => total + (table.rowCount ?? table.rows.length), 0),
        });

        let totalRows = 0;
        let sourceRows = 0;
        let quarantinedRows = 0;
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

        for (const [tableIndex, tableData] of tables.entries()) {
          const sourceRowCount = tableData.rowCount ?? tableData.rows.length;
          const tableRowCount = tableData.publishableRowCount ?? sourceRowCount;
          totalRows += tableRowCount;
          sourceRows += sourceRowCount;
          quarantinedRows += Math.max(0, sourceRowCount - tableRowCount);
          await options.jobLease?.reportProgress?.("semantic_mapping", {
            tableIndex: tableIndex + 1,
            tableCount: tables.length,
            tableName: tableData.tableName,
            totalRows,
          });

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
              signal: options.jobLease?.signal,
            },
          );

          const aiAnalysis = aiLoopRes.validationStatus === "validated" ? aiLoopRes.result : null;
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
            // Large structured files keep only their bounded semantic preview
            // in PostgreSQL's JSONB compatibility table. Keep query routing
            // explicit so ClickHouse unavailability cannot masquerade as a
            // complete dataset through that preview.
            queryStore: isStreamingStructuredFile ? "clickhouse_primary" : "postgres_compatibility",
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
          const [tableRow] = await this.mutateFileStage(companyId, initialDs.id, options, (db) => db
            .insert(dataSourceTables)
            .values({
              ...(options.jobLease ? {
                id: jobScopedTableId(companyId, initialDs.id, options.jobLease.jobId, tableData.tableName),
              } : {}),
              dataSourceId: initialDs.id,
              companyId,
              tableName: tableData.tableName,
              rowCount: tableRowCount,
              columnCount: tableData.columns.length,
              schemaDefinition: tableData.columns as any,
              semanticModel: tableSemanticModel as any,
            })
            .returning());

          createdTables.push(tableRow);

          // Synthesize structured schema chunk for vector store retrieval
          const colList = (tableData.columns || []).map((c) => `${c.name} (${c.dataType || "string"}${c.role ? `, role: ${c.role}` : ""})`).join(", ");
          const metricList = (tableSemanticModel.metrics || []).map((m: any) => `${m.name || m}`).join(", ");
          const chunkContent = `Table: ${tableData.tableName}\nRole: ${tableSemanticModel.tableRole || "table"}\nColumns: ${colList}${metricList ? `\nMetrics: ${metricList}` : ""}`;
          await this.mutateFileStage(companyId, initialDs.id, options, (db) => db
            .insert(dataSourceChunks)
            .values({
              companyId,
              dataSourceId: initialDs.id,
              chunkIndex: tables.indexOf(tableData),
              title: `Schema: ${tableData.tableName}`,
              content: chunkContent,
              metadata: {
                corpusKind: "schema",
                tableId: tableRow.id,
                tableName: tableData.tableName,
              },
            })
          );

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
              await this.mutateFileStage(companyId, initialDs.id, options, (db) => db.insert(dataSourceRecords).values(values));
            }
          }

          // Sync to ClickHouse OLAP engine if DDL is present
          try {
            const chDdl = (tableSemanticModel as any)?.clickhouseSchema?.createTableDdl;
            if (chDdl) {
              const { ClickhouseService, clickhouseSourceTableName, rewriteClickhouseCreateTableName } = await import("./clickhouse.js");
              const clickhouse = new ClickhouseService();
              const sanitizedName = clickhouseSourceTableName(tableRow.id, tableData.tableName);
              const identifiedDdl = rewriteClickhouseCreateTableName(chDdl, sanitizedName);
              const identifiedModel = {
                ...tableSemanticModel,
                clickhouseTable: sanitizedName,
                clickhouseSchema: { ...(tableSemanticModel as any).clickhouseSchema, createTableDdl: identifiedDdl },
              };
              await this.mutateFileStage(companyId, initialDs.id, options, (db) => db
                .update(dataSourceTables)
                .set({ semanticModel: identifiedModel as any, updatedAt: new Date() })
                .where(and(eq(dataSourceTables.id, tableRow.id), eq(dataSourceTables.companyId, companyId))));
              tableRow.semanticModel = identifiedModel as any;
              if (isStreamingStructuredFile) {
                await options.jobLease?.reportProgress?.("clickhouse_insert", {
                  tableName: sanitizedName,
                  totalRows: tableRowCount,
                  insertedRows: 0,
                });
                let csvCheckpoint: DurableCsvCheckpoint | null = null;
                let csvIdentityHash: string | null = null;
                if (isStreamingCsv && options.jobLease) {
                  const tableSchemaFingerprint = createHash("sha256").update(JSON.stringify(tableData.columns.map((column) => ({
                    name: column.name,
                    dataType: column.dataType,
                    clickhouseType: column.clickhouseType,
                    role: column.role,
                    semanticCategory: column.semanticCategory,
                  })))).digest("hex");
                  csvIdentityHash = createHash("sha256").update(JSON.stringify({
                    version: 1,
                    jobId: options.jobLease.jobId,
                    tableId: tableRow.id,
                    sourceFingerprint: options.csvSourceFingerprint || `size:${sourceFileSize}`,
                    tableSchemaFingerprint,
                  })).digest("hex");
                  const previousCheckpoint = readDurableCsvCheckpoint(options.jobLease.progress?.csvCheckpoint);
                  if (options.jobLease.progress?.csvCheckpoint && !previousCheckpoint) {
                    throw new Error("Durable CSV resume checkpoint is malformed; enqueue a fresh ingestion job");
                  }
                  if (previousCheckpoint && (previousCheckpoint.tableId !== tableRow.id
                    || previousCheckpoint.identityHash !== csvIdentityHash)) {
                    throw new Error("CSV source or schema changed after its durable checkpoint; enqueue a fresh ingestion job");
                  }
                  csvCheckpoint = previousCheckpoint || {
                    version: 2,
                    identityHash: csvIdentityHash,
                    tableId: tableRow.id,
                    byteOffset: 0,
                    committedRows: 0,
                    sourceRowsCommitted: 0,
                    insertedRows: 0,
                    nextBatchIndex: 0,
                    delimiter: null,
                  };
                  if (!previousCheckpoint) {
                    await options.jobLease.reportProgress?.("csv_checkpoint", { csvCheckpoint });
                  }
                }
                const rowStream = isStreamingCsv
                  ? StructuredIngestionService.streamCsvRows(file.filePath!, tableData.columns, csvCheckpoint ? {
                    byteOffset: csvCheckpoint.byteOffset,
                    rowsCommitted: csvCheckpoint.sourceRowsCommitted ?? csvCheckpoint.committedRows,
                    delimiter: csvCheckpoint.delimiter || undefined,
                  } : undefined)
                  : StructuredIngestionService.streamExcelRows(
                    file.filePath!,
                    tableData.tableName,
                    tableData.columns,
                    undefined,
                    tableData.headerRowPresent,
                  );
                const runFencedOperation = options.jobLease
                  ? async (operation: () => Promise<void>) => this.db.transaction(async (tx) => {
                    await assertDataSourceJobLease(tx, companyId, initialDs.id, options.jobLease!);
                    await operation();
                    await assertDataSourceJobLease(tx, companyId, initialDs.id, options.jobLease!);
                  })
                  : undefined;
                const synced = await clickhouse.syncTableFromStream(
                  sanitizedName,
                  identifiedDdl,
                  rowStream,
                  companyId,
                  (insertedRows) => options.jobLease?.reportProgress?.("clickhouse_insert", {
                    tableName: sanitizedName,
                    totalRows: tableRowCount,
                    insertedRows,
                  }),
                  runFencedOperation
                    ? async (_insertedRows, publish) => runFencedOperation(publish)
                    : undefined,
                  options.jobLease
                    ? {
                      jobId: options.jobLease.jobId,
                      signal: options.jobLease.signal,
                      runFencedOperation,
                      ...(isStreamingCsv && csvCheckpoint ? {
                        startBatchIndex: csvCheckpoint.nextBatchIndex,
                        startInsertedCount: csvCheckpoint.insertedRows ?? csvCheckpoint.committedRows,
                        getRowCheckpoint: getCsvSourceRowCheckpoint,
                        onBatchCommitted: async (insertedRows, nextBatchIndex, sourceCheckpoint) => {
                          const rowCheckpoint = sourceCheckpoint as ReturnType<typeof getCsvSourceRowCheckpoint>;
                          const previousSourceRows = csvCheckpoint?.sourceRowsCommitted ?? csvCheckpoint?.committedRows ?? 0;
                          const previousInsertedRows = csvCheckpoint?.insertedRows ?? csvCheckpoint?.committedRows ?? 0;
                          if (!rowCheckpoint || rowCheckpoint.rowNumber < previousSourceRows
                            || insertedRows < previousInsertedRows || !csvIdentityHash) {
                            throw new Error("CSV parser did not provide a valid checkpoint for the committed ClickHouse batch");
                          }
                          const nextCheckpoint: DurableCsvCheckpoint = {
                            version: 2,
                            identityHash: csvIdentityHash,
                            tableId: tableRow.id,
                            byteOffset: rowCheckpoint.byteOffset,
                            committedRows: rowCheckpoint.rowNumber,
                            sourceRowsCommitted: rowCheckpoint.rowNumber,
                            insertedRows,
                            nextBatchIndex,
                            delimiter: rowCheckpoint.delimiter,
                          };
                          await options.jobLease!.reportProgress?.("csv_checkpoint", { csvCheckpoint: nextCheckpoint });
                          csvCheckpoint = nextCheckpoint;
                        },
                      } : {}),
                      beforePublish: () => options.jobLease!.reportProgress?.("publishing", {
                        tableName: sanitizedName,
                        insertedRows: tableRowCount,
                      }) ?? Promise.resolve(),
                      keepBatchTablesOnFailure: (error) => {
                        const cancellationRequested = options.jobLease!.isCancellationRequested?.() ?? false;
                        if (error instanceof DataSourceLeaseLostError) return !cancellationRequested;
                        if (cancellationRequested) return false;
                        return options.jobLease!.attempt < (options.jobLease!.maxAttempts ?? 3);
                      },
                    }
                    : undefined,
                );
                if (synced.insertedCount !== tableRowCount) {
                  throw new Error(`ClickHouse received ${synced.insertedCount} rows; expected ${tableRowCount}`);
                }
              } else {
                await clickhouse.syncTable(sanitizedName, identifiedDdl, tableData.rows, companyId);
              }
            }
          } catch (chErr: any) {
            if (isStreamingCsv || chErr instanceof DataSourceLeaseLostError) throw chErr;
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
            await this.mutateFileStage(companyId, initialDs.id, options, (db) => db
              .update(dataSourceTables)
              .set({
                semanticModel: {
                  ...currentModel,
                  relationships: tableRels,
                } as any,
              })
              .where(and(eq(dataSourceTables.id, createdTable.id), eq(dataSourceTables.companyId, companyId))));
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
          summary: `Dataset terstruktur berisikan ${tables.length} tabel: ${totalRows.toLocaleString()} baris valid dipublikasikan dari ${sourceRows.toLocaleString()} baris sumber; ${quarantinedRows.toLocaleString()} baris invalid dikarantina. Dianalisis dan dipetakan oleh ${specialistAgentName} (${inferredDomain || "Structured Data"}).`,
          onboardedAt: new Date().toISOString(),
          suggestedQueries: allSuggestedQueries,
          reasoningSteps: allReasoningSteps,
        };

        // Update status to 'ready' with semantic profile
        const completedMetadata = {
          ...((initialDs.metadata as Record<string, unknown> | null) || {}),
          completedAt: new Date().toISOString(),
          tableCount: tables.length,
          totalRows,
          sourceRows,
          quarantinedRows,
          sheetNames: tables.map((t) => t.tableName),
          onboardedBy: specialistAgentName,
          semanticProfile,
          onboardingReasoning: allReasoningSteps,
          suggestedQueries: allSuggestedQueries,
        };
        // Enforce publication gate check (mandatory by default)
        const rejectedTables = tables.filter((t) => t.semanticModel?.publicationGateStatus === "rejected");
        if (rejectedTables.length > 0 && options.enforcePublicationGate !== false) {
          const gateErrors = rejectedTables.flatMap((t) => t.semanticModel?.unresolvedDefinitions || []);
          await this.db
            .update(dataSources)
            .set({
              status: "failed",
              metadata: {
                ...completedMetadata,
                publicationGateErrors: gateErrors,
              },
              updatedAt: new Date(),
            })
            .where(and(eq(dataSources.id, initialDs.id), eq(dataSources.companyId, companyId)));
          throw new Error(`Publication gate rejected dataset: ${gateErrors.join("; ")}`);
        }

        const updated = options.deferReady ? initialDs : (await this.db
          .update(dataSources)
          .set({ status: "ready", metadata: completedMetadata, updatedAt: new Date() })
          .where(and(eq(dataSources.id, initialDs.id), eq(dataSources.companyId, companyId)))
          .returning())[0];

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

        const finalDs: DataSource = {
          ...updated,
          metadata: options.deferReady ? completedMetadata : updated.metadata,
          collectionId: updated.collectionId,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          semanticProfile,
          tables: createdTables,
        };

        if (options.collectionId && !options.skipCorrelation) {
          try {
            await this.collectionsService.correlateCollection(companyId, options.collectionId);
          } catch (err) {
            console.error(`[OnboardingOrchestrator] Failed to correlate collection ${options.collectionId}:`, err);
          }
        }

        return finalDs;
      } else {
        // --- 4. KNOWLEDGE / RAG INGESTION SPECIALIST PIPELINE ---
        await options.jobLease?.reportProgress?.("document_chunking", { fileBytes: file.size ?? 0 });
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

        const streamTextRag = Boolean(file.filePath)
          && KnowledgeIngestionService.isStreamableTextDocument(file.originalname);
        const streamBinaryRag = Boolean(file.filePath)
          && KnowledgeIngestionService.isStreamableBinaryDocument(file.originalname);
        const vectorStore = new DataSourceVectorStore(this.db);
        const ragModelService = new RagModelService();
        const embeddingBatchSize = 32;
        let embeddingSpace: EmbeddingSpace | null = null;
        let embeddingGeneration: string | null = null;
        let embeddingBackend: string | null = null;
        let embeddingAvailable = true;
        let insertedChunks = 0;
        let chunks: ParsedChunk[] = [];
        let totalWords = 0;
        let chunkCount = 0;
        let documentExtractionQuality: Record<string, unknown> | undefined;
        const persistChunkBatch = async (chunkBatch: ParsedChunk[]) => {
          let vectors: number[][] | null = null;
          if (embeddingAvailable) {
            const generated = await ragModelService.embed(
              chunkBatch.map((chunk) => chunk.content),
              embeddingSpace || undefined,
            );
            if (generated.vectors && generated.space) {
              if (!generated.generation) throw new Error("RAG embedding provider did not report a model generation");
              if (embeddingSpace && generated.space !== embeddingSpace) {
                throw new Error("RAG embedding provider changed model space during one document generation");
              }
              if (embeddingGeneration && generated.generation !== embeddingGeneration) {
                throw new Error("RAG embedding model revision changed during one document generation");
              }
              embeddingSpace = generated.space;
              embeddingGeneration = generated.generation;
              embeddingBackend = generated.backend;
              vectors = generated.vectors;
            } else {
              if (embeddingSpace) {
                throw new Error("RAG embedding provider became unavailable before this document generation completed");
              }
              embeddingAvailable = false;
            }
          }

          const chunkValues = chunkBatch.map((chunk, index) => ({
            dataSourceId: initialDs.id,
            companyId,
            chunkIndex: chunk.chunkIndex,
            title: chunk.title,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            metadata: {
              ...chunk.metadata,
              embeddingSpace,
              embeddingGeneration,
              embeddingBackend,
            },
            embedding: vectors?.[index] ?? null,
          }));
          await vectorStore.insertChunks(chunkValues, options.jobLease
            ? { companyId, sourceId: initialDs.id, lease: options.jobLease }
            : undefined);
          insertedChunks += chunkBatch.length;
          await options.jobLease?.reportProgress?.("vector_write", {
            ...(chunkCount > 0 ? { chunkCount } : {}),
            insertedChunks,
          });
        };

        if (streamTextRag) {
          const streamed = await KnowledgeIngestionService.processTextFile(
            file.filePath!,
            persistChunkBatch,
            { signal: options.jobLease?.signal, batchSize: embeddingBatchSize, sampleLimit: 100 },
          );
          chunks = streamed.sampleChunks;
          totalWords = streamed.totalWords;
          chunkCount = streamed.chunkCount;
        } else if (streamBinaryRag) {
          const streamed = await KnowledgeIngestionService.processDocumentFile(
            file.filePath!,
            file.originalname,
            persistChunkBatch,
            { signal: options.jobLease?.signal, batchSize: embeddingBatchSize, sampleLimit: 100 },
          );
          chunks = streamed.sampleChunks;
          totalWords = streamed.totalWords;
          chunkCount = streamed.chunkCount;
          documentExtractionQuality = streamed.extractionQuality;
        } else {
          const parsed = await KnowledgeIngestionService.processDocument(
            file.originalname,
            this.readFileBuffer(file),
            file.mimetype,
          );
          chunks = parsed.chunks;
          totalWords = parsed.totalWords;
          chunkCount = chunks.length;
          for (let offset = 0; offset < chunks.length; offset += embeddingBatchSize) {
            await persistChunkBatch(chunks.slice(offset, offset + embeddingBatchSize));
          }
        }
        await options.jobLease?.reportProgress?.("embedding", { chunkCount });
        await options.jobLease?.reportProgress?.("vector_write", { chunkCount, insertedChunks });

        // 4a. Execute Autonomous Semantic Document Analysis via Knowledge Ingestion Agent
        const semanticSampleChunks = chunks.slice(0, 100);
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
            signal: options.jobLease?.signal,
          },
        );

        const docAnalysis = aiDocRes.validationStatus === "validated" ? aiDocRes.result : null;
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
            semanticSampleChunks.map((c, idx) => ({ id: `chunk-${idx}`, title: c.title || undefined, content: c.content }))
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
            semanticSampleChunks.map((c, idx) => ({ id: `chunk-${idx}`, title: c.title || undefined, content: c.content })),
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
          summary: finalSummary || `Dokumen '${file.originalname}' (${chunkCount} chunks, ${totalWords} kata) dipetakan ke dalam basis pengetahuan RAG oleh ${specialistAgentName}.`,
            onboardedAt: new Date().toISOString(),
          suggestedQueries: finalQueries,
          reasoningSteps,
        };

        // Update status to 'ready' with semantic profile
        const completedMetadata = {
          ...((initialDs.metadata as Record<string, unknown> | null) || {}),
          completedAt: new Date().toISOString(),
          chunkCount,
          totalWords,
          embeddingSpace,
          embeddingGeneration,
          embeddingBackend,
          ...(documentExtractionQuality ? { documentExtractionQuality } : {}),
          embeddingStatus: embeddingAvailable && embeddingSpace ? "ready" : "unavailable",
          onboardedBy: specialistAgentName,
          semanticProfile,
          onboardingReasoning: reasoningSteps,
          suggestedQueries: finalQueries,
        };
        const updated = options.deferReady ? initialDs : (await this.db
          .update(dataSources)
          .set({ status: "ready", metadata: completedMetadata, updatedAt: new Date() })
          .where(and(eq(dataSources.id, initialDs.id), eq(dataSources.companyId, companyId)))
          .returning())[0];

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

        const finalDs: DataSource = {
          ...updated,
          metadata: options.deferReady ? completedMetadata : updated.metadata,
          collectionId: updated.collectionId,
          sourceType: updated.sourceType as any,
          status: updated.status as any,
          semanticProfile,
          chunks: chunks.slice(0, 10) as any[],
        };

        if (options.collectionId && !options.skipCorrelation) {
          try {
            await this.collectionsService.correlateCollection(companyId, options.collectionId);
          } catch (err) {
            console.error(`[OnboardingOrchestrator] Failed to correlate collection ${options.collectionId}:`, err);
          }
        }

        return finalDs;
      }
    } catch (err: any) {
      if (!options.deferReady) {
        await this.db.update(dataSources).set({
          status: "error",
          metadata: { failedAt: new Date().toISOString(), error: err?.message || String(err) },
          updatedAt: new Date(),
        }).where(and(eq(dataSources.id, initialDs.id), eq(dataSources.companyId, companyId)));
      }

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
    options: { name?: string; description?: string; async?: boolean } = {},
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

    const sanitizedConfig = databaseConfigWithoutPassword(config);
    const sourceId = randomUUID();
    const credentials = new DataSourceDatabaseConfigService(this.db);
    const persistedConfig = await credentials.prepare(companyId, sourceId, config);

    // 2. Create initial data source record
    const [initialDs] = await this.db
      .insert(dataSources)
      .values({
        id: sourceId,
        companyId,
        name: defaultName,
        description:
          options.description ||
          `External ${config.type.toUpperCase()} database connection to ${config.database} on ${config.host}`,
        sourceType: config.type,
        status: "processing",
        metadata: {
          startedAt: new Date().toISOString(),
          ...persistedConfig,
          serverVersion: testResult.version,
          onboardedBy: specialistAgentName,
        },
      })
      .returning().catch(async (error) => {
        await credentials.archivePrepared(companyId, persistedConfig);
        throw error;
      });

    // 3. Enqueue durable external DB onboarding job in dataSourceJobs
    const idempotencyKey = `external-db-onboarding:${companyId}:${sourceId}:v1`;
    await this.db.insert(dataSourceJobs).values({
      companyId,
      dataSourceId: sourceId,
      jobType: "external_db_onboarding",
      status: "queued",
      stage: "queued",
      idempotencyKey,
      progress: {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        specialistAgentId,
        specialistAgentName,
        agentModel,
        agentInstructions,
        adapterType: databaseIngestionAgent?.adapterType,
      },
    });

    if (options.async === false) {
      const { DataSourceIngestionWorker } = await import("./data-source-ingestion-worker.js");
      const worker = new DataSourceIngestionWorker(this.db, "external_db_onboarding");
      await worker.tick();
    }

    return {
      ...initialDs,
      metadata: publicDatabaseMetadata(initialDs.metadata),
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

      // 2. Execute Autonomous Relational Schema Analysis via Database Ingestion Agent per table & column batch
      const schemaFingerprint = createHash("sha256")
        .update(
          tables
            .map((t) => {
              const schemaPrefix = t.schemaName ? `${t.schemaName}.` : "public.";
              const colSig = (t.schemaDefinition || [])
                .map((c) => `${c.name}:${c.dataType}:${c.nativeType || ""}:${c.isPrimaryKey ? "PK" : ""}:${c.isForeignKey ? "FK" : ""}`)
                .sort()
                .join(",");
              return `${schemaPrefix}${t.tableName}:${t.rowCount}:${colSig}`;
            })
            .sort()
            .join("|"),
        )
        .digest("hex")
        .slice(0, 32);

      // Invalidate existing checkpoint if schema fingerprint has changed
      const existingCheckpoint = (initialDs.metadata as any)?.onboardingCheckpoint;
      let resumedCheckpoint = existingCheckpoint;
      if (existingCheckpoint && existingCheckpoint.schemaFingerprint !== schemaFingerprint) {
        console.log(`[onboarding-orchestrator] Schema fingerprint changed from ${existingCheckpoint.schemaFingerprint} to ${schemaFingerprint}. Invalidating stale checkpoint.`);
        resumedCheckpoint = null;
      }
      const completedBatchKeys = new Set<string>(resumedCheckpoint?.completedBatchKeys || []);

      let finalDomain = resumedCheckpoint?.finalDomain || `${config.type.toUpperCase()} Relational Database`;
      const finalEntities: string[] = [...(resumedCheckpoint?.finalEntities || [])];
      const finalTopics: string[] = [...(resumedCheckpoint?.finalTopics || [])];
      const tableRoles: Record<string, string> = { ...(resumedCheckpoint?.tableRoles || {}) };
      const relationships: any[] = [...(resumedCheckpoint?.relationships || [])];
      const suggestedQueries: any[] = [...(resumedCheckpoint?.suggestedQueries || [])];
      const reasoningSteps: any[] = [...(resumedCheckpoint?.reasoningSteps || [])];
      const tableProfiles: Record<string, any> = { ...(resumedCheckpoint?.tableProfiles || {}) };
      const crossTableClusters: any[] = [...(resumedCheckpoint?.crossTableClusters || [])];

      for (const pt of tables) {
        const qualifiedName = `${pt.schemaName || "public"}.${pt.tableName}`;
        const allCols = pt.schemaDefinition || [];
        const BATCH_SIZE = 20;

        for (let i = 0; i < allCols.length; i += BATCH_SIZE) {
          const batchKey = `${qualifiedName}:${i}:${i + BATCH_SIZE}`;
          if (completedBatchKeys.has(batchKey)) {
            continue;
          }
          const colBatch = allCols.slice(i, i + BATCH_SIZE);
          let batchSuccess = false;
          try {
            const aiDbRes = await aiReasoningService.analyzeDatabaseSchema(
              config.type,
              config.database,
              [{
                tableName: pt.tableName,
                rowCount: pt.rowCount,
                columns: colBatch.map((c) => ({
                  name: c.name,
                  dataType: c.dataType,
                  isPrimary: c.isPrimaryKey,
                  isForeign: c.isForeignKey,
                })),
              }],
              {
                agentName: specialistAgentName,
                model: agentModel,
                instructionsPath: agentInstructions,
                adapterType,
                allowDatabaseObservations: false,
              },
            );

            if (aiDbRes?.result && aiDbRes.validationStatus === "validated") {
              finalDomain = aiDbRes.result.domain || finalDomain;
              if (aiDbRes.result.entities) finalEntities.push(...aiDbRes.result.entities);
              if (aiDbRes.result.primaryTopics) finalTopics.push(...aiDbRes.result.primaryTopics);
              if (aiDbRes.result.tableRoles?.[pt.tableName]) tableRoles[pt.tableName] = aiDbRes.result.tableRoles[pt.tableName];
              if (aiDbRes.result.relationships) relationships.push(...aiDbRes.result.relationships);
              if (aiDbRes.result.suggestedQueries) suggestedQueries.push(...aiDbRes.result.suggestedQueries);

              // Observation -> Validation -> Correction loop:
              // Merge column profiles safely instead of overwriting prior batch profiles!
              if (aiDbRes.result.tableProfiles?.[pt.tableName]) {
                const existing = tableProfiles[pt.tableName] || {};
                const incoming = aiDbRes.result.tableProfiles[pt.tableName];
                tableProfiles[pt.tableName] = {
                  ...existing,
                  ...incoming,
                  metrics: Array.from(new Set([...(existing.metrics || []), ...(incoming.metrics || [])])),
                  dimensions: Array.from(new Set([...(existing.dimensions || []), ...(incoming.dimensions || [])])),
                };
              }
              if (aiDbRes.result.crossTableClusters) crossTableClusters.push(...aiDbRes.result.crossTableClusters);
              if (Array.isArray(aiDbRes.reasoningSteps)) reasoningSteps.push(...aiDbRes.reasoningSteps);
              batchSuccess = true;
            } else {
              throw new Error("Database schema mapping did not pass validation");
            }
          } catch {
            // Apply deterministic JEV correction for this batch
            try {
              const batchSummary = [{
                name: pt.tableName,
                columns: colBatch.map((c) => c.name),
                rowCount: pt.rowCount,
              }];
              const fallbackRes = await this.jevService.evaluateDatabaseTables(batchSummary);
              if (fallbackRes.entities) finalEntities.push(...fallbackRes.entities);
              if (fallbackRes.tableRoles?.[pt.tableName] && !tableRoles[pt.tableName]) {
                tableRoles[pt.tableName] = fallbackRes.tableRoles[pt.tableName];
              }
              if (fallbackRes.tableProfiles?.[pt.tableName]) {
                const existing = tableProfiles[pt.tableName] || {};
                const incoming = fallbackRes.tableProfiles[pt.tableName];
                tableProfiles[pt.tableName] = {
                  ...existing,
                  ...incoming,
                  metrics: Array.from(new Set([...(existing.metrics || []), ...(incoming.metrics || [])])),
                  dimensions: Array.from(new Set([...(existing.dimensions || []), ...(incoming.dimensions || [])])),
                };
              }
              batchSuccess = true;
            } catch {
              // Batch could not be analyzed; keep batchSuccess = false
            }
          }

          if (batchSuccess) {
            completedBatchKeys.add(batchKey);
          }
        }
      }

      // Fallback to TypeSafe JEV System One if AI reasoning is offline
      if (finalEntities.length === 0) {
        const tableSummaries = tables.map((t) => ({
          name: t.tableName,
          columns: t.schemaDefinition.map((c) => c.name),
          rowCount: t.rowCount,
        }));
        const dbSemanticRes = await this.jevService.evaluateDatabaseTables(tableSummaries);
        finalEntities.push(...dbSemanticRes.entities);
        Object.assign(tableRoles, dbSemanticRes.tableRoles);
        relationships.push(...dbSemanticRes.relationships);
        finalTopics.push(...dbSemanticRes.primaryTopics);
        suggestedQueries.push(...dbSemanticRes.suggestedQueries);
        Object.assign(tableProfiles, dbSemanticRes.tableProfiles || {});
        crossTableClusters.push(...(dbSemanticRes.crossTableClusters || []));
        if (dbSemanticRes.reasoningSteps) reasoningSteps.push(...dbSemanticRes.reasoningSteps);
      }

      const summary = `Basis data relasional (${config.type}) dengan ${tables.length} tabel terhubung dan dipetakan oleh ${specialistAgentName}.`;

      for (const tableData of tables) {
        totalRows += tableData.rowCount;

        const tProf = tableProfiles[tableData.tableName];
        // Enhance table semantic model with agent's analyzed table role and per-table topics
        const tableSemantic = {
          ...tableData.semanticModel,
          sourceSchema: tableData.schemaName,
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
            const { ClickhouseService, clickhouseSourceTableName, rewriteClickhouseCreateTableName } = await import("./clickhouse.js");
            const clickhouse = new ClickhouseService();
            const sanitizedName = clickhouseSourceTableName(tableRow.id, tableData.tableName);
            const identifiedDdl = rewriteClickhouseCreateTableName(chDdl, sanitizedName);
            const identifiedModel = {
              ...tableSemantic,
              clickhouseTable: sanitizedName,
              clickhouseSchema: { ...(tableSemantic as any).clickhouseSchema, createTableDdl: identifiedDdl },
            };
            await this.db
              .update(dataSourceTables)
              .set({ semanticModel: identifiedModel as any, updatedAt: new Date() })
              .where(eq(dataSourceTables.id, tableRow.id));
            await clickhouse.syncTable(sanitizedName, identifiedDdl, undefined, companyId);
          }
        } catch (chErr: any) {
          console.warn(`[ClickhouseSync] Optional DB schema sync skipped: ${chErr.message}`);
        }

        // Synthesize structured schema chunk for vector store retrieval
        try {
          const cols = (tableData.schemaDefinition as any[]) || [];
          const colText = cols.map((c: any) => `${c.name} (${c.dataType || "string"}${c.role ? `, role: ${c.role}` : ""})`).join(", ");
          const metricText = ((tableData.semanticModel as any)?.metrics || []).map((m: any) => `${m.name || m}`).join(", ");
          const content = `Table: ${tableData.tableName}\nRole: ${tableSemantic.tableRole}\nColumns: ${colText}${metricText ? `\nMetrics: ${metricText}` : ""}`;
          let embeddingVector: number[] | null = null;
          let embeddingSpace: string | null = null;
          try {
            const ragModel = new RagModelService();
            const embedded = await ragModel.embed([content]);
            if (embedded.vectors?.[0] && embedded.space) {
              embeddingVector = embedded.vectors[0];
              embeddingSpace = embedded.space;
            }
          } catch {
            // Graceful fallback
          }
          const vectorStore = new DataSourceVectorStore(this.db);
          const ragModel = new RagModelService();
          const embeddingGeneration = embeddingSpace ? ragModel.embeddingGeneration(embeddingSpace as any) : undefined;
          await vectorStore.insertChunks([{
            companyId,
            dataSourceId: initialDs.id,
            chunkIndex: tables.indexOf(tableData),
            title: `Schema: ${tableData.tableName}`,
            content,
            embedding: embeddingVector,
            metadata: {
              corpusKind: "schema",
              tableId: tableRow?.id,
              tableName: tableData.tableName,
              ...(embeddingSpace ? { embeddingSpace, embeddingGeneration } : {}),
            },
          }]);
        } catch {
          // Safe fallback
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
            ...initialDs.metadata,
            connectionConfig: sanitizedConfig,
            rawConfig: databaseConfigWithoutPassword(config),
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
            ...initialDs.metadata,
            failedAt: new Date().toISOString(),
            error: databaseConnectionErrorMessage(err, config),
            connectionConfig: sanitizedConfig,
          },
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, initialDs.id));

      console.error(`[onboarding-orchestrator] Error during database onboarding for ${defaultName}:`, databaseConnectionErrorMessage(err, config));
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
