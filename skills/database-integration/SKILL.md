---
name: database-integration
description: >
  Autonomous dynamic querying, multi-table relationship navigation, schema introspection, and entity profiling across
  connected enterprise relational databases (PostgreSQL, MariaDB, MySQL, SQL Server). Use when answering questions
  about live database records, multi-table foreign key joins, entity lookups, and transactional data.
---

# External Enterprise Database Integration Skill

This skill equips Paperclip agents (such as `DataAgent`, `DatabaseIntegrationAgent`, or any agent assigned database connections) to dynamically inspect relational schemas, navigate foreign-key topologies, formulate dialect-specific SQL, execute safe queries, and synthesize grounded responses.

---

## 1. Primary Action Tool: `query_database.py`

Agents should run the pre-built Python CLI tool directly from bash:

### A. List Connected External Databases
```bash
python3 skills/database-integration/scripts/query_database.py --list-dbs
```

### B. Inspect Tables in a Database
```bash
python3 skills/database-integration/scripts/query_database.py --db "<data_source_id_or_name>" --inspect-tables
```

### C. Describe Table Columns, Data Types, and Searchable Keys
```bash
python3 skills/database-integration/scripts/query_database.py --db "<data_source_id_or_name>" --describe-table "<table_name>"
```

### D. Execute Safe Read-Only SQL Query
```bash
python3 skills/database-integration/scripts/query_database.py \
  --db "<data_source_id_or_name>" \
  --query-sql "SELECT id, name, status FROM users WHERE status = 'active' LIMIT 10"
```

---

## 2. Dynamic Query Strategy Pipeline

When a user asks a question requiring data from an external database:

1. **Schema Discovery**: Never assume table names or column names exist. Always run `--inspect-tables` and `--describe-table` to verify column names and roles.
2. **Entity Profiling**: For specific entity queries, filter by searchable columns (`searchableColumns` or primary keys).
3. **Multi-Table JOINs**: Use foreign-key relationships discovered during schema introspection. Always use explicit table aliases.
4. **Self-Correction Retry Loop**: If a query returns a column error (e.g. `Unknown column 'x'`), inspect the table schema with `--describe-table`, fix the column name, and retry.
5. **Read-Only Invariant**: Only read-only operations (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`) are permitted. All mutating operations (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`) are blocked.

---

## 3. Response Formatting & Provenance Standard

1. **Executive Answer**: State the primary insight directly.
2. **Structured Table**: Display multi-row results in clean Markdown tables with number formatting.
3. **Query Transparency**: Cite the executed SQL query for auditability.
4. **Internal Provenance**:
   > *Data resmi terverifikasi dari database internal **[Nama Database]** (Tabel: `[nama_tabel]`).*
