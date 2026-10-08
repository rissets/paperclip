---
name: data-sources-structured
description: >
  High-performance analytical querying, aggregation, and multidimensional slicing across
  structured datasets (CSV, Excel, Sheets, Parquet) and ClickHouse OLAP storage. Use when answering questions
  about revenues, metrics, KPIs, sales volume, time-series distributions, and grouped statistics.
---

# Structured Data & OLAP Analytics Skill

This skill equips agents assigned structured datasets to query, aggregate, and analyze tabular data stored in ClickHouse or PostgreSQL. Source names, table names, and columns must be discovered from the current agent's live assignment and schema; this skill deliberately contains no tenant-specific source or table names.

## 0. Access and Assignment Rules

- For greetings, “what can you do?” capability questions, and other conversational turns that do not request facts from a dataset, answer from the agent's configured name, role, and instructions. Do not call the datasource CLI, enumerate tables, or invoke the coordinator for those turns.
- Treat the ACL-filtered tables supplied by runtime orchestration or metadata CLI as the complete allowlist. In Auto, prefer the catalog already supplied; `--list-tables` and `--describe-table` are allowed for authorized metadata only. Never rely on a source/table name remembered from another task.
- This is a read-only analysis skill. Do not create, edit, delete, connect, or assign a data source, and do not change agent access metadata through an API, SQL, or script. An owner assigns sources from the agent's **Data Sources** menu. If the needed source is missing, ask the owner to assign it there, then rediscover the list.
- Use only tables and columns returned by the current assignment and `--describe-table`. Do not infer access from a collection name mentioned in conversation.

---

## 1. Primary Action Tool: `query_structured.py`

Agents should use the pre-built Python CLI tool to inspect schemas and query only the assigned datasets:

### Orchestration mode (`Auto`)

When the run context contains `[Enterprise Datasource Orchestration Active]` and the user asks for dataset facts, send the user's complete analytical question through the coordinator first:

```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --orchestrate "<the user's complete question>" \
  --format json
```

This is the normal path for CSV, Excel, ClickHouse, and assigned external database questions. It resolves the source/table scope, validates the plan, chooses the execution lane, and returns the execution trace and provenance. Prefer its injected catalog and schema; use `--list-tables` or `--describe-table` only to fill missing authorized metadata. Do not call `--aggregate` or direct `--sql` for a new question in Auto. Direct data queries require orchestration Off or a specific fallback reason returned by the coordinator. Never launch the direct query and orchestrated query in parallel.

In Auto, the CLI allows ACL-filtered catalog and schema metadata reads; they never execute business-data queries. Direct `--aggregate` or `--sql` calls require a concrete coordinator fallback reason passed as `--direct-fallback-reason "<specific reason from coordinator>"`; do not use a generic reason. With `--format json`, stdout is one compact JSON document on a single line, and CLI/API errors are one compact JSON object on stderr. Parse the complete output line as JSON; do not parse the default Markdown table format.

Document retrieval remains a separate RAG operation; this structured-data coordinator does not replace `search_knowledge.py` for document-only questions.

### A. Discover Structured Tables (Orchestration Off or Explicit Coordinator Fallback)
Discover tables within a collection when the user has identified one:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --list-tables --collection "<collection_slug_or_id>"
```

Or list all tables assigned to this agent (preferred when the request does not name a collection). Use JSON when you need exact IDs or ClickHouse table mappings:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --list-tables --format json
```

The JSON catalog's `tableId` and `dataSourceId` are the stable IDs for structured API operations; `rowCount` is numeric. Keep the two IDs separate. Aggregate operations resolve the pair against the current ACL-filtered catalog before querying. For direct `--sql`, use `clickhouseTable`: the human-facing `Table Name` can be only a logical label and may not exist in ClickHouse. Never guess or rebuild physical table names.

### B. Describe Table Schema, Columns, and Metrics
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --data-source-id "<data_source_id>" \
  --describe-table "<table_id>"
```

### C. Run Fast Aggregations (`sum`, `avg`, `count`, `min`, `max`)
Group by any categorical dimension with optional filters:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_id>" \
  --data-source-id "<data_source_id>" \
  --aggregate sum \
  --column "<metric_column>" \
  --group-by "<category_dimension>" \
  --limit 20
```

With dimensional filtering:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_id>" \
  --data-source-id "<data_source_id>" \
  --aggregate avg \
  --column "<metric_column>" \
  --filter "region=East"
```

### D. Execute Custom Read-Only ClickHouse OLAP SQL
For complex analytical queries, quantiles, time-series distributions, CTEs, or window expressions:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --sql "SELECT category_col, count(*), sum(metric_col) AS total FROM <clickhouse_table_from_catalog> GROUP BY category_col ORDER BY total DESC"
```

#### ClickHouse Best Practices for Dynamic SQL:
1. **Date & Timestamp Functions**:
   Ingested tabular datasets (CSV/Excel) often store timestamp and date values as `String`. In ClickHouse, date functions (such as `toHour()`, `toDayOfWeek()`, `toDate()`, `toStartOfDay()`, `toStartOfHour()`) require `DateTime` or `Date`.
   Always wrap string date/timestamp columns with `parseDateTimeBestEffortOrNull(column_name)` or `toDateTimeOrNull(column_name)`:
   ```sql
   SELECT toHour(parseDateTimeBestEffortOrNull(timestamp_col)) AS hour, count(*) FROM <table_name> GROUP BY hour ORDER BY hour ASC
   ```
2. **Multi-Stage Common Table Expressions (CTEs)**:
   You can freely structure queries using CTEs (`WITH <cte_name> AS (...) SELECT ... FROM <cte_name>`).
3. **Excel serial dates (numbers like 45123)**:
   Columns named `month`, `date`, etc. imported from Excel may hold serial day numbers (Float64/String).
   `toDate()` takes ONE argument (or 2 with timezone) - `toDate(1899, 12, 30)` is INVALID.
   Use: `toDate('1899-12-30') + toInt32(col)` then `toStartOfMonth(...)`:
   ```sql
   SELECT toStartOfMonth(toDate('1899-12-30') + toInt32(month)) AS m, sum(net_revenue_usd) FROM <table> GROUP BY m ORDER BY m
   ```
   Check the column type first; if it is a real date string use `parseDateTimeBestEffortOrNull(col)` instead.
4. **Never reference a column you have not verified.** Reuse a schema already verified in the current thread. Otherwise describe only the selected table once, or query its physical identifier from the catalog. A column present in one table may not exist in another; join only on verified shared keys.
5. The catalog-provided physical ClickHouse identifiers start with `ds_`; use them for direct SQL. Do not use `system.tables` as a shortcut for source row counts: its records describe ClickHouse metadata, not data rows. To count source records, run `count()` against the physical source table.
6. **On a ClickHouse error, classify it before retrying**. For `UNKNOWN_IDENTIFIER`, use the exact identifier and CTE scope from the error, compare them with the verified table columns and current CTE projection/aliases, then rewrite with real fields; never invent a replacement such as `sinx`. Re-describe only if the selected table's schema is unknown. Retry one corrected query at most once.
7. **Charts**: when a visual helps, follow the `diagram-chart-rendering` skill and emit a ```mermaid block.
8. **Dynamic Schema Introspection First**: Run `--describe-table <table_id>` only when the required columns or types are not already known from the current request/thread or catalog metadata. Do not rediscover a known schema for a presentation-only follow-up.

---

## 2. Efficient Query Plan for Large Sources

1. For a new analysis, list the assigned tables once. Use row counts, semantic metrics, and the user's question to select the smallest relevant set; do not print or inspect the full catalog in the answer.
2. Describe only those tables whose needed columns, timestamp, or entity keys are still unknown. Reuse the verified schema and result already present in the current issue thread when the user asks to redraw or explain the same answer.
3. Plan one bounded query before running it: project only needed columns, filter the requested date range and entity scope as early as possible, aggregate in ClickHouse, and return grouped results rather than raw records. Avoid `SELECT *` and repeated full-table probes.
4. For large time-series tables, first compute the requested grain (for example, per hour or per entity/day). If comparing event and baseline windows, restrict the scan to both windows and aggregate each window before joining. Join on the verified entity key and time bucket; never join solely on timestamp.
5. Prefer `--aggregate` for simple supported aggregates. It can use the structured-result cache. Custom `--sql` is for analyses that need SQL features beyond that API and may execute a fresh scan.
6. Keep the response result compact with a meaningful `--limit`. A row limit does not reduce the scan needed for an aggregate, so use filters and aggregation as well.
7. For a presentation-only follow-up such as “buatkan visualisasi ulang”, reuse the latest verified query result, date range, filters, and source citation in the thread. Do not rerun discovery or the same successful query unless the user changes scope or requests fresh data.

### ClickHouse Dialect and Query-Shaping Rules

- For date arithmetic, use `addDays(ts, n)` / `addHours(ts, n)` or ClickHouse interval syntax. Do not generate `toIntervalDays`; ClickHouse 26.8 exposes singular `toIntervalDay` and `toIntervalHour` functions.
- Do not put an aggregate alias in `GROUP BY`. Group only by source dimensions; if a later step needs an aggregate such as `min(ts)`, compute it in one CTE and reference it from an outer query.
- Do not join an event subset back to an entire fact table using timestamp alone. Carry the entity key and bound the fact-table time range to the event and comparison windows before aggregation.
- For String timestamps, parse only after verifying the schema, and apply the requested time range as early as the stored type allows.
- The query CLI waits up to 70 seconds for the API, just beyond ClickHouse's 60-second server execution limit. If a query reaches that limit, reduce its time range, entities, joins, or intermediate grain before retrying; do not immediately rerun the same SQL.

---

## 3. Response Standard for Structured Data

1. **Direct Executive Answer**: Lead with the computed number or key finding (e.g., *"Total omzet untuk kategori X adalah **Rp 1.450.000.000**"*).
2. **Markdown Data Table**: Present grouped results in cleanly formatted Markdown tables with proper units and number formatting.
3. **Engine & Provenance Note**: State whether the query was executed via ClickHouse OLAP Engine or PostgreSQL streaming:
   > *Query dieksekusi secara teroptimasi menggunakan ClickHouse OLAP Engine.*
4. **No Repeated Progress Text**: Do not expose internal reasoning or repeat the same progress/update paragraph. Return one concise result after the query completes, with assumptions and any limitation stated once.

## 4. Error Recovery

- Classify an error before retrying. For an unknown column, re-describe only the affected table. For an unknown CTE alias or SQL dialect issue, fix the SQL using verified columns and projections already obtained; do not repeat schema discovery or guess column spellings.
- Retry a corrected query at most once. Never submit an identical failed query again. For timeout/resource-limit errors, narrow the scan or simplify the plan; do not increase the timeout or fan out repeated queries.
- If a query remains invalid or exceeds the server limit after one correction, report the exact blocker and the smaller scope needed to continue.
