import type { Db } from "@paperclipai/db";
import { dataSourceTables, dataSources } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { DataSourcesService } from "./data-sources.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { aiReasoningService } from "./ai-reasoning.js";
import type { SpecialistExecution } from "@paperclipai/shared";
import { makeDataSourceCacheKey } from "./data-source-cache.js";
import { DataSourceQueryTracer } from "./data-source-query-trace.js";
import { DataSourcePlanValidator } from "./data-source-plan-validator.js";
import {
  resolveDimensionBinding,
  resolveRequestedDimension,
  resolveSemanticDimensionBindings,
  resolveSemanticMetricBindings,
  resolveTemporalRangeFilter,
} from "./data-source-query-semantics.js";

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
  async answer(
    companyId: string,
    query: string,
    options?: {
      collectionId?: string;
      agentId?: string;
      dataSourceIds?: string[];
      tableIds?: string[];
      authzFingerprint?: string;
      traceId?: string;
      runId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      preferredMode?: "live" | "snapshot";
    },
  ): Promise<SpecialistExecution> {
    if (options?.signal?.aborted) {
      throw new Error("Query execution was cancelled or exceeded deadline budget");
    }
    const tracer = new DataSourceQueryTracer({
      companyId,
      query,
      traceId: options?.traceId,
      agentId: options?.agentId,
      runId: options?.runId,
      sessionId: options?.sessionId,
    });
    const startTime = Date.now();

    let allSources = await this.db
      .select()
      .from(dataSources)
      .where(and(eq(dataSources.companyId, companyId), eq(dataSources.status, "ready")));

    let tables = await this.db
      .select()
      .from(dataSourceTables)
      .where(eq(dataSourceTables.companyId, companyId));

    let authorizedDataSourceIds = options?.dataSourceIds;
    if (options?.agentId) {
      const access = await this.dataSourcesService.getAgentDataSources(companyId, options.agentId);
      const agentAllowedIds = access.mode === "none" ? [] : access.effectiveDataSourceIds || [];
      authorizedDataSourceIds = authorizedDataSourceIds
        ? authorizedDataSourceIds.filter((id) => agentAllowedIds.includes(id))
        : agentAllowedIds;
    }
    if (authorizedDataSourceIds) {
      const allowed = new Set(authorizedDataSourceIds);
      allSources = allSources.filter((source) => allowed.has(source.id));
      tables = tables.filter((table) => allowed.has(table.dataSourceId));
    }
    if (options?.tableIds) {
      const selectedTableIds = new Set(options.tableIds);
      tables = tables.filter((table) => selectedTableIds.has(table.id));
      const selectedSourceIds = new Set(tables.map((table) => table.dataSourceId));
      allSources = allSources.filter((source) => selectedSourceIds.has(source.id));
    }
    const authzFingerprint = options?.authzFingerprint || makeDataSourceCacheKey([
      "data-agent-acl",
      options?.agentId || "internal-company-scope",
      ...(authorizedDataSourceIds ? [...authorizedDataSourceIds].sort() : ["all-company-sources"]),
    ]);

    if (options?.collectionId) {
      const colSources = allSources.filter((s) => s.collectionId === options.collectionId);
      if (colSources.length > 0) {
        allSources = colSources;
        const sourceIds = new Set(colSources.map((s) => s.id));
        tables = tables.filter((t) => sourceIds.has(t.dataSourceId));
      }
    }

    if (allSources.length === 0 && tables.length === 0) {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: "Query internal data sources",
        resultsSummary: "No internal data sources or tables currently available in this company.",
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }

    const queryLower = query.toLowerCase();

    // 1. Dynamic Entity Lookup & Profiling Detection
    // Collect all known entity names from onboarded tables' semantic models and table names
    const knownEntities = new Set<string>();
    for (const t of tables) {
      const sModel: any = t.semanticModel || {};
      for (const ent of sModel.entities || []) {
        if (typeof ent === "string" && ent.length >= 2) knownEntities.add(ent.toLowerCase());
      }
      const cleaned = t.tableName.replace(/^(tbl_|mst_|dim_|fact_|trx_|sys_|ref_|t_|m_|f_|v_)/i, "").toLowerCase();
      for (const part of cleaned.split(/[\s_\-]+/)) {
        if (part.length >= 2) knownEntities.add(part);
      }
    }

    const matchesKnownEntity = Array.from(knownEntities).some((ent) => queryLower.includes(ent));
    const hasLookupVerb =
      /^(profiling|profil|cari|carikan|info|data|detail|cek|siapa|tampilkan|lookup|find|show|status)\b/i.test(query.trim()) ||
      queryLower.includes("profil") ||
      queryLower.includes("profiling") ||
      queryLower.includes("detail");

    // Also check with TypeSafe Jev System One if ambiguous
    let isProfiling = matchesKnownEntity || hasLookupVerb;
    if (!isProfiling) {
      try {
        const jevCheck = await this.jevService.systemOne(
          { user_query: query },
          {
            is_entity_lookup: {
              type: "noul",
              instructions: "Apakah query ini menanyakan informasi spesifik, profil, atribut, atau status dari suatu entitas/objek dalam basis data?",
            },
          },
        );
        const ans = jevCheck.answers["is_entity_lookup"] as any;
        if (ans && ans.noul >= 0.5) isProfiling = true;
      } catch {
        // use heuristic
      }
    }

    // 2. Dynamic Entity Profiling Across All Connected External Databases & Tables
    // Snapshot routing has already selected a complete, validated ClickHouse
    // copy for this request. Keep the selective live lookup path for fresh
    // entity lookups, but do not let this heuristic bypass the chosen engine.
    if (isProfiling && options?.preferredMode !== "snapshot") {
      const dbSources = allSources.filter(
        (s) => s.sourceType === "mariadb" || s.sourceType === "mysql" || s.sourceType === "postgres",
      );

      // 1. Clean generic conversational lead-in phrases (command/intent verbs and generic entity nouns)
      const cleanQuery = query
        .replace(/^(profiling|profil|tolong\s+profiling|cari\s+profil|carikan|cari|info|data|tampilkan|detail|siapa|cek|search|lookup|find|show)\s+/i, "")
        .replace(/^(perusahaan|organisasi|entitas|koperasi|badan\s+hukum|yayasan|pt|cv)\s+/i, "")
        .replace(/[?.,!]+$/, "")
        .trim();

      if (cleanQuery.length >= 2) {
        const allCheckedTables: string[] = [];
        for (const dbSource of dbSources) {
          const dsTables = tables.filter((t) => t.dataSourceId === dbSource.id);
          const quote = dbSource.sourceType === "postgres" ? `"` : "`";

          // Sort tables: prioritize fact/dimension tables and entity-matched tables ahead of audit/sync logs
          const sortedTables = [...dsTables].sort((a, b) => {
            const semA: any = a.semanticModel || {};
            const semB: any = b.semanticModel || {};
            const roleWeight = (role?: string) => {
              if (role === "fact_table") return 4;
              if (role === "dimension_table") return 3;
              if (role === "lookup_table") return 2;
              if (role === "audit_log") return 0;
              return 1;
            };
            const weightA = roleWeight(semA.tableRole);
            const weightB = roleWeight(semB.tableRole);
            return weightB - weightA;
          });

          // Prune tables: prioritize tables whose entities or table name match query terms
          const relevantTables = sortedTables.filter((tbl) => {
            const semModel = (tbl.semanticModel as any) || {};
            const tableEntities: string[] = (semModel.entities || []).concat(
              tbl.tableName.replace(/^(tbl_|table_|tb_|m_|t_)/i, "").split(/[\s_\-]+/)
            ).filter((e: string) => e && e.length > 1);

            const matchesEntity = tableEntities.some(
              (ent) => queryLower.includes(ent.toLowerCase()) || cleanQuery.toLowerCase().includes(ent.toLowerCase())
            );
            const matchesTableName = queryLower.includes(tbl.tableName.toLowerCase());
            return matchesEntity || matchesTableName;
          });

          // Focus search on matching tables, or at most the top 2 sorted tables
          const targetTables = relevantTables.length > 0 ? relevantTables : sortedTables.slice(0, 2);
          for (const t of targetTables) {
            allCheckedTables.push(t.tableName);
          }

          const isNumericTerm = /^\d+$/.test(cleanQuery);

          for (const tbl of targetTables) {
            const cols = (tbl.schemaDefinition as any[]) || [];
            const semModel = (tbl.semanticModel as any) || {};

            // Dynamic searchable columns: prioritize primary text/identity columns, limit to top 3
            const searchableCols = cols.filter((c: any) => {
              // Type matching guard: prevent MySQL string-to-zero type coercion bug on numeric columns!
              if (!isNumericTerm && (c.dataType === "number" || c.dataType === "integer" || c.dataType === "float")) {
                return false;
              }
              if (semModel.searchableColumns && semModel.searchableColumns.includes(c.name)) {
                return true;
              }
              return (
                c.isSearchable ||
                c.role === "identifier" ||
                c.semanticCategory === "identity" ||
                /^(nama_|nama$|name$|_name|title|judul|kode_|code|label)/i.test(c.name)
              );
            }).slice(0, 3);
            const searchableColNames: string[] = searchableCols.map((c: any) => c.name);

            // Dynamic candidate search terms:
            // Check if cleanQuery starts with any entity name defined for this table (e.g. "Pelanggan", "Perseroan", "Produk", "Vendor")
            const tableEntities: string[] = (semModel.entities || []).concat(
              tbl.tableName.replace(/^(tbl_|table_|tb_|m_|t_)/i, "").split(/[\s_\-]+/)
            ).filter((e: string) => e && e.length > 1);

            const candidateTerms: string[] = [cleanQuery];
            const strippedLeadIn = cleanQuery.replace(/^(perusahaan|organisasi|entitas|koperasi|badan\s+hukum|yayasan|pt|cv)\s+/i, "").trim();
            if (strippedLeadIn && !candidateTerms.includes(strippedLeadIn)) {
              candidateTerms.push(strippedLeadIn);
            }
            const coreName = (strippedLeadIn || cleanQuery).trim();
            if (coreName.length >= 2) {
              const upper = coreName.toUpperCase();
              if (!candidateTerms.includes(upper)) candidateTerms.push(upper);
              if (!candidateTerms.includes(`PT ${upper}`)) candidateTerms.push(`PT ${upper}`);
              if (!candidateTerms.includes(`PT. ${upper}`)) candidateTerms.push(`PT. ${upper}`);
              if (!candidateTerms.includes(`KOPERASI ${upper}`)) candidateTerms.push(`KOPERASI ${upper}`);
            }

            // If the clean query starts with an entity word known to this table, also generate stripped candidate
            for (const ent of tableEntities) {
              const entRegex = new RegExp(`^${ent}\\s+`, "i");
              if (entRegex.test(cleanQuery)) {
                const stripped = cleanQuery.replace(entRegex, "").trim();
                if (stripped.length >= 2 && !candidateTerms.includes(stripped)) {
                  candidateTerms.push(stripped);
                }
              }
            }

            // Search across all candidate terms and searchable columns
            for (const sTerm of candidateTerms) {
              if (sTerm.length < 2) continue;

              for (const colName of searchableColNames) {
                try {
                  const escapedExact = sTerm.replace(/'/g, "''");
                  const schemaName = (semModel as any)?.schemaName;
                  const schemaPrefix = schemaName ? `${quote}${schemaName}${quote}.` : "";
                  // 1. Exact match
                  let sql = `SELECT * FROM ${schemaPrefix}${quote}${tbl.tableName}${quote} WHERE ${quote}${colName}${quote} = '${escapedExact}' LIMIT 5`;
                  let res = await this.dataSourcesService.querySql(companyId, dbSource.id, sql, 5, options?.signal, { statementTimeoutMs: 10_000 });

                  // 2. Prefix match fallback if exact match returns 0 rows
                  if (res.rows.length === 0) {
                    const prefixTerm = sTerm.split(" ").slice(0, 2).join(" ");
                    sql = `SELECT * FROM ${schemaPrefix}${quote}${tbl.tableName}${quote} WHERE ${quote}${colName}${quote} LIKE '${prefixTerm.replace(/'/g, "''")}%' LIMIT 5`;
                    res = await this.dataSourcesService.querySql(companyId, dbSource.id, sql, 5, options?.signal, { statementTimeoutMs: 10_000 });
                  }

                  if (res.rows.length > 0) {
                    const matchedRow = res.rows[0];
                    const summary = this.formatDynamicEntityProfile(
                      matchedRow,
                      tbl.tableName,
                      dbSource.name,
                      cols,
                      semModel.jsonStructures,
                      semModel.entities
                    );
                    const trace = tracer.finish({
                      engine: dbSource.sourceType === "postgres" ? "postgres" : "mysql",
                      outcome: "success",
                    });
                    return {
                      agent: "data_agent",
                      task: `Profil entitas internal: ${matchedRow[colName] || sTerm}`,
                      query: sql,
                      resultsSummary: summary,
                      dataPreview: res.rows,
                      traceId: trace.traceId,
                      stageTimings: trace.timings,
                    };
                  }
                } catch (err: any) {
                  // Table/column query error logged quietly, continue to next candidate table
                  console.warn(`[DataAgent] Dynamic query on ${tbl.tableName}.${colName} error:`, err.message);
                }
              }
            }
          }
        }

        if (allCheckedTables.length > 0) {
          const uniqueChecked = Array.from(new Set(allCheckedTables));
          const trace = tracer.finish({
            engine: dbSources[0]?.sourceType === "postgres" ? "postgres" : "mysql",
            outcome: "success",
          });
          return {
            agent: "data_agent",
            task: `Pencarian entitas: ${cleanQuery}`,
            resultsSummary: `### 🔍 Hasil Pencarian Entitas: "${cleanQuery}"\n\nPencarian telah dilakukan secara otomatis pada tabel kandidat terkait:\n${uniqueChecked.map((t) => `- **\`${t}\`**: Tidak ditemukan catatan yang cocok dengan nama atau awalan tersebut.`).join("\n")}\n\n*Catatan: Tidak ada data profil yang terdaftar dengan nama tersebut dalam database yang terhubung (${dbSources.map(s => s.name).join(", ")}).*`,
            dataPreview: [],
            traceId: trace.traceId,
            stageTimings: trace.timings,
          };
        }
      }
    }

    // 2b. Dynamic Multi-Table SQL Reasoning & Execution for External Databases & ClickHouse
    const dbSources = allSources.filter(
      (s) => s.sourceType === "mariadb" || s.sourceType === "mysql" || s.sourceType === "postgres" || s.sourceType === "clickhouse",
    );

    // The orchestrator may select an already-published ClickHouse snapshot
    // for this request. Do not let the legacy dynamic-SQL lane bypass that
    // route and reopen a potentially slow external connection.
    if (dbSources.length > 0 && options?.preferredMode !== "snapshot") {
      // Find candidate DB source matching user query or first available DB source
      let targetDbSource = dbSources[0];
      for (const dbs of dbSources) {
        if (queryLower.includes(dbs.name.toLowerCase())) {
          targetDbSource = dbs;
          break;
        }
      }

      const dbTables = tables.filter((t) => t.dataSourceId === targetDbSource.id);
      // Check if user query matches topics, tables, or entities in this database
      const hasDbRelevance = dbTables.some((t) => {
        const tName = t.tableName.toLowerCase();
        if (queryLower.includes(tName)) return true;
        const sem = (t.semanticModel as any) || {};
        for (const ent of sem.entities || []) {
          if (queryLower.includes(String(ent).toLowerCase())) return true;
        }
        return false;
      }) || queryLower.includes(targetDbSource.name.toLowerCase()) || dbSources.length === 1;

      if (dbTables.length > 0 && hasDbRelevance) {
        const tablesInput = dbTables.map((t) => ({
          tableName: t.tableName,
          columns: (t.schemaDefinition as any[]) || [],
          relationships: ((t.semanticModel as any)?.relationships || []) as any[],
        }));

        let previousError: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const sqlDecision = await aiReasoningService.generateDynamicSqlQuery({
              userQuery: query,
              dbType: targetDbSource.sourceType,
              tables: tablesInput,
              previousError,
              signal: options?.signal,
            });

            if (sqlDecision?.sql) {
              // P1-04: Validate LLM-generated dynamic SQL against schema and authorized sources
              const sqlTableMatches = Array.from(sqlDecision.sql.matchAll(/\b(?:from|join)\s+([a-zA-Z0-9_."]+)/gi))
                .map((m) => m[1].replace(/["`]/g, "").split(".").pop() || "")
                .filter(Boolean);

              const validator = new DataSourcePlanValidator();
              const planValidation = validator.validatePlan({
                companyId,
                allowedDataSourceIds: [targetDbSource.id],
                tables: dbTables.map((t) => ({
                  id: t.id,
                  tableName: t.tableName,
                  dataSourceId: t.dataSourceId,
                  schemaDefinition: (t.schemaDefinition as any[]) || [],
                  rowCount: t.rowCount || 0,
                })),
                referencedTables: sqlTableMatches.length > 0 ? sqlTableMatches : dbTables.map((t) => t.tableName),
                referencedColumns: [],
              });

              if (!planValidation.valid) {
                throw new Error(`Plan validation failed for generated SQL: ${planValidation.errors.join("; ")}`);
              }

              const res = await this.dataSourcesService.querySql(companyId, targetDbSource.id, sqlDecision.sql, 25, options?.signal, { statementTimeoutMs: 20_000 });
              if (res && res.rows && res.rows.length > 0) {
                let summary = `### Hasil Query Analitik Database: ${targetDbSource.name}\n\n`;
                summary += `> **Strategi Query:** ${sqlDecision.explanation}\n`;
                summary += `> \`\`\`sql\n> ${res.sql || sqlDecision.sql}\n> \`\`\`\n\n`;

                const headers = res.columns || Object.keys(res.rows[0] || {});
                summary += `| ${headers.join(" | ")} |\n`;
                summary += `| ${headers.map(() => "---").join(" | ")} |\n`;
                for (const row of res.rows.slice(0, 15)) {
                  const line = headers.map((h) => {
                    const val = (row as any)[h];
                    if (typeof val === "number") return val.toLocaleString();
                    return String(val ?? "-");
                  });
                  summary += `| ${line.join(" | ")} |\n`;
                }

                if (res.rowCount > 15) {
                  summary += `\n*(Menampilkan 15 teratas dari ${res.rowCount} total baris &bull; Waktu eksekusi: ${res.executionTimeMs || 10}ms)*\n`;
                }

                const trace = tracer.finish({
                  engine: targetDbSource.sourceType === "postgres" ? "postgres" : "mysql",
                  outcome: "success",
                });
                return {
                  agent: "data_agent",
                  task: `Eksekusi SQL analitik pada ${targetDbSource.name}`,
                  query: sqlDecision.sql,
                  resultsSummary: summary,
                  dataPreview: res.rows,
                  traceId: trace.traceId,
                  stageTimings: trace.timings,
                };
              }
            }
          } catch (err: any) {
            previousError = err.message;
            console.warn(`[DataAgent] Dynamic SQL attempt ${attempt} failed:`, err.message);
          }
        }
      }
    }

    // 3. Handle Tabular Analytics (CSV / Excel / Structured metrics)
    if (tables.length === 0) {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: "Query structured database",
        resultsSummary: "Data tidak ditemukan dalam tabel internal yang aktif.",
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }

    // 3. Multi-table evaluation: score ALL tables to pick the best candidate based on tokens, entities, metrics, dimensions, and sample values
    let bestTable: (typeof tables)[0] | null = null;
    let bestScore = 0;

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

    if (!bestTable || bestScore <= 0) {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: "Analisis Data Internal",
        resultsSummary: "Pertanyaan tidak cocok dengan topik, tabel, atau metrik yang tersedia dalam data source saat ini.",
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }

    let matchedMetric: string | undefined;
    let matchedDimension: string | undefined;
    let unverifiedGroupBy: string | undefined;
    let matchedAggregation: "sum" | "avg" | "count" | "min" | "max" = "sum";

    // Use Jev for structured metric decision on the best candidate table
    const semModel: any = bestTable.semanticModel || {};
    const columnDefinitions = (bestTable.schemaDefinition as any[]) || [];
    const metricBindings = resolveSemanticMetricBindings(
      semModel.metrics || [],
      columnDefinitions,
      semModel.synonyms || {},
    );
    const knownMetricColumns = new Set(metricBindings.map((binding) => binding.column.toLowerCase()));
    for (const column of columnDefinitions) {
      if (column.role === "metric" && typeof column.name === "string" && !knownMetricColumns.has(column.name.toLowerCase())) {
        metricBindings.push({ name: column.name, column: column.name, synonyms: [] });
        knownMetricColumns.add(column.name.toLowerCase());
      }
    }
    const metricNames = metricBindings.map((binding) => binding.name);
    const dimensionBindings = resolveSemanticDimensionBindings(
      semModel.dimensions || [],
      columnDefinitions,
      semModel.synonyms || {},
    );
    const dimNames = dimensionBindings.map((dimension) => dimension.name);
    const requestedDimension = resolveRequestedDimension(query, dimensionBindings);
    if (requestedDimension.status === "ambiguous" || requestedDimension.status === "unmatched") {
      const trace = tracer.finish({ outcome: "abstained" });
      const detail = requestedDimension.status === "ambiguous"
        ? `Dimensi pengelompokan ambigu (${requestedDimension.names.join(", ")}).`
        : "Dimensi pengelompokan yang diminta tidak memiliki binding kolom terverifikasi.";
      return {
        agent: "data_agent",
        task: `Analisis Data (${bestTable.tableName})`,
        resultsSummary: `${detail} Query tidak dijalankan agar hasil agregasi tidak salah dikelompokkan.`,
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }
    if (requestedDimension.status === "resolved") matchedDimension = requestedDimension.column;

    const normalizedQuery = queryLower.replace(/[^a-z0-9]+/g, "");
    const explicitMetricBindings = metricBindings.filter((binding) => {
      const values = [binding.column, binding.name, ...binding.synonyms]
        .map((value) => String(value).trim())
        .filter((value) => value.length >= 3);
      return values.some((value) => queryLower.includes(value.toLowerCase())
        || normalizedQuery.includes(value.toLowerCase().replace(/[^a-z0-9]+/g, "")));
    });
    const aggregationFromQuestion = /\b(rata-rata|average|mean|avg)\b/i.test(query)
      ? "avg"
      : /\b(tertinggi|highest|max(?:imum)?)\b/i.test(query)
        ? "max"
        : /\b(terendah|lowest|min(?:imum)?)\b/i.test(query)
          ? "min"
          : /\b(berapa banyak|jumlah baris|total baris|count|hit(?:ung)?)\b/i.test(query)
            ? "count"
            : /\b(total|jumlah|sum|biaya|cost|omzet|revenue|sales)\b/i.test(query)
              ? "sum"
              : undefined;

    // Exact physical-column and unambiguous semantic-label matches are
    // deterministic; avoid an extra model call for those common queries.
    if (explicitMetricBindings.length === 1) {
      matchedMetric = explicitMetricBindings[0].column;
      if (aggregationFromQuestion) matchedAggregation = aggregationFromQuestion;
    } else if (metricNames.length > 0) {
      try {
        const jevMetricDecision = await this.jevService.decideStructuredMetric(
          query,
          metricNames,
          dimNames,
        );
        const requestedMetric = jevMetricDecision.metric || undefined;
        const matchedBinding = metricBindings.find((binding) => binding.name.toLowerCase() === String(requestedMetric || "").toLowerCase()
          || binding.column.toLowerCase() === String(requestedMetric || "").toLowerCase());
        matchedMetric = matchedBinding?.column;
        if (aggregationFromQuestion) matchedAggregation = aggregationFromQuestion;
        else if (["sum", "avg", "count", "min", "max"].includes(jevMetricDecision.aggregation)) {
          matchedAggregation = jevMetricDecision.aggregation;
        }
        if (!matchedDimension && jevMetricDecision.groupBy) {
          const dimensionBinding = resolveDimensionBinding(jevMetricDecision.groupBy, dimensionBindings);
          matchedDimension = dimensionBinding?.column;
          if (!dimensionBinding) unverifiedGroupBy = jevMetricDecision.groupBy;
        }
      } catch {
        // fallback to keyword matching
      }
    }

    if (unverifiedGroupBy) {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: `Analisis Data (${bestTable.tableName})`,
        resultsSummary: `Jev mengusulkan pengelompokan '${unverifiedGroupBy}' yang tidak terikat ke kolom terverifikasi. Query tidak dijalankan.`,
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
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

      for (const binding of metricBindings) {
        const identities = [binding.name, binding.column, ...binding.synonyms];
        if (identities.some((identity) => queryLower.includes(identity.toLowerCase()))) {
          matchedMetric = binding.column;
          break;
        }
      }

      for (const d of semModel.dimensions || []) {
        const dName = d.name.toLowerCase();
        if (queryLower.includes(dName)) {
          matchedDimension = d.name;
          break;
        }
      }

      if (!matchedMetric && (matchedAggregation === "count" || /berapa banyak|jumlah baris|total baris|count/i.test(queryLower))) {
        matchedAggregation = "count";
        matchedMetric = metricBindings[0]?.column || "*";
      }
    }

    if (!matchedMetric && matchedAggregation !== "count") {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: `Analisis Data (${bestTable.tableName})`,
        resultsSummary: `Metrik yang dimaksud dalam pertanyaan tidak ditemukan pada tabel ${bestTable.tableName}. Kolom/metrik yang tersedia: ${(semModel.metrics || []).map((m: any) => m.name).join(", ") || "tidak ada"}.`,
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }

    // Detect exact sample value filters from dimensions (e.g., wilayah = "Jakarta")
    const detectedFilter: Record<string, any> = {};
    for (const d of semModel.dimensions || []) {
      for (const val of d.sampleValues || []) {
        const valStr = String(val);
        if (valStr.length >= 3 && queryLower.includes(valStr.toLowerCase())) {
          detectedFilter[d.name] = valStr;
        }
      }
    }

    const temporalRange = resolveTemporalRangeFilter(query, columnDefinitions);
    if (temporalRange.status === "unsafe") {
      const trace = tracer.finish({ outcome: "abstained" });
      return {
        agent: "data_agent",
        task: `Analisis Data (${bestTable.tableName})`,
        resultsSummary: `${temporalRange.reason} Tabel yang cocok adalah ${bestTable.tableName}; saya tidak akan menghitung tanpa filter periode yang dapat diverifikasi.`,
        traceId: trace.traceId,
        stageTimings: trace.timings,
      };
    }
    if (temporalRange.status === "resolved") {
      detectedFilter[temporalRange.column] = { gte: temporalRange.gte, lt: temporalRange.lt };
    }

    const structuredFilter = Object.keys(detectedFilter).length > 0 ? detectedFilter : undefined;
    const periodDescription = temporalRange.status === "resolved"
      ? ` (period: ${temporalRange.label} on ${temporalRange.column})`
      : "";

    const bestSource = allSources.find((source) => source.id === bestTable.dataSourceId);
    const snapshot = (bestTable.semanticModel as any)?.externalSnapshot;
    const freshnessSensitive = /\b(latest|current|live|real[ -]?time|sekarang|terkini|hari ini|saat ini|terbaru)\b/i.test(query);
    const queryMode: "live" | "snapshot" = options?.preferredMode ?? (
      bestSource && ["postgres", "mysql", "mariadb"].includes(bestSource.sourceType)
        && bestTable.rowCount >= 100_000
        && Boolean(matchedMetric)
        && snapshot?.status === "ready"
        && !freshnessSensitive
        ? "snapshot"
        : "live"
    );

    // 4. Execute deterministic query on table
    let queryResult;
    const querySourceDescription = queryMode === "snapshot" && (snapshot?.lastIncrementalAt || snapshot?.completedAt)
      ? (() => {
          const capturedAt = snapshot.lastIncrementalAt || snapshot.completedAt;
          const timestampMode = snapshot.syncMode === "incremental";
          const consistency = timestampMode ? "best-effort timestamp consistency" : "best-effort keyset consistency";
          const deletionNote = snapshot.deleteSemantics === "soft_delete_column"
            ? "soft-delete tombstones are applied; hard deletes require full reconciliation"
            : "hard deletes after this snapshot may remain until full reconciliation";
          return `using the published ClickHouse ${timestampMode ? "incremental snapshot" : "full snapshot"} captured at ${new Date(capturedAt).toLocaleString()} (${consistency}; ${deletionNote})`;
        })()
      : "using a live source query";
    let queryDescription = "";
    const filterDesc = Object.keys(detectedFilter).length > 0
      ? ` (filter: ${JSON.stringify(detectedFilter)})`
      : "";

    if (matchedMetric && matchedDimension) {
      queryDescription = `Aggregate ${matchedAggregation}(${matchedMetric}) grouped by ${matchedDimension} on table '${bestTable.tableName}'${filterDesc}${periodDescription}; ${querySourceDescription}`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        filter: structuredFilter,
        aggregate: {
          column: matchedMetric,
          fn: matchedAggregation,
          groupBy: matchedDimension,
        },
        mode: queryMode,
        limit: 15,
        authzFingerprint,
        signal: options?.signal,
      });
    } else if (matchedMetric) {
      queryDescription = `Compute ${matchedAggregation}(${matchedMetric}) on table '${bestTable.tableName}'${filterDesc}${periodDescription}; ${querySourceDescription}`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        filter: structuredFilter,
        aggregate: {
          column: matchedMetric,
          fn: matchedAggregation,
        },
        mode: queryMode,
        authzFingerprint,
        signal: options?.signal,
      });
    } else {
      queryDescription = `Preview top records from table '${bestTable.tableName}' using live source query`;
      queryResult = await this.dataSourcesService.queryTable(companyId, bestTable.id, {
        limit: 10,
        authzFingerprint,
        signal: options?.signal,
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

    const trace = tracer.finish({
      engine: queryMode === "snapshot" ? "clickhouse" : (bestSource?.sourceType as any) || "fast_path",
      outcome: "success",
    });

    return {
      agent: "data_agent",
      task: queryDescription,
      query: queryDescription,
      resultsSummary: summary,
      dataPreview: queryResult.rows,
      traceId: trace.traceId,
      stageTimings: trace.timings,
    };
  }

  /**
   * Dynamically formats any entity record from any database table into a rich, structured Markdown profile.
   * Discovers primary identifiers, attributes, dates, financial values, locations, and parses nested JSON arrays/objects.
   */
  public formatDynamicEntityProfile(
    row: any,
    tableName: string,
    sourceName: string,
    columns: any[] = [],
    jsonStructures?: any,
    entities?: string[]
  ): string {
    if (!row || typeof row !== "object") return "Data record kosong.";

    const keys = Object.keys(row);
    const handledKeys = new Set<string>();

    // 1. Identify Entity Name / Title
    let titleVal = "";
    let titleCol = "";
    for (const c of columns) {
      if (c.role === "identifier" || c.semanticCategory === "identity" || /^(nama_|nama$|name$|_name|title|judul|label)/i.test(c.name)) {
        if (row[c.name] && String(row[c.name]).trim().length > 0) {
          titleVal = String(row[c.name]).trim();
          titleCol = c.name;
          break;
        }
      }
    }
    if (!titleVal) {
      const fallbackKey = keys.find((k) => /^(nama|name|title|judul|code|kode)/i.test(k) && row[k]);
      if (fallbackKey) {
        titleVal = String(row[fallbackKey]).trim();
        titleCol = fallbackKey;
      } else {
        titleVal = row[keys[0]] ? String(row[keys[0]]) : tableName;
      }
    }
    if (titleCol) handledKeys.add(titleCol);

    let out = `### Profil Data: ${titleVal}\n\n`;
    out += `> **Status Data:** Terverifikasi 100% dari Sumber Data Internal (**${sourceName}** &mdash; \`${tableName}\`).\n`;
    out += `> *Pengambilan data dilakukan secara lokal dari database resmi tanpa menggunakan pencarian publik eksternal.*\n\n`;

    // 2. Identify and Parse JSON Columns
    const jsonFields: { key: string; label: string; data: any }[] = [];
    for (const k of keys) {
      const colDef = columns.find((c) => c.name === k);
      let isJson = colDef?.semanticCategory === "nested_structure" || colDef?.isJson || colDef?.dataType === "json";
      let parsedData: any = null;

      if (jsonStructures && jsonStructures[k]) {
        isJson = true;
      }

      const val = row[k];
      if (val && typeof val === "object") {
        isJson = true;
        parsedData = val;
      } else if (typeof val === "string" && (val.trim().startsWith("[") || val.trim().startsWith("{"))) {
        try {
          parsedData = JSON.parse(val);
          isJson = true;
        } catch {
          // not valid json
        }
      }

      if (isJson && parsedData) {
        handledKeys.add(k);
        jsonFields.push({
          key: k,
          label: colDef?.humanLabel || this.humanizeLabel(k),
          data: parsedData,
        });
      }
    }

    // 3. Location / Domisili / Alamat (from semanticCategory === "location")
    const locationKeys = keys.filter((k) => {
      if (handledKeys.has(k)) return false;
      const colDef = columns.find((c) => c.name === k);
      return colDef?.semanticCategory === "location" || this.getOrDeduceCategory(k, colDef) === "location";
    });
    let locationParts: string[] = [];
    for (const lk of locationKeys) {
      handledKeys.add(lk);
      if (row[lk] && String(row[lk]).trim() !== "" && String(row[lk]).trim() !== "-") {
        locationParts.push(String(row[lk]).trim());
      }
    }

    // 4. Financial / Permodalan / Nilai / Metrik (from semanticCategory === "financial" or role === "metric")
    const financialKeys = keys.filter((k) => {
      if (handledKeys.has(k)) return false;
      const colDef = columns.find((c) => c.name === k);
      return colDef?.semanticCategory === "financial" || colDef?.role === "metric" || this.getOrDeduceCategory(k, colDef) === "financial";
    });
    const financialEntries: { label: string; value: string }[] = [];
    for (const fk of financialKeys) {
      handledKeys.add(fk);
      const val = row[fk];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        const num = Number(val);
        const valStr = !isNaN(num) && typeof val !== "boolean"
          ? (num >= 1000 ? `Rp ${num.toLocaleString("id-ID")}` : num.toLocaleString("id-ID"))
          : String(val);
        const colDef = columns.find((c) => c.name === fk);
        financialEntries.push({ label: colDef?.humanLabel || this.humanizeLabel(fk), value: valStr });
      }
    }

    // 5. Contact / Kontak & Komunikasi (from semanticCategory === "contact")
    const contactKeys = keys.filter((k) => {
      if (handledKeys.has(k)) return false;
      const colDef = columns.find((c) => c.name === k);
      return colDef?.semanticCategory === "contact" || this.getOrDeduceCategory(k, colDef) === "contact";
    });
    const contactEntries: { label: string; value: string }[] = [];
    for (const ck of contactKeys) {
      handledKeys.add(ck);
      const val = row[ck];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        const colDef = columns.find((c) => c.name === ck);
        contactEntries.push({ label: colDef?.humanLabel || this.humanizeLabel(ck), value: String(val) });
      }
    }

    // 6. Identity & Status Attributes (from semanticCategory === "identity" | "status" or role === "identifier")
    const identityKeys = keys.filter((k) => {
      if (handledKeys.has(k)) return false;
      const colDef = columns.find((c) => c.name === k);
      const cat = colDef?.semanticCategory || this.getOrDeduceCategory(k, colDef);
      return cat === "identity" || cat === "status" || colDef?.role === "identifier";
    });
    const identityEntries: { label: string; value: string }[] = [];
    for (const ik of identityKeys) {
      handledKeys.add(ik);
      const val = row[ik];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        let valStr = String(val);
        if (/tanggal|date|tgl/i.test(ik) && !isNaN(Date.parse(valStr))) {
          valStr = new Date(valStr).toLocaleDateString("id-ID", { dateStyle: "long" });
        } else if (/status/i.test(ik)) {
          valStr = valStr.toUpperCase();
        } else if (/nomor|no_|sk|npwp|id|kode|akta/i.test(ik)) {
          valStr = `\`${valStr}\``;
        }
        const colDef = columns.find((c) => c.name === ik);
        identityEntries.push({ label: colDef?.humanLabel || this.humanizeLabel(ik), value: valStr });
      }
    }

    // 7. Temporal Attributes (from semanticCategory === "temporal" or role === "timestamp")
    const temporalKeys = keys.filter((k) => {
      if (handledKeys.has(k)) return false;
      const colDef = columns.find((c) => c.name === k);
      const cat = colDef?.semanticCategory || this.getOrDeduceCategory(k, colDef);
      return cat === "temporal" || colDef?.role === "timestamp";
    });
    const temporalEntries: { label: string; value: string }[] = [];
    for (const tk of temporalKeys) {
      handledKeys.add(tk);
      const val = row[tk];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        let valStr = String(val);
        if (!isNaN(Date.parse(valStr)) && valStr.length > 5) {
          valStr = new Date(valStr).toLocaleDateString("id-ID", { dateStyle: "long" });
        }
        const colDef = columns.find((c) => c.name === tk);
        temporalEntries.push({ label: colDef?.humanLabel || this.humanizeLabel(tk), value: valStr });
      }
    }

    // Render 1: Identitas & Legalitas
    out += `#### 1. Identitas & Atribut Utama\n`;
    out += `- **Nama / Entitas:** ${titleVal}\n`;
    for (const entry of identityEntries) {
      out += `- **${entry.label}:** ${entry.value}\n`;
    }
    out += `\n`;

    // Render 2: Domisili & Lokasi
    if (locationParts.length > 0) {
      out += `#### 2. Domisili & Lokasi\n`;
      out += `- **Alamat / Lokasi:** ${locationParts.join(", ")}\n\n`;
    }

    // Render 3: Keuangan & Permodalan
    if (financialEntries.length > 0) {
      out += `#### 3. Metrik & Finansial\n`;
      for (const entry of financialEntries) {
        out += `- **${entry.label}:** **${entry.value}**\n`;
      }
      out += `\n`;
    }

    // Render 4: Kontak & Komunikasi
    if (contactEntries.length > 0) {
      out += `#### 4. Kontak & Komunikasi\n`;
      for (const entry of contactEntries) {
        out += `- **${entry.label}:** ${entry.value}\n`;
      }
      out += `\n`;
    }

    // Render 5: Waktu & Periode
    if (temporalEntries.length > 0) {
      out += `#### 5. Waktu & Periode\n`;
      for (const entry of temporalEntries) {
        out += `- **${entry.label}:** ${entry.value}\n`;
      }
      out += `\n`;
    }

    // Render 4: JSON Bersarang (Pengurus/Saham/KBLI/Line Items)
    let sectionIdx = 4;
    for (const jf of jsonFields) {
      const data = jf.data;
      if (Array.isArray(data) && data.length > 0) {
        // Flatten nested data arrays (e.g. [{id: 1, data: [{...}]}])
        let flatItems: any[] = [];
        for (const item of data) {
          if (item && Array.isArray(item.data)) {
            flatItems.push(...item.data);
          } else if (item) {
            flatItems.push(item);
          }
        }

        if (flatItems.length > 0) {
          // Case A: Susunan Pengurus / Pemegang Saham
          const isShareholderLike = flatItems.some(
            (it) => it.nama_badan_hukum || it.nama || it.jabatan || it.jumlah_lembar || it.lembar
          );
          if (isShareholderLike) {
            out += `#### ${sectionIdx}. Susunan ${jf.label}\n`;
            out += `| Nama Lengkap / Badan Usaha | Jabatan | Saham / Lembar | Nilai Nominal | Kontak / Detail |\n`;
            out += `|---|---|---|---|---|\n`;
            for (const it of flatItems) {
              const name = it.nama_badan_hukum || it.nama || "-";
              const jab = it.jabatan || "Anggota";
              const lembar = it.jumlah_lembar_saham_modal_ditempatkan || it.jumlah_lembar || it.lembar || "-";
              let nilai = it.total_harga_saham_yang_dipegang || it.total_nominal || it.nilai || "-";
              if (nilai !== "-" && !isNaN(Number(nilai))) {
                nilai = `Rp ${Number(nilai).toLocaleString("id-ID")}`;
              }
              const contact = it.email || it.telepon || it.npwp || "-";
              out += `| **${name}** | ${jab} | ${lembar} | ${nilai} | ${contact} |\n`;
            }
            out += `\n`;
            sectionIdx++;
            continue;
          }

          // Case B: KBLI / Kegiatan Usaha
          const isKbliLike = flatItems.some((it) => it.maksud || it.tujuan || (it.id && it.deskripsi));
          if (isKbliLike) {
            out += `#### ${sectionIdx}. ${jf.label}\n`;
            for (const k of flatItems.slice(0, 10)) {
              const tujuanStr = Array.isArray(k.tujuan) ? k.tujuan.slice(0, 2).join("; ") : (k.tujuan || "");
              out += `- **${k.id ? `KBLI ${k.id}:` : ""}** ${k.maksud || k.deskripsi || ""}${tujuanStr ? ` &mdash; *(${tujuanStr})*` : ""}\n`;
            }
            out += `\n`;
            sectionIdx++;
            continue;
          }

          // Case C: Generic Array of Objects -> Markdown Table
          if (typeof flatItems[0] === "object" && flatItems[0] !== null) {
            const tableKeys = Array.from(
              new Set(flatItems.flatMap((it) => (it && typeof it === "object" ? Object.keys(it) : [])))
            ).slice(0, 5);

            if (tableKeys.length > 0) {
              out += `#### ${sectionIdx}. ${jf.label}\n`;
              out += `| ${tableKeys.map((k) => this.humanizeLabel(k)).join(" | ")} |\n`;
              out += `| ${tableKeys.map(() => "---").join(" | ")} |\n`;
              for (const it of flatItems.slice(0, 10)) {
                const rowCells = tableKeys.map((k) => {
                  const val = it[k];
                  if (val === undefined || val === null) return "-";
                  if (typeof val === "object") return JSON.stringify(val);
                  return String(val);
                });
                out += `| ${rowCells.join(" | ")} |\n`;
              }
              out += `\n`;
              sectionIdx++;
              continue;
            }
          }

          // Case D: Primitives array
          out += `#### ${sectionIdx}. ${jf.label}\n`;
          for (const it of flatItems.slice(0, 10)) {
            out += `- ${String(it)}\n`;
          }
          out += `\n`;
          sectionIdx++;
        }
      } else if (typeof data === "object" && data !== null) {
        // Single object key-values
        out += `#### ${sectionIdx}. ${jf.label}\n`;
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined && v !== null) {
            out += `- **${this.humanizeLabel(k)}:** ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`;
          }
        }
        out += `\n`;
        sectionIdx++;
      }
    }

    // Render 5: Remaining non-handled attributes
    const remainingKeys = keys.filter(
      (k) => !handledKeys.has(k) && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== ""
    );
    if (remainingKeys.length > 0) {
      out += `#### Informasi Tambahan\n`;
      for (const rk of remainingKeys.slice(0, 10)) {
        out += `- **${this.humanizeLabel(rk)}:** ${String(row[rk])}\n`;
      }
      out += `\n`;
    }

    return out;
  }

  private getOrDeduceCategory(key: string, colDef?: any): string {
    if (colDef?.semanticCategory) return colDef.semanticCategory;
    if (colDef?.role === "identifier") return "identity";
    if (colDef?.role === "metric") return "financial";
    if (colDef?.role === "timestamp") return "temporal";

    const lower = key.toLowerCase();
    if (/(^id$|_id$|^id_|nomor|no_|sk_|code|kode|sku|npwp|nik|reg)/i.test(lower)) return "identity";
    if (/(status|state|kondisi|active|aktif|flag|is_)/i.test(lower)) return "status";
    if (/(alamat|address|street|jalan|kelurahan|desa|kecamatan|kabupaten|kota|city|provinsi|province|state|country|negara|pos|zip|postal|region|wilayah)/i.test(lower)) return "location";
    if (/(modal|harga|price|nilai|total|amount|nominal|biaya|cost|omset|pendapatan|revenue|saldo|fee|tax|pajak|tarif|disetor|balance|salary|gaji)/i.test(lower)) return "financial";
    if (/(email|mail|phone|telepon|telp|hp|handphone|fax|mobile|kontak|contact|website|url)/i.test(lower)) return "contact";
    if (/(tanggal|date|tgl|created|updated|waktu|time|tahun|year|bulan|month|period|periode|timestamp)/i.test(lower)) return "temporal";
    if (/(jenis|tipe|type|category|kategori|kelompok|group|divisi|division|departemen|department|sektor|sector|role|jabatan|kbli)/i.test(lower)) return "classification";
    if (/(keterangan|deskripsi|description|catatan|notes|remark|memo|detail|bio|summary)/i.test(lower)) return "content";
    return "general";
  }

  private humanizeLabel(key: string): string {
    return key
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(" ")
      .map((word) => {
        const lower = word.toLowerCase();
        if (lower === "sk") return "SK";
        if (lower === "npwp") return "NPWP";
        if (lower === "id") return "ID";
        if (lower === "cv") return "CV";
        if (lower === "pt") return "PT";
        if (lower === "kbli") return "KBLI";
        if (lower === "tgl") return "Tanggal";
        if (lower === "no") return "Nomor";
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  private formatCompanyProfile(row: any, sourceName: string): string {
    const formatted = this.formatDynamicEntityProfile(row, "tbl_perseroan", sourceName);
    return formatted.replace("### Profil Data: ", "### Profil Data: PT ");
  }

  private formatCvProfile(row: any, sourceName: string): string {
    return this.formatDynamicEntityProfile(row, "ahu_cv", sourceName);
  }
}
