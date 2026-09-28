import type { Db } from "@paperclipai/db";
import { dataSourceTables, dataSources } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { DataSourcesService } from "./data-sources.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import type { SpecialistExecution } from "@paperclipai/shared";

export class DataAgentService {
  private dataSourcesService: DataSourcesService;
  private jevService: TypeSafeJevService;

  constructor(private db: Db) {
    this.dataSourcesService = new DataSourcesService(db);
    this.jevService = new TypeSafeJevService();
  }

  /**
   * Execute structured data reasoning, database entity profiling, and analytical queries
   */
  async answer(companyId: string, query: string): Promise<SpecialistExecution> {
    const allSources = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.status, "ready")));

    const tables = await this.db
      .select()
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    if (allSources.length === 0 && tables.length === 0) {
      return {
        agent: "data_agent",
        task: "Query internal data sources",
        resultsSummary: "No internal data sources or tables currently available in this company.",
      };
    }

    const queryLower = query.toLowerCase();

    // 1. Check if this is an Entity / Company Profiling Query (e.g., "profiling PT Bagus Harapan Tritunggal")
    const isProfilingKeyword =
      queryLower.includes("profil") ||
      queryLower.includes("profiling") ||
      queryLower.includes("pt ") ||
      queryLower.includes("cv ") ||
      queryLower.includes("perseroan") ||
      queryLower.includes("legalitas") ||
      queryLower.includes("direksi") ||
      queryLower.includes("pemegang saham") ||
      queryLower.includes("notaris") ||
      queryLower.includes("sk kemenkumham") ||
      queryLower.includes("npwp") ||
      queryLower.includes("badan hukum");

    // Also check with TypeSafe Jev System One
    let isProfiling = isProfilingKeyword;
    if (!isProfiling) {
      try {
        const jevCheck = await this.jevService.systemOne(
          { user_query: query },
          {
            is_company_profiling: {
              type: "noul",
              instructions: "Apakah query ini menanyakan profil, pengurus, legalitas, atau data perseroan/perusahaan?",
            },
          },
        );
        const ans = jevCheck.answers["is_company_profiling"] as any;
        if (ans && ans.noul >= 0.5) isProfiling = true;
      } catch {
        // use heuristic
      }
    }

    // 2. Handle Entity Profiling on External Databases (AHU_DB / tbl_perseroan / ahu_cv)
    if (isProfiling) {
      const dbSource = allSources.find(
        (s) => s.sourceType === "mariadb" || s.sourceType === "mysql" || s.sourceType === "postgres",
      );

      if (dbSource) {
        // Clean company search term
        let searchTerm = query
          .replace(/^(profiling|profil|tolong\s+profiling|cari\s+profil|carikan|info|data)\s+/i, "")
          .replace(/^(pt|cv|kantor|perusahaan)\s+/i, "")
          .replace(/[?.,!]+$/, "")
          .trim()
          .toUpperCase();

        if (searchTerm.length >= 2) {
          try {
            // First try exact match on tbl_perseroan
            let sql = `SELECT * FROM tbl_perseroan WHERE nama_perseroan = '${searchTerm.replace(/'/g, "''")}' LIMIT 5`;
            let res = await this.dataSourcesService.querySql(companyId, dbSource.id, sql, 5);

            // If not found, try LIKE prefix search
            if (res.rows.length === 0) {
              const prefixTerm = searchTerm.split(" ").slice(0, 2).join(" ");
              sql = `SELECT * FROM tbl_perseroan WHERE nama_perseroan LIKE '${prefixTerm.replace(/'/g, "''")}%' LIMIT 5`;
              res = await this.dataSourcesService.querySql(companyId, dbSource.id, sql, 5);
            }

            if (res.rows.length > 0) {
              const row = res.rows[0];
              const summary = this.formatCompanyProfile(row, dbSource.name);
              return {
                agent: "data_agent",
                task: `Profil entitas internal: ${row.nama_perseroan || searchTerm}`,
                query: sql,
                resultsSummary: summary,
                dataPreview: res.rows,
              };
            }

            // Fallback: check ahu_cv if not found in tbl_perseroan
            try {
              const cvSql = `SELECT * FROM ahu_cv WHERE nama = '${searchTerm.replace(/'/g, "''")}' OR nama LIKE '${searchTerm.replace(/'/g, "''")}%' LIMIT 3`;
              const cvRes = await this.dataSourcesService.querySql(companyId, dbSource.id, cvSql, 3);
              if (cvRes.rows.length > 0) {
                const cvRow = cvRes.rows[0];
                const summary = this.formatCvProfile(cvRow, dbSource.name);
                return {
                  agent: "data_agent",
                  task: `Profil legalitas CV: ${cvRow.nama || searchTerm}`,
                  query: cvSql,
                  resultsSummary: summary,
                  dataPreview: cvRes.rows,
                };
              }
            } catch {
              // ahu_cv fallback error ignored
            }
          } catch (err: any) {
            console.warn("[DataAgent] SQL entity search error:", err.message);
          }
        }
      }
    }

    // 3. Handle Tabular Analytics (CSV / Excel / Structured metrics)
    if (tables.length === 0) {
      return {
        agent: "data_agent",
        task: "Query structured database",
        resultsSummary: "Data perusahaan tidak ditemukan dalam data source internal yang aktif.",
      };
    }

    // 3. Multi-table evaluation: score ALL tables to pick the best candidate based on tokens, entities, metrics, dimensions, and sample values
    let bestTable = tables[0];
    let bestScore = -1;

    for (const tbl of tables) {
      let score = 0;
      const sModel: any = tbl.semanticModel || {};
      const tNameLower = tbl.tableName.toLowerCase();

      // Check full table name match
      if (queryLower.includes(tNameLower)) {
        score += 20;
      } else {
        // Check partial token matches (e.g. "penjualan", "transaksi", "item", "pelanggan")
        const tTokens = tNameLower.split(/[\s_\-]+/).filter((w: string) => w.length > 2);
        for (const tok of tTokens) {
          if (queryLower.includes(tok)) score += 5;
        }
      }

      // Check entity match
      for (const ent of sModel.entities || []) {
        if (queryLower.includes(String(ent).toLowerCase())) score += 6;
      }

      // Check metric names and synonyms
      for (const m of sModel.metrics || []) {
        const mName = String(m.name).toLowerCase();
        if (queryLower.includes(mName)) score += 6;
        const syns = sModel.synonyms?.[m.name] || [];
        for (const s of syns) {
          if (queryLower.includes(String(s).toLowerCase())) score += 4;
        }
      }

      // Check dimension names and synonyms
      for (const d of sModel.dimensions || []) {
        const dName = String(d.name).toLowerCase();
        if (queryLower.includes(dName)) score += 4;
        const syns = sModel.synonyms?.[d.name] || [];
        for (const s of syns) {
          if (queryLower.includes(String(s).toLowerCase())) score += 3;
        }
        // Check sample values match in query! (e.g. "Jakarta", "Surabaya", "Lunas")
        for (const val of d.sampleValues || []) {
          const valStr = String(val).toLowerCase();
          if (valStr.length >= 3 && queryLower.includes(valStr)) {
            score += 8;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestTable = tbl;
      }
    }

    let matchedMetric: string | undefined;
    let matchedDimension: string | undefined;
    let matchedAggregation: "sum" | "avg" | "count" | "min" | "max" = "sum";

    // Use Jev for structured metric decision on the best candidate table
    const semModel: any = bestTable.semanticModel || {};
    const metricNames = (semModel.metrics || []).map((m: any) => m.name);
    const dimNames = (semModel.dimensions || []).map((d: any) => d.name);

    if (metricNames.length > 0) {
      try {
        const jevMetricDecision = await this.jevService.decideStructuredMetric(
          query,
          metricNames,
          dimNames,
        );
        matchedMetric = jevMetricDecision.metric;
        matchedAggregation = jevMetricDecision.aggregation;
        matchedDimension = jevMetricDecision.groupBy;
      } catch {
        // fallback to keyword matching
      }
    }

    // Heuristic detection if JEV did not resolve a metric
    if (!matchedMetric) {
      if (queryLower.includes("rata-rata") || queryLower.includes("average") || queryLower.includes("mean")) {
        matchedAggregation = "avg";
      } else if (queryLower.includes("tertinggi") || queryLower.includes("highest") || queryLower.includes("max")) {
        matchedAggregation = "max";
      } else if (queryLower.includes("terendah") || queryLower.includes("lowest") || queryLower.includes("min")) {
        matchedAggregation = "min";
      } else if (queryLower.includes("berapa banyak") || queryLower.includes("jumlah baris") || queryLower.includes("count")) {
        matchedAggregation = "count";
      }

      for (const m of semModel.metrics || []) {
        const mName = m.name.toLowerCase();
        if (queryLower.includes(mName)) {
          matchedMetric = m.name;
          break;
        }
        const syns = semModel.synonyms?.[m.name] || [];
        for (const s of syns) {
          if (queryLower.includes(String(s).toLowerCase())) {
            matchedMetric = m.name;
            break;
          }
        }
        if (matchedMetric) break;
      }

      for (const d of semModel.dimensions || []) {
        const dName = d.name.toLowerCase();
        if (queryLower.includes(dName)) {
          matchedDimension = d.name;
          break;
        }
      }

      if (!matchedMetric && semModel.metrics?.length > 0) {
        matchedMetric = semModel.metrics[0].name;
      }
      if (!matchedDimension && semModel.dimensions?.length > 0) {
        matchedDimension = semModel.dimensions[0].name;
      }
    }

    // Detect exact sample value filters from dimensions (e.g., wilayah = "Jakarta")
    const detectedFilter: Record<string, string> = {};
    for (const d of semModel.dimensions || []) {
      for (const val of d.sampleValues || []) {
        const valStr = String(val);
        if (valStr.length >= 3 && queryLower.includes(valStr.toLowerCase())) {
          detectedFilter[d.name] = valStr;
        }
      }
    }

    // 4. Execute deterministic query on table
    let queryResult;
    let queryDescription = "";
    const filterDesc = Object.keys(detectedFilter).length > 0
      ? ` (filter: ${JSON.stringify(detectedFilter)})`
      : "";

    if (matchedMetric && matchedDimension) {
      queryDescription = `Aggregate ${matchedAggregation}(${matchedMetric}) grouped by ${matchedDimension} on table '${bestTable.tableName}'${filterDesc}`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        filter: Object.keys(detectedFilter).length > 0 ? detectedFilter : undefined,
        aggregate: {
          column: matchedMetric,
          fn: matchedAggregation,
          groupBy: matchedDimension,
        },
        limit: 15,
      });
    } else if (matchedMetric) {
      queryDescription = `Compute ${matchedAggregation}(${matchedMetric}) on table '${bestTable.tableName}'${filterDesc}`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        filter: Object.keys(detectedFilter).length > 0 ? detectedFilter : undefined,
        aggregate: {
          column: matchedMetric,
          fn: matchedAggregation,
        },
      });
    } else {
      queryDescription = `Preview top records from table '${bestTable.tableName}'`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        limit: 10,
      });
    }

    // 5. Format tabular result summary
    let summary = `Data Agent queried internal table **${bestTable.tableName}** (${queryDescription}).\n\n`;

    if (queryResult.rows.length > 0) {
      const headers = queryResult.columns;
      summary += `| ${headers.join(" | ")} |\n`;
      summary += `| ${headers.map(() => "---").join(" | ")} |\n`;

      for (const row of queryResult.rows.slice(0, 10)) {
        const line = headers.map((h) => {
          const val = row[h];
          if (typeof val === "number") {
            return val.toLocaleString();
          }
          return String(val ?? "-");
        });
        summary += `| ${line.join(" | ")} |\n`;
      }

      if (queryResult.totalRows > 10) {
        summary += `\n*(Menampilkan 10 teratas dari ${queryResult.totalRows} hasil)*\n`;
      }
    } else {
      summary += "Tidak ada baris yang sesuai dengan kriteria yang diminta.";
    }

    return {
      agent: "data_agent",
      task: queryDescription,
      query: queryDescription,
      resultsSummary: summary,
      dataPreview: queryResult.rows,
    };
  }

  /**
   * Helper to format rich Indonesian company profile from tbl_perseroan
   */
  private formatCompanyProfile(row: any, sourceName: string): string {
    const namaPerseroan = row.nama_perseroan || "N/A";
    const nomorSk = row.nomor_sk || "-";
    const tglSk = row.tanggal_sk ? new Date(row.tanggal_sk).toLocaleDateString("id-ID", { dateStyle: "long" }) : "-";
    const status = row.status_perseroan || "Aktif";
    const npwp = row.npwp_perseroan || "-";
    const jenis = row.jenis_perseroan || "PMDN";
    const tahun = row.tahun_pendirian || "-";
    const notaris = row.nama_notaris || "-";
    const alamat = [
      row.alamat_perseroan,
      row.kelurahan,
      row.kecamatan_nama_perseroan,
      row.kabupaten_nama_perseroan,
      row.provinsi_nama_perseroan,
    ].filter(Boolean).join(", ");

    // Format Modal
    let modalDisetorStr = "-";
    if (row.modal_disetorkan) {
      const num = Number(row.modal_disetorkan);
      modalDisetorStr = isNaN(num) ? String(row.modal_disetorkan) : `Rp ${num.toLocaleString("id-ID")}`;
    }

    // Parse Pemegang Saham / Pengurus
    let shareholdersList: any[] = [];
    if (row.pemegang_saham) {
      try {
        const parsed = typeof row.pemegang_saham === "string" ? JSON.parse(row.pemegang_saham) : row.pemegang_saham;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const dataArr = item.data || [item];
            for (const d of dataArr) {
              if (d.nama_badan_hukum || d.nama) {
                shareholdersList.push({
                  nama: d.nama_badan_hukum || d.nama,
                  jabatan: d.jabatan || "Pemegang Saham",
                  lembar: d.jumlah_lembar_saham_modal_ditempatkan || d.jumlah_lembar || "-",
                  nilai: d.total_harga_saham_yang_dipegang ? `Rp ${Number(d.total_harga_saham_yang_dipegang).toLocaleString("id-ID")}` : "-",
                  email: d.email || "-",
                  telepon: d.no_telepon_dewan || "-",
                });
              }
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }

    // Parse Kegiatan / KBLI
    let kegiatanList: any[] = [];
    if (row.kegiatan) {
      try {
        const parsed = typeof row.kegiatan === "string" ? JSON.parse(row.kegiatan) : row.kegiatan;
        if (Array.isArray(parsed)) {
          kegiatanList = parsed;
        }
      } catch {
        // ignore
      }
    }

    let out = `### Profil Resmi: PT ${namaPerseroan}\n\n`;
    out += `> **Status Data:** Terverifikasi 100% dari Sumber Data Internal (**${sourceName}** &mdash; \`tbl_perseroan\`).\n`;
    out += `> *Pengambilan data dilakukan secara lokal dari database resmi tanpa menggunakan pencarian publik eksternal.*\n\n`;

    out += `#### 1. Identitas & Legalitas Perseroan\n`;
    out += `- **Nama Resmi:** PT ${namaPerseroan}\n`;
    out += `- **Nomor SK Kemenkumham:** \`${nomorSk}\`\n`;
    out += `- **Tanggal SK Pengesahan:** ${tglSk}\n`;
    out += `- **NPWP Perseroan:** \`${npwp}\`\n`;
    out += `- **Status Perseroan:** ${status.toUpperCase()}\n`;
    out += `- **Jenis Perseroan:** ${jenis}\n`;
    out += `- **Tahun Pendirian:** ${tahun}\n`;
    out += `- **Notaris Pembuat Akta:** ${notaris}\n\n`;

    out += `#### 2. Domisili & Alamat Terdaftar\n`;
    out += `- **Alamat Lengkap:** ${alamat || "-"}\n\n`;

    out += `#### 3. Struktur Permodalan\n`;
    out += `- **Total Modal Disetor:** **${modalDisetorStr}**\n\n`;

    if (shareholdersList.length > 0) {
      out += `#### 4. Susunan Dewan Pengurus & Pemegang Saham (BOD / BOC)\n`;
      out += `| Nama Lengkap | Jabatan | Jumlah Saham | Nilai Saham | Kontak / Email |\n`;
      out += `|---|---|---|---|---|\n`;
      for (const s of shareholdersList) {
        out += `| **${s.nama}** | ${s.jabatan} | ${s.lembar} | ${s.nilai} | ${s.email} |\n`;
      }
      out += `\n`;
    }

    if (kegiatanList.length > 0) {
      out += `#### 5. Maksud, Tujuan & Bidang Usaha (KBLI Terdaftar)\n`;
      for (const k of kegiatanList.slice(0, 8)) {
        const tujuanStr = Array.isArray(k.tujuan) ? k.tujuan.slice(0, 2).join("; ") : "";
        out += `- **KBLI ${k.id || ""}:** ${k.maksud || ""}${tujuanStr ? ` &mdash; *(${tujuanStr})*` : ""}\n`;
      }
      out += `\n`;
    }

    return out;
  }

  private formatCvProfile(row: any, sourceName: string): string {
    const namaCv = row.nama || "N/A";
    const noDaftar = row.no_pendaftaran || "-";
    const status = row.status || "Aktif";
    const npwp = row.npwp_no || "-";
    const alamat = row.alamat || "-";
    const modal = row.modal ? `Rp ${Number(row.modal).toLocaleString("id-ID")}` : "-";
    const aktaNo = row.akta_no || "-";
    const aktaTgl = row.akta_tgl ? new Date(row.akta_tgl).toLocaleDateString("id-ID", { dateStyle: "long" }) : "-";

    let out = `### Profil Resmi: CV ${namaCv}\n\n`;
    out += `> **Status Data:** Terverifikasi 100% dari Sumber Data Internal (**${sourceName}** &mdash; \`ahu_cv\`).\n\n`;
    out += `#### 1. Identitas & Pendaftaran CV\n`;
    out += `- **Nama Badan Usaha:** CV ${namaCv}\n`;
    out += `- **Nomor Pendaftaran Kemenkumham:** \`${noDaftar}\`\n`;
    out += `- **NPWP:** \`${npwp}\`\n`;
    out += `- **Status Usaha:** ${status.toUpperCase()}\n`;
    out += `- **Akta Notaris:** No. ${aktaNo} (${aktaTgl})\n\n`;
    out += `#### 2. Domisili & Modal\n`;
    out += `- **Alamat Terdaftar:** ${alamat}\n`;
    out += `- **Modal Usaha:** **${modal}**\n\n`;
    return out;
  }
}
