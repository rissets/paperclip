---
name: database-integration
description: >
  Autonomous dynamic querying, multi-table relationship navigation, and entity profiling across
  external enterprise relational databases (PostgreSQL, MariaDB, MySQL). Use when answering questions
  about live database records, multi-table foreign key joins, corporate registries, transactions, and JSON structures.
---

# External Enterprise Database Integration Skill

This skill equips Paperclip agents (especially `DatabaseIntegrationAgent` and `DataAgent`) to **dynamically reason, navigate multi-table schemas, formulate dialect-specific SQL, execute queries with self-correcting retry loops, and synthesize grounded responses** from external relational databases.

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

## End-to-End Retrieval Flow for External Databases

When a user asks a question requiring data from an external database, the agent follows this 5-stage dynamic retrieval pipeline:

```
[ User Query ]
       │
       ▼
1. Dynamic Discovery & Candidate Table Resolution
   - Fetch active databases via GET /data-sources
   - Inspect tableProfiles, semanticModels, and tableRoles
   - Resolve candidate tables across 20+ tables
       │
       ▼
2. Query Strategy Selection
   ├──► Strategy A: Fast B-Tree Entity Profiling (searchableColumns, exact + prefix match)
   └──► Strategy B: Dynamic Multi-Table Relational JOIN & Analytics (crossTableClusters)
       │
       ▼
3. Safe Dialect-Specific SQL Formulation
   - Dialect quoting: PostgreSQL ("") vs MariaDB/MySQL (``)
   - Foreign key topology: JOIN table_b ON table_a.fk = table_b.pk
   - JSON extraction: ->> vs JSON_UNQUOTE(JSON_EXTRACT())
   - Read-only constraint + LIMIT clause (max 50)
       │
       ▼
4. Execution & Self-Correction Feedback Loop (Agentic Retry)
   - Execute POST /data-sources/:id/query-sql
   - If SQL Error ──► Analyze DB error ──► Refine SQL aliases/columns ──► Retry (Max 3 iterations)
   - If 0 Rows     ──► Fall back from exact match to LIKE '%term%' or broader cluster join
       │
       ▼
5. Dynamic Synthesis & Grounded Provenance
   - Format Markdown tables with formatted currency/units
   - Parse nested JSON arrays into structured sections
   - Conclude with official internal database citation
```

---

## 1. Stage 1: Dynamic Discovery & Schema Introspection

Do NOT assume static table names or hardcoded columns. Always discover the live database schema:

```bash
# List all active databases for the company
curl -sS -X GET "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"}
```

**Inspecting Connected Database Metadata:**
Identify data sources where `sourceType` is `"postgres"`, `"mariadb"`, or `"mysql"`. Each table contains:
- `tableName`: e.g. `perseroan`, `modal`, `alamat`, `pengurus`
- `schemaDefinition`: list of column objects (`name`, `dataType`, `role`, `semanticCategory`, `isSearchable`)
- `semanticModel`:
  - `tableRole`: `"fact_table"` | `"dimension_table"` | `"lookup_table"`
  - `entities`: e.g. `["perseroan", "perusahaan", "pt"]`
  - `searchableColumns`: e.g. `["nama_perseroan", "nomor_sk"]`
  - `relationships`: foreign key links to other tables
  - `jsonStructures`: nested JSON subfields (e.g. `data_pengurus`, `data_pemegang_saham`)
- `crossTableClusters`: topology groupings (e.g. `Corporate Registry Cluster: [perseroan, modal, alamat, pengurus]`)

---

## 2. Stage 2 & 3: Query Formulation Strategies

### Strategy A: Sub-Second Dynamic Entity Profiling

When the user asks about a specific entity (e.g., *"Siapa pengurus dan berapa modal PT TELEKOMUNIKASI INDONESIA TBK?"*):

1. **Extract Search Term**: Clean conversational verbs (`profiling`, `cari`, `info`, `siapa`, `cek`).
2. **Target `searchableColumns`**: Find columns flagged with `isSearchable: true` or `role: "identifier"`.
3. **Formulate Exact Search First**:
   ```sql
   -- For MariaDB/MySQL:
   SELECT * FROM `tbl_perseroan` WHERE `nama_perseroan` = 'PT TELEKOMUNIKASI INDONESIA TBK' LIMIT 5;

   -- For PostgreSQL:
   SELECT * FROM "perseroan" WHERE "nama_perseroan" = 'PT TELEKOMUNIKASI INDONESIA TBK' LIMIT 5;
   ```
4. **Prefix Fallback (if 0 rows returned)**:
   ```sql
   SELECT * FROM `tbl_perseroan` WHERE `nama_perseroan` LIKE 'PT TELEKOMUNIKASI INDONESIA%' LIMIT 5;
   ```

---

### Strategy B: Multi-Table Relational JOIN via `crossTableClusters`

When the user asks complex analytical, relational, or multi-attribute questions (e.g., *"Tampilkan 5 perusahaan dengan modal disetor terbesar beserta alamat dan kota mereka"*):

1. **Inspect `crossTableClusters` & `relationships`**:
   - Master entity table: `tbl_perseroan` (PK: `perseroan_id`)
   - Capital table: `tbl_modal` (FK: `tbl_modal.perseroan_id` -> `tbl_perseroan.perseroan_id`)
   - Address table: `tbl_alamat` (FK: `tbl_alamat.perseroan_id` -> `tbl_perseroan.perseroan_id`)
2. **Formulate Multi-Table SQL with Explicit Aliases**:
   ```sql
   SELECT
     p.perseroan_id,
     p.nama_perseroan,
     p.status_perseroan,
     m.modal_disetor,
     a.alamat,
     a.kota
   FROM `tbl_perseroan` p
   INNER JOIN `tbl_modal` m ON p.perseroan_id = m.perseroan_id
   LEFT JOIN `tbl_alamat` a ON p.perseroan_id = a.perseroan_id
   WHERE p.status_perseroan = 'AKTIF'
   ORDER BY m.modal_disetor DESC
   LIMIT 5;
   ```

---

### Strategy C: Semi-Structured JSON Extraction

When tables store nested corporate management, shareholders, or attributes inside JSON/JSONB columns:

#### PostgreSQL Dialect (`->>` and `jsonb_array_elements`):
```sql
SELECT
  id,
  nama_perseroan,
  pengurus->>'direktur_utama' AS direktur_utama,
  pengurus->>'komisaris_utama' AS komisaris_utama,
  modal->>'modal_disetor' AS modal_disetor
FROM "perseroan"
WHERE pengurus IS NOT NULL
LIMIT 10;
```

#### MariaDB / MySQL Dialect (`JSON_UNQUOTE`, `JSON_EXTRACT`):
```sql
SELECT
  id,
  nama_perseroan,
  JSON_UNQUOTE(JSON_EXTRACT(data_pengurus, '$.direktur_utama')) AS direktur_utama,
  JSON_UNQUOTE(JSON_EXTRACT(data_modal, '$.modal_disetor')) AS modal_disetor
FROM `perseroan`
WHERE data_pengurus IS NOT NULL
LIMIT 10;
```

---

## 3. Stage 4: Execution & Self-Correction Feedback Loop

Execute the formulated SQL via the Paperclip database query endpoint:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/query-sql" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT p.nama_perseroan, m.modal_disetor FROM tbl_perseroan p JOIN tbl_modal m ON p.id = m.perseroan_id ORDER BY m.modal_disetor DESC LIMIT 5",
    "limit": 5
  }'
```

### Self-Correction Feedback Loop (Retry Mechanics):
- **Error: Column Not Found (`Unknown column 'x'`)**:
  Inspect `schemaDefinition` for the candidate table, correct the column name (e.g. `nominal_modal` instead of `modal`), and retry immediately.
- **Error: Ambiguous Column (`Column 'id' in field list is ambiguous`)**:
  Disambiguate with table aliases (e.g. `p.id` instead of `id`) and retry.
- **0 Rows on Exact Search**:
  Switch from exact equality (`WHERE col = '...'`) to prefix match (`WHERE col LIKE '...'`) or strip entity prefix ("PT", "CV") and retry.

---

## 4. Stage 5: Response Formatting & Provenance Standard

Always format responses according to the enterprise provenance standard:

1. **Executive Insight & Context**:
   Lead with the key finding or answer directly.
2. **Structured Presentation**:
   - For multi-row results: Clean Markdown table with formatted numbers (e.g. `Rp 250.000.000`).
   - For single-entity profiles: Grouped sections by `semanticCategory` (Identitas, Finansial/Modal, Lokasi/Alamat, Pengurus JSON).
3. **Query Strategy Transparency**:
   Include a collapsible or quoted snippet showing the executed SQL query for auditability:
   > **Strategi Query:** Evaluasi relasi multi-tabel (`tbl_perseroan` &times; `tbl_modal`)
   > ```sql
   > SELECT p.nama_perseroan, m.modal_disetor FROM tbl_perseroan p JOIN tbl_modal m ON p.perseroan_id = m.perseroan_id ORDER BY m.modal_disetor DESC LIMIT 5;
   > ```
4. **Mandatory Internal Provenance Citation**:
   > *Data resmi terverifikasi 100% dari database internal **[Nama Data Source]** (Tabel: `[nama_tabel]`). Query dieksekusi secara terisolasi tanpa akses publik luar.*
