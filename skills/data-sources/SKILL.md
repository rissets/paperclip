---
name: data-sources
description: >
  Master guide for enterprise data sources in Paperclip. Query structured datasets (CSV, Excel) via ClickHouse OLAP,
  search unstructured knowledge documents (PDF, DOCX, Markdown) via Hybrid Vector + Lexical RAG, and access live external
  databases (PostgreSQL, MariaDB, MySQL). Use when answering business analytics, sales, policies, SOPs, or entity profiles.
---

# Enterprise Data Sources Master Skill

This skill equips Paperclip agents to autonomously discover, query, and synthesize enterprise data across three specialized categories:
1. **Structured Data (CSV / Excel)**: High-speed analytics and aggregations powered by ClickHouse columnar OLAP storage and PostgreSQL streaming.
2. **Knowledge RAG Documents (PDF / DOCX / Markdown)**: Hybrid Dense Vector + Lexical BM25 semantic retrieval verified by TypeSafe Jev System One.
3. **External Relational Databases (PostgreSQL / MariaDB / MySQL)**: Direct safe read-only SQL queries, multi-table foreign key joins (`crossTableClusters`), and B-Tree indexed entity profiling.

---

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

## 1. Discover Active Enterprise Data Sources

List all active data sources and their tables or document metadata registered for the company:

```bash
curl -sS -X GET "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"}
```

**Returned Data Source Categories:**
- `sourceType: "csv"` | `"excel"`: Structured tabular datasets with `tables`, `schemaDefinition`, and `semanticModel`.
- `sourceType: "rag_document"`: Unstructured documents with `chunkCount`, semantic topics, and document summaries.
- `sourceType: "postgres"` | `"mariadb"` | `"mysql"`: External databases with relational schemas, foreign keys, and `crossTableClusters`.

---

## 2. Category 1: Structured Data & ClickHouse OLAP Analytics

When users ask for calculations, sums, averages, counts, or grouped rollups:

### A. Execute Aggregation via `POST /tables/:tableId/query`

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
    "filter": {
      "tahun": "2024"
    },
    "limit": 25
  }'
```

### B. Execution Engine Behavior
1. **ClickHouse OLAP Engine (MergeTree)**: Automatically evaluated first for sub-10ms aggregations.
2. **PostgreSQL Streaming Fallback**: If ClickHouse is unavailable or table is unsynced, queries execute gracefully via in-memory PostgreSQL streaming.

---

## 3. Category 2: Knowledge Documents & Hybrid RAG Retrieval

When users ask for policies, standard operating procedures (SOP), SLAs, compliance, guidelines, or factual document questions:

### A. Execute Hybrid Search via `POST /search-knowledge`

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/search-knowledge" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Berapa jaminan SLA uptime untuk layanan cloud dan bagaimana klausul penalti downtime?",
    "limit": 5
  }'
```

### B. Search Pipeline & TypeSafe Jev Verification
- **Dense Vector Similarity (30%)**: Cosine similarity against 384/768-dimension embeddings stored in `dataSourceChunks`.
- **Lexical BM25 & Exact Phrase Match (70%)**: Matches exact legal/regulatory terms, article numbers, and title terms.
- **TypeSafe Jev System One (jev-1.13.0) Re-ranking**: Evaluates retrieved chunks, re-ranks them by semantic alignment, and verifies whether the question is answerable (`isAnswerable`, `confidence`) without hallucination.

### C. Grounded Blockquote Citation Standard
Always include exact document references:
```markdown
> **[1] Sumber: Cloud SLA Policy 2024** (Pasal 4: Jaminan Uptime)
> "Penyedia menjamin uptime bulanan minimal 99.99% untuk semua layanan Tier-1."
```

---

## 4. Category 3: External Database Data (PostgreSQL, MariaDB, MySQL)

When users ask for live transactional data, corporate profiles, multi-table records, or relational aggregations:

### A. Dynamic External Database Retrieval Flow
1. **Dynamic Discovery**: Query `GET /api/companies/$COMPANY_ID/data-sources` to identify connected database instances and their tables.
2. **Topology Resolution**: Check `crossTableClusters` and `relationships` to map foreign key connections across tables.
3. **Query Strategy Execution**:
   - **Fast-Path Entity Profiling**: If searching for a specific named entity (company, SK, person), query `searchableColumns` with exact match, falling back to prefix `LIKE 'PREFIX%'` if 0 rows returned.
   - **Analytical Multi-Table JOIN**: If answering cross-table questions, generate dialect-specific SQL (`""` for PostgreSQL, `\`` for MariaDB/MySQL) joining primary and foreign keys with explicit aliases.
   - **JSON Field Extraction**: Extract nested structures using `pengurus->>'direktur'` (Postgres) or `JSON_UNQUOTE(JSON_EXTRACT(data, '$.direktur'))` (MariaDB/MySQL).
4. **Self-Correction Retry Loop**: If the database reports a column or syntax error, the agent analyzes the error, corrects table/column names from the schema definition, and retries (up to 3 iterations).
5. **Grounded Provenance**: Concludes with the official database citation referencing the source and table.

### B. Execute Safe Read-Only SQL via `POST /data-sources/:id/query-sql`

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/query-sql" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT p.nama_perseroan, p.status, m.modal_disetor, a.kota FROM tbl_perseroan p JOIN tbl_modal m ON p.perseroan_id = m.perseroan_id LEFT JOIN tbl_alamat a ON p.perseroan_id = a.perseroan_id WHERE p.status = \"AKTIF\" ORDER BY m.modal_disetor DESC LIMIT 5",
    "limit": 5
  }'
```

### C. Safety & Invariants
- Mutating statements (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, etc.) are blocked with `400 Bad Request`.
- Results are strictly capped at 500 rows maximum to guarantee stability.
- PostgreSQL queries are executed inside read-only transactions.

---

## 5. TypeSafe Jev Orchestration Architecture (System One)

When interacting via the Enterprise Orchestrator (`POST /api/companies/:companyId/orchestrator/sessions/:sessionId/chat`), TypeSafe Jev 1.13.0 operates as a zero-latency gatekeeper:

```
[ User Query ]
       │
       ▼
TypeSafe Jev System One (jev-1.13.0)
       │
       ├──► "data_agent" ──────────► Structured Datasets (ClickHouse OLAP) & External DB (SQL)
       ├──► "knowledge_agent" ─────► Knowledge Documents (Hybrid Vector + Lexical RAG)
       └──► "hybrid" ──────────────► Concurrently dispatches both, synthesizing facts + policies
```

- **Confidence $\ge 0.85$**: Autonomous execution with grounded citations.
- **Cross-Domain Synthesis**: Formats numbers in markdown tables and policies in blockquotes.
