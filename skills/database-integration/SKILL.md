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

## 5. Dynamic Discovery & Generic Entity Profiling

Paperclip agents dynamically discover connected data sources and profile domain entities without requiring hardcoded table names, static schema assumptions, or hardcoded entity prefixes.

### Ingestion & Onboarding Stage
During data source onboarding, the `DatabaseIntegrationAgent` (or `StructuredIngestionAgent`):
1. **Discovers Schema & Types**: Introspects tables, columns, data types, and primary/foreign keys.
2. **Detects JSON Structures**: Samples top rows to extract nested keys (e.g., shareholders, management, line items).
3. **Assigns Semantic Categories**: Categorizes columns into standardized categories:
   - `identity`: primary identifiers, entity names, registration/SK numbers, codes.
   - `location`: addresses, cities, provinces, postal codes, countries.
   - `financial`: authorized/paid capital, prices, totals, balances.
   - `contact`: phone numbers, emails, websites.
   - `temporal`: establishment dates, decree dates, transaction timestamps.
   - `status`: active, closed, pending, cancelled.
   - `classification`: entity types, business sectors, categories.
   - `nested_structure`: parsed JSON objects/arrays (directors, shareholders, items).
   - `content`: descriptions, articles of association, notes.
4. **Builds Semantic Entities & Searchable Columns**: Generates human-friendly labels and registers `entities` and `searchableColumns` in `semanticModel` for downstream routing.

### Runtime Dynamic Profiling Protocol
When answering entity profiling queries:
1. **Dynamic Entity Resolution**: The `DataAgent` inspects active data sources from `GET /api/companies/$PAPERCLIP_COMPANY_ID/data-sources` and matches the user query against discovered `entities` and `searchableColumns`.
2. **Internal-First Priority**: Never query public web search engines if an internal database or data source holds relevant enterprise/entity records.
3. **Targeted Query Formulation**: Runs exact search, and if 0 rows returned, uses indexed B-Tree prefix match (`WHERE col LIKE "TERM%"`).
4. **Dynamic Profile Formatting**: Groups row fields dynamically by their onboarding `semanticCategory` (Identitas, Lokasi, Keuangan/Modal, Pengurus/Struktur, Status, dll.) and formats parsed JSON arrays into readable markdown tables.
5. **Grounded Provenance**: Concludes with a dynamic provenance citation referencing the actual data source and table name:
   > *Terverifikasi dari database resmi internal [Nama Data Source] ([Nama Tabel]).*


