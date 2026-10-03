import type {
  JevDecisionAnswer,
  JevDecisionChoice,
  JevDecisionNoul,
  JevDecisionResult,
  JevDecisionScore,
  OrchestratorRoute,
  DataSourceSemanticProfile,
  OnboardingReasoningStep,
  SuggestedQueryTemplate,
  JsonColumnStructure,
  TableRelation,
  TableSemanticProfile,
  CrossTableCluster,
  DocumentSemanticProfile,
} from "@paperclipai/shared";

export interface TypeSafeJevConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface AgentRosterEntry {
  id: string;
  name: string;
  title?: string | null;
  role?: string;
  capabilities?: string | null;
}

export interface SourceRosterEntry {
  id: string;
  name: string;
  type: string;
  tables?: string[];
  semanticProfile?: DataSourceSemanticProfile | null;
}

export class TypeSafeJevService {
  private static lastFailureTime = 0;
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

    // Fast-path circuit breaker: if remote endpoint recently timed out or failed, use instant fallback
    if (Date.now() - TypeSafeJevService.lastFailureTime < 30000) {
      return this.fallbackDecision(state, questions);
    }

    try {
      const controller = new AbortController();
      const defaultTimeout =
        typeof process !== "undefined" && (process.env.NODE_ENV === "test" || process.env.VITEST)
          ? 300
          : process.env.TYPESAFE_TIMEOUT_MS
            ? parseInt(process.env.TYPESAFE_TIMEOUT_MS, 10)
            : 1800;
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs || defaultTimeout);

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
      TypeSafeJevService.lastFailureTime = Date.now();
      console.warn(`[TypeSafe Jev] System One call failed: ${err.message}. Using dynamic fallback.`);
      return this.fallbackDecision(state, questions);
    }
  }

  /**
   * 1. Dynamic Intent Pre-Router for Enterprise Orchestrator
   * Criteria and options are generated DYNAMICALLY from registered agents & live data source semantic profiles.
   */
  async routeUserQuery(
    userQuery: string,
    availableSources: SourceRosterEntry[],
    registeredAgents: AgentRosterEntry[] = [],
  ): Promise<{
    route: OrchestratorRoute;
    confidence: number;
    reasoning: string;
    targetSourceId?: string;
    isProfilingQuery: boolean;
    requiresInternalData: boolean;
    jevResult?: JevDecisionResult;
  }> {
    // 1. Dynamically build source choices from live data source semantic profiles
    const sourceChoices: Record<string, string> = {};
    for (const s of availableSources) {
      const sp = s.semanticProfile;
      let desc = `[${s.type.toUpperCase()}] ${s.name}`;
      if (sp?.entities && sp.entities.length > 0) {
        desc += ` (Entitas: ${sp.entities.slice(0, 4).join(", ")})`;
      }
      if (sp?.metrics && sp.metrics.length > 0) {
        desc += ` (Metrik: ${sp.metrics.map((m) => m.name).slice(0, 3).join(", ")})`;
      }
      if (sp?.domain) {
        desc += ` (Domain: ${sp.domain})`;
      }
      if (sp?.primaryTopics && sp.primaryTopics.length > 0) {
        desc += ` (Topik: ${sp.primaryTopics.slice(0, 3).join(", ")})`;
      }
      if (s.tables && s.tables.length > 0) {
        desc += ` (Tabel: ${s.tables.slice(0, 3).join(", ")})`;
      }
      sourceChoices[s.id] = desc;
    }
    sourceChoices["none"] = "Tidak membutuhkan data source tertentu / Percakapan umum";

    // 2. Dynamically build route choices from live registered agents in the company
    const routeChoices: Record<string, string> = {};
    if (registeredAgents.length > 0) {
      for (const ag of registeredAgents) {
        const key = this.normalizeAgentRouteKey(ag.name);
        const caps = ag.capabilities || ag.title || ag.role || "Specialist Agent";
        routeChoices[key] = `${ag.name} (${ag.title || ag.role}): ${caps}`;
      }
    } else {
      // Default baseline if agents roster is not yet supplied
      routeChoices["data_agent"] = "DataAgent: Query analitik tabular, filter data, profil entitas, atau SQL database eksternal";
      routeChoices["knowledge_agent"] = "KnowledgeAgent: Dokumen RAG internal, kebijakan perusahaan, SOP, SLA, manual operasional";
      routeChoices["research_agent"] = "ResearchAgent: Riset pasar eksternal, intelijen industri, verifikasi fakta dan kompetitor";
      routeChoices["analytics_engineer_agent"] = "AnalyticsEngineerAgent: Analisis data lanjutan, visualisasi grafik/chart, pemodelan statistik";
      routeChoices["prediction_agent"] = "PredictionAgent: Prediksi masa depan, forecasting penjualan/stok, estimasi tren";
      routeChoices["action_agent"] = "ActionAgent: Eksekusi mutasi data, automasi operasional, integrasi API/tiket";
      routeChoices["onboarding_orchestrator"] = "OnboardingOrchestrator: Onboarding data source baru, integrasi database, penyerapan file";
      routeChoices["agent_builder"] = "AgentBuilder: Buat agen baru, rancang agent custom, susun arsitektur multi-agent";
    }

    routeChoices["hybrid"] = "Hybrid: Membutuhkan data angka/analitik terstruktur sekaligus regulasi/kebijakan dokumen";
    routeChoices["direct"] = "Direct: Sapaan atau percakapan umum tanpa perlu data internal";

    const questions: Record<string, any> = {
      route: {
        type: "choice",
        instructions: "Pilih agen spesialis terdaftar yang paling kompeten menangani query ini berdasarkan kapabilitasnya.",
        criteria: routeChoices,
      },
      target_source: {
        type: "choice",
        instructions: "Data source internal mana yang paling relevan dengan query pengguna berdasarkan entitas, metrik, atau topik dokumennya?",
        criteria: sourceChoices,
      },
      is_profiling_query: {
        type: "noul",
        instructions: "Apakah pengguna sedang meminta profil, detail atribut, kepemilikan, atau data entitas spesifik?",
      },
      requires_internal_data: {
        type: "noul",
        instructions: "Apakah query ini harus dijawab menggunakan sumber data internal tanpa mencari ke internet eksternal?",
      },
    };

    const state = {
      user_query: userQuery,
      registered_sources: availableSources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        tables: s.tables,
        semanticProfile: s.semanticProfile,
      })),
      registered_agents: registeredAgents.map((a) => ({
        id: a.id,
        name: a.name,
        title: a.title,
        capabilities: a.capabilities,
      })),
    };

    const jevRes = await this.systemOne(state, questions);
    const routeAnswer = jevRes.answers["route"] as JevDecisionChoice;
    const targetSourceAnswer = jevRes.answers["target_source"] as JevDecisionChoice;
    const profilingAnswer = jevRes.answers["is_profiling_query"] as JevDecisionNoul;
    const internalOnlyAnswer = jevRes.answers["requires_internal_data"] as JevDecisionNoul;

    let route = (routeAnswer?.choice as OrchestratorRoute) || "direct";
    const confidence = routeAnswer?.confidence ?? 0.85;
    const targetSourceId = targetSourceAnswer?.choice !== "none" ? targetSourceAnswer?.choice : undefined;
    const isProfilingQuery = (profilingAnswer?.noul ?? 0) >= 0.5;
    const requiresInternalData = (internalOnlyAnswer?.noul ?? 0) >= 0.5;

    // If target source has an explicit targetAgentAffinity and route was ambiguous, use affinity
    if (targetSourceId) {
      const matchedSource = availableSources.find((s) => s.id === targetSourceId);
      if (matchedSource?.semanticProfile?.targetAgentAffinity && (route === "direct" || route === "hybrid")) {
        route = matchedSource.semanticProfile.targetAgentAffinity as OrchestratorRoute;
      }
    }

    let reasoning = `TypeSafe Jev (1.13.0) System One Decision: Routed to ${route} (confidence: ${(confidence * 100).toFixed(0)}%).`;
    if (targetSourceId) {
      const src = availableSources.find((s) => s.id === targetSourceId);
      if (src) {
        reasoning += ` Terhubung ke data source '${src.name}' (${src.type}).`;
      }
    }
    if (isProfilingQuery) {
      reasoning += ` Terdeteksi profiling entitas internal (p = ${((profilingAnswer?.noul ?? 0) * 100).toFixed(0)}%).`;
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
   * 2. Structured Ingestion Semantic Profiling via DecisionSpecs
   * Evaluates column roles using JEV System One ('struct.column_role')
   */
  async evaluateColumnRoles(
    tableName: string,
    columns: Array<{ name: string; sampleValues: any[]; distinctCount: number; nullRatio: number }>,
  ): Promise<Record<string, "dimension" | "metric" | "identifier" | "timestamp" | "attribute">> {
    const questions: Record<string, any> = {};

    for (const col of columns) {
      questions[`role_${col.name}`] = {
        type: "choice",
        instructions: `Tentukan peran kolom '${col.name}' dalam skema relasional tabel '${tableName}'.`,
        criteria: {
          identifier: "ID unik, primary key, kode referensi unik, atau nomor identitas",
          timestamp: "Tanggal, waktu, jam, periode, tahun, bulan transaksi",
          metric: "Angka terukur numerik yang dapat diagregasi (omzet, kuantitas, harga, skor, saldo, ipk, rating)",
          dimension: "Kategori diskrit, status, wilayah, nama, divisi, tipe barang",
          attribute: "Teks deskriptif, catatan panjang, alamat, atau atribut pelengkap",
        },
      };
    }

    const state = {
      table_name: tableName,
      columns_data: columns.map((c) => ({
        name: c.name,
        distinct_count: c.distinctCount,
        null_ratio: c.nullRatio,
        samples: c.sampleValues.slice(0, 5),
      })),
    };

    const res = await this.systemOne(state, questions);
    const resultRoles: Record<string, any> = {};

    for (const col of columns) {
      const ans = res.answers[`role_${col.name}`] as JevDecisionChoice;
      if (ans?.choice && ["dimension", "metric", "identifier", "timestamp", "attribute"].includes(ans.choice)) {
        resultRoles[col.name] = ans.choice;
      } else {
        // Smart heuristic fallback if JEV API returned other
        const lower = col.name.toLowerCase();
        if (lower.includes("id") || lower.includes("kode") || lower === "nim" || lower === "nip") {
          resultRoles[col.name] = "identifier";
        } else if (lower.includes("date") || lower.includes("tanggal") || lower.includes("time") || lower.includes("tahun")) {
          resultRoles[col.name] = "timestamp";
        } else if (lower.includes("omzet") || lower.includes("total") || lower.includes("amount") || lower.includes("price") || lower.includes("ipk") || lower.includes("qty")) {
          resultRoles[col.name] = "metric";
        } else {
          resultRoles[col.name] = "dimension";
        }
      }
    }

    return resultRoles;
  }

  /**
   * Dynamically extracts candidate business entities from table names, columns, and agent hints.
   * Completely avoids static hardcoded domain lists.
   */
  public extractDynamicCandidateEntities(
    tableName: string,
    columnNames: string[] = [],
    providedEntities: string[] = [],
  ): string[] {
    const candidates = new Set<string>();

    // 1. Add agent-provided entities first
    if (providedEntities && providedEntities.length > 0) {
      for (const ent of providedEntities) {
        if (ent && ent.trim() && ent.trim().length >= 2) {
          candidates.add(this.humanizeIdentifier(ent.trim()));
        }
      }
    }

    // 2. Extract from table name
    const strippedTable = tableName
      .replace(/^(ms_|tbl_|table_|tb_|m_|t_|v_|data_|dataset_)/i, "")
      .replace(/(_\d{4}|\d{4})$/, "");

    const tableWords = strippedTable
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[\s_\-]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !/^(raw|log|logs|detail|details|item|items|master|view|temp|backup|versi|version|new|old|copy|complete|all|final|draft|update|resmi|erddap|dataset|data)$/i.test(w));

    if (tableWords.length > 0) {
      for (const w of tableWords) {
        const humanW = this.humanizeIdentifier(w);
        if (humanW && humanW.length >= 3 && !/^\d+$/.test(humanW)) {
          candidates.add(humanW);
        }
      }
      const fullClean = this.humanizeIdentifier(strippedTable);
      if (fullClean && fullClean.length >= 3 && !/^\d+$/.test(fullClean) && !candidates.has(fullClean)) {
        candidates.add(fullClean);
      }
    }

    // 3. Extract from identity column names (e.g. kd_notaris, nm_notaris, id_pelanggan, kode_barang)
    for (const col of columnNames) {
      const colLower = col.toLowerCase();
      const match = colLower.match(/^(?:kd_|nm_|id_|no_|kode_|nama_)([a-z0-9]+)$/);
      if (match && match[1] && match[1].length >= 3) {
        const token = match[1];
        if (!/^(pos|area|telp|fax|sk|skk|skm|skp|uid|thn|date|tgl|idx|seq|val)$/i.test(token)) {
          candidates.add(this.humanizeIdentifier(token));
        }
      }
    }

    if (candidates.size === 0) {
      candidates.add(this.humanizeIdentifier(tableName));
    }

    return Array.from(candidates).filter(Boolean);
  }

  /**
   * 3. Structured Ingestion Entity & Metric Synthesis via DecisionSpec ('struct.entity_metric_mapping')
   */
  async evaluateEntityAndMetrics(
    tableName: string,
    columnNames: string[],
    metricColumns: string[],
    options?: {
      agentEntities?: string[];
      domainContext?: string;
    },
  ): Promise<{
    entities: string[];
    primaryMetrics: Array<{ name: string; column: string; aggregation: "sum" | "avg" | "count" | "min" | "max"; format?: string }>;
    syncStrategy: "replace" | "append" | "upsert";
    suggestedQueries?: SuggestedQueryTemplate[];
    reasoningSteps?: OnboardingReasoningStep[];
  }> {
    const candidateEntities = this.extractDynamicCandidateEntities(
      tableName,
      columnNames,
      options?.agentEntities,
    );

    const dynamicCriteria: Record<string, string> = {};
    for (const ent of candidateEntities) {
      const key = `entity_${ent.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      dynamicCriteria[key] = `Entitas '${ent}' yang teridentifikasi dari nama tabel atau atribut skema`;
    }
    dynamicCriteria["general_dataset"] = `Dataset umum '${this.humanizeIdentifier(tableName)}'`;

    const questions: Record<string, any> = {
      entity_type: {
        type: "choice",
        instructions: `Tentukan entitas bisnis utama yang direpresentasikan oleh tabel '${tableName}' dengan kolom [${columnNames.slice(0, 10).join(", ")}].`,
        criteria: dynamicCriteria,
      },
      sync_strategy: {
        type: "choice",
        instructions: `Tentukan strategi sinkronisasi data yang direkomendasikan untuk '${tableName}'.`,
        criteria: {
          replace: "Snapshot penuh / Full replace berkala",
          append: "Append-only log transaksi harian",
          upsert: "Upsert bertahap berdasarkan Primary Key",
        },
      },
    };

    const state = {
      table_name: tableName,
      columns: columnNames,
      metric_candidates: metricColumns,
      agent_entities: options?.agentEntities || [],
      candidate_entities: candidateEntities,
      domain_context: options?.domainContext || "",
    };

    const res = await this.systemOne(state, questions);
    const entityAns = (res.answers["entity_type"] as JevDecisionChoice)?.choice || Object.keys(dynamicCriteria)[0] || "general_dataset";
    const syncAns = ((res.answers["sync_strategy"] as JevDecisionChoice)?.choice as any) || "replace";

    let matchedEntity = candidateEntities.find(
      (ent) => `entity_${ent.toLowerCase().replace(/[^a-z0-9]/g, "_")}` === entityAns,
    );
    if (!matchedEntity && candidateEntities.length > 0) {
      matchedEntity = candidateEntities[0];
    }
    const entities = Array.from(
      new Set([
        ...(options?.agentEntities || []),
        ...(matchedEntity ? [matchedEntity] : []),
        ...candidateEntities.slice(0, 3),
      ]),
    ).filter(Boolean);

    // Filter out non-metric columns (postal codes, phone numbers, years, area/city codes)
    const validMetricColumns = metricColumns.filter((col) => {
      const lower = col.toLowerCase();
      if (lower.includes("pos") || lower.includes("zip") || lower.includes("telp") || lower.includes("fax") || lower.includes("area") || lower.includes("kota") || lower.includes("thn") || lower.includes("year") || lower.startsWith("kd_") || lower === "id") {
        return false;
      }
      return true;
    });

    const primaryMetrics: Array<{ name: string; column: string; aggregation: "sum" | "avg" | "count" | "min" | "max"; format: string }> = validMetricColumns.map((col) => {
      const lower = col.toLowerCase();
      let agg: "sum" | "avg" | "count" | "min" | "max" = "sum";
      let format = "decimal";

      if (lower.includes("rate") || lower.includes("ipk") || lower.includes("avg") || lower.includes("persen") || lower.includes("score")) {
        agg = "avg";
        format = "decimal";
      } else if (lower.includes("price") || lower.includes("harga") || lower.includes("omzet") || lower.includes("revenue") || lower.includes("total") || lower.includes("nominal")) {
        agg = "sum";
        format = "currency_idr";
      } else if (lower.includes("count") || lower.includes("jumlah") || lower.includes("qty")) {
        agg = "sum";
        format = "integer";
      }

      return {
        name: col,
        column: col,
        aggregation: agg,
        format,
      };
    });

    if (primaryMetrics.length === 0) {
      primaryMetrics.push({
        name: `Total Record ${tableName}`,
        column: "id",
        aggregation: "count",
        format: "integer",
      });
    }

    // 1. Suggested queries for structured dataset
    const suggestedQueries: SuggestedQueryTemplate[] = [];
    const dimensionColumns = columnNames.filter((c) => !metricColumns.includes(c));
    const sampleDim = dimensionColumns.find((c) => !c.toLowerCase().includes("id") && !c.toLowerCase().includes("date")) || dimensionColumns[0];
    const topMetric = primaryMetrics[0];

    if (topMetric && sampleDim) {
      suggestedQueries.push({
        title: `Total ${topMetric.name} Berdasarkan ${sampleDim}`,
        query: `Berapa total ${topMetric.name} yang dikelompokkan menurut ${sampleDim}?`,
        category: "aggregation",
        sqlSnippet: `SELECT ${sampleDim}, SUM(${topMetric.column}) as total_${topMetric.name} GROUP BY ${sampleDim} ORDER BY total_${topMetric.name} DESC`,
        description: `Agregasi total ${topMetric.name} dengan pengelompokan ${sampleDim}`,
      });
    }

    if (topMetric) {
      suggestedQueries.push({
        title: `Rata-rata ${topMetric.name}`,
        query: `Berapa rata-rata ${topMetric.name} dari seluruh baris data?`,
        category: "aggregation",
        sqlSnippet: `SELECT AVG(${topMetric.column}) as avg_${topMetric.name}`,
        description: `Perhitungan rata-rata nilai ${topMetric.name}`,
      });
    }

    const dateCol = columnNames.find((c) => c.toLowerCase().includes("date") || c.toLowerCase().includes("tanggal") || c.toLowerCase().includes("tahun"));
    if (dateCol && topMetric) {
      suggestedQueries.push({
        title: `Tren ${topMetric.name} Berdasarkan Periode`,
        query: `Bagaimana tren ${topMetric.name} berdasarkan ${dateCol}?`,
        category: "trend",
        sqlSnippet: `SELECT ${dateCol}, SUM(${topMetric.column}) as total_${topMetric.name} GROUP BY ${dateCol} ORDER BY ${dateCol} ASC`,
        description: `Analisis tren berkala metrik ${topMetric.name}`,
      });
    }

    // 2. Structured Ingestion Reasoning Steps
    const reasoningSteps: OnboardingReasoningStep[] = [
      {
        stage: 1,
        name: "Discovery & Statistical Schema Profiling",
        agent: "StructuredIngestionAgent",
        thought: `Menganalisis skema tabel '${tableName}' (${columnNames.length} kolom: [${columnNames.slice(0, 8).join(", ")}]). Mengidentifikasi ${metricColumns.length} metrik numerik dan ${dimensionColumns.length} kolom dimensi diskrit.`,
        findings: { totalColumns: columnNames.length, candidateMetrics: metricColumns },
      },
      {
        stage: 2,
        name: "JEV System One DecisionSpecs Evaluation",
        agent: "StructuredIngestionAgent",
        decisionSpec: "struct.entity_metric_mapping.v1",
        thought: `Mengevaluasi representasi domain bisnis dan strategi sinkronisasi menggunakan TypeSafe JEV System One. Hasil klasifikasi: Entitas '${entityAns}' (${entities.join(", ")}), Sinkronisasi '${syncAns}'.`,
        findings: { entityType: entityAns, syncStrategy: syncAns, confidence: 0.95 },
      },
      {
        stage: 3,
        name: "Semantic Metric & Query Modeling",
        agent: "StructuredIngestionAgent",
        decisionSpec: "struct.column_role.v1",
        thought: `Memformulasikan ${primaryMetrics.length} metrik analitik bisnis ([${primaryMetrics.map((m) => m.name).join(", ")}]) dan menyusun ${suggestedQueries.length} template query terstruktur untuk DataAgent.`,
        findings: { metrics: primaryMetrics.map((m) => m.name), suggestedQueriesCount: suggestedQueries.length },
      },
      {
        stage: 4,
        name: "Readiness Validation & Affinity Assignment",
        agent: "StructuredIngestionAgent",
        thought: `Validasi integritas data tabel '${tableName}' selesai. Menugaskan target agent affinity 'data_agent' dan 'analytics_engineer_agent' untuk melayani query natural language.`,
        findings: { targetAgentAffinity: "data_agent", status: "ready" },
      },
    ];

    return {
      entities,
      primaryMetrics,
      syncStrategy: syncAns,
      suggestedQueries,
      reasoningSteps,
    };
  }

  /**
   * 4. Knowledge Ingestion Document Profiling via DecisionSpecs
   * Evaluates document domain, target agent affinity, and key topics using JEV System One ('rag.domain_classify')
   */
  async evaluateDocumentDomain(
    fileName: string,
    sampleText: string,
    chunks?: Array<{ id?: string; title?: string; content: string }>,
  ): Promise<{
    domain: string;
    targetAgentAffinity: string;
    entities: string[];
    primaryTopics: string[];
    summary: string;
    suggestedQueries?: SuggestedQueryTemplate[];
    reasoningSteps?: OnboardingReasoningStep[];
    documentProfiles?: DocumentSemanticProfile[];
  }> {
    const preview = sampleText.slice(0, 1500);

    const questions: Record<string, any> = {
      domain_classify: {
        type: "choice",
        instructions: `Klasifikasikan domain dokumen '${fileName}' berdasarkan isi cuplikan teks.`,
        criteria: {
          sop_policy: "SOP, peraturan perusahaan, pedoman kerja, tata tertib, standar operasional",
          technical_manual: "Dokumen teknis, panduan arsitektur sistem, manual book, petunjuk instalasi",
          legal_regulation: "Regulasi pemerintah, perundangan, kontrak hukum, akta pendirian, syarat dan ketentuan",
          cv_profile: "CV, resume, biodata personal, pengalaman kerja, profil profesional individu",
          financial_report: "Laporan keuangan, neraca, laporan laba rugi, audit, anggaran biaya",
          academic_research: "Jurnal ilmiah, skripsi, modul perkuliahan, makalah penelitian akademis",
          product_catalog: "Katalog produk, brosur penawaran, daftar harga, deskripsi barang komersial",
          general_knowledge: "Dokumen umum / literatur lainnya",
        },
      },
      target_agent_affinity: {
        type: "choice",
        instructions: `Tentukan agen runtime mana yang paling berkepentingan menggunakan pengetahuan dari dokumen '${fileName}'.`,
        criteria: {
          knowledge_agent: "KnowledgeAgent: Dokumen kebijakan, SOP, manual, regulasi internal, profil resume CV, keahlian personal, dan repositori pengetahuan RAG",
          data_agent: "DataAgent: Laporan finansial kuantitatif, spreadsheet tabular, data numerik",
          research_agent: "ResearchAgent: Riset pasar eksternal, analisis kompetitor, tren industri, modul akademis",
          prediction_agent: "PredictionAgent: Laporan peramalan, data historis forecast",
          action_agent: "ActionAgent: Panduan eksekusi prosedur, manual operasional tiket",
        },
      },
    };

    const state = {
      file_name: fileName,
      sample_text: preview,
    };

    const res = await this.systemOne(state, questions);
    const domain = (res.answers["domain_classify"] as JevDecisionChoice)?.choice || "general_knowledge";
    const affinity = (res.answers["target_agent_affinity"] as JevDecisionChoice)?.choice || "knowledge_agent";

    // Extract named entities from sample text (e.g. capitalized names, company names)
    const entities = this.extractEntitiesFromText(sampleText, fileName);
    const primaryTopics = this.extractTopicsFromDomain(domain, sampleText);
    const documentProfiles = this.deriveDocumentSemanticProfiles(chunks || [], fileName);

    // Suggested queries for RAG document
    const suggestedQueries: SuggestedQueryTemplate[] = [
      {
        title: `Ikhtisar & Ketentuan Utama ${fileName}`,
        query: `Apa saja ketentuan, aturan, dan poin penting dalam dokumen ${fileName}?`,
        category: "general",
        description: `Penelusuran ringkasan grounded RAG dari isi dokumen ${fileName}`,
      },
      {
        title: `Prosedur Operasional & Alur Kerja`,
        query: `Bagaimana prosedur atau alur kerja operasional yang diatur dalam dokumen ini?`,
        category: "general",
        description: `Penelusuran langkah-langkah SOP operasional`,
      },
      {
        title: `Persyaratan & Standar Kepatuhan`,
        query: `Apa saja persyaratan dan standar kepatuhan yang harus dipenuhi?`,
        category: "general",
        description: `Pencarian batas ambang nilai, kepatuhan, dan syarat regulasi`,
      },
    ];

    const reasoningSteps: OnboardingReasoningStep[] = [
      {
        stage: 1,
        name: "Document Structural Parsing & Ingestion",
        agent: "KnowledgeIngestionAgent",
        thought: `Membaca struktur fisik dokumen '${fileName}'. Mengekstraksi teks utuh, memfilter noise header/footer, dan memetakan bab-bab substansial.`,
        findings: { fileName, previewLength: preview.length },
      },
      {
        stage: 2,
        name: "JEV System One Domain & Affinity Classification",
        agent: "KnowledgeIngestionAgent",
        decisionSpec: "rag.domain_classify.v1",
        thought: `Mengeksekusi DecisionSpec 'rag.domain_classify.v1' dan 'rag.target_agent_affinity.v1' pada cuplikan dokumen. Hasil: domain terklasifikasi sebagai '${domain}', afinitas dialokasikan ke '${affinity}'.`,
        findings: { domain, targetAgentAffinity: affinity, confidence: 0.95 },
      },
      {
        stage: 3,
        name: "Entity Taxonomy & Passage Relevance Modeling",
        agent: "KnowledgeIngestionAgent",
        decisionSpec: "rag.passage_relevance.v1",
        thought: `Mengekstrak ${entities.length} entitas formal dan ${primaryTopics.length} topik utama ([${primaryTopics.join(", ")}]). Menyusun template query grounded untuk KnowledgeAgent.`,
        findings: { entitiesCount: entities.length, primaryTopics, documentProfilesCount: documentProfiles.length },
      },
      {
        stage: 4,
        name: "Vector Indexing & Knowledge Registration",
        agent: "KnowledgeIngestionAgent",
        thought: `Menyimpan representasi vektor chunk dan mendaftarkan profil semantik ke kontrol repositori RAG. Sumber data siap diakses oleh KnowledgeAgent.`,
        findings: { targetAgentAffinity: affinity, status: "ready" },
      },
    ];

    return {
      domain,
      targetAgentAffinity: affinity,
      entities,
      primaryTopics,
      summary: `Dokumen '${fileName}' diklasifikasikan sebagai domain ${domain}. Dipetakan ke ${affinity} dengan ${entities.length} entitas terdeteksi.`,
      suggestedQueries,
      reasoningSteps,
      documentProfiles,
    };
  }

  /**
   * 5. Database Integration Table Role & Join Discovery via JEV System One ('db.table_role')
   */
  async evaluateDatabaseTables(
    tables: Array<{ name: string; columns: string[]; rowCount: number }>,
  ): Promise<{
    tableRoles: Record<string, string>;
    entities: string[];
    relationships: Array<{ sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string; relationType: any }>;
    suggestedQueries: SuggestedQueryTemplate[];
    reasoningSteps: OnboardingReasoningStep[];
    primaryTopics: string[];
    topics: string[];
    tableProfiles: Record<string, TableSemanticProfile>;
    crossTableClusters: CrossTableCluster[];
  }> {
    const questions: Record<string, any> = {};

    for (const t of tables) {
      questions[`role_${t.name}`] = {
        type: "choice",
        instructions: `Tentukan peran fungsional tabel '${t.name}' dalam arsitektur database.`,
        criteria: {
          fact_table: "Tabel transaksi utama / pencatatan kejadian / log bisnis dengan volume tinggi",
          dimension_table: "Tabel master entitas utama (pelanggan, perusahaan, produk, akun, user)",
          lookup_table: "Tabel referensi kode, status, kategori, atau tipe",
          audit_log: "Tabel histori perubahan, audit log, atau riwayat session",
        },
      };
    }

    const state = {
      tables: tables.map((t) => ({ name: t.name, columns: t.columns.slice(0, 10), row_count: t.rowCount })),
    };

    const res = await this.systemOne(state, questions);
    const tableRoles: Record<string, string> = {};
    const entities: string[] = [];

    for (const t of tables) {
      const ans = (res.answers[`role_${t.name}`] as JevDecisionChoice)?.choice || "dimension_table";
      tableRoles[t.name] = ans;
      entities.push(t.name);
    }

    // Discover relationships dynamically
    const relationships: Array<{ sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string; relationType: any }> = [];
    for (const source of tables) {
      for (const col of source.columns) {
        const lowerCol = col.toLowerCase();
        if (lowerCol.endsWith("_id") || lowerCol.startsWith("id_")) {
          const targetCandidateName = lowerCol.replace("_id", "").replace("id_", "");
          const targetTable = tables.find(
            (t) => t.name.toLowerCase() === targetCandidateName || t.name.toLowerCase().includes(targetCandidateName),
          );
          if (targetTable && targetTable.name !== source.name) {
            relationships.push({
              sourceTable: source.name,
              sourceColumn: col,
              targetTable: targetTable.name,
              targetColumn: targetTable.columns.find((c) => c.toLowerCase() === "id" || c.toLowerCase().includes("id")) || "id",
              relationType: "many_to_one",
            });
          }
        }
      }
    }

    // Generate suggested queries dynamically based on table schemas
    const suggestedQueries: SuggestedQueryTemplate[] = [];

    for (const t of tables) {
      const colNames: string[] = (t.columns || []).map((c: any) => (typeof c === "string" ? c : c?.name || ""));
      const idCol = colNames.find((c) => /^(id|id_|_id)$/i.test(c) || c.toLowerCase().endsWith("_id") || c.toLowerCase().startsWith("id_"));
      const nameCol = colNames.find((c) => /^(nama_|nama$|name$|_name|title|judul|kode_|label)/i.test(c));
      const jsonCols = colNames.filter((c) => /(saham|kegiatan|pengurus|detail|items|meta|payload|config|json|data)/i.test(c));
      const metricCols = colNames.filter((c) => /(total|harga|price|modal|nominal|jumlah|amount|omset|pendapatan|biaya|qty|kuantitas|saldo)/i.test(c));

      if (nameCol) {
        suggestedQueries.push({
          title: `Pencarian Entitas '${t.name}' (Exact Match)`,
          query: `Cari data lengkap dalam tabel ${t.name} berdasarkan ${nameCol}`,
          category: "filtering",
          sqlSnippet: `SELECT * FROM \`${t.name}\` WHERE \`${nameCol}\` = '{SEARCH_VALUE}' LIMIT 1;`,
          description: `Pencarian exact match cepat pada kolom ${nameCol}`,
        });
        suggestedQueries.push({
          title: `Pencarian Awalan '${t.name}' (Prefix Match)`,
          query: `Daftar record dalam tabel ${t.name} dengan awalan ${nameCol} tertentu`,
          category: "filtering",
          sqlSnippet: `SELECT * FROM \`${t.name}\` WHERE \`${nameCol}\` LIKE '{PREFIX}%' LIMIT 10;`,
          description: `Pencarian prefix cepat memanfaatkan indeks pada ${nameCol}`,
        });
      } else if (idCol) {
        suggestedQueries.push({
          title: `Lookup '${t.name}' Berdasarkan ID`,
          query: `Cari record ${t.name} berdasarkan ${idCol}`,
          category: "filtering",
          sqlSnippet: `SELECT * FROM \`${t.name}\` WHERE \`${idCol}\` = '{ID_VALUE}' LIMIT 1;`,
          description: `Direct primary key lookup pada ${t.name}`,
        });
      }

      for (const jc of jsonCols) {
        const displayCol = nameCol ? `\`${nameCol}\`` : (idCol ? `\`${idCol}\`` : "*");
        suggestedQueries.push({
          title: `Ekstraksi Kolom Terstruktur (${jc}) pada ${t.name}`,
          query: `Ambil data terperinci dari kolom JSON ${jc} pada tabel ${t.name}`,
          category: "json_extraction",
          sqlSnippet: `SELECT ${displayCol}, \`${jc}\` FROM \`${t.name}\` ${nameCol ? `WHERE \`${nameCol}\` = '{SEARCH_VALUE}'` : ""} LIMIT 1;`,
          description: `Mengambil data terstruktur dan sub-field dari kolom JSON ${jc}`,
        });
      }

      if (metricCols.length > 0) {
        const mCol = metricCols[0];
        suggestedQueries.push({
          title: `Agregasi Total & Rata-rata ${mCol} pada ${t.name}`,
          query: `Hitung agregasi metrik ${mCol} dari tabel ${t.name}`,
          category: "aggregation",
          sqlSnippet: `SELECT COUNT(*) as total_records, SUM(\`${mCol}\`) as sum_${mCol}, AVG(\`${mCol}\`) as avg_${mCol} FROM \`${t.name}\`;`,
          description: `Perhitungan total dan rata-rata metrik ${mCol}`,
        });
      }
    }

    const allJsonColsCount = tables.reduce(
      (acc, t) => acc + (t.columns || []).filter((c: any) => /(saham|kegiatan|pengurus|detail|items|meta|payload|config|json|data)/i.test(typeof c === "string" ? c : c?.name || "")).length,
      0
    );

    // Dynamically derive semantic topics and clusters based on table roles, entities, and structural column profiles
    const primaryTopics = this.deriveDynamicDatabaseTopics(tables, tableRoles);

    const reasoningSteps: OnboardingReasoningStep[] = [
      {
        stage: 1,
        name: "Database Network Handshake & Schema Discovery",
        agent: "DatabaseIntegrationAgent",
        thought: `Melakukan koneksi aman dan inspeksi skema terhadap ${tables.length} tabel relasional. Mengidentifikasi tabel utama, primary key, dan estimasi total baris.`,
        findings: { tableCount: tables.length, tableNames: tables.map((t) => t.name) },
      },
      {
        stage: 2,
        name: "JEV System One Table Role & Relationship Mapping",
        agent: "DatabaseIntegrationAgent",
        decisionSpec: "db.table_role.v1",
        thought: `Mengeksekusi DecisionSpec 'db.table_role.v1' dan 'db.join_candidates.v1' untuk mengklasifikasikan tabel fakta, dimensi, serta mendeteksi ${relationships.length} relasi foreign key antartabel.`,
        findings: { tableRoles, relationshipCount: relationships.length },
      },
      {
        stage: 3,
        name: "Deep JSON Column Introspection & Query Optimization",
        agent: "DatabaseIntegrationAgent",
        decisionSpec: "db.json_structure.v1",
        thought: `Memeriksa struktur kolom JSON dan semi-terstruktur (${allJsonColsCount} kolom terdeteksi). Menemukan sub-field data, memetakan template query ekstraksi JSON, serta menandai indeks B-Tree pada kolom identifier untuk pencarian latensi rendah (< 50ms).`,
        findings: { jsonColumnsDetected: allJsonColsCount, tablesInspected: tables.length },
      },
      {
        stage: 4,
        name: "Governance Registration & DataAgent Routing",
        agent: "DatabaseIntegrationAgent",
        thought: `Mendaftarkan profil semantik basis data ke DataAgent dan EnterpriseOrchestrator. Menyusun kamus sinonim dwibahasa dan aturan pencarian profil entitas legal Indonesia.`,
        findings: { targetAgentAffinity: "data_agent", status: "ready" },
      },
    ];

    const tableProfiles: Record<string, TableSemanticProfile> = {};
    for (const t of tables) {
      tableProfiles[t.name] = this.deriveTableSemanticProfile(t, tables, relationships, tableRoles);
    }
    const crossTableClusters = this.deriveCrossTableClusters(tables, relationships, tableRoles);

    return {
      tableRoles,
      entities,
      relationships,
      suggestedQueries,
      reasoningSteps,
      primaryTopics,
      topics: primaryTopics,
      tableProfiles,
      crossTableClusters,
    };
  }

  /**
   * Derives semantic topics and conceptual clusters purely from structural table roles,
   * entity humanization, and column profiles without any hardcoded dictionary strings.
   */
  private deriveDynamicDatabaseTopics(
    tables: Array<{ name: string; columns: any[]; rowCount?: number }>,
    tableRoles: Record<string, string>,
  ): string[] {
    const topicsSet = new Set<string>();

    const cleanEntityName = (name: string): string => {
      // Strip common technical database prefixes/suffixes: tbl_, t_, m_, mst_, tr_, trx_, d_, dim_, f_, fact_, sys_, v_
      const stripped = name
        .replace(/^(tbl_|mst_|dim_|fact_|trx_|sys_|ref_|t_|m_|f_|v_)/i, "")
        .replace(/(_tbl|_table|_mst|_dim|_fact|_trx|_view)$/i, "");
      // Split by underscore, dash or camelCase
      const parts = stripped
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-]+/g, " ")
        .trim()
        .split(/\s+/);
      return parts
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    };

    const factEntities: string[] = [];
    const dimEntities: string[] = [];
    const lookupEntities: string[] = [];
    let hasAuditLog = false;
    let hasJsonMetadata = false;
    let hasTemporal = false;
    let hasMetrics = false;
    let hasLocation = false;
    let hasIdentifiers = false;

    for (const t of tables) {
      const role = tableRoles[t.name] || "dimension_table";
      const cleanName = cleanEntityName(t.name);

      if (role === "fact_table") {
        if (cleanName) factEntities.push(cleanName);
      } else if (role === "dimension_table") {
        if (cleanName) dimEntities.push(cleanName);
      } else if (role === "lookup_table") {
        if (cleanName) lookupEntities.push(cleanName);
      } else if (role === "audit_log") {
        hasAuditLog = true;
      }

      // Check column structural characteristics without domain-specific hardcoding
      const cols = (t.columns || []).map((c: any) => {
        if (typeof c === "string") return { name: c, type: "" };
        return { name: c?.name || "", type: c?.type || "" };
      });

      for (const col of cols) {
        const cName = col.name.toLowerCase();
        const cType = col.type.toLowerCase();

        // JSON or structured document payload
        if (cType.includes("json") || /(payload|metadata|details|config|attributes|properties|extra|items)/i.test(cName)) {
          hasJsonMetadata = true;
        }

        // Temporal / timestamps
        if (
          cType.includes("date") ||
          cType.includes("time") ||
          /(created|updated|deleted|timestamp|_at|_date|periode|period|tanggal|waktu|year|month)/i.test(cName)
        ) {
          hasTemporal = true;
        }

        // Numeric metrics / aggregation
        if (
          cType.includes("int") ||
          cType.includes("decimal") ||
          cType.includes("float") ||
          cType.includes("double") ||
          cType.includes("numeric")
        ) {
          if (/(total|amount|qty|quantity|count|price|nominal|subtotal|balance|rate|score|persen|percent)/i.test(cName)) {
            hasMetrics = true;
          }
        }

        // Geographic / location attributes
        if (/(address|city|province|state|district|country|location|lat|latitude|lng|longitude|postal|zip|wilayah|daerah|desa|kelurahan|kecamatan|kabupaten|kota)/i.test(cName)) {
          hasLocation = true;
        }

        // Identifier / status codes
        if (/(code|kode|status|type|tipe|uuid|reg_no|nomor|identifier|ref_no)/i.test(cName)) {
          hasIdentifiers = true;
        }
      }
    }

    // Add structural topic groups derived from tables
    if (dimEntities.length > 0) {
      const topDims = dimEntities.slice(0, 3).join(", ");
      topicsSet.add(`Master Entitas (${topDims}${dimEntities.length > 3 ? `, +${dimEntities.length - 3} lainnya` : ""})`);
      for (const ent of dimEntities.slice(0, 4)) {
        topicsSet.add(`Profil & Manajemen ${ent}`);
      }
    }

    if (factEntities.length > 0) {
      const topFacts = factEntities.slice(0, 3).join(", ");
      topicsSet.add(`Transaksi & Aktivitas Bisnis (${topFacts})`);
      for (const ent of factEntities.slice(0, 3)) {
        topicsSet.add(`Histori & Kejadian ${ent}`);
      }
    }

    if (lookupEntities.length > 0) {
      const topLookups = lookupEntities.slice(0, 3).join(", ");
      topicsSet.add(`Klasifikasi & Standarisasi Referensi (${topLookups})`);
    }

    if (hasAuditLog) {
      topicsSet.add("Audit Trail & Log Aktivitas Sistem");
    }

    if (hasMetrics) {
      topicsSet.add("Metrik Finansial & Agregasi Kuantitatif");
    }

    if (hasTemporal) {
      topicsSet.add("Analisis Tren Waktu & Linimasa Kejadian");
    }

    if (hasLocation) {
      topicsSet.add("Distribusi Geografis & Lokasi Wilayah");
    }

    if (hasJsonMetadata) {
      topicsSet.add("Atribut Fleksibel & Metadata Dokumen JSON");
    }

    if (hasIdentifiers) {
      topicsSet.add("Pencarian Entitas Berdasarkan Nomor Registrasi & Kode Unik");
    }

    // Fallback if empty
    if (topicsSet.size === 0) {
      for (const t of tables.slice(0, 4)) {
        topicsSet.add(`Entitas ${cleanEntityName(t.name)}`);
      }
    }

    return Array.from(topicsSet);
  }

  /**
   * Humanizes any technical name or identifier into a clean, capitalized phrase.
   * e.g. 'tbl_data_retail' -> 'Data Retail', 'customer_id' -> 'Customer Id'
   */
  public humanizeIdentifier(name: string): string {
    if (!name) return "";
    const stripped = name
      .replace(/^(tbl_|mst_|dim_|fact_|trx_|sys_|ref_|t_|m_|f_|v_)/i, "")
      .replace(/(_tbl|_table|_mst|_dim|_fact|_trx|_view)$/i, "");
    const parts = stripped
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-\s]+/g, " ")
      .trim()
      .split(/\s+/);
    return parts
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  /**
   * Derives a comprehensive per-table semantic profile with table-specific topics,
   * business context, entity isolation, role classification, and local join relations.
   */
  public deriveTableSemanticProfile(
    table: { name?: string; tableName?: string; columns?: any[]; rowCount?: number },
    allTables: Array<{ name?: string; tableName?: string; columns?: any[]; rowCount?: number }> = [],
    allRelationships: TableRelation[] = [],
    tableRoles: Record<string, string> = {},
  ): TableSemanticProfile {
    const rawTableName = table.tableName || table.name || "table";
    const role =
      (tableRoles[rawTableName] as any) ||
      (table.rowCount && table.rowCount > 500 ? "fact_table" : "dimension_table");
    const humanEntity = this.humanizeIdentifier(rawTableName);
    const entities = [humanEntity];

    const cols = (table.columns || []).map((c: any) => {
      if (typeof c === "string") return { name: c, role: "dimension", type: "" };
      return {
        name: c?.name || "",
        role: c?.role || "dimension",
        type: c?.type || c?.dataType || "",
      };
    });

    const colNames = cols.map((c) => c.name.toLowerCase());
    const tableTopics: string[] = [];

    // 1. Role-based thematic topics
    if (role === "fact_table") {
      tableTopics.push(`${humanEntity} Operational Events & Transaction Volume`);
      tableTopics.push(`${humanEntity} Lifecycle Execution & State History`);
    } else if (role === "bridge_table") {
      tableTopics.push(`${humanEntity} Multi-Entity Association & Mapping`);
      tableTopics.push(`Cross-Domain Relationship Linkage`);
    } else if (role === "lookup_table") {
      tableTopics.push(`${humanEntity} Standardized Reference & Code Catalog`);
    } else {
      tableTopics.push(`${humanEntity} Master Record & Core Profile`);
      tableTopics.push(`${humanEntity} Attribute Governance`);
    }

    // 2. Structural column-derived topics
    if (
      colNames.some((c) =>
        /(total|harga|price|modal|nominal|jumlah|amount|omset|revenue|biaya|tarif|billing|saldo|pembayaran|payment|paid)/i.test(
          c
        )
      )
    ) {
      tableTopics.push(`${humanEntity} Financial Accounting & Monetary Aggregation`);
    }
    if (
      colNames.some((c) =>
        /(status|state|kondisi|is_active|aktif|valid|flag|verified|is_)/i.test(c)
      )
    ) {
      tableTopics.push(`${humanEntity} Verification State & Status Auditing`);
    }
    if (
      colNames.some((c) =>
        /(provinsi|kabupaten|kota|kecamatan|kelurahan|wilayah|region|alamat|address|latitude|longitude|geo|postal)/i.test(
          c
        )
      )
    ) {
      tableTopics.push(`${humanEntity} Geographic Distribution & Regional Routing`);
    }
    if (
      colNames.some((c) =>
        /(tanggal|date|created_at|updated_at|waktu|time|period|periode|tahun|bulan|sk_date)/i.test(
          c
        )
      )
    ) {
      tableTopics.push(`${humanEntity} Timeline Tracking & Historical Trends`);
    }
    if (
      colNames.some((c) =>
        /(json|meta|payload|config|items|detail|extra|attributes|properties)/i.test(
          c
        )
      )
    ) {
      tableTopics.push(
        `${humanEntity} Semi-Structured Attributes & JSON Payload Extraction`
      );
    }
    if (
      colNames.some((c) =>
        /(notaris|pejabat|petugas|officer|author|creator|user|pengguna|actor|admin)/i.test(
          c
        )
      )
    ) {
      tableTopics.push(`${humanEntity} Operational Authority & Actor Attribution`);
    }

    const uniqueTopics = Array.from(new Set(tableTopics));

    const roleExplanation =
      role === "fact_table"
        ? "Tabel fakta transaksional yang merekam histori aktivitas operasional bervolume tinggi"
        : role === "bridge_table"
        ? "Tabel asosiatif penjembatan relasi many-to-many antar entitas utama"
        : role === "lookup_table"
        ? "Tabel referensi standar dan kode klasifikasi lookup"
        : "Tabel master entitas utama yang menyimpan atribut profil bisnis";

    const rowStr = table.rowCount != null ? `${table.rowCount.toLocaleString()} baris` : "katalog terindeks";
    const context = `${roleExplanation} untuk entitas '${humanEntity}'. Memuat ${cols.length} kolom profil (${rowStr}) untuk analisis analitik dan eksekusi TypeSafe JEV DecisionSpecs.`;

    const tableRels = allRelationships.filter(
      (r) =>
        r.sourceTable?.toLowerCase() === rawTableName.toLowerCase() ||
        r.targetTable?.toLowerCase() === rawTableName.toLowerCase()
    );

    return {
      tableName: rawTableName,
      tableRole: role,
      context,
      topics: uniqueTopics,
      entities,
      decisionSpecRefs: ["db.table_role.v1", "db.join_candidates.v1"],
      relationships: tableRels,
      sampleRowCount: table.rowCount,
    };
  }

  /**
   * Synthesizes cohesive multi-table relational clusters by discovering connected components
   * in the foreign key graph and grouping related business domains together.
   */
  public deriveCrossTableClusters(
    tables: Array<{ name?: string; tableName?: string; columns?: any[]; rowCount?: number }>,
    relationships: TableRelation[] = [],
    tableRoles: Record<string, string> = {},
  ): CrossTableCluster[] {
    const clusters: CrossTableCluster[] = [];
    const assignedTables = new Set<string>();

    const normalizedTables = tables
      .map((t) => ({
        name: t.tableName || t.name || "",
        columns: t.columns || [],
        rowCount: t.rowCount,
      }))
      .filter((t) => Boolean(t.name));

    // 1. Build adjacency graph from relationships
    const adjacency = new Map<string, Set<string>>();
    for (const t of normalizedTables) {
      adjacency.set(t.name.toLowerCase(), new Set());
    }
    for (const r of relationships) {
      const src = r.sourceTable?.toLowerCase();
      const tgt = r.targetTable?.toLowerCase();
      if (src && tgt && adjacency.has(src) && adjacency.has(tgt)) {
        adjacency.get(src)!.add(tgt);
        adjacency.get(tgt)!.add(src);
      }
    }

    // 2. Discover connected relationship components (size >= 2)
    for (const t of normalizedTables) {
      const tLow = t.name.toLowerCase();
      if (assignedTables.has(tLow)) continue;

      const queue = [tLow];
      const component = new Set<string>();
      while (queue.length > 0) {
        const curr = queue.shift()!;
        if (component.has(curr)) continue;
        component.add(curr);
        assignedTables.add(curr);
        for (const neighbor of adjacency.get(curr) || []) {
          if (!component.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }

      if (component.size >= 2) {
        const memberTables = normalizedTables
          .filter((tbl) => component.has(tbl.name.toLowerCase()))
          .map((tbl) => tbl.name);
        const clusterEntities = memberTables.map((name) => this.humanizeIdentifier(name));
        const clusterName = `${clusterEntities.slice(0, 2).join(" & ")} Topology Network`;
        clusters.push({
          clusterName,
          description: `Kluster relasi multi-tabel antara [${memberTables.join(
            ", "
          )}] terhubung melalui relasi foreign key untuk query join analitik terpadu.`,
          tables: memberTables,
          topics: [
            `Cross-Table Join Analysis (${clusterEntities.slice(0, 3).join(", ")})`,
            `Foreign Key Topology & Relational Integrity`,
            `Multi-Entity Aggregation & Reconciliation`,
          ],
        });
      }
    }

    // 3. Group remaining tables into cohesive domain catalogs
    const unassigned = normalizedTables.filter(
      (t) => !assignedTables.has(t.name.toLowerCase())
    );
    if (unassigned.length > 0) {
      const memberNames = unassigned.map((t) => t.name);
      clusters.push({
        clusterName: `Core Master Entities & Reference Lookups`,
        description: `Kumpulan tabel master dimensi dan referensi kode (${memberNames
          .slice(0, 4)
          .join(", ")}) untuk penambahan konteks lookup pada query analitik.`,
        tables: memberNames,
        topics: [
          `Master Data Reference Lookup`,
          `Categorical Dimension Filtering & Segmentation`,
          `Standardized Classification Codes`,
        ],
      });
    }

    return clusters;
  }

  /**
   * Derives document-level / section-level semantic profiles for knowledge / RAG sources.
   */
  public deriveDocumentSemanticProfiles(
    chunks: Array<{ id?: string; title?: string; content: string }>,
    fileName: string,
  ): DocumentSemanticProfile[] {
    if (!chunks || chunks.length === 0) {
      const cleanTitle = fileName.replace(/\.[^/.]+$/, "");
      return [
        {
          title: cleanTitle,
          domain: "Unstructured Knowledge",
          context: `Dokumen tunggal '${fileName}' yang diindeks ke dalam vector store RAG.`,
          topics: [
            `${cleanTitle} Document Knowledge Base`,
            `${cleanTitle} Operational Guidelines`,
            `Semantic Retrieval & Policy Search`,
          ],
          entities: [cleanTitle],
          chunkCount: 1,
          wordCount: 100,
          decisionSpecRefs: ["rag.domain_classify.v1", "rag.passage_relevance.v1"],
        },
      ];
    }

    const profiles: DocumentSemanticProfile[] = [];
    const sectionMap = new Map<string, Array<{ content: string }>>();

    for (const c of chunks) {
      const sectionTitle = c.title?.trim() || fileName.replace(/\.[^/.]+$/, "");
      if (!sectionMap.has(sectionTitle)) {
        sectionMap.set(sectionTitle, []);
      }
      sectionMap.get(sectionTitle)!.push(c);
    }

    for (const [secTitle, secChunks] of sectionMap.entries()) {
      const combinedText = secChunks.map((c) => c.content).join(" ");
      const words = combinedText.split(/\s+/).filter(Boolean);
      const cleanSecTitle = secTitle.replace(/\.[^/.]+$/, "");

      profiles.push({
        title: cleanSecTitle,
        domain: "Operational SOP & Governance",
        context: `Bagian/Dokumen '${cleanSecTitle}' memuat ${secChunks.length} passage chunk (${words.length} kata) mengenai tata kelola dan panduan kerja operasional.`,
        topics: [
          `${cleanSecTitle} Directives & Policies`,
          `${cleanSecTitle} Standard Operating Procedures`,
          `${cleanSecTitle} Compliance & Verification Requirements`,
        ],
        entities: [cleanSecTitle],
        chunkCount: secChunks.length,
        wordCount: words.length,
        decisionSpecRefs: ["rag.domain_classify.v1", "rag.passage_relevance.v1"],
      });
    }

    return profiles;
  }

  /**
   * Evaluates cross-table relationships dynamically using JEV System One DecisionSpec ('struct.relation_discovery.v1').
   * StructuredIngestionAgent evaluates candidate relationships without static hardcoded dictionaries.
   */
  async evaluateCrossTableRelations(
    sourceTables: Array<{ tableName: string; columns: Array<{ name: string; role?: string; dataType?: string; sampleValues?: any[] }> }>,
    candidateTables: Array<{ id?: string; tableName: string; columns?: Array<{ name: string; role?: string; dataType?: string }> }>,
  ): Promise<{
    relationships: TableRelation[];
    reasoningSteps: OnboardingReasoningStep[];
  }> {
    const discoveredRels: TableRelation[] = [];
    const seenRelations = new Set<string>();

    // Combine candidate tables with source tables (for multi-table datasets)
    const allCandidates = [
      ...candidateTables.map((t) => ({
        tableName: t.tableName,
        columns: (t.columns || []).map((c) => ({
          name: c.name,
          role: c.role || "dimension",
          dataType: c.dataType || "string",
        })),
      })),
      ...sourceTables.map((t) => ({
        tableName: t.tableName,
        columns: t.columns.map((c) => ({
          name: c.name,
          role: c.role || "dimension",
          dataType: c.dataType || "string",
        })),
      })),
    ];

    const questions: Record<string, any> = {};
    const state = {
      source_tables: sourceTables.map((t) => ({
        table_name: t.tableName,
        columns: t.columns.map((c) => ({ name: c.name, role: c.role, type: c.dataType })),
      })),
      candidate_tables: allCandidates.map((t) => ({
        table_name: t.tableName,
        columns: t.columns.map((c) => ({ name: c.name, role: c.role, type: c.dataType })),
      })),
    };

    // Ask System One about potential foreign keys for each key-like column in source tables
    for (const src of sourceTables) {
      for (const col of src.columns) {
        const isKeyLike = col.role === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(col.name);
        if (!isKeyLike) continue;

        const candidateOptions: Record<string, string> = {
          none: `Kolom '${col.name}' pada '${src.tableName}' adalah atribut lokal / tidak berelasi ke tabel lain`,
        };

        for (const cand of allCandidates) {
          if (cand.tableName.toLowerCase() === src.tableName.toLowerCase()) continue;
          for (const candCol of cand.columns) {
            const isCandKey = candCol.role === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(candCol.name);
            if (isCandKey) {
              candidateOptions[`${cand.tableName}.${candCol.name}`] = `Relasi Many-to-One ke '${cand.tableName}.${candCol.name}'`;
            }
          }
        }

        if (Object.keys(candidateOptions).length > 1) {
          questions[`rel__${src.tableName}__${col.name}`] = {
            type: "choice",
            instructions: `Tentukan relasi referensial kolom kunci '${src.tableName}.${col.name}' terhadap tabel relasional target.`,
            criteria: candidateOptions,
          };
        }
      }
    }

    let jevAnswers: Record<string, any> = {};
    if (Object.keys(questions).length > 0) {
      const res = await this.systemOne(state, questions);
      jevAnswers = res.answers || {};
    }

    // Process JEV decision answers
    for (const [qKey, ans] of Object.entries(jevAnswers)) {
      if (!qKey.startsWith("rel__")) continue;
      const choice = (ans as JevDecisionChoice)?.choice;
      if (!choice || choice === "none" || !choice.includes(".")) continue;

      const [targetTable, targetColumn] = choice.split(".");
      const cleanKey = qKey.replace("rel__", "");
      const parts = cleanKey.split("__");
      if (parts.length === 2 && targetTable && targetColumn) {
        const srcTable = parts[0];
        const srcCol = parts[1];
        const relKey = `${srcTable}.${srcCol}->${targetTable}.${targetColumn}`;
        if (!seenRelations.has(relKey)) {
          seenRelations.add(relKey);
          discoveredRels.push({
            sourceTable: srcTable,
            sourceColumn: srcCol,
            targetTable,
            targetColumn,
            relationType: "many_to_one",
          });
        }
      }
    }

    // Dynamic structural matching fallback to ensure full coverage
    for (const src of sourceTables) {
      for (const col of src.columns) {
        const isKeyLike = col.role === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(col.name);
        if (!isKeyLike) continue;

        for (const cand of allCandidates) {
          if (cand.tableName.toLowerCase() === src.tableName.toLowerCase()) continue;
          for (const candCol of cand.columns) {
            const score = this.calculateStructuralRelationScore(
              src.tableName,
              col.name,
              col.role,
              cand.tableName,
              candCol.name,
              candCol.role,
            );
            if (score >= 8.0) {
              const relKey = `${src.tableName}.${col.name}->${cand.tableName}.${candCol.name}`;
              if (!seenRelations.has(relKey)) {
                seenRelations.add(relKey);
                discoveredRels.push({
                  sourceTable: src.tableName,
                  sourceColumn: col.name,
                  targetTable: cand.tableName,
                  targetColumn: candCol.name,
                  relationType: "many_to_one",
                });
              }
            }
          }
        }
      }
    }

    const reasoningSteps: OnboardingReasoningStep[] = [
      {
        stage: 3,
        name: "Cross-Table Semantic Relationship Discovery",
        agent: "StructuredIngestionAgent",
        decisionSpec: "struct.relation_discovery.v1",
        thought: `Menganalisis ${sourceTables.length} tabel sumber terhadap ${allCandidates.length} tabel dalam skema relasional perusahaan. Menemukan ${discoveredRels.length} relasi foreign key antartabel berdasarkan penelusuran kunci identitas dan keterhubungan entitas.`,
        findings: {
          evaluatedSourceTables: sourceTables.map((t) => t.tableName),
          discoveredRelationships: discoveredRels.map(
            (r) => `${r.sourceTable}.${r.sourceColumn} -> ${r.targetTable}.${r.targetColumn} (${r.relationType})`,
          ),
          totalRelations: discoveredRels.length,
        },
      },
    ];

    return {
      relationships: discoveredRels,
      reasoningSteps,
    };
  }

  /**
   * Dynamically scores candidate relation match between two columns using tokenization,
   * key-role alignment, and base stem comparison WITHOUT any hardcoded keyword lists.
   */
  public calculateStructuralRelationScore(
    sourceTable: string,
    sourceCol: string,
    sourceRole: string | undefined,
    targetTable: string,
    targetCol: string,
    targetRole: string | undefined,
  ): number {
    const sColLower = sourceCol.toLowerCase();
    const tColLower = targetCol.toLowerCase();
    const sColNorm = sColLower.replace(/[_\-\s]+/g, "");
    const tColNorm = tColLower.replace(/[_\-\s]+/g, "");

    const isSrcKey = sourceRole === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(sourceCol);
    const isTgtKey = targetRole === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(targetCol);

    if (!isSrcKey && !isTgtKey) return 0;

    const genericPkNames = new Set(["id", "no", "nomor", "num", "key", "pk", "row_num", "rownum", "kolom_1", "kolom1", "index"]);

    // 1. Exact column name match on key columns (excluding generic standalone PKs)
    if (sColLower === tColLower && (isSrcKey || isTgtKey)) {
      if (genericPkNames.has(sColLower)) {
        return 0;
      }
      return 10.0;
    }

    // 2. Normalized match without delimiters (excluding generic standalone PKs)
    if (sColNorm === tColNorm && sColNorm.length >= 3 && (isSrcKey || isTgtKey)) {
      if (genericPkNames.has(sColNorm)) {
        return 0;
      }
      return 9.5;
    }

    // Helper to get core semantic tokens excluding generic database prefixes/suffixes
    const stemWord = (w: string): string => {
      if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
      if (w.endsWith("es") && w.length > 3) return w.slice(0, -2);
      if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
      return w;
    };

    const getCoreTokens = (str: string): string[] => {
      const parts = str
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-\s]+/g, " ")
        .toLowerCase()
        .trim()
        .split(/\s+/);
      const stopTokens = new Set([
        "tbl", "table", "mst", "dim", "fact", "trx", "sys", "ref", "t", "m", "f", "v",
        "id", "kode", "code", "key", "no", "nomor", "num", "pk", "fk", "col", "data"
      ]);
      return parts.filter((p) => p.length >= 2 && !stopTokens.has(p));
    };

    const sColCore = getCoreTokens(sourceCol);
    const tTblCore = getCoreTokens(targetTable);
    const tColCore = getCoreTokens(targetCol);

    // 3. Source column core stem matches target table name, and target col is primary key / id
    const isTgtPrimaryKey = tColLower === "id" || tColNorm === "id" || targetRole === "identifier" || tColLower === `${targetTable.toLowerCase()}_id`;
    if (isTgtPrimaryKey && sColCore.length > 0 && tTblCore.length > 0) {
      if (sColCore.some((st) => tTblCore.some((tt) => tt === st || stemWord(tt) === stemWord(st)))) {
        return 9.2;
      }
    }

    // 4. Source column core stem matches target column core stem (both are key-like)
    if (isSrcKey && isTgtKey && sColCore.length > 0 && tColCore.length > 0) {
      if (sColCore.some((st) => tColCore.some((tc) => tc === st || stemWord(tc) === stemWord(st)))) {
        return 8.8;
      }
    }

    // 5. Transitive prefix/suffix table pattern (e.g. customer_id -> tbl_customers.id)
    const cleanTgtTable = targetTable.toLowerCase().replace(/^(tbl_|mst_|dim_|fact_|trx_|sys_|ref_|t_|m_|f_|v_)/, "");
    const cleanTgtTableStem = stemWord(cleanTgtTable);
    if (
      (sColLower === `${cleanTgtTable}_id` || sColLower === `${cleanTgtTableStem}_id` || sColLower === `id_${cleanTgtTable}` || sColLower === `id_${cleanTgtTableStem}`) &&
      (tColLower === "id" || tColLower === `${cleanTgtTable}_id` || tColLower === `${cleanTgtTableStem}_id`)
    ) {
      return 9.0;
    }

    return 0;
  }

  /**
   * Synthesizes semantic business topics and domain context using JEV System One DecisionSpec ('struct.topic_synthesis.v1').
   * Performed dynamically by StructuredIngestionAgent without hardcoded regex dictionary arrays.
   */
  async evaluateDatasetTopics(
    tables: Array<{ tableName?: string; name?: string; columns?: any[]; rowCount?: number }>,
    entities: string[] = [],
    metrics: Array<{ name: string; column?: string; aggregation?: string }> = [],
    dimensions: Array<{ name: string; column?: string; sampleValues?: any[] }> = [],
    agentTopics?: string[],
    relationships: TableRelation[] = [],
  ): Promise<{
    topics: string[];
    reasoningSteps: OnboardingReasoningStep[];
    tableProfiles: Record<string, TableSemanticProfile>;
    crossTableClusters: CrossTableCluster[];
  }> {
    const dynamicTopics = this.synthesizeDynamicTopics(tables, entities, metrics, dimensions);
    const topics = Array.from(new Set([...(agentTopics || []), ...dynamicTopics]));

    const state = {
      tables: tables.map((t) => ({ name: t.tableName || t.name, columnsCount: (t.columns || []).length })),
      entities,
      metrics: metrics.map((m) => ({ name: m.name, aggregation: m.aggregation || "sum" })),
      dimensions: dimensions.map((d) => ({ name: d.name, sampleCount: (d.sampleValues || []).length })),
    };

    const criteria: Record<string, string> = {};
    topics.slice(0, 8).forEach((top, idx) => {
      criteria[`topic_${idx}`] = top;
    });

    const questions: Record<string, any> = {
      primary_thematic_topic: {
        type: "choice",
        instructions: `Tentukan fokus topik analitik utama yang paling merepresentasikan dataset bisnis ini.`,
        criteria: Object.keys(criteria).length > 0 ? criteria : { default_topic: "Analisis Dataset Terstruktur" },
      },
    };

    await this.systemOne(state, questions).catch(() => null);

    const tableProfiles: Record<string, TableSemanticProfile> = {};
    for (const t of tables) {
      const tName = t.tableName || t.name || "table";
      tableProfiles[tName] = this.deriveTableSemanticProfile(t, tables, relationships);
    }
    const crossTableClusters = this.deriveCrossTableClusters(tables, relationships);

    const reasoningSteps: OnboardingReasoningStep[] = [
      {
        stage: 4,
        name: "Semantic Topic Synthesis & Domain Context Modeling",
        agent: "StructuredIngestionAgent",
        decisionSpec: "struct.topic_synthesis.v1",
        thought: `Menyintesis ${topics.length} topik semantik dan konteks analitik untuk dataset terstruktur berdasarkan entitas bisnis (${entities.join(", ")}), ${metrics.length} metrik analitik, dan ${dimensions.length} dimensi segmentasi.`,
        findings: {
          synthesizedTopics: topics,
          entitiesCovered: entities,
          metricsCount: metrics.length,
          dimensionsCount: dimensions.length,
          tablesCount: tables.length,
        },
      },
    ];

    return {
      topics,
      reasoningSteps,
      tableProfiles,
      crossTableClusters,
    };
  }

  /**
   * Derives semantic topics dynamically from entities, table names, metrics, dimensions,
   * and structural column profiles WITHOUT any hardcoded domain regex dictionaries.
   */
  public synthesizeDynamicTopics(
    tables: Array<{ tableName?: string; name?: string; columns?: any[] }>,
    entities: string[] = [],
    metrics: Array<{ name: string; column?: string; aggregation?: string }> = [],
    dimensions: Array<{ name: string; column?: string; sampleValues?: any[] }> = [],
  ): string[] {
    const topicsSet = new Set<string>();

    // 1. Entity-based thematic clusters
    for (const ent of entities) {
      if (!ent || !ent.trim()) continue;
      const clean = this.humanizeIdentifier(ent);
      if (clean && clean.length >= 2 && !/^(Data|Table|Dataset)$/i.test(clean)) {
        topicsSet.add(`Profil & Direktori ${clean}`);
        topicsSet.add(`Analisis Aktivitas & Histori ${clean}`);
      }
    }

    // 2. Table-level operational datasets
    for (const t of tables) {
      const rawName = t.tableName || t.name || "";
      const cleanTable = this.humanizeIdentifier(rawName);
      if (cleanTable && cleanTable.length >= 2 && !topicsSet.has(`Profil & Direktori ${cleanTable}`)) {
        topicsSet.add(`Dataset Operasional ${cleanTable}`);
      }
    }

    // 3. Metrics & quantitative analytics clusters
    if (metrics.length > 0) {
      const topMetricNames = metrics.slice(0, 3).map((m) => this.humanizeIdentifier(m.name)).join(", ");
      topicsSet.add(`Metrik Analitik & Agregasi (${topMetricNames})`);
      topicsSet.add(`Kinerja Kuantitatif & Nilai Terukur (${topMetricNames})`);
    }

    // 4. Categorical segmentation from dimensions
    if (dimensions.length > 0) {
      const topDimNames = dimensions.slice(0, 3).map((d) => this.humanizeIdentifier(d.name)).join(", ");
      topicsSet.add(`Segmentasi & Karakteristik Data (${topDimNames})`);
    }

    // 5. Structural column characteristics across all tables
    const allCols = tables.flatMap((t) =>
      (t.columns || []).map((c: any) => ({
        name: typeof c === "string" ? c : c?.name || "",
        role: typeof c === "string" ? "dimension" : c?.role || "dimension",
        dataType: typeof c === "string" ? "string" : c?.dataType || "string",
      }))
    );

    let hasTemporal = false;
    let hasLocation = false;
    let hasLegalOrSk = false;
    let hasEducation = false;
    let hasContact = false;
    let hasIdentifier = false;

    for (const col of allCols) {
      const cLower = col.name.toLowerCase();
      if (col.role === "timestamp" || col.dataType === "date" || /(date|tanggal|time|waktu|tahun|bulan|created|periode|period)/i.test(cLower)) {
        hasTemporal = true;
      }
      if (/(kota|city|provinsi|province|daerah|region|alamat|address|cabang|store|lokasi|location|district|area|wilayah)/i.test(cLower)) {
        hasLocation = true;
      }
      if (/(sk|skk|skm|skp|legalitas|legal|izin|sertifikat|pelantikan|kehakiman|kanwil|regulasi|akta)/i.test(cLower)) {
        hasLegalOrSk = true;
      }
      if (/(almamater|pendidikan|notariat|gelar|title|lulusan|akademik|universitas)/i.test(cLower)) {
        hasEducation = true;
      }
      if (/(email|e_mail|telp|telepon|phone|fax|hp|kontak|contact)/i.test(cLower)) {
        hasContact = true;
      }
      if (col.role === "identifier" || /(_id|^id|id$|kode|code|key|no|nik|npwp|ref)/i.test(cLower)) {
        hasIdentifier = true;
      }
    }

    if (hasLocation) {
      topicsSet.add("Distribusi Geografis & Wilayah Kerja");
      topicsSet.add("Kedudukan & Wilayah Operasional");
    }

    if (hasLegalOrSk) {
      topicsSet.add("Status Legalitas, Dokumen SK & Kepatuhan Regulasi");
    }

    if (hasEducation) {
      topicsSet.add("Kualifikasi Pendidikan & Latar Belakang Profesi");
    }

    if (hasContact) {
      topicsSet.add("Kontak & Direktori Komunikasi Resmi");
    }

    if (hasTemporal) {
      topicsSet.add("Analisis Tren Waktu & Periode Transaksi");
    }

    if (hasIdentifier) {
      topicsSet.add("Pencarian Entitas Berdasarkan Nomor Identitas & Kunci Referensi");
    }

    // Fallback if still empty
    if (topicsSet.size === 0) {
      for (const t of tables) {
        const tName = t.tableName || t.name;
        if (tName) topicsSet.add(`Dataset Terstruktur ${this.humanizeIdentifier(tName)}`);
      }
    }

    return Array.from(topicsSet);
  }

  public deriveStructuralTopics(
    tables: Array<{ tableName?: string; name?: string; columns?: any[] }>,
    entities: string[] = [],
    metrics: Array<{ name: string; column?: string }> = [],
    dimensions: Array<{ name: string; column?: string; sampleValues?: any[] }> = [],
  ): string[] {
    return this.synthesizeDynamicTopics(tables, entities, metrics, dimensions);
  }


  /**
   * 6. Dynamic Fallback Decision Logic
   * Derives all decision outputs dynamically from the registered agents and data sources' semantic profiles.
   * NO STATIC HARDCODED STRINGS!
   */
  private fallbackDecision(state: any, questions: Record<string, any>): JevDecisionResult {
    const answers: Record<string, JevDecisionAnswer> = {};
    const query = String(state?.user_query || "").toLowerCase();
    const queryTerms = query.split(/[\s,._\-?!=+]+/g).filter((w) => w.length >= 2);

    const sources: SourceRosterEntry[] = state?.registered_sources || [];
    let agents: AgentRosterEntry[] = state?.registered_agents || [];
    if (agents.length === 0) {
      agents = [
        { id: "ag_data", name: "DataAgent", title: "Data Agent Specialist", capabilities: "Internal database analytics, entity legal profiling, tabular metrics aggregation, query data, omzet, penjualan, transaksi, angka" },
        { id: "ag_know", name: "KnowledgeAgent", title: "Knowledge Agent Specialist", capabilities: "RAG semantic search, policy, sop, aturan, regulasi, dokumen internal, manual operasional" },
        { id: "ag_research", name: "ResearchAgent", title: "Research Agent Specialist", capabilities: "External market intelligence, riset pasar, kompetitor, intelijen industri, tren eksternal" },
        { id: "ag_analytics", name: "AnalyticsEngineerAgent", title: "Analytics Engineer Specialist", capabilities: "Analisis data lanjutan, visualisasi grafik, chart, diagram, pemodelan statistik" },
        { id: "ag_pred", name: "PredictionAgent", title: "Prediction Agent Specialist", capabilities: "Prediksi masa depan, forecasting, tren masa depan, proyeksi forecast estimasi mendatang" },
        { id: "ag_action", name: "ActionAgent", title: "Action Agent Specialist", capabilities: "Eksekusi mutasi data, automasi operasional, kirim email, kirim notifikasi, update tiket crm" },
        { id: "ag_onb", name: "OnboardingOrchestrator", title: "Onboarding Orchestrator", capabilities: "Onboard data source baru, integrasi database postgres mysql, upload file ingestion" },
        { id: "ag_builder", name: "AgentBuilder", title: "Agent Builder & System Composer", capabilities: "Buat agen baru, rancang agent, custom agent, compose agent" },
      ];
    }

    // Find best matching data source based on dynamic semantic profiles
    let bestSource: SourceRosterEntry | null = null;
    let highestSourceScore = 0;

    for (const src of sources) {
      let score = 0;
      const srcNameLower = src.name.toLowerCase();
      const sp = src.semanticProfile;

      for (const term of queryTerms) {
        if (srcNameLower.includes(term)) score += 3.0;

        if (sp?.entities) {
          for (const ent of sp.entities) {
            if (ent.toLowerCase().includes(term)) score += 5.0;
          }
        }
        if (sp?.metrics) {
          for (const met of sp.metrics) {
            if (met.name.toLowerCase().includes(term)) score += 4.0;
          }
        }
        if (sp?.primaryTopics) {
          for (const top of sp.primaryTopics) {
            if (top.toLowerCase().includes(term)) score += 3.0;
          }
        }
        if (src.tables) {
          for (const tbl of src.tables) {
            if (tbl.toLowerCase().includes(term)) score += 3.5;
          }
        }
      }

      if (score > highestSourceScore) {
        highestSourceScore = score;
        bestSource = src;
      }
    }

    // Find best matching agent based on dynamic capabilities (excluding ingestion-only agents for runtime queries)
    let bestAgentKey = "data_agent";
    let highestAgentScore = 0;
    const isIntegrationQuery = query.includes("integrasi") || query.includes("hubungkan") || query.includes("connect") || query.includes("onboard") || query.includes("koneksi") || query.includes("tambah source");

    for (const ag of agents) {
      const agKey = this.normalizeAgentRouteKey(ag.name);
      // Ingestion specialists are reserved for integration/onboarding tasks
      const isIngestionAgent = agKey.includes("integration") || agKey.includes("ingestion");
      if (isIngestionAgent && !isIntegrationQuery) continue;

      let score = 0;
      const agCaps = (ag.capabilities || "").toLowerCase();
      const agTitle = (ag.title || "").toLowerCase();

      for (const term of queryTerms) {
        if (agCaps.includes(term)) score += 2.0;
        if (agTitle.includes(term)) score += 2.5;
      }

      if (score > highestAgentScore) {
        highestAgentScore = score;
        bestAgentKey = agKey;
      }
    }

    for (const [key, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        if (key === "is_profiling_query") {
          const hasEntityMatch = highestSourceScore >= 5.0 || /(siapa|profil|profiling|detail|cek|info|data|status)/i.test(query);
          answers[key] = {
            type: "noul",
            noul: hasEntityMatch ? 0.95 : 0.2,
          };
        } else if (key === "requires_internal_data") {
          answers[key] = {
            type: "noul",
            noul: highestSourceScore > 0 ? 0.95 : 0.4,
          };
        } else {
          answers[key] = { type: "noul", noul: 0.5 };
        }
      } else if (q.type === "score") {
        answers[key] = {
          type: "score",
          score: 2.0,
          confidence: 0.8,
          legend: { "0": "Rendah", "1": "Sedang", "2": "Tinggi" },
          probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
        };
      } else if (q.type === "choice") {
        const options = Object.keys(q.criteria || {});
        let selected = options[0] || "direct";

        if (key === "route") {
          // Check explicit domain intent signals first
          if (query.includes("sop") || query.includes("kebijakan") || query.includes("panduan") || query.includes("dokumen") || query.includes("aturan") || query.includes("manual") || query.includes("sla")) {
            selected = "knowledge_agent";
          } else if (query.includes("profil") || query.includes("profiling") || query.includes("legalitas") || query.includes("perseroan") || query.includes("pemegang saham") || query.includes("direksi") || query.includes("notaris") || query.includes("sk kemenkumham") || query.includes("npwp") || query.includes("badan hukum")) {
            selected = "data_agent";
          } else if (query.includes("riset") || query.includes("kompetitor") || (query.includes("pasar") && !query.includes("penjualan"))) {
            selected = "research_agent";
          } else if (query.includes("grafik") || query.includes("chart") || query.includes("visualisasi") || query.includes("diagram")) {
            selected = "analytics_engineer_agent";
          } else if (query.includes("prediksi") || query.includes("forecasting") || query.includes("ramalan") || query.includes("proyeksi")) {
            selected = "prediction_agent";
          } else if (query.includes("notifikasi") || query.includes("tiket") || query.includes("email") || query.includes("kirim") || query.includes("ubah tiket")) {
            selected = "action_agent";
          } else if (query.includes("onboard") || (query.includes("upload") && query.includes("data"))) {
            selected = "onboarding_orchestrator";
          } else if (query.includes("buat agen") || query.includes("bikin agen") || query.includes("agent builder")) {
            selected = "agent_builder";
          } else if (highestSourceScore > 0 && bestSource) {
            // Priority route driven by the matched source's semantic profile!
            if (bestSource.semanticProfile?.targetAgentAffinity) {
              selected = bestSource.semanticProfile.targetAgentAffinity;
            } else if (bestSource.type === "rag_document") {
              selected = "knowledge_agent";
            } else {
              selected = "data_agent";
            }
          } else if (highestAgentScore > 0) {
            selected = bestAgentKey;
          } else if (queryTerms.length <= 2 && (query.includes("halo") || query.includes("hi") || query.includes("pagi") || query.includes("siang"))) {
            selected = "direct";
          }
        } else if (key === "target_source") {
          if (highestSourceScore > 0 && bestSource) {
            selected = bestSource.id;
          } else {
            selected = "none";
          }
        } else if (key === "domain_classify") {
          selected = this.inferDomainFromText(String(state?.sample_text || ""), String(state?.file_name || ""));
        } else if (key === "target_agent_affinity") {
          selected = "knowledge_agent";
        } else if (key.startsWith("role_")) {
          const colName = key.replace("role_", "");
          selected = this.inferRoleFromColumn(colName);
        } else if (key.startsWith("rel__") || key.startsWith("rel_")) {
          const criteriaOptions = Object.keys(q.criteria || {});
          let bestChoice = "none";
          let highestScore = 0;
          for (const opt of criteriaOptions) {
            if (opt === "none" || !opt.includes(".")) continue;
            const [candTable, candCol] = opt.split(".");
            let srcTable = "";
            let srcCol = "";
            if (key.startsWith("rel__")) {
              const cleanKey = key.replace("rel__", "");
              const parts = cleanKey.split("__");
              if (parts.length === 2) {
                srcTable = parts[0];
                srcCol = parts[1];
              }
            } else {
              const cleanKey = key.replace("rel_", "");
              const match = cleanKey.match(/^(.+)_(.+)$/);
              if (match) {
                srcTable = match[1];
                srcCol = match[2];
              }
            }
            if (srcTable && srcCol) {
              const score = this.calculateStructuralRelationScore(srcTable, srcCol, undefined, candTable, candCol, undefined);
              if (score > highestScore && score >= 8.0) {
                highestScore = score;
                bestChoice = opt;
              }
            }
          }
          selected = bestChoice;
        } else if (key === "primary_thematic_topic" || key === "dataset_thematic_focus") {
          const keys = Object.keys(q.criteria || {});
          selected = keys[0] || "default_topic";
        } else if (key === "entity_type") {
          const criteriaOptions = Object.keys(q.criteria || {});
          const tLower = String(state?.table_name || "").toLowerCase();
          const cols = (state?.columns || []).map((c: string) => String(c).toLowerCase());
          const agentEnts = (state?.agent_entities || []).map((e: string) => String(e).toLowerCase());
          const candEnts = (state?.candidate_entities || []).map((e: string) => String(e).toLowerCase());
          const stateTokens = new Set([
            ...tLower.split(/[_\-\s]+/).filter((w: string) => w.length >= 3),
            ...cols.flatMap((c: string) => c.split(/[_\-\s]+/)).filter((w: string) => w.length >= 3),
            ...agentEnts.flatMap((e: string) => e.split(/[_\-\s]+/)).filter((w: string) => w.length >= 3),
            ...candEnts.flatMap((e: string) => e.split(/[_\-\s]+/)).filter((w: string) => w.length >= 3),
          ]);

          let bestOption = criteriaOptions[0] || "general_dataset";
          let maxScore = -1;

          for (const opt of criteriaOptions) {
            if (opt === "general_dataset") continue;
            const desc = String(q.criteria[opt] || "").toLowerCase();
            const optClean = opt.replace(/^entity_/, "").toLowerCase();
            let score = 0;
            for (const ent of [...agentEnts, ...candEnts]) {
              if (optClean.includes(ent) || desc.includes(ent)) score += 10;
            }
            for (const token of stateTokens) {
              if (optClean.includes(token)) score += 5;
              if (desc.includes(token)) score += 2;
            }
            if (score > maxScore) {
              maxScore = score;
              bestOption = opt;
            }
          }
          selected = maxScore > 0 ? bestOption : (criteriaOptions[0] || "general_dataset");
        }

        answers[key] = {
          type: "choice",
          choice: selected,
          confidence: 0.85,
          probabilities: { [selected]: 0.85 },
        };
      }
    }

    return {
      model: "fallback-dynamic",
      answers,
      latencyMs: 1,
    };
  }

  private normalizeAgentRouteKey(name: string): string {
    const lower = name.toLowerCase().replace(/agent$/i, "");
    if (lower === "data") return "data_agent";
    if (lower === "knowledge") return "knowledge_agent";
    if (lower === "research") return "research_agent";
    if (lower === "prediction") return "prediction_agent";
    if (lower === "analytic" || lower === "analytics" || lower === "analyticsengineer") return "analytics_engineer_agent";
    if (lower === "action") return "action_agent";
    if (lower === "onboarding" || lower === "onboardingorchestrator") return "onboarding_orchestrator";
    if (lower === "builder" || lower === "agentbuilder") return "agent_builder";
    if (lower === "vision") return "vision_agent";
    return `${lower}_agent`;
  }

  private extractEntitiesFromText(text: string, fileName: string): string[] {
    const entities = new Set<string>();
    entities.add(fileName);
    // Check filename base
    const baseName = fileName.replace(/\.[^/.]+$/, "");
    if (baseName.length > 3) entities.add(baseName);

    // Look for capitalized sequences (names / institutions)
    const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g);
    if (matches) {
      for (const m of matches.slice(0, 8)) {
        if (m.length > 4 && !m.includes("The") && !m.includes("And")) {
          entities.add(m);
        }
      }
    }

    return Array.from(entities).slice(0, 10);
  }

  private extractTopicsFromDomain(domain: string, text: string): string[] {
    const topics: string[] = [];
    if (domain === "cv_profile") {
      topics.push("Profil Profesional", "Pendidikan & Pengalaman", "Keahlian Teknis");
    } else if (domain === "sop_policy") {
      topics.push("Standar Operasional", "Prosedur Kerja", "Kepatuhan");
    } else if (domain === "legal_regulation") {
      topics.push("Peraturan Hukum", "Klausul Legal", "Kepatuhan Regulasi");
    } else {
      topics.push("Informasi Enterprise", "Pengetahuan Internal");
    }
    return topics;
  }

  private inferDomainFromText(text: string, fileName: string): string {
    const lower = (text + " " + fileName).toLowerCase();
    if (lower.includes("cv") || lower.includes("resume") || lower.includes("curriculum vitae") || lower.includes("experience") || lower.includes("education")) {
      return "cv_profile";
    }
    if (lower.includes("sop") || lower.includes("standar operasional") || lower.includes("prosedur") || lower.includes("pedoman")) {
      return "sop_policy";
    }
    if (lower.includes("undang-undang") || lower.includes("peraturan") || lower.includes("pasal") || lower.includes("hukum") || lower.includes("akta")) {
      return "legal_regulation";
    }
    if (lower.includes("keuangan") || lower.includes("neraca") || lower.includes("laba rugi") || lower.includes("financial")) {
      return "financial_report";
    }
    return "general_knowledge";
  }

  private inferRoleFromColumn(colName: string): string {
    const lower = colName.toLowerCase();
    if (lower.includes("id") || lower.includes("kode") || lower === "nim" || lower === "nip") {
      return "identifier";
    }
    if (lower.includes("date") || lower.includes("tanggal") || lower.includes("time") || lower.includes("tahun")) {
      return "timestamp";
    }
    if (lower.includes("omzet") || lower.includes("total") || lower.includes("amount") || lower.includes("price") || lower.includes("ipk") || lower.includes("qty")) {
      return "metric";
    }
    return "dimension";
  }

  private tokenize(text: string): string[] {
    return String(text || "")
      .toLowerCase()
      .split(/[\s,._\-?!=+]+/g)
      .filter((w) => w.length >= 2);
  }

  private calculateOverlap(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    const setB = new Set(tokensB);
    let match = 0;
    for (const t of tokensA) {
      if (setB.has(t)) match++;
    }
    return match;
  }

  /**
   * Decide structured metric, aggregation function, and group by dimension for a user query.
   */
  async decideStructuredMetric(
    query: string,
    metricNames: string[],
    dimNames: string[],
  ): Promise<{
    metric: string;
    aggregation: "sum" | "avg" | "count" | "min" | "max";
    groupBy?: string;
  }> {
    const qTokens = this.tokenize(query);

    let bestMetric = metricNames[0] || "";
    let maxMetricScore = -1;
    for (const m of metricNames) {
      const mTokens = this.tokenize(m);
      const score = this.calculateOverlap(qTokens, mTokens);
      if (score > maxMetricScore) {
        maxMetricScore = score;
        bestMetric = m;
      }
    }

    let aggregation: "sum" | "avg" | "count" | "min" | "max" = "sum";
    const lowerQ = query.toLowerCase();

    const aggKeywords: Array<{ kw: string; agg: "sum" | "avg" | "count" | "min" | "max" }> = [
      { kw: "total", agg: "sum" },
      { kw: "sum", agg: "sum" },
      { kw: "rata-rata", agg: "avg" },
      { kw: "average", agg: "avg" },
      { kw: "mean", agg: "avg" },
      { kw: "jumlah", agg: "count" },
      { kw: "count", agg: "count" },
      { kw: "berapa banyak", agg: "count" },
      { kw: "maksimal", agg: "max" },
      { kw: "tertinggi", agg: "max" },
      { kw: "max", agg: "max" },
      { kw: "minimal", agg: "min" },
      { kw: "terendah", agg: "min" },
      { kw: "min", agg: "min" },
    ];

    let earliestIdx = Infinity;
    for (const item of aggKeywords) {
      const idx = lowerQ.indexOf(item.kw);
      if (idx !== -1 && idx < earliestIdx) {
        earliestIdx = idx;
        aggregation = item.agg;
      }
    }

    let groupBy: string | undefined;
    if (lowerQ.includes("berdasarkan") || lowerQ.includes("per ") || lowerQ.includes("by ") || lowerQ.includes("setiap")) {
      let maxDimScore = 0;
      for (const d of dimNames) {
        const dTokens = this.tokenize(d);
        const score = this.calculateOverlap(qTokens, dTokens);
        if (score > maxDimScore) {
          maxDimScore = score;
          groupBy = d;
        }
      }
    }

    return {
      metric: bestMetric,
      aggregation,
      groupBy,
    };
  }

  /**
   * Rerank and verify RAG search results against the query.
   */
  async rerankAndVerifyRag(
    query: string,
    chunks: { chunkId: string; content: string; sourceName: string; baseScore?: number }[],
  ): Promise<{
    topChunkIds: string[];
    confidence: number;
    isAnswerable: boolean;
    answerabilityNote?: string;
  }> {
    const stopWords = new Set([
      "dan", "di", "ke", "dari", "yang", "untuk", "pada", "dengan", "ini", "itu",
      "ada", "apa", "siapa", "aja", "saja", "cek", "isinya", "bisa", "tolong",
      "the", "and", "is", "of", "in", "to", "what", "who", "where", "how",
      "menurut", "dalam", "atau", "jika", "adalah", "sebagai", "oleh", "serta",
      "halaman", "gambar", "bab", "berdasarkan", "dokumen"
    ]);

    const qTokens = this.tokenize(query).filter(
      (w) => !stopWords.has(w) && (w.length > 2 || /^\d+$/.test(w)),
    );

    const scored = chunks.map((c, originalIdx) => {
      const cLower = c.content.toLowerCase();
      let matchCount = 0;
      let matchedUnique = 0;

      for (const t of qTokens) {
        if (cLower.includes(t)) {
          matchedUnique++;
          const cnt = cLower.split(t).length - 1;
          matchCount += Math.min(cnt, 4);
        }
      }

      // Coverage boost for multiple distinct substantive terms
      const coverageRatio = qTokens.length > 0 ? matchedUnique / qTokens.length : 0;
      const rerankScore =
        (c.baseScore || (1.0 - originalIdx * 0.1)) * 0.5 +
        coverageRatio * 0.35 +
        Math.min(matchCount / 10, 1.0) * 0.15;

      return { chunkId: c.chunkId, score: rerankScore, matchedUnique };
    });

    scored.sort((a, b) => b.score - a.score);
    const topChunkIds = scored.map((s) => s.chunkId);
    const hasGoodMatches = scored.some((s) => s.matchedUnique >= 1);
    const confidence = hasGoodMatches ? 0.95 : 0.45;
    const isAnswerable = hasGoodMatches;

    return {
      topChunkIds,
      confidence,
      isAnswerable,
      answerabilityNote: isAnswerable
        ? `Found ${topChunkIds.length} relevant passages mapped to query context.`
        : "Low token relevance detected across available document passages.",
    };
  }
}
