import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSourceCollections,
  dataSources,
  dataSourceTables,
  dataSourceRecords,
  dataSourceChunks,
  activityLog,
} from "@paperclipai/db";
import type {
  DataSourceCollection,
  CollectionSemanticProfile,
  DataSource,
  TableRelation,
  CrossDocumentCorrelation,
  CrossModalCorrelation,
  UnifiedClickhouseView,
  SuggestedQueryTemplate,
} from "@paperclipai/shared";
import { badRequest, payloadTooLarge } from "../errors.js";
import { ClickhouseService } from "./clickhouse.js";
import { analyzeTemporalOverlaps } from "./data-source-temporal-overlap.js";

const require = createRequire(import.meta.url);
type ZipEntryStream = NodeJS.ReadableStream & AsyncIterable<Buffer> & {
  path: string;
  type: string;
  vars?: { uncompressedSize?: number };
};
type ZipParserStream = NodeJS.ReadableStream & AsyncIterable<ZipEntryStream> & {
  destroy(error?: Error): ZipParserStream;
};
const unzipper = require("unzipper") as {
  Parse(options?: { forceStream?: boolean }): NodeJS.ReadWriteStream & ZipParserStream;
};

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_EXTRACTED_FILES = 500;
const DEFAULT_MAX_ZIP_EXPANDED_BYTES = GiB;
const MAX_ZIP_EXPANDED_BYTES = 2 * GiB;
const MAX_COLLECTION_VIEWS = 100;

export class DataSourceCollectionsService {
  constructor(private db: Db, private clickhouse = new ClickhouseService()) {}

  /**
   * Helper to generate a URL-safe slug from a collection name
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "collection";
  }

  /**
   * List all data source collections for a company with item counts and summary statistics
   */
  async list(companyId: string): Promise<DataSourceCollection[]> {
    const collections = await this.db
      .select()
      .from(dataSourceCollections)
      .where(eq(dataSourceCollections.companyId, companyId))
      .orderBy(desc(dataSourceCollections.createdAt));

    if (collections.length === 0) return [];

    // Aggregate by collection in the database. The old implementation issued
    // three queries per collection and loaded every table/chunk ID just to
    // display counts on the datasource landing page.
    const [sourceCounts, tableCounts, chunkCounts] = await Promise.all([
      this.db.select({
        collectionId: dataSources.collectionId,
        dataSourceCount: sql<number>`count(*)`,
        documentCount: sql<number>`count(*) filter (where ${dataSources.sourceType} = 'rag_document')`,
      })
        .from(dataSources)
        .where(eq(dataSources.companyId, companyId))
        .groupBy(dataSources.collectionId),
      this.db.select({
        collectionId: dataSources.collectionId,
        tableCount: sql<number>`count(${dataSourceTables.id})`,
        totalRows: sql<number | string>`coalesce(sum(${dataSourceTables.rowCount}), 0)`,
      })
        .from(dataSources)
        .leftJoin(dataSourceTables, and(
          eq(dataSourceTables.dataSourceId, dataSources.id),
          eq(dataSourceTables.companyId, companyId),
        ))
        .where(eq(dataSources.companyId, companyId))
        .groupBy(dataSources.collectionId),
      this.db.select({
        collectionId: dataSources.collectionId,
        totalChunks: sql<number>`count(${dataSourceChunks.id})`,
      })
        .from(dataSources)
        .leftJoin(dataSourceChunks, and(
          eq(dataSourceChunks.dataSourceId, dataSources.id),
          eq(dataSourceChunks.companyId, companyId),
        ))
        .where(eq(dataSources.companyId, companyId))
        .groupBy(dataSources.collectionId),
    ]);
    const sourceCountByCollection = new Map(sourceCounts.map((row) => [row.collectionId, row]));
    const tableCountByCollection = new Map(tableCounts.map((row) => [row.collectionId, row]));
    const chunkCountByCollection = new Map(chunkCounts.map((row) => [row.collectionId, row]));

    return collections.map((col) => {
      const sourceCountsForCollection = sourceCountByCollection.get(col.id);
      const tableCountsForCollection = tableCountByCollection.get(col.id);
      const chunkCountsForCollection = chunkCountByCollection.get(col.id);
      return {
        ...col,
        semanticProfile: (col.semanticProfile as unknown as CollectionSemanticProfile) || null,
        metadata: col.metadata as Record<string, unknown> | null,
        dataSourceCount: Number(sourceCountsForCollection?.dataSourceCount || 0),
        tableCount: Number(tableCountsForCollection?.tableCount || 0),
        documentCount: Number(sourceCountsForCollection?.documentCount || 0),
        totalRows: Number(tableCountsForCollection?.totalRows || 0),
        totalChunks: Number(chunkCountsForCollection?.totalChunks || 0),
      };
    });
  }

  /**
   * Get single collection by ID with full details, member sources, and semantic profile
   */
  async getById(companyId: string, id: string): Promise<DataSourceCollection | null> {
    const [col] = await this.db
      .select()
      .from(dataSourceCollections)
      .where(and(eq(dataSourceCollections.id, id), eq(dataSourceCollections.companyId, companyId)));

    if (!col) return null;

    // Fetch member data sources
    const memberSources = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.collectionId, col.id)))
      .orderBy(desc(dataSources.createdAt));

    const sourcesWithTables: DataSource[] = [];
    let totalRows = 0;
    let tableCount = 0;
    let totalChunks = 0;

    for (const ds of memberSources) {
      const tables = await this.db
        .select()
        .from(dataSourceTables)
        .where(eq(dataSourceTables.dataSourceId, ds.id));

      const chunks = await this.db
        .select()
        .from(dataSourceChunks)
        .where(eq(dataSourceChunks.dataSourceId, ds.id))
        .limit(20);

      tableCount += tables.length;
      totalRows += tables.reduce((sum, t) => sum + (t.rowCount || 0), 0);
      totalChunks += chunks.length;

      sourcesWithTables.push({
        ...ds,
        collectionId: col.id,
        collectionName: col.name,
        sourceType: ds.sourceType as any,
        status: ds.status as any,
        semanticProfile: (ds.metadata as any)?.semanticProfile || null,
        tables: tables as any[],
        chunks: chunks as any[],
      });
    }

    return {
      ...col,
      semanticProfile: (col.semanticProfile as unknown as CollectionSemanticProfile) || null,
      metadata: col.metadata as Record<string, unknown> | null,
      dataSources: sourcesWithTables,
      dataSourceCount: memberSources.length,
      tableCount,
      documentCount: memberSources.filter((s) => s.sourceType === "rag_document").length,
      totalRows,
      totalChunks,
    };
  }

  /**
   * Get single collection by slug
   */
  async getBySlug(companyId: string, slug: string): Promise<DataSourceCollection | null> {
    const [col] = await this.db
      .select()
      .from(dataSourceCollections)
      .where(and(eq(dataSourceCollections.slug, slug), eq(dataSourceCollections.companyId, companyId)));

    if (!col) return null;
    return this.getById(companyId, col.id);
  }

  /**
   * Create a new collection (e.g. "timurtelecom")
   */
  async create(
    companyId: string,
    input: {
      name: string;
      description?: string;
      color?: string;
      icon?: string;
    },
  ): Promise<DataSourceCollection> {
    const trimmedName = input.name.trim();
    let baseSlug = this.slugify(trimmedName);
    let finalSlug = baseSlug;
    let counter = 1;

    // Ensure unique slug within company
    while (true) {
      const [existing] = await this.db
        .select({ id: dataSourceCollections.id })
        .from(dataSourceCollections)
        .where(and(eq(dataSourceCollections.companyId, companyId), eq(dataSourceCollections.slug, finalSlug)));

      if (!existing) break;
      counter++;
      finalSlug = `${baseSlug}-${counter}`;
    }

    const [created] = await this.db
      .insert(dataSourceCollections)
      .values({
        companyId,
        name: trimmedName,
        slug: finalSlug,
        description: input.description?.trim() || null,
        color: input.color || "#0284c7",
        icon: input.icon || "folder",
        metadata: {
          createdAtIso: new Date().toISOString(),
        },
      })
      .returning();

    // Log activity
    await this.db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "system",
      action: "data_source_collection.created",
      entityType: "data_source_collection",
      entityId: created.id,
      details: {
        name: created.name,
        slug: created.slug,
      },
    });

    return {
      ...created,
      semanticProfile: null,
      metadata: created.metadata as Record<string, unknown> | null,
      dataSourceCount: 0,
      tableCount: 0,
      documentCount: 0,
      totalRows: 0,
      totalChunks: 0,
    };
  }

  /**
   * Update an existing collection
   */
  async update(
    companyId: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      color?: string;
      icon?: string;
    },
  ): Promise<DataSourceCollection | null> {
    const patch: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) {
      patch.name = input.name.trim();
    }
    if (input.description !== undefined) {
      patch.description = input.description?.trim() || null;
    }
    if (input.color !== undefined) {
      patch.color = input.color;
    }
    if (input.icon !== undefined) {
      patch.icon = input.icon;
    }

    const [updated] = await this.db
      .update(dataSourceCollections)
      .set(patch)
      .where(and(eq(dataSourceCollections.id, id), eq(dataSourceCollections.companyId, companyId)))
      .returning();

    if (!updated) return null;
    return this.getById(companyId, id);
  }

  /**
   * Delete a collection (unlinks member data sources without deleting their underlying files)
   */
  async delete(companyId: string, id: string): Promise<boolean> {
    const [deleted] = await this.db
      .delete(dataSourceCollections)
      .where(and(eq(dataSourceCollections.id, id), eq(dataSourceCollections.companyId, companyId)))
      .returning();

    if (!deleted) return false;

    // Member data sources will have collectionId set to null automatically due to onDelete: "set null"
    await this.db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "system",
      action: "data_source_collection.deleted",
      entityType: "data_source_collection",
      entityId: id,
      details: { name: deleted.name },
    });

    return true;
  }

  /**
   * Add existing data sources into a collection and trigger correlation
   */
  async addSourcesToCollection(companyId: string, collectionId: string, dataSourceIds: string[]): Promise<void> {
    if (dataSourceIds.length === 0) return;

    await this.db
      .update(dataSources)
      .set({
        collectionId,
        updatedAt: new Date(),
      })
      .where(and(eq(dataSources.companyId, companyId), inArray(dataSources.id, dataSourceIds)));

    // Trigger asynchronous or synchronous cross-correlation
    await this.correlateCollection(companyId, collectionId);
  }

  /**
   * Remove a single data source from its collection
   */
  async removeSourceFromCollection(companyId: string, collectionId: string, dataSourceId: string): Promise<void> {
    await this.db
      .update(dataSources)
      .set({
        collectionId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dataSources.id, dataSourceId),
          eq(dataSources.collectionId, collectionId),
          eq(dataSources.companyId, companyId),
        ),
      );

    // Re-run correlation for the remaining items in the collection
    await this.correlateCollection(companyId, collectionId);
  }

  /**
   * Stream supported ZIP members to private temporary files. Only bounded
   * member buffers are kept by the parser; callers must remove directory when
   * each returned file has been copied into datasource storage.
   */
  async extractZipEntries(
    input: { filePath: string } | { buffer: Buffer },
    limits: { maxEntryBytes?: number; maxTotalBytes?: number; maxFiles?: number } = {},
  ): Promise<{
    directory: string;
    entries: Array<{ originalname: string; filePath: string; mimetype: string; size: number }>;
  }> {
    const configuredExpandedBytes = Number(process.env.DATASOURCE_MAX_ZIP_EXPANDED_BYTES || DEFAULT_MAX_ZIP_EXPANDED_BYTES);
    if (!Number.isSafeInteger(configuredExpandedBytes) || configuredExpandedBytes <= 0) {
      throw new Error("DATASOURCE_MAX_ZIP_EXPANDED_BYTES must be a positive safe integer");
    }
    const maxTotalBytes = Math.min(limits.maxTotalBytes ?? configuredExpandedBytes, MAX_ZIP_EXPANDED_BYTES);
    const maxFiles = Math.min(limits.maxFiles ?? MAX_EXTRACTED_FILES, MAX_EXTRACTED_FILES);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-datasource-zip-"));
    const extractedFiles: Array<{ originalname: string; filePath: string; mimetype: string; size: number }> = [];
    const usedNames = new Set<string>();
    let totalExpandedBytes = 0;
    let archiveEntryCount = 0;
    const drainWithinArchiveLimit = async (entry: ZipEntryStream) => {
      for await (const chunk of entry) {
        totalExpandedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (totalExpandedBytes > maxTotalBytes) {
          throw payloadTooLarge(`ZIP archive expands beyond its ${maxTotalBytes}-byte total limit`);
        }
      }
    };
    const inputStream = "filePath" in input
      ? fs.createReadStream(input.filePath, { highWaterMark: 64 * 1024 })
      : Readable.from([input.buffer]);
    const parser = inputStream.pipe(unzipper.Parse({ forceStream: true }));
    const allowedExtensions = new Set([
      "csv",
      "tsv",
      "xlsx",
      "xls",
      "pdf",
      "docx",
      "doc",
      "txt",
      "md",
      "json",
    ]);

    try {
      for await (const entry of parser) {
        archiveEntryCount += 1;
        if (archiveEntryCount > MAX_ZIP_ENTRIES) {
          await drainWithinArchiveLimit(entry);
          throw payloadTooLarge(`ZIP archive contains more than ${MAX_ZIP_ENTRIES} entries`);
        }
        const announcedBytes = Number(entry.vars?.uncompressedSize);
        if (Number.isFinite(announcedBytes) && announcedBytes > maxTotalBytes - totalExpandedBytes) {
          throw payloadTooLarge(`ZIP archive expands beyond its ${maxTotalBytes}-byte total limit`);
        }
        if (entry.type === "Directory") {
          await drainWithinArchiveLimit(entry);
          continue;
        }

        const normalizedPath = entry.path.replace(/\\/g, "/");
        const segments = normalizedPath.split("/");
        if (normalizedPath.includes("\0") || normalizedPath.startsWith("/")
          || /^[a-z]:/i.test(normalizedPath) || segments.some((segment) => segment === "..")) {
          await drainWithinArchiveLimit(entry);
          throw badRequest("ZIP archive contains an unsafe member path");
        }
        // Skip system/hidden mac files.
        if (segments.includes("__MACOSX") || segments.some((segment) => segment.startsWith("."))) {
          await drainWithinArchiveLimit(entry);
          continue;
        }

        const basename = path.posix.basename(normalizedPath);
        const ext = basename.split(".").pop()?.toLowerCase() || "";
        if (!allowedExtensions.has(ext)) {
          await drainWithinArchiveLimit(entry);
          continue;
        }
        if (extractedFiles.length >= maxFiles) {
          await drainWithinArchiveLimit(entry);
          throw payloadTooLarge(`ZIP archive contains more than ${maxFiles} supported datasource files`);
        }

        const envName = ext === "csv" || ext === "tsv"
          ? "DATASOURCE_MAX_CSV_UPLOAD_BYTES"
          : "DATASOURCE_MAX_FILE_UPLOAD_BYTES";
        const defaultEntryBytes = ext === "csv" || ext === "tsv" ? GiB : 100 * MiB;
        const maximumEntryBytes = ext === "csv" || ext === "tsv" ? 2 * GiB : 100 * MiB;
        const configuredEntryBytes = Number(process.env[envName] || defaultEntryBytes);
        if (!Number.isSafeInteger(configuredEntryBytes) || configuredEntryBytes <= 0) {
          throw new Error(`${envName} must be a positive safe integer`);
        }
        const entryLimit = Math.min(limits.maxEntryBytes ?? configuredEntryBytes, maximumEntryBytes);
        if (Number.isFinite(announcedBytes) && announcedBytes > entryLimit) {
          await drainWithinArchiveLimit(entry);
          throw payloadTooLarge(`ZIP member ${basename} exceeds its ${entryLimit}-byte datasource limit`);
        }

        let outputBytes = 0;
        const outputPath = path.join(directory, `${randomUUID()}.${ext}`);
        const byteLimit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            outputBytes += chunk.length;
            totalExpandedBytes += chunk.length;
            if (outputBytes > entryLimit) {
              callback(payloadTooLarge(`ZIP member ${basename} exceeds its ${entryLimit}-byte datasource limit`));
              return;
            }
            if (totalExpandedBytes > maxTotalBytes) {
              callback(payloadTooLarge(`ZIP archive expands beyond its ${maxTotalBytes}-byte total limit`));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(entry, byteLimit, fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));

        let originalname = basename;
        if (usedNames.has(originalname.toLocaleLowerCase("en-US"))) {
          const extension = path.posix.extname(basename);
          const stem = basename.slice(0, basename.length - extension.length);
          originalname = `${stem}-${randomUUID().slice(0, 8)}${extension}`;
        }
        usedNames.add(originalname.toLocaleLowerCase("en-US"));

        let mimetype = "application/octet-stream";
        if (ext === "csv") mimetype = "text/csv";
        else if (ext === "tsv" || ext === "txt") mimetype = "text/plain";
        else if (ext === "pdf") mimetype = "application/pdf";
        else if (ext === "xlsx") mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        else if (ext === "xls") mimetype = "application/vnd.ms-excel";
        else if (ext === "docx") mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        else if (ext === "md") mimetype = "text/markdown";
        else if (ext === "json") mimetype = "application/json";

        extractedFiles.push({ originalname, filePath: outputPath, mimetype, size: outputBytes });
      }
    } catch (error) {
      parser.destroy();
      inputStream.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    return { directory, entries: extractedFiles };
  }

  /**
   * Universal Cross-Source Correlation Engine:
   * Maps foreign key relationships, shared topics, cross-document entities,
   * and ClickHouse unified join views across all members of a collection.
   */
  async correlateCollection(companyId: string, collectionId: string): Promise<CollectionSemanticProfile> {
    const [col] = await this.db
      .select()
      .from(dataSourceCollections)
      .where(and(eq(dataSourceCollections.id, collectionId), eq(dataSourceCollections.companyId, companyId)));

    if (!col) {
      throw new Error(`Collection not found: ${collectionId}`);
    }

    // 1. Fetch all data sources in the collection
    const memberSources = await this.db
      .select({
        id: dataSources.id,
        companyId: dataSources.companyId,
        collectionId: dataSources.collectionId,
        name: dataSources.name,
        sourceType: dataSources.sourceType,
        status: dataSources.status,
        metadata: dataSources.metadata,
        createdAt: dataSources.createdAt,
      })
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.collectionId, collectionId)))
      .orderBy(asc(dataSources.createdAt), asc(dataSources.id));

    const sourceIds = memberSources.map((s) => s.id);

    if (sourceIds.length === 0) {
      const priorViews = ((col.semanticProfile as unknown as CollectionSemanticProfile | null)?.unifiedClickhouseViews || [])
        .map((view) => view.viewName)
        .filter((name) => /^pcv_[a-f0-9]{24}$/.test(name));
      if (priorViews.length > 0) {
        try {
          if ((await this.clickhouse.isHealthy()).ok) {
            const database = await this.clickhouse.ensureCompanyDatabase(companyId);
            for (const viewName of priorViews) {
              await this.clickhouse.execute(`DROP VIEW IF EXISTS \`${viewName}\``, database).catch(() => {});
            }
          }
        } catch {
          // The empty collection profile still publishes even when ClickHouse
          // is down; orphan cleanup retries on the next explicit correlation.
        }
      }
      const emptyProfile: CollectionSemanticProfile = {
        domain: "General",
        primaryTopics: [],
        entities: [],
        crossTableRelationships: [],
        crossDocumentCorrelations: [],
        crossModalCorrelations: [],
        temporalOverlapAnalysis: {
          status: "complete",
          tablesAnalyzed: 0,
          tablesWithTemporalBounds: 0,
          comparedPairs: 0,
          findingsTruncated: false,
          findings: [],
        },
        unifiedClickhouseViews: [],
        suggestedQueries: [],
        summary: "Empty collection without data sources.",
        lastCorrelatedAt: new Date().toISOString(),
      };

      await this.db
        .update(dataSourceCollections)
        .set({
          semanticProfile: emptyProfile as any,
          updatedAt: new Date(),
        })
        .where(eq(dataSourceCollections.id, collectionId));

      return emptyProfile;
    }

    // 2. Fetch all tables and column definitions across all structured sources in this collection
    const MAX_COLLECTION_ANALYSIS_TABLES = 500;
    const [tableCountResult, sampledTables] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)` })
        .from(dataSourceTables)
        .innerJoin(dataSources, and(
          eq(dataSources.id, dataSourceTables.dataSourceId),
          eq(dataSources.companyId, companyId),
        ))
        .where(and(
          eq(dataSourceTables.companyId, companyId),
          eq(dataSources.collectionId, collectionId),
        )),
      this.db.select({
        id: dataSourceTables.id,
        dataSourceId: dataSourceTables.dataSourceId,
        companyId: dataSourceTables.companyId,
        tableName: dataSourceTables.tableName,
        rowCount: dataSourceTables.rowCount,
        columnCount: dataSourceTables.columnCount,
        schemaDefinition: dataSourceTables.schemaDefinition,
        semanticModel: dataSourceTables.semanticModel,
        createdAt: dataSourceTables.createdAt,
        updatedAt: dataSourceTables.updatedAt,
      })
        .from(dataSourceTables)
        .innerJoin(dataSources, and(
          eq(dataSources.id, dataSourceTables.dataSourceId),
          eq(dataSources.companyId, companyId),
        ))
        .where(and(
          eq(dataSourceTables.companyId, companyId),
          eq(dataSources.collectionId, collectionId),
        ))
        .orderBy(asc(dataSourceTables.createdAt), asc(dataSourceTables.id))
        .limit(MAX_COLLECTION_ANALYSIS_TABLES + 1),
    ]);
    const totalTableCount = Number(tableCountResult[0]?.count || 0);
    const tablesTruncated = sampledTables.length > MAX_COLLECTION_ANALYSIS_TABLES;
    const tables = sampledTables.slice(0, MAX_COLLECTION_ANALYSIS_TABLES);
    const columnNames = (schema: unknown): string[] => Array.isArray(schema)
      ? schema.map((column) => typeof column === "string" ? column : String((column as { name?: unknown })?.name || "")).filter(Boolean)
      : [];

    // Read at most 100 sample rows per table in one bounded-result query. The
    // previous per-table loop made collection correlation perform N database
    // round trips and loaded every RAG chunk into application memory.
    const tableSamples = new Map<string, Array<Record<string, unknown>>>();
    for (const table of tables) tableSamples.set(table.id, []);
    if (tables.length > 0) {
      const rankedSamples = this.db
        .select({
          tableId: dataSourceRecords.tableId,
          data: dataSourceRecords.data,
          sampleRank: sql<number>`row_number() over (partition by ${dataSourceRecords.tableId} order by ${dataSourceRecords.rowIndex})`.as("sample_rank"),
        })
        .from(dataSourceRecords)
        .where(and(
          eq(dataSourceRecords.companyId, companyId),
          inArray(dataSourceRecords.tableId, tables.map((table) => table.id)),
        ))
        .as("ranked_datasource_samples");
      const sampleRows = await this.db
        .select({ tableId: rankedSamples.tableId, data: rankedSamples.data })
        .from(rankedSamples)
        .where(sql`${rankedSamples.sampleRank} <= 100`)
        .orderBy(rankedSamples.tableId, rankedSamples.sampleRank);
      for (const sample of sampleRows) {
        tableSamples.get(sample.tableId)?.push(sample.data);
      }
    }

    // 3. CROSS-TABLE FOREIGN KEY & RELATIONSHIP DISCOVERY
    const discoveredRelationships: TableRelation[] = [];
    const MAX_RELATION_CANDIDATES = 20_000;
    const MAX_DISCOVERED_RELATIONSHIPS = 500;
    type RelationColumn = { table: typeof tables[number]; column: Record<string, unknown>; name: string; normalized: string; tableIndex: number };
    const relationColumns: RelationColumn[] = [];
    const columnsByName = new Map<string, RelationColumn[]>();
    const columnsByNormalizedName = new Map<string, RelationColumn[]>();
    for (const [tableIndex, table] of tables.entries()) {
      for (const rawColumn of Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) {
        const column = typeof rawColumn === "string" ? { name: rawColumn } : rawColumn as Record<string, unknown>;
        const name = String(column.name || "").trim();
        if (!name) continue;
        const lowerName = name.toLowerCase();
        const candidate = { table, column, name, normalized: lowerName.replace(/_/g, ""), tableIndex };
        relationColumns.push(candidate);
        const exactGroup = columnsByName.get(lowerName) || [];
        exactGroup.push(candidate);
        columnsByName.set(lowerName, exactGroup);
        const normalizedGroup = columnsByNormalizedName.get(candidate.normalized) || [];
        normalizedGroup.push(candidate);
        columnsByNormalizedName.set(candidate.normalized, normalizedGroup);
      }
    }

    const candidateRelations = new Map<string, { left: RelationColumn; right: RelationColumn }>();
    const addCandidateRelation = (first: RelationColumn, second: RelationColumn) => {
      if (first.table.id === second.table.id || candidateRelations.size >= MAX_RELATION_CANDIDATES) return;
      const [left, right] = first.tableIndex < second.tableIndex ? [first, second] : [second, first];
      const key = `${left.table.id}\0${left.name}\0${right.table.id}\0${right.name}`;
      candidateRelations.set(key, { left, right });
    };
    const isExactForeignKeyName = (name: string) => name.endsWith("_id") || name.endsWith("_code")
      || name.endsWith("_no") || name.startsWith("kode_") || name.startsWith("id_")
      || ["nik", "msisdn", "nip", "email", "phone"].includes(name);

    // Match named keys through indexes instead of comparing every column in
    // every table against every other column (O(tables² * columns²)). Bare
    // id-to-id is deliberately excluded because it creates noisy Cartesian
    // relationship graphs for ordinary primary keys.
    for (const [name, group] of columnsByName) {
      if (name === "id" || !isExactForeignKeyName(name)) continue;
      for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex++) {
          addCandidateRelation(group[leftIndex]!, group[rightIndex]!);
          if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
        }
        if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
      }
      if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
    }
    for (const [normalized, group] of columnsByNormalizedName) {
      if (!(normalized.includes("id") || normalized.includes("code") || normalized.includes("key"))) continue;
      for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex++) {
          if (group[leftIndex]!.name.toLowerCase() !== group[rightIndex]!.name.toLowerCase()) {
            addCandidateRelation(group[leftIndex]!, group[rightIndex]!);
          }
          if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
        }
        if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
      }
      if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
    }
    for (const primaryKey of relationColumns.filter((entry) => entry.name.toLowerCase() === "id" || entry.column.isPrimaryKey === true)) {
      const singularTable = primaryKey.table.tableName.toLowerCase().replace(/s$/, "");
      for (const foreignKey of columnsByName.get(`${singularTable}_id`) || []) {
        addCandidateRelation(primaryKey, foreignKey);
        if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
      }
      if (candidateRelations.size >= MAX_RELATION_CANDIDATES) break;
    }

    const valuesByTableColumn = new Map<string, Set<string>>();
    const sampleValues = (candidate: RelationColumn) => {
      const key = `${candidate.table.id}\0${candidate.name}`;
      const cached = valuesByTableColumn.get(key);
      if (cached) return cached;
      const values = new Set((tableSamples.get(candidate.table.id) || [])
        .map((row) => row[candidate.name])
        .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
        .map(String));
      valuesByTableColumn.set(key, values);
      return values;
    };

    const discoveredPairKeys = new Set<string>();
    for (const { left: columnA, right: columnB } of candidateRelations.values()) {
      if (discoveredRelationships.length >= MAX_DISCOVERED_RELATIONSHIPS) break;
      const valuesA = sampleValues(columnA);
      const valuesB = sampleValues(columnB);
      let overlapCount = 0;
      for (const value of valuesA) if (valuesB.has(value)) overlapCount += 1;
      const hasOverlap = valuesA.size > 0 && valuesB.size > 0 ? overlapCount > 0 : true;
      if (!hasOverlap) continue;

      const relationKey = `${columnA.table.id}.${columnA.name}->${columnB.table.id}.${columnB.name}`;
      if (discoveredPairKeys.has(relationKey)) continue;
      discoveredPairKeys.add(relationKey);
      const columnAName = columnA.name.toLowerCase();
      const columnBName = columnB.name.toLowerCase();
      let relationType: "one_to_many" | "many_to_one" | "one_to_one" = "many_to_one";
      if (columnAName === "id" || columnA.column.isPrimaryKey === true) relationType = "one_to_many";
      else if (columnBName === "id" || columnB.column.isPrimaryKey === true) relationType = "many_to_one";
      discoveredRelationships.push({
        sourceTable: columnA.table.tableName,
        sourceTableId: columnA.table.id,
        sourceColumn: columnA.name,
        targetTable: columnB.table.tableName,
        targetTableId: columnB.table.id,
        targetColumn: columnB.name,
        relationType,
      });
    }

    // 4. CROSS-DOCUMENT & RAG CORRELATION
    const allDocumentSources = memberSources.filter((s) => s.sourceType === "rag_document");
    const documentSources = allDocumentSources.slice(0, MAX_COLLECTION_ANALYSIS_TABLES);
    const documentsTruncated = allDocumentSources.length > documentSources.length;
    const rankedDocumentChunks = this.db
      .select({
        id: dataSourceChunks.id,
        dataSourceId: dataSourceChunks.dataSourceId,
        title: dataSourceChunks.title,
        content: dataSourceChunks.content,
        metadata: dataSourceChunks.metadata,
        chunkRank: sql<number>`row_number() over (partition by ${dataSourceChunks.dataSourceId} order by ${dataSourceChunks.chunkIndex})`.as("chunk_rank"),
      })
      .from(dataSourceChunks)
      .where(and(eq(dataSourceChunks.companyId, companyId), inArray(dataSourceChunks.dataSourceId, documentSources.map((source) => source.id))))
      .as("ranked_datasource_chunks");
    const documentChunks = await this.db
      .select({
        id: rankedDocumentChunks.id,
        dataSourceId: rankedDocumentChunks.dataSourceId,
        title: rankedDocumentChunks.title,
        content: rankedDocumentChunks.content,
        metadata: rankedDocumentChunks.metadata,
      })
      .from(rankedDocumentChunks)
      .where(sql`${rankedDocumentChunks.chunkRank} <= 5`)
      .orderBy(rankedDocumentChunks.dataSourceId, rankedDocumentChunks.chunkRank);
    const chunksBySource = new Map<string, typeof documentChunks>();
    for (const chunk of documentChunks) {
      const sourceChunks = chunksBySource.get(chunk.dataSourceId) || [];
      sourceChunks.push(chunk);
      chunksBySource.set(chunk.dataSourceId, sourceChunks);
    }

    const docProfilesMap = new Map<string, { id: string; title: string; entities: Set<string>; text: string }>();

    for (const doc of documentSources) {
      const chunksForDoc = chunksBySource.get(doc.id) || [];
      const combinedText = chunksForDoc.map((chunk) => chunk.content.slice(0, 2_000)).join(" ").slice(0, 10_000);
      const semantic = (doc.metadata as any)?.semanticProfile;

      const entities = new Set<string>();
      if (Array.isArray(semantic?.entities)) {
        for (const e of semantic.entities.slice(0, 100)) entities.add(String(e).toLowerCase());
      }

      // Keyword / entity extraction from text
      const extractedWords = combinedText.match(/\b[A-Z][a-z0-9_-]{2,}\b/g) || [];
      for (const w of extractedWords.slice(0, 30)) {
        entities.add(w.toLowerCase());
      }

      docProfilesMap.set(doc.id, {
        id: doc.id,
        title: doc.name,
        entities,
        text: combinedText.slice(0, 500),
      });
    }

    const crossDocumentCorrelations: CrossDocumentCorrelation[] = [];
    const docList = Array.from(docProfilesMap.values());

    for (let i = 0; i < docList.length && crossDocumentCorrelations.length < 1_000; i++) {
      for (let j = i + 1; j < docList.length && crossDocumentCorrelations.length < 1_000; j++) {
        const docA = docList[i];
        const docB = docList[j];

        const shared: string[] = [];
        for (const ent of docA.entities) {
          if (docB.entities.has(ent)) shared.push(ent);
        }

        if (shared.length > 0) {
          crossDocumentCorrelations.push({
            sourceDocId: docA.id,
            sourceDocTitle: docA.title,
            targetDocId: docB.id,
            targetDocTitle: docB.title,
            sharedEntities: shared.slice(0, 8),
            semanticSimilarity: Math.min(0.95, 0.5 + shared.length * 0.1),
            correlationSummary: `Dokumen "${docA.title}" dan "${docB.title}" memiliki korelasi entitas bersama: ${shared.slice(0, 5).join(", ")}.`,
          });
        }
      }
    }

    // 5. CROSS-MODAL LINKING (RAG Documents <-> Structured Tables)
    const crossModalCorrelations: CrossModalCorrelation[] = [];
    const genericEntityTokens = new Set([
      "about", "after", "agent", "analytics", "based", "company", "customer", "customers", "data", "document",
      "enterprise", "from", "general", "information", "network", "record", "source", "table", "that", "this", "with",
    ]);
    const entityTokens = (value: string) => [...new Set((value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{3,}/gu) || [])
      .flatMap((token) => token.endsWith("s") && token.length > 4 ? [token, token.slice(0, -1)] : [token])
      .filter((token) => !genericEntityTokens.has(token)))];
    const tableIdsByToken = new Map<string, Set<string>>();
    for (const table of tables) {
      const tokens = new Set<string>();
      for (const name of columnNames(table.schemaDefinition)) {
        for (const token of entityTokens(name.slice(0, 256))) tokens.add(token);
      }
      for (const row of tableSamples.get(table.id) || []) {
        for (const value of Object.values(row)) {
          for (const token of entityTokens(String(value ?? "").slice(0, 256))) tokens.add(token);
        }
      }
      for (const token of tokens) {
        const ids = tableIdsByToken.get(token) || new Set<string>();
        ids.add(table.id);
        tableIdsByToken.set(token, ids);
      }
    }

    const crossModalPairs = new Map<string, { doc: typeof docList[number]; tableId: string; entities: Set<string> }>();
    const MAX_CROSS_MODAL_PAIRS = 5_000;
    for (const doc of docList) {
      for (const entity of doc.entities) {
        const tokens = entityTokens(entity);
        if (tokens.length === 0) continue;
        const initialCandidates = tableIdsByToken.get(tokens[0]!);
        if (!initialCandidates) continue;
        for (const tableId of initialCandidates) {
          if (!tokens.every((token) => tableIdsByToken.get(token)?.has(tableId))) continue;
          const pairKey = `${doc.id}\0${tableId}`;
          let pair = crossModalPairs.get(pairKey);
          if (!pair && crossModalPairs.size < MAX_CROSS_MODAL_PAIRS) {
            pair = { doc, tableId, entities: new Set<string>() };
            crossModalPairs.set(pairKey, pair);
          }
          pair?.entities.add(entity);
        }
      }
    }
    const tableNameById = new Map(tables.map((table) => [table.id, table.tableName]));
    for (const pair of crossModalPairs.values()) {
      const tableName = tableNameById.get(pair.tableId);
      if (!tableName) continue;
      const matchingEntities = Array.from(pair.entities).slice(0, 6);
      crossModalCorrelations.push({
        documentId: pair.doc.id,
        documentTitle: pair.doc.title,
        tableId: pair.tableId,
        tableName,
        sharedEntities: matchingEntities,
        correlationDescription: `Dokumen "${pair.doc.title}" berelasi secara konteks dengan tabel "${tableName}" melalui entitas [${matchingEntities.slice(0, 4).join(", ")}].`,
      });
    }

    // 6. Deploy bounded, company-scoped ClickHouse views for materialized
    // structured sources. Keep semantic relationship candidates visible when
    // their tables are not available in ClickHouse, but never call those views
    // deployed or authorize SQL against them.
    const unifiedClickhouseViews: UnifiedClickhouseView[] = [];
    const quoteClickhouseIdentifier = (name: string) => `\`${name.replaceAll("`", "``")}\``;
    const companyDatabase = this.clickhouse.getCompanyDatabase(companyId);
    let clickhouseReady = false;
    let clickhouseReadinessChecked = false;
    let deployedViewCount = 0;
    const sourceById = new Map(memberSources.map((source) => [source.id, source]));
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const temporalOverlapAnalysis = analyzeTemporalOverlaps(
      tables.map((table) => {
        const source = sourceById.get(table.dataSourceId);
        return {
          tableId: table.id,
          sourceId: table.dataSourceId,
          sourceType: source?.sourceType ?? "unknown",
          sourceStatus: source?.status ?? "unknown",
          tableName: table.tableName,
          semanticModel: table.semanticModel,
        };
      }),
      { tablesTruncated },
    );
    const priorProfile = col.semanticProfile as unknown as CollectionSemanticProfile | null;
    const priorGeneratedViews = (priorProfile?.unifiedClickhouseViews || [])
      .map((view) => view.viewName)
      .filter((name) => /^pcv_[a-f0-9]{24}$/.test(name));

    for (const rel of discoveredRelationships) {
      const relationIdentity = `${rel.sourceTableId || rel.sourceTable}.${rel.sourceColumn}->${rel.targetTableId || rel.targetTable}.${rel.targetColumn}`;
      const viewName = `pcv_${createHash("sha256").update(`${collectionId}:${relationIdentity}`).digest("hex").slice(0, 24)}`;
      const sourceTable = rel.sourceTableId ? tableById.get(rel.sourceTableId) : undefined;
      const targetTable = rel.targetTableId ? tableById.get(rel.targetTableId) : undefined;
      const source = sourceTable ? sourceById.get(sourceTable.dataSourceId) : undefined;
      const target = targetTable ? sourceById.get(targetTable.dataSourceId) : undefined;
      const sourceClickhouseName = (sourceTable?.semanticModel as Record<string, unknown> | null)?.clickhouseTable;
      const targetClickhouseName = (targetTable?.semanticModel as Record<string, unknown> | null)?.clickhouseTable;
      const sourceColumns = columnNames(sourceTable?.schemaDefinition);
      const targetColumns = columnNames(targetTable?.schemaDefinition);
      const sourceReady = source?.status === "ready" && ["csv", "excel"].includes(source.sourceType);
      const targetReady = target?.status === "ready" && ["csv", "excel"].includes(target.sourceType);
      const hasSafeMaterializedTables = sourceReady && targetReady
        && typeof sourceClickhouseName === "string" && /^[a-zA-Z0-9_]+$/.test(sourceClickhouseName)
        && typeof targetClickhouseName === "string" && /^[a-zA-Z0-9_]+$/.test(targetClickhouseName)
        && sourceColumns.includes(rel.sourceColumn) && targetColumns.includes(rel.targetColumn);

      let deploymentStatus: "deployed" | "not_deployed" | "failed" = "not_deployed";
      let deploymentMessage: string | undefined;
      let joinSql = "";

      if (!hasSafeMaterializedTables) {
        deploymentMessage = "Both related structured tables must be ready and materialized in ClickHouse.";
      } else if (deployedViewCount >= MAX_COLLECTION_VIEWS) {
        deploymentMessage = `Collection view limit reached (${MAX_COLLECTION_VIEWS}).`;
      } else {
        if (!clickhouseReadinessChecked) {
          clickhouseReadinessChecked = true;
          try {
            clickhouseReady = (await this.clickhouse.isHealthy()).ok;
            if (clickhouseReady) await this.clickhouse.ensureCompanyDatabase(companyId);
          } catch {
            clickhouseReady = false;
          }
        }
        if (!clickhouseReady) {
          deploymentStatus = "failed";
          deploymentMessage = "ClickHouse is unavailable; run collection correlation again after it recovers.";
        } else {
          const projectColumns = (table: typeof tables[number], alias: "s" | "t") => {
            const tableColumns = columnNames(table.schemaDefinition);
            return tableColumns.map((column) => {
              const outputName = `${alias}_${table.id.slice(0, 8)}__${column}`;
              return `${alias}.${quoteClickhouseIdentifier(column)} AS ${quoteClickhouseIdentifier(outputName)}`;
            });
          };
          const selectColumns = [
            ...projectColumns(sourceTable!, "s"),
            ...projectColumns(targetTable!, "t"),
          ];
          joinSql = `CREATE OR REPLACE VIEW ${quoteClickhouseIdentifier(viewName)} AS\nSELECT ${selectColumns.join(",\n       ")}\nFROM ${quoteClickhouseIdentifier(companyDatabase)}.${quoteClickhouseIdentifier(sourceClickhouseName as string)} AS s\nLEFT JOIN ${quoteClickhouseIdentifier(companyDatabase)}.${quoteClickhouseIdentifier(targetClickhouseName as string)} AS t\n  ON s.${quoteClickhouseIdentifier(rel.sourceColumn)} = t.${quoteClickhouseIdentifier(rel.targetColumn)};`;
          try {
            if (!clickhouseReady) throw new Error("ClickHouse is unavailable");
            await this.clickhouse.execute(joinSql, companyDatabase);
            deploymentStatus = "deployed";
            deployedViewCount += 1;
          } catch {
            deploymentStatus = "failed";
            deploymentMessage = "ClickHouse could not create this view; run collection correlation again after fixing the source table.";
          }
        }
      }

      unifiedClickhouseViews.push({
        viewName,
        description: `Unified join view combining ${rel.sourceTable} and ${rel.targetTable} on ${rel.sourceColumn} = ${rel.targetColumn}.`,
        joinSql,
        sourceTables: [rel.sourceTable, rel.targetTable],
        sourceTableIds: [rel.sourceTableId, rel.targetTableId].filter((id): id is string => Boolean(id)),
        deploymentStatus,
        deploymentMessage,
      });
    }

    if (!clickhouseReadinessChecked && priorGeneratedViews.length > 0) {
      clickhouseReadinessChecked = true;
      try {
        clickhouseReady = (await this.clickhouse.isHealthy()).ok;
        if (clickhouseReady) await this.clickhouse.ensureCompanyDatabase(companyId);
      } catch {
        clickhouseReady = false;
      }
    }

    if (clickhouseReady) {
      const currentViewNames = new Set(unifiedClickhouseViews.map((view) => view.viewName));
      for (const staleViewName of priorGeneratedViews) {
        if (currentViewNames.has(staleViewName)) continue;
        await this.clickhouse.execute(`DROP VIEW IF EXISTS ${quoteClickhouseIdentifier(staleViewName)}`, companyDatabase).catch(() => {});
      }
    }

    // 7. MULTI-TABLE SUGGESTED ANALYTICAL QUERIES
    const suggestedQueries: SuggestedQueryTemplate[] = [];

    for (const rel of discoveredRelationships) {
      suggestedQueries.push({
        title: `Join Analisis ${rel.sourceTable} & ${rel.targetTable}`,
        query: `Bagaimana perbandingan data antara ${rel.sourceTable} dan ${rel.targetTable} berdasarkan ${rel.sourceColumn}?`,
        category: "aggregation",
        sqlSnippet: unifiedClickhouseViews.find((view) => view.deploymentStatus === "deployed"
          && view.sourceTableIds?.includes(rel.sourceTableId || "")
          && view.sourceTableIds?.includes(rel.targetTableId || ""))
          ? `SELECT * FROM ${quoteClickhouseIdentifier(unifiedClickhouseViews.find((view) => view.deploymentStatus === "deployed"
            && view.sourceTableIds?.includes(rel.sourceTableId || "")
            && view.sourceTableIds?.includes(rel.targetTableId || ""))!.viewName)} LIMIT 10;`
          : "",
        description: `Menggabungkan data ${rel.sourceTable} dengan ${rel.targetTable} menggunakan foreign key ${rel.sourceColumn}.`,
      });
    }

    // Single-table query fallback if no relationships
    if (suggestedQueries.length === 0 && tables.length > 0) {
      suggestedQueries.push({
        title: `Eksplorasi Data ${tables[0].tableName}`,
        query: `Tampilkan ringkasan data dari tabel ${tables[0].tableName}`,
        category: "general",
        sqlSnippet: `SELECT * FROM ${tables[0].tableName} LIMIT 20;`,
        description: `Mengambil cuplikan sampel baris dari tabel ${tables[0].tableName}.`,
      });
    }

    // 8. UNIFIED DOMAIN & TOPICS SYNTHESIS
    const allEntities = new Set<string>();
    const allTopics = new Set<string>();

    for (const ds of memberSources) {
      const sem = (ds.metadata as any)?.semanticProfile;
      if (sem) {
        if (Array.isArray(sem.entities)) sem.entities.forEach((e: string) => allEntities.add(String(e)));
        if (Array.isArray(sem.topics)) sem.topics.forEach((t: string) => allTopics.add(String(t)));
        if (Array.isArray(sem.primaryTopics)) sem.primaryTopics.forEach((t: string) => allTopics.add(String(t)));
      }
    }

    // Telecommunications domain heuristic for timurtelecom or similar collections
    let inferredDomain = "Enterprise Operations";
    const colNameLower = col.name.toLowerCase();
    if (colNameLower.includes("telecom") || colNameLower.includes("timur") || colNameLower.includes("telco")) {
      inferredDomain = "Telecommunications & Network Operations";
      allTopics.add("BTS Tower Infrastructure");
      allTopics.add("Subscriber Billing & Billing Cycle");
      allTopics.add("Network SLA & Performance");
      allTopics.add("Customer Relationship Management");
    } else if (tables.length > 0) {
      inferredDomain = "Data Analytics & Cross-Table Intelligence";
    }

    const boundedAnalysisReachedLimit = tablesTruncated || documentsTruncated
      || candidateRelations.size >= MAX_RELATION_CANDIDATES
      || discoveredRelationships.length >= MAX_DISCOVERED_RELATIONSHIPS
      || crossDocumentCorrelations.length >= 1_000
      || crossModalPairs.size >= MAX_CROSS_MODAL_PAIRS
      || deployedViewCount >= MAX_COLLECTION_VIEWS;
    const analysisLimitNote = boundedAnalysisReachedLimit
      ? ` Hasil korelasi dibatasi oleh safety caps: maksimum ${MAX_COLLECTION_ANALYSIS_TABLES} tabel/dokumen, ${MAX_RELATION_CANDIDATES} pasangan relasi kandidat, ${MAX_DISCOVERED_RELATIONSHIPS} relasi, 1.000 korelasi dokumen, 5.000 korelasi lintas-modal, dan ${MAX_COLLECTION_VIEWS} view per proses.`
      : "";
    const summary = `Collection "${col.name}" terdiri dari ${memberSources.length} sumber data (${totalTableCount} tabel tabular, ${allDocumentSources.length} dokumen RAG). Terdeteksi ${discoveredRelationships.length} kandidat relasi foreign key, ${deployedViewCount} ClickHouse view terpasang, ${crossDocumentCorrelations.length} korelasi dokumen, ${crossModalCorrelations.length} tautan dokumen-tabel, dan ${temporalOverlapAnalysis.findings.length} periode data yang overlap untuk ditinjau.${analysisLimitNote}`;

    const finalProfile: CollectionSemanticProfile = {
      domain: inferredDomain,
      primaryTopics: Array.from(allTopics).slice(0, 10),
      entities: Array.from(allEntities).slice(0, 20),
      crossTableRelationships: discoveredRelationships,
      crossDocumentCorrelations,
      crossModalCorrelations,
      temporalOverlapAnalysis,
      unifiedClickhouseViews,
      suggestedQueries,
      summary,
      lastCorrelatedAt: new Date().toISOString(),
    };

    // 9. Persist into DB
    await this.db
      .update(dataSourceCollections)
      .set({
        semanticProfile: finalProfile as any,
        updatedAt: new Date(),
      })
      .where(eq(dataSourceCollections.id, collectionId));

    return finalProfile;
  }
}
