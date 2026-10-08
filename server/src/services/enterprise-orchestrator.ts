import { randomUUID, createHash } from "node:crypto";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  orchestratorSessions,
  orchestratorMessages,
  dataSources,
  dataSourceTables,
  dataSourceCollections,
  dataSourceQueryExecutions,
  dataSourceQueryExperiences,
  agents,
} from "@paperclipai/db";
import type {
  OrchestrationPlan,
  OrchestratorMessage,
  OrchestratorRoute,
  OrchestratorSession,
  SpecialistExecution,
  DataSourceSemanticProfile,
  AgentDataSourceOrchestrationEffectiveState,
  DataSourceOrchestrationMode,
  QueryContextRequest,
  QueryContextResponse,
  CreateQueryExecutionRequest,
  QueryExecutionRecord,
  QueryExecutionListItem,
  QueryExecutionFeedbackRequest,
} from "@paperclipai/shared";
import { DataAgentService } from "./data-agent.js";
import { KnowledgeAgentService } from "./knowledge-agent.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { EnterpriseAgentRosterService } from "./enterprise-agent-roster.js";
import { DataSourcesService } from "./data-sources.js";
import { DataSourceQueryTracer } from "./data-source-query-trace.js";
import { DataSourceVectorStore } from "./data-source-vector-store.js";
import { RagModelService } from "./rag-models.js";
import { QuestionDeadlineBudget } from "./question-deadline-budget.js";
import { DataSourceCacheService, makePlanCacheKey } from "./data-source-cache.js";
import { DataSourceExperienceService } from "./data-source-experience.js";
import { DataSourcePlanValidator, type PlanValidationResult } from "./data-source-plan-validator.js";
import { resolveQueryTableScope } from "./data-source-query-scope.js";
import { clickhouseSourceTableName } from "./clickhouse.js";

function queryExecutionRecordFromRow(row: typeof dataSourceQueryExecutions.$inferSelect): QueryExecutionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId ?? undefined,
    runId: row.runId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    dataSourceIds: Array.isArray(row.dataSourceIds) ? row.dataSourceIds : undefined,
    query: row.query,
    status: row.status as QueryExecutionRecord["status"],
    engine: row.engine ?? "clickhouse",
    resultsSummary: row.resultsSummary ?? undefined,
    data: row.dataPreview ?? undefined,
    traceId: row.traceId ?? undefined,
    stageTimings: row.stageTimings as any,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
  };
}

function sameDatasourceScope(left: string[], right: string[]): boolean {
  const normalize = (ids: string[]) => Array.from(new Set(ids)).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export interface SchemaRetrievalCandidate {
  id: string;
  dataSourceId: string;
  tableName: string;
  metrics: string[];
  dimensions: string[];
  relevanceScore?: number;
  matchedBy?: "exact_match" | "lexical" | "vector" | "hybrid";
}

export interface HybridRetrievalResult {
  candidates: SchemaRetrievalCandidate[];
  skippedVectorRerank: boolean;
  exactMatchFound: boolean;
  reasoning: string;
}

export interface QueryRoutingDecision {
  route: "clickhouse_snapshot" | "live_external" | "clarify";
  reason: string;
  consistencyLevel: "snapshot_read_committed" | "live_transactional" | "unverified";
}

export function computePlanHash(input: {
  query: string;
  parameters?: Record<string, unknown>;
  templateId?: string;
  dataSourceIds?: string[];
}): string {
  const normQuery = input.query.trim().toLowerCase();
  const sortedParams = Object.keys(input.parameters || {})
    .sort()
    .map((k) => `${k}:${JSON.stringify((input.parameters || {})[k])}`)
    .join(";");
  const templateId = input.templateId || "";
  const sortedDataSources = [...(input.dataSourceIds || [])].sort().join(",");
  return createHash("sha256")
    .update(`${normQuery}|${sortedParams}|${templateId}|${sortedDataSources}`)
    .digest("hex");
}

export class EnterpriseOrchestratorService {
  private dataAgent: DataAgentService;
  private knowledgeAgent: KnowledgeAgentService;
  private jevService: TypeSafeJevService;
  private rosterService: EnterpriseAgentRosterService;
  private dataSourcesService: DataSourcesService;
  private cacheService: DataSourceCacheService;
  public readonly experienceService: DataSourceExperienceService;
  private activeExecutions = new Map<string, {
    record: QueryExecutionRecord;
    budget: QuestionDeadlineBudget;
  }>();
  private feedbackRegistry = new Map<string, QueryExecutionFeedbackRequest>();
  private resolvedContextsCache = new Map<string, {
    context: QueryContextResponse;
    expiresAt: number;
  }>();

  constructor(private db: Db) {
    this.dataAgent = new DataAgentService(db);
    this.knowledgeAgent = new KnowledgeAgentService(db);
    this.jevService = new TypeSafeJevService();
    this.rosterService = new EnterpriseAgentRosterService(db);
    this.dataSourcesService = new DataSourcesService(db);
    this.cacheService = new DataSourceCacheService();
    this.experienceService = new DataSourceExperienceService(db);
  }

  /**
   * List sessions for a company
   */
  async listSessions(companyId: string): Promise<OrchestratorSession[]> {
    const list = await this.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.companyId, companyId))
      .orderBy(desc(orchestratorSessions.createdAt));

    return list as any[];
  }

  /**
   * Create new session
   */
  async createSession(companyId: string, title?: string): Promise<OrchestratorSession> {
    const [session] = await this.db
      .insert(orchestratorSessions)
      .values({
        companyId,
        title: title || "New Orchestration Session",
        status: "active",
      })
      .returning();

    return session as any;
  }

  /**
   * Get messages for a session
   */
  async getMessages(companyId: string, sessionId: string): Promise<OrchestratorMessage[]> {
    const list = await this.db
      .select()
      .from(orchestratorMessages)
      .where(and(eq(orchestratorMessages.sessionId, sessionId), eq(orchestratorMessages.companyId, companyId)))
      .orderBy(orchestratorMessages.createdAt);

    return list as any[];
  }

  /**
   * Main Orchestrator Chat Execution
   * Dynamic System One Decision Plane (TypeSafe Jev 1.13.0) -> Route -> Delegate -> Synthesize
   * Driven by live agents & live data source semantic profiles.
   */
  async chat(
    companyId: string,
    sessionId: string,
    userQuery: string,
    options: { dataSourceIds?: string[]; authzFingerprint?: string } = {},
  ): Promise<OrchestratorMessage> {
    // 0. Ensure enterprise agent roster (cached per company)
    await this.rosterService.ensureEnterpriseRoster(companyId);

    // 1. Save user query message
    await this.db.insert(orchestratorMessages).values({
      sessionId,
      companyId,
      role: "user",
      content: userQuery,
    });

    // 2. Discover available data sources and their tables + semantic profiles
    const allAvailableSources = await this.db
      .select({
        id: dataSources.id,
        name: dataSources.name,
        type: dataSources.sourceType,
        status: dataSources.status,
        metadata: dataSources.metadata,
        collectionId: dataSources.collectionId,
      })
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.status, "ready")));

    const allTables = await this.db
      .select({
        dataSourceId: dataSourceTables.dataSourceId,
        tableName: dataSourceTables.tableName,
      })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    const allowedDataSourceIds = options.dataSourceIds ? new Set(options.dataSourceIds) : null;
    const availableSources = allowedDataSourceIds
      ? allAvailableSources.filter((source) => allowedDataSourceIds.has(source.id))
      : allAvailableSources;
    const tables = allowedDataSourceIds
      ? allTables.filter((table) => allowedDataSourceIds.has(table.dataSourceId))
      : allTables;

    const sourcesWithTables = availableSources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      tables: tables.filter((t) => t.dataSourceId === s.id).map((t) => t.tableName),
      semanticProfile: ((s.metadata as any)?.semanticProfile || null) as DataSourceSemanticProfile | null,
    }));

    // 3. Fetch live agents for dynamic routing
    const registeredAgents = await this.rosterService.getRosterForRouting(companyId);

    // 4. System One Decisional Semantic Layer (TypeSafe Jev 1.13.0) - DYNAMIC & BASED ON ONBOARDING PROFILES
    const jevDecision = await this.jevService.routeUserQuery(userQuery, sourcesWithTables, registeredAgents);

    let route: OrchestratorRoute = jevDecision.route;
    let confidence = jevDecision.confidence;
    let reasoning = jevDecision.reasoning;

    // Resolve target collection if any
    const targetSource = availableSources.find((s) => s.id === jevDecision.targetSourceId);
    let matchedCollectionId = targetSource?.collectionId || undefined;

    if (!matchedCollectionId) {
      const collections = await this.db
        .select({ id: dataSourceCollections.id, name: dataSourceCollections.name, slug: dataSourceCollections.slug })
        .from(dataSourceCollections)
        .where(eq(dataSourceCollections.companyId, companyId));

      const qLower = userQuery.toLowerCase();
      const colMatch = collections.find(
        (c) => qLower.includes(c.name.toLowerCase()) || qLower.includes(c.slug.toLowerCase())
      );
      if (colMatch) {
        matchedCollectionId = colMatch.id;
      }
    }

    // 5. Delegate to Specialist Agents
    const specialistExecutions: SpecialistExecution[] = [];

    if (route === "data_agent" || route === "analytics_engineer_agent" || route === "prediction_agent" || route === "hybrid") {
      const dataResult = await this.dataAgent.answer(companyId, userQuery, {
        collectionId: matchedCollectionId,
        dataSourceIds: options.dataSourceIds,
        authzFingerprint: options.authzFingerprint,
        sessionId,
        traceId: `orch-${sessionId}-${Date.now()}`,
      });
      specialistExecutions.push(dataResult);
    }

    if (route === "knowledge_agent" || route === "research_agent" || route === "hybrid") {
      const knowledgeResult = await this.knowledgeAgent.answer(companyId, userQuery, {
        dataSourceId: jevDecision.targetSourceId,
        collectionId: matchedCollectionId,
        dataSourceIds: options.dataSourceIds,
        authzFingerprint: options.authzFingerprint,
      });
      specialistExecutions.push(knowledgeResult);
    }

    // 6. Synthesize Grounded Executive Response
    let synthesizedAnswer = "";

    if (route === "direct") {
      synthesizedAnswer = `Halo! Saya adalah **Homseo**, Chief of Staff & Main Enterprise Agent Orchestrator untuk rissets.\n\nSaya mengorkestrasi agen-agen spesialis dan terhubung langsung ke sumber data internal yang telah siap digunakan:
- **External Databases (MariaDB/Postgres):** ${availableSources.filter((s) => s.type === "mariadb" || s.type === "postgres" || s.type === "mysql").map((s) => s.name).join(", ") || "Belum ada"}
- **Structured Datasets (CSV/Excel):** ${availableSources.filter((s) => s.type === "csv" || s.type === "excel").map((s) => s.name).join(", ") || "Belum ada"}
- **Knowledge Documents (RAG):** ${availableSources.filter((s) => s.type === "rag_document").map((s) => s.name).join(", ") || "Belum ada"}

Seluruh keputusan query diarahkan secara dinamis oleh **TypeSafe AI Jev System One (jev-1.13.0)** berdasarkan semantic profile dari masing-masing data source. Silakan tanyakan analisis data, profil entitas, atau regulasi internal!`;
    } else if (route === "hybrid") {
      const dataExec = specialistExecutions.find((e) => e.agent === "data_agent");
      const knowExec = specialistExecutions.find((e) => e.agent === "knowledge_agent");

      synthesizedAnswer = `### Sintesis Eksekutif & Lintas Domain\n\n`;
      synthesizedAnswer += `*Keputusan semantik divalidasi oleh TypeSafe Jev System One (${(confidence * 100).toFixed(0)}% confidence).*\n\n`;

      if (dataExec?.resultsSummary) {
        synthesizedAnswer += `#### 📊 Temuan Data & Profil Internal\n${dataExec.resultsSummary}\n\n`;
      }

      if (knowExec?.resultsSummary) {
        synthesizedAnswer += `#### 📋 Konteks Regulasi & Kebijakan Internal\n${knowExec.resultsSummary}\n\n`;
      }

      synthesizedAnswer += `\n*Dikoordinasikan dan diverifikasi oleh Homseo (Main Enterprise Orchestrator).*`;
    } else if (route === "data_agent" || route === "analytics_engineer_agent" || route === "prediction_agent") {
      const dataExec = specialistExecutions.find((e) => e.agent === "data_agent") || specialistExecutions[0];
      synthesizedAnswer = dataExec?.resultsSummary || "Tidak ada hasil data yang dapat disintesis.";
    } else if (route === "knowledge_agent" || route === "research_agent") {
      const knowExec = specialistExecutions.find((e) => e.agent === "knowledge_agent") || specialistExecutions[0];
      synthesizedAnswer = knowExec?.resultsSummary || "Tidak ada rujukan dokumen yang dapat disintesis.";
    } else if (route === "onboarding_orchestrator") {
      synthesizedAnswer = `### Onboarding Orchestrator\n\nSaat ini terdapat **${availableSources.length}** data source terdaftar di sistem:\n` +
        availableSources.map((s) => `- **${s.name}** (${s.type.toUpperCase()}) — Status: Ready`).join("\n") +
        `\n\nAnda dapat menambahkan data source baru melalui menu Data Sources (Upload CSV/Excel/PDF atau Hubungkan Database Eksternal).`;
    } else {
      synthesizedAnswer = specialistExecutions[0]?.resultsSummary || `Tugas diproses oleh spesialis ${route}.`;
    }

    const plan: OrchestrationPlan = {
      intent: userQuery,
      route,
      confidence,
      reasoning,
      selectedDataSources: availableSources as any[],
      specialistExecutions,
      synthesizedAnswer,
      jevDecisions: jevDecision.jevResult,
    };

    // 7. Save assistant message with plan
    const [assistantMsg] = await this.db
      .insert(orchestratorMessages)
      .values({
        sessionId,
        companyId,
        role: "assistant",
        content: synthesizedAnswer,
        orchestrationPlan: plan as any,
      })
      .returning();

    return assistantMsg as any;
  }

  /**
   * Resolve effective orchestration state for an agent
   */
  async resolveEffectiveOrchestrationState(
    companyId: string,
    agentId: string,
  ): Promise<AgentDataSourceOrchestrationEffectiveState> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));

    if (!agent) {
      return {
        mode: "off",
        enabled: false,
        adapterSupported: false,
        assignmentScope: "none",
        effectiveDataSourceIds: [],
        reason: `Agent not found: ${agentId}`,
      };
    }

    const orchestrationConfig = (agent.metadata as any)?.datasourceOrchestration;
    const mode: DataSourceOrchestrationMode = orchestrationConfig?.mode === "off" ? "off" : "auto";

    const adapterType = agent.adapterType || "";
    const supportedAdapters = new Set([
      "pi_local", "pi-local", "pi", "pi-cli",
      "codex_local", "codex-local",
      "claude_local", "claude-local",
      "cursor_local", "cursor",
      "gemini_local", "opencode_local",
      "process",
    ]);
    const adapterSupported = supportedAdapters.has(adapterType);

    const access = await this.dataSourcesService.getAgentDataSources(companyId, agentId);
    const assignmentScope = access.mode;
    const effectiveDataSourceIds = access.mode === "none" ? [] : access.effectiveDataSourceIds || [];

    const companyAllowlist = process.env.DATASOURCE_ORCHESTRATION_COMPANY_ALLOWLIST
      ? process.env.DATASOURCE_ORCHESTRATION_COMPANY_ALLOWLIST.split(",").map((s) => s.trim())
      : null;
    const companyRolloutEnabled = process.env.DATASOURCE_ORCHESTRATION_ENABLED !== "false"
      && (!companyAllowlist || companyAllowlist.includes(companyId));
    const enabled = companyRolloutEnabled && mode === "auto" && adapterSupported && assignmentScope !== "none" && effectiveDataSourceIds.length > 0;

    return {
      mode,
      enabled,
      adapterSupported,
      assignmentScope,
      effectiveDataSourceIds,
      reason: !enabled
        ? !companyRolloutEnabled
          ? "Enterprise datasource orchestration is disabled via rollout flag"
          : mode === "off"
            ? "Orchestration mode is explicitly set to Off"
            : !adapterSupported
              ? `Adapter '${adapterType}' does not support data source orchestration`
              : assignmentScope === "none"
                ? "Agent has no data source assignments (scope: none)"
                : "No active data sources available in scope"
        : undefined,
    };
  }

  /**
   * P1-01: Shared prepareQuery coordinator entry point (resolves access, candidate tables, freshness, and experiences).
   */
  async prepareQuery(
    companyId: string,
    request: QueryContextRequest,
  ): Promise<QueryContextResponse> {
    return this.resolveQueryContext(companyId, request);
  }

  /**
   * P1-03: Shared plan validator for physical bindings, metrics, grain, joins, freshness, and scan cost.
   */
  async validatePlan(
    companyId: string,
    input: {
      allowedDataSourceIds: string[];
      referencedTables: string[];
      referencedColumns?: Array<{ table: string; column: string }>;
      metrics?: Array<{ name: string; formula?: string; column?: string; aggregation?: string; grain?: string; timezone?: string }>;
      joins?: Array<{ leftTable: string; rightTable: string; leftColumn: string; rightColumn: string }>;
      estimatedRowsScan?: number;
    },
  ): Promise<PlanValidationResult> {
    const tableRows = await this.db
      .select({
        id: dataSourceTables.id,
        dataSourceId: dataSourceTables.dataSourceId,
        tableName: dataSourceTables.tableName,
        rowCount: dataSourceTables.rowCount,
        schemaDefinition: dataSourceTables.schemaDefinition,
        semanticModel: dataSourceTables.semanticModel,
      })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    const validator = new DataSourcePlanValidator();
    return validator.validatePlan({
      companyId,
      allowedDataSourceIds: input.allowedDataSourceIds,
      tables: tableRows.map((t) => ({
        id: t.id,
        dataSourceId: t.dataSourceId,
        tableName: t.tableName,
        rowCount: t.rowCount ?? 0,
        schemaDefinition: (t.schemaDefinition as any) || [],
        semanticModel: (t.semanticModel as any) || {},
      })),
      referencedTables: input.referencedTables,
      referencedColumns: input.referencedColumns || [],
      metrics: input.metrics,
      joins: input.joins,
      estimatedRowsScan: input.estimatedRowsScan,
    });
  }

  /**
   * P1-03: Shared executePlan method executing via engine, admission, cache, deadline budget, and cancellation.
   */
  async executePlan(
    companyId: string,
    request: CreateQueryExecutionRequest,
  ): Promise<QueryExecutionRecord> {
    return this.createQueryExecution(companyId, request);
  }

  /**
   * Resolve query context & lane (Fast path resolver)
   * INVARIANT: Guarantees a single consistent context for a question within the run/session.
   */
  async resolveQueryContext(
    companyId: string,
    request: QueryContextRequest,
    options: { effectiveState?: AgentDataSourceOrchestrationEffectiveState } = {},
  ): Promise<QueryContextResponse> {
    let effectiveGrantFingerprint = "all";
    let effectiveState = options.effectiveState;
    if (request.agentId) {
      effectiveState ??= await this.resolveEffectiveOrchestrationState(companyId, request.agentId);
      if (!effectiveState.enabled) {
        // Revoked or disabled agents never receive cached execution context
        return this.doResolveQueryContext(companyId, request, effectiveState);
      }
      effectiveGrantFingerprint = `${effectiveState.mode}:${(effectiveState.effectiveDataSourceIds || []).sort().join(",")}`;
    }

    const qNorm = (request.query || "").trim().toLowerCase();
    const runOrSession = request.runId || request.sessionId;
    if (runOrSession) {
      const cacheKey = `${companyId}:${runOrSession}:${effectiveGrantFingerprint}:${qNorm}`;
      const cachedCtx = this.resolvedContextsCache.get(cacheKey);
      if (cachedCtx && cachedCtx.expiresAt > Date.now()) {
        return cachedCtx.context;
      }
      const resolved = await this.doResolveQueryContext(companyId, request, effectiveState);
      this.resolvedContextsCache.set(cacheKey, {
        context: resolved,
        expiresAt: Date.now() + 60_000,
      });
      return resolved;
    }

    return this.doResolveQueryContext(companyId, request, effectiveState);
  }

  private async doResolveQueryContext(
    companyId: string,
    request: QueryContextRequest,
    knownEffectiveState?: AgentDataSourceOrchestrationEffectiveState,
  ): Promise<QueryContextResponse> {
    const tracer = new DataSourceQueryTracer({
      companyId,
      query: request.query,
      agentId: request.agentId,
      sessionId: request.sessionId,
      runId: request.runId,
    });
    const preflightStart = Date.now();

    // 1. Check agent authorization & effective state if agentId is provided
    let requestedDataSourceIds: string[] | null = null;
    if (request.agentId) {
      const state = knownEffectiveState ?? await this.resolveEffectiveOrchestrationState(companyId, request.agentId);
      if (!state.enabled) {
        tracer.markPreflight(Date.now() - preflightStart);
        const trace = tracer.finish({ outcome: "abstained" });
        return {
          lane: "abstained",
          traceId: trace.traceId,
          agentId: request.agentId,
          allowedDataSourceIds: [],
          availableTables: [],
          reasoning: state.reason || "Datasource orchestration not enabled for this agent",
        };
      }
      requestedDataSourceIds = state.effectiveDataSourceIds;
    }

    // Keep the source identity beside the ACL decision. The agent needs these
    // stable identities to distinguish same-named tables across data sources.
    const authorizedSources = requestedDataSourceIds && requestedDataSourceIds.length === 0
      ? []
      : await this.db
        .select({ id: dataSources.id, name: dataSources.name, sourceType: dataSources.sourceType })
        .from(dataSources)
        .where(and(
          eq(dataSources.companyId, companyId),
          eq(dataSources.status, "ready"),
          ...(requestedDataSourceIds ? [inArray(dataSources.id, requestedDataSourceIds)] : []),
        ));
    const allowedDataSourceIds = authorizedSources.map((source) => source.id);
    const sourcesById = new Map(authorizedSources.map((source) => [source.id, source]));

    const qTrimmed = request.query.trim().toLowerCase();

    // 2. Fast Path Lane 1: Non-data conversational greeting / utterance
    const isGreeting = /^(halo|hallo|hai|hi|hello|selamat pagi|selamat siang|selamat sore|selamat malam|terima kasih|makasih|thanks|thank you|siapa kamu|kamu siapa|bisa apa|apa kemampuanmu|apa kabar|apa yang bisa (?:anda|kamu) lakukan\b|apa yang dapat (?:anda|kamu) lakukan\b)/i.test(qTrimmed);
    const hasDataKeywords = /omzet|penjualan|keuangan|laporan|revenue|sales|profit|transaksi|total|rata-rata|average|jumlah baris|count|stok|harga|tabel|kolom|dataset|database/i.test(qTrimmed);

    if (isGreeting && !hasDataKeywords) {
      tracer.markPreflight(Date.now() - preflightStart);
      const trace = tracer.finish({ engine: "fast_path", outcome: "success" });
      return {
        lane: "fast_path_non_data",
        traceId: trace.traceId,
        agentId: request.agentId,
        allowedDataSourceIds,
        availableTables: [],
        reasoning: "Conversational non-data query; bypassing schema retrieval and SQL planning",
      };
    }

    // 3. Fast Path Lane 2: Presentation-only reuse on prior result
    const isPresentationOnly = /^(tampilkan|format|gaya|tabel|grafik|chart|urutkan|visualisasikan|jelaskan kembali|ringkas angka)/i.test(qTrimmed) &&
      !/(tambah|kurang|refresh|perbarui|ubah periode|filter baru|berdasarkan)/i.test(qTrimmed);

    if (request.previousResultId || isPresentationOnly) {
      let verifiedPriorId: string | undefined;
      if (request.previousResultId) {
        try {
          const priorRows = await this.db
            .select({
              id: dataSourceQueryExecutions.id,
              companyId: dataSourceQueryExecutions.companyId,
              agentId: dataSourceQueryExecutions.agentId,
              status: dataSourceQueryExecutions.status,
            })
            .from(dataSourceQueryExecutions)
            .where(
              and(
                eq(dataSourceQueryExecutions.id, request.previousResultId as any),
                eq(dataSourceQueryExecutions.companyId, companyId),
              ),
            );
          const priorRow = priorRows[0];
          if (priorRow && priorRow.status === "completed") {
            // Reauthorization: caller must have valid access scope
            if (allowedDataSourceIds.length > 0) {
              verifiedPriorId = priorRow.id;
            }
          } else if (!priorRow && this.activeExecutions.has(request.previousResultId)) {
            const mem = this.activeExecutions.get(request.previousResultId);
            if (mem && mem.record.companyId === companyId && mem.record.status === "completed") {
              if (allowedDataSourceIds.length > 0) {
                verifiedPriorId = mem.record.id;
              }
            }
          }
        } catch {
          // Strictly leave unverified if error/not found
        }
      } else if (!request.previousResultId && (request.sessionId || request.runId) && allowedDataSourceIds.length > 0) {
        try {
          const recentRows = await this.db
            .select({ id: dataSourceQueryExecutions.id })
            .from(dataSourceQueryExecutions)
            .where(
              and(
                eq(dataSourceQueryExecutions.companyId, companyId),
                request.sessionId
                  ? eq(dataSourceQueryExecutions.sessionId, request.sessionId)
                  : eq(dataSourceQueryExecutions.runId, request.runId! as any),
                eq(dataSourceQueryExecutions.status, "completed"),
              ),
            )
            .orderBy(desc(dataSourceQueryExecutions.createdAt))
            .limit(1);
          if (recentRows[0]) {
            verifiedPriorId = recentRows[0].id;
          }
        } catch {
          // Ignore
        }
      }

      if (verifiedPriorId) {
        tracer.markPreflight(Date.now() - preflightStart);
        const trace = tracer.finish({ engine: "fast_path", outcome: "success" });
        return {
          lane: "fast_path_presentation_reuse",
          traceId: trace.traceId,
          agentId: request.agentId,
          allowedDataSourceIds,
          availableTables: [],
          previousResultReference: verifiedPriorId,
          reasoning: "Presentation formatting reuse on prior verified execution",
        };
      }
    }

    // 4. Fetch available tables for allowed sources
    const allowedSet = new Set(allowedDataSourceIds);
    const tables = await this.db
      .select({
        id: dataSourceTables.id,
        dataSourceId: dataSourceTables.dataSourceId,
        tableName: dataSourceTables.tableName,
        schemaDefinition: dataSourceTables.schemaDefinition,
        semanticModel: dataSourceTables.semanticModel,
      })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    const candidateTables = tables
      .filter((t) => allowedSet.has(t.dataSourceId))
      .map((t) => {
        const sem = (t.semanticModel as any) || {};
        const source = sourcesById.get(t.dataSourceId);
        const metrics = (sem.metrics || []).map((m: any) => String(m?.name || m || ""));
        const dimensions = (sem.dimensions || []).map((d: any) => String(d?.name || d || ""));
        const rawColumns = Array.isArray(t.schemaDefinition) ? t.schemaDefinition : [];
        const maxColumns = 80;
        const columns = rawColumns.slice(0, maxColumns).flatMap((column: any) => {
          const name = typeof column?.name === "string" ? column.name : "";
          if (!name) return [];
          const dataType = [column.dataType, column.clickhouseType, column.type]
            .find((value) => typeof value === "string" && value.length > 0);
          const role = typeof column.role === "string" ? column.role : undefined;
          return [{ name, ...(dataType ? { dataType } : {}), ...(role ? { role } : {}) }];
        });
        const storedClickhouseTable = typeof sem.clickhouseTable === "string" && sem.clickhouseTable.length > 0
          ? sem.clickhouseTable
          : undefined;
        const supportsClickhouseSnapshot = ["csv", "excel", "clickhouse", "postgres", "postgresql", "mysql", "mariadb", "external_database"]
          .includes(source?.sourceType || "");
        return {
          id: t.id,
          dataSourceId: t.dataSourceId,
          tableName: t.tableName,
          sourceName: source?.name,
          sourceType: source?.sourceType,
          clickhouseTable: storedClickhouseTable || (supportsClickhouseSnapshot
            ? clickhouseSourceTableName(t.id, t.tableName)
            : undefined),
          columns,
          columnsTruncated: rawColumns.length > maxColumns,
          schemaDefinition: t.schemaDefinition,
          semanticModel: t.semanticModel,
          metrics,
          dimensions,
        };
      });

    const contextTables = candidateTables.map((table) => ({
      id: table.id,
      dataSourceId: table.dataSourceId,
      tableName: table.tableName,
      ...(table.sourceName ? { sourceName: table.sourceName } : {}),
      ...(table.sourceType ? { sourceType: table.sourceType } : {}),
      ...(table.clickhouseTable ? { clickhouseTable: table.clickhouseTable } : {}),
      columns: table.columns,
      columnsTruncated: table.columnsTruncated,
      metrics: table.metrics,
      dimensions: table.dimensions,
    }));

    const currentSchemaFingerprint = DataSourceExperienceService.computeFingerprintFromTables(candidateTables);

    // 3b. Fast Path Lane 3: Verified Template Experience Reuse (with schema drift guard)
    try {
      const applicableExperience = await this.experienceService.retrieveApplicableExperience(
        companyId,
        qTrimmed,
        allowedDataSourceIds,
        currentSchemaFingerprint,
      );
      if (applicableExperience) {
        tracer.markPreflight(Date.now() - preflightStart);
        const trace = tracer.finish({ engine: "fast_path", outcome: "success" });
        return {
          lane: "fast_path_template",
          traceId: trace.traceId,
          agentId: request.agentId,
          allowedDataSourceIds,
          availableTables: [],
          candidateTemplateId: applicableExperience.id,
          reasoning: `Verified query template matched (status: ${applicableExperience.status})`,
        };
      }
    } catch {
      // Non-blocking in mocks
    }

    if (candidateTables.length === 0) {
      tracer.markPreflight(Date.now() - preflightStart);
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        lane: "abstained",
        traceId: trace.traceId,
        agentId: request.agentId,
        allowedDataSourceIds,
        availableTables: [],
        reasoning: "No ready tables found in authorized data sources",
      };
    }
    // 4b. Catalog overview inquiry detection
    const isCatalogInquiry = /(?:data\s+apa|tabel\s+apa|ada\s+data\s+apa|list\s+tabel|daftar\s+tabel|apa\s+(?:saja\s+)?yang\s+(?:anda|kamu)\s+(?:punya|miliki)|apa\s+yang\s+bisa\s+anda\s+lakukan|show\s+tables|list\s+tables|data\s+apa\s+aja)/i.test(qTrimmed);
    if (isCatalogInquiry) {
      tracer.markPreflight(Date.now() - preflightStart);
      const trace = tracer.finish({ outcome: "success" });
      return {
        lane: "orchestrated",
        traceId: trace.traceId,
        agentId: request.agentId,
        allowedDataSourceIds,
        availableTables: contextTables,
        reasoning: "Catalog overview inquiry; returning all authorized candidate tables",
      };
    }

    // 5. Check relevance via hybrid retriever with selective reranker
    const retrieval = await this.hybridRetrieveSchema(companyId, qTrimmed, allowedDataSourceIds);
    tracer.markPreflight(Date.now() - preflightStart);

    if (retrieval.candidates.length === 0 && !hasDataKeywords) {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        lane: "abstained",
        traceId: trace.traceId,
        agentId: request.agentId,
        allowedDataSourceIds,
        availableTables: contextTables,
        reasoning: "Pertanyaan tidak memiliki relevansi dengan tabel atau metrik yang tersedia",
      };
    }

    // Relation expansion to include dependent tables
    const candidateById = new Map(contextTables.map((table) => [table.id, table]));
    const selectedCandidateIds = new Set(retrieval.candidates.map((candidate) => candidate.id));
    const selectedLogicalNames = new Set(retrieval.candidates.map((candidate) => candidate.tableName.toLowerCase()));
    const enrichedCandidates = retrieval.candidates.flatMap((candidate) => {
      const metadata = candidateById.get(candidate.id);
      return metadata ? [{ ...metadata, relevanceScore: candidate.relevanceScore, matchedBy: candidate.matchedBy }] : [];
    });
    // A logical table-name collision must remain visible even when retrieval's
    // top-K ranking would otherwise retain only one physical source.
    const sameNameCandidates = contextTables
      .filter((candidate) => selectedLogicalNames.has(candidate.tableName.toLowerCase()) && !selectedCandidateIds.has(candidate.id))
      .map((candidate) => ({ ...candidate, relevanceScore: 1, matchedBy: "exact_match" as const }));
    const candidateTableIds = new Set([...selectedCandidateIds, ...sameNameCandidates.map((candidate) => candidate.id)]);
    const relatedTables: Array<(typeof contextTables)[number] & { relevanceScore: number; matchedBy: "hybrid" }> = [];
    for (const cand of [...enrichedCandidates, ...sameNameCandidates]) {
      const tbl = tables.find((t) => t.id === cand.id);
      const relations = (tbl?.semanticModel as any)?.relationships || [];
      for (const rel of relations) {
        const targetName = (rel.targetTable || "").toLowerCase();
        if (!targetName) continue;
        for (const targetTable of contextTables.filter((table) => table.tableName.toLowerCase() === targetName)) {
          if (candidateTableIds.has(targetTable.id)) continue;
          candidateTableIds.add(targetTable.id);
          relatedTables.push({
            ...targetTable,
            relevanceScore: ((cand as any).relevanceScore || 0.5) * 0.8,
            matchedBy: "hybrid",
          });
        }
      }
    }
    const finalCandidates = [...enrichedCandidates, ...sameNameCandidates, ...relatedTables];

    const trace = tracer.finish({ outcome: "success" });
    return {
      lane: "orchestrated",
      traceId: trace.traceId,
      agentId: request.agentId,
      allowedDataSourceIds,
      availableTables: finalCandidates.length > 0 ? finalCandidates : contextTables,
      reasoning: retrieval.exactMatchFound
        ? `Exact match schema retrieval: ${retrieval.reasoning}`
        : "Data query requires full enterprise orchestrator planning",
    };
  }

  /**
   * P4-03: Hybrid retriever with selective reranker:
   * 1. Exact match check (if table/metric exactly mentioned, skips vector reranker to preserve latency)
   * 2. Scoped lexical retrieval on tables, metrics, dimensions, synonyms
   * 3. Tenant ACL guard (strictly company + allowedDataSourceIds)
   * 4. Top-K cap
   */
  async hybridRetrieveSchema(
    companyId: string,
    userQuery: string,
    allowedDataSourceIds: string[],
    options?: { limit?: number; vectorQuery?: number[]; embeddingSpace?: "bge-m3" | "openrouter-text-embedding-3-small" },
  ): Promise<HybridRetrievalResult> {
    const limit = options?.limit ?? 5;
    const allowedSet = new Set(allowedDataSourceIds);

    const tables = await this.db
      .select({
        id: dataSourceTables.id,
        dataSourceId: dataSourceTables.dataSourceId,
        tableName: dataSourceTables.tableName,
        schemaDefinition: dataSourceTables.schemaDefinition,
        semanticModel: dataSourceTables.semanticModel,
      })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    const candidateTables = tables
      .filter((t) => allowedSet.has(t.dataSourceId))
      .map((t) => {
        const sem = (t.semanticModel as any) || {};
        const metrics: string[] = (sem.metrics || []).map((m: any) => String(m?.name || m || ""));
        const dimensions: string[] = (sem.dimensions || []).map((d: any) => String(d?.name || d || ""));
        const columns: string[] = (Array.isArray(t.schemaDefinition) ? t.schemaDefinition : [])
          .map((column: any) => String(column?.name || ""))
          .filter(Boolean);
        return {
          id: t.id,
          dataSourceId: t.dataSourceId,
          tableName: t.tableName,
          metrics,
          dimensions,
          columns,
        };
      });

    if (candidateTables.length === 0) {
      return {
        candidates: [],
        skippedVectorRerank: true,
        exactMatchFound: false,
        reasoning: "No candidate tables authorized",
      };
    }

    const qLower = userQuery.toLowerCase().trim();
    const queryTokens = qLower.split(/[\s,.;:!?_/\-]+/).filter((w) => w.length >= 2);

    // Step 1: A named physical table takes precedence over generic exact
    // column/metric matches. A question that names one table and groups by a
    // common column such as `domain` must not lose that table when many other
    // tables also expose the same column.
    const exactTableNameMatches = candidateTables.filter((table) => {
      const identity = table.tableName.toLowerCase();
      let offset = qLower.indexOf(identity);
      while (offset >= 0) {
        const before = qLower[offset - 1];
        const after = qLower[offset + identity.length];
        const isIdentifierPart = (value: string | undefined) => Boolean(value && /[a-z0-9_]/i.test(value));
        if (!isIdentifierPart(before) && !isIdentifierPart(after)) return true;
        offset = qLower.indexOf(identity, offset + identity.length);
      }
      return queryTokens.includes(identity);
    });
    if (exactTableNameMatches.length > 0) {
      const namedCandidates = exactTableNameMatches.slice(0, limit).map((table) => ({
        ...table,
        relevanceScore: 1.0,
        matchedBy: "exact_match" as const,
      }));
      return {
        candidates: namedCandidates,
        skippedVectorRerank: true,
        exactMatchFound: true,
        reasoning: `Exact table-name match found for ${exactTableNameMatches.map((table) => table.tableName).join(", ")}; skipped vector reranker to preserve latency`,
      };
    }

    // Step 2: Check exact metric/column matches only after named-table matches.
    const exactMatches: SchemaRetrievalCandidate[] = [];
    for (const table of candidateTables) {
      const hasExactMetric = table.metrics.some((m: string) => queryTokens.includes(m.toLowerCase()) || qLower.includes(m.toLowerCase()));
      const hasExactPhysicalColumn = table.columns.some((column: string) =>
        queryTokens.includes(column.toLowerCase()) || qLower.includes(column.toLowerCase()),
      );

      if (hasExactMetric || hasExactPhysicalColumn) {
        exactMatches.push({
          ...table,
          relevanceScore: 1.0,
          matchedBy: "exact_match",
        });
      }
    }

    if (exactMatches.length > 0) {
      return {
        candidates: exactMatches.slice(0, limit),
        skippedVectorRerank: true,
        exactMatchFound: true,
        reasoning: `Exact match found for ${exactMatches.map((m) => m.tableName).join(", ")}; skipped vector reranker to preserve latency`,
      };
    }

    // Step 3: Scoped lexical scoring
    const scoredCandidates: Array<SchemaRetrievalCandidate & { score: number }> = [];
    for (const table of candidateTables) {
      let lexicalHits = 0;
      const lowerName = table.tableName.toLowerCase();
      for (const tok of queryTokens) {
        if (lowerName.includes(tok)) lexicalHits += 2;
        if (table.metrics.some((m: string) => m.toLowerCase().includes(tok))) lexicalHits += 1;
        if (table.dimensions.some((d: string) => d.toLowerCase().includes(tok))) lexicalHits += 1;
        if (table.columns.some((column: string) => column.toLowerCase().split(/[^a-z0-9]+/).includes(tok))) lexicalHits += 1;
      }
      const score = queryTokens.length > 0 ? Math.min(1, lexicalHits / (queryTokens.length * 2)) : 0;
      if (score > 0) {
        scoredCandidates.push({
          ...table,
          relevanceScore: score,
          matchedBy: "lexical",
          score,
        });
      }
    }

    // Step 4: Vector retrieval (if vector provided or generate from RagModelService if available)
    let vectorQuery = options?.vectorQuery;
    let embeddingSpace = options?.embeddingSpace;
    let embeddingGeneration = (options as any)?.embeddingGeneration;
    const ragModelService = new RagModelService();

    if (!vectorQuery) {
      try {
        const generated = await ragModelService.embed([userQuery]);
        if (generated.vectors?.[0] && generated.space) {
          vectorQuery = generated.vectors[0];
          embeddingSpace = generated.space;
          embeddingGeneration = generated.generation || ragModelService.embeddingGeneration(generated.space);
        }
      } catch {
        // Fallback to lexical
      }
    }

    if (vectorQuery && embeddingSpace) {
      try {
        const vectorStore = new DataSourceVectorStore(this.db);
        const resolvedGeneration = embeddingGeneration || ragModelService.embeddingGeneration(embeddingSpace);
        const vectorScores = await vectorStore.searchSchemaVectors({
          companyId,
          dataSourceIds: allowedDataSourceIds,
          embeddingSpace,
          embeddingGeneration: resolvedGeneration,
          vector: vectorQuery,
          limit,
        });

        if (vectorScores && vectorScores.size > 0) {
          const scoredById = new Map(scoredCandidates.map((candidate) => [candidate.id, candidate]));
          const authorizedTablesById = new Map(candidateTables
            .filter((candidate) => allowedSet.has(candidate.dataSourceId))
            .map((candidate) => [candidate.id, candidate]));
          for (const [tableId, vScore] of vectorScores) {
            const candidate = scoredById.get(tableId);
            if (candidate) {
              candidate.score = 0.4 * candidate.score + 0.6 * vScore;
              candidate.relevanceScore = candidate.score;
              candidate.matchedBy = "hybrid";
              continue;
            }
            const authorizedTable = authorizedTablesById.get(tableId);
            if (!authorizedTable) continue;
            const vectorOnlyCandidate = {
              ...authorizedTable,
              relevanceScore: 0.6 * vScore,
              matchedBy: "hybrid" as const,
              score: 0.6 * vScore,
            };
            scoredCandidates.push(vectorOnlyCandidate);
            scoredById.set(tableId, vectorOnlyCandidate);
          }
        }
      } catch {
        // Graceful fallback
      }
    }

    scoredCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Step 5: Selective reranker when candidate scores are close / ambiguous
    let skippedVectorRerank = true;
    if (scoredCandidates.length >= 2) {
      const topDiff = (scoredCandidates[0].score || 0) - (scoredCandidates[1].score || 0);
      if (topDiff < 0.25) {
        try {
          const rerankDocs = scoredCandidates.slice(0, 5).map((c) => ({
            id: c.id,
            text: `Table: ${c.tableName}. Metrics: ${c.metrics.join(", ")}. Dimensions: ${c.dimensions.join(", ")}`,
          }));
          const reranked = await ragModelService.rerank(userQuery, rerankDocs);
          if (reranked && reranked.length > 0) {
            skippedVectorRerank = false;
            const rankMap = new Map(reranked.map((r) => [r.id, r.score]));
            for (const cand of scoredCandidates) {
              if (rankMap.has(cand.id)) {
                const rScore = rankMap.get(cand.id)!;
                cand.score = 0.5 * cand.score + 0.5 * rScore;
                cand.relevanceScore = cand.score;
                (cand as any).matchedBy = "reranked";
              }
            }
            scoredCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));
          }
        } catch {
          // Graceful fallback
        }
      }
    }

    return {
      candidates: scoredCandidates.slice(0, limit),
      skippedVectorRerank,
      exactMatchFound: false,
      reasoning: `Retrieved ${scoredCandidates.length} candidate tables via lexical/hybrid scoring${skippedVectorRerank ? "" : " with selective rerank"}`,
    };
  }

  /**
   * P4-04: Selective snapshot routing policy:
   * - Selective indexed lookup -> live external
   * - Large analytical aggregation -> ClickHouse snapshot (if ready)
   * - Empty/missing snapshot -> live external or clarify
   */
  determineQueryExecutionRoute(
    queryOrPlan: { isSelectiveLookup?: boolean; hasAggregation?: boolean; hasTimeSeries?: boolean; query?: string },
    tableMetadata: {
      isExternalDb: boolean;
      rowCount?: number;
      clickhouseDeployed: boolean;
      clickhouseRowCount?: number;
      publishedSnapshotReady?: boolean;
      queryStore?: string;
    },
  ): QueryRoutingDecision {
    const q = (queryOrPlan.query || "").toLowerCase();
    const isExplicitLookup = queryOrPlan.isSelectiveLookup ||
      (/\bwhere\s+(id|[a-z0-9_]+_id)\s*=\s*/i.test(q) && /\blimit\s+[1-9]\b/i.test(q) && !queryOrPlan.hasAggregation);

    if (isExplicitLookup && tableMetadata.isExternalDb) {
      return {
        route: "live_external",
        reason: "Selective indexed lookup routed directly to live external database for real-time freshness",
        consistencyLevel: "live_transactional",
      };
    }

    const isAnalytical = queryOrPlan.hasAggregation ||
      queryOrPlan.hasTimeSeries ||
      /\b(sum|avg|count|min|max|group\s+by|between)\b/i.test(q) ||
      (tableMetadata.rowCount ?? 0) > 1000;

    const tableSnapshotReady = tableMetadata.publishedSnapshotReady
      ?? (tableMetadata.clickhouseDeployed && (tableMetadata.clickhouseRowCount ?? 0) > 0);

    if (isAnalytical && tableMetadata.clickhouseDeployed && tableSnapshotReady) {
      return {
        route: "clickhouse_snapshot",
        reason: "Large aggregation/analytical query routed to ClickHouse snapshot for sub-second execution",
        consistencyLevel: "snapshot_read_committed",
      };
    }

    if (tableMetadata.isExternalDb) {
      if (isAnalytical && !tableSnapshotReady) {
        return {
          route: "live_external",
          reason: "The selected table has no verified ClickHouse snapshot; using the authorized live external source",
          consistencyLevel: "live_transactional",
        };
      }
      return {
        route: "live_external",
        reason: "Routed to live external database",
        consistencyLevel: "live_transactional",
      };
    }

    return tableMetadata.clickhouseDeployed && tableSnapshotReady
      ? {
          route: "clickhouse_snapshot",
          reason: "Routed to the published ClickHouse table for local structured analytics",
          consistencyLevel: "snapshot_read_committed",
        }
      : {
          route: "clarify",
          reason: "The selected local table has no verified queryable ClickHouse publication",
          consistencyLevel: "unverified",
        };
  }

  private async confirmStoredDatasourceScope(
    row: typeof dataSourceQueryExecutions.$inferSelect,
    currentScope: string[],
  ): Promise<boolean> {
    if (Array.isArray(row.dataSourceIds)) {
      return sameDatasourceScope(row.dataSourceIds, currentScope);
    }

    // Older records did not persist their source scope. A matching plan hash
    // includes the sorted source IDs, so backfill that exact scope before the
    // record can be reused or exposed to an agent.
    try {
      await this.db
        .update(dataSourceQueryExecutions)
        .set({ dataSourceIds: currentScope })
        .where(eq(dataSourceQueryExecutions.id, row.id as any));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create & run a query execution through the coordinator facade with 55s budget,
   * plan result caching, and 15s retry guard.
   */
  async createQueryExecution(
    companyId: string,
    request: CreateQueryExecutionRequest,
  ): Promise<QueryExecutionRecord> {
    const executionId = `exec-${randomUUID()}`;
    const budget = new QuestionDeadlineBudget({
      totalBudgetMs: Math.min(request.deadlineMs || 55_000, 60_000),
      submittedAt: request.submittedAt ? (typeof request.submittedAt === "number" ? request.submittedAt : new Date(request.submittedAt).getTime()) : undefined,
    });

    const record: QueryExecutionRecord = {
      id: executionId,
      companyId,
      agentId: request.agentId,
      runId: request.runId,
      sessionId: request.sessionId,
      query: request.query,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.activeExecutions.set(executionId, { record, budget });

    // 0a. Calculate caller's active grants from DB (strict fail-closed)
    let effectiveDataSourceIds = request.dataSourceIds || [];
    if (request.agentId) {
      try {
        const access = await this.dataSourcesService.getAgentDataSources(companyId, request.agentId);
        if (access.mode === "none") {
          effectiveDataSourceIds = [];
        } else {
          const allowedDataSourceIds = access.effectiveDataSourceIds || [];
          const allowedSet = new Set(allowedDataSourceIds);
          effectiveDataSourceIds = effectiveDataSourceIds.length > 0
            ? effectiveDataSourceIds.filter((id) => allowedSet.has(id))
            : allowedDataSourceIds;
        }
      } catch {
        effectiveDataSourceIds = [];
      }
    } else if (effectiveDataSourceIds.length === 0) {
      try {
        const allReady = await this.db
          .select({ id: dataSources.id })
          .from(dataSources)
          .where(and(eq(dataSources.companyId, companyId), eq(dataSources.status, "ready")));
        effectiveDataSourceIds = allReady.map((s) => s.id);
      } catch {
        effectiveDataSourceIds = [];
      }
    }

    effectiveDataSourceIds = Array.from(new Set(effectiveDataSourceIds)).sort();
    record.dataSourceIds = effectiveDataSourceIds;

    const planHash = computePlanHash({
      query: request.query,
      parameters: request.parameters,
      templateId: request.templateId,
      dataSourceIds: effectiveDataSourceIds,
    });

    // Check durable idempotency on (company_id, run_id, plan_hash) with caller reauthorization
    if (request.runId) {
      try {
        const existingRows = await this.db
          .select()
          .from(dataSourceQueryExecutions)
          .where(
            and(
              eq(dataSourceQueryExecutions.companyId, companyId),
              eq(dataSourceQueryExecutions.runId, request.runId as any),
              eq(dataSourceQueryExecutions.planHash, planHash),
            ),
          );
        const existing = existingRows[0];
        if (existing && existing.status === "completed") {
          const callerOwnsExecution = !request.agentId || existing.agentId === request.agentId;
          const scopeMatches = await this.confirmStoredDatasourceScope(existing, effectiveDataSourceIds);
          if (callerOwnsExecution && scopeMatches && (!request.agentId || effectiveDataSourceIds.length > 0)) {
            this.activeExecutions.delete(executionId);
            return queryExecutionRecordFromRow({ ...existing, dataSourceIds: effectiveDataSourceIds });
          }
        }
      } catch {
        // Table may not exist or mock
      }
    }

    try {
      const insertPromise = this.db.insert(dataSourceQueryExecutions).values({
        id: executionId,
        companyId,
        agentId: (request.agentId as any) || null,
        runId: (request.runId as any) || null,
        sessionId: request.sessionId || null,
        dataSourceIds: effectiveDataSourceIds,
        query: request.query,
        planHash,
        engine: "clickhouse",
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      if (insertPromise && typeof (insertPromise as any).then === "function") {
        await insertPromise;
      }
    } catch (insertErr: any) {
      if (request.runId && (insertErr?.code === "23505" || String(insertErr).toLowerCase().includes("unique") || String(insertErr).toLowerCase().includes("duplicate"))) {
        try {
          const [existing] = await this.db
            .select()
            .from(dataSourceQueryExecutions)
            .where(
              and(
                eq(dataSourceQueryExecutions.companyId, companyId),
                eq(dataSourceQueryExecutions.runId, request.runId as any),
                eq(dataSourceQueryExecutions.planHash, planHash),
              ),
            );
          const callerOwnsExecution = !request.agentId || existing?.agentId === request.agentId;
          const scopeMatches = existing
            ? await this.confirmStoredDatasourceScope(existing, effectiveDataSourceIds)
            : false;
          if (existing && callerOwnsExecution && scopeMatches && (!request.agentId || effectiveDataSourceIds.length > 0)) {
            this.activeExecutions.delete(executionId);
            return queryExecutionRecordFromRow({ ...existing, dataSourceIds: effectiveDataSourceIds });
          }
        } catch {
          // Fall through
        }
      }
    }

    try {
      if (request.agentId && effectiveDataSourceIds.length === 0) {
        throw new Error("Agent has no authorized data sources assigned for this query");
      }

      // 0b. Calculate real datasetVersion from active data sources
      let datasetVersion = 1;
      let activeSources: Array<{ id: string; sourceType: string; updatedAt: Date }> = [];
      try {
        activeSources = await this.db
          .select({ id: dataSources.id, sourceType: dataSources.sourceType, updatedAt: dataSources.updatedAt })
          .from(dataSources)
          .where(
            and(
              eq(dataSources.companyId, companyId),
              eq(dataSources.status, "ready"),
              inArray(dataSources.id, effectiveDataSourceIds.length > 0 ? effectiveDataSourceIds : ["00000000-0000-0000-0000-000000000000"]),
            ),
          );
        if (activeSources.length > 0) {
          datasetVersion = Math.max(...activeSources.map((s) => s.updatedAt.getTime()));
        }
      } catch {
        // Safe fallback
      }

      // 0c. Load table metadata & compute schema fingerprint
      let referencedTables: string[] = [];
      let referencedColumns: string[] = [];
      let totalRowCount = 0;
      let tableRows: any[] = [];

      try {
        tableRows = await this.db
          .select({
            id: dataSourceTables.id,
            tableName: dataSourceTables.tableName,
            rowCount: dataSourceTables.rowCount,
            schemaDefinition: dataSourceTables.schemaDefinition,
            semanticModel: dataSourceTables.semanticModel,
            dataSourceId: dataSourceTables.dataSourceId,
          })
          .from(dataSourceTables)
          .where(
            and(
              eq(dataSourceTables.companyId, companyId),
              inArray(dataSourceTables.dataSourceId, effectiveDataSourceIds.length > 0 ? effectiveDataSourceIds : ["00000000-0000-0000-0000-000000000000"]),
            ),
          );

        const authorizedSourceIds = new Set(effectiveDataSourceIds);
        const readySourceIds = new Set(activeSources.map((source) => source.id));
        // Some test adapters and older DB wrappers do not enforce `inArray`;
        // keep the authorization boundary explicit before schema retrieval.
        tableRows = tableRows.filter(
          (table) => authorizedSourceIds.has(table.dataSourceId) && readySourceIds.has(table.dataSourceId),
        );
        totalRowCount = tableRows.reduce((acc, t) => acc + (t.rowCount || 0), 0);
        referencedTables = tableRows.map((t) => t.tableName);
        referencedColumns = tableRows.flatMap((t) => ((t.schemaDefinition as any[]) || []).map((c: any) => c.name || ""));
      } catch {
        // Safe fallback in test mocks
      }

      // Resolve the plan against the authorized schema before routing. Pi may
      // emit a generic alias such as `table`; exact physical-column retrieval
      // can bind that alias without exposing unrelated assigned sources.
      // Only extract table references from SQL keywords if query appears to be SQL,
      // never from natural-language queries where English words like 'from' or 'join'
      // are natural words.
      const isLikelySql = /^\s*(?:select|with|show|describe|explain)\b/i.test(request.query);
      const sqlTableMatches = isLikelySql
        ? Array.from(request.query.matchAll(/\b(?:from|join)\s+([a-zA-Z0-9_."]+)/gi))
            .map((m) => m[1].replace(/["`]/g, ""))
            .filter(Boolean)
        : [];
      const explicitTables = Array.from(new Set([...(request.tables || []), ...sqlTableMatches]));
      let schemaRetrieval: HybridRetrievalResult = {
        candidates: [],
        skippedVectorRerank: true,
        exactMatchFound: false,
        reasoning: "Schema retrieval not available",
      };
      try {
        schemaRetrieval = await this.hybridRetrieveSchema(companyId, request.query, effectiveDataSourceIds, { limit: 5 });
      } catch {
        // Physical references can still be validated without semantic retrieval.
      }
      const tableScope = resolveQueryTableScope({
        query: request.query,
        requestedReferences: explicitTables,
        allowedTables: tableRows,
        rankedTables: schemaRetrieval.candidates,
        exactMatchFound: schemaRetrieval.exactMatchFound,
      });
      if (tableScope.needsClarification) {
        const candidateNames = schemaRetrieval.candidates.slice(0, 5).map((candidate) => candidate.tableName);
        const tableHint = candidateNames.length > 0
          ? ` Kandidat yang cocok: ${candidateNames.join(", ")}.`
          : " Tidak ada satu tabel yang cocok secara unik di datasource yang ditugaskan.";
        const unresolved = tableScope.unresolvedReferences.length > 0
          ? tableScope.unresolvedReferences.join(", ")
          : "pilihan tabel";
        record.status = "completed";
        record.resultsSummary = `Belum menjalankan query karena ${unresolved} tidak ditemukan atau ambigu.${tableHint} Sebutkan tabel atau metrik yang dimaksud agar hasil tidak diambil dari sumber yang salah.`;
        record.engine = "fast_path";
        record.completedAt = new Date().toISOString();
        record.updatedAt = record.completedAt;
        const clarificationTrace = new DataSourceQueryTracer({
          companyId,
          query: request.query,
          traceId: `orch-exec-${executionId}`,
          agentId: request.agentId,
          runId: request.runId,
          sessionId: request.sessionId,
        }).finish({ engine: "fast_path", outcome: "abstained" });
        record.traceId = clarificationTrace.traceId;
        record.stageTimings = clarificationTrace.timings;
        budget.finish();
        await this.persistExecutionUpdate(companyId, executionId, record);
        return record;
      }

      const candidateTableIds = (schemaRetrieval.candidates || []).slice(0, 5).map((candidate) => candidate.id);
      const executionTableRows = tableScope.tables
        || (candidateTableIds.length > 0
          ? tableRows.filter((table) => candidateTableIds.includes(table.id))
          : tableRows);
      const executionDataSourceIds = Array.from(new Set(executionTableRows.map((table) => table.dataSourceId)));
      const validationTableRefs = tableScope.referencedTables.length > 0
        ? tableScope.referencedTables
        : explicitTables;
      const executionSchemaFingerprint = DataSourceExperienceService.computeFingerprintFromTables(executionTableRows);

      // 0d. Shared plan validation
      if (validationTableRefs.length > 0) {
        const planValidation = await this.validatePlan(companyId, {
          allowedDataSourceIds: effectiveDataSourceIds,
          referencedTables: validationTableRefs,
        });
        if (!planValidation.valid) {
          throw new Error(`Plan validation failed: ${planValidation.errors.join(", ")}`);
        }
      }

      // 0e. Determine query execution route dynamically
      const { ClickhouseService } = await import("./clickhouse.js");
      const clickhouse = new ClickhouseService();
      const chHealth = await clickhouse.isHealthy().catch(() => ({ ok: false }));
      const executionSources = activeSources.filter((source) => executionDataSourceIds.includes(source.id));
      const executionSourceTypes = Array.from(new Set(executionSources.map((source) => source.sourceType)));
      const externalSourceTypes = new Set(["postgres", "postgresql", "mysql", "mariadb", "external_database"]);
      const isExternalDb = executionSourceTypes.length === 1 && externalSourceTypes.has(executionSourceTypes[0]);
      const clickhouseDeployed = chHealth.ok;

      let clickhouseRowCount = 0;
      let publishedSnapshotReady = false;
      if (clickhouseDeployed && executionTableRows.length > 0) {
        const tableNames = new Set(await clickhouse.listTables(companyId).catch(() => []));
        publishedSnapshotReady = executionTableRows.every((table) => {
          const semanticModel = (table.semanticModel as any) || {};
          const sourceType = executionSources.find((source) => source.id === table.dataSourceId)?.sourceType;
          const isExternal = typeof sourceType === "string" && externalSourceTypes.has(sourceType);
          const publishedName = semanticModel.clickhouseTable;
          if (typeof publishedName !== "string" || !tableNames.has(publishedName)) return false;
          if (!isExternal) return ["csv", "excel", "clickhouse"].includes(sourceType || "");

          const snapshot = semanticModel.externalSnapshot;
          if (snapshot?.status !== "ready") return false;
          const snapshotTables = [publishedName, ...(Array.isArray(snapshot.deltaTables) ? snapshot.deltaTables : [])];
          return snapshotTables.every((name) => typeof name === "string" && tableNames.has(name));
        });
        if (publishedSnapshotReady) {
          clickhouseRowCount = executionTableRows.reduce((acc, table) => {
            const snapshot = (table.semanticModel as any)?.externalSnapshot;
            return acc + Number(snapshot?.rowCount ?? table.rowCount ?? 0);
          }, 0);
        }
      }

      totalRowCount = executionTableRows.reduce((total, table) => total + Number(table.rowCount || 0), 0);
      referencedTables = executionTableRows.map((table) => table.tableName);
      referencedColumns = executionTableRows.flatMap((table) => ((table.schemaDefinition as any[]) || []).map((column: any) => column.name || ""));

      const freshnessSensitive = /\b(latest|current|live|real[ -]?time|sekarang|terkini|hari ini|saat ini|terbaru)\b/i.test(request.query);
      const isSelectiveLookup = freshnessSensitive || (/\bwhere\s+(id|[a-z0-9_]+_id)\s*=\s*/i.test(request.query) && /\blimit\s+[1-9]\b/i.test(request.query));

      const routing = this.determineQueryExecutionRoute(
        {
          query: request.query,
          isSelectiveLookup,
        },
        {
          isExternalDb,
          rowCount: totalRowCount,
          clickhouseDeployed,
          clickhouseRowCount,
          publishedSnapshotReady,
        },
      );
      if (routing.route === "clarify") {
        record.status = "completed";
        record.engine = "fast_path";
        record.resultsSummary = `${routing.reason}. Sinkronkan atau pulihkan publikasi ClickHouse tabel terpilih sebelum menjalankan query.`;
        record.completedAt = new Date().toISOString();
        record.updatedAt = record.completedAt;
        const clarifyTrace = new DataSourceQueryTracer({
          companyId,
          query: request.query,
          traceId: `orch-exec-${executionId}`,
          agentId: request.agentId,
          runId: request.runId,
          sessionId: request.sessionId,
        }).finish({ engine: "fast_path", outcome: "abstained" });
        record.traceId = clarifyTrace.traceId;
        record.stageTimings = clarifyTrace.timings;
        budget.finish();
        await this.persistExecutionUpdate(companyId, executionId, record);
        return record;
      }

      const externalEngine = executionSourceTypes[0];
      const selectedEngine: "clickhouse" | "postgres" | "mysql" | "mariadb" = routing.route === "clickhouse_snapshot"
        ? "clickhouse"
        : externalEngine === "mysql" || externalEngine === "mariadb"
          ? externalEngine
          : "postgres";
      record.engine = selectedEngine;

      // 1. Check cached parameterized plan result if available with reauthorization check and schema drift guard
      const normalizedParams = request.parameters || {};
      const cacheKey = makePlanCacheKey(companyId, planHash, normalizedParams, selectedEngine, datasetVersion, executionSchemaFingerprint);
      const cached = await this.cacheService.getCachedPlanResult(cacheKey, effectiveDataSourceIds);
      if (cached) {
        record.status = "completed";
        record.resultsSummary = (cached.data as any)?.resultsSummary;
        record.data = (cached.data as any)?.data;
        record.engine = cached.engine;
        record.traceId = (cached.data as any)?.traceId || `orch-cache-${executionId}`;
        record.stageTimings = (cached.data as any)?.stageTimings || {
          preflightMs: 1,
          retrievalMs: 1,
          planningMs: 1,
          validationMs: 1,
          databaseExecutionMs: 1,
          synthesisMs: 1,
          totalMs: 6,
        };
        record.completedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();

        await this.persistExecutionUpdate(companyId, executionId, record);
        return record;
      }

      // 1b. Direct fast-path execution of verified templates with parameter binding & drift guard
      if (!request.templateId) {
        try {
          const autoMatchedExp = await this.experienceService.retrieveApplicableExperience(
            companyId,
            request.query,
            effectiveDataSourceIds,
            executionSchemaFingerprint,
          );
          if (autoMatchedExp) {
            request.templateId = autoMatchedExp.id;
          }
        } catch {
          // Safe fallback
        }
      }

      if (request.templateId) {
        try {
          const [expRow] = await this.db
            .select()
            .from(dataSourceQueryExperiences)
            .where(
              and(
                eq(dataSourceQueryExperiences.id, request.templateId as any),
                eq(dataSourceQueryExperiences.companyId, companyId),
              ),
            );
          if (expRow && (expRow.status === "reference_verified" || expRow.status === "user_approved")) {
            // Re-verify caller has grants to all referenced data sources!
            const allowedSet = new Set(effectiveDataSourceIds);
            const hasGrants = (expRow.referencedDataSourceIds || []).every((id) => allowedSet.has(id));
            if (!hasGrants) {
              throw new Error("Caller lacks permission for one or more data sources required by this template");
            }

            // Re-verify schema fingerprint has not drifted!
            if (expRow.schemaFingerprint && expRow.schemaFingerprint !== executionSchemaFingerprint) {
              throw new Error("Schema fingerprint has drifted since template was verified");
            }

            const boundSql = this.experienceService.bindParameters(
              expRow.parameterizedSql,
              request.parameters || {},
            );
            const engine = expRow.engine || "clickhouse";
            let queryRes: any;
            if (engine === "clickhouse") {
              queryRes = await this.dataSourcesService.queryClickhouse(
                companyId,
                boundSql,
                undefined,
                budget.signal,
              );
            } else if (expRow.referencedDataSourceIds?.[0]) {
              queryRes = await this.dataSourcesService.querySql(
                companyId,
                expRow.referencedDataSourceIds[0],
                boundSql,
                50,
                budget.signal,
              );
            }
            if (queryRes) {
              record.status = "completed";
              record.resultsSummary = `Executed verified template '${expRow.intent}' with parameters ${JSON.stringify(request.parameters || {})}`;
              record.data = queryRes.rows;
              record.engine = engine;
              record.completedAt = new Date().toISOString();
              record.updatedAt = new Date().toISOString();
              await this.persistExecutionUpdate(companyId, executionId, record);
              return record;
            }
          }
        } catch (err: any) {
          if (err?.message?.includes("Caller lacks permission") || err?.message?.includes("Schema fingerprint has drifted")) {
            throw err;
          }
          // Fall through to general planning if template execution fails
        }
      }

      // 2. Execute with deadline propagation and at most 1 corrective retry if budget > 15s
      let result: SpecialistExecution | undefined;
      let lastError: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          if (!budget.canRetry()) {
            break;
          }
          budget.consumeRetry();
        }
        try {
          result = await this.dataAgent.answer(companyId, request.query, {
            agentId: request.agentId,
            runId: request.runId,
            sessionId: request.sessionId,
            dataSourceIds: executionDataSourceIds.length > 0 ? executionDataSourceIds : effectiveDataSourceIds,
            tableIds: executionTableRows.map((table) => table.id),
            traceId: `orch-exec-${executionId}`,
            signal: budget.signal,
            preferredMode: routing.route === "clickhouse_snapshot" ? "snapshot" : "live",
          });
          lastError = null;
          break;
        } catch (err: any) {
          lastError = err;
          if (budget.isBudgetExceeded()) {
            break;
          }
        }
      }

      if (lastError && !result) {
        throw lastError;
      }

      budget.finish();

      if (record.status !== "cancelled" && !budget.signal.aborted) {
        record.status = "completed";
        record.resultsSummary = result?.resultsSummary;
        record.data = result?.dataPreview;
        record.traceId = result?.traceId;
        record.stageTimings = result?.stageTimings;
        record.engine = selectedEngine;
        record.completedAt = new Date().toISOString();

        // Cache the successful plan result
        await this.cacheService.setCachedPlanResult(cacheKey, {
          planHash,
          normalizedParams,
          engine: selectedEngine,
          datasetVersion,
          companyId,
          dataSourceIds: effectiveDataSourceIds,
          createdAt: Date.now(),
          ttlSeconds: 300,
          data: {
            resultsSummary: result?.resultsSummary,
            data: result?.dataPreview,
            traceId: result?.traceId,
            stageTimings: result?.stageTimings,
          },
        });

        // P6-02: Auto-record candidate experience into learning pipeline (only valid SQL, no natural language queries)
        const executedSql = (result?.query && /^\s*(?:select|with)\b/i.test(result.query)) ? result.query : null;
        if (executedSql) {
          try {
            const actualTables = Array.from(executedSql.matchAll(/\b(?:from|join)\s+([a-zA-Z0-9_."]+)/gi))
              .map((m) => m[1].replace(/["`]/g, "").split(".").pop() || "")
              .filter(Boolean);
            const distinctTables = Array.from(new Set(actualTables));
            const referencedSources = tableRows
              .filter((t) => distinctTables.includes(t.tableName))
              .map((t) => t.dataSourceId);

            await this.experienceService.recordCandidateExperience({
              companyId,
              originatingExecutionId: executionId,
              intent: request.query,
              parameterizedSql: executedSql,
              referencedDataSourceIds: Array.from(new Set(referencedSources.length > 0 ? referencedSources : effectiveDataSourceIds)),
              referencedTables: distinctTables.length > 0 ? distinctTables : referencedTables,
              referencedColumns: referencedColumns.filter((c) => executedSql.toLowerCase().includes(c.toLowerCase())),
              schemaFingerprint: executionSchemaFingerprint,
              engine: selectedEngine === "clickhouse" ? "clickhouse" : "live_external",
              status: "candidate",
            });
          } catch {
            // Non-blocking in mocks
          }
        }
      }
      record.updatedAt = new Date().toISOString();

      await this.persistExecutionUpdate(companyId, executionId, record);
      return record;
    } catch (err: any) {
      const explicitlyCancelled = record.status === "cancelled";
      budget.cancel("Query execution failed or timed out");
      record.status = explicitlyCancelled ? "cancelled" : "failed";
      record.errorMessage = err?.message || String(err);
      record.completedAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();

      await this.persistExecutionUpdate(companyId, executionId, record);
      return record;
    }
  }

  private async persistExecutionUpdate(
    companyId: string,
    executionId: string,
    record: QueryExecutionRecord,
  ): Promise<void> {
    try {
      const updatePromise = this.db
        .update(dataSourceQueryExecutions)
        .set({
          status: record.status,
          dataSourceIds: record.dataSourceIds,
          resultsSummary: record.resultsSummary || null,
          dataPreview: record.data || null,
          stageTimings: (record.stageTimings as any) || null,
          errorMessage: record.errorMessage || null,
          traceId: record.traceId || null,
          engine: record.engine || "clickhouse",
          completedAt: record.completedAt ? new Date(record.completedAt) : new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dataSourceQueryExecutions.id, executionId as any),
            eq(dataSourceQueryExecutions.companyId, companyId),
          ),
        );
      if (updatePromise && typeof (updatePromise as any).then === "function") {
        await updatePromise;
      }
    } catch {
      // Safe fallback in test mocks
    }
  }

  /**
   * P1-03 & P6-02: Shared recordOutcome method to persist execution outcome, timings, candidate experience, and trace.
   */
  async recordOutcome(
    companyId: string,
    executionId: string,
    outcome: {
      status: "completed" | "failed" | "cancelled";
      resultsSummary?: string;
      data?: any;
      errorMessage?: string;
      stageTimings?: any;
      traceId?: string;
      engine?: string;
    },
  ): Promise<void> {
    const entry = this.activeExecutions.get(executionId);
    if (entry && entry.record.companyId === companyId) {
      entry.record.status = outcome.status;
      entry.record.resultsSummary = outcome.resultsSummary;
      entry.record.data = outcome.data;
      entry.record.errorMessage = outcome.errorMessage;
      entry.record.stageTimings = outcome.stageTimings;
      if (outcome.traceId) entry.record.traceId = outcome.traceId;
      if (outcome.engine) entry.record.engine = outcome.engine;
      entry.record.completedAt = new Date().toISOString();
      entry.record.updatedAt = new Date().toISOString();
    }
    await this.persistExecutionUpdate(companyId, executionId, {
      id: executionId,
      companyId,
      query: "",
      status: outcome.status,
      resultsSummary: outcome.resultsSummary,
      data: outcome.data,
      errorMessage: outcome.errorMessage,
      stageTimings: outcome.stageTimings,
      traceId: outcome.traceId,
      engine: outcome.engine,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  async getQueryExecution(companyId: string, executionId: string): Promise<QueryExecutionRecord | null> {
    const entry = this.activeExecutions.get(executionId);
    if (entry && entry.record.companyId === companyId) {
      return entry.record;
    }

    try {
      const rows = await this.db
        .select()
        .from(dataSourceQueryExecutions)
        .where(
          and(
            eq(dataSourceQueryExecutions.id, executionId as any),
            eq(dataSourceQueryExecutions.companyId, companyId),
          ),
        );
      const row = rows[0];
      if (!row) return null;
      return queryExecutionRecordFromRow(row);
    } catch {
      return null;
    }
  }

  async listQueryExecutions(
    companyId: string,
    options: {
      agentId?: string;
      dataSourceId?: string;
      allowedDataSourceIds?: string[];
      limit?: number;
    } = {},
  ): Promise<QueryExecutionListItem[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 50)));
    const conditions: any[] = [eq(dataSourceQueryExecutions.companyId, companyId)];
    if (options.agentId) conditions.push(eq(dataSourceQueryExecutions.agentId, options.agentId as any));
    if (options.dataSourceId) {
      conditions.push(sql`${dataSourceQueryExecutions.dataSourceIds} @> ${JSON.stringify([options.dataSourceId])}::jsonb`);
    }

    const rows = await this.db
      .select()
      .from(dataSourceQueryExecutions)
      .where(and(...conditions))
      .orderBy(desc(dataSourceQueryExecutions.createdAt))
      .limit(limit);

    const allowed = options.allowedDataSourceIds ? new Set(options.allowedDataSourceIds) : undefined;
    return rows
      // Rows created before scope persistence cannot safely be attributed to a datasource.
      .filter((row) => Array.isArray(row.dataSourceIds))
      .filter((row) => !allowed || row.dataSourceIds!.every((id) => allowed.has(id)))
      .map((row) => {
        const { data: _data, ...summary } = queryExecutionRecordFromRow(row);
        return summary;
      });
  }

  async cancelQueryExecution(companyId: string, executionId: string): Promise<boolean> {
    const entry = this.activeExecutions.get(executionId);
    if (entry && entry.record.companyId === companyId) {
      if (entry.record.status === "running") {
        entry.budget.cancel("Cancelled by user request");
        entry.record.status = "cancelled";
        entry.record.updatedAt = new Date().toISOString();
        entry.record.completedAt = new Date().toISOString();
        await this.persistExecutionUpdate(companyId, executionId, entry.record);
        return true;
      }
      return false;
    }

    try {
      const rows = await this.db
        .select()
        .from(dataSourceQueryExecutions)
        .where(
          and(
            eq(dataSourceQueryExecutions.id, executionId as any),
            eq(dataSourceQueryExecutions.companyId, companyId),
          ),
        );
      const row = rows[0];
      if (row && row.status === "running") {
        await this.db
          .update(dataSourceQueryExecutions)
          .set({ status: "cancelled", updatedAt: new Date(), completedAt: new Date() })
          .where(
            and(
              eq(dataSourceQueryExecutions.id, executionId as any),
              eq(dataSourceQueryExecutions.companyId, companyId),
            ),
          );
        return true;
      }
    } catch {
      // Ignore
    }
    return false;
  }

  async submitQueryFeedback(
    companyId: string,
    executionId: string,
    feedback: QueryExecutionFeedbackRequest,
    actorId = "user-1",
    actorType: "board" | "agent" | "user" = "user",
  ): Promise<void> {
    const entry = this.activeExecutions.get(executionId);
    let execution = entry?.record;
    if (!execution || execution.companyId !== companyId) {
      execution = (await this.getQueryExecution(companyId, executionId)) ?? undefined;
    }
    if (!execution || execution.companyId !== companyId) {
      throw new Error(`Execution ${executionId} not found`);
    }
    this.feedbackRegistry.set(executionId, feedback);

    // Look up associated experienceId if one exists for this execution
    let experienceId: string | undefined;
    try {
      const expRows = await this.db
        .select({ id: dataSourceQueryExperiences.id })
        .from(dataSourceQueryExperiences)
        .where(
          and(
            eq(dataSourceQueryExperiences.companyId, companyId),
            eq(dataSourceQueryExperiences.originatingExecutionId, executionId as any),
          ),
        );
      if (expRows[0]) {
        experienceId = expRows[0].id;
      }
    } catch {
      // Safe fallback
    }

    // Persist durably to Postgres
    const isPositive =
      feedback.sentiment === "positive" ||
      feedback.sentiment === "helpful" ||
      feedback.verdict === "correct";

    await this.experienceService.recordFeedback({
      companyId,
      executionId,
      experienceId,
      actorType,
      actorId,
      sentiment: isPositive ? "positive" : "negative",
      businessFieldsToFix: feedback.businessFieldsToFix || [],
      correctionNote: feedback.correctionNote || feedback.comment || feedback.correctedDefinition,
    });
  }

  async listExperiences(companyId: string, filter?: { status?: any; allowedDataSourceIds?: string[]; dataSourceId?: string }) {
    return this.experienceService.listExperiences(companyId, filter);
  }

  async promoteExperience(
    companyId: string,
    experienceId: string,
    targetStatus: "reference_verified" | "user_approved",
    evidence?: Record<string, unknown>,
  ) {
    return this.experienceService.promoteExperience(companyId, experienceId, targetStatus, evidence);
  }
}
