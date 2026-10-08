import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DataSourceMappingReviewRequest } from "@paperclipai/shared";
import { activityLog, dataSourceChunks, dataSourceJobs, dataSources, dataSourceTables, type Db } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { DataSourceCacheService } from "./data-source-cache.js";

export type MappingReviewColumn = {
  name: string;
  dataType?: string;
  role?: string;
  semanticCategory?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
};

export type MappingReviewCorrection = {
  index: number;
  name: string;
  column: string;
  description?: string;
  aggregation?: string;
};

type SemanticMetric = Record<string, unknown> & {
  name: string;
  column?: string;
  aggregation?: string;
};

type SemanticDimension = Record<string, unknown> & {
  name: string;
  column?: string;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function schemaFingerprint(columns: MappingReviewColumn[]): string {
  const contract = columns.map((column) => ({
    name: column.name,
    dataType: column.dataType || "unknown",
    role: column.role || "attribute",
    semanticCategory: column.semanticCategory || "general",
  })).sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex").slice(0, 32);
}

function schemaChunkContent(tableName: string, model: Record<string, any>, columns: MappingReviewColumn[]): string {
  const columnText = columns.slice(0, 500).map((column) =>
    `${column.name} (${column.dataType || "string"}${column.role ? `, role: ${column.role}` : ""})`,
  ).join(", ");
  const metricText = (Array.isArray(model.metrics) ? model.metrics : []).slice(0, 100).map((metric: any) =>
    `${metric.name || "metric"} [${metric.aggregation || "unknown"} · ${metric.column || metric.physicalColumn || "unbound"}]${metric.description ? `: ${metric.description}` : ""}`,
  ).join("; ");
  const dimensionText = (Array.isArray(model.dimensions) ? model.dimensions : []).slice(0, 100).map((dimension: any) =>
    `${dimension.name || "dimension"} [${dimension.column || "unbound"}]${dimension.description ? `: ${dimension.description}` : ""}`,
  ).join("; ");
  const parts = [
    `Table: ${tableName}`,
    `Role: ${model.tableRole || "table"}`,
    `Columns: ${columnText}`,
    metricText ? `Metrics: ${metricText}` : "",
    dimensionText ? `Dimensions: ${dimensionText}` : "",
  ].filter(Boolean);
  return parts.join("\n").slice(0, 24_000);
}

function isSensitiveColumn(column: MappingReviewColumn): boolean {
  if (["identity", "contact"].includes(String(column.semanticCategory || "").toLowerCase())) return true;
  return /(^|_)(nik|ktp|npwp|email|e_mail|phone|mobile|telepon|alamat|address|personal_id|passport)(_|$)/i.test(column.name);
}

function correctionForColumn(columns: MappingReviewColumn[], name: string, kind: "metric" | "dimension", aggregation?: string) {
  const column = columns.find((candidate) => candidate.name === name);
  if (!column) throw badRequest(`Kolom '${name}' tidak ada dalam schema tabel yang sedang direview`);
  if (isSensitiveColumn(column)) {
    throw badRequest(`Kolom sensitif '${name}' tidak dapat dipakai sebagai semantic ${kind}`);
  }
  if (kind === "metric" && aggregation !== "count" && column.dataType !== "number" && column.role !== "metric") {
    throw badRequest(`Kolom '${name}' bukan kolom numerik yang dapat dipakai sebagai metric`);
  }
  return column;
}

export function applyDataSourceMappingCorrections<T extends { name: string }>(
  values: unknown,
  corrections: MappingReviewCorrection[],
  kind: "metric" | "dimension",
  columns: MappingReviewColumn[],
): T[] {
  const current: Record<string, any>[] = Array.isArray(values)
    ? values.map((value) => typeof value === "string" ? { name: value } : { ...asRecord(value) })
    : [];
  for (const correction of corrections) {
    const existing = current[correction.index];
    if (!existing || typeof existing.name !== "string") {
      throw badRequest(`Index semantic ${kind} ${correction.index} tidak ditemukan`);
    }
    const physicalColumn = correctionForColumn(columns, correction.column, kind, correction.aggregation);
    const previousName = existing.name;
    const next = {
      ...existing,
      name: correction.name.trim(),
      column: physicalColumn.name,
      description: correction.description?.trim() || "",
      provenance: "user_defined",
    } as Record<string, any>;
    if (previousName !== next.name) {
      const aliases = Array.isArray(existing.synonyms) ? existing.synonyms : [];
      next.synonyms = [...new Set([...aliases.filter((value: unknown): value is string => typeof value === "string"), previousName])];
    }
    if (kind === "metric") {
      next.physicalColumn = physicalColumn.name;
      next.aggregation = correction.aggregation;
      next.publicationGateStatus = "verified";
      // A human correction binds a field, never a free-form SQL expression.
      delete next.expression;
    } else if (existing.column !== physicalColumn.name) {
      // Sample values belonged to the old physical field and must not survive rebinding.
      delete next.sampleValues;
    }
    current[correction.index] = next;
  }

  const duplicate = new Set<string>();
  for (const value of current) {
    const normalized = normalizeIdentity(String(value.name || ""));
    if (normalized && duplicate.has(normalized)) {
      throw badRequest(`Semantic ${kind} '${value.name}' menduplikasi nama lain; gunakan label unik`);
    }
    duplicate.add(normalized);
  }
  return current as T[];
}

/** Persists operator mapping review, safely binds corrections to catalog columns, and invalidates query cache. */
export class DataSourceMappingReviewService {
  private cache = new DataSourceCacheService();

  constructor(private db: Db) {}

  async review(input: {
    companyId: string;
    dataSourceId: string;
    tableId: string;
    reviewerId: string;
    request: DataSourceMappingReviewRequest;
  }) {
    const reviewedAt = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [source] = await tx.select().from(dataSources).where(and(
        eq(dataSources.id, input.dataSourceId),
        eq(dataSources.companyId, input.companyId),
      )).for("update");
      if (!source) throw notFound("Data source not found");
      if (source.status !== "ready") throw badRequest("Semantic mapping can only be reviewed after datasource onboarding is ready");

      const [table] = await tx.select().from(dataSourceTables).where(and(
        eq(dataSourceTables.id, input.tableId),
        eq(dataSourceTables.dataSourceId, input.dataSourceId),
        eq(dataSourceTables.companyId, input.companyId),
      )).for("update");
      if (!table) throw notFound("Data source table not found");

      const columns = (Array.isArray(table.schemaDefinition) ? table.schemaDefinition : []) as MappingReviewColumn[];
      if (columns.some((column) => !column || typeof column.name !== "string" || !column.name)) {
        throw badRequest("Table schema is incomplete; mapping review cannot bind to it safely");
      }
      const priorModel = asRecord(table.semanticModel);
      const metricCorrections = input.request.metricCorrections || [];
      const dimensionCorrections = input.request.dimensionCorrections || [];
      let metrics = Array.isArray(priorModel.metrics) ? priorModel.metrics : [];
      let dimensions = Array.isArray(priorModel.dimensions) ? priorModel.dimensions : [];
      const hasCorrections = metricCorrections.length + dimensionCorrections.length > 0;

      if (hasCorrections) {
        const [activeJob] = await tx.select({ id: dataSourceJobs.id }).from(dataSourceJobs).where(and(
          eq(dataSourceJobs.companyId, input.companyId),
          eq(dataSourceJobs.dataSourceId, input.dataSourceId),
          inArray(dataSourceJobs.status, ["queued", "running", "cancel_requested"]),
        )).limit(1);
        if (activeJob) throw conflict("Mapping cannot change while an ingestion, snapshot, or embedding job is active; retry after it finishes");
      }

      if (input.request.decision === "corrected" || (input.request.decision === "approved" && hasCorrections)) {
        metrics = applyDataSourceMappingCorrections<SemanticMetric>(metrics, metricCorrections, "metric", columns);
        dimensions = applyDataSourceMappingCorrections<SemanticDimension>(dimensions, dimensionCorrections, "dimension", columns);
      }
      if (input.request.decision === "approved") {
        // Approval verifies the final bindings, including untouched fields, against the current catalog.
        for (const metric of metrics) {
          const model = asRecord(metric);
          const column = typeof model.column === "string" ? model.column : model.physicalColumn;
          if (typeof column !== "string" || !column) throw badRequest(`Metric '${model.name || "unknown"}' belum terikat ke kolom fisik`);
          correctionForColumn(columns, column, "metric", model.aggregation);
        }
        for (const dimension of dimensions) {
          const model = asRecord(dimension);
          const column = typeof model.column === "string" ? model.column : model.name;
          if (typeof column !== "string" || !column) throw badRequest(`Dimension '${model.name || "unknown"}' belum terikat ke kolom fisik`);
          correctionForColumn(columns, column, "dimension");
        }
      }

      if (input.request.decision === "approved") {
        metrics = metrics.map((rawMetric) => ({
          ...asRecord(rawMetric),
          provenance: asRecord(rawMetric).provenance === "user_defined" ? "user_defined" : "verified",
          publicationGateStatus: "verified",
        }));
        dimensions = dimensions.map((rawDimension) => ({
          ...asRecord(rawDimension),
          provenance: asRecord(rawDimension).provenance === "user_defined" ? "user_defined" : "verified",
        }));
      }

      const fingerprint = schemaFingerprint(columns);
      const priorReview = asRecord(priorModel.mappingReview);
      const revision = Number.isSafeInteger(priorReview.revision) && priorReview.revision >= 0
        ? priorReview.revision + 1
        : 1;
      const history = Array.isArray(priorModel.mappingReviewHistory) ? priorModel.mappingReviewHistory : [];
      const event = {
        id: randomUUID(),
        decision: input.request.decision,
        reviewerId: input.reviewerId,
        reviewedAt: reviewedAt.toISOString(),
        schemaFingerprint: fingerprint,
        ...(input.request.note ? { note: input.request.note } : {}),
        metricCorrections,
        dimensionCorrections,
      };
      const nextModel: Record<string, any> = {
        ...priorModel,
        metrics,
        dimensions,
        version: Number.isSafeInteger(priorModel.version) ? Number(priorModel.version) + 1 : 2,
        mappingReview: {
          status: input.request.decision,
          revision,
          reviewerId: input.reviewerId,
          reviewedAt: reviewedAt.toISOString(),
          schemaFingerprint: fingerprint,
          ...(input.request.note ? { note: input.request.note } : {}),
        },
        mappingReviewHistory: [...history, event].slice(-20),
      };

      await tx.update(dataSourceTables).set({ semanticModel: nextModel, updatedAt: reviewedAt })
        .where(and(
          eq(dataSourceTables.id, input.tableId),
          eq(dataSourceTables.dataSourceId, input.dataSourceId),
          eq(dataSourceTables.companyId, input.companyId),
        ));

      let embeddingRefreshPending = false;
      if (hasCorrections) {
        const qualifiedTableName = nextModel.sourceSchema
          ? `${nextModel.sourceSchema}.${table.tableName}`
          : table.tableName;
        const schemaChunks = await tx.select({ id: dataSourceChunks.id }).from(dataSourceChunks).where(and(
          eq(dataSourceChunks.companyId, input.companyId),
          eq(dataSourceChunks.dataSourceId, input.dataSourceId),
          sql`${dataSourceChunks.metadata}->>'tableId' = ${table.id}`,
        )).for("update");
        if (schemaChunks.length > 0) {
          const content = schemaChunkContent(qualifiedTableName, nextModel, columns);
          for (const chunk of schemaChunks) {
            await tx.update(dataSourceChunks).set({ content, embedding: null })
              .where(and(eq(dataSourceChunks.id, chunk.id), eq(dataSourceChunks.companyId, input.companyId)));
          }
          embeddingRefreshPending = true;
        }
      }

      const metadata = asRecord(source.metadata);
      const profile = asRecord(metadata.semanticProfile);
      const profiles = asRecord(profile.tableProfiles);
      const identity = nextModel.sourceSchema
        ? `${nextModel.sourceSchema}.${table.tableName}`
        : table.tableName;
      const priorProfile = asRecord(profiles[identity]);
      profiles[identity] = {
        ...priorProfile,
        tableName: identity,
        ...(typeof nextModel.context === "string" ? { context: nextModel.context } : {}),
        ...(Array.isArray(nextModel.topics) ? { topics: nextModel.topics } : {}),
        ...(Array.isArray(nextModel.entities) ? { entities: nextModel.entities } : {}),
        metrics,
        dimensions,
        mappingReview: nextModel.mappingReview,
      };
      const nextMetadata: Record<string, unknown> = {
        ...metadata,
        semanticProfile: { ...profile, tableProfiles: profiles },
        ...(embeddingRefreshPending ? { semanticMappingRevision: revision, embeddingStatus: "pending", embeddingReindexStatus: "pending" } : {}),
      };
      if (embeddingRefreshPending) {
        const oldSpace = nextMetadata.embeddingSpace;
        const oldGeneration = nextMetadata.embeddingGeneration;
        if (oldSpace === "bge-m3" || oldSpace === "openrouter-text-embedding-3-small") {
          nextMetadata.previousEmbeddingSpace = oldSpace;
          if (typeof oldGeneration === "string") nextMetadata.previousEmbeddingGeneration = oldGeneration;
        }
        delete nextMetadata.embeddingSpace;
        delete nextMetadata.embeddingGeneration;
        delete nextMetadata.embeddingTargetSpace;
        delete nextMetadata.embeddingTargetGeneration;
      }
      await tx.update(dataSources).set({
        metadata: nextMetadata,
        updatedAt: reviewedAt,
      }).where(and(eq(dataSources.id, input.dataSourceId), eq(dataSources.companyId, input.companyId)));

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.reviewerId,
        action: "data_source.semantic_mapping_reviewed",
        entityType: "data_source_table",
        entityId: table.id,
        details: {
          dataSourceId: input.dataSourceId,
          tableName: table.tableName,
          decision: input.request.decision,
          revision,
          schemaFingerprint: fingerprint,
          metricCorrectionCount: metricCorrections.length,
          dimensionCorrectionCount: dimensionCorrections.length,
          embeddingRefreshPending,
        },
      });

      return { tableId: table.id, tableName: table.tableName, semanticModel: nextModel, embeddingRefreshPending };
    });

    await this.cache.invalidateDataSourceCache(input.companyId, input.dataSourceId);
    return result;
  }
}
