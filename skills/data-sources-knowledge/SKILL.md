---
name: data-sources-knowledge
description: >
  Search, retrieve, and synthesize unstructured enterprise knowledge documents (PDF, DOCX, Markdown, Text, HTML)
  using Hybrid Vector + Lexical BM25 retrieval and TypeSafe Jev verification. Use when answering questions about
  company policies, standard operating procedures (SOP), SLAs, compliance, guidelines, and technical manuals.
---

# Knowledge RAG & Semantic Retrieval Skill

This skill equips Paperclip agents (such as `KnowledgeAgent`, `ResearchAgent`, or any agent assigned RAG data sources) to search, retrieve, and synthesize information from company knowledge documents using an ultra-fast Hybrid Retrieval engine (Dense Vector + Lexical BM25).

---

## 🚀 Fast 2-Step Execution Protocol (Speed & Precision)

To deliver instant, accurate responses and avoid execution lag, always follow this streamlined 2-step protocol:

```
[ Step 1: Single-Pass Retrieval ] ──► [ Step 2: Structured Executive Synthesis ]
  (1 fast Python tool or script)         (Immediate direct answer in thread)
```

> **CRITICAL RULES**: 
> 1. Run **EXACTLY ONE** retrieval call using the Python CLI tool. The hybrid engine fuses dense vector embeddings with BM25 term weighting and returns ranked relevant chunks.
> 2. **DO NOT** execute multi-turn query loops, repetitive exploratory commands, or environment dumps.
> 3. Synthesize and deliver the final answer immediately in the next turn.

---

## 1. Primary Action Tool: `search_knowledge.py`

Use the pre-built Python CLI tool directly from bash. It connects directly to the Paperclip Knowledge API and outputs cleanly formatted results in < 100ms.

### Basic Search (Top 6 Chunks):
```bash
python3 skills/data-sources-knowledge/scripts/search_knowledge.py --query "<pertanyaan atau topik yang dicari>" --limit 6
```

### Scoped Search (Target Specific Data Source ID):
```bash
python3 skills/data-sources-knowledge/scripts/search_knowledge.py --query "<kata kunci>" --data-source-id "<data-source-id>" --limit 4
```

### Output Formats:
- `--format compact` (Default): Clean, truncated passages with titles and source document names.
- `--format markdown`: Markdown formatted sections with similarity scores.
- `--format json`: Machine-readable raw JSON data.

*(Note: You can also use `bash skills/data-sources-knowledge/scripts/search-knowledge.sh "<query>" 6` as a shell alternative).*

---

## 2. Executive Synthesis & Presentation Protocol

To ensure clear, executive-grade answers:

### A. Lead with the Direct Answer
Open directly with an executive summary paragraph answering the core question. Use fluent, natural language matching the user's prompt (e.g. natural Indonesian for Indonesian prompts, English for English prompts).

### B. Structured Presentation (Tables or Scannable Bullets)
- For multi-attribute queries, guidelines, component specs, or metrics: **Use a clean Markdown table** or **structured bold bullet points**.
- **STRICT ANTI-REDUNDANCY RULE**: 
  **NEVER repeat identical text in blockquotes under bullet points.** 
  Synthesize the facts directly, clearly, and concisely.

**Contoh Format Ringkasan Bersih:**

| Komponen / Topik | Rincian & Ketentuan Terverifikasi | Dokumen Sumber |
|---|---|---|
| **Ketentuan Utama** | Rincian kebijakan atau prosedur standar operasional | Bab / Bagian Terkait |
| **Persyaratan / Kriteria** | Syarat pemenuhan atau kualifikasi yang dipersyaratkan | Panduan Operasional |
| **Prosedur / Alur** | Langkah-langkah kerja atau eskalasi sistem | Standar Pelaksanaan |

### C. Concise Document Reference Footnote
List verified source documents neatly at the bottom instead of cluttering individual points with repetitive quote blocks:

```markdown
---
### 📚 Referensi Dokumen Internal:
- *Nama_Dokumen_SOP* — Bagian X.Y (Judul Bagian/Topik)
```

### D. Honest Transparency for Unspecified Details
If a specific detail or technical indicator is mentioned broadly in the source document without deep elaboration, explain what is officially documented and state concisely that deeper technical details are not elaborated in the active guide.
