import { createHash } from "node:crypto";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  dataSourceQueryExperiences,
  dataSourceQueryFeedback,
} from "@paperclipai/db";
import type {
  QueryExperienceRecord,
  QueryFeedbackRecord,
  QueryExperienceStatus,
} from "@paperclipai/shared";

export interface RecordCandidateExperienceInput {
  companyId: string;
  originatingExecutionId: string;
  intent: string;
  parameterizedSql: string;
  parameterSchema?: Record<string, { type: string; description?: string }>;
  referencedDataSourceIds: string[];
  referencedTables: string[];
  referencedColumns: string[];
  metricBindings?: string[];
  schemaFingerprint: string;
  engine?: "clickhouse" | "live_external" | "hybrid";
  status?: "candidate" | "execution_checked";
  validationEvidence?: Record<string, unknown>;
}

export interface RecordFeedbackInput {
  companyId: string;
  executionId: string;
  experienceId?: string;
  actorType: "board" | "agent" | "user";
  actorId: string;
  sentiment: "positive" | "negative";
  businessFieldsToFix?: string[];
  correctionNote?: string;
}

export class DataSourceExperienceService {
  constructor(private db: Db) {}

  /**
   * P6-01 & P6-02: Record a candidate or execution-checked query experience in Postgres.
   * INVARIANT: Execution success alone does not promote to reference_verified or user_approved.
   */
  async recordCandidateExperience(
    input: RecordCandidateExperienceInput,
  ): Promise<QueryExperienceRecord> {
    const status: QueryExperienceStatus = input.status || "candidate";

    const [row] = await this.db
      .insert(dataSourceQueryExperiences)
      .values({
        companyId: input.companyId,
        originatingExecutionId: input.originatingExecutionId,
        intent: input.intent.trim(),
        parameterizedSql: input.parameterizedSql.trim(),
        parameterSchema: input.parameterSchema || {},
        referencedDataSourceIds: input.referencedDataSourceIds,
        referencedTables: input.referencedTables,
        referencedColumns: input.referencedColumns,
        metricBindings: input.metricBindings || [],
        schemaFingerprint: input.schemaFingerprint,
        engine: input.engine || "clickhouse",
        status,
        validationEvidence: input.validationEvidence || {},
      })
      .returning();

    return this.mapExperienceRow(row);
  }

  /**
   * P6-02: Record feedback on an execution and its linked experience.
   */
  async recordFeedback(input: RecordFeedbackInput): Promise<QueryFeedbackRecord> {
    const [feedbackRow] = await this.db
      .insert(dataSourceQueryFeedback)
      .values({
        companyId: input.companyId,
        executionId: input.executionId,
        experienceId: input.experienceId ? (input.experienceId as any) : null,
        actorType: input.actorType,
        actorId: input.actorId,
        sentiment: input.sentiment,
        businessFieldsToFix: input.businessFieldsToFix || [],
        correctionNote: input.correctionNote,
      })
      .returning();

    if (input.experienceId) {
      // If negative feedback, degrade or mark candidate/rejected
      const newStatus = input.sentiment === "negative" ? "rejected" : undefined;
      const updateData: any = {
        updatedAt: new Date(),
      };
      if (newStatus) {
        updateData.status = newStatus;
      }

      await this.db
        .update(dataSourceQueryExperiences)
        .set(updateData)
        .where(
          and(
            eq(dataSourceQueryExperiences.id, input.experienceId as any),
            eq(dataSourceQueryExperiences.companyId, input.companyId),
          ),
        );
    }

    return {
      id: feedbackRow.id,
      companyId: feedbackRow.companyId,
      executionId: feedbackRow.executionId,
      experienceId: feedbackRow.experienceId,
      actorType: feedbackRow.actorType as any,
      actorId: feedbackRow.actorId,
      sentiment: feedbackRow.sentiment as any,
      businessFieldsToFix: feedbackRow.businessFieldsToFix || [],
      correctionNote: feedbackRow.correctionNote,
      createdAt: (feedbackRow.createdAt ?? new Date()).toISOString(),
      updatedAt: (feedbackRow.updatedAt ?? feedbackRow.createdAt ?? new Date()).toISOString(),
    };
  }

  /**
   * P6-02: Explicitly promote an experience to reference_verified or user_approved.
   * Requires human review or reference benchmark verification evidence.
   */
  async promoteExperience(
    companyId: string,
    experienceId: string,
    targetStatus: "reference_verified" | "user_approved",
    evidence?: Record<string, unknown>,
  ): Promise<QueryExperienceRecord> {
    const reviewer = evidence?.reviewedBy || evidence?.reviewerId || evidence?.approverId || evidence?.verifiedBy;
    const benchmark = evidence?.referenceSql || evidence?.benchmarkRunId || evidence?.verifiedBy || evidence?.matchedGoldenWorkload;
    if (targetStatus === "user_approved" && !reviewer) {
      throw new Error("Promotion to 'user_approved' requires a reviewer identity (reviewedBy or reviewerId)");
    }
    if (targetStatus === "reference_verified" && !benchmark) {
      throw new Error("Promotion to 'reference_verified' requires benchmark or reference SQL evidence");
    }

    const [row] = await this.db
      .update(dataSourceQueryExperiences)
      .set({
        status: targetStatus,
        validationEvidence: evidence || {},
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dataSourceQueryExperiences.id, experienceId as any),
          eq(dataSourceQueryExperiences.companyId, companyId),
        ),
      )
      .returning();

    if (!row) {
      throw new Error(`Experience ${experienceId} not found in company ${companyId}`);
    }

    return this.mapExperienceRow(row);
  }

  /**
   * P6-03: Retrieve applicable verified experience for a question.
   * Guards:
   * 1. Status MUST be 'reference_verified' or 'user_approved' (unreviewed candidates never reused).
   * 2. ACL: All referencedDataSourceIds MUST be in caller's allowedDataSourceIds.
   * 3. Schema Fingerprint: MUST match currentSchemaFingerprint (prevents drift).
   */
  async retrieveApplicableExperience(
    companyId: string,
    query: string,
    allowedDataSourceIds: string[],
    currentSchemaFingerprint?: string,
  ): Promise<QueryExperienceRecord | null> {
    const qNorm = query.trim().toLowerCase();
    const allowedSet = new Set(allowedDataSourceIds);

    // Fetch verified experiences for this company
    const candidates = await this.db
      .select()
      .from(dataSourceQueryExperiences)
      .where(
        and(
          eq(dataSourceQueryExperiences.companyId, companyId),
          inArray(dataSourceQueryExperiences.status, ["reference_verified", "user_approved"]),
        ),
      )
      .orderBy(desc(dataSourceQueryExperiences.updatedAt));

    for (const exp of candidates) {
      // 1. ACL Guard: Check if ALL referenced sources are allowed
      const sources = exp.referencedDataSourceIds || [];
      const isAllowed = sources.every((s) => allowedSet.has(s));
      if (!isAllowed) {
        continue;
      }

      // 2. Drift Guard: Check schema fingerprint
      if (currentSchemaFingerprint && exp.schemaFingerprint !== currentSchemaFingerprint) {
        // Schema drifted since template was verified - do not reuse
        continue;
      }

      // 3. Intent match (exact or normalized token match)
      const expIntent = exp.intent.toLowerCase();
      if (expIntent === qNorm || this.calculateIntentOverlap(expIntent, qNorm) >= 0.85) {
        // Update lastUsedAt
        await this.db
          .update(dataSourceQueryExperiences)
          .set({ lastUsedAt: new Date() })
          .where(eq(dataSourceQueryExperiences.id, exp.id));

        return this.mapExperienceRow(exp);
      }
    }

    return null;
  }

  /**
   * P6-03: Parameter binding utility.
   * Binds template SQL parameters without copying hardcoded literals across users.
   */
  bindParameters(parameterizedSql: string, params: Record<string, unknown>): string {
    let bound = parameterizedSql;
    for (const [key, value] of Object.entries(params)) {
      const formatted = typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
      bound = bound.replaceAll(`:${key}`, formatted).replaceAll(`{{${key}}}`, formatted);
    }
    return bound;
  }

  /**
   * Calculate deterministic schema fingerprint from tables, columns, and metrics.
   */
  static computeSchemaFingerprint(components: {
    tables: string[];
    columns: string[];
    metrics?: string[];
  }): string {
    const sortedTables = [...components.tables].sort().join(",");
    const sortedColumns = [...components.columns].sort().join(",");
    const sortedMetrics = [...(components.metrics || [])].sort().join(",");
    return createHash("sha256")
      .update(`${sortedTables}|${sortedColumns}|${sortedMetrics}`)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Deterministically compute unified schema fingerprint from loaded table records.
   * Collects table names, schemaDefinition column names/types, and semanticModel dimensions & metrics.
   */
  static computeFingerprintFromTables(tables: Array<{
    tableName: string;
    schemaDefinition?: any[];
    semanticModel?: Record<string, unknown> | null;
  }>): string {
    const tableNames: string[] = [];
    const columns: string[] = [];
    const metrics: string[] = [];

    for (const t of tables) {
      tableNames.push(t.tableName);
      const schema = Array.isArray(t.schemaDefinition) ? t.schemaDefinition : [];
      for (const col of schema) {
        columns.push(`${t.tableName}.${col.name || ""}:${col.dataType || ""}`);
      }
      const sem = (t.semanticModel as any) || {};
      for (const dim of sem.dimensions || []) {
        if (typeof dim === "string") {
          columns.push(`${t.tableName}.${dim}`);
        } else {
          const synonyms = Array.isArray(dim.synonyms) ? dim.synonyms.map(String).sort().join(",") : "";
          columns.push(`${t.tableName}.${dim.name || ""}:${dim.column || ""}:${synonyms}`);
        }
      }
      for (const m of sem.metrics || []) {
        if (typeof m === "string") {
          metrics.push(`${t.tableName}.${m}`);
        } else {
          const synonyms = Array.isArray(m.synonyms) ? m.synonyms.map(String).sort().join(",") : "";
          const physicalColumn = m.column || m.physicalColumn || "";
          metrics.push(`${t.tableName}.${m.name || ""}:${physicalColumn}:${m.aggregation || ""}:${synonyms}`);
        }
      }
    }

    return DataSourceExperienceService.computeSchemaFingerprint({
      tables: tableNames,
      columns,
      metrics,
    });
  }

  computeFingerprintFromTables(tables: Array<{
    tableName: string;
    schemaDefinition?: any[];
    semanticModel?: Record<string, unknown> | null;
  }>): string {
    return DataSourceExperienceService.computeFingerprintFromTables(tables);
  }

  computeSchemaFingerprint(components: {
    tables: string[];
    columns: string[];
    metrics?: string[];
  }): string {
    return DataSourceExperienceService.computeSchemaFingerprint(components);
  }

  async listExperiences(
    companyId: string,
    filter?: { status?: QueryExperienceStatus; allowedDataSourceIds?: string[]; dataSourceId?: string },
  ): Promise<QueryExperienceRecord[]> {
    const conditions = [eq(dataSourceQueryExperiences.companyId, companyId)];
    if (filter?.status) {
      conditions.push(eq(dataSourceQueryExperiences.status, filter.status));
    }

    const rows = await this.db
      .select()
      .from(dataSourceQueryExperiences)
      .where(and(...conditions))
      .orderBy(desc(dataSourceQueryExperiences.createdAt));

    let mapped = rows.map((r) => this.mapExperienceRow(r));
    if (filter?.allowedDataSourceIds !== undefined) {
      const allowedSet = new Set(filter.allowedDataSourceIds);
      mapped = filter.allowedDataSourceIds.length === 0
        ? []
        : mapped.filter((r) =>
            r.referencedDataSourceIds.length === 0 ||
            r.referencedDataSourceIds.every((id) => allowedSet.has(id))
          );
    }
    if (filter?.dataSourceId) {
      mapped = mapped.filter((r) => r.referencedDataSourceIds.includes(filter.dataSourceId!));
    }
    return mapped;
  }

  private calculateIntentOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let match = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) match++;
    }
    return (2 * match) / (wordsA.size + wordsB.size);
  }

  private mapExperienceRow(row: any): QueryExperienceRecord {
    return {
      id: row.id,
      companyId: row.companyId,
      originatingExecutionId: row.originatingExecutionId,
      intent: row.intent,
      parameterizedSql: row.parameterizedSql,
      parameterSchema: row.parameterSchema,
      referencedDataSourceIds: row.referencedDataSourceIds || [],
      referencedTables: row.referencedTables || [],
      referencedColumns: row.referencedColumns || [],
      metricBindings: row.metricBindings || [],
      schemaFingerprint: row.schemaFingerprint,
      engine: row.engine as any,
      status: row.status as any,
      validationEvidence: row.validationEvidence,
      feedbackCount: row.feedbackCount,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
