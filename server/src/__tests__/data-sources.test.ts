import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { StructuredIngestionService } from "../services/structured-ingestion.js";
import { KnowledgeIngestionService } from "../services/knowledge-ingestion.js";

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
    expect(inspection.clickhouseType).toContain("nama_badan_hukum String");
    expect(inspection.clickhouseType).toContain("jumlah_lembar Float64");

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
});



