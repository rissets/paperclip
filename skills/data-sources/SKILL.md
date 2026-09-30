---
name: data-sources
description: >
  Universal data sources routing and execution skill across unstructured knowledge bases (RAG),
  structured tabular datasets (CSV, Excel), and external relational databases (PostgreSQL, MariaDB, MySQL).
---

# Universal Data Sources & Enterprise Retrieval Skill

This skill equips Paperclip agents to discover, inspect, and route queries across all enterprise data sources available to the company.

---

## 1. Primary Action Tool: `data_sources.py`

Run the Python CLI tool to inspect and list all data sources:

```bash
# List all active data sources
python3 skills/data-sources/scripts/data_sources.py --list

# Filter by type (rag_document, database, csv, excel)
python3 skills/data-sources/scripts/data_sources.py --type rag_document
python3 skills/data-sources/scripts/data_sources.py --type database

# Inspect a specific data source in detail
python3 skills/data-sources/scripts/data_sources.py --id "<data_source_id>"
```

---

## 2. Delegation to Specialized Tools

Depending on the data source type, use the corresponding specialized action tool:

1. **Unstructured Documents (PDF, DOCX, TXT, MD)**:
   - Tool: `python3 skills/data-sources-knowledge/scripts/search_knowledge.py --query "<query>" --limit 6`
2. **Structured Tabular Datasets (CSV, Excel, ClickHouse)**:
   - Tool: `python3 skills/data-sources-structured/scripts/query_structured.py --list-tables`
   - Tool: `python3 skills/data-sources-structured/scripts/query_structured.py --table "<name>" --aggregate sum --column "<col>"`
3. **Connected External Databases (PostgreSQL, MariaDB, MySQL)**:
   - Tool: `python3 skills/database-integration/scripts/query_database.py --list-dbs`
   - Tool: `python3 skills/database-integration/scripts/query_database.py --db "<id>" --query-sql "SELECT ..."`
