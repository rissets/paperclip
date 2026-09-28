import { describe, it, expect, vi } from "vitest";
import { TypeSafeJevService } from "../services/typesafe-jev.js";
import { ENTERPRISE_ROSTER_DEFINITIONS } from "../services/enterprise-agent-roster.js";
import type { DataSourceSemanticProfile } from "@paperclipai/shared";

describe("TypeSafe JEV Dynamic Onboarding & Routing", () => {
  it("verifies enterprise agent roster definitions contains all 17 specialists from docs", () => {
    expect(ENTERPRISE_ROSTER_DEFINITIONS.length).toBe(17);

    // 3 Orchestrators
    const orchestrators = ENTERPRISE_ROSTER_DEFINITIONS.filter((a) =>
      ["Homseo", "OnboardingOrchestrator", "AgentBuilder"].includes(a.name),
    );
    expect(orchestrators.length).toBe(3);

    // 7 Onboarding Specialists
    const onboardingSpecialists = ENTERPRISE_ROSTER_DEFINITIONS.filter((a) =>
      [
        "StructuredIngestionAgent",
        "KnowledgeIngestionAgent",
        "DatabaseIntegrationAgent",
        "ApiIntegrationAgent",
        "IotIntegrationAgent",
        "CctvIntegrationAgent",
        "McpBuilderAgent",
      ].includes(a.name),
    );
    expect(onboardingSpecialists.length).toBe(7);

    // 7 Runtime Specialists
    const runtimeSpecialists = ENTERPRISE_ROSTER_DEFINITIONS.filter((a) =>
      [
        "KnowledgeAgent",
        "DataAgent",
        "ResearchAgent",
        "AnalyticsEngineerAgent",
        "PredictionAgent",
        "ActionAgent",
        "VisionAgent",
      ].includes(a.name),
    );
    expect(runtimeSpecialists.length).toBe(7);
  });

  it("dynamically evaluates column roles using JEV DecisionSpec ('struct.column_role')", async () => {
    const jev = new TypeSafeJevService();
    const columns = [
      { name: "id_transaksi", distinctCount: 100, nullRatio: 0, sampleValues: ["TX-001", "TX-002"] },
      { name: "tanggal_order", distinctCount: 90, nullRatio: 0, sampleValues: ["2026-03-01", "2026-03-02"] },
      { name: "omzet_penjualan", distinctCount: 85, nullRatio: 0, sampleValues: [500000, 1200000] },
      { name: "kategori_produk", distinctCount: 5, nullRatio: 0, sampleValues: ["Elektronik", "Fashion"] },
    ];

    const roles = await jev.evaluateColumnRoles("t_orders", columns);
    expect(roles["id_transaksi"]).toBe("identifier");
    expect(roles["tanggal_order"]).toBe("timestamp");
    expect(roles["omzet_penjualan"]).toBe("metric");
    expect(roles["kategori_produk"]).toBe("dimension");
  });

  it("dynamically synthesizes entities and metrics using DecisionSpec ('struct.entity_metric_mapping')", async () => {
    const jev = new TypeSafeJevService();
    const result = await jev.evaluateEntityAndMetrics(
      "laporan_keuangan_bulanan",
      ["id", "bulan", "total_omzet", "laba_bersih", "divisi"],
      ["total_omzet", "laba_bersih"],
    );

    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities).toContain("laporan_keuangan_bulanan");
    expect(result.primaryMetrics.length).toBe(2);
    expect(result.primaryMetrics[0].name).toBe("total_omzet");
    expect(result.primaryMetrics[0].aggregation).toBe("sum");
  });

  it("dynamically classifies document domain and extracts entities ('rag.domain_classify')", async () => {
    const jev = new TypeSafeJevService();
    const docSample = `
      CURRICULUM VITAE
      Nama: Danang Haris Setiawan
      Pendidikan: Universitas Indonesia
      Pengalaman Kerja: Software Engineer di PT Bagus Harapan Tritunggal
      Keahlian: Artificial Intelligence, TypeScript, PostgreSQL
    `;

    const result = await jev.evaluateDocumentDomain("Danang_CV_2026.docx", docSample);
    expect(result.domain).toBe("cv_profile");
    expect(result.targetAgentAffinity).toBe("knowledge_agent");
    expect(result.entities).toContain("Danang_CV_2026.docx");
    expect(result.primaryTopics).toContain("Profil Profesional");
  });

  it("dynamically routes user queries based on live semantic profiles with ZERO hardcoded rules", async () => {
    const jev = new TypeSafeJevService();

    const registeredAgents = [
      { id: "1", name: "DataAgent", title: "Data Specialist", capabilities: "SQL queries, metrics aggregation, structured analytics" },
      { id: "2", name: "KnowledgeAgent", title: "Knowledge Specialist", capabilities: "Document retrieval, CV profiling, RAG search, policy lookup" },
      { id: "3", name: "VisionAgent", title: "Vision Specialist", capabilities: "CCTV feeds, video streaming, computer vision, frame analysis" },
    ];

    const mockProfileCV: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: "KnowledgeIngestionAgent",
      decisionSpecRefs: ["rag.domain_classify.v1"],
      domain: "cv_profile",
      targetAgentAffinity: "knowledge_agent",
      entities: ["Danang Haris Setiawan", "Universitas Indonesia"],
      primaryTopics: ["Pendidikan & Pengalaman", "Keahlian"],
      summary: "Curriculum Vitae Danang Haris Setiawan",
      onboardedAt: new Date().toISOString(),
    };

    const mockProfileSales: DataSourceSemanticProfile = {
      version: "1.0.0",
      onboardedBy: "StructuredIngestionAgent",
      decisionSpecRefs: ["struct.entity_metric_mapping.v1"],
      domain: "retail_analytics",
      targetAgentAffinity: "data_agent",
      entities: ["Transaksi Toko", "omzet_penjualan"],
      metrics: [{ name: "omzet_penjualan", column: "omzet", aggregation: "sum" }],
      summary: "Tabel omzet transaksi retail",
      onboardedAt: new Date().toISOString(),
    };

    const availableSources = [
      { id: "src-cv-1", name: "CV_Danang.pdf", type: "rag_document", semanticProfile: mockProfileCV },
      { id: "src-sales-2", name: "Sales_Q3.csv", type: "csv", tables: ["sales_data"], semanticProfile: mockProfileSales },
    ];

    // Query 1: Menanyakan CV Danang
    const decisionCV = await jev.routeUserQuery(
      "Siapa nama dan pendidikan Danang Haris Setiawan?",
      availableSources,
      registeredAgents,
    );
    expect(decisionCV.targetSourceId).toBe("src-cv-1");
    expect(decisionCV.route).toBe("knowledge_agent");

    // Query 2: Menanyakan data omzet penjualan
    const decisionSales = await jev.routeUserQuery(
      "Berapa total omzet penjualan pada Q3?",
      availableSources,
      registeredAgents,
    );
    expect(decisionSales.targetSourceId).toBe("src-sales-2");
    expect(decisionSales.route).toBe("data_agent");
  });
});
