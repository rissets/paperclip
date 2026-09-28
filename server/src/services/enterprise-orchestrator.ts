import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  orchestratorSessions,
  orchestratorMessages,
  dataSources,
  dataSourceTables,
} from "@paperclipai/db";
import type {
  OrchestrationPlan,
  OrchestratorMessage,
  OrchestratorRoute,
  OrchestratorSession,
  SpecialistExecution,
  DataSourceSemanticProfile,
} from "@paperclipai/shared";
import { DataAgentService } from "./data-agent.js";
import { KnowledgeAgentService } from "./knowledge-agent.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { EnterpriseAgentRosterService } from "./enterprise-agent-roster.js";

export class EnterpriseOrchestratorService {
  private dataAgent: DataAgentService;
  private knowledgeAgent: KnowledgeAgentService;
  private jevService: TypeSafeJevService;
  private rosterService: EnterpriseAgentRosterService;

  constructor(private db: Db) {
    this.dataAgent = new DataAgentService(db);
    this.knowledgeAgent = new KnowledgeAgentService(db);
    this.jevService = new TypeSafeJevService();
    this.rosterService = new EnterpriseAgentRosterService(db);
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
  async chat(companyId: string, sessionId: string, userQuery: string): Promise<OrchestratorMessage> {
    // 0. Ensure enterprise agent roster
    await this.rosterService.ensureEnterpriseRoster(companyId);

    // 1. Save user query message
    await this.db.insert(orchestratorMessages).values({
      sessionId,
      companyId,
      role: "user",
      content: userQuery,
    });

    // 2. Discover available data sources and their tables + semantic profiles
    const availableSources = await this.db
      .select({
        id: dataSources.id,
        name: dataSources.name,
        type: dataSources.sourceType,
        status: dataSources.status,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.status, "ready")));

    const tables = await this.db
      .select({
        dataSourceId: dataSourceTables.dataSourceId,
        tableName: dataSourceTables.tableName,
      })
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

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

    // 5. Delegate to Specialist Agents
    const specialistExecutions: SpecialistExecution[] = [];

    if (route === "data_agent" || route === "analytics_engineer_agent" || route === "prediction_agent" || route === "hybrid") {
      const dataResult = await this.dataAgent.answer(companyId, userQuery);
      specialistExecutions.push(dataResult);
    }

    if (route === "knowledge_agent" || route === "research_agent" || route === "hybrid") {
      const knowledgeResult = await this.knowledgeAgent.answer(companyId, userQuery, {
        dataSourceId: jevDecision.targetSourceId,
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
}
