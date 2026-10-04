import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SuggestedQueryTemplate,
  TableRelation,
  TableSemanticProfile,
  CrossTableCluster,
  DocumentSemanticProfile,
} from "@paperclipai/shared";

export interface ColumnSample {
  name: string;
  sampleValues: any[];
  distinctCount?: number;
  nullRatio?: number;
  dataType?: string;
}

export interface CandidateTableInfo {
  tableName: string;
  columns: Array<{ name: string; role?: string; dataType?: string }>;
}

export interface AgentReasoningOptions {
  agentName?: string;
  model?: string;
  instructionsPath?: string;
  adapterType?: string;
  maxRetries?: number;
}

export type StructuredAgentOptions = AgentReasoningOptions;

export interface AgenticStep {
  stage: number;
  name: string;
  agent: string;
  thought: string;
  findings?: any;
  error?: string;
  iteration?: number;
}

export interface AgenticLoopResult<T> {
  result: T | null;
  iterations: number;
  reasoningSteps: AgenticStep[];
}

export interface AiTableAnalysisResult {
  domain: string;
  entities: string[];
  primaryTopics: string[];
  columnRoles: Record<string, "identifier" | "dimension" | "metric" | "temporal" | "attribute" | "ignore">;
  primaryKey: string[];
  metrics: Array<{
    name: string;
    column: string;
    aggregation: "sum" | "avg" | "count" | "min" | "max";
    description: string;
    format?: string;
  }>;
  relationships: TableRelation[];
  suggestedQueries: SuggestedQueryTemplate[];
  reasoningSummary: string;
  tableProfiles?: Record<string, TableSemanticProfile>;
  crossTableClusters?: CrossTableCluster[];
}

export interface AiDocumentAnalysisResult {
  domain: string;
  entities: string[];
  primaryTopics: string[];
  summary: string;
  targetAgentAffinity: string;
  suggestedQueries: SuggestedQueryTemplate[];
  reasoningSummary: string;
  documentProfiles?: DocumentSemanticProfile[];
}

export interface AiDatabaseAnalysisResult {
  domain: string;
  entities: string[];
  primaryTopics: string[];
  tableRoles: Record<string, "fact_table" | "dimension_table" | "lookup_table" | "bridge_table">;
  relationships: TableRelation[];
  suggestedQueries: SuggestedQueryTemplate[];
  reasoningSummary: string;
  tableProfiles?: Record<string, TableSemanticProfile>;
  crossTableClusters?: CrossTableCluster[];
}

export class AiReasoningService {
  private piCommand: string;
  private routerBaseUrl: string;
  private routerApiKey: string;
  private defaultModel: string;

  constructor() {
    // Resolve pi command from common locations
    this.piCommand =
      process.env.PAPERCLIP_PI_COMMAND ||
      (fs.existsSync("/Users/danangharissetiawan/.local/bin/pi")
        ? "/Users/danangharissetiawan/.local/bin/pi"
        : "pi");

    this.routerBaseUrl =
      process.env.RISSET_BASE_URL ||
      process.env.AI_ROUTER_URL ||
      "https://router.rissets.com/v1";

    this.routerApiKey =
      process.env.RISSET_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "";

    if (!this.routerApiKey) {
      try {
        const hostDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
        const hostModelsPath = path.join(hostDir, "models.json");
        if (fs.existsSync(hostModelsPath)) {
          const raw = JSON.parse(fs.readFileSync(hostModelsPath, "utf8"));
          if (raw?.providers?.rissets?.apiKey) {
            this.routerApiKey = raw.providers.rissets.apiKey;
          }
          if (raw?.providers?.rissets?.baseUrl) {
            this.routerBaseUrl = raw.providers.rissets.baseUrl;
          }
        }
      } catch {
        // host models.json not present
      }
    }

    this.defaultModel = "rissets/neural/deepseek-v4.1-flash";
  }

  /**
   * Generic Agentic Execution Loop with self-correction feedback and retry mechanics.
   * Runs the agent's LLM model, validates schema and quality criteria, and if issues
   * are detected, injects specific error feedback for the next iteration.
   */
  async executeAgenticLoop<T>(
    taskName: string,
    initialPrompt: string,
    validator: (rawJson: any) => { valid: boolean; errors: string[]; sanitized?: T },
    options?: AgentReasoningOptions,
  ): Promise<AgenticLoopResult<T>> {
    const maxRetries = Math.max(1, options?.maxRetries ?? 3);
    const agentName = options?.agentName || "Ingestion Agent";
    const model = options?.model || this.defaultModel;
    const instructionsPath = options?.instructionsPath;
    const reasoningSteps: AgenticStep[] = [];

    let currentPrompt = initialPrompt;
    let lastParsed: any = null;
    let lastErrors: string[] = [];

    for (let iteration = 1; iteration <= maxRetries; iteration++) {
      if (iteration === 1) {
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Autonomous Reasoning`,
          agent: agentName,
          thought: `Memulai penalaran agentic '${agentName}' untuk evaluasi '${taskName}' menggunakan model ${model}.`,
          iteration: 1,
        });
      } else {
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Self-Correction Feedback (Iterasi ${iteration}/${maxRetries})`,
          agent: agentName,
          thought: `Melakukan perbaikan dan penalaran ulang (retry) karena validasi pada iterasi sebelumnya belum terpenuhi: ${lastErrors.join(", ")}.`,
          iteration,
          findings: { previousErrors: lastErrors },
        });
      }

      let rawOutput: string | null = null;
      let execError: string | null = null;

      // 1. Prioritize direct HTTP router inference if API key is available (fast 1-3s vs CLI process overhead)
      if (this.routerApiKey) {
        try {
          rawOutput = await this.runViaRouterHttp(currentPrompt, model);
        } catch (err: any) {
          execError = `Router HTTP failed: ${err.message}`;
          console.warn(`[${agentName}] Iteration ${iteration} Router HTTP failed: ${err.message}. Trying Pi CLI fallback.`);
        }
      }

      // 2. Fall back to Pi CLI if router HTTP did not return an output
      if (!rawOutput) {
        try {
          rawOutput = await this.runViaPiCli(currentPrompt, model, instructionsPath);
        } catch (err: any) {
          execError = (execError ? `${execError}; ` : "") + err.message;
          console.warn(`[${agentName}] Iteration ${iteration} Pi execution failed: ${err.message}`);
        }
      }

      if (!rawOutput) {
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Model Execution Stalled`,
          agent: agentName,
          thought: `Inference model gagal pada iterasi ${iteration}: ${execError || "No response received"}.`,
          error: execError || "Model inference failed",
          iteration,
        });
        continue;
      }

      // 3. Extract and parse JSON
      const parsed = this.extractJson(rawOutput);
      if (!parsed) {
        lastErrors = ["Format output bukan JSON valid atau struktur kurung kurawal tidak lengkap"];
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Format Syntax Check`,
          agent: agentName,
          thought: `Respons model tidak dapat diparsing sebagai JSON. Menyiapkan feedback korektif untuk iterasi ${iteration + 1}.`,
          error: "Malformed JSON output",
          iteration,
        });

        currentPrompt = `${initialPrompt}\n\n[AGENTIC FEEDBACK - RETRY ITERATION ${iteration + 1}]:\nYour previous response was NOT valid JSON:\n${rawOutput.slice(0, 300)}\n\nPlease correct this immediately. Output ONLY raw, valid JSON with no markdown fences, no code block backticks, and exactly matching the requested JSON schema.`;
        continue;
      }

      lastParsed = parsed;

      // 4. Validate domain rules & criteria
      const validation = validator(parsed);
      if (!validation.valid) {
        lastErrors = validation.errors;
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Validation Gate (Iterasi ${iteration})`,
          agent: agentName,
          thought: `Hasil evaluasi memerlukan penyempurnaan domain/entitas: ${validation.errors.join("; ")}. Agen melakukan penalaran korektif.`,
          findings: { validationIssues: validation.errors },
          iteration,
        });

        currentPrompt = `${initialPrompt}\n\n[AGENTIC FEEDBACK - RETRY ITERATION ${iteration + 1}]:\nYour previous analysis JSON was parsed, but failed validation with the following issues:\n${validation.errors.map((e) => `- ${e}`).join("\n")}\n\nPlease reason through each issue carefully, correct them, and provide a fully compliant, complete JSON response.`;
        continue;
      }

      // 5. Validation passed!
      reasoningSteps.push({
        stage: reasoningSteps.length + 1,
        name: `${taskName} - Validasi Berhasil`,
        agent: agentName,
        thought: `Analisis '${taskName}' berhasil divalidasi pada iterasi ${iteration}. Seluruh entitas, domain, dan relasi terverifikasi akurat.`,
        findings: {
          domain: (validation.sanitized as any)?.domain,
          entities: (validation.sanitized as any)?.entities,
          topics: (validation.sanitized as any)?.primaryTopics,
        },
        iteration,
      });

      return {
        result: validation.sanitized || (parsed as T),
        iterations: iteration,
        reasoningSteps,
      };
    }

    // Fallback: If max retries reached, attempt sanitizing the best available parsed object
    if (lastParsed) {
      const fallbackSanitization = validator(lastParsed);
      if (fallbackSanitization.sanitized) {
        reasoningSteps.push({
          stage: reasoningSteps.length + 1,
          name: `${taskName} - Best-Effort Sanitization`,
          agent: agentName,
          thought: `Iterasi maksimum tercapai (${maxRetries}). Menggunakan data terbaik yang berhasil tersanitasi.`,
          iteration: maxRetries,
        });
        return {
          result: fallbackSanitization.sanitized,
          iterations: maxRetries,
          reasoningSteps,
        };
      }
    }

    return {
      result: null,
      iterations: maxRetries,
      reasoningSteps,
    };
  }

  /**
   * Run the Structured Ingestion Agent to perform complete semantic profiling,
   * entity discovery, column role classification, and relationship mapping with an agentic loop.
   */
  async analyzeTable(
    tableName: string,
    columns: ColumnSample[],
    sampleRows: Record<string, any>[] = [],
    candidateTables: CandidateTableInfo[] = [],
    agentOptions?: AgentReasoningOptions,
  ): Promise<AgenticLoopResult<AiTableAnalysisResult>> {
    const columnSummary = columns
      .map((c) => {
        const samples = (c.sampleValues || [])
          .slice(0, 4)
          .map((v) =>
            v === null || v === undefined
              ? "null"
              : typeof v === "string"
              ? `"${v.slice(0, 35)}"`
              : String(v),
          );
        return `- ${c.name} (${c.dataType || "string"}, samples: [${samples.join(", ")}])`;
      })
      .join("\n");

    const candidateSummary = candidateTables.slice(0, 15).map((t) => ({
      tableName: t.tableName,
      columns: t.columns.map((c) => c.name).slice(0, 15),
    }));

    const sampleRowSnippet = sampleRows
      .slice(0, 3)
      .map((r) => {
        const simplified: Record<string, any> = {};
        for (const [k, v] of Object.entries(r).slice(0, 10)) {
          simplified[k] =
            typeof v === "string" && v.length > 50 ? v.slice(0, 50) + "..." : v;
        }
        return JSON.stringify(simplified);
      })
      .join("\n");

    const initialPrompt = `You are Primbon's built-in Structured Ingestion Agent.
Analyze this newly onboarded table for business semantic profiling, entity discovery, and cross-table relations.

Target Table: ${tableName}
Columns and Sample Data:
${columnSummary}

Sample Rows:
${sampleRowSnippet || "No sample rows available"}

Existing Organization Tables (check for real foreign-key relations):
${JSON.stringify(candidateSummary, null, 2)}

Instructions:
1. Identify the real-world business/scientific domain (e.g. "Retail / Customer Analytics", "Hospitality & Food Service - Cafe Industry", "Oceanography / Marine Environmental Satellite Data", "Legal & Notary Affairs", "Healthcare", "HR Payroll").
2. Identify 1 to 4 clean, real business entities (e.g. "Customer", "Product", "Cafe", "Chlorophyll"). Never output dates, numbers, or file name artifacts as entities.
3. Synthesize 4 to 8 domain-specific analytical topics (e.g. "Cafe Reviews and Ratings", "Customer Transaction Analysis", "Phytoplankton Biomass Trends"). Never output generic boilerplate topics like "Profil & Direktori [number]".
4. Classify each column role:
   - "identifier" (ID, unique key, code, reference number, name)
   - "metric" (quantitative numbers for measurement/aggregation: price, amount, rating, count, measurement values)
   - "temporal" (date, timestamp, epoch time, year)
   - "dimension" (category, status, region, type, description)
   - "attribute" (contact details, phone, address, URL)
5. Identify primaryKey columns (single or composite key that uniquely identifies a row).
6. Determine aggregation for metrics: "sum" (for money amounts, counts, quantities) or "avg" (for ratings, ratios, percentages, measurements) or "count".
7. Discover REAL relationships between this table and existing organization tables:
   - Only propose relations where column names and business semantics truly match.
   - Do NOT propose relations between unrelated domains (e.g. retail vs notary tables).
   - Set confidence between 0.0 and 1.0, and provide a clear rationale.
8. Suggest 3 to 6 practical SQL query templates for analytics.

Respond with ONLY valid JSON (no markdown formatting, no code block backticks):
{
  "domain": string,
  "entities": string[],
  "primaryTopics": string[],
  "columnRoles": Record<string, "identifier"|"dimension"|"metric"|"temporal"|"attribute">,
  "primaryKey": string[],
  "metrics": Array<{
    "name": string,
    "column": string,
    "aggregation": "sum"|"avg"|"count"|"min"|"max",
    "description": string,
    "format": "integer"|"decimal"|"currency_idr"|"percentage"
  }>,
  "relationships": Array<{
    "sourceTable": string,
    "sourceColumn": string,
    "targetTable": string,
    "targetColumn": string,
    "relationType": "one_to_one"|"one_to_many"|"many_to_one"|"many_to_many",
    "confidence": number,
    "rationale": string
  }>,
  "suggestedQueries": Array<{
    "title": string,
    "query": string,
    "category": "aggregation"|"filtering"|"trend"|"general",
    "sqlSnippet": string,
    "description": string
  }>,
  "reasoningSummary": string
}`;

    const validator = (parsed: any): { valid: boolean; errors: string[]; sanitized?: AiTableAnalysisResult } => {
      const errors: string[] = [];
      if (!parsed || typeof parsed !== "object") {
        return { valid: false, errors: ["Parsed output is not an object"] };
      }

      // Domain check
      const domain = typeof parsed.domain === "string" ? parsed.domain.trim() : "";
      if (domain.length < 3 || domain.toLowerCase() === "unknown") {
        errors.push("Field 'domain' must be a descriptive non-empty string");
      }

      // Entities check
      let entities: string[] = [];
      if (Array.isArray(parsed.entities)) {
        entities = parsed.entities
          .map((e: any) => (typeof e === "string" ? e : e?.name || e?.entity || ""))
          .filter((e: string) => typeof e === "string" && e.trim().length > 0 && !/^\d+$/.test(e.trim()));
      }
      if (entities.length === 0) {
        errors.push("Field 'entities' must contain at least 1 real business entity");
      }

      // Topics check
      let primaryTopics: string[] = [];
      if (Array.isArray(parsed.primaryTopics)) {
        primaryTopics = parsed.primaryTopics
          .map((t: any) => (typeof t === "string" ? t : t?.topic || t?.name || ""))
          .filter((t: string) => typeof t === "string" && t.trim().length > 0);
      }
      if (primaryTopics.length < 2) {
        errors.push("Field 'primaryTopics' must contain at least 2 analytical topics");
      }

      // Column roles check
      const columnRoles: Record<string, any> = {};
      if (parsed.columnRoles && typeof parsed.columnRoles === "object") {
        for (const [k, v] of Object.entries(parsed.columnRoles)) {
          const roleVal = typeof v === "string" ? v : (v as any)?.role || "dimension";
          columnRoles[k] = roleVal;
        }
      }

      // Primary key check
      let primaryKey: string[] = [];
      if (Array.isArray(parsed.primaryKey)) {
        primaryKey = parsed.primaryKey.filter((k: any) => typeof k === "string");
      } else if (parsed.primaryKey && typeof parsed.primaryKey === "object") {
        if (Array.isArray(parsed.primaryKey.candidate)) {
          primaryKey = parsed.primaryKey.candidate;
        }
      }

      // Metrics check
      const metrics: any[] = [];
      if (Array.isArray(parsed.metrics)) {
        for (const m of parsed.metrics) {
          if (!m) continue;
          const col = m.column || m.name;
          if (!col) continue;
          let agg = m.aggregation;
          if (Array.isArray(m.aggregations) && m.aggregations.length > 0) {
            agg = m.aggregations[0];
          }
          if (!["sum", "avg", "count", "min", "max"].includes(agg)) {
            agg = "sum";
          }
          metrics.push({
            name: m.name || col,
            column: col,
            aggregation: agg,
            description: m.description || `Metric ${m.name || col}`,
            format: m.format || "decimal",
          });
        }
      }

      // Relationships check
      const relationships: any[] = [];
      if (Array.isArray(parsed.relationships)) {
        for (const r of parsed.relationships) {
          if (r && r.sourceColumn && r.targetTable && r.targetColumn) {
            relationships.push({
              sourceTable: r.sourceTable,
              sourceColumn: r.sourceColumn,
              targetTable: r.targetTable,
              targetColumn: r.targetColumn,
              relationType:
                r.relationType === "one_to_one" || r.relationType === "one_to_many"
                  ? r.relationType
                  : "many_to_one",
              confidence: typeof r.confidence === "number" ? r.confidence : 0.8,
              rationale: r.rationale || "Discovered by Structured Ingestion Agent",
            });
          }
        }
      }

      // Suggested queries check
      const suggestedQueries: SuggestedQueryTemplate[] = [];
      if (Array.isArray(parsed.suggestedQueries)) {
        for (const q of parsed.suggestedQueries) {
          if (q && (q.query || q.title)) {
            suggestedQueries.push({
              title: q.title || q.intent || "Analytical Query",
              query: q.query || q.sql || "",
              category: ["aggregation", "filtering", "trend", "general"].includes(q.category)
                ? q.category
                : "aggregation",
              sqlSnippet: q.sqlSnippet || q.query || "",
              description: q.description || q.title || "",
            });
          }
        }
      }

      const sampleRowCount = sampleRows?.length || 0;
      const tableProfiles: Record<string, TableSemanticProfile> = {
        [tableName]: {
          tableName,
          tableRole: sampleRowCount > 500 ? "fact_table" : "dimension_table",
          context: `Tabel terstruktur '${tableName}' berisikan ${columns.length} kolom dengan ${
            sampleRowCount.toLocaleString()
          } baris data untuk analisis kuantitatif dan reporting.`,
          topics: primaryTopics,
          entities,
          decisionSpecRefs: ["struct.column_role.v1", "struct.entity_metric_mapping.v1"],
          relationships,
          sampleRowCount,
        },
      };

      const sanitized: AiTableAnalysisResult = {
        domain: domain || "Structured Dataset",
        entities,
        primaryTopics,
        columnRoles,
        primaryKey,
        metrics,
        relationships,
        suggestedQueries,
        tableProfiles,
        reasoningSummary:
          parsed.reasoningSummary ||
          `Analisis semantik dataset berhasil divalidasi oleh Structured Ingestion Agent (${entities.join(", ")}).`,
      };

      return {
        valid: errors.length === 0,
        errors,
        sanitized,
      };
    };

    return this.executeAgenticLoop<AiTableAnalysisResult>(
      `Structured Table Analysis (${tableName})`,
      initialPrompt,
      validator,
      {
        agentName: agentOptions?.agentName || "Structured Ingestion Agent",
        model: agentOptions?.model || this.defaultModel,
        instructionsPath: agentOptions?.instructionsPath,
        adapterType: agentOptions?.adapterType,
        maxRetries: agentOptions?.maxRetries ?? 3,
      },
    );
  }

  /**
   * Run the Knowledge Ingestion Agent to perform deep semantic document analysis,
   * domain classification, entity extraction, and retrieval query synthesis with an agentic loop.
   */
  async analyzeDocument(
    fileName: string,
    chunks: Array<{ chunkIndex: number; title: string | null; content: string }>,
    totalWords: number,
    agentOptions?: AgentReasoningOptions,
  ): Promise<AgenticLoopResult<AiDocumentAnalysisResult>> {
    const chunkSnippets = chunks
      .slice(0, 6)
      .map(
        (c) =>
          `[Chunk #${c.chunkIndex}${c.title ? ` - ${c.title}` : ""}]:\n${c.content.slice(0, 600)}`,
      )
      .join("\n\n---\n\n");

    const initialPrompt = `You are Primbon's built-in Knowledge Ingestion Agent.
Your mission is to perform deep semantic document analysis, domain taxonomy classification, key entities extraction, passage synthesis, target agent affinity determination, and semantic retrieval query generation for unstructured knowledge base onboarding.

Document Name: ${fileName}
Total Words: ${totalWords}
Total Chunks: ${chunks.length}

Representative Document Excerpts:
${chunkSnippets || "(No text content extracted)"}

Instructions:
1. Identify the real-world knowledge domain (e.g. "Corporate Legal & Governance Policy", "Technical Architecture & API Specifications", "Clinical Research & Healthcare Protocols", "Financial Audit & Accounting Standards", "Marine Ecology & Environmental Science"). Do NOT output vague strings like "document" or "unstructured".
2. Extract 2 to 6 key subject entities described or governed by this document (e.g. "Notary Regulation", "Data Privacy Framework", "Chlorophyll Satellite Sensor", "API Gateway Architecture"). Do NOT extract file extensions, dates, or numbers as entities.
3. Synthesize 4 to 8 domain-specific analytical and operational topics covered in this document (e.g. "Compliance Requirements", "Authentication Procedures", "Algorithm Performance Metrics"). Never output generic topics like "Bab 1", "Section 1", or "Topik A".
4. Write an executive summary of this document (2-4 sentences in clear Indonesian or English) highlighting its purpose, scope, and key operational takeaways.
5. Determine target agent affinity: "rag_agent" | "document_agent" | "policy_agent" | "research_agent" | "data_agent".
6. Generate 3 to 6 high-value semantic retrieval questions / queries that users or operational agents would ask when querying this knowledge base.

Respond with ONLY valid JSON (no markdown formatting, no code block backticks):
{
  "domain": string,
  "entities": string[],
  "primaryTopics": string[],
  "summary": string,
  "targetAgentAffinity": "rag_agent"|"document_agent"|"policy_agent"|"research_agent"|"data_agent",
  "suggestedQueries": Array<{
    "title": string,
    "query": string,
    "category": "factual"|"procedural"|"policy"|"summary",
    "description": string
  }>,
  "reasoningSummary": string
}`;

    const validator = (parsed: any): { valid: boolean; errors: string[]; sanitized?: AiDocumentAnalysisResult } => {
      const errors: string[] = [];
      if (!parsed || typeof parsed !== "object") {
        return { valid: false, errors: ["Parsed output is not an object"] };
      }

      // Domain check
      const domain = typeof parsed.domain === "string" ? parsed.domain.trim() : "";
      if (domain.length < 3 || domain.toLowerCase() === "unknown" || domain.toLowerCase() === "document") {
        errors.push("Field 'domain' must be a specific knowledge domain string");
      }

      // Entities check
      let entities: string[] = [];
      if (Array.isArray(parsed.entities)) {
        entities = parsed.entities
          .map((e: any) => (typeof e === "string" ? e : e?.name || e?.entity || ""))
          .filter((e: string) => typeof e === "string" && e.trim().length > 0 && !/^\d+$/.test(e.trim()));
      }
      if (entities.length === 0) {
        errors.push("Field 'entities' must contain at least 1 real subject entity");
      }

      // Topics check
      let primaryTopics: string[] = [];
      if (Array.isArray(parsed.primaryTopics)) {
        primaryTopics = parsed.primaryTopics
          .map((t: any) => (typeof t === "string" ? t : t?.topic || t?.name || ""))
          .filter((t: string) => typeof t === "string" && t.trim().length > 0);
      }
      if (primaryTopics.length < 2) {
        errors.push("Field 'primaryTopics' must contain at least 2 specific knowledge topics");
      }

      // Summary check
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (summary.length < 15) {
        errors.push("Field 'summary' must be an informative text of at least 15 characters");
      }

      // Target agent affinity check
      const targetAgentAffinity =
        typeof parsed.targetAgentAffinity === "string" && parsed.targetAgentAffinity.trim()
          ? parsed.targetAgentAffinity.trim()
          : "rag_agent";

      // Suggested queries check
      const suggestedQueries: SuggestedQueryTemplate[] = [];
      if (Array.isArray(parsed.suggestedQueries)) {
        for (const q of parsed.suggestedQueries) {
          if (q && (q.query || q.title)) {
            suggestedQueries.push({
              title: q.title || q.query || "Knowledge Search",
              query: q.query || q.title || "",
              category: ["factual", "procedural", "policy", "summary"].includes(q.category)
                ? (q.category as any)
                : "general",
              sqlSnippet: q.sqlSnippet || "",
              description: q.description || q.title || "",
            });
          }
        }
      }

      const documentProfiles: DocumentSemanticProfile[] = [
        {
          title: fileName.replace(/\.[^/.]+$/, ""),
          domain: domain || "Knowledge Document",
          context: summary || `Dokumen '${fileName}' dipetakan ke dalam knowledge base.`,
          topics: primaryTopics,
          entities,
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.passage_relevance.v1"],
        },
      ];

      const sanitized: AiDocumentAnalysisResult = {
        domain: domain || "Knowledge Document",
        entities,
        primaryTopics,
        summary: summary || `Dokumen ${fileName} dipetakan ke dalam basis pengetahuan RAG.`,
        targetAgentAffinity,
        suggestedQueries,
        documentProfiles,
        reasoningSummary:
          parsed.reasoningSummary ||
          `Penalaran dokumen selesai oleh Knowledge Ingestion Agent. Entitas: ${entities.join(", ")}.`,
      };

      return {
        valid: errors.length === 0,
        errors,
        sanitized,
      };
    };

    return this.executeAgenticLoop<AiDocumentAnalysisResult>(
      `Document Semantic Extraction (${fileName})`,
      initialPrompt,
      validator,
      {
        agentName: agentOptions?.agentName || "Knowledge Ingestion Agent",
        model: agentOptions?.model || this.defaultModel,
        instructionsPath: agentOptions?.instructionsPath,
        adapterType: agentOptions?.adapterType,
        maxRetries: agentOptions?.maxRetries ?? 3,
      },
    );
  }

  /**
   * Run the Database Ingestion Agent to perform live catalog introspection,
   * table role classification, cross-table relationship synthesis, and analytical SQL templates.
   */
  async analyzeDatabaseSchema(
    dbType: string,
    databaseName: string,
    tables: Array<{
      tableName: string;
      rowCount: number;
      columns: Array<{ name: string; dataType: string; isPrimary?: boolean; isForeign?: boolean; references?: any }>;
    }>,
    agentOptions?: AgentReasoningOptions,
  ): Promise<AgenticLoopResult<AiDatabaseAnalysisResult>> {
    const tableSummaries = tables.map((t) => {
      // Prioritize PKs and FKs, then top descriptive columns
      const keyCols = t.columns.filter((c) => c.isPrimary || c.isForeign);
      const otherCols = t.columns.filter((c) => !c.isPrimary && !c.isForeign);
      const selectedCols = [...keyCols, ...otherCols.slice(0, Math.max(8, 15 - keyCols.length))];
      const remainingCount = t.columns.length - selectedCols.length;

      const colList = selectedCols.map((c) => {
        const flags = [];
        if (c.isPrimary) flags.push("PK");
        if (c.isForeign) flags.push(`FK->${c.references || ""}`);
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        return `${c.name} (${c.dataType}${flagStr})`;
      });

      const moreStr = remainingCount > 0 ? `, +${remainingCount} more columns` : "";
      return `- Table '${t.tableName}' (Rows: ${t.rowCount}):\n  Columns: ${colList.join(", ")}${moreStr}`;
    }).join("\n\n");

    const initialPrompt = `You are Primbon's built-in Database Ingestion Agent.
Your mission is to handle live relational database connections, catalog introspection, business entity discovery, table role classification, cross-table relationship synthesis, and analytical SQL query generation.

Database Engine: ${dbType}
Database Name: ${databaseName}
Total Tables: ${tables.length}

Tables and Columns:
${tableSummaries}

Instructions:
1. Identify the overarching business/application domain of this database (e.g. "Enterprise E-Commerce & Order Management", "Healthcare Electronic Medical Records", "Hospitality Point of Sale & Inventory", "Financial Core Banking System").
2. Identify 2 to 8 real business entities represented across the database (e.g. "Customer", "Order", "Product", "Invoice", "Payment", "InventoryItem").
3. Classify the role of EVERY table into one of:
   - "fact_table": Contains numeric business measurements, transactions, events, or time-series data with high row counts or transaction foreign keys.
   - "dimension_table": Contains business entities, master data, attributes, categories, and descriptors (e.g. users, products, stores).
   - "lookup_table": Small reference tables, status codes, country codes, category lists.
   - "bridge_table": Many-to-many junction tables linking two dimension tables or fact tables.
4. Discover relationships between tables:
   - Match primary keys to foreign keys or naming conventions (e.g. order_items.order_id -> orders.id, orders.customer_id -> customers.id).
   - Identify relationType ("one_to_one", "one_to_many", "many_to_one", "many_to_many").
   - Assign confidence (0.0 - 1.0) and explain the business rationale.
5. Synthesize 4 to 8 primary analytical topics that this database supports.
6. Generate 3 to 6 practical SQL query templates (with realistic JOINs, GROUP BYs, and aggregations) for operational intelligence.

Respond with ONLY valid JSON (no markdown formatting, no code block backticks):
{
  "domain": string,
  "entities": string[],
  "primaryTopics": string[],
  "tableRoles": Record<string, "fact_table"|"dimension_table"|"lookup_table"|"bridge_table">,
  "relationships": Array<{
    "sourceTable": string,
    "sourceColumn": string,
    "targetTable": string,
    "targetColumn": string,
    "relationType": "one_to_one"|"one_to_many"|"many_to_one"|"many_to_many",
    "confidence": number,
    "rationale": string
  }>,
  "suggestedQueries": Array<{
    "title": string,
    "query": string,
    "category": "aggregation"|"filtering"|"trend"|"general",
    "sqlSnippet": string,
    "description": string
  }>,
  "reasoningSummary": string
}`;

    const validator = (parsed: any): { valid: boolean; errors: string[]; sanitized?: AiDatabaseAnalysisResult } => {
      const errors: string[] = [];
      if (!parsed || typeof parsed !== "object") {
        return { valid: false, errors: ["Parsed output is not an object"] };
      }

      // Domain check
      const domain = typeof parsed.domain === "string" ? parsed.domain.trim() : "";
      if (domain.length < 3 || domain.toLowerCase() === "unknown") {
        errors.push("Field 'domain' must be a descriptive relational database domain");
      }

      // Entities check
      let entities: string[] = [];
      if (Array.isArray(parsed.entities)) {
        entities = parsed.entities
          .map((e: any) => (typeof e === "string" ? e : e?.name || e?.entity || ""))
          .filter((e: string) => typeof e === "string" && e.trim().length > 0 && !/^\d+$/.test(e.trim()));
      }
      if (entities.length === 0) {
        errors.push("Field 'entities' must contain at least 1 real business entity");
      }

      // Table roles check
      const tableRoles: Record<string, "fact_table" | "dimension_table" | "lookup_table" | "bridge_table"> = {};
      const validRoles = ["fact_table", "dimension_table", "lookup_table", "bridge_table"];
      if (parsed.tableRoles && typeof parsed.tableRoles === "object") {
        for (const [k, v] of Object.entries(parsed.tableRoles)) {
          const rStr = String(v).toLowerCase().replace(/[- ]/g, "_");
          if (validRoles.includes(rStr)) {
            tableRoles[k] = rStr as any;
          } else {
            tableRoles[k] = "dimension_table";
          }
        }
      }
      // Ensure all inspected tables have an assigned role
      for (const t of tables) {
        if (!tableRoles[t.tableName]) {
          tableRoles[t.tableName] = t.rowCount > 500 ? "fact_table" : "dimension_table";
        }
      }

      // Topics check
      let primaryTopics: string[] = [];
      if (Array.isArray(parsed.primaryTopics)) {
        primaryTopics = parsed.primaryTopics
          .map((t: any) => (typeof t === "string" ? t : t?.topic || t?.name || ""))
          .filter((t: string) => typeof t === "string" && t.trim().length > 0);
      }
      if (primaryTopics.length < 2) {
        errors.push("Field 'primaryTopics' must contain at least 2 analytical database topics");
      }

      // Relationships check
      const relationships: any[] = [];
      if (Array.isArray(parsed.relationships)) {
        for (const r of parsed.relationships) {
          if (r && r.sourceTable && r.sourceColumn && r.targetTable && r.targetColumn) {
            relationships.push({
              sourceTable: r.sourceTable,
              sourceColumn: r.sourceColumn,
              targetTable: r.targetTable,
              targetColumn: r.targetColumn,
              relationType:
                r.relationType === "one_to_one" || r.relationType === "one_to_many"
                  ? r.relationType
                  : "many_to_one",
              confidence: typeof r.confidence === "number" ? r.confidence : 0.85,
              rationale: r.rationale || "Introspected relational foreign-key relationship",
            });
          }
        }
      }

      // Suggested queries check
      const suggestedQueries: SuggestedQueryTemplate[] = [];
      if (Array.isArray(parsed.suggestedQueries)) {
        for (const q of parsed.suggestedQueries) {
          if (q && (q.query || q.title || q.sqlSnippet)) {
            suggestedQueries.push({
              title: q.title || "Database Analysis Query",
              query: q.query || q.sqlSnippet || "",
              category: ["aggregation", "filtering", "trend", "general"].includes(q.category)
                ? q.category
                : "aggregation",
              sqlSnippet: q.sqlSnippet || q.query || "",
              description: q.description || q.title || "",
            });
          }
        }
      }

      // Generate per-table profiles for all tables
      const tableProfiles: Record<string, TableSemanticProfile> = {};
      if (parsed.tableProfiles && typeof parsed.tableProfiles === "object") {
        for (const [tName, tp] of Object.entries(parsed.tableProfiles)) {
          if (tp && typeof tp === "object") {
            const rawTp = tp as any;
            tableProfiles[tName] = {
              tableName: tName,
              tableRole: tableRoles[tName] || "dimension_table",
              context: typeof rawTp.context === "string" ? rawTp.context : `Tabel '${tName}' dalam skema relasional.`,
              topics: Array.isArray(rawTp.topics) ? rawTp.topics.map((x: any) => String(x)) : [],
              entities: Array.isArray(rawTp.entities) ? rawTp.entities.map((x: any) => String(x)) : [tName],
              decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1"],
              relationships: relationships.filter(
                (r) =>
                  r.sourceTable?.toLowerCase() === tName.toLowerCase() ||
                  r.targetTable?.toLowerCase() === tName.toLowerCase()
              ),
            };
          }
        }
      }

      // Ensure 100% table coverage
      for (const t of tables) {
        if (!tableProfiles[t.tableName]) {
          const tRole = tableRoles[t.tableName] || (t.rowCount > 500 ? "fact_table" : "dimension_table");
          const tRels = relationships.filter(
            (r) =>
              r.sourceTable?.toLowerCase() === t.tableName.toLowerCase() ||
              r.targetTable?.toLowerCase() === t.tableName.toLowerCase()
          );
          tableProfiles[t.tableName] = {
            tableName: t.tableName,
            tableRole: tRole,
            context: `Tabel '${t.tableName}' (${tRole === "fact_table" ? "Tabel Fakta Transaksional" : "Tabel Master Dimensi"}) memuat ${t.columns.length} kolom profil (${t.rowCount.toLocaleString()} baris) untuk analitik terpadu.`,
            topics: [
              `${t.tableName} Data Records & Integrity`,
              `${t.tableName} Column Schema & Attributes`,
              `${tRole === "fact_table" ? "Operational Transaction Activity" : "Master Entity Profile"}`,
            ],
            entities: [t.tableName],
            decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1"],
            relationships: tRels,
            sampleRowCount: t.rowCount,
          };
        }
      }

      // Synthesize cross-table clusters
      const crossTableClusters: CrossTableCluster[] = [];
      if (Array.isArray(parsed.crossTableClusters)) {
        for (const cl of parsed.crossTableClusters) {
          if (cl && typeof cl === "object" && cl.clusterName && Array.isArray(cl.tables)) {
            crossTableClusters.push({
              clusterName: String(cl.clusterName),
              description: String(cl.description || `Jaringan multi-tabel antara [${cl.tables.join(", ")}].`),
              tables: cl.tables.map((x: any) => String(x)),
              topics: Array.isArray(cl.topics) ? cl.topics.map((x: any) => String(x)) : [`Cross-Table Analysis (${cl.tables.slice(0, 3).join(", ")})`],
            });
          }
        }
      }
      if (crossTableClusters.length === 0 && tables.length > 1) {
        const relTables = Array.from(new Set(relationships.flatMap((r) => [r.sourceTable, r.targetTable]))).filter(Boolean);
        if (relTables.length > 1) {
          crossTableClusters.push({
            clusterName: `${domain} Relational Topology Network`,
            description: `Jaringan relasi multi-tabel antara [${relTables.join(", ")}] terhubung melalui relasi foreign key untuk join analitik.`,
            tables: relTables,
            topics: [
              `Cross-Table Join Analysis (${relTables.slice(0, 3).join(", ")})`,
              `Foreign Key Topology & Integrity`,
              `Multi-Entity Reconciliation`,
            ],
          });
        }
      }

      const sanitized: AiDatabaseAnalysisResult = {
        domain: domain || `${dbType.toUpperCase()} Relational Database`,
        entities,
        primaryTopics,
        tableRoles,
        relationships,
        suggestedQueries,
        tableProfiles,
        crossTableClusters,
        reasoningSummary:
          parsed.reasoningSummary ||
          `Introspeksi skema database '${databaseName}' (${tables.length} tabel) selesai divalidasi oleh Database Ingestion Agent.`,
      };

      return {
        valid: errors.length === 0,
        errors,
        sanitized,
      };
    };

    return this.executeAgenticLoop<AiDatabaseAnalysisResult>(
      `Database Schema Introspection (${databaseName})`,
      initialPrompt,
      validator,
      {
        agentName: agentOptions?.agentName || "Database Ingestion Agent",
        model: agentOptions?.model || this.defaultModel,
        instructionsPath: agentOptions?.instructionsPath,
        adapterType: agentOptions?.adapterType,
        maxRetries: agentOptions?.maxRetries ?? 3,
      },
    );
  }

  /**
   * Dynamically generate a safe read-only SQL query based on table schemas, columns, relationships, and user query.
   */
  async generateDynamicSqlQuery(options: {
    userQuery: string;
    dbType: string;
    tables: Array<{
      tableName: string;
      columns: Array<{ name: string; dataType?: string; role?: string; semanticCategory?: string; isSearchable?: boolean }>;
      relationships?: TableRelation[];
    }>;
    previousError?: string;
  }): Promise<{ sql: string; explanation: string } | null> {
    const quote = options.dbType === "postgres" ? `"` : "`";
    const tablesSummary = options.tables.slice(0, 15).map((t) => {
      const colList = t.columns.slice(0, 20).map((c) => `${c.name} (${c.dataType || "string"}${c.semanticCategory ? `, ${c.semanticCategory}` : ""})`).join(", ");
      const relList = (t.relationships || []).map((r) => `${r.sourceColumn} -> ${r.targetTable}.${r.targetColumn}`).join("; ");
      return `- Table ${quote}${t.tableName}${quote}: columns [${colList}]${relList ? ` | Relations: [${relList}]` : ""}`;
    }).join("\n");

    const prompt = `You are an expert SQL engineer. Generate a single, safe, read-only SELECT SQL query for ${options.dbType} to answer this user request:
"${options.userQuery}"

Available Database Tables & Columns:
${tablesSummary}

${options.previousError ? `\n[CORRECTIVE FEEDBACK - PREVIOUS ATTEMPT FAILED]:\n${options.previousError}\nPlease fix the column names, table names, or syntax.\n` : ""}

Rules:
1. ONLY produce a read-only SELECT query. Never use INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or CREATE.
2. Use proper ${options.dbType} identifier quoting (${quote}identifier${quote}).
3. Always include a LIMIT clause (max 50) to prevent memory exhaustion.
4. Output your response as a JSON object:
{
  "sql": "SELECT ...",
  "explanation": "Brief explanation of query strategy"
}`;

    try {
      let rawOutput: string | null = null;
      try {
        rawOutput = await this.runViaPiCli(prompt, this.defaultModel);
      } catch {
        rawOutput = await this.runViaRouterHttp(prompt, this.defaultModel);
      }
      if (!rawOutput) return null;
      const parsed = this.extractJson(rawOutput);
      if (parsed && typeof parsed.sql === "string") {
        return {
          sql: parsed.sql.trim().replace(/;+$/, ""),
          explanation: parsed.explanation || "Dynamic SQL query",
        };
      }
    } catch (err: any) {
      console.warn("[AiReasoningService] generateDynamicSqlQuery error:", err.message);
    }
    return null;
  }

  /**
   * Synthesize a grounded, fluent, and well-structured answer to a user question based on retrieved knowledge chunks.
   */
  async synthesizeKnowledgeResponse(options: {
    userQuery: string;
    chunks: Array<{
      sourceName: string;
      title?: string;
      content: string;
      chunkId?: string;
    }>;
  }): Promise<string | null> {
    if (options.chunks.length === 0) return null;

    const formattedContext = options.chunks.map((c, i) => {
      return `[Chunk ${i + 1}] Source: "${c.sourceName}" | Section: "${c.title || "Document"}"\nContent: ${c.content}`;
    }).join("\n\n---\n\n");

    const prompt = `You are a knowledgeable, authoritative enterprise Knowledge Agent. Synthesize a direct, professional, and well-structured answer to the user query based ONLY on the provided verified enterprise knowledge documents.

User Query:
"${options.userQuery}"

Verified Enterprise Document Chunks:
${formattedContext}

Instructions:
1. Provide a direct, thorough, executive answer answering the user's specific question. Open with a clear summary paragraph.
2. Use fluent Indonesian (or English if the query was in English).
3. Present key components, cards, or metrics using structured markdown tables or clean scannable bullet points with bold titles.
4. STRICT RULE: DO NOT duplicate quotes in blockquotes under every bullet point. Present facts directly and authoritatively.
5. Do NOT hallucinate facts not present in the chunks. If a specific metric or formula is only described generally in the text, explain what is documented clearly and concisely without being overly defensive.
6. Provide the answer directly as clean markdown text.`;

    try {
      let rawOutput: string | null = null;
      try {
        rawOutput = await this.runViaPiCli(prompt, this.defaultModel);
      } catch {
        rawOutput = await this.runViaRouterHttp(prompt, this.defaultModel);
      }
      return rawOutput?.trim() || null;
    } catch (err: any) {
      console.warn("[AiReasoningService] synthesizeKnowledgeResponse error:", err.message);
      return null;
    }
  }

  private runViaPiCli(
    prompt: string,
    model: string,
    instructionsPath?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = ["--model", model, "--no-session", "--no-extensions"];

      if (instructionsPath && fs.existsSync(instructionsPath)) {
        args.push("--append-system-prompt", instructionsPath);
      }

      args.push("-p", prompt);

      const proc = spawn(this.piCommand, args, {
        env: {
          ...process.env,
          RISSET_API_KEY: this.routerApiKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Pi execution timed out (45s)"));
      }, 45000);

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim().length > 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Pi exited with code ${code}: ${stderr.slice(0, 300)}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async runViaRouterHttp(prompt: string, model: string): Promise<string | null> {
    if (!this.routerApiKey) return null;

    // Clean model string for router API if needed
    const apiModel = model.replace(/^rissets\//, "");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75000);

    const res = await fetch(`${this.routerBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.routerApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: apiModel.includes("/") ? apiModel : "neural/deepseek-v4.1-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3500,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : null;
  }

  private extractJson(raw: string): any | null {
    try {
      let cleaned = raw.trim();
      // Remove markdown code fences if present
      if (cleaned.includes("```")) {
        const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (match && match[1]) {
          cleaned = match[1].trim();
        } else {
          cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        }
      }

      // Find first { and last }
      const startIdx = cleaned.indexOf("{");
      const endIdx = cleaned.lastIndexOf("}");
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        cleaned = cleaned.slice(startIdx, endIdx + 1);
      }

      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

export const aiReasoningService = new AiReasoningService();
