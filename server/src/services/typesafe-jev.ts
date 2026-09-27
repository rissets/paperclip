import type {
  JevDecisionAnswer,
  JevDecisionChoice,
  JevDecisionNoul,
  JevDecisionResult,
  JevDecisionScore,
  OrchestratorRoute,
} from "@paperclipai/shared";

export interface TypeSafeJevConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export class TypeSafeJevService {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(config?: TypeSafeJevConfig) {
    this.baseUrl =
      config?.baseUrl ||
      process.env.TYPESAFE_BASE_URL ||
      "https://api.typesafe.ai/v1/systemone";
    this.apiKey =
      config?.apiKey ||
      process.env.TYPESAFE_API_KEY ||
      "apikey_2175770293d0b2bb4d7aad207229b074c260_3910962778a389e67c61d1e9a3a37f716f9435fd5d6370b15d3f2a0b88f94df8";
    this.defaultModel =
      config?.model ||
      process.env.DEFAULT_SYSTEMONE_MODEL ||
      "jev-1.13.0";
  }

  /**
   * Core System One execution endpoint
   */
  async systemOne(
    state: Record<string, any>,
    questions: Record<string, any>,
    options?: { model?: string; timeoutMs?: number },
  ): Promise<JevDecisionResult> {
    const start = Date.now();
    const model = options?.model || this.defaultModel;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs || 8000);

      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state,
          model,
          questions,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TypeSafe Jev API error (${res.status}): ${errText}`);
      }

      const data = (await res.json()) as any;
      const latencyMs = Date.now() - start;

      return {
        model: data.model || model,
        answers: data.answers || {},
        usage: data.usage,
        latencyMs,
      };
    } catch (err: any) {
      console.warn(`[TypeSafe Jev] System One call failed: ${err.message}. Using deterministic fallback.`);
      return this.fallbackDecision(state, questions);
    }
  }

  /**
   * 1. Intent Pre-Router for Enterprise Orchestrator
   */
  async routeUserQuery(
    userQuery: string,
    availableSources: Array<{ id: string; name: string; type: string; tables?: string[] }>,
  ): Promise<{
    route: OrchestratorRoute;
    confidence: number;
    reasoning: string;
    targetSourceId?: string;
    isProfilingQuery: boolean;
    requiresInternalData: boolean;
    jevResult?: JevDecisionResult;
  }> {
    const sourceChoices: Record<string, string> = {};
    for (const s of availableSources) {
      const tableInfo = s.tables && s.tables.length > 0 ? ` (Tabel: ${s.tables.slice(0, 5).join(", ")})` : "";
      sourceChoices[s.id] = `[${s.type.toUpperCase()}] ${s.name}${tableInfo}`;
    }
    sourceChoices["none"] = "Tidak membutuhkan data source tertentu / Percakapan umum";

    const questions: Record<string, any> = {
      route: {
        type: "choice",
        instructions: "Agen mana yang paling berwenang menangani query ini?",
        criteria: {
          data_agent: "DataAgent: Query analitik tabular, filter data, profil perusahaan/entitas, atau SQL database eksternal",
          knowledge_agent: "KnowledgeAgent: Pertanyaan dokumen RAG, kebijakan internal, SOP, SLA, manual",
          hybrid: "Hybrid: Membutuhkan data angka/profil sekaligus regulasi/kebijakan dokumen",
          direct: "Direct: Sapaan atau percakapan umum tanpa perlu data internal",
        },
      },
      target_source: {
        type: "choice",
        instructions: "Data source internal mana yang paling relevan dengan query pengguna?",
        criteria: sourceChoices,
      },
      is_profiling_query: {
        type: "noul",
        instructions: "Apakah pengguna sedang meminta profil, legalitas, kepemilikan, atau data entitas/perusahaan/PT/CV?",
      },
      requires_internal_data: {
        type: "noul",
        instructions: "Apakah query ini harus dijawab menggunakan sumber data internal perusahaan tanpa mencari ke internet eksternal?",
      },
    };

    const state = {
      user_query: userQuery,
      registered_sources: availableSources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        tables: s.tables,
      })),
    };

    const jevRes = await this.systemOne(state, questions);
    const routeAnswer = jevRes.answers["route"] as JevDecisionChoice;
    const targetSourceAnswer = jevRes.answers["target_source"] as JevDecisionChoice;
    const profilingAnswer = jevRes.answers["is_profiling_query"] as JevDecisionNoul;
    const internalOnlyAnswer = jevRes.answers["requires_internal_data"] as JevDecisionNoul;

    const route = (routeAnswer?.choice as OrchestratorRoute) || "direct";
    const confidence = routeAnswer?.confidence ?? 0.85;
    const targetSourceId = targetSourceAnswer?.choice !== "none" ? targetSourceAnswer?.choice : undefined;
    const isProfilingQuery = (profilingAnswer?.noul ?? 0) >= 0.5;
    const requiresInternalData = (internalOnlyAnswer?.noul ?? 0) >= 0.5;

    let reasoning = `TypeSafe Jev (1.13.0) System One Decision: Routed to ${route} (confidence: ${(confidence * 100).toFixed(0)}%).`;
    if (isProfilingQuery) {
      reasoning += ` Terdeteksi profiling entitas perusahaan internal (p = ${((profilingAnswer?.noul ?? 0) * 100).toFixed(0)}%). Prioritaskan internal data source.`;
    }

    return {
      route,
      confidence,
      reasoning,
      targetSourceId,
      isProfilingQuery,
      requiresInternalData,
      jevResult: jevRes,
    };
  }

  /**
   * 2. External Database Entity Profiling & Table Decision
   */
  async decideDatabaseTable(
    userQuery: string,
    tables: Array<{ name: string; rowCount?: number; columns?: string[] }>,
  ): Promise<{
    selectedTable: string;
    confidence: number;
    searchColumn?: string;
    extractedEntityName?: string;
  }> {
    const tableCriteria: Record<string, string> = {};
    for (const t of tables) {
      tableCriteria[t.name] = `Tabel ${t.name} (kolom: ${(t.columns || []).slice(0, 8).join(", ")})`;
    }
    tableCriteria["none"] = "Tidak ada tabel yang cocok";

    const questions: Record<string, any> = {
      target_table: {
        type: "choice",
        instructions: "Tabel mana dalam database yang paling tepat untuk menjawab query ini?",
        criteria: tableCriteria,
      },
    };

    const state = {
      user_query: userQuery,
      available_tables: tables.map((t) => ({
        name: t.name,
        columns: t.columns,
      })),
    };

    const res = await this.systemOne(state, questions);
    const tableChoice = res.answers["target_table"] as JevDecisionChoice;
    const selectedTable = tableChoice?.choice && tableChoice.choice !== "none" ? tableChoice.choice : tables[0]?.name || "";

    // Extract search entity name using heuristic clean
    let extractedEntityName = userQuery
      .replace(/^(profiling|profil|tolong\s+profiling|cari|carikan|info|data)\s+/i, "")
      .replace(/^(pt|cv|kantor|perusahaan)\s+/i, "")
      .trim();

    return {
      selectedTable,
      confidence: tableChoice?.confidence ?? 0.8,
      extractedEntityName,
    };
  }

  /**
   * 3. RAG Document Re-Ranking & Answerability Verification
   */
  async rerankAndVerifyRag(
    userQuery: string,
    chunks: Array<{ chunkId: string; content: string; sourceName?: string }>,
  ): Promise<{
    topChunkIds: string[];
    isAnswerable: boolean;
    confidence: number;
  }> {
    if (chunks.length === 0) {
      return { topChunkIds: [], isAnswerable: false, confidence: 1.0 };
    }

    const questions: Record<string, any> = {
      is_answerable: {
        type: "noul",
        instructions: "Apakah kumpulan cuplikan dokumen pada state memuat informasi yang cukup untuk menjawab pertanyaan pengguna?",
      },
    };

    // Ask score for each chunk up to 5 chunks
    chunks.slice(0, 5).forEach((c, idx) => {
      questions[`chunk_score_${idx}`] = {
        type: "score",
        instructions: `Seberapa relevan cuplikan dokumen #${idx + 1} dengan pertanyaan pengguna?`,
        criteria: ["Tidak Relevan", "Sedikit Relevan", "Sangat Relevan"],
      };
    });

    const state = {
      user_query: userQuery,
      document_chunks: chunks.slice(0, 5).map((c, idx) => ({
        index: idx,
        id: c.chunkId,
        snippet: c.content.slice(0, 500),
      })),
    };

    const res = await this.systemOne(state, questions);
    const answerable = res.answers["is_answerable"] as JevDecisionNoul;
    const isAnswerable = (answerable?.noul ?? 0.8) >= 0.4;

    // Sort by chunk score
    const scored = chunks.slice(0, 5).map((c, idx) => {
      const scoreAns = res.answers[`chunk_score_${idx}`] as JevDecisionScore;
      return {
        chunkId: c.chunkId,
        score: scoreAns?.score ?? 1.0,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return {
      topChunkIds: scored.map((s) => s.chunkId),
      isAnswerable,
      confidence: answerable ? Math.abs(answerable.noul - 0.5) * 2 : 0.8,
    };
  }

  /**
   * 4. Structured Data / Excel Metric Decision
   */
  async decideStructuredMetric(
    userQuery: string,
    availableMetrics: string[],
    availableDimensions: string[],
  ): Promise<{
    metric: string;
    aggregation: "sum" | "avg" | "count" | "min" | "max";
    groupBy?: string;
  }> {
    const metricCriteria: Record<string, string> = {};
    availableMetrics.forEach((m) => {
      metricCriteria[m] = `Metric: ${m}`;
    });
    metricCriteria["count_all"] = "Hitung jumlah baris / frekuensi data";

    const dimCriteria: Record<string, string> = {};
    availableDimensions.forEach((d) => {
      dimCriteria[d] = `Dimensi / Kategori: ${d}`;
    });
    dimCriteria["none"] = "Tidak perlu pengelompokan / agregasi global";

    const questions: Record<string, any> = {
      target_metric: {
        type: "choice",
        instructions: "Kolom metrik angka mana yang paling tepat untuk dihitung?",
        criteria: metricCriteria,
      },
      aggregation_function: {
        type: "choice",
        instructions: "Fungsi agregasi mana yang dimaksud pengguna?",
        criteria: {
          sum: "SUM: Total, jumlah akumulasi nilai, total omzet/biaya",
          avg: "AVG: Rata-rata, mean",
          count: "COUNT: Hitung jumlah transaksi/item",
          max: "MAX: Tertinggi, maksimal",
          min: "MIN: Terendah, minimal",
        },
      },
      group_by: {
        type: "choice",
        instructions: "Berdasarkan kategori/dimensi mana data perlu dikelompokkan?",
        criteria: dimCriteria,
      },
    };

    const state = {
      user_query: userQuery,
      metrics: availableMetrics,
      dimensions: availableDimensions,
    };

    const res = await this.systemOne(state, questions);
    const metricChoice = res.answers["target_metric"] as JevDecisionChoice;
    const aggChoice = res.answers["aggregation_function"] as JevDecisionChoice;
    const groupChoice = res.answers["group_by"] as JevDecisionChoice;

    return {
      metric: metricChoice?.choice && metricChoice.choice !== "count_all" ? metricChoice.choice : availableMetrics[0] || "count",
      aggregation: (aggChoice?.choice as any) || "sum",
      groupBy: groupChoice?.choice && groupChoice.choice !== "none" ? groupChoice.choice : undefined,
    };
  }

  /**
   * Deterministic Fallback in case network or API is unavailable
   */
  private fallbackDecision(state: any, questions: Record<string, any>): JevDecisionResult {
    const answers: Record<string, JevDecisionAnswer> = {};
    const query = String(state?.user_query || "").toLowerCase();

    for (const [key, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        const isInternal = query.includes("pt") || query.includes("perusahaan") || query.includes("profil");
        answers[key] = {
          type: "noul",
          noul: isInternal ? 0.9 : 0.5,
        };
      } else if (q.type === "score") {
        answers[key] = {
          type: "score",
          score: 2.0,
          confidence: 0.7,
          legend: { "0": "Rendah", "1": "Sedang", "2": "Tinggi" },
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
        };
      } else if (q.type === "choice") {
        const options = Object.keys(q.criteria || {});
        let selected = options[0] || "other";
        if (key === "route") {
          if (query.includes("profil") || query.includes("pt") || query.includes("perseroan") || query.includes("tabel") || query.includes("sales")) {
            selected = "data_agent";
          } else if (query.includes("sop") || query.includes("sla") || query.includes("kebijakan")) {
            selected = "knowledge_agent";
          }
        }
        answers[key] = {
          type: "choice",
          choice: selected,
          confidence: 0.8,
          probabilities: { [selected]: 0.8 },
        };
      }
    }

    return {
      model: "fallback-deterministic",
      answers,
      latencyMs: 1,
    };
  }
}
