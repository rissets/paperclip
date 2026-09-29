---
name: data-sources-structured
description: >
  High-performance analytical querying, aggregation, and multidimensional slicing across
  structured datasets (CSV, Excel) and ClickHouse OLAP storage. Use when answering questions
  about revenues, metrics, KPIs, sales volume, time-series distributions, and grouped statistics.
---

# Structured Data & OLAP Analytics Skill

This skill equips Paperclip agents (especially `DataAgent` and `AnalyticsEngineerAgent`) to query, aggregate, and analyze enterprise structured datasets (CSV and Excel files) powered by ClickHouse columnar OLAP storage and PostgreSQL streaming.

## Environment & Authentication

The following environment variables are provided during heartbeat/agent execution:
- `PAPERCLIP_API_URL`: Paperclip server base URL (e.g., `http://localhost:3100`)
- `PAPERCLIP_COMPANY_ID`: Active company ID
- `PAPERCLIP_API_KEY`: Bearer authentication token (if required)

```bash
AUTH_HEADER=""
if [ -n "$PAPERCLIP_API_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $PAPERCLIP_API_KEY"
fi
```

---

## 1. Structured Data Execution Engines: ClickHouse OLAP vs PostgreSQL Fallback

Paperclip employs a dual-tier execution engine for structured data:

1. **ClickHouse OLAP Engine (Primary for Aggregations)**:
   - Tables ingested from CSV/Excel or synchronized from external databases are registered into an isolated ClickHouse database (`paperclip_<company_id>`).
   - ClickHouse uses the columnar `MergeTree` engine, executing aggregations (`sum`, `avg`, `min`, `max`, `count`) and `GROUP BY` rollups in sub-10ms over millions of rows.
2. **PostgreSQL / PGlite Streaming (Fallback & Row Previews)**:
   - Raw records are stored locally in `data_source_records`.
   - If ClickHouse is not available or a table has not been synced, Paperclip automatically falls back to in-memory streaming and aggregation in PostgreSQL without failing the query.

---

## 2. Discover Structured Tables & Semantic Metrics

Inspect all ready structured tables and their semantic metrics (identity, dimensions, metrics, synonyms):

```bash
curl -sS -X GET "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"}
```

**Inspecting a Table's Schema & Semantic Model:**
```json
{
  "id": "ds-structured-01",
  "name": "data_retail",
  "sourceType": "csv",
  "status": "ready",
  "tables": [
    {
      "id": "tbl-retail-01",
      "tableName": "data_retail",
      "rowCount": 50000,
      "schemaDefinition": [
        { "name": "transaksi_id", "role": "identifier", "dataType": "string" },
        { "name": "cabang", "role": "dimension", "dataType": "string", "sampleValues": ["Jakarta", "Surabaya", "Bandung"] },
        { "name": "kategori_produk", "role": "dimension", "dataType": "string" },
        { "name": "total_penjualan", "role": "metric", "dataType": "number" },
        { "name": "tanggal", "role": "dimension", "dataType": "date" }
      ],
      "semanticModel": {
        "tableRole": "fact_table",
        "metrics": [
          { "name": "total_penjualan", "aggregation": "sum", "unit": "IDR" }
        ],
        "dimensions": [
          { "name": "cabang", "sampleValues": ["Jakarta", "Surabaya", "Bandung"] },
          { "name": "kategori_produk", "sampleValues": ["Minuman", "Makanan", "Retail"] }
        ],
        "synonyms": {
          "total_penjualan": ["omzet", "revenue", "sales", "penjualan", "pendapatan"]
        }
      }
    }
  ]
}
```

---

## 3. Querying Structured Tables

### A. Aggregations with Group By (`POST /query`)

Execute lightning-fast aggregations grouped by any categorical dimension:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/tables/$TABLE_ID/query" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "aggregate": {
      "column": "total_penjualan",
      "fn": "sum",
      "groupBy": "cabang"
    },
    "limit": 20
  }'
```

**Response format:**
```json
{
  "tableId": "tbl-retail-01",
  "tableName": "data_retail",
  "columns": ["cabang", "sum_total_penjualan", "row_count"],
  "rows": [
    { "cabang": "Jakarta", "sum_total_penjualan": 1450000000, "row_count": 18200 },
    { "cabang": "Surabaya", "sum_total_penjualan": 980000000, "row_count": 12400 },
    { "cabang": "Bandung", "sum_total_penjualan": 620000000, "row_count": 8100 }
  ],
  "totalRows": 3
}
```

### B. Global Aggregations (Single Metric Stat)

Compute overall sum, average, min, or max:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/tables/$TABLE_ID/query" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "aggregate": {
      "column": "total_penjualan",
      "fn": "avg"
    }
  }'
```

### C. Filtered Aggregations & Slicing

Filter by specific dimensions (e.g. `cabang = "Jakarta"`) before aggregating:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/tables/$TABLE_ID/query" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "cabang": "Jakarta"
    },
    "aggregate": {
      "column": "total_penjualan",
      "fn": "sum",
      "groupBy": "kategori_produk"
    },
    "limit": 10
  }'
```

---

## 4. Direct Read-Only ClickHouse OLAP Queries

When custom SQL analytics are needed (e.g. window functions, quantiles, complex expressions), query ClickHouse directly:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/clickhouse/query" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT kategori_produk, sum(total_penjualan) AS revenue, quantile(0.95)(total_penjualan) AS p95_order FROM data_retail GROUP BY kategori_produk ORDER BY revenue DESC",
    "limit": 50
  }'
```

---

## 5. Syncing Data Sources to ClickHouse

To ensure tables are synchronized into ClickHouse OLAP storage:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/sync-clickhouse" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "dataSourceId": "$DATA_SOURCE_ID"
  }'
```

---

## 6. Agent Response Protocol for Structured Data

1. **Direct Executive Metric**: Start with the exact answer (e.g., *"Total omzet cabang Jakarta adalah **Rp 1.450.000.000**"*).
2. **Markdown Data Table**: Present grouped results in cleanly formatted markdown tables with number formatting (commas, currency, units).
3. **Engine Provenance Note**: State whether the query was executed on ClickHouse OLAP Engine or PostgreSQL streaming:
   > *Query dieksekusi secara teroptimasi menggunakan ClickHouse OLAP Engine (MergeTree) dalam 8ms.*
