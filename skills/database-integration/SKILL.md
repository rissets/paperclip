---
name: database-integration
description: >
  Query, navigate relationships, and introspect schemas across connected relational databases
  (PostgreSQL, MariaDB, MySQL, SQL Server). Use when answering questions about live database
  records, multi-table joins, entity lookups, and transactional data.
---

# External Enterprise Database Integration Skill

This skill equips agents assigned relational databases to inspect schemas, navigate relationships, formulate dialect-specific SQL, and synthesize grounded responses. Database names, table names, and columns are discovered at runtime and must not be fixed in this skill.

## 0. Access and Assignment Rules

- `--list-dbs` reports the databases visible to the current agent. Treat that result as the allowlist and rediscover it for each task.
- This is a read-only analysis skill. Do not create, edit, delete, connect, or assign a data source, and do not change agent access metadata through an API, SQL, or script. An owner assigns sources from the agent's **Data Sources** menu. If the needed source is missing, ask the owner to assign it there, then rediscover the list.
- Never use a remembered datasource, table, or column name from another tenant or task. Describe the selected table before constructing SQL.

---

## 1. Primary Action Tool: `query_database.py`

Agents should run the pre-built Python CLI tool directly from bash:

### A. List Connected External Databases
```bash
python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py --list-dbs
```

### B. Inspect Tables in a Database
```bash
python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py --db "<data_source_id_or_name>" --inspect-tables
```

### C. Describe Table Columns, Data Types, and Searchable Keys
```bash
python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py --db "<data_source_id_or_name>" --describe-table "<table_name>"
```

### D. Execute Safe Read-Only SQL Query
```bash
python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py \
  --db "<data_source_id_or_name>" \
  --query-sql "SELECT <verified_columns> FROM <verified_table> WHERE <verified_filter> LIMIT 50"
```

---

## 2. Dynamic Query Strategy Pipeline

When a user asks a question requiring data from an external database:

1. **Schema Discovery**: Never assume table names or column names exist. Run `--inspect-tables` once, choose the smallest relevant set, and run `--describe-table` only for the tables needed.
2. **Entity Profiling**: For specific entity queries, filter by searchable columns (`searchableColumns` or primary keys).
3. **Bounded Query**: Select only required columns, filter early, use an explicit row limit, and aggregate at the database when the user asks for counts, totals, or trends. Avoid unfiltered scans and repeated probes on large tables.
4. **Multi-Table JOINs**: Use verified foreign-key or shared-key relationships. Always use explicit table aliases and aggregate high-volume inputs before joining when possible.
5. **Durable Execution**: `--query-sql` submits a durable query job and polls for its result. The default database timeout is 30 seconds and the maximum is 60 seconds; returned rows are capped at 1,000. Do not submit duplicate jobs while one is queued or running. On timeout, narrow the filter or query plan and submit one corrected job.
6. **Self-Correction**: Classify errors before retrying. Re-describe only when a table or column is unknown; fix syntax/dialect errors from the existing schema. Retry a corrected query at most once, never the identical failed SQL.
7. **Read-Only Invariant**: Only read-only operations (`SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`) are permitted. All mutating operations (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`) are blocked.

---

## 3. Response Formatting & Provenance Standard

1. **Executive Answer**: State the primary insight directly.
2. **Structured Table**: Display multi-row results in clean Markdown tables with number formatting.
3. **Query Transparency**: Cite the executed SQL query for auditability, without exposing credentials or connection details.
4. **Internal Provenance**:
   > *Data resmi terverifikasi dari database internal **[Nama Database]** (Tabel: `[nama_tabel]`).*
5. **No Repeated Progress Text**: Do not expose internal reasoning or repeat progress messages. Return one concise, result-focused answer after the query job completes.
