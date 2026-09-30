# Enterprise Data Sources, Built-In Agents, and Architecture Diff
**Branch Comparison: `master` vs `development` / `workspace`**

*Document Version:* 1.0.0  
*Date:* September 30, 2026  
*Status:* Complete & Verified  

---

## 1. Executive Summary

This document provides a comprehensive technical comparison between the base `master` branch and the feature branch (`development` / `workspace`). 

Over the course of 19 commits, **106 files were modified or added** (+45,455 insertions, -145 deletions). The changes transform Paperclip from a task-orchestration control plane into an enterprise-grade agentic data intelligence platform. The platform natively ingests, classifies, profiles, and queries heterogeneous enterprise data sources (structured files, relational databases, and unstructured knowledge documents) with high-assurance **TypeSafe JEV** reasoning and out-of-the-box **Built-In Agents** with active skills.

```
                           +---------------------------------------+
                           |          Paperclip Control Plane      |
                           +-------------------+-------------------+
                                               |
              +--------------------------------+--------------------------------+
              |                                                                 |
+-------------v---------------+                                   +-------------v---------------+
|     Data Ingestion Layer    |                                   |     Runtime Retrieval       |
+-----------------------------+                                   +-----------------------------+
| 1. Structured Ingestion     |                                   | 1. Data Agent               |
|    - CSV, Excel, Parquet    |                                   |    - Safe Read-Only SQL     |
|    - ClickHouse Sync        |                                   |    - ClickHouse Aggregation |
| 2. Knowledge Ingestion      |                                   | 2. Knowledge Agent          |
|    - PDF (unpdf), DOCX, MD  |                                   |    - pgvector Semantic RAG  |
|    - pgvector + BM25 Hybrid |                                   |    - BM25 Fulltext Search   |
| 3. Database Ingestion       |                                   | 3. Homseo (Lead Agent)      |
|    - PostgreSQL, MySQL,     |                                   |    - JEV System 1 & 2 Triage|
|      MariaDB, Oracle, MSSQL |                                   |    - Cross-domain Routing   |
+-----------------------------+                                   +-----------------------------+
              |                                                                 |
              +--------------------------------+--------------------------------+
                                               |
                               +---------------v---------------+
                               |  Core Storage & State Plane   |
                               +-------------------------------+
                               | - PostgreSQL / PGlite         |
                               | - ClickHouse OLAP Engine      |
                               | - pgvector Vector Store       |
                               +-------------------------------+
```

---

## 2. Master vs Development High-Level Comparison

| Feature / Capability | `master` Branch | `development` / `workspace` Branch |
| :--- | :--- | :--- |
| **Data Sources Concept** | Not present; no database schema or UI for data sources. | First-class entity (`data_sources` table) supporting tabular files, databases, APIs, IoT, and CCTV. |
| **Data Ingestion Engine** | None. Manual file uploads only as task attachments. | Automated deep reasoning ingestion for CSV, Excel, Parquet, PDF, DOCX, and live relational databases. |
| **OLAP & Analytics** | None. Pure transactional PostgreSQL. | Integrated **ClickHouse** service for high-volume tabular sync, schema auto-generation, and analytical execution. |
| **Vector Search & RAG** | Basic text search on issues and comments. | **pgvector** vector embeddings + BM25 hybrid ranking with semantic window chunking. |
| **Decision Model** | Hardcoded heuristics and rule-based dispatch. | **TypeSafe JEV (Justified Epistemic Value)** System 1 (format triage) & System 2 (architectural topic derivation). |
| **Built-In Agents** | Minimal default agent scaffolding. | **6 Core Built-In Agents** automatically provisioned on company creation with instantly active skills. |
| **Agent Roster Model** | Flat, manual configuration for every agent. | Tiered hierarchy (Homseo lead + Ingestion Specialists + Query Specialists) with 11 obsolete niche agents removed. |
| **Agent Deletion Integrity** | Foreign key failures when deleting agents with assets/runs. | Safe cascade deletion handling `cost_events`, `finance_events`, `assets`, `approvals`, and `goals`. |
| **Runtime Skills** | Standard system tools only. | 4 domain-specific skills: `data-sources`, `data-sources-structured`, `data-sources-knowledge`, `database-integration`. |
| **UI Management** | Tasks, Agents, Projects, Settings. | Dedicated **Data Sources** view, deep detail inspector, schema visualization, and cross-table topology network graph. |
| **Model Adapter Support** | Standard API and local execution. | Added `cmd/` prefix support for Pi Local adapter, automatic connection cleanup, and Hermes skill execution. |

---

## 3. Database Layer (`packages/db`)

### 3.1 New Table: `data_sources`
Located in [`packages/db/src/schema/data_sources.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/schema/data_sources.ts) and exported in [`packages/db/src/schema/index.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/db/src/schema/index.ts):

```typescript
export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    type: text("type").$type<DataSourceType>().notNull(), // "file" | "database" | "api" | "iot" | "cctv"
    status: text("status").$type<DataSourceStatus>().notNull().default("pending"), // "pending" | "indexing" | "ready" | "error"
    sourceConfig: jsonb("source_config").$type<Record<string, unknown>>().notNull().default({}),
    schemaSnapshot: jsonb("schema_snapshot").$type<DataSourceSchemaSnapshot>(),
    semanticModel: jsonb("semantic_model").$type<DataSourceSemanticModel>(),
    clickhouseTable: text("clickhouse_table"),
    errorMessage: text("error_message"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("data_sources_company_type_idx").on(table.companyId, table.type),
    companyStatusIdx: index("data_sources_company_status_idx").on(table.companyId, table.status),
  }),
);
```

### 3.2 Migration `0285_empty_killraven.sql`
- Creates table `data_sources` with UUID primary key.
- Establishes foreign key constraint to `companies(id)`.
- Adds compound indexes `data_sources_company_type_idx` and `data_sources_company_status_idx`.
- Updates Drizzle migration journal and schema snapshots.

### 3.3 Foreign Key Cascades & Agent Removal Safety
In [`server/src/services/agents.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/server/src/services/agents.ts#L1080-L1115):
- Deletes dependent rows in `heartbeat_run_events`, `cost_events`, and `finance_events` referencing `heartbeat_runs.id` and `agent.id`.
- Nullifies `assets.created_by_agent_id`, `approvals.requested_by_agent_id`, `goals.owner_agent_id`, `issues.conversation_agent_id`, and `issue_thread_interactions`.
- Prevents database runtime `violates foreign key constraint` errors when retiring or deleting agents.

---

## 4. Shared Types & Domain Contracts (`packages/shared`)

Located in [`packages/shared/src/types/data-source.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/types/data-source.ts) and [`packages/shared/src/types/orchestrator.ts`](file:///Users/danangharissetiawan/Dev/decide/paperclip/packages/shared/src/types/orchestrator.ts):

1. **`DataSourceType` & `DataSourceStatus`**:
   - Types: `"file" | "database" | "api" | "iot" | "cctv"`
   - Statuses: `"pending" | "indexing" | "ready" | "error"`
2. **`DataSourceSchemaSnapshot`**:
   - Represents introspected tables, columns, primary keys, foreign key relations, data types, and sample data.
3. **`DynamicSemanticTopic`**:
   - Dynamic architectural classification (e.g. `commercial_clients`, `procurement_contracts`, `financial_ledgers`) derived at runtime from headers, entity relationships, and value distributions.
4. **`CrossTableTopology`**:
   - Node-and-edge graph mapping entity relationships across tables and files for automated JOIN path resolution.
5. **`DatabaseConnectionConfig`**:
   - Secure connection options for PostgreSQL, MariaDB, MySQL, SQL Server, and Oracle (host, port, database, credentials, SSL, connection timeouts, and connection pool sizing).

---

## 5. Backend Services & Intelligence Architecture (`server/src/services/`)

### 5.1 TypeSafe JEV Decision Plane (`typesafe-jev.ts`)
- **System 1 Triage**: Fast heuristic and MIME-type classification routing raw inputs to the proper ingestion engine in under 5ms.
- **System 2 Architectural Reasoning**:
  - Dynamically inspects table schemas, column names, bilingual aliases (Indonesian & English, e.g., `nama_pt`, `nomor_surat`, `npwp`, `kode_rekening`), and foreign key graphs.
  - Replaced static regular expressions with contextual domain derivation.
  - Computes an epistemic confidence score (`epistemicScore`) ensuring query agents understand the semantics before executing queries.

### 5.2 Structured Ingestion Service (`structured-ingestion.ts`)
- Ingests CSV, XLSX, XLS, and Parquet datasets.
- Inspects top sample rows to infer column data types, null ratios, cardinality, and distribution.
- Flattens nested JSON subfields automatically.
- Generates and executes ClickHouse table schemas (`ReplacingMergeTree` or `MergeTree`) with appropriate column types (`LowCardinality(String)`, `Nullable`, `DateTime64`).

### 5.3 Knowledge Ingestion Service (`knowledge-ingestion.ts`)
- Ingests unstructured files: PDF, DOCX, Markdown, and TXT.
- **Pure JavaScript PDF Stream Decompression**: Uses `unpdf` to parse PDF files in memory without external binaries (like `pdftotext` or `poppler`).
- Semantic chunking with context overlap and density window extraction.
- Syncs document embeddings to `pgvector` and tokenized keywords to BM25 search indices for hybrid search.

### 5.4 Database Integration Service (`database-integration.ts`)
- Provides live connectivity to PostgreSQL, MySQL, MariaDB, Oracle, and Microsoft SQL Server.
- Introspects tables, columns, primary keys, foreign keys, and indexes.
- **MariaDB / MySQL Wildcard Optimization**: Rewrites query plans with leading wildcards (`%keyword%`) on indexed company name columns to utilize prefix filters or fulltext indexes, preventing table scan timeouts.
- Generates CDC (Change Data Capture) synchronization blueprints into ClickHouse.

### 5.5 ClickHouse Service (`clickhouse.ts`)
- Native HTTP client for ClickHouse communication.
- Manages connection lifecycle, table creation, batch inserts (1,000 to 10,000 rows/batch), analytical aggregations, and health monitoring.

### 5.6 Runtime Query Specialists
- **`data-agent.ts`**:
  - Runtime service powering **Data Agent**.
  - Dual-mode dynamic query engine: checks semantic topic context & schema catalog first, then selects either safe read-only SQL on the external database or high-performance aggregation on ClickHouse.
  - Includes strict SQL guardrails prohibiting DDL/DML mutations (`DROP`, `ALTER`, `UPDATE`, `DELETE`, `INSERT`, `TRUNCATE`).
- **`knowledge-agent.ts`**:
  - Runtime service powering **Knowledge Agent**.
  - Hybrid RAG retrieval combining vector similarity scores and BM25 term density.
  - Extracts exact citations and references.

### 5.7 Built-In Agents & Roster Overhaul (`built-in-agents.ts` & `enterprise-agent-roster.ts`)
- **6 Core Built-In Agents** defined with `defaultSkillKeys`:
  1. `Homseo` (`builtin:homseo`) – Lead orchestrator.
  2. `Structured Ingestion Agent` (`builtin:structured-ingestion`) – File ingestion.
  3. `Knowledge Ingestion Agent` (`builtin:knowledge-ingestion`) – Document & RAG ingestion.
  4. `Database Ingestion Agent` (`builtin:database-ingestion`) – Live database ingestion.
  5. `Data Agent` (`builtin:data-agent`) – Relational & tabular query specialist.
  6. `Knowledge Agent` (`builtin:knowledge-agent`) – Knowledge base retrieval specialist.
- **Immediate Skill Activation**:
  - Automatically maps `defaultSkillKeys` into `agent.adapterConfig.paperclipSkillSyncPreference.desiredSkillEntries` and `desiredSkills`.
  - Skills are live and active immediately upon organization creation.
- **Roster Pruning**:
  - Removed 11 non-essential niche agents (`PredictionAgent`, `OnboardingOrchestrator`, `ResearchAgent`, `ActionAgent`, `AgentBuilder`, `ApiIntegrationAgent`, `VisionAgent`, `IotIntegrationAgent`, `CctvIntegrationAgent`, `McpBuilderAgent`, `AnalyticsEngineerAgent`).

---

## 6. REST API Endpoints (`server/src/routes/data-sources.ts`)

Base Route: `/api/companies/:companyId/data-sources`

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | List all data sources for a company with status and summary metrics. |
| `POST` | `/` | Register a new data source (e.g., database connection configuration). |
| `POST` | `/upload` | Multipart file upload (CSV, XLSX, PDF, DOCX) with instant triage and background ingestion. |
| `GET` | `/:id` | Retrieve full data source details, schema snapshot, semantic model, and topics. |
| `PATCH`| `/:id` | Update data source name, configuration, or scheduling options. |
| `DELETE`| `/:id` | Delete data source, clean up associated ClickHouse tables and vector indices. |
| `POST` | `/:id/sync` | Trigger an immediate re-sync to ClickHouse / vector store. |
| `POST` | `/:id/test-connection` | Test live database connectivity and credential validity. |
| `GET` | `/search/entities` | Search entities across all registered data sources using fuzzy and exact match. |
| `GET` | `/topology/network` | Retrieve cross-table network topology graph for the company. |

---

## 7. Runtime Skills Catalog (`skills/`)

Four domain-specific skills were authored and registered in the catalog:

1. **`skills/data-sources/SKILL.md`**:
   - Master skill for discovery, classification, and routing of enterprise data sources.
   - Instructs agents on identifying source types and choosing the right sub-agent or ingestion tool.
2. **`skills/data-sources-structured/SKILL.md`**:
   - Comprehensive instructions for handling CSV, Excel, and Parquet files.
   - ClickHouse schema generation, batch sync strategies, and statistical profiling.
3. **`skills/data-sources-knowledge/SKILL.md`**:
   - Guidelines for parsing unstructured documents (PDF, DOCX, Markdown).
   - Text chunking parameters, embedding generation, pgvector indexing, and hybrid search.
4. **`skills/database-integration/SKILL.md`**:
   - Complete standard operating procedure for external database connectivity.
   - Connection validation, schema extraction, MariaDB index-aware wildcard optimization, and safe read-only SQL execution.

---

## 8. User Interface (`ui/`)

### 8.1 Pages
- **`ui/src/pages/DataSources.tsx`**:
  - Data sources dashboard with status filters (All, Ready, Indexing, Error).
  - Drag-and-drop file upload zone for instant document & tabular file ingestion.
  - Modal form for configuring external database connections (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle).
- **`ui/src/pages/DataSourceDetail.tsx`**:
  - Detailed view of a data source.
  - Interactive table explorer showing column names, inferred data types, null counts, and sample values.
  - Semantic topics visual tags and confidence scores.
  - ClickHouse synchronization status and health badges.
  - Cross-table topology visualizer.

### 8.2 Ingestion Config Cards
- `ui/src/components/StructuredIngestionConfigCard.tsx`
- `ui/src/components/KnowledgeIngestionConfigCard.tsx`
- `ui/src/components/DatabaseIngestionConfigCard.tsx`

### 8.3 Navigation & Styling
- Added **Data Sources** item with database icon to [`ui/src/components/Sidebar.tsx`](file:///Users/danangharissetiawan/Dev/decide/paperclip/ui/src/components/Sidebar.tsx).
- 100% compliant with the `DESIGN.md` token system (`pnpm check:token-gates` clean).

---

## 9. Model Adapters & Runtime Engine (`packages/adapters/`)

- **Pi Local Adapter (`packages/adapters/pi-local/`)**:
  - Added support for `cmd/` model prefix to run local CLI agent models smoothly.
  - Cleaned `aiConnection` cleanup on adapter switch to prevent orphaned processes.
- **Hermes Gateway Adapter (`packages/adapters/hermes/`)**:
  - Implemented skill discovery and execution in `packages/adapters/hermes/src/gateway/server/skills.ts`.
- **Codex Local Adapter (`packages/adapters/codex-local/`)**:
  - Minor test harness and ACP alignment updates.

---

## 10. Commit History & Chronology (master..workspace)

```
654b5e1ac feat(agents): auto-provision core built-in agents with default active skills and cascade deletion
fcff8853e feat(skills): enhance dynamic external database retrieval flow and reasoning in skills and agents
d34796986 feat(data-sources): add per-table semantic topics & cross-table network topology
291381eef feat(pi): tune session defaults
3bcd557df feat(jev): replace static database topic regex with purely dynamic architectural topic derivation
bb601047c fix(data-sources): populate semantic topics for external databases and render them in UI
89ad3159f feat(data-sources): make entity search, semantic categorization, and profiling fully dynamic
f838d898c fix(db-integration): optimize MariaDB leading wildcard queries on indexed company name columns to prevent full table scan timeouts
505bd3fc6 feat(onboarding): implement deep reasoning ingestion, dynamic semantic profiling, JSON field introspection, and cross-table relations with TypeSafe JEV
01af989e8 fix(rag): optimize query term isolation and density window snippet extraction
4352d1ecd feat(data-sources): implement multi-agent onboarding with dynamic JEV semantic profiling
d1ebcf776 fix(knowledge-ingestion): decompress PDF streams with unpdf and improve hybrid RAG ranking
4a802aa94 fix(data-sources): use multipart postForm for file upload and support docx decompression
bfa9f794c feat(adapter-pi-local): support cmd/ model prefix and clean aiConnection on adapter switch
54038f240 fix(auth): document PAPERCLIP_AGENT_JWT_SECRET in .env.example
15fdd65fd feat(agents): verify and ensure multi-agent A2A communication, delegation, and full semantic routing
ed2d44c37 feat(data-sources): inspect top 5 sample rows, map JSON subfields, and generate ClickHouse schema
769198470 feat: integrate TypeSafe Jev System One semantic format triage into onboarding orchestrator
513323a26 feat: enterprise data sources, database integration, Jev decision plane, and native agent orchestrator
```

---

## 11. Verification Checklist & Gate Results

- [x] **Database Migrations**: Migration `0285_empty_killraven.sql` applied and compatible with embedded PGlite and PostgreSQL.
- [x] **Typecheck**: `pnpm --filter @paperclipai/server typecheck` passed with **0 errors**.
- [x] **Design Tokens**: `pnpm check:token-gates` passed with **All gates clean** (1078 files scanned).
- [x] **Company Creation Verification**: Verified on fresh test company creation that only the 6 core agents are provisioned, each with its designated skills active.
- [x] **Existing Instances Cleaned**: Cleaned up obsolete agent rows in existing companies (`decide`, `rissets`).
- [x] **Git Remote Sync**: All commits pushed to `origin/workspace`.
