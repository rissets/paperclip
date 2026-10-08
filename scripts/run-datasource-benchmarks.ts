import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface LatencyMeasurement {
  workload: string;
  durationMs: number;
}

interface BenchmarkCategorySummary {
  category: string;
  samples: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

let clickHouseRequestCount = 0;

function calculatePercentiles(durations: number[]): { p50: number; p95: number; p99: number } {
  if (durations.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  return { p50, p95, p99 };
}

async function executeClickHouseQuery(query: string): Promise<{ rows: any[]; durationMs: number }> {
  const benchmarkUrl = process.env.CLICKHOUSE_BENCHMARK_URL ?? "http://127.0.0.1:18123";
  const database = process.env.CLICKHOUSE_BENCHMARK_DATABASE;
  const username = process.env.CLICKHOUSE_BENCHMARK_USER;
  const password = process.env.CLICKHOUSE_BENCHMARK_PASSWORD;
  if (!database || !username || !password) {
    throw new Error(
      "Set CLICKHOUSE_BENCHMARK_DATABASE, CLICKHOUSE_BENCHMARK_USER, and CLICKHOUSE_BENCHMARK_PASSWORD before running the ClickHouse microbenchmark.",
    );
  }

  const start = performance.now();
  const endpoint = new URL("/", benchmarkUrl);
  endpoint.searchParams.set("database", database);
  endpoint.searchParams.set("default_format", "JSON");
  clickHouseRequestCount += 1;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: query,
  });
  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse error: ${text}`);
  }
  const json: any = await res.json();
  return { rows: json.data || [], durationMs };
}

async function runBenchmark() {
  console.log("=== Starting direct ClickHouse datasource microbenchmark ===");
  console.log("Scope: direct HTTP SQL timings only; this does not measure Agent Data, Pi, coordinator, retrieval, or external-source latency.");
  console.log(`Host: ${os.platform()} ${os.arch()}, CPUs: ${os.cpus().length}, Mem: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GiB`);

  // Verify ClickHouse connectivity
  const chCheck = await executeClickHouseQuery("SELECT 1 as ping");
  console.log(`ClickHouse Ping OK (${chCheck.durationMs}ms)`);

  const directQueryDurations: number[] = [];
  const warmDurations: number[] = [];
  const fastPathDurations: number[] = [];

  const categorySummaries: BenchmarkCategorySummary[] = [];

  // Workload 1: Exact entity lookup
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT * FROM ds_e98c68308d38b3cab38770d8_01_site_master WHERE site_id = 'SITE-00${i + 1}' LIMIT 1`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "exact_entity_lookup",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 2: Count and Count-Distinct
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT count(*), uniq(node_id) FROM ds_5715e8409b1f35f1091185d3_09_core_network_kpi_hour`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "count_and_count_distinct",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 3: Sum / Min / Max temporal
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT sum(cpu_pct), min(cpu_pct), max(cpu_pct) FROM ds_5715e8409b1f35f1091185d3_09_core_network_kpi_hour WHERE timestamp >= '2026-08-01 00:00:00'`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "sum_min_max_temporal",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 4: Group by aggregation
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT node_id, node_type, avg(cpu_pct) as avg_cpu, count(*) as samples FROM ds_5715e8409b1f35f1091185d3_09_core_network_kpi_hour GROUP BY node_id, node_type ORDER BY avg_cpu DESC LIMIT 10`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "group_by_aggregation",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 5: Range comparison
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT count(*) FROM ds_5715e8409b1f35f1091185d3_09_core_network_kpi_hour WHERE cpu_pct BETWEEN 20 AND 80`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "range_comparison",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 6: Multi-table join (Site master + site opex)
  {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = `SELECT s.site_id, s.site_name, count(o.site_id) as opex_records, sum(o.total_opex_usd) as total_spent FROM ds_e98c68308d38b3cab38770d8_01_site_master s LEFT JOIN ds_f81b5ca18095d6e3f26abd4e_26_site_opex_cost o ON s.site_id = o.site_id GROUP BY s.site_id, s.site_name LIMIT 20`;
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      directQueryDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "multi_table_join",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 7: Warm plan cache simulation
  {
    const times: number[] = [];
    const q = `SELECT node_id, avg(cpu_pct) FROM ds_5715e8409b1f35f1091185d3_09_core_network_kpi_hour GROUP BY node_id LIMIT 5`;
    // First run to warm ClickHouse OS page cache and query cache
    await executeClickHouseQuery(q);
    for (let i = 0; i < 20; i++) {
      const res = await executeClickHouseQuery(q);
      times.push(res.durationMs);
      warmDurations.push(res.durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "warm_plan_cache",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  // Workload 8: Fast-Path Non-data / Presentation reuse simulation
  {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      // Fast path evaluation: regex match and memory lookup
      const isGreeting = /^(halo|hai|selamat pagi|terima kasih)/i.test("halo selamat pagi!");
      const hasKeywords = /omzet|penjualan|kpi|transaksi/i.test("halo selamat pagi!");
      const lane = isGreeting && !hasKeywords ? "fast_path_non_data" : "orchestrated";
      const durationMs = Math.round((performance.now() - start) * 1000) / 1000;
      times.push(durationMs);
      fastPathDurations.push(durationMs);
    }
    const p = calculatePercentiles(times);
    categorySummaries.push({
      category: "fast_path_non_data",
      samples: times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 1000) / 1000,
      p50Ms: p.p50,
      p95Ms: p.p95,
      p99Ms: p.p99,
    });
  }

  const directP = calculatePercentiles(directQueryDurations);
  const warmP = calculatePercentiles(warmDurations);
  const fastP = calculatePercentiles(fastPathDurations);

  console.log("\n=== Measured Latency Percentiles ===");
  console.log(`Direct ClickHouse SQL (${directQueryDurations.length} queries) -> p50: ${directP.p50}ms, p95: ${directP.p95}ms, p99: ${directP.p99}ms`);
  console.log(`Repeated ClickHouse SQL (${warmDurations.length} queries) -> p50: ${warmP.p50}ms, p95: ${warmP.p95}ms, p99: ${warmP.p99}ms`);
  console.log(`Local regex microbenchmark (${fastPathDurations.length} samples) -> p50: ${fastP.p50}ms, p95: ${fastP.p95}ms, p99: ${fastP.p99}ms`);
  console.log("These measurements are not evidence of the whole-question latency target.");

  // Update manifest file
  const manifestPath = path.resolve(process.cwd(), "doc/benchmarks/2026-10-07-datasource-benchmark-manifest.json");
  const manifestContent = JSON.parse(await fs.readFile(manifestPath, "utf-8"));

  manifestContent.benchmarkRun = {
    status: "OBSERVED_PARTIAL",
    verifiedAt: new Date().toISOString(),
    verifier: "Paperclip Enterprise Datasource Benchmark Harness (scripts/run-datasource-benchmarks.ts)",
    measuredAgainst: {
      clickhouseHost: new URL(process.env.CLICKHOUSE_BENCHMARK_URL ?? "http://127.0.0.1:18123").host,
      clickhouseDatabase: process.env.CLICKHOUSE_BENCHMARK_DATABASE,
      totalClickHouseHttpRequests: clickHouseRequestCount,
      totalMeasurements: directQueryDurations.length + warmDurations.length + fastPathDurations.length,
      measurementScope: "direct_clickhouse_http_sql",
      endToEndLatencyVerified: false,
    },
    workloadSummaries: categorySummaries,
    limitations: [
      "Measures direct ClickHouse HTTP SQL and a local regex microbenchmark only.",
      "Does not include browser, agent, Pi/LLM, coordinator, retrieval, external database, or answer rendering time.",
      "Does not exercise configured data-size tiers or concurrent load tiers.",
    ],
  };

  manifestContent.environment.host = {
    runtime: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuCores: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || "Unknown",
    memoryGiB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
  };

  manifestContent.measuredLatencyBenchmarks = {
    directClickHouseSql: {
      p50Ms: directP.p50,
      p95Ms: directP.p95,
      p99Ms: directP.p99,
      sampleCount: directQueryDurations.length,
      status: "OBSERVED_NOT_END_TO_END",
    },
    repeatedClickHouseSql: {
      p50Ms: warmP.p50,
      p95Ms: warmP.p95,
      p99Ms: warmP.p99,
      sampleCount: warmDurations.length,
      status: "OBSERVED_NOT_END_TO_END",
    },
    localRegexMicrobenchmark: {
      p50Ms: fastP.p50,
      p95Ms: fastP.p95,
      p99Ms: fastP.p99,
      sampleCount: fastPathDurations.length,
      status: "NOT_SERVICE_LATENCY",
    },
  };

  manifestContent.endToEndLatencyQualification = {
    status: "NOT_VERIFIED",
    requiredEvidence: "Authenticated browser Agent Data -> Pi/coordinator -> authorized source query -> final answer, measured from user submission through rendered answer.",
  };
  manifestContent.designBudgets = {
    ...manifestContent.designBudgets,
    qualification: "planning targets only; not established by this direct ClickHouse microbenchmark",
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifestContent, null, 2), "utf-8");
  console.log(`\nUpdated benchmark manifest at ${manifestPath} with status: OBSERVED_PARTIAL.`);
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
