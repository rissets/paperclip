import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { StructuredIngestionService } from "../services/structured-ingestion.js";
import { KnowledgeIngestionService } from "../services/knowledge-ingestion.js";
import { TypeSafeJevService } from "../services/typesafe-jev.js";

describe("Structured Ingestion Service", () => {
  it("parses and profiles CSV data accurately with roles and semantic model", () => {
    const csvContent = `id,customer_name,region,sales_amount,quantity,order_date
1,Alice,Surabaya,150000,3,2026-01-15
2,Bob,Jakarta,250000,5,2026-01-16
3,Charlie,Surabaya,100000,2,2026-01-17
4,Diana,Bandung,300000,6,2026-01-18
5,Evan,Jakarta,450000,8,2026-01-19`;

    const parsed = StructuredIngestionService.parseCsv(csvContent, "sales_january");

    expect(parsed.tableName).toBe("sales_january");
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.columns).toHaveLength(6);

    // Verify Column Definitions
    const idCol = parsed.columns.find((c) => c.name === "id");
    expect(idCol?.role).toBe("identifier");

    const salesCol = parsed.columns.find((c) => c.name === "sales_amount");
    expect(salesCol?.role).toBe("metric");
    expect(salesCol?.dataType).toBe("number");
    expect(salesCol?.min).toBe(100000);
    expect(salesCol?.max).toBe(450000);

    const regionCol = parsed.columns.find((c) => c.name === "region");
    expect(regionCol?.role).toBe("dimension");
    expect(regionCol?.distinctCount).toBe(3);

    // Verify Semantic Model
    expect(parsed.semanticModel.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sales_amount", aggregation: "sum" }),
        expect.objectContaining({ name: "quantity", aggregation: "sum" }),
      ]),
    );

    expect(parsed.semanticModel.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "region" }),
        expect.objectContaining({ name: "customer_name" }),
      ]),
    );

    expect(parsed.semanticModel.synonyms.sales_amount).toContain("omzet");
    expect(parsed.semanticModel.synonyms.sales_amount).toContain("pendapatan");
    expect(parsed.semanticModel.synonyms.region).toContain("wilayah");
    expect(parsed.semanticModel.synonyms.region).toContain("cabang");
  });

  it("parses multi-sheet Excel workbooks", () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet([
      { product_id: "P1", name: "Laptop", price: 15000000 },
      { product_id: "P2", name: "Mouse", price: 250000 },
    ]);
    const ws2 = XLSX.utils.json_to_sheet([
      { order_id: "O100", customer: "Acme Corp", total: 15250000 },
    ]);

    XLSX.utils.book_append_sheet(wb, ws1, "Products");
    XLSX.utils.book_append_sheet(wb, ws2, "Orders");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const tables = StructuredIngestionService.parseExcel(buffer);

    expect(tables).toHaveLength(2);
    expect(tables[0].tableName).toBe("Products");
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[1].tableName).toBe("Orders");
    expect(tables[1].rows).toHaveLength(1);
  });
});

describe("Knowledge Ingestion Service", () => {
  it("chunks markdown documents with structure awareness", async () => {
    const markdownDoc = `# Kebijakan Pengadaan Barang dan Jasa

## Ketentuan Umum
Seluruh pengadaan barang di atas 100 juta rupiah wajib mendapatkan persetujuan tertulis dari Direktur Keuangan.
Pengadaan operasional harian di bawah 10 juta rupiah dapat disetujui langsung oleh Manager Unit terkait.

## Prosedur Tender Vendor
Setiap pemilihan vendor harus membandingkan minimal 3 penawaran harga resmi dari supplier terdaftar.
Evaluasi didasarkan pada kualitas, rekam jejak, garansi purna jual, dan harga penawaran.`;

    const { chunks, totalWords } = await KnowledgeIngestionService.processDocument(
      "SOP_Pengadaan.md",
      Buffer.from(markdownDoc, "utf-8"),
      "text/markdown",
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(totalWords).toBeGreaterThan(20);

    const firstChunk = chunks[0];
    expect(firstChunk.title).toBeDefined();
    expect(firstChunk.content).toContain("100 juta");
    expect(firstChunk.embedding).toBeDefined();
    expect(firstChunk.embedding).toHaveLength(128);
  });

  it("calculates accurate cosine similarity for semantic matching", () => {
    const textA = "Kebijakan pengadaan barang operasional dan persetujuan direktur keuangan.";
    const textB = "Aturan pengadaan barang kantor dan otorisasi anggaran pengadaan.";
    const textC = "Resep memasak rendang daging sapi khas Padang.";

    const embA = KnowledgeIngestionService.generateEmbedding(textA);
    const embB = KnowledgeIngestionService.generateEmbedding(textB);
    const embC = KnowledgeIngestionService.generateEmbedding(textC);

    const simAB = KnowledgeIngestionService.cosineSimilarity(embA, embB);
    const simAC = KnowledgeIngestionService.cosineSimilarity(embA, embC);

    // Business & procurement query matches more closely than food recipe
    expect(simAB).toBeGreaterThan(simAC);
  });
});

describe("Database Integration Service", () => {
  it("enforces read-only SQL validation and blocks DDL/DML mutations", async () => {
    const { DatabaseIntegrationService } = await import("../services/database-integration.js");
    const service = new DatabaseIntegrationService();

    const mockConfig: any = {
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "test",
      username: "user",
    };

    // Disallowed statements
    await expect(service.queryDatabase(mockConfig, "DROP TABLE users")).rejects.toThrow(
      /Security Violation/i,
    );
    await expect(service.queryDatabase(mockConfig, "DELETE FROM orders WHERE id = 1")).rejects.toThrow(
      /Security Violation/i,
    );
    await expect(service.queryDatabase(mockConfig, "UPDATE accounts SET balance = 0")).rejects.toThrow(
      /Security Violation/i,
    );
    await expect(service.queryDatabase(mockConfig, "INSERT INTO logs VALUES ('hack')")).rejects.toThrow(
      /Security Violation/i,
    );
    await expect(service.queryDatabase(mockConfig, "ALTER TABLE users ADD COLUMN pass text")).rejects.toThrow(
      /Security Violation/i,
    );
    await expect(service.queryDatabase(mockConfig, "TRUNCATE TABLE audit_log")).rejects.toThrow(
      /Security Violation/i,
    );
  });

  it("inspects top 5 sample rows to detect JSON columns, map subfields, and generate ClickHouse DDL", async () => {
    const { DatabaseIntegrationService } = await import("../services/database-integration.js");
    const service = new DatabaseIntegrationService();

    // 5 sample rows representing real AHU_DB perseroan data (row 1 has null modal_dasar, row 2-5 have JSON)
    const sampleRows = [
      null,
      JSON.stringify([
        {
          id: 1,
          data: [
            {
              nama_badan_hukum: "PT HARAPAN MAJU",
              jabatan: "DIREKTUR UTAMA",
              jumlah_lembar: 500,
              total_nominal: 50000000,
              is_active: true,
            },
          ],
        },
      ]),
      JSON.stringify([
        {
          id: 2,
          data: [
            {
              nama_badan_hukum: "BUDI SANTOSO",
              jabatan: "KOMISARIS",
              jumlah_lembar: 200,
              total_nominal: 20000000,
              npwp: "012345678901234",
            },
          ],
        },
      ]),
      null,
      JSON.stringify([
        {
          id: 3,
          data: [
            {
              nama_badan_hukum: "PT INVESTASI BERSAMA",
              jabatan: "DIREKTUR",
              jumlah_lembar: 300,
              total_nominal: 30000000,
            },
          ],
        },
      ]),
    ];

    const inspection = service.inspectColumn("pemegang_saham", "longtext", sampleRows);

    expect(inspection.isJson).toBe(true);
    expect(inspection.dataType).toBe("json");
    expect(inspection.jsonStructure).toBeDefined();
    expect(inspection.jsonStructure?.kind).toBe("array_of_objects");

    const subFieldNames = inspection.jsonStructure?.subFields.map((s) => s.name);
    expect(subFieldNames).toContain("nama_badan_hukum");
    expect(subFieldNames).toContain("jabatan");
    expect(subFieldNames).toContain("jumlah_lembar");
    expect(subFieldNames).toContain("npwp");

    // ClickHouse type should be an Array(Tuple(...))
    expect(inspection.clickhouseType).toContain("Array(Tuple(");
    expect(inspection.clickhouseType).toContain("`nama_badan_hukum` String");
    expect(inspection.clickhouseType).toContain("`jumlah_lembar` Float64");

    // Test semantic model generation with nested dimensions and ClickHouse DDL
    const mockColumns: any[] = [
      {
        name: "id_perseroan",
        dataType: "string",
        role: "identifier",
        isPrimaryKey: true,
        sampleValues: ["UUID-001"],
        clickhouseType: "String",
      },
      {
        name: "nama_perseroan",
        dataType: "string",
        role: "dimension",
        sampleValues: ["PT BAGUS HARAPAN TRITUNGGAL"],
        clickhouseType: "String",
      },
      {
        name: "pemegang_saham",
        dataType: "json",
        role: "dimension",
        isJson: true,
        jsonStructure: inspection.jsonStructure,
        sampleValues: sampleRows.slice(0, 5),
        clickhouseType: inspection.clickhouseType,
      },
    ];

    const semanticModel = (service as any).buildSemanticModel("tbl_perseroan", mockColumns, [], "id_perseroan");

    // Check nested dimensions
    expect(semanticModel.nestedDimensions).toBeDefined();
    const nestedNames = semanticModel.nestedDimensions.map((nd: any) => nd.name);
    expect(nestedNames).toContain("pemegang_saham.nama_badan_hukum");
    expect(nestedNames).toContain("pemegang_saham.jabatan");

    // Check synonyms for nested dimensions
    expect(semanticModel.synonyms["pemegang_saham.nama_badan_hukum"]).toBeDefined();
    expect(semanticModel.synonyms["pemegang_saham.nama_badan_hukum"]).toContain("pemegang saham");

    // Check ClickHouse schema DDL
    expect(semanticModel.clickhouseSchema).toBeDefined();
    expect(semanticModel.clickhouseSchema.engine).toBe("MergeTree");
    expect(semanticModel.clickhouseSchema.orderBy).toEqual(["id_perseroan"]);
    expect(semanticModel.clickhouseSchema.createTableDdl).toContain("CREATE TABLE IF NOT EXISTS `tbl_perseroan`");
    expect(semanticModel.clickhouseSchema.createTableDdl).toContain("`id_perseroan` String");
    expect(semanticModel.clickhouseSchema.createTableDdl).toContain("`pemegang_saham` Array(Tuple(");
    expect(semanticModel.clickhouseSchema.createTableDdl).toContain("ENGINE = MergeTree()");
    expect(semanticModel.clickhouseSchema.createTableDdl).toContain("ORDER BY (`id_perseroan`)");
  });
});

describe("TypeSafe Jev System One Decision Plane", () => {
  it("routes entity profiling query to data_agent with high calibrated confidence", async () => {
    const { TypeSafeJevService } = await import("../services/typesafe-jev.js");
    const jev = new TypeSafeJevService();

    const decision = await jev.routeUserQuery("profiling pt bagus harapan tritunggal", [
      { id: "ds_db", name: "AHU_DB", type: "mariadb", tables: ["tbl_perseroan", "ahu_cv"] },
      { id: "ds_sales", name: "Sales Q3 Report", type: "csv", tables: ["Sales Q3 Report"] },
      { id: "ds_rag", name: "Cloud SLA Policy", type: "rag_document" },
    ]);

    expect(decision.route).toBe("data_agent");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
    expect(decision.isProfilingQuery).toBe(true);
  });

  it("decides structured metrics on tabular sales dataset", async () => {
    const { TypeSafeJevService } = await import("../services/typesafe-jev.js");
    const jev = new TypeSafeJevService();

    const metricDecision = await jev.decideStructuredMetric(
      "Berapa total penjualan dan rata-rata omzet per region?",
      ["sales_amount", "quantity", "profit"],
      ["region", "customer_name", "category"],
    );

    expect(metricDecision.metric).toBeDefined();
    expect(metricDecision.aggregation).toBe("sum");
    expect(metricDecision.groupBy).toBe("region");
  });

  it("re-ranks RAG candidate snippets with calibrated scoring", async () => {
    const { TypeSafeJevService } = await import("../services/typesafe-jev.js");
    const jev = new TypeSafeJevService();

    const ragEval = await jev.rerankAndVerifyRag("Berapa komitmen SLA uptime cloud?", [
      { chunkId: "c1", content: "Layanan cloud menjamin ketersediaan uptime 99.95% per bulan.", sourceName: "SLA Policy" },
      { chunkId: "c2", content: "Prosedur pengajuan cuti tahunan karyawan.", sourceName: "HR Policy" },
    ]);

    expect(ragEval.topChunkIds).toBeDefined();
    expect(ragEval.topChunkIds[0]).toBe("c1");
    expect(ragEval.isAnswerable).toBe(true);
  });

  it("formats Indonesian company profile from internal AHU_DB perseroan record", async () => {
    const { DataAgentService } = await import("../services/data-agent.js");
    const agent = new DataAgentService({} as any);

    const mockRow = {
      nama_perseroan: "BAGUS HARAPAN TRITUNGGAL",
      nomor_sk: "AHU-0013786.AH.01.02.Tahun 2025",
      tanggal_sk: "2025-02-25T17:00:00.000Z",
      npwp_perseroan: "316469865028000",
      status_perseroan: "tertutup",
      alamat_perseroan: "Kompleks Majapahit Permai Blok B 113, Jl Majapahit No 18,20,22",
      modal_disetorkan: "11000000000",
      nama_notaris: "ERVINIA IDA WAHYUNI ADAM, S.H., M.KN.",
      pemegang_saham: JSON.stringify([
        {
          id: 1,
          data: [
            { nama_badan_hukum: "IDA BAGUS ALIT WIDNYANA", jabatan: "DIREKTUR", email: "alit@bht.co.id" },
            { nama_badan_hukum: "TIMOTIUS SETIADI WIDJAJA", jabatan: "KOMISARIS", email: "timotius@bht.co.id" },
          ],
        },
      ]),
      kegiatan: JSON.stringify([
        { id: "46511", maksud: "Perdagangan Besar Komputer", tujuan: ["Komputer dan perlengkapan"] },
      ]),
    };

    const formatted = (agent as any).formatCompanyProfile(mockRow, "AHU_DB");
    expect(formatted).toContain("PT BAGUS HARAPAN TRITUNGGAL");
    expect(formatted).toContain("AHU-0013786.AH.01.02.Tahun 2025");
    expect(formatted).toContain("11.000.000.000");
    expect(formatted).toContain("IDA BAGUS ALIT WIDNYANA");
    expect(formatted).toContain("KBLI 46511");
    expect(formatted).toContain("Sumber Data Internal");
  });

  it("formats generic entity profiles dynamically without hardcoded table names or prefixes", async () => {
    const { DataAgentService } = await import("../services/data-agent.js");
    const agent = new DataAgentService({} as any);

    const mockRow = {
      customer_id: "CUST-9821",
      full_name: "Alexander Graham",
      account_status: "active",
      shipping_address: "142 Tech Valley Boulevard",
      lifetime_spend: 45000000,
      registered_at: "2024-01-15T00:00:00.000Z",
      contact_email: "alexander@techvalley.io",
      order_history: JSON.stringify([
        { order_id: "ORD-001", item_name: "Ultra HD Monitor", quantity: 2, total_amount: 15000000 },
        { order_id: "ORD-002", item_name: "Ergonomic Chair", quantity: 1, total_amount: 5000000 },
      ]),
    };

    const mockColumns = [
      { name: "customer_id", dataType: "string", role: "identifier", semanticCategory: "identity", humanLabel: "Customer ID" },
      { name: "full_name", dataType: "string", role: "dimension", semanticCategory: "identity", humanLabel: "Full Name", isSearchable: true },
      { name: "account_status", dataType: "string", role: "dimension", semanticCategory: "status", humanLabel: "Account Status" },
      { name: "shipping_address", dataType: "string", role: "dimension", semanticCategory: "location", humanLabel: "Shipping Address" },
      { name: "lifetime_spend", dataType: "number", role: "metric", semanticCategory: "financial", humanLabel: "Lifetime Spend" },
      { name: "registered_at", dataType: "date", role: "timestamp", semanticCategory: "temporal", humanLabel: "Registration Date" },
      { name: "contact_email", dataType: "string", role: "dimension", semanticCategory: "contact", humanLabel: "Contact Email" },
      { name: "order_history", dataType: "json", role: "dimension", semanticCategory: "nested_structure", isJson: true, humanLabel: "Order History" },
    ];

    const formatted = agent.formatDynamicEntityProfile(
      mockRow,
      "customer_profiles",
      "E-Commerce Production DB",
      mockColumns as any,
    );

    expect(formatted).toContain("Alexander Graham");
    expect(formatted).toContain("CUST-9821");
    expect(formatted).toContain("ACTIVE");
    expect(formatted).toContain("142 Tech Valley Boulevard");
    expect(formatted).toContain("45.000.000");
    expect(formatted).toContain("alexander@techvalley.io");
    expect(formatted).toContain("Ultra HD Monitor");
    expect(formatted).toContain("E-Commerce Production DB");
    expect(formatted).toContain("customer_profiles");
  });

  it("semantically routes multi-agent requests across all specialist agents", async () => {
    const { TypeSafeJevService } = await import("../services/typesafe-jev.js");
    const jev = new TypeSafeJevService();

    const sources = [
      { id: "ds_db", name: "AHU_DB", type: "mariadb", tables: ["tbl_perseroan"] },
      { id: "ds_csv", name: "Sales Q3", type: "csv", tables: ["sales"] },
      { id: "ds_rag", name: "Corporate SOP", type: "rag_document" },
    ];

    const dataRes = await jev.routeUserQuery("tampilkan omzet penjualan cabang jakarta", sources);
    expect(dataRes.route).toBe("data_agent");

    const knowRes = await jev.routeUserQuery("apa isi SOP dan aturan cuti perusahaan?", sources);
    expect(knowRes.route).toBe("knowledge_agent");

    const researchRes = await jev.routeUserQuery("riset pasar kompetitor cloud di Asia Tenggara", sources);
    expect(researchRes.route).toBe("research_agent");

    const analyticsRes = await jev.routeUserQuery("buatkan visualisasi grafik dan chart pertumbuhan user", sources);
    expect(analyticsRes.route).toBe("analytics_engineer_agent");

    const predRes = await jev.routeUserQuery("prediksi dan forecasting tren penjualan bulan depan", sources);
    expect(predRes.route).toBe("prediction_agent");

    const actionRes = await jev.routeUserQuery("kirim notifikasi email dan ubah tiket CRM", sources);
    expect(actionRes.route).toBe("action_agent");

    const onbRes = await jev.routeUserQuery("onboard database postgres baru dan upload file", sources);
    expect(onbRes.route).toBe("onboarding_orchestrator");

    const buildRes = await jev.routeUserQuery("buat agen baru untuk divisi logistik", sources);
    expect(buildRes.route).toBe("agent_builder");
  });

  it("dynamically discovers cross-table relationships without hardcoded dictionaries", async () => {
    const jev = new TypeSafeJevService();

    const sourceTables = [
      {
        tableName: "data_retail",
        columns: [
          { name: "id", role: "identifier" },
          { name: "customer_id", role: "identifier" },
          { name: "product_id", role: "identifier" },
          { name: "total_omset", role: "metric" },
        ],
      },
    ];

    const candidateTables = [
      {
        tableName: "tbl_customers",
        columns: [
          { name: "id", role: "identifier" },
          { name: "nama_pelanggan", role: "dimension" },
        ],
      },
      {
        tableName: "tbl_products",
        columns: [
          { name: "id", role: "identifier" },
          { name: "nama_produk", role: "dimension" },
        ],
      },
    ];

    const { relationships, reasoningSteps } = await jev.evaluateCrossTableRelations(
      sourceTables,
      candidateTables,
    );

    expect(relationships.length).toBeGreaterThanOrEqual(2);
    expect(
      relationships.some(
        (r) =>
          r.sourceTable === "data_retail" &&
          r.sourceColumn === "customer_id" &&
          r.targetTable === "tbl_customers" &&
          r.targetColumn === "id",
      ),
    ).toBe(true);
    expect(
      relationships.some(
        (r) =>
          r.sourceTable === "data_retail" &&
          r.sourceColumn === "product_id" &&
          r.targetTable === "tbl_products" &&
          r.targetColumn === "id",
      ),
    ).toBe(true);

    expect(reasoningSteps.length).toBeGreaterThanOrEqual(1);
    expect(reasoningSteps[0].decisionSpec).toBe("struct.relation_discovery.v1");
    expect(reasoningSteps[0].agent).toBe("StructuredIngestionAgent");
  });

  it("synthesizes semantic topics dynamically via struct.topic_synthesis.v1", async () => {
    const jev = new TypeSafeJevService();

    const tables = [
      {
        tableName: "data_retail",
        columns: [
          { name: "customer_id", role: "identifier" },
          { name: "omzet", role: "metric" },
          { name: "kota_cabang", role: "dimension" },
          { name: "tanggal_transaksi", role: "timestamp" },
        ],
      },
    ];

    const { topics, reasoningSteps } = await jev.evaluateDatasetTopics(
      tables,
      ["Pelanggan", "Retail"],
      [{ name: "omzet", aggregation: "sum" }],
      [{ name: "kota_cabang", sampleValues: ["Jakarta", "Surabaya"] }],
    );

    expect(topics.length).toBeGreaterThan(0);
    expect(topics.some((t) => t.includes("Pelanggan"))).toBe(true);
    expect(topics.some((t) => t.includes("Omzet"))).toBe(true);
    expect(topics.some((t) => t.includes("Geografis") || t.includes("Wilayah"))).toBe(true);
    expect(topics.some((t) => t.includes("Waktu") || t.includes("Periode"))).toBe(true);

    expect(reasoningSteps.length).toBeGreaterThanOrEqual(1);
    expect(reasoningSteps[0].decisionSpec).toBe("struct.topic_synthesis.v1");
    expect(reasoningSteps[0].agent).toBe("StructuredIngestionAgent");
  });
});



