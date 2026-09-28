import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

export interface EnterpriseAgentSpec {
  name: string;
  title: string;
  role: "general" | "engineer" | "researcher" | "devops";
  category: "orchestrator" | "onboarding" | "runtime";
  capabilities: string;
  reportsToHomseo?: boolean;
}

export const ENTERPRISE_AGENT_ROSTER: EnterpriseAgentSpec[] = [
  // 1. PLATFORM / ORCHESTRATOR
  {
    name: "Homseo",
    title: "Enterprise Orchestrator & Chief of Staff",
    role: "general",
    category: "orchestrator",
    capabilities:
      "Chief of Staff, Cross-domain enterprise orchestration, Jev System One semantic routing, external database intelligence, structured analytics, RAG knowledge synthesis",
    reportsToHomseo: false,
  },
  {
    name: "OnboardingOrchestrator",
    title: "Onboarding Orchestrator",
    role: "general",
    category: "orchestrator",
    capabilities:
      "Multi-source enterprise data discovery, onboarding planning, delegation to ingestion specialists, progress tracking, capability publishing",
    reportsToHomseo: true,
  },
  {
    name: "AgentBuilder",
    title: "Agent Builder & System Composer",
    role: "general",
    category: "orchestrator",
    capabilities:
      "Enterprise agent compiler & composer; translates business requirements into specialized agents by reusing existing agents, skills, and MCP tools before generating code",
    reportsToHomseo: true,
  },

  // 2. ONBOARDING SPECIALISTS (7 agents)
  {
    name: "StructuredIngestionAgent",
    title: "Structured Data Ingestion Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "Structured file ingestion (CSV, Excel, Sheets, Parquet), automated schema profiling, data quality evaluation, semantic model building, batch indexing",
    reportsToHomseo: true,
  },
  {
    name: "KnowledgeIngestionAgent",
    title: "Knowledge Ingestion Specialist",
    role: "researcher",
    category: "onboarding",
    capabilities:
      "Unstructured document ingestion (PDF, DOCX, TXT, MD), semantic text chunking, embedding generation, vector and BM25 hybrid search indexing, document domain classification",
    reportsToHomseo: true,
  },
  {
    name: "DatabaseIntegrationAgent",
    title: "Database Integration Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "External database connectivity (PostgreSQL, MariaDB, MySQL, SQL Server, Oracle), schema & relation discovery, primary & foreign keys extraction, bilingual semantic modeling",
    reportsToHomseo: true,
  },
  {
    name: "ApiIntegrationAgent",
    title: "API Integration Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "REST API and OpenAPI 3.0 / Swagger ingestion, endpoint contract discovery, payload schema deduction, webhook mapping, and API semantic profiling",
    reportsToHomseo: true,
  },
  {
    name: "IotIntegrationAgent",
    title: "IoT Integration Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "MQTT broker subscription (v3.1.1/v5.0), industrial sensor telemetry ingestion, timeseries payload parsing, metric threshold configuration, and IoT semantic profiling",
    reportsToHomseo: true,
  },
  {
    name: "CctvIntegrationAgent",
    title: "CCTV Integration Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "RTSP video stream connectivity, Frigate NVR event metadata ingestion, restricted zone violation triage, alert escalation rules, and surveillance semantic profiling",
    reportsToHomseo: true,
  },
  {
    name: "McpBuilderAgent",
    title: "MCP Builder Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "Autonomous Model Context Protocol (MCP) server & tool generator, converting external APIs, databases, and IoT devices into standardized agent tools",
    reportsToHomseo: true,
  },

  // 3. RUNTIME SPECIALISTS (7 agents)
  {
    name: "KnowledgeAgent",
    title: "Knowledge Agent Specialist",
    role: "researcher",
    category: "runtime",
    capabilities:
      "RAG semantic search, policy and SOP retrieval, document analysis, citation extraction",
    reportsToHomseo: true,
  },
  {
    name: "DataAgent",
    title: "Data Agent Specialist",
    role: "engineer",
    category: "runtime",
    capabilities:
      "Internal database analytics, legal & commercial entity profiling across connected databases, tabular metrics aggregation on CSV and Excel datasets, ClickHouse execution",
    reportsToHomseo: true,
  },
  {
    name: "ResearchAgent",
    title: "Research Agent Specialist",
    role: "researcher",
    category: "runtime",
    capabilities:
      "External market intelligence, web research, fact verification, competitor landscape analysis, structured A2A evidence synthesis",
    reportsToHomseo: true,
  },
  {
    name: "AnalyticsEngineerAgent",
    title: "Analytics Engineer Specialist",
    role: "engineer",
    category: "runtime",
    capabilities:
      "Code interpreter sandbox execution, Python Polars/Pandas transformations, complex aggregations, interactive charts, and business reports",
    reportsToHomseo: true,
  },
  {
    name: "PredictionAgent",
    title: "Prediction & Forecasting Specialist",
    role: "engineer",
    category: "runtime",
    capabilities:
      "Time-series forecasting, anomaly detection, predictive regression & classification modeling in sandbox",
    reportsToHomseo: true,
  },
  {
    name: "ActionAgent",
    title: "Action & Operations Specialist",
    role: "devops",
    category: "runtime",
    capabilities:
      "Governed execution of business operations, external system mutations, and MCP tools with strict approval policies and validation",
    reportsToHomseo: true,
  },
  {
    name: "VisionAgent",
    title: "Vision Agent Specialist",
    role: "researcher",
    category: "runtime",
    capabilities:
      "Visual analysis of CCTV snapshots, image anomaly detection, OCR on scanned physical forms, multi-modal evidence inspection",
    reportsToHomseo: true,
  },
];

export const ENTERPRISE_ROSTER_DEFINITIONS = ENTERPRISE_AGENT_ROSTER;

export class EnterpriseAgentRosterService {
  constructor(private db: Db) {}

  /**
   * Ensure all enterprise agents exist for the specified company.
   * Creates missing agents automatically.
   */
  async ensureEnterpriseRoster(companyId: string) {
    // 1. Fetch existing agents
    const existing = await this.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const existingMap = new Map(existing.map((a) => [a.name.toLowerCase(), a.id]));

    // Find Homseo id for reportsTo
    let homseoId = existingMap.get("homseo");

    // If Homseo is not yet created, create Homseo first
    if (!homseoId) {
      const homseoSpec = ENTERPRISE_AGENT_ROSTER.find((s) => s.name === "Homseo")!;
      const [createdHomseo] = await this.db
        .insert(agents)
        .values({
          companyId,
          name: homseoSpec.name,
          title: homseoSpec.title,
          role: homseoSpec.role,
          capabilities: homseoSpec.capabilities,
          status: "idle",
          adapterType: "pi_local",
          adapterConfig: {
            model: "cmd/gpt-5.6-luna",
          },
          permissions: {
            canCreateAgents: true,
            canCreateSkills: true,
          },
        })
        .returning();
      homseoId = createdHomseo.id;
      existingMap.set("homseo", homseoId);
    }

    // Create any missing agents
    for (const spec of ENTERPRISE_AGENT_ROSTER) {
      if (existingMap.has(spec.name.toLowerCase())) {
        continue;
      }

      await this.db.insert(agents).values({
        companyId,
        name: spec.name,
        title: spec.title,
        role: spec.role,
        capabilities: spec.capabilities,
        status: "idle",
        reportsTo: spec.reportsToHomseo ? homseoId : null,
        adapterType: "pi_local",
        adapterConfig: {
          model: "cmd/gpt-5.6-luna",
        },
        permissions: {
          canCreateAgents: true,
          canCreateSkills: true,
        },
      });
    }
  }

  /**
   * Get all active agents with their capabilities for dynamic JEV routing
   */
  async getRosterForRouting(companyId: string): Promise<
    Array<{
      id: string;
      name: string;
      title: string;
      role: string;
      capabilities: string;
    }>
  > {
    const list = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        title: agents.title,
        role: agents.role,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    return list.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title || a.name,
      role: a.role,
      capabilities: a.capabilities || "",
    }));
  }
}
