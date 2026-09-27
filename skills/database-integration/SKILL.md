---
name: database-integration
description: >
  Connect, inspect, and query external relational databases (PostgreSQL, MariaDB, MySQL).
  Access tables, columns, primary & foreign key relationships, semantic models, and execute
  controlled, safe read-only SELECT queries.
---

# Enterprise Database Integration Skill

This skill equips Paperclip agents (especially `DatabaseIntegrationAgent` and `DataAgent`) to interact with live external enterprise databases connected through Paperclip's native database integration engine.

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

## 1. Test Database Connection

Verify network reachability and credentials for PostgreSQL, MariaDB, or MySQL:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/test-connection" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "enterprise_db",
    "username": "readonly_user",
    "password": "secretpassword",
    "ssl": false
  }'
```

**Response format:**
```json
{
  "success": true,
  "latencyMs": 14,
  "database": "enterprise_db",
  "version": "PostgreSQL 16.2",
  "serverType": "postgres"
}
```

---

## 2. Onboard & Connect an External Database

Connect a database, discover all tables, columns, foreign key relations, and build bilingual semantic models:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/connect-database" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "enterprise_db",
      "username": "readonly_user",
      "password": "secretpassword",
      "ssl": false
    },
    "name": "Production ERP Database",
    "description": "Enterprise PostgreSQL database for inventory and orders"
  }'
```

---

## 3. Execute Controlled Read-Only SQL Query

Run safe read-only SQL (`SELECT` / `WITH`) against an external database data source:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/query-sql" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT o.id, c.name, o.total_amount FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.total_amount DESC LIMIT 10",
    "limit": 10
  }'
```

**Response format:**
```json
{
  "columns": ["id", "name", "total_amount"],
  "rows": [
    { "id": 101, "name": "PT Jaya Abadi", "total_amount": 250000000 },
    { "id": 102, "name": "CV Maju Terus", "total_amount": 180000000 }
  ],
  "rowCount": 2,
  "executionTimeMs": 18,
  "sql": "SELECT o.id, c.name, o.total_amount FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.total_amount DESC LIMIT 10"
}
```

---

## 4. Safety & Invariants

- **Read-Only Strictness**: Any mutating keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `CREATE`) are rejected with `400 Bad Request`.
- **Query Bounds**: Limit is capped at 500 rows maximum to prevent memory exhaustion.
- **Transactions**: PostgreSQL queries are wrapped in `READ ONLY` transactions.

---

## 5. Indonesian Legal Entity & Company Profiling (`AHU_DB`)

When an Indonesian legal entity database (`AHU_DB`) is connected:

### Mandatory Rule
**NEVER search the public internet or external web (e.g. LinkedIn, Google, BidIntel) for Indonesian company legal profiles.** Always query the internal `tbl_perseroan` or `ahu_cv` table.

### Profiling Query Pattern
```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/data-sources/$DATA_SOURCE_ID/query-sql" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT id_perseroan, nama_perseroan, npwp_perseroan, nomor_sk, tanggal_sk, status_perseroan, jenis_perseroan, tahun_pendirian, alamat_perseroan, modal_dasar, modal_disetorkan, nama_notaris, pemegang_saham, kegiatan, provinsi_nama_perseroan, kabupaten_nama_perseroan FROM tbl_perseroan WHERE nama_perseroan = \"[NAMA_PERUSAHAAN]\" LIMIT 5"
  }'
```

If exact match returns 0 rows, use prefix match:
`WHERE nama_perseroan LIKE "[NAMA_PERUSAHAAN_PREFIX]%"`

### Report Formatting
Extract and format:
1. **Legalitas:** Nomor SK Kemenkumham, Tanggal SK, Status (Aktif/Tertutup), NPWP.
2. **Domisili:** Alamat lengkap, Kota, Provinsi.
3. **Modal:** Modal Disetor & Modal Dasar (Rupiah).
4. **Pengurus & Pemegang Saham:** Tabel memuat Nama, Jabatan (BOD/BOC), Lembar Saham, Nilai Saham, Email.
5. **Kegiatan Usaha / KBLI:** Daftar maksud dan tujuan terdaftar.
6. **Provenance Tag:** *Terverifikasi dari database resmi internal AHU_DB (tbl_perseroan).*

