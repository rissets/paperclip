---
name: data-sources-structured
description: >
  High-performance analytical querying, aggregation, and multidimensional slicing across
  structured datasets (CSV, Excel, Sheets, Parquet) and ClickHouse OLAP storage. Use when answering questions
  about revenues, metrics, KPIs, sales volume, time-series distributions, and grouped statistics.
---

# Structured Data & OLAP Analytics Skill

This skill equips Primbon agents (such as `DataAgent`, `AnalyticsEngineerAgent`, or any agent assigned structured datasets) to query, aggregate, and analyze tabular datasets powered by ClickHouse columnar OLAP storage and PostgreSQL streaming.

---

## 1. Primary Action Tool: `query_structured.py`

Agents should run the pre-built Python CLI tool directly from bash to inspect schemas, execute aggregations, and run SQL queries:

### A. Discover Structured Tables (Collection-Scoped or Universal)
Discover tables within a specific collection (ultra-fast, avoids scanning unrelated enterprise datasets):
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --list-tables --collection "<collection_slug_or_id>"
```

Or list all tables assigned to this agent:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --list-tables
```

### B. Describe Table Schema, Columns, and Metrics
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --describe-table "<table_name_or_id>"
```

### C. Run Fast Aggregations (`sum`, `avg`, `count`, `min`, `max`)
Group by any categorical dimension with optional filters:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_name_or_id>" \
  --aggregate sum \
  --column "<metric_column>" \
  --group-by "<category_dimension>" \
  --limit 20
```

With dimensional filtering:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_name_or_id>" \
  --aggregate avg \
  --column "<metric_column>" \
  --filter "region=East"
```

### D. Execute Custom Read-Only ClickHouse OLAP SQL
For complex analytical queries, quantiles, time-series distributions, CTEs, or window expressions:
```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --sql "SELECT category_col, count(*), sum(metric_col) AS total FROM <table_name> GROUP BY category_col ORDER BY total DESC"
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
4. **Never reference a column you have not verified.** A column that exists in one table
   (e.g. `package_id` in `18_subscriber_package_assignment`) may not exist in another
   (`23_subscriber_revenue_monthly`). Verify with `--describe-table <table>` or
   `DESCRIBE "<table>"` / `SELECT name FROM system.columns WHERE table = '<table>'`
   (system tables are allowed), and JOIN on the shared key (e.g. `subscriber_id`) to get missing attributes.
5. **Quote table names that start with digits** with backticks or double quotes: `` `23_subscriber_revenue_monthly` ``.
6. **On any ClickHouse error, read the message, re-describe the table, fix the query, and retry** (max 3 attempts) before reporting failure.
7. **Charts**: when a visual helps, follow the `diagram-chart-rendering` skill and emit a ```mermaid block.
8. **Dynamic Schema Introspection First**:
   Always run `--describe-table <table_name>` first to discover the exact column names, data types, and semantic metrics before constructing custom analytical queries.

---

## 2. Response Standard for Structured Data

1. **Direct Executive Answer**: Lead with the computed number or key finding (e.g., *"Total omzet untuk kategori X adalah **Rp 1.450.000.000**"*).
2. **Markdown Data Table**: Present grouped results in cleanly formatted Markdown tables with proper units and number formatting.
3. **Engine & Provenance Note**: State whether the query was executed via ClickHouse OLAP Engine or PostgreSQL streaming:
   > *Query dieksekusi secara teroptimasi menggunakan ClickHouse OLAP Engine.*
