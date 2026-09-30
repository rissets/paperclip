---
name: data-sources-structured
description: >
  High-performance analytical querying, aggregation, and multidimensional slicing across
  structured datasets (CSV, Excel, Sheets, Parquet) and ClickHouse OLAP storage. Use when answering questions
  about revenues, metrics, KPIs, sales volume, time-series distributions, and grouped statistics.
---

# Structured Data & OLAP Analytics Skill

This skill equips Paperclip agents (such as `DataAgent`, `AnalyticsEngineerAgent`, or any agent assigned structured datasets) to query, aggregate, and analyze tabular datasets powered by ClickHouse columnar OLAP storage and PostgreSQL streaming.

---

## 1. Primary Action Tool: `query_structured.py`

Agents should run the pre-built Python CLI tool directly from bash to inspect schemas, execute aggregations, and run SQL queries:

### A. Discover All Structured Tables
```bash
python3 skills/data-sources-structured/scripts/query_structured.py --list-tables
```

### B. Describe Table Schema, Columns, and Metrics
```bash
python3 skills/data-sources-structured/scripts/query_structured.py --describe-table "<table_name_or_id>"
```

### C. Run Fast Aggregations (`sum`, `avg`, `count`, `min`, `max`)
Group by any categorical dimension with optional filters:
```bash
python3 skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_name_or_id>" \
  --aggregate sum \
  --column "<metric_column>" \
  --group-by "<category_dimension>" \
  --limit 20
```

With dimensional filtering:
```bash
python3 skills/data-sources-structured/scripts/query_structured.py \
  --table "<table_name_or_id>" \
  --aggregate avg \
  --column "<metric_column>" \
  --filter "region=East"
```

### D. Execute Custom Read-Only ClickHouse OLAP SQL
For complex analytical queries, quantiles, or window expressions:
```bash
python3 skills/data-sources-structured/scripts/query_structured.py \
  --sql "SELECT category, count(*), sum(total_amount) AS revenue FROM my_table GROUP BY category ORDER BY revenue DESC"
```

---

## 2. Response Standard for Structured Data

1. **Direct Executive Answer**: Lead with the computed number or key finding (e.g., *"Total omzet untuk kategori X adalah **Rp 1.450.000.000**"*).
2. **Markdown Data Table**: Present grouped results in cleanly formatted Markdown tables with proper units and number formatting.
3. **Engine & Provenance Note**: State whether the query was executed via ClickHouse OLAP Engine or PostgreSQL streaming:
   > *Query dieksekusi secara teroptimasi menggunakan ClickHouse OLAP Engine.*
