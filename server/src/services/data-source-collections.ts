import path from "node:path";
import AdmZip from "adm-zip";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
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

export class DataSourceCollectionsService {
  constructor(private db: Db) {}

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

    const results: DataSourceCollection[] = [];

    for (const col of collections) {
      // Fetch member data sources count & breakdown
      const memberSources = await this.db
        .select({
          id: dataSources.id,
          sourceType: dataSources.sourceType,
        })
        .from(dataSources)
        .where(and(eq(dataSources.companyId, companyId), eq(dataSources.collectionId, col.id)));

      const sourceIds = memberSources.map((s) => s.id);

      let tableCount = 0;
      let totalRows = 0;
      let documentCount = 0;
      let totalChunks = 0;

      if (sourceIds.length > 0) {
        // Count tables & rows
        const tables = await this.db
          .select({
            rowCount: dataSourceTables.rowCount,
          })
          .from(dataSourceTables)
          .where(and(eq(dataSourceTables.companyId, companyId), inArray(dataSourceTables.dataSourceId, sourceIds)));

        tableCount = tables.length;
        totalRows = tables.reduce((acc, t) => acc + (t.rowCount || 0), 0);

        // Count chunks for document types
        const chunks = await this.db
          .select({
            id: dataSourceChunks.id,
          })
          .from(dataSourceChunks)
          .where(and(eq(dataSourceChunks.companyId, companyId), inArray(dataSourceChunks.dataSourceId, sourceIds)));

        totalChunks = chunks.length;
        documentCount = memberSources.filter((s) => s.sourceType === "rag_document").length;
      }

      results.push({
        ...col,
        semanticProfile: (col.semanticProfile as unknown as CollectionSemanticProfile) || null,
        metadata: col.metadata as Record<string, unknown> | null,
        dataSourceCount: memberSources.length,
        tableCount,
        documentCount,
        totalRows,
        totalChunks,
      });
    }

    return results;
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
   * Extract files from an uploaded ZIP buffer in-memory
   */
  extractZipEntries(
    buffer: Buffer,
  ): Array<{ originalname: string; buffer: Buffer; mimetype: string; size: number }> {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const extractedFiles: Array<{ originalname: string; buffer: Buffer; mimetype: string; size: number }> = [];

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

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const normalizedPath = entry.entryName.replace(/\\/g, "/");
      // Skip system/hidden mac files
      if (
        normalizedPath.startsWith("__MACOSX/") ||
        normalizedPath.includes("/.") ||
        path.basename(normalizedPath).startsWith(".")
      ) {
        continue;
      }

      const basename = path.basename(normalizedPath);
      const ext = basename.split(".").pop()?.toLowerCase() || "";

      if (!allowedExtensions.has(ext)) {
        continue;
      }

      const fileBuffer = entry.getData();
      let mimetype = "application/octet-stream";
      if (ext === "csv") mimetype = "text/csv";
      else if (ext === "tsv" || ext === "txt") mimetype = "text/plain";
      else if (ext === "pdf") mimetype = "application/pdf";
      else if (ext === "xlsx") mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      else if (ext === "xls") mimetype = "application/vnd.ms-excel";
      else if (ext === "docx") mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      else if (ext === "md") mimetype = "text/markdown";
      else if (ext === "json") mimetype = "application/json";

      extractedFiles.push({
        originalname: basename,
        buffer: fileBuffer,
        mimetype,
        size: fileBuffer.length,
      });
    }

    return extractedFiles;
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
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.collectionId, collectionId)));

    const sourceIds = memberSources.map((s) => s.id);

    if (sourceIds.length === 0) {
      const emptyProfile: CollectionSemanticProfile = {
        domain: "General",
        primaryTopics: [],
        entities: [],
        crossTableRelationships: [],
        crossDocumentCorrelations: [],
        crossModalCorrelations: [],
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
    const tables = await this.db
      .select()
      .from(dataSourceTables)
      .where(and(eq(dataSourceTables.companyId, companyId), inArray(dataSourceTables.dataSourceId, sourceIds)));

    // Fetch sample records for each table to verify value overlap
    const tableSamples = new Map<string, Array<Record<string, unknown>>>();
    for (const t of tables) {
      const samples = await this.db
        .select({ data: dataSourceRecords.data })
        .from(dataSourceRecords)
        .where(and(eq(dataSourceRecords.tableId, t.id), eq(dataSourceRecords.companyId, companyId)))
        .limit(100);

      tableSamples.set(t.id, samples.map((s) => s.data));
    }

    // 3. CROSS-TABLE FOREIGN KEY & RELATIONSHIP DISCOVERY
    const discoveredRelationships: TableRelation[] = [];
    const discoveredPairKeys = new Set<string>();

    for (let i = 0; i < tables.length; i++) {
      for (let j = 0; j < tables.length; j++) {
        if (i === j) continue;
        const tableA = tables[i];
        const tableB = tables[j];

        const colsA = (tableA.schemaDefinition as any[]) || [];
        const colsB = (tableB.schemaDefinition as any[]) || [];
        const samplesA = tableSamples.get(tableA.id) || [];
        const samplesB = tableSamples.get(tableB.id) || [];

        for (const colA of colsA) {
          const colAName = (typeof colA === "string" ? colA : colA.name || "").toLowerCase().trim();
          if (!colAName) continue;

          for (const colB of colsB) {
            const colBName = (typeof colB === "string" ? colB : colB.name || "").toLowerCase().trim();
            if (!colBName) continue;

            // Relationship heuristics:
            // Match Case 1: Exact column name match for foreign key patterns (e.g. `customer_id` == `customer_id`)
            // Match Case 2: Primary key `id` on Table A matches `{tableA_singular}_id` on Table B
            // Match Case 3: Common enterprise domain patterns (e.g. `site_id`, `bts_id`, `msisdn`, `kode_area`)
            const singularTableA = tableA.tableName.toLowerCase().replace(/s$/, "");
            const singularTableB = tableB.tableName.toLowerCase().replace(/s$/, "");

            const isExactFkMatch =
              colAName === colBName &&
              (colAName.endsWith("_id") ||
                colAName.endsWith("_code") ||
                colAName.endsWith("_no") ||
                colAName.startsWith("kode_") ||
                colAName.startsWith("id_") ||
                ["id", "nik", "msisdn", "nip", "email", "phone"].includes(colAName));

            const isPkToFkMatch =
              (colAName === "id" && colBName === `${singularTableA}_id`) ||
              (colBName === "id" && colAName === `${singularTableB}_id`);

            const isNormalizedMatch =
              colAName.replace(/_/g, "") === colBName.replace(/_/g, "") &&
              (colAName.includes("id") || colAName.includes("code") || colAName.includes("key"));

            if (isExactFkMatch || isPkToFkMatch || isNormalizedMatch) {
              // Check sample value intersection if samples are available
              const valuesA = new Set(
                samplesA
                  .map((r) => r[colA.name || colAName])
                  .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
                  .map(String),
              );

              const valuesB = new Set(
                samplesB
                  .map((r) => r[colB.name || colBName])
                  .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
                  .map(String),
              );

              let overlapCount = 0;
              for (const val of valuesA) {
                if (valuesB.has(val)) overlapCount++;
              }

              // Value overlap confirmed OR matching standard naming convention
              const hasOverlap = valuesA.size > 0 && valuesB.size > 0 ? overlapCount > 0 : true;

              if (hasOverlap) {
                const relationKey = `${tableA.tableName}.${colA.name || colAName}->${tableB.tableName}.${colB.name || colBName}`;
                const reverseKey = `${tableB.tableName}.${colB.name || colBName}->${tableA.tableName}.${colA.name || colAName}`;

                if (!discoveredPairKeys.has(relationKey) && !discoveredPairKeys.has(reverseKey)) {
                  discoveredPairKeys.add(relationKey);

                  // Determine relation type
                  let relationType: "one_to_many" | "many_to_one" | "one_to_one" = "many_to_one";
                  if (colAName === "id" || colA.isPrimaryKey) {
                    relationType = "one_to_many";
                  } else if (colBName === "id" || colB.isPrimaryKey) {
                    relationType = "many_to_one";
                  }

                  discoveredRelationships.push({
                    sourceTable: tableA.tableName,
                    sourceColumn: colA.name || colAName,
                    targetTable: tableB.tableName,
                    targetColumn: colB.name || colBName,
                    relationType,
                  });
                }
              }
            }
          }
        }
      }
    }

    // 4. CROSS-DOCUMENT & RAG CORRELATION
    const documentSources = memberSources.filter((s) => s.sourceType === "rag_document");
    const documentChunks = await this.db
      .select({
        id: dataSourceChunks.id,
        dataSourceId: dataSourceChunks.dataSourceId,
        title: dataSourceChunks.title,
        content: dataSourceChunks.content,
        metadata: dataSourceChunks.metadata,
      })
      .from(dataSourceChunks)
      .where(and(eq(dataSourceChunks.companyId, companyId), inArray(dataSourceChunks.dataSourceId, sourceIds)));

    const docProfilesMap = new Map<string, { id: string; title: string; entities: Set<string>; text: string }>();

    for (const doc of documentSources) {
      const chunksForDoc = documentChunks.filter((c) => c.dataSourceId === doc.id);
      const combinedText = chunksForDoc.map((c) => c.content).join(" ");
      const semantic = (doc.metadata as any)?.semanticProfile;

      const entities = new Set<string>();
      if (Array.isArray(semantic?.entities)) {
        for (const e of semantic.entities) entities.add(String(e).toLowerCase());
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

    for (let i = 0; i < docList.length; i++) {
      for (let j = i + 1; j < docList.length; j++) {
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
    for (const doc of docList) {
      for (const table of tables) {
        const matchingEntities: string[] = [];
        const cols = (table.schemaDefinition as any[]) || [];
        const samples = tableSamples.get(table.id) || [];

        for (const ent of doc.entities) {
          // Check if entity matches any column name or sample value in the table
          const matchesCol = cols.some((c) => (c.name || "").toLowerCase().includes(ent));
          const matchesSample = samples.some((s) =>
            Object.values(s).some((val) => String(val).toLowerCase().includes(ent)),
          );

          if (matchesCol || matchesSample) {
            matchingEntities.push(ent);
          }
        }

        if (matchingEntities.length > 0) {
          crossModalCorrelations.push({
            documentId: doc.id,
            documentTitle: doc.title,
            tableId: table.id,
            tableName: table.tableName,
            sharedEntities: matchingEntities.slice(0, 6),
            correlationDescription: `Dokumen "${doc.title}" berelasi secara konteks dengan tabel "${table.tableName}" melalui entitas [${matchingEntities.slice(0, 4).join(", ")}].`,
          });
        }
      }
    }

    // 6. SYNTHESIZE UNIFIED CLICKHOUSE VIEWS
    const unifiedClickhouseViews: UnifiedClickhouseView[] = [];
    const collectionSlug = col.slug.replace(/[^a-z0-9_]/g, "_");

    for (const rel of discoveredRelationships) {
      const viewName = `view_${collectionSlug}_${rel.sourceTable}_${rel.targetTable}`.replace(/[^a-z0-9_]/g, "_");
      const joinSql = `CREATE OR REPLACE VIEW ${viewName} AS
SELECT s.*, t.*
FROM ${rel.sourceTable} s
LEFT JOIN ${rel.targetTable} t
  ON s.${rel.sourceColumn} = t.${rel.targetColumn};`;

      unifiedClickhouseViews.push({
        viewName,
        description: `Unified join view combining ${rel.sourceTable} and ${rel.targetTable} on ${rel.sourceColumn} = ${rel.targetColumn}.`,
        joinSql,
        sourceTables: [rel.sourceTable, rel.targetTable],
      });
    }

    // 7. MULTI-TABLE SUGGESTED ANALYTICAL QUERIES
    const suggestedQueries: SuggestedQueryTemplate[] = [];

    for (const rel of discoveredRelationships) {
      suggestedQueries.push({
        title: `Join Analisis ${rel.sourceTable} & ${rel.targetTable}`,
        query: `Bagaimana perbandingan data antara ${rel.sourceTable} dan ${rel.targetTable} berdasarkan ${rel.sourceColumn}?`,
        category: "aggregation",
        sqlSnippet: `SELECT s.${rel.sourceColumn}, count(*) as total_records
FROM ${rel.sourceTable} s
JOIN ${rel.targetTable} t ON s.${rel.sourceColumn} = t.${rel.targetColumn}
GROUP BY s.${rel.sourceColumn}
ORDER BY total_records DESC
LIMIT 10;`,
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

    const summary = `Collection "${col.name}" terdiri dari ${memberSources.length} sumber data (${tables.length} tabel tabular, ${documentSources.length} dokumen RAG). Terdeteksi ${discoveredRelationships.length} relasi foreign key antar-file, ${crossDocumentCorrelations.length} korelasi dokumen, dan ${crossModalCorrelations.length} tautan dokumen-tabel.`;

    const finalProfile: CollectionSemanticProfile = {
      domain: inferredDomain,
      primaryTopics: Array.from(allTopics).slice(0, 10),
      entities: Array.from(allEntities).slice(0, 20),
      crossTableRelationships: discoveredRelationships,
      crossDocumentCorrelations,
      crossModalCorrelations,
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
