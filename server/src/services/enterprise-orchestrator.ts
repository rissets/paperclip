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
} from "@paperclipai/shared";
import { DataAgentService } from "./data-agent.js";
import { KnowledgeAgentService } from "./knowledge-agent.js";
import { TypeSafeJevService } from "./typesafe-jev.js";

export class EnterpriseOrchestratorService {
  private dataAgent: DataAgentService;
  private knowledgeAgent: KnowledgeAgentService;
  private jevService: TypeSafeJevService;

  constructor(private db: Db) {
    this.dataAgent = new DataAgentService(db);
    this.knowledgeAgent = new KnowledgeAgentService(db);
    this.jevService = new TypeSafeJevService();
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
   * System One Decision Plane (TypeSafe Jev 1.13.0) -> Route -> Delegate -> Synthesize
   */
  async chat(companyId: string, sessionId: string, userQuery: string): Promise<OrchestratorMessage> {
    // 1. Save user query message
    await this.db.insert(orchestratorMessages).values({
      sessionId,
      companyId,
      role: "user",
      content: userQuery,
    });

    // 2. Discover available data sources and their tables
    const availableSources = await this.db
      .select({
        id: dataSources.id,
        name: dataSources.name,
        type: dataSources.sourceType,
        status: dataSources.status,
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
      ...s,
      tables: tables.filter((t) => t.dataSourceId === s.id).map((t) => t.tableName),
    }));

    // 3. System One Decisional Semantic Layer (TypeSafe Jev 1.13.0)
    const jevDecision = await this.jevService.routeUserQuery(userQuery, sourcesWithTables);

    let route: OrchestratorRoute = jevDecision.route;
    let confidence = jevDecision.confidence;
    let reasoning = jevDecision.reasoning;

    // 4. Delegate to Specialist Agents
    const specialistExecutions: SpecialistExecution[] = [];

    if (route === "data_agent" || route === "hybrid") {
      const dataResult = await this.dataAgent.answer(companyId, userQuery);
      specialistExecutions.push(dataResult);
    }

    if (route === "knowledge_agent" || route === "hybrid") {
      const knowledgeResult = await this.knowledgeAgent.answer(companyId, userQuery);
      specialistExecutions.push(knowledgeResult);
    }

    // 5. Synthesize Grounded Executive Response
    let synthesizedAnswer = "";

    if (route === "direct") {
      synthesizedAnswer = `Halo! Saya adalah **Homseo**, Chief of Staff & Main Enterprise Agent Orchestrator untuk rissets.\n\nSaya terhubung dengan sumber data internal perusahaan Anda yang telah siap digunakan:
- **External Databases (MariaDB/Postgres):** ${availableSources.filter((s) => s.type === "mariadb" || s.type === "postgres" || s.type === "mysql").map((s) => s.name).join(", ") || "Belum ada"}
- **Structured Datasets (CSV/Excel):** ${availableSources.filter((s) => s.type === "csv" || s.type === "excel").map((s) => s.name).join(", ") || "Belum ada"}
- **Knowledge Documents (RAG):** ${availableSources.filter((s) => s.type === "rag_document").map((s) => s.name).join(", ") || "Belum ada"}

Seluruh keputusan query diarahkan oleh **TypeSafe AI Jev System One (jev-1.13.0)** untuk menjamin akurasi dan kepatuhan data internal. Silakan tanyakan analisis data, profil perseroan, atau SOP perusahaan!`;
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
    } else if (route === "data_agent") {
      const dataExec = specialistExecutions[0];
      synthesizedAnswer = dataExec?.resultsSummary || "Tidak ada hasil yang dihasilkan oleh Data Agent.";
    } else if (route === "knowledge_agent") {
      const knowExec = specialistExecutions[0];
      synthesizedAnswer = knowExec?.resultsSummary || "Tidak ada rujukan dokumen yang dihasilkan oleh Knowledge Agent.";
    }

    const plan: OrchestrationPlan = {
      intent: userQuery,
      route,
      confidence,
      reasoning,
      selectedDataSources: availableSources,
      specialistExecutions,
      synthesizedAnswer,
      jevDecisions: jevDecision.jevResult,
    };

    // 6. Save assistant message with plan
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

    // Auto update session title if default
    const [currentSession] = await this.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, sessionId));

    if (currentSession?.title === "New Orchestration Session") {
      const truncatedTitle = userQuery.length > 40 ? userQuery.slice(0, 37) + "..." : userQuery;
      await this.db
        .update(orchestratorSessions)
        .set({ title: truncatedTitle, updatedAt: new Date() })
        .where(eq(orchestratorSessions.id, sessionId));
    }

    return assistantMsg as any;
  }
}
