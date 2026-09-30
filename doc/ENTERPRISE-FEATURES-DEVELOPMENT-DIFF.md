# Enterprise Data Sources, Built-In Agents, and Architecture Diff
**Definitive Technical Specification & Comparative Diff Report: `master` vs `development` / `workspace`**

*Document Version:* 3.0.0 (Master-Grade Architecture & Service Breakdown)  
*Date:* September 30, 2026  
*Status:* Complete, Verified & Merged into `workspace`  
*Scope:* 19 Commits | 106 Files Modified/Created | +45,455 Additions / -145 Deletions  

---

## Table of Contents
1. [Executive Summary & Motivation](#1-executive-summary--motivation)
2. [End-to-End System Architecture](#2-end-to-end-system-architecture)
3. [Comprehensive Data Source Architecture by Category](#3-comprehensive-data-source-architecture-by-category)
   - 3.1 [Structured Tabular Data (CSV, Excel, Parquet, Google Sheets)](#31-structured-tabular-data-csv-excel-parquet-google-sheets)
   - 3.2 [Relational & External Databases (PostgreSQL, MariaDB, MySQL, Oracle, MSSQL)](#32-relational--external-databases-postgresql-mariadb-mysql-oracle-mssql)
   - 3.3 [Unstructured Knowledge & Documents (PDF, DOCX, Markdown, TXT)](#33-unstructured-knowledge--documents-pdf-docx-markdown-txt)
   - 3.4 [Streaming, API & Hardware Telemetry (REST API, MQTT IoT, CCTV RTSP/Frigate)](#34-streaming-api--hardware-telemetry-rest-api-mqtt-iot-cctv-rtspfrigate)
4. [Master vs Development Architectural Comparison Matrix](#4-master-vs-development-architectural-comparison-matrix)
5. [Complete Exhaustive Inventory of Modified & Added Files (106 Files)](#5-complete-exhaustive-inventory-of-modified--added-files-106-files)
6. [Deep Dive into Added & Enhanced Backend Services (`server/src/services/`)](#6-deep-dive-into-added--enhanced-backend-services-serversrcservices)
   - 6.1 [`data-sources.ts` (Data Sources Service)](#61-data-sourcests-data-sources-service)
   - 6.2 [`typesafe-jev.ts` (TypeSafe JEV Decision Plane)](#62-typesafe-jevts-typesafe-jev-decision-plane)
   - 6.3 [`ai-reasoning.ts` (Deep Reasoning Ingestion Engine)](#63-ai-reasoningts-deep-reasoning-ingestion-engine)
   - 6.4 [`structured-ingestion.ts` (Tabular File Processing & ClickHouse DDL)](#64-structured-ingestionts-tabular-file-processing--clickhouse-ddl)
   - 6.5 [`knowledge-ingestion.ts` (In-Memory PDF & Hybrid RAG Engine)](#65-knowledge-ingestionts-in-memory-pdf--hybrid-rag-engine)
   - 6.6 [`database-integration.ts` (Multi-Database Driver & Wildcard Optimizer)](#66-database-integrationts-multi-database-driver--wildcard-optimizer)
   - 6.7 [`clickhouse.ts` (High-Throughput OLAP Service)](#67-clickhousets-high-throughput-olap-service)
   - 6.8 [`data-agent.ts` (Runtime Analytics Specialist)](#68-data-agentts-runtime-analytics-specialist)
   - 6.9 [`knowledge-agent.ts` (Runtime Knowledge Retrieval Specialist)](#69-knowledge-agentts-runtime-knowledge-retrieval-specialist)
   - 6.10 [`onboarding-orchestrator.ts` (Automated Onboarding Coordinator)](#610-onboarding-orchestratorts-automated-onboarding-coordinator)
   - 6.11 [`enterprise-orchestrator.ts` (Query Dispatch & Synthesis)](#611-enterprise-orchestratorts-query-dispatch--synthesis)
   - 6.12 [`built-in-agents.ts` & `enterprise-agent-roster.ts` (Roster & Active Skills)](#612-built-in-agentsts--enterprise-agent-rosterts-roster--active-skills)
   - 6.13 [`agents.ts` (Cascade Deletion & Integrity Guard)](#613-agentsts-cascade-deletion--integrity-guard)
7. [Database Schema & Data Contracts (`packages/db` & `packages/shared`)](#7-database-schema--data-contracts-packagesdb--packagesshared)
8. [REST API Surface & Contract Specifications (`server/src/routes/`)](#8-rest-api-surface--contract-specifications-serversrcroutes)
9. [Runtime Skills Catalog (`skills/`)](#9-runtime-skills-catalog-skills)
10. [User Interface Architecture (`ui/`)](#10-user-interface-architecture-ui)
11. [Agent Execution Adapters (`packages/adapters/`)](#11-agent-execution-adapters-packagesadapters)
12. [Chronological Commit Breakdown (19 Commits)](#12-chronological-commit-breakdown-19-commits)
13. [Verification, Quality Gates & Compliance](#13-verification-quality-gates--compliance)

---

## 1. Executive Summary & Motivation

In the base `master` branch, Paperclip served strictly as an autonomous task orchestration control plane. Agents interacted with tasks, ran shell commands, and generated pull requests, but had no built-in mechanism to understand, query, or introspect company data assets.

The `development` / `workspace` branch implements a foundational paradigm shift: **transforming Paperclip into an Enterprise Agentic Data Intelligence Control Plane**. It allows organizations to connect diverse data sources—whether large CSV/Excel spreadsheets, enterprise SQL databases, or unstructured knowledge documents—and equips agents with the exact tools, decision models, and active skills to query and reason over that data safely.

---

## 2. End-to-End System Architecture

```
                                      CLIENT / USER / API
                                                │
                                                ▼
                          ┌───────────────────────────────────────────┐
                          │         Paperclip REST API Layer          │
                          │   /api/companies/:id/data-sources         │
                          └─────────────────────┬─────────────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
  ┌─────────────────────────────┐                               ┌─────────────────────────────┐
  │   ONBOARDING PIPELINE       │                               │     RUNTIME QUERY ENGINE    │
  │  (Onboarding Orchestrator)  │                               │   (Enterprise Orchestrator) │
  └──────────────┬──────────────┘                               └──────────────┬──────────────┘
                 │                                                             │
         TypeSafe JEV (System 1)                                        TypeSafe JEV (System 2)
         Format & Ingestion Triage                                      Semantic Query Routing
                 │                                                             │
     ┌───────────┼───────────┐                                         ┌───────┴───────┐
     ▼           ▼           ▼                                         ▼               ▼
┌─────────┐ ┌─────────┐ ┌─────────┐                               ┌─────────┐     ┌─────────┐
│Structured│ │Knowledge│ │Database │                               │  Data   │     │Knowledge│
│Ingestion│ │Ingestion│ │Ingestion│                               │  Agent  │     │  Agent  │
│  Agent  │ │  Agent  │ │  Agent  │                               └────┬────┘     └────┬────┘
└────┬────┘ └────┬────┘ └────┬────┘                                    │               │
     │           │           │                                         │               │
     ▼           ▼           ▼                                         ▼               ▼
┌─────────┐ ┌─────────┐ ┌─────────┐                               ┌─────────┐     ┌─────────┐
│ClickHouse│ │pgvector │ │Relational│                              │ClickHouse│    │pgvector │
│Batch DDL│ │ & BM25  │ │Schema   │                               │Fast OLAP│     │Dense &  │
│Sync     │ │Index    │ │Mirror   │                               │& SafeSQL│     │BM25 RAG │
└─────────┘ └─────────┘ └─────────┘                               └─────────┘     └─────────┘
```

---

## 3. Comprehensive Data Source Architecture by Category

### 3.1 Structured Tabular Data (CSV, Excel, Parquet, Google Sheets)
- **Supported Formats**: `.csv`, `.tsv`, `.xlsx`, `.xls`, `.parquet`, Google Sheets.
- **Ingestion Engine**: `StructuredIngestionService` (`server/src/services/structured-ingestion.ts`).
- **Processing Flow**:
  1. *Stream Parsing*: Reads tabular rows using streaming buffers without blowing Node.js heap.
  2. *Top-5 Row Sampling*: Analyzes the first 5 non-null rows per column to detect format semantics (e.g., date formats `YYYY-MM-DD`, currency symbols, percentages).
  3. *Statistical Profiling*: Calculates null counts, null ratios (`0.0`–`1.0`), cardinalities, min/max values, and distinct counts.
  4. *JSON Subfield Flattening*: If a column contains JSON strings or objects, the engine recursively parses sample rows, infers subfield schemas (`JsonSubField`), and creates virtual nested dimensions.
  5. *ClickHouse Schema Generation*: Generates an optimized DDL statement (`CREATE TABLE IF NOT EXISTS`) using `ReplacingMergeTree` or `MergeTree`. Column types are mapped to `LowCardinality(String)`, `Nullable(Float64)`, `DateTime64`, etc.
  6. *Batch Sync*: Pushes records into ClickHouse in configurable batches (1,000 to 10,000 rows/batch).
- **Query Flow**:
  - `Data Agent` translates analytical questions into ClickHouse SQL queries (e.g. `SELECT category, sum(revenue) FROM table GROUP BY category`).

### 3.2 Relational & External Databases (PostgreSQL, MariaDB, MySQL, Oracle, MSSQL)
- **Supported Engines**: PostgreSQL (via `postgres.js`), MySQL / MariaDB (via `mysql2`), Microsoft SQL Server, Oracle.
- **Ingestion Engine**: `DatabaseIntegrationService` (`server/src/services/database-integration.ts`).
- **Processing Flow**:
  1. *Live Connection Test*: Verifies credentials, host reachability, SSL enforcement, and network round-trip latency (`latencyMs`).
  2. *Catalog Introspection*: Queries `information_schema.tables`, `information_schema.columns`, `information_schema.key_column_usage`, and index catalogs.
  3. *Relationship Mapping*: Extracts Primary Key (PK) and Foreign Key (FK) constraints, establishing `TableRelation` (`one_to_many`, `many_to_one`, `one_to_one`).
  4. *Table Role Prioritization*: Classifies tables into `fact_table` (transactions), `dimension_table` (entities), `lookup_table` (statuses/codes), or `audit_log`.
  5. *Bilingual Semantic Modeling*: Detects enterprise terminology across Indonesian and English (e.g. `nama_pt`, `npwp`, `nomor_rekening`, `customer_id`, `invoice_date`).
- **Query Flow & Optimization**:
  - **Safe Read-Only Guardrails**: The service rejects non-SELECT queries (`DROP`, `ALTER`, `UPDATE`, `DELETE`, `INSERT`, `TRUNCATE`, `EXEC`).
  - **MariaDB Leading Wildcard Optimizer**:
    ```typescript
    // In MariaDB / MySQL, leading wildcards (e.g. LIKE '%XYZ%') cannot use B-Tree indexes,
    // resulting in full table scans and timeouts on large tables.
    // The optimizer converts leading wildcard queries on indexed columns into prefix scans:
    if (config.type === "mariadb" || config.type === "mysql") {
      finalSql = finalSql.replace(
        /([`"\w]+)\s+LIKE\s+['"]%([^%'"\s][^'"]*?)['"]/gi,
        (_match, col, term) => `${col} LIKE '${term}'`,
      );
    }
    ```

### 3.3 Unstructured Knowledge & Documents (PDF, DOCX, Markdown, TXT)
- **Supported Formats**: `.pdf`, `.docx`, `.doc`, `.md`, `.txt`.
- **Ingestion Engine**: `KnowledgeIngestionService` (`server/src/services/knowledge-ingestion.ts`).
- **Processing Flow**:
  1. *Pure JavaScript PDF Decompression*: Employs `unpdf` to decompress and extract font-mapped text from PDF streams entirely in memory without requiring external binary tools (`poppler`, `pdftotext`).
  2. *DOCX Parsing*: Decompresses Office Open XML ZIP archives and extracts textual nodes from `word/document.xml`.
  3. *Semantic Chunking*: Splits raw text into cohesive chunks (default: 500 words per chunk with 50-word context overlap).
  4. *Hybrid Embedding & Indexing*:
     - Dense vectors: Generates vector embeddings stored in `pgvector`.
     - Sparse lexical index: Tokenizes terms, removes stop words, and stores frequency metrics for BM25 search.
- **Query Flow**:
  - `Knowledge Agent` executes hybrid retrieval combining dense vector similarity and sparse BM25 scores:
    $$\text{Combined Score} = (\text{Dense Score} \times 0.3) + (\min(\text{Lexical Score} / 35, 1.0) \times 0.7)$$
  - **Term Density Windowing**: Locates the highest concentration of query keywords in the chunk and extracts a 500-character snippet window for exact source citation.

### 3.4 Streaming, API & Hardware Telemetry (REST API, MQTT IoT, CCTV RTSP/Frigate)
- **REST APIs (`api_rest`)**: Stores OpenAPI 3.0 / Swagger endpoint specs, auth tokens, base URLs, and headers.
- **MQTT IoT Telemetry (`mqtt_iot`)**: Stores MQTT broker URLs, topic subscriptions, and telemetry payload schemas.
- **CCTV Feeds (`cctv_feed`)**: Stores RTSP stream URLs, Frigate NVR endpoints, camera names, and location tags.

---

## 4. Master vs Development Architectural Comparison Matrix

| Capability | `master` Branch | `development` / `workspace` Branch |
| :--- | :--- | :--- |
| **Data Source Entities** | Not supported. | Dedicated `data_sources` table with JSON schemas and topics. |
| **Ingestion Pipeline** | None. Manual file handling. | Automated multi-agent reasoning ingestion with TypeSafe JEV. |
| **PDF Decompression** | External native binaries required. | In-memory stream decompression via `unpdf`. |
| **OLAP Storage** | None (PostgreSQL OLTP only). | Native **ClickHouse** cluster client with batch insert. |
| **RAG Retrieval** | Simple `ILIKE` on issue tables. | **pgvector** dense vectors + **BM25** hybrid search. |
| **Topic Derivation** | Static regex or none. | **Dynamic Architectural Topic Derivation** based on schema & sample values. |
| **External Databases** | Not accessible by agents. | Native connection pool for PostgreSQL, MariaDB, MySQL, Oracle, MSSQL. |
| **Query Optimization** | N/A | MariaDB B-Tree wildcard prefix rewriting. |
| **Built-In Agents** | Minimal default agent scaffolding. | **6 Core Built-In Agents** provisioned automatically on company creation. |
| **Skill Provisioning** | Manual configuration in UI. | **Out-of-the-Box Active Skills**: `defaultSkillKeys` immediately enabled. |
| **Agent Roster Size** | 17 experimental/niche agents. | Streamlined to **6 Core Agents**; 11 obsolete agents removed. |
| **Agent Deletion Safety** | Failed on foreign key constraints. | Atomic cascade deletion handling `cost_events`, `finance_events`, `assets`, `approvals`. |
| **User Interface** | Boards, Tasks, Settings. | Dedicated **Data Sources** view, detail inspector, schema explorer, and topology graph. |
| **Token Design System** | Inconsistent Tailwind arbitrary values. | 100% compliant with `DESIGN.md` design token layer (`pnpm check:token-gates`). |
| **Local LLM Adapters** | Standard model strings. | Added `cmd/` prefix support for local CLI wrappers and auto-cleanup. |

---

## 5. Complete Exhaustive Inventory of Modified & Added Files (106 Files)

### 5.1 Root Configuration & Environment (3 files)
1. [`.env.example`](file:///Users/danangharissetiawan/Dev/decide/paperclip/.env.example) (`M`): Added `PAPERCLIP_AGENT_JWT_SECRET` and ClickHouse connection configuration keys.
2. [`.gitignore`](file:///Users/danangharissetiawan/Dev/decide/paperclip/.gitignore) (`M`): Added ignore rules for temporary ingestion scratch files and local PGlite dumps.
3. [`pnpm-lock.yaml`](file:///Users/danangharissetiawan/Dev/decide/paperclip/pnpm-lock.yaml) (`M`): Added dependencies for `unpdf`, `mysql2`, `postgres`, `@clickhouse/client`.

### 5.2 Architecture & Customization Documentation (16 files)
4. [`doc/ENTERPRISE-FEATURES-DEVELOPMENT-DIFF.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/doc/ENTERPRISE-FEATURES-DEVELOPMENT-DIFF.md) (`A`): Master technical specification and comparative diff report.
5. [`customization/docs/Agent Orkestrator.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Agent%20Orkestrator.md) (`A`): Comprehensive enterprise orchestrator design document.
6. [`customization/docs/Agent Registry.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Agent%20Registry.md) (`A`): Agent capabilities and role taxonomy.
7. [`customization/docs/Data Source Registry.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Data%20Source%20Registry.md) (`A`): Data source registration contracts.
8. [`customization/docs/Data Source/CCTV.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Data%20Source/CCTV.md) (`A`): RTSP & Frigate surveillance data architecture.
9. [`customization/docs/Data Source/External DB, API, IoT.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Data%20Source/External%20DB,%20API,%20IoT.md) (`A`): External connection patterns and security.
10. [`customization/docs/Data Source/RAG.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Data%20Source/RAG.md) (`A`): Vector indexing and document retrieval specifications.
11. [`customization/docs/Data Source/Structured Data Excel, CSV, Sheets.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Data%20Source/Structured%20Data%20Excel,%20CSV,%20Sheets.md) (`A`): Tabular profiling and ClickHouse mapping design.
12. [`customization/docs/PRD.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/PRD.md) (`A`): Product Requirements Document for enterprise data features.
13. [`customization/docs/Planning.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Planning.md) (`A`): Implementation roadmaps, milestones, and sprint plans.
14. [`customization/docs/README.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/README.md) (`A`): Customization guide index and quick start.
15. [`customization/docs/Secret, Runtime, Artifact, Observability.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Secret,%20Runtime,%20Artifact,%20Observability.md) (`A`): Runtime credential management and tracing.
16. [`customization/docs/Skill Registry & Tool Registry.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Skill%20Registry%20&%20Tool%20Registry.md) (`A`): Catalog of agent skills and tool definitions.
17. [`customization/docs/Tech Stack.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/Tech%20Stack.md) (`A`): Complete technology stack reference.
18. [`customization/docs/TypeSafe AI - Jev Model.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/TypeSafe%20AI%20-%20Jev%20Model.md) (`A`): TypeSafe JEV epistemic decision theory specification.
19. [`customization/docs/notes.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/customization/docs/notes.md) (`A`): Implementation and integration scratchpad notes.

### 5.3 Shared Packages (`packages/shared`, `packages/db`, `packages/adapters`) (19 files)
20. [`packages/adapter-utils/src/session-compaction.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapter-utils/src/session-compaction.ts) (`M`): Session state compaction tuning.
21. [`packages/adapters/codex-local/src/server/acp.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/codex-local/src/server/acp.ts) (`M`): Codex agent protocol updates.
22. [`packages/adapters/codex-local/src/server/test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/codex-local/src/server/test.ts) (`M`): Test runner alignment.
23. [`packages/adapters/hermes/README.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/README.md) (`M`): Hermes gateway adapter documentation.
24. [`packages/adapters/hermes/src/gateway/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/index.ts) (`M`): Gateway initialization.
25. [`packages/adapters/hermes/src/gateway/server/config-schema.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/server/config-schema.ts) (`M`): Gateway config schema validator.
26. [`packages/adapters/hermes/src/gateway/server/execute.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/server/execute.test.ts) (`M`): Gateway execution tests.
27. [`packages/adapters/hermes/src/gateway/server/execute.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/server/execute.ts) (`M`): Gateway command executor.
28. [`packages/adapters/hermes/src/gateway/server/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/server/index.ts) (`M`): Gateway exports.
29. [`packages/adapters/hermes/src/gateway/server/skills.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/hermes/src/gateway/server/skills.ts) (`A`): Hermes skill discovery and execution runtime.
30. [`packages/adapters/pi-local/src/server/execute.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/pi-local/src/server/execute.ts) (`M`): Pi local execution loop.
31. [`packages/adapters/pi-local/src/server/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/pi-local/src/server/index.ts) (`M`): Pi local exports.
32. [`packages/adapters/pi-local/src/server/models.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/pi-local/src/server/models.test.ts) (`M`): Tests for model resolution.
33. [`packages/adapters/pi-local/src/server/models.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/adapters/pi-local/src/server/models.ts) (`M`): Added `cmd/` prefix handling for CLI-wrapped models.
34. [`packages/db/package.json`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/package.json) (`M`): Added dependencies for schema generation.
35. [`packages/db/src/migrations/0285_empty_killraven.sql`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/migrations/0285_empty_killraven.sql) (`A`): Migration creating table `data_sources`.
36. [`packages/db/src/migrations/meta/0285_snapshot.json`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/migrations/meta/0285_snapshot.json) (`A`): Drizzle schema snapshot.
37. [`packages/db/src/migrations/meta/_journal.json`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/migrations/meta/_journal.json) (`M`): Migration journal tracking.
38. [`packages/db/src/schema/data_sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/schema/data_sources.ts) (`A`): Table definition for `data_sources`.
39. [`packages/db/src/schema/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/schema/index.ts) (`M`): Export of `dataSources` schema.
40. [`packages/shared/src/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/index.ts) (`M`): Export of data source contracts.
41. [`packages/shared/src/types/data-source.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/types/data-source.ts) (`A`): Complete TypeScript interfaces for all data source models.
42. [`packages/shared/src/types/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/types/index.ts) (`M`): Re-exports.
43. [`packages/shared/src/types/orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/types/orchestrator.ts) (`A`): Contracts for orchestrator routing and A2A communication.
44. [`packages/shared/src/validators/agent.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/validators/agent.ts) (`M`): Validation schema updates for agent roles.

### 5.4 Server Services, Routes & Middlewares (33 files)
45. [`server/package.json`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/package.json) (`M`): Added server dependencies (`unpdf`, `mysql2`, `postgres`, `@clickhouse/client`).
46. [`server/src/app.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/app.ts) (`M`): Mounted `dataSourceRoutes`.
47. [`server/src/adapters/hermes-gateway-doc.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/adapters/hermes-gateway-doc.ts) (`M`): Hermes gateway docs alignment.
48. [`server/src/built-ins/agents/database-ingestion/AGENTS.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/built-ins/agents/database-ingestion/AGENTS.md) (`A`): Instructions for Database Ingestion Agent.
49. [`server/src/built-ins/agents/knowledge-ingestion/AGENTS.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/built-ins/agents/knowledge-ingestion/AGENTS.md) (`A`): Instructions for Knowledge Ingestion Agent.
50. [`server/src/built-ins/agents/structured-ingestion/AGENTS.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/built-ins/agents/structured-ingestion/AGENTS.md) (`A`): Instructions for Structured Ingestion Agent.
51. [`server/src/middleware/http-log-policy.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/middleware/http-log-policy.ts) (`M`): Log policy configuration.
52. [`server/src/middleware/http-log-redaction.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/middleware/http-log-redaction.ts) (`M`): Redacted database connection passwords from logs.
53. [`server/src/middleware/redact-sensitive.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/middleware/redact-sensitive.ts) (`M`): Redaction helper updates.
54. [`server/src/routes/access.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/routes/access.ts) (`M`): Company access policy rules.
55. [`server/src/routes/agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/routes/agents.ts) (`M`): Agent route handlers and skill inspection.
56. [`server/src/routes/data-sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/routes/data-sources.ts) (`A`): Complete REST routes for `/api/companies/:id/data-sources`.
57. [`server/src/routes/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/routes/index.ts) (`M`): Route aggregator.
58. [`server/src/services/agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/agents.ts) (`M`): Cascade deletion and foreign key mitigation.
59. [`server/src/services/ai-connection-runtime.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/ai-connection-runtime.ts) (`M`): Runtime AI process manager.
60. [`server/src/services/ai-reasoning.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/ai-reasoning.ts) (`A`): Deep reasoning ingestion and profiling engine.
61. [`server/src/services/built-in-agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/built-in-agents.ts) (`M`): 6 Core Built-In Agents with `defaultSkillKeys`.
62. [`server/src/services/clickhouse.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/clickhouse.ts) (`A`): High-throughput ClickHouse OLAP service.
63. [`server/src/services/data-agent.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/data-agent.ts) (`A`): Runtime query analytics and safe read-only SQL specialist.
64. [`server/src/services/data-sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/data-sources.ts) (`A`): Lifecycle manager, search, and hybrid retrieval.
65. [`server/src/services/database-integration.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/database-integration.ts) (`A`): Multi-database connector & MariaDB wildcard optimizer.
66. [`server/src/services/enterprise-agent-roster.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/enterprise-agent-roster.ts) (`A`): Core enterprise agent roster service.
67. [`server/src/services/enterprise-orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/enterprise-orchestrator.ts) (`A`): Multi-agent dispatcher and response synthesizer.
68. [`server/src/services/knowledge-agent.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/knowledge-agent.ts) (`A`): Runtime RAG specialist service.
69. [`server/src/services/knowledge-ingestion.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/knowledge-ingestion.ts) (`A`): In-memory PDF extraction and hybrid vector indexing.
70. [`server/src/services/onboarding-orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/onboarding-orchestrator.ts) (`A`): Multi-agent onboarding coordinator.
71. [`server/src/services/structured-ingestion.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/structured-ingestion.ts) (`A`): Tabular profiling and ClickHouse table generation.
72. [`server/src/services/tool-access.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/tool-access.ts) (`M`): Tool governance and permission checking.
73. [`server/src/services/typesafe-jev.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/typesafe-jev.ts) (`A`): TypeSafe JEV decision plane.
74. [`server/src/__tests__/adapter-routes.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/adapter-routes.test.ts) (`M`): Adapter routing tests.
75. [`server/src/__tests__/built-in-agents.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/built-in-agents.test.ts) (`M`): Built-in agent provisioning tests.
76. [`server/src/__tests__/clickhouse-service.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/clickhouse-service.test.ts) (`A`): ClickHouse connectivity and query tests.
77. [`server/src/__tests__/companies-service.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/companies-service.test.ts) (`M`): Company lifecycle tests.
78. [`server/src/__tests__/data-sources.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/data-sources.test.ts) (`A`): Data source CRUD and upload tests.
79. [`server/src/__tests__/http-log-redaction.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/http-log-redaction.test.ts) (`M`): Password redaction tests.
80. [`server/src/__tests__/knowledge-ingestion.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/knowledge-ingestion.test.ts) (`A`): PDF and document parsing tests.
81. [`server/src/__tests__/onboarding-jev-mapping.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/onboarding-jev-mapping.test.ts) (`A`): JEV System 1 format triage tests.
82. [`server/src/__tests__/tool-access-service.test.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/__tests__/tool-access-service.test.ts) (`M`): Tool access governance tests.

### 5.5 Runtime Agent Skills (4 files)
83. [`skills/data-sources/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources/SKILL.md) (`A`): Master data sources catalog and routing skill.
84. [`skills/data-sources-structured/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources-structured/SKILL.md) (`A`): Tabular file handling, ClickHouse schema, and profiling skill.
85. [`skills/data-sources-knowledge/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources-knowledge/SKILL.md) (`A`): Knowledge RAG, document parsing, and pgvector skill.
86. [`skills/database-integration/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/database-integration/SKILL.md) (`A`): External database connectivity and wildcard optimization skill.

### 5.6 User Interface (UI / Frontend) (20 files)
87. [`ui/src/App.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/App.tsx) (`M`): Added routes for Data Sources and Data Source Detail pages.
88. [`ui/src/adapters/hermes-gateway/config-fields.test.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/adapters/hermes-gateway/config-fields.test.tsx) (`M`): Hermes UI tests.
89. [`ui/src/adapters/hermes-gateway/config-fields.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/adapters/hermes-gateway/config-fields.tsx) (`M`): Hermes gateway UI config fields.
90. [`ui/src/api/data-sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/api/data-sources.ts) (`A`): Typed frontend API client for data sources.
91. [`ui/src/components/AgentConfigForm.render.test.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/AgentConfigForm.render.test.tsx) (`M`): Config form render tests.
92. [`ui/src/components/AgentConfigForm.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/AgentConfigForm.tsx) (`M`): Agent configuration form enhancements.
93. [`ui/src/components/DatabaseIngestionConfigCard.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/DatabaseIngestionConfigCard.tsx) (`A`): UI config card for database ingestion settings.
94. [`ui/src/components/KnowledgeIngestionConfigCard.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/KnowledgeIngestionConfigCard.tsx) (`A`): UI config card for document ingestion settings.
95. [`ui/src/components/Sidebar.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/Sidebar.tsx) (`M`): Added **Data Sources** menu item in company navigation.
96. [`ui/src/components/StructuredIngestionConfigCard.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/StructuredIngestionConfigCard.tsx) (`A`): UI config card for tabular file ingestion settings.
97. [`ui/src/components/new-agent/NewAgentSetup.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/new-agent/NewAgentSetup.tsx) (`M`): New agent creation wizard updates.
98. [`ui/src/lib/activity-format.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/lib/activity-format.ts) (`M`): Activity feed formatting for data source events.
99. [`ui/src/lib/company-routes.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/lib/company-routes.ts) (`M`): Added data source route helpers.
100. [`ui/src/pages/AgentDetail.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/AgentDetail.tsx) (`M`): Agent detail view enhancements.
101. [`ui/src/pages/Agents.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/Agents.tsx) (`M`): Agent list view updates.
102. [`ui/src/pages/DataSourceDetail.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/DataSourceDetail.tsx) (`A`): Detailed inspector for schema, sample rows, topics, and topology.
103. [`ui/src/pages/DataSources.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/DataSources.tsx) (`A`): Data sources dashboard and file upload dropzone.
104. [`ui/src/pages/NewAgent.test.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/NewAgent.test.tsx) (`M`): Agent creation test suite updates.
105. [`ui/src/pages/apps/AppDetail.test.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/apps/AppDetail.test.tsx) (`M`): App detail tests.
106. [`ui/src/pages/apps/app-detail/AdvancedPanel.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/apps/app-detail/AdvancedPanel.tsx) (`M`): Advanced app settings panel.

---

## 6. Deep Dive into Added & Enhanced Backend Services (`server/src/services/`)

### 6.1 `data-sources.ts` (Data Sources Service)
- **Class**: `DataSourcesService`
- **Location**: [`server/src/services/data-sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/data-sources.ts) (1,036 lines)
- **Key Responsibilities**:
  - `create(companyId, input)`: Registers a new data source record in PostgreSQL.
  - `getById(id)`: Fetches data source with schema snapshot and semantic model.
  - `list(companyId)`: Lists all sources for an organization, filtered by active status.
  - `update(id, patch)`: Updates configurations, schedules, or names.
  - `delete(id)`: Deletes data source and automatically drops corresponding ClickHouse tables.
  - `searchEntities(companyId, term, options)`: Performs fuzzy and exact matches across all onboarded tables, prioritizing primary keys and entity columns.
  - `searchChunksHybrid(companyId, query, options)`: Executes hybrid vector/BM25 search over document chunks.
  - `getNetworkTopology(companyId)`: Computes an adjacency matrix of cross-table relationships across all active databases and files.

### 6.2 `typesafe-jev.ts` (TypeSafe JEV Decision Plane)
- **Class**: `TypeSafeJevService`
- **Location**: [`server/src/services/typesafe-jev.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/typesafe-jev.ts) (2,298 lines)
- **Key Responsibilities**:
  - `systemOne(state, questions, options)`: Fast HTTP evaluation to the TypeSafe AI endpoint with automatic fallback.
  - `routeUserQuery(userQuery, companyId, registeredAgents, sources)`: Dynamically generates criteria and routes queries to either `data_agent`, `knowledge_agent`, or `homseo`.
  - `deriveArchitecturalTopics(tableName, columns, samples, relations)`: Inspects table schemas and sample data to identify business domains without hardcoded regular expressions.
  - `fallbackDecision(state, questions)`: Provides robust local epistemic heuristic scoring when remote API endpoints are unreachable.

### 6.3 `ai-reasoning.ts` (Deep Reasoning Ingestion Engine)
- **Class**: `AiReasoningService`
- **Location**: [`server/src/services/ai-reasoning.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/ai-reasoning.ts) (1,227 lines)
- **Key Responsibilities**:
  - `analyzeTableSchema(tableName, columns, sampleRows)`: Executes deep reasoning over column semantics, identifying primary keys, dimensions, metrics, and relationships.
  - `analyzeDocument(text, title, mimeType)`: Analyzes unstructured text to extract key themes, target agent affinities, and business entities.
  - `flattenJsonSubFields(columnName, sampleValues)`: Inspects JSON columns, identifies object/array topologies, and generates virtual sub-fields.

### 6.4 `structured-ingestion.ts` (Tabular File Processing & ClickHouse DDL)
- **Class**: `StructuredIngestionService`
- **Location**: [`server/src/services/structured-ingestion.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/structured-ingestion.ts) (652 lines)
- **Key Responsibilities**:
  - `parseFile(buffer, fileName, mimeType)`: Memory-efficient streaming parser for CSV, Excel, and Parquet.
  - `profileColumns(rows, columnNames)`: Generates detailed statistical profiles (null ratio, distinct count, cardinality).
  - `generateClickhouseDdl(tableName, columns, options)`: Emits optimized `CREATE TABLE` DDL for ClickHouse.

### 6.5 `knowledge-ingestion.ts` (In-Memory PDF & Hybrid RAG Engine)
- **Class**: `KnowledgeIngestionService`
- **Location**: [`server/src/services/knowledge-ingestion.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/knowledge-ingestion.ts) (328 lines)
- **Key Responsibilities**:
  - `parseDocument(buffer, fileName, mimeType)`: Extracts text using `unpdf` for PDF, ZIP parsing for DOCX, and raw UTF-8 for Markdown.
  - `chunkText(text, options)`: Segments documents into 500-word chunks with 50-word overlap.
  - `indexHybrid(companyId, sourceId, chunks)`: Generates dense embeddings for `pgvector` and tokens for BM25.

### 6.6 `database-integration.ts` (Multi-Database Driver & Wildcard Optimizer)
- **Class**: `DatabaseIntegrationService`
- **Location**: [`server/src/services/database-integration.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/database-integration.ts) (1,241 lines)
- **Key Responsibilities**:
  - `testConnection(config)`: Validates credentials and measures ping latency.
  - `inspectDatabase(config)`: Introspects tables, columns, constraints, foreign keys, and indexes.
  - `executeReadOnlyQuery(config, sql, limit)`: Runs parameterized queries with strict read-only enforcement and execution timeouts.
  - `optimizeWildcardQuery(sql, dbType)`: Rewrites `col LIKE '%XYZ%'` to `col LIKE 'XYZ%'` in MariaDB/MySQL to enable index prefix scans.

### 6.7 `clickhouse.ts` (High-Throughput OLAP Service)
- **Class**: `ClickhouseService`
- **Location**: [`server/src/services/clickhouse.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/clickhouse.ts) (269 lines)
- **Key Responsibilities**:
  - `insertBatch(table, rows)`: Streams records into ClickHouse in batches of up to 10,000 rows.
  - `query(sql, params)`: Executes analytical aggregations (`SUM`, `AVG`, `COUNT DISTINCT`) over massive datasets.

### 6.8 `data-agent.ts` (Runtime Analytics Specialist)
- **Class**: `DataAgentService`
- **Location**: [`server/src/services/data-agent.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/data-agent.ts) (876 lines)
- **Key Responsibilities**:
  - `answer(companyId, query)`: Natural language query processor.
  - Table role prioritization: `fact_table` (4) > `dimension_table` (3) > `lookup_table` (2) > `audit_log` (0).
  - Routes complex aggregations to ClickHouse and entity lookups to the source database.

### 6.9 `knowledge-agent.ts` (Runtime Knowledge Retrieval Specialist)
- **Class**: `KnowledgeAgentService`
- **Location**: [`server/src/services/knowledge-agent.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/knowledge-agent.ts) (124 lines)
- **Key Responsibilities**:
  - `answer(companyId, query)`: Queries `pgvector` and BM25 indices using reciprocal rank fusion (`dense * 0.3 + lexical * 0.7`).
  - Formats responses with exact document citations and snippet references.

### 6.10 `onboarding-orchestrator.ts` (Automated Onboarding Coordinator)
- **Class**: `OnboardingOrchestratorService`
- **Location**: [`server/src/services/onboarding-orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/onboarding-orchestrator.ts) (1,365 lines)
- **Key Responsibilities**:
  - `onboardSource(companyId, fileOrConfig, options)`: Coordinates the end-to-end ingestion pipeline:
    1. System 1 format triage.
    2. Dispatching to the appropriate specialist agent (`Structured`, `Knowledge`, or `Database Ingestion Agent`).
    3. Running the 5-stage deep reasoning loop.
    4. Synchronizing tabular records to ClickHouse and document chunks to pgvector.
    5. Registering the data source as `ready`.

### 6.11 `enterprise-orchestrator.ts` (Query Dispatch & Synthesis)
- **Class**: `EnterpriseOrchestratorService`
- **Location**: [`server/src/services/enterprise-orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/enterprise-orchestrator.ts) (212 lines)
- **Key Responsibilities**:
  - Multi-agent dispatch, JEV routing, and response synthesis across structured data and knowledge documents.

### 6.12 `built-in-agents.ts` & `enterprise-agent-roster.ts` (Roster & Active Skills)
- **Location**: [`server/src/services/built-in-agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/built-in-agents.ts) & [`server/src/services/enterprise-agent-roster.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/enterprise-agent-roster.ts)
- **Key Responsibilities**:
  - Defines the 6 Core Built-In Agents.
  - Automatically provisions agents upon company creation via `AUTO_PROVISION_ON_COMPANY_CREATE_KEYS`.
  - Injects `defaultSkillKeys` into `adapterConfig.paperclipSkillSyncPreference.desiredSkillEntries`.
  - Ensures skills are immediately active out-of-the-box.

### 6.13 `agents.ts` (Cascade Deletion & Integrity Guard)
- **Location**: [`server/src/services/agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/agents.ts) (modified `remove` method)
- **Key Responsibilities**:
  - Implements atomic cascade deletion for `heartbeat_run_events`, `cost_events`, and `finance_events`.
  - Safely nullifies `assets.createdByAgentId`, `approvals.requestedByAgentId`, `goals.ownerAgentId`, and `issues.conversationAgentId`.
  - Eliminates foreign key violation errors when deleting agents.

---

## 7. Database Schema & Data Contracts (`packages/db` & `packages/shared`)

### Database Table: `data_sources`
```sql
CREATE TABLE IF NOT EXISTS "data_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "source_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "schema_snapshot" jsonb,
  "semantic_model" jsonb,
  "clickhouse_table" text,
  "error_message" text,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "data_sources_company_type_idx" ON "data_sources" ("company_id", "type");
CREATE INDEX "data_sources_company_status_idx" ON "data_sources" ("company_id", "status");
```

---

## 8. REST API Surface & Contract Specifications (`server/src/routes/`)

Base Endpoint: `/api/companies/:companyId/data-sources`

```
GET    /api/companies/:companyId/data-sources              -> List all company data sources
POST   /api/companies/:companyId/data-sources              -> Register database or API data source
POST   /api/companies/:companyId/data-sources/upload       -> Multipart file upload (CSV, XLSX, PDF, DOCX)
GET    /api/companies/:companyId/data-sources/:id          -> Fetch full schema snapshot & semantic model
PATCH  /api/companies/:companyId/data-sources/:id          -> Update data source name, sync schedule, or config
DELETE /api/companies/:companyId/data-sources/:id          -> Drop data source and associated ClickHouse tables
POST   /api/companies/:companyId/data-sources/:id/sync     -> Trigger immediate manual re-sync
POST   /api/companies/:companyId/data-sources/:id/test-connection -> Test live database connection & latency
GET    /api/companies/:companyId/data-sources/search/entities      -> Search entities across all data sources
GET    /api/companies/:companyId/data-sources/topology/network     -> Retrieve cross-table network topology graph
```

---

## 9. Runtime Skills Catalog (`skills/`)

- [`skills/data-sources/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources/SKILL.md): Master discovery and classification skill.
- [`skills/data-sources-structured/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources-structured/SKILL.md): Standard operating procedure for tabular datasets, ClickHouse DDL, and statistical profiling.
- [`skills/data-sources-knowledge/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/data-sources-knowledge/SKILL.md): Document chunking, pgvector embeddings, and hybrid citation generation.
- [`skills/database-integration/SKILL.md`](file:///Users/danangharissetiawan/Dev/decide/paperclip/skills/database-integration/SKILL.md): External database connectivity, MariaDB wildcard optimization, and safe read-only SQL queries.

---

## 10. User Interface Architecture (`ui/`)

- **Data Sources Dashboard ([`ui/src/pages/DataSources.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/DataSources.tsx))**:
  - Filterable by type (`file`, `database`, `api`) and status (`ready`, `indexing`, `error`).
  - Drag-and-drop file upload dropzone.
  - Connection modal for PostgreSQL, MariaDB, MySQL, SQL Server, and Oracle.
- **Data Source Detail View ([`ui/src/pages/DataSourceDetail.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/pages/DataSourceDetail.tsx))**:
  - Schema table explorer with column type badges and sample row previews.
  - Semantic topics visual tags with confidence scores.
  - ClickHouse synchronization status badges.
  - Interactive Cross-Table Topology Graph.
- **Sidebar Integration ([`ui/src/components/Sidebar.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/Sidebar.tsx))**:
  - Added **Data Sources** navigation item with database icon.
- **Design System Token Compliance**:
  - 100% compliant with `ui/src/index.css` token layer (`pnpm check:token-gates` passed).

---

## 11. Agent Execution Adapters (`packages/adapters/`)

- **Pi Local Adapter**:
  - Added support for `cmd/` prefix for CLI-wrapped local LLMs.
  - Implemented automatic process cleanup on adapter switch.
- **Hermes Gateway Adapter**:
  - Added dynamic skill discovery and execution in `packages/adapters/hermes/src/gateway/server/skills.ts`.

---

## 12. Chronological Commit Breakdown (19 Commits)

```
1.  513323a26: feat: enterprise data sources, database integration, Jev decision plane, and native agent orchestrator
2.  769198470: feat: integrate TypeSafe Jev System One semantic format triage into onboarding orchestrator
3.  ed2d44c37: feat(data-sources): inspect top 5 sample rows, map JSON subfields, and generate ClickHouse schema
4.  15fdd65fd: feat(agents): verify and ensure multi-agent A2A communication, delegation, and full semantic routing
5.  54038f240: fix(auth): document PAPERCLIP_AGENT_JWT_SECRET in .env.example
6.  bfa9f794c: feat(adapter-pi-local): support cmd/ model prefix and clean aiConnection on adapter switch
7.  4a802aa94: fix(data-sources): use multipart postForm for file upload and support docx decompression
8.  d1ebcf776: fix(knowledge-ingestion): decompress PDF streams with unpdf and improve hybrid RAG ranking
9.  4352d1ecd: feat(data-sources): implement multi-agent onboarding with dynamic JEV semantic profiling
10. 01af989e8: fix(rag): optimize query term isolation and density window snippet extraction
11. 505bd3fc6: feat(onboarding): implement deep reasoning ingestion, dynamic semantic profiling, JSON field introspection, and cross-table relations with TypeSafe JEV
12. f838d898c: fix(db-integration): optimize MariaDB leading wildcard queries on indexed company name columns to prevent full table scan timeouts
13. 89ad3159f: feat(data-sources): make entity search, semantic categorization, and profiling fully dynamic
14. bb601047c: fix(data-sources): populate semantic topics for external databases and render them in UI
15. 3bcd557df: feat(jev): replace static database topic regex with purely dynamic architectural topic derivation
16. 291381eef: feat(pi): tune session defaults
17. d34796986: feat(data-sources): add per-table semantic topics & cross-table network topology
18. fcff8853e: feat(skills): enhance dynamic external database retrieval flow and reasoning in skills and agents
19. 654b5e1ac: feat(agents): auto-provision core built-in agents with default active skills and cascade deletion
```

---

## 13. Verification, Quality Gates & Compliance

- **Server Typecheck**: `pnpm --filter @paperclipai/server typecheck` ➔ **PASSED (0 errors)**.
- **Design Token Audit**: `pnpm check:token-gates` ➔ **PASSED (All gates clean across 1,078 files)**.
- **Database Migrations**: Migration `0285_empty_killraven.sql` applied cleanly in dev PGlite.
- **Auto-Provisioning Verification**: Verified on new company creation that only the 6 core agents are created with active skills.
- **Cascade Deletion Verification**: Obsolete agents cleanly removed from `rissets` and `decide` without foreign key constraint errors.
- **Git Synchronization**: Pushed to `origin/workspace`.
