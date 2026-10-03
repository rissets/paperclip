# Data Source Collections, Zip Ingestion, and Cross-Source Correlation

**Date**: 2026-10-02  
**Status**: In Progress  
**Target**: Paperclip Enterprise Data Plane

---

## 1. Executive Summary & Research Findings

### 1.1 Scope of Data Source Collections
**Question**: *Apakah collection ini berlaku untuk semua type datasource (structured data, knowledge base / rag docs, external database, iot, cctv) atau hanya structured data (csv, tsv, excel) dan knowledge data (pdf, word, dll)?*

**Design Decision**:
Data Source Collections are designed as **Universal Enterprise Workspaces / Folders**:
1. **Heterogeneous Ingestion**: A collection is NOT restricted to just one type. In modern enterprise operations (such as the requested `timurtelecom` telecom domain), a project encompasses:
   - **Structured files**: CSV, TSV, Excel (`customers.csv`, `bts_towers.csv`, `network_billing.xlsx`).
   - **Unstructured / RAG documents**: PDF, DOCX, TXT, MD (SLA contracts, technical telecom standard manuals, SOPs).
   - **Archive files**: `.zip` archives containing multiple structured and unstructured files, unpacked automatically on upload into the collection.
   - **External Live Databases**: PostgreSQL, MariaDB, MySQL, ClickHouse connections tagged into the collection.
   - **Real-time Feeds**: IoT MQTT broker topics and CCTV stream feeds monitoring remote towers or data centers.

2. **Unified Relational & Semantic Synthesis**:
   When files and data sources are organized in the same collection:
   - **Cross-Table Foreign Key Discovery**: The engine automatically discovers foreign keys and relationships across different tabular files/tables within the collection (e.g. matching `billing.customer_id` with `customers.id`, checking cardinality and value overlap).
   - **Cross-Document RAG & Topic Correlation**: The engine identifies shared entities, overlapping topics, and semantic similarities between documents.
   - **Cross-Modal Linking**: The engine connects document entities (e.g., SLA references to "Tower Site Cengkareng") with structured data records (`bts_towers.site_name`).
   - **ClickHouse Schema & Unified Views**: The engine produces ClickHouse DDL and multi-table join views uniting tables in the collection.

---

## 2. Architecture & Data Contracts

### 2.1 Database Layer (`packages/db`)
- New table `data_source_collections`:
  - `id`: UUID (PK)
  - `companyId`: UUID (FK to `companies.id`, cascade)
  - `name`: Text (e.g. "timurtelecom")
  - `slug`: Text
  - `description`: Text
  - `color`: Text
  - `icon`: Text
  - `semanticProfile`: JSONB (`CollectionSemanticProfile`)
  - `metadata`: JSONB (statistics, counts)
  - `createdAt`, `updatedAt`
- Updated table `data_sources`:
  - Add `collectionId`: UUID (FK to `data_source_collections.id`, `onDelete: "set null"`)
  - Index `data_sources_collection_idx`

### 2.2 Shared Types (`packages/shared`)
- `DataSourceCollection`
- `CollectionSemanticProfile`:
  - `domain`: string
  - `primaryTopics`: string[]
  - `entities`: string[]
  - `crossTableRelationships`: TableRelation[]
  - `crossDocumentCorrelations`: Array<{ docA: string; docB: string; sharedEntities: string[]; semanticSimilarity: number; reason: string }>
  - `crossModalCorrelations`: Array<{ documentId: string; tableId: string; sharedEntities: string[]; correlationDescription: string }>
  - `unifiedClickhouseViews`: Array<{ viewName: string; joinSql: string; description: string }>
  - `suggestedQueries`: SuggestedQueryTemplate[]
  - `lastCorrelatedAt`: string

---

## 3. Implementation Plan

1. **Step 1 - Database Schema & Migration**:
   - Update `packages/db/src/schema/data_sources.ts` with `dataSourceCollections` and `dataSources.collectionId`.
   - Run `pnpm db:generate`.
   - Verify compile with `pnpm --filter @paperclipai/db build`.

2. **Step 2 - Shared Types**:
   - Update `packages/shared/src/types/data-source.ts`.
   - Rebuild `@paperclipai/shared`.

3. **Step 3 - Backend Services & Zip Support**:
   - Install `adm-zip` and `@types/adm-zip` in `@paperclipai/server`.
   - Create `DataSourceCollectionsService` in `server/src/services/data-source-collections.ts`:
     - Full CRUD for collections.
     - Zip extraction & batch onboarding into collection.
     - Automated cross-table foreign key discovery engine (schema + value overlap + cardinality).
     - Cross-document topic and entity linking engine.
     - ClickHouse unified views generator.
   - Update `OnboardingOrchestratorService` to accept `collectionId` and automatically trigger collection correlation on new file onboarding.
   - Add routes in `server/src/routes/data-sources.ts`.

4. **Step 4 - Frontend UI & Visualizations**:
   - Update `ui/src/api/data-sources.ts` with collection endpoints.
   - Update `ui/src/pages/DataSources.tsx` with Collection Folder Cards, New Collection Modal, and Collection Upload.
   - Create `ui/src/pages/DataSourceCollectionDetail.tsx`:
     - Tab 1: Member Data Sources & Files
     - Tab 2: Cross-Table Foreign Key & Relationship Map
     - Tab 3: Semantic Topics & Cross-Modal Correlations
     - Tab 4: Unified SQL & ClickHouse Query Playground
   - Register route in `ui/src/App.tsx`.
   - Ensure 100% compliance with `DESIGN.md` token gates (`pnpm check:token-gates`).

5. **Step 5 - Testing & Verification**:
   - Add automated test suite in `server/src/__tests__/data-source-collections.test.ts`.
   - Run typecheck `pnpm -r typecheck`.
   - Test live by creating collection `timurtelecom`, uploading sample CSVs, and verifying relationship mapping and correlation.
