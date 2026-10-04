#!/usr/bin/env python3
"""
Paperclip Structured Data & OLAP Analytics Tool (Python CLI)
Perform high-performance queries, aggregations, and schema introspection across structured datasets (CSV/Excel) and ClickHouse OLAP tables.

Usage:
    # 1. List all available structured tables:
    python3 query_structured.py --list-tables

    # 2. Describe table schema & semantic metrics:
    python3 query_structured.py --describe-table <table_name_or_id>

    # 3. Perform fast metric aggregation (sum, avg, count, min, max):
    python3 query_structured.py --table <table_id> --aggregate sum --column <metric_column> [--group-by <dim>] [--filter <key=val>]

    # 4. Execute direct read-only ClickHouse SQL query:
    python3 query_structured.py --sql "SELECT category, count(*), sum(amount) FROM my_table GROUP BY category"
"""

import os
import sys
import json
import argparse
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
        with urllib.request.urlopen(req, timeout=20) as resp:
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

def main():
    parser = argparse.ArgumentParser(
        description="Query and analyze structured datasets (CSV/Excel) and ClickHouse OLAP tables.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list-tables", action="store_true", help="List all ready structured tables and datasets")
    group.add_argument("--describe-table", type=str, metavar="TABLE", help="Describe table schema, columns, and metrics")
    group.add_argument("--aggregate", choices=["sum", "avg", "count", "min", "max"], help="Run aggregation function on a table")
    group.add_argument("--sql", type=str, help="Execute direct read-only ClickHouse/SQL query")

    # Options for aggregate
    parser.add_argument("--collection", "-c", type=str, help="Filter tables by collection ID or slug")
    parser.add_argument("--table", type=str, help="Table ID or Table Name for aggregation")
    parser.add_argument("--data-source-id", type=str, help="Data Source ID (optional if table is unique)")
    parser.add_argument("--column", type=str, help="Column / metric to aggregate")
    parser.add_argument("--group-by", type=str, help="Categorical column to group by")
    parser.add_argument("--filter", type=str, help="Filter in format 'column=value'")
    parser.add_argument("--limit", type=int, default=50, help="Result limit")
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
        if args.list_tables:
            print("*(Agen tidak memiliki izin akses ke data source apa pun. Mode: Terisolasi)*")
            return
        print("Error: Akses ditolak. Agen ini tidak memiliki izin akses ke data source apa pun.", file=sys.stderr)
        sys.exit(1)

    # 1. List Tables
    if args.list_tables:
        url = f"{api_prefix}/companies/{company_id}/data-sources"
        params = []
        if agent_id:
            params.append(f"agentId={agent_id}")
        if args.collection:
            params.append(f"collectionId={args.collection}")
        if params:
            url += "?" + "&".join(params)

        sources = make_request(url, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)
        
        tables_list = []
        for ds in sources:
            ds_name = ds.get("name")
            ds_id = ds.get("id")
            col_id = ds.get("collectionId")
            col_name = ds.get("collectionName")

            if access_mode == "selected":
                allowed_by_ds = ds_id in assigned_ids if assigned_ids else False
                allowed_by_col = col_id in assigned_col_ids if (col_id and assigned_col_ids) else False
                if not allowed_by_ds and not allowed_by_col and (assigned_ids or assigned_col_ids):
                    continue

            ds_type = ds.get("sourceType")
            status = ds.get("status")
            for tbl in ds.get("tables", []):
                tables_list.append({
                    "Table Name": tbl.get("tableName"),
                    "Collection": col_name or "-",
                    "Row Count": f"{tbl.get('rowCount', 0):,}",
                    "Column Count": tbl.get("columnCount", 0),
                    "Source Type": ds_type,
                    "Status": status,
                    "Table ID": tbl.get("id"),
                    "Data Source ID": ds_id
                })

        if args.format == "json":
            print(json.dumps(tables_list, indent=2))
        else:
            scope_label = f" in Collection '{args.collection}'" if args.collection else ""
            print(f"### Structured Tables{scope_label} ({len(tables_list)} found):\n")
            if tables_list:
                headers = ["Table Name", "Collection", "Row Count", "Column Count", "Source Type", "Status", "Table ID"]
                print_markdown_table(headers, tables_list)
            else:
                print("No structured tables accessible to this agent.")
        return

    # 2. Describe Table
    if args.describe_table:
        url = f"{api_prefix}/companies/{company_id}/data-sources"
        sources = make_request(url, api_key=args.api_key, session_token=args.session_token)
        target = args.describe_table.lower()
        found_table = None
        found_ds = None

        for ds in sources:
            for tbl in ds.get("tables", []):
                if tbl.get("id") == args.describe_table or tbl.get("tableName", "").lower() == target:
                    found_table = tbl
                    found_ds = ds
                    break
            if found_table:
                break

        if not found_table:
            print(f"Table '{args.describe_table}' not found in company data sources.", file=sys.stderr)
            sys.exit(1)

        if args.format == "json":
            print(json.dumps(found_table, indent=2))
            return

        print(f"### Schema for Table: `{found_table.get('tableName')}`")
        print(f"- **Data Source**: {found_ds.get('name')} (`{found_ds.get('id')}`)")
        print(f"- **Total Rows**: {found_table.get('rowCount', 0):,}")
        print(f"- **Total Columns**: {found_table.get('columnCount', 0)}\n")

        schema_cols = found_table.get("schemaDefinition", [])
        if schema_cols:
            print("#### Columns & Data Types:")
            col_rows = []
            for col in schema_cols:
                col_rows.append({
                    "Column": col.get("name"),
                    "Type": col.get("dataType"),
                    "Role": col.get("role", "dimension"),
                    "Samples": ", ".join(str(s) for s in col.get("sampleValues", [])[:3])
                })
            print_markdown_table(["Column", "Type", "Role", "Samples"], col_rows)

        sem = found_table.get("semanticModel", {})
        if sem.get("metrics"):
            print("\n#### Identified Metrics:")
            for m in sem["metrics"]:
                print(f"- **{m.get('name')}** (Aggregation: `{m.get('aggregation', 'sum')}`) {m.get('unit', '')}")
            return

    # 3. Direct SQL query (ClickHouse)
    if args.sql:
        url = f"{api_prefix}/companies/{company_id}/data-sources/clickhouse/query"
        payload = {"sql": args.sql, "limit": args.limit}
        res = make_request(url, method="POST", payload=payload, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)
        
        if args.format == "json":
            print(json.dumps(res, indent=2))
            return

        rows = res.get("rows", [])
        columns = res.get("columns", [])
        if not columns and rows and isinstance(rows[0], dict):
            columns = list(rows[0].keys())

        print(f"### Query Results ({len(rows)} rows, executed in {res.get('executionMs', 0)}ms):\n")
        print_markdown_table(columns, rows)
        return

    # 4. Aggregations on Table
    if args.aggregate:
        if not args.table:
            print("Error: --table is required when running --aggregate", file=sys.stderr)
            sys.exit(1)

        # Resolve data source and table ID
        ds_id = args.data_source_id
        table_id = args.table

        if not ds_id:
            url = f"{api_prefix}/companies/{company_id}/data-sources"
            sources = make_request(url, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)
            for ds in sources:
                for tbl in ds.get("tables", []):
                    if tbl.get("id") == args.table or tbl.get("tableName", "").lower() == args.table.lower():
                        ds_id = ds.get("id")
                        table_id = tbl.get("id")
                        break
                if ds_id:
                    break

        if not ds_id or not table_id:
            print(f"Error: Could not resolve table '{args.table}' to a valid data source.", file=sys.stderr)
            sys.exit(1)

        query_payload = {
            "aggregate": {
                "fn": args.aggregate,
                "column": args.column or "*",
            },
            "limit": args.limit
        }
        if args.group_by:
            query_payload["aggregate"]["groupBy"] = args.group_by
        if args.filter and "=" in args.filter:
            k, v = args.filter.split("=", 1)
            query_payload["filter"] = {k.strip(): v.strip()}

        url = f"{api_prefix}/companies/{company_id}/data-sources/{ds_id}/tables/{table_id}/query"
        res = make_request(url, method="POST", payload=query_payload, api_key=args.api_key, agent_id=agent_id, session_token=args.session_token)

        if args.format == "json":
            print(json.dumps(res, indent=2))
            return

        rows = res.get("rows", [])
        columns = res.get("columns", [])
        if not columns and rows and isinstance(rows[0], dict):
            columns = list(rows[0].keys())

        print(f"### Hasil Agregasi `{args.aggregate.upper()}` ({len(rows)} baris):\n")
        print_markdown_table(columns, rows)

if __name__ == "__main__":
    main()
