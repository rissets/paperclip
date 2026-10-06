#!/usr/bin/env python3
"""
Paperclip External Database Integration Tool (Python CLI)
Discover connected relational databases, inspect schemas & relationships, and execute safe read-only SQL queries.

Usage:
    # 1. List connected external databases:
    python3 query_database.py --list-dbs

    # 2. Inspect all tables in a database:
    python3 query_database.py --db <data_source_id> --inspect-tables

    # 3. Describe columns and foreign keys of a table:
    python3 query_database.py --db <data_source_id> --describe-table <table_name>

    # 4. Execute safe read-only SQL query:
    python3 query_database.py --db <data_source_id> --query-sql "SELECT * FROM users LIMIT 5"
"""

import os
import sys
import json
import argparse
import time
import urllib.request
import urllib.error

def get_env_or_default(key, default=None):
    return os.environ.get(key, default)

def make_request(url, method="GET", payload=None, api_key=None, agent_id=None, session_token=None):
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 PrimbonAgent/1.0",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if session_token:
        headers["Cookie"] = f"session_token={session_token}"
        try:
            from urllib.parse import urlparse
            p = urlparse(url)
            headers["Origin"] = f"{p.scheme}://{p.netloc}"
        except Exception:
            headers["Origin"] = "http://localhost:3100"
    if agent_id:
        headers["X-Agent-ID"] = agent_id
        headers["X-Paperclip-Agent-ID"] = agent_id

    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="ignore")
        print(f"Error ({e.code}): {err}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Connection error to {url}: {e}", file=sys.stderr)
        sys.exit(1)

def print_markdown_table(headers, rows):
    if not rows:
        print("*(Tidak ada data yang ditemukan)*")
        return
    header_line = "| " + " | ".join(str(h) for h in headers) + " |"
    sep_line = "| " + " | ".join("---" for _ in headers) + " |"
    print(header_line)
    print(sep_line)
    for r in rows:
        if isinstance(r, dict):
            row_vals = [str(r.get(h, "")) for h in headers]
        elif isinstance(r, (list, tuple)):
            row_vals = [str(val) for val in r]
        else:
            row_vals = [str(r)]
        print("| " + " | ".join(row_vals) + " |")

def run_durable_query_job(
    api_prefix,
    company_id,
    data_source_id,
    sql,
    row_limit,
    statement_timeout_ms,
    *,
    api_key=None,
    agent_id=None,
    session_token=None,
    poll_interval_seconds=1.0,
):
    """Submit a bounded read-only query and retrieve its durable result."""
    if not isinstance(row_limit, int) or row_limit < 1 or row_limit > 1000:
        raise ValueError("Query row limit must be between 1 and 1000")
    if not isinstance(statement_timeout_ms, int) or statement_timeout_ms < 1000 or statement_timeout_ms > 60000:
        raise ValueError("Query timeout must be between 1000 and 60000 milliseconds")

    endpoint = f"{api_prefix}/companies/{company_id}/data-sources/{data_source_id}/query-jobs"
    auth = {
        "api_key": api_key,
        "agent_id": agent_id,
        "session_token": session_token,
    }
    submitted = make_request(
        endpoint,
        method="POST",
        payload={"sql": sql, "rowLimit": row_limit, "statementTimeoutMs": statement_timeout_ms},
        **auth,
    )
    job = submitted.get("data", submitted) if isinstance(submitted, dict) else {}
    job_id = job.get("id") if isinstance(job, dict) else None
    if not job_id:
        raise RuntimeError("Datasource query job response did not include a job ID")

    status_url = f"{endpoint}/{job_id}"
    result_url = f"{status_url}/result"
    cancel_url = f"{status_url}/cancel"
    wait_deadline = time.monotonic() + statement_timeout_ms / 1000 + 15

    while True:
        response = make_request(status_url, **auth)
        job = response.get("data", response) if isinstance(response, dict) else {}
        status = job.get("status") if isinstance(job, dict) else None
        if status == "succeeded":
            result = make_request(result_url, **auth)
            return result.get("data", result) if isinstance(result, dict) else result
        if status in ("failed", "cancelled"):
            detail = job.get("lastError") if isinstance(job, dict) else None
            raise RuntimeError(detail or f"Datasource query job {status}")
        if time.monotonic() >= wait_deadline:
            try:
                make_request(cancel_url, method="POST", payload={}, **auth)
            except Exception:
                pass
            raise TimeoutError("Timed out waiting for the datasource query job; a cancellation was requested")
        time.sleep(max(0, poll_interval_seconds))

def main():
    parser = argparse.ArgumentParser(
        description="Interact with connected enterprise relational databases (PostgreSQL, MariaDB, MySQL).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list-dbs", action="store_true", help="List all connected external databases")
    group.add_argument("--inspect-tables", action="store_true", help="Inspect all tables in the specified database")
    group.add_argument("--describe-table", type=str, metavar="TABLE", help="Describe table columns, types, and keys")
    group.add_argument("--query-sql", type=str, metavar="SQL", help="Execute safe read-only SQL query on the database")

    parser.add_argument("--db", type=str, help="Database Data Source ID or Name (required for inspect/describe/query)")
    parser.add_argument("--limit", type=int, default=50, help="Maximum number of rows returned")
    parser.add_argument(
        "--statement-timeout-ms",
        type=int,
        default=30000,
        help="Maximum external database execution time in milliseconds (1000-60000)",
    )
    parser.add_argument("--format", choices=["table", "json"], default="table", help="Output format")

    parser.add_argument("--company-id", type=str, default=get_env_or_default("PAPERCLIP_COMPANY_ID"))
    parser.add_argument("--agent-id", type=str, default=get_env_or_default("PAPERCLIP_AGENT_ID"))
    parser.add_argument("--api-url", type=str, default=get_env_or_default("PAPERCLIP_API_URL", "http://localhost:3100"))
    parser.add_argument("--api-key", type=str, default=get_env_or_default("PAPERCLIP_API_KEY"))
    parser.add_argument("--session-token", type=str, default=get_env_or_default("PAPERCLIP_SESSION_TOKEN"))

    args = parser.parse_args()
    base_url = args.api_url.rstrip("/")
    api_prefix = base_url if "/api" in base_url else f"{base_url}/api"
    company_id = args.company_id
    agent_id = args.agent_id
    access_mode = get_env_or_default("PAPERCLIP_DATA_SOURCES_MODE", "all")
    assigned_raw = get_env_or_default("PAPERCLIP_ASSIGNED_DATA_SOURCES", "")
    assigned_ids = set([x.strip() for x in assigned_raw.split(",") if x.strip()])
    assigned_col_raw = get_env_or_default("PAPERCLIP_ASSIGNED_COLLECTIONS", "")
    assigned_col_ids = set([x.strip() for x in assigned_col_raw.split(",") if x.strip()])

    if not company_id:
        print("Error: Company ID is required (set $PAPERCLIP_COMPANY_ID or pass --company-id)", file=sys.stderr)
        sys.exit(1)

    if access_mode == "none":
        if args.list_dbs:
            print("*(Agen tidak memiliki izin akses ke database apa pun. Mode: Terisolasi)*")
            return
        print("Error: Akses ditolak. Agen ini tidak memiliki izin akses ke database apa pun.", file=sys.stderr)
        sys.exit(1)

    # 1. List Databases
    if args.list_dbs:
        url = f"{api_prefix}/companies/{company_id}/data-sources"
        if agent_id:
            url += f"?agentId={agent_id}"
        sources = make_request(url, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)
        
        db_sources = []
        for ds in sources:
            st = ds.get("sourceType", "").lower()
            if st in ["mariadb", "mysql", "postgres", "postgresql", "database"]:
                if access_mode == "selected":
                    col_id = ds.get("collectionId")
                    allowed_by_ds = ds.get("id") in assigned_ids if assigned_ids else False
                    allowed_by_col = col_id in assigned_col_ids if (col_id and assigned_col_ids) else False
                    if not allowed_by_ds and not allowed_by_col and (assigned_ids or assigned_col_ids):
                        continue
                meta = ds.get("metadata") or {}
                db_sources.append({
                    "Database Name": ds.get("name"),
                    "Engine": st.upper(),
                    "Host": meta.get("host", "configured"),
                    "Database": meta.get("database", meta.get("dbName", "-")),
                    "Status": ds.get("status"),
                    "Tables Count": len(ds.get("tables", [])),
                    "Data Source ID": ds.get("id")
                })

        if args.format == "json":
            print(json.dumps(db_sources, indent=2))
        else:
            print(f"### Connected External Databases ({len(db_sources)} active):\n")
            if db_sources:
                headers = ["Database Name", "Engine", "Database", "Tables Count", "Status", "Data Source ID"]
                print_markdown_table(headers, db_sources)
            else:
                print("No external databases accessible to this agent.")
        return

    # Check for --db argument
    if not args.db:
        print("Error: --db <data_source_id_or_name> is required for this operation.", file=sys.stderr)
        sys.exit(1)

    # Resolve DB ID
    url = f"{api_prefix}/companies/{company_id}/data-sources"
    if agent_id:
        url += f"?agentId={agent_id}"
    sources = make_request(url, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)
    target_ds = None
    for ds in sources:
        if ds.get("id") == args.db or ds.get("name", "").lower() == args.db.lower():
            target_ds = ds
            break

    if not target_ds:
        print(f"Error: Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)

    if access_mode == "selected":
        col_id = target_ds.get("collectionId")
        allowed_by_ds = target_ds.get("id") in assigned_ids if assigned_ids else False
        allowed_by_col = col_id in assigned_col_ids if (col_id and assigned_col_ids) else False
        if not allowed_by_ds and not allowed_by_col and (assigned_ids or assigned_col_ids):
            print(f"Error: Akses ditolak. Database '{target_ds.get('name')}' ({target_ds.get('id')}) tidak ditugaskan ke agen ini.", file=sys.stderr)
            sys.exit(1)

    ds_id = target_ds.get("id")

    # 2. Inspect Tables
    if args.inspect_tables:
        tables = target_ds.get("tables", [])
        if args.format == "json":
            print(json.dumps(tables, indent=2))
            return

        print(f"### Tables in Database `{target_ds.get('name')}` ({len(tables)} tables):\n")
        table_rows = []
        for tbl in tables:
            sem = tbl.get("semanticModel") or {}
            table_rows.append({
                "Table Name": tbl.get("tableName"),
                "Row Count": f"{tbl.get('rowCount', 0):,}",
                "Columns": tbl.get("columnCount", 0),
                "Role": sem.get("tableRole", "table"),
                "Searchable": ", ".join(sem.get("searchableColumns", [])[:2]) or "-"
            })
        print_markdown_table(["Table Name", "Row Count", "Columns", "Role", "Searchable"], table_rows)
        return

    # 3. Describe Table
    if args.describe_table:
        target_tbl = None
        for tbl in target_ds.get("tables", []):
            if tbl.get("tableName", "").lower() == args.describe_table.lower() or tbl.get("id") == args.describe_table:
                target_tbl = tbl
                break

        if not target_tbl:
            print(f"Table '{args.describe_table}' not found in database '{target_ds.get('name')}'.", file=sys.stderr)
            sys.exit(1)

        if args.format == "json":
            print(json.dumps(target_tbl, indent=2))
            return

        print(f"### Schema for Table: `{target_tbl.get('tableName')}`")
        print(f"- **Database**: {target_ds.get('name')} (`{ds_id}`)")
        print(f"- **Row Count**: {target_tbl.get('rowCount', 0):,}\n")

        cols = target_tbl.get("schemaDefinition", [])
        if cols:
            print("#### Columns:")
            col_rows = []
            for c in cols:
                col_rows.append({
                    "Column": c.get("name"),
                    "Type": c.get("dataType"),
                    "Role": c.get("role", "column"),
                    "Semantic Category": c.get("semanticCategory", "-")
                })
            print_markdown_table(["Column", "Type", "Role", "Semantic Category"], col_rows)

        sem = target_tbl.get("semanticModel") or {}
        if sem.get("searchableColumns"):
            print(f"\n- **Searchable Columns**: `{', '.join(sem['searchableColumns'])}`")
        if sem.get("entities"):
            print(f"- **Associated Entities**: {', '.join(sem['entities'])}")
        return

    # 4. Execute Read-Only SQL Query
    if args.query_sql:
        sql = args.query_sql.strip()
        # Basic client-side read-only guard
        first_word = sql.split()[0].upper() if sql else ""
        if first_word not in ["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"]:
            print(f"Error: Only read-only queries (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) are allowed.", file=sys.stderr)
            sys.exit(1)

        try:
            res = run_durable_query_job(
                api_prefix,
                company_id,
                ds_id,
                sql,
                args.limit,
                args.statement_timeout_ms,
                api_key=args.api_key,
                agent_id=agent_id,
                session_token=args.session_token,
            )
        except (RuntimeError, TimeoutError, ValueError) as error:
            print(f"Error: {error}", file=sys.stderr)
            sys.exit(1)

        if args.format == "json":
            print(json.dumps(res, indent=2))
            return

        rows = res.get("rows", [])
        columns = res.get("columns", [])
        if not columns and rows and isinstance(rows[0], dict):
            columns = list(rows[0].keys())

        print(f"### Hasil Query Database ({len(rows)} baris):\n")
        print_markdown_table(columns, rows)
        print(
            f"\n> *Query job selesai di database **{target_ds.get('name')}** "
            f"(limit: {args.limit}, timeout: {args.statement_timeout_ms // 1000}s)*"
        )

if __name__ == "__main__":
    main()
