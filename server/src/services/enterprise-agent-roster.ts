import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { builtInAgentService } from "./built-in-agents.js";

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

  // 2. ONBOARDING SPECIALISTS (3 agents)
  {
    name: "StructuredIngestionAgent",
    title: "Structured Data Ingestion Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "Structured file ingestion (CSV, Excel, Sheets, Parquet), automated schema profiling, data quality evaluation, semantic model building, batch indexing, dynamic JEV topic & context discovery, ClickHouse sync",
    reportsToHomseo: true,
  },
  {
    name: "KnowledgeIngestionAgent",
    title: "Knowledge Ingestion Specialist",
    role: "researcher",
    category: "onboarding",
    capabilities:
      "Unstructured document ingestion (PDF, DOCX, TXT, MD), semantic text chunking, embedding generation, vector and BM25 hybrid search indexing, document domain classification, ClickHouse hybrid vector sync",
    reportsToHomseo: true,
  },
  {
    name: "DatabaseIntegrationAgent",
    title: "Database Integration Specialist",
    role: "engineer",
    category: "onboarding",
    capabilities:
      "External database connectivity (PostgreSQL, MariaDB, MySQL, SQL Server, Oracle), schema & relation discovery, primary & foreign keys extraction, bilingual semantic modeling, CDC replication to ClickHouse",
    reportsToHomseo: true,
  },

  // 3. RUNTIME QUERY & RETRIEVAL SPECIALISTS (2 agents)
  {
    name: "DataAgent",
    title: "Data Agent Specialist",
    role: "engineer",
    category: "runtime",
    capabilities:
      "Internal database analytics, legal & commercial entity profiling across connected databases, tabular metrics aggregation on CSV and Excel datasets, ClickHouse execution, safe read-only SQL queries",
    reportsToHomseo: true,
  },
  {
    name: "KnowledgeAgent",
    title: "Knowledge Agent Specialist",
    role: "researcher",
    category: "runtime",
    capabilities:
      "RAG semantic search, policy and SOP retrieval, document analysis, citation extraction, ClickHouse vector retrieval, TypeSafe Jev verification",
    reportsToHomseo: true,
  },
];

export const ENTERPRISE_ROSTER_DEFINITIONS = ENTERPRISE_AGENT_ROSTER;

export class EnterpriseAgentRosterService {
  constructor(private db: Db) {}

  /**
   * Ensure all enterprise agents exist for the specified company.
   * Auto-provisions the 6 core built-in agents (Homseo, 3 onboarding agents, 2 query/retrieval agents).
   */
  async ensureEnterpriseRoster(companyId: string) {
    await builtInAgentService(this.db).autoProvisionBundledAgents(companyId);
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
