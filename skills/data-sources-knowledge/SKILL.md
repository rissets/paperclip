---
name: data-sources-knowledge
description: >
  Search, retrieve, and synthesize unstructured enterprise knowledge documents (PDF, DOCX, Markdown, Text)
  using Hybrid Vector + Lexical BM25 search and TypeSafe Jev verification. Use when answering questions about
  company policies, standard operating procedures (SOP), SLAs, compliance, guidelines, and manuals.
---

# Knowledge RAG & Semantic Retrieval Skill

This skill equips Paperclip agents (especially `KnowledgeAgent` and `ResearchAgent`) to search and synthesize enterprise knowledge documents using a production-grade Hybrid Retrieval engine verified by TypeSafe Jev System One.

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

## 1. Knowledge RAG Retrieval Architecture

Paperclip implements a 4-stage hybrid retrieval pipeline:

```
[ User Query ]
       │
       ▼
1. Query Analysis & Stopword Stripping
       │
       ├──► Dense Vector Embedding (float array / pgvector) ──► Cosine Similarity (30%)
       │                                                                  │
       └──► Substantive Terms & Exact Phrase Extraction     ──► Lexical BM25 & Term Frequency (70%)
                                                                          │
                                                                          ▼
                                                             2. Reciprocal Score Fusion
                                                                          │
                                                                          ▼
                                                             3. Term Density Snippet Windowing
                                                                          │
                                                                          ▼
                                                             4. TypeSafe Jev System One Re-ranking &
                                                                Answerability Verification (isAnswerable, confidence)
                                                                          │
                                                                          ▼
                                                             [ Grounded Citations & Synthesis ]
```

1. **Dense Vector Embeddings**: Cosine similarity matches semantic conceptual meaning even when exact wording differs.
2. **Lexical BM25 & Coverage Boost**: Matches exact legal terms, policy numbers, article codes, and phrase clusters.
3. **Term Density Windowing**: Snippets are extracted around the highest keyword concentration to provide concise context.
4. **TypeSafe Jev System One (jev-1.13.0) Re-ranking**: Fast zero-latency semantic verification checks whether chunks truly answer the user query and assesses confidence to avoid hallucinated answers.

---

## 2. Searching Knowledge Documents

Execute a hybrid semantic search across company documents:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/search-knowledge" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Berapa jaminan SLA uptime untuk layanan cloud tier-1 dan bagaimana prosedur refund jika terjadi downtime?",
    "limit": 5
  }'
```

**Targeted Document Search (Optional Filter):**
To scope the search to a specific document (e.g., SLA Policy):
```json
{
  "query": "kebijakan refund",
  "dataSourceId": "ds-rag-sla-uuid",
  "limit": 3
}
```

**Response Format:**
```json
[
  {
    "chunkId": "chk-uuid-001",
    "dataSourceId": "ds-rag-sla-uuid",
    "dataSourceName": "Cloud SLA Policy 2024",
    "title": "Pasal 4: Jaminan Ketersediaan Layanan (Uptime SLA)",
    "content": "Penyedia menjamin ketersediaan layanan cloud Tier-1 sebesar 99.99% setiap bulannya. Jika uptime berada di bawah 99.95%, pelanggan berhak mengajukan kredit tagihan sebesar 10%...",
    "snippet": "Penyedia menjamin ketersediaan layanan cloud Tier-1 sebesar 99.99% setiap bulannya...",
    "score": 0.88,
    "tokenCount": 142
  }
]
```

---

## 3. Grounded Synthesis & Citation Protocol

To prevent AI hallucination and comply with enterprise governance:

1. **Lead with the Direct Answer**:
   Summarize the core policy rule or answer directly in the first paragraph.
2. **Mandatory Grounded Blockquote Citations**:
   For every factual statement or policy quote, provide the exact reference in blockquote format:
   ```markdown
   > **[1] Sumber: Cloud SLA Policy 2024** (Pasal 4: Jaminan Ketersediaan Layanan)
   > "Penyedia menjamin ketersediaan layanan cloud Tier-1 sebesar 99.99% setiap bulannya. Jika uptime berada di bawah 99.95%, pelanggan berhak mengajukan kredit tagihan sebesar 10%."
   ```
3. **Handle Unanswerable or Ambiguous Queries**:
   If TypeSafe Jev marks `isAnswerable: false` or if `confidence < 0.60`, do NOT guess or extrapolate beyond the retrieved text. Explicitly state:
   *"Informasi spesifik mengenai klausul X tidak disebutkan dalam dokumen internal yang tersedia. Rujukan terdekat hanya membahas ketentuan Y."*
4. **Document Profiles & Multi-Document Citations**:
   When answering questions that span multiple documents (e.g. Employee Handbook + IT Security Policy), synthesize each domain under distinct subheadings and cite both sources.
