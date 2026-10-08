---
name: data-sources
description: >
  Universal data sources routing and execution skill across unstructured knowledge bases (RAG),
  structured tabular datasets (CSV, Excel), and external relational databases (PostgreSQL, MariaDB, MySQL).
---

# Universal Data Sources & Enterprise Retrieval Skill

This skill equips Primbon agents to discover, inspect, and route queries across all enterprise data sources available to the company.

---

## 1. Primary Action Tool: `data_sources.py`

Run the Python CLI tool to inspect collections and list data sources:

```bash
# 1. Discover Collections (Fastest way to understand company datasets and domains):
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --list-collections

# 2. Inspect a specific Collection (see cross-table relations, correlated docs, and unified ClickHouse view):
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --collection timurtelecom

# 3. List data sources scoped to a Collection:
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --list --collection timurtelecom

# 4. List all active data sources in company:
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --list

# 5. Filter by type (rag_document, database, csv, excel):
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --type rag_document
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --type database

# 6. Inspect a specific data source in detail:
python3 ~/.pi/agent/skills/data-sources/scripts/data_sources.py --id "<data_source_id>"
```

---

## 2. Delegation to Specialized Tools

### Enterprise orchestration for analytical questions

When the agent run includes `[Enterprise Datasource Orchestration Active]`, send the complete natural-language question once through the Enterprise Orchestrator before using a source-specific query tool:

```bash
python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
  --orchestrate "<the user's complete question>" \
  --format json
```

The shared coordinator handles assigned CSV/Excel, ClickHouse, and external relational sources. Do not list/describe/query those sources first for the same question, since that repeats discovery and bypasses the shared plan, deadline, cache, and provenance path. If the prompt says orchestration is `Off`, follow the direct workflows below. Document-only RAG questions still use `search_knowledge.py`; mixed document and structured questions use the structured coordinator for numeric facts and RAG for document evidence, then clearly distinguish their provenance.

Depending on the data source type, use the corresponding specialized action tool:

1. **Unstructured Documents (PDF, DOCX, TXT, MD)**:
   - Tool: `python3 ~/.pi/agent/skills/data-sources-knowledge/scripts/search_knowledge.py --query "<query>" --limit 6`
2. **Structured Tabular Datasets (CSV, Excel, ClickHouse)**:
   - Tool: `python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --list-tables`
   - Tool: `python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py --table "<name>" --aggregate sum --column "<col>"`
3. **Connected External Databases (PostgreSQL, MariaDB, MySQL)**:
   - Tool: `python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py --list-dbs`
   - Tool: `python3 ~/.pi/agent/skills/database-integration/scripts/query_database.py --db "<id>" --query-sql "SELECT ..."`
