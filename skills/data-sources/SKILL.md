---
name: data-sources
description: >
  Query enterprise structured datasets (CSV, Excel) and search RAG knowledge documents
  managed in Paperclip. Use when answering business analytics, sales, revenues,
  aggregations, table filters, or retrieving company policies, SOPs, and SLAs.
---

# Enterprise Data Sources & RAG Skill

This skill equips Paperclip agents to autonomously discover, query, and synthesize enterprise data directly from Paperclip's Data Sources engine.

## Environment & Authentication

The following environment variables are provided during heartbeat/agent execution:
- `PAPERCLIP_API_URL`: Paperclip server base URL (e.g., `http://localhost:3100`)
- `PAPERCLIP_COMPANY_ID`: Active company ID
- `PAPERCLIP_API_KEY`: Bearer authentication token (if required)

When making HTTP requests via `curl`, include:
```bash
AUTH_HEADER=""
if [ -n "$PAPERCLIP_API_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $PAPERCLIP_API_KEY"
fi
```

---

## 1. Discover Available Data Sources

List all active data sources (structured tables and RAG knowledge documents) registered for the company:

```bash
curl -sS -X GET "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"}
```

**Response format:**
Returns an array of data source objects:
```json
[
  {
    "id": "ds-uuid",
    "name": "Sales Q3 Report",
    "sourceType": "csv",
    "status": "ready",
    "tables": [
      {
        "id": "table-uuid",
        "tableName": "Sales Q3 Report",
        "rowCount": 6,
        "schemaDefinition": [
          { "name": "region", "role": "dimension", "dataType": "string" },
          { "name": "revenue", "role": "metric", "dataType": "number" }
        ],
        "semanticModel": {
          "metrics": [{ "name": "revenue", "aggregation": "sum" }],
          "synonyms": { "revenue": ["revenue", "penjualan", "omzet"] }
        }
      }
    ]
  },
  {
    "id": "ds-rag-uuid",
    "name": "Cloud SLA Policy",
    "sourceType": "rag_document",
    "status": "ready",
    "metadata": { "chunkCount": 4 }
  }
]
```

---

## 2. Query Structured Data (CSV / Excel)

Execute aggregations, filtering, and groupings on structured tables:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/tables/$TABLE_ID/query" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "aggregate": {
      "metric": "revenue",
      "function": "sum",
      "groupBy": "region"
    },
    "limit": 100
  }'
```

**Optional Filter syntax:**
```json
{
  "filter": {
    "region": "APAC"
  }
}
```

---

## 3. Search Knowledge Documents (RAG)

Perform semantic search across document chunks with vector similarity:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/search-knowledge" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Berapa jaminan SLA uptime untuk Alpha Cloud?",
    "limit": 4
  }'
```

**Response format:**
Returns matched chunks sorted by similarity score:
```json
[
  {
    "id": "chunk-uuid",
    "dataSourceId": "ds-rag-uuid",
    "sourceName": "Cloud SLA Policy",
    "title": "Service Level Commitments",
    "content": "All Tier-1 cloud services, including Alpha Cloud and Gamma Analytics, guarantee an uptime of 99.99% monthly...",
    "similarity": 0.89
  }
]
```

---

## 4. Response Best Practices for Agents

1. **Lead with the Direct Answer**: Provide the executive summary immediately.
2. **Tabular Results**: Format structured metrics into Markdown tables with formatted numbers (e.g. `126,000`).
3. **Grounded Citations**: When answering from RAG knowledge documents, always cite the source document name and section title in blockquotes:
   > **Source: [Document Name]** (Section Title)
   > "...excerpt..."
4. **Cross-Domain Synthesis**: When a question combines both operational numbers and policy rules (e.g., "Berapa omzet produk X dan apa klausul refund-nya?"), present the policy context first, followed by the verified numbers.

---

## 5. TypeSafe Jev Decision Plane (System One Architecture)

Paperclip incorporates **TypeSafe AI Jev (jev-1.13.0)** as a fast, calibrated semantic decision layer:
- **Zero-Latency Gatekeeper (~150ms)**: Routes user requests between Data Agent (structured/DB) and Knowledge Agent (RAG/docs) using `Choice` and `Noul` primitives without expensive text-generation decoding.
- **Calibrated Confidence**: Employs empirical RLCD calibration: confidence $\ge 0.85$ auto-executes; lower confidence prompts user clarification.
- **RAG Verification**: Re-ranks vector chunks using `Score` and tests answerability via `Noul` before displaying results, preventing hallucinated conclusions.
- **Structured Metric Mapping**: Automatically determines target metric, aggregation function (`sum`, `avg`, `min`, `max`, `count`), and dimension grouping from natural language queries.

