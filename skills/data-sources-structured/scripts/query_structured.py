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
import hashlib
import re
import argparse
import urllib.request
import urllib.error

def get_env_or_default(key, default=None):
    return os.environ.get(key, default)

def print_json(value, stream=None):
    target = stream or sys.stdout
    target.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")

def print_cli_error(message, output_format="table", *, code="query_error", status=None):
    if output_format == "json":
        error = {"code": code, "message": str(message)}
        if status is not None:
            error["status"] = status
        print_json({"error": error}, sys.stderr)
    else:
        print(f"Error: {message}", file=sys.stderr)

def make_request(url, method="GET", payload=None, api_key=None, agent_id=None, session_token=None, timeout_seconds=20, output_format="table"):
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
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="ignore")
        print_cli_error(err or f"HTTP {e.code}", output_format, code="http_error", status=e.code)
        sys.exit(1)
    except Exception as e:
        print_cli_error(f"Connection error to {url}: {e}", output_format, code="connection_error")
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

def clickhouse_table_name(table):
    """Return the published physical ClickHouse identifier, including its stable fallback."""
    semantic_model = table.get("semanticModel") or {}
    stored_name = semantic_model.get("clickhouseTable")
    if isinstance(stored_name, str) and stored_name:
        return stored_name

    table_id = table.get("id")
    if not table_id:
        return None
    readable = re.sub(r"[^a-zA-Z0-9_]", "_", str(table.get("tableName") or "table")).lower()[:24] or "table"
    identity = hashlib.sha256(str(table_id).encode("utf-8")).hexdigest()[:24]
    return f"ds_{identity}_{readable}"

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
    group.add_argument("--orchestrate", type=str, metavar="QUERY", help="Execute query through Enterprise Orchestrator facade")

    # Options for aggregate
    parser.add_argument("--collection", "-c", type=str, help="Filter tables by collection ID or slug")
    parser.add_argument("--table", type=str, help="Table ID or Table Name for aggregation")
    parser.add_argument("--data-source-id", type=str, help="Data Source ID (optional if table is unique)")
    parser.add_argument("--column", type=str, help="Column / metric to aggregate")
    parser.add_argument("--group-by", type=str, help="Categorical column to group by")
    parser.add_argument("--filter", type=str, help="Filter in format 'column=value'")
    parser.add_argument("--limit", type=int, default=50, help="Result limit")
    parser.add_argument("--format", choices=["table", "json"], default="table", help="Output format")
    parser.add_argument(
        "--direct-fallback-reason",
        type=str,
        help="Coordinator-provided reason required for a direct data-query fallback in orchestration Auto",
    )

    parser.add_argument("--company-id", type=str, default=get_env_or_default("PAPERCLIP_COMPANY_ID"))
    parser.add_argument("--agent-id", type=str, default=get_env_or_default("PAPERCLIP_AGENT_ID"))
    parser.add_argument("--api-url", type=str, default=get_env_or_default("PAPERCLIP_API_URL", "http://localhost:3100"))
    parser.add_argument("--api-key", type=str, default=get_env_or_default("PAPERCLIP_API_KEY"))
    parser.add_argument("--session-token", type=str, default=get_env_or_default("PAPERCLIP_SESSION_TOKEN"))
    parser.add_argument("--run-id", type=str, default=get_env_or_default("PAPERCLIP_RUN_ID"))
    parser.add_argument("--submitted-at", type=str, default=get_env_or_default("PAPERCLIP_SUBMITTED_AT"))
    parser.add_argument("--deadline-ms", type=int, default=int(get_env_or_default("PAPERCLIP_DEADLINE_MS", "55000")))

    args = parser.parse_args()
    base_url = args.api_url.rstrip("/")
    api_prefix = base_url if "/api" in base_url else f"{base_url}/api"
    company_id = args.company_id
    agent_id = args.agent_id
    access_mode = get_env_or_default("PAPERCLIP_DATA_SOURCES_MODE", "all")
    orchestration_mode = get_env_or_default("PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE", "off").strip().lower()
    assigned_raw = get_env_or_default("PAPERCLIP_ASSIGNED_DATA_SOURCES", "")
    assigned_ids = set([x.strip() for x in assigned_raw.split(",") if x.strip()])
    assigned_col_raw = get_env_or_default("PAPERCLIP_ASSIGNED_COLLECTIONS", "")
    assigned_col_ids = set([x.strip() for x in assigned_col_raw.split(",") if x.strip()])

    if not company_id:
        print_cli_error("Company ID is required (set $PAPERCLIP_COMPANY_ID or pass --company-id)", args.format, code="company_id_required")
        sys.exit(1)

    metadata_only_operation = args.list_tables or bool(args.describe_table)
    if orchestration_mode == "auto" and not args.orchestrate and not metadata_only_operation and not (args.direct_fallback_reason or "").strip():
        print_cli_error(
            "Datasource orchestration is active. Submit the complete question with --orchestrate; direct data queries require a specific fallback reason returned by the coordinator.",
            args.format,
            code="orchestration_required",
        )
        sys.exit(2)

    if access_mode == "none":
        if args.list_tables:
            if args.format == "json":
                print_json([])
            else:
                print("*(Agen tidak memiliki izin akses ke data source apa pun. Mode: Terisolasi)*")
            return
        print_cli_error("Akses ditolak. Agen ini tidak memiliki izin akses ke data source apa pun.", args.format, code="source_access_denied")
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

        sources = make_request(
            url,
            api_key=args.api_key,
            agent_id=agent_id,
            session_token=args.session_token,
            output_format=args.format,
        )
        
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
                physical_table = clickhouse_table_name(tbl)
                tables_list.append({
                    "Table Name": tbl.get("tableName"),
                    "Collection": col_name or "-",
                    "Row Count": f"{tbl.get('rowCount', 0):,}",
                    "Column Count": tbl.get("columnCount", 0),
                    "Source Type": ds_type,
                    "Status": status,
                    "Table ID": tbl.get("id"),
                    "Data Source ID": ds_id,
                    "ClickHouse Table": physical_table,
                    # Keep the human-readable labels above and expose stable,
                    # typed fields for agents consuming --format json.
                    "tableId": tbl.get("id"),
                    "dataSourceId": ds_id,
                    "rowCount": tbl.get("rowCount", 0),
                    "clickhouseTable": physical_table,
                })

        if args.format == "json":
            print_json(tables_list)
        else:
            scope_label = f" in Collection '{args.collection}'" if args.collection else ""
            print(f"### Structured Tables{scope_label} ({len(tables_list)} found):\n")
            if tables_list:
                headers = ["Table Name", "Collection", "Row Count", "Column Count", "Source Type", "Status", "Table ID", "ClickHouse Table"]
                print_markdown_table(headers, tables_list)
            else:
                print("No structured tables accessible to this agent.")
        return

    # 1b. Orchestrate Query Facade
    if args.orchestrate:
        url = f"{api_prefix}/companies/{company_id}/orchestrator/query-executions"
        payload = {
            "query": args.orchestrate,
            "agentId": agent_id,
        }
        if args.run_id:
            payload["runId"] = args.run_id
        if args.submitted_at:
            payload["submittedAt"] = int(args.submitted_at) if str(args.submitted_at).isdigit() else args.submitted_at
        if args.deadline_ms:
            payload["deadlineMs"] = args.deadline_ms
        res = make_request(
            url,
            method="POST",
            payload=payload,
            api_key=args.api_key,
            agent_id=agent_id,
            session_token=args.session_token,
            timeout_seconds=70,
            output_format=args.format,
        )
        if args.format == "json":
            print_json(res)
            return

        print(f"### Hasil Orchestrator Query (Status: {res.get('status', 'unknown')})\n")
        if res.get("resultsSummary"):
            print(f"{res['resultsSummary']}\n")

        timings = res.get("stageTimings") or {}
        if timings:
            print(f"- **Trace ID**: `{res.get('traceId')}`")
            print(f"- **Stage Timings**: Preflight {timings.get('preflightMs', 0)}ms | Planning {timings.get('planningMs', 0)}ms | Exec {timings.get('databaseExecutionMs', 0)}ms | Total {timings.get('totalMs', 0)}ms\n")

        data = res.get("data")
        if isinstance(data, list) and data:
            columns = list(data[0].keys()) if isinstance(data[0], dict) else []
            if columns:
                print_markdown_table(columns, data)
        return

    # 2. Describe Table
    if args.describe_table:
        if args.data_source_id:
            url = f"{api_prefix}/companies/{company_id}/data-sources/{args.data_source_id}"
            sources = [make_request(
                url,
                api_key=args.api_key,
                agent_id=agent_id,
                session_token=args.session_token,
                output_format=args.format,
            )]
        else:
            url = f"{api_prefix}/companies/{company_id}/data-sources"
            if agent_id:
                url += f"?agentId={agent_id}"
            sources = make_request(
                url,
                api_key=args.api_key,
                agent_id=agent_id,
                session_token=args.session_token,
                output_format=args.format,
            )
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
            print_cli_error(
                f"Table '{args.describe_table}' not found in company data sources.",
                args.format,
                code="table_not_found",
            )
            sys.exit(1)

        if args.format == "json":
            result = dict(found_table)
            result["clickhouseTable"] = clickhouse_table_name(found_table)
            print_json(result)
            return

        print(f"### Schema for Table: `{found_table.get('tableName')}`")
        print(f"- **Data Source**: {found_ds.get('name')} (`{found_ds.get('id')}`)")
        print(f"- **Total Rows**: {found_table.get('rowCount', 0):,}")
        print(f"- **Total Columns**: {found_table.get('columnCount', 0)}\n")
        print(f"- **ClickHouse Table**: `{clickhouse_table_name(found_table)}`\n")

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
        # ClickHouse enforces its own 60-second execution ceiling. Keep the
        # client connected slightly longer so it receives the real server
        # error/result instead of timing out and encouraging a duplicate retry.
        res = make_request(
            url,
            method="POST",
            payload=payload,
            api_key=args.api_key,
            agent_id=agent_id,
            session_token=args.session_token,
            timeout_seconds=70,
            output_format=args.format,
        )
        
        if args.format == "json":
            print_json(res)
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
            print_cli_error(
                "--table is required when running --aggregate",
                args.format,
                code="table_required",
            )
            sys.exit(1)

        # Resolve the table against the ACL-filtered catalog every time. Keeping
        # the canonical source/table pair prevents a table UUID or logical label
        # from accidentally being sent as the datasource URL segment.
        catalog_url = f"{api_prefix}/companies/{company_id}/data-sources"
        if agent_id:
            catalog_url += f"?agentId={agent_id}"
        sources = make_request(
            catalog_url,
            api_key=args.api_key,
            agent_id=agent_id,
            session_token=args.session_token,
            output_format=args.format,
        )
        matches = []
        for source in sources:
            source_id = source.get("id")
            if args.data_source_id and source_id != args.data_source_id:
                continue
            for table in source.get("tables", []):
                if table.get("id") == args.table or str(table.get("tableName") or "").lower() == args.table.lower():
                    matches.append((source_id, table.get("id")))

        if len(matches) != 1 or not matches[0][0] or not matches[0][1]:
            message = (
                f"Could not resolve exactly one accessible table '{args.table}'"
                + (f" in data source '{args.data_source_id}'" if args.data_source_id else "")
                + ". Use --list-tables --format json and pass the matching dataSourceId/tableId pair."
            )
            print_cli_error(message, args.format, code="table_resolution_failed")
            sys.exit(1)
        ds_id, table_id = matches[0]

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
        res = make_request(
            url,
            method="POST",
            payload=query_payload,
            api_key=args.api_key,
            agent_id=agent_id,
            session_token=args.session_token,
            timeout_seconds=70,
            output_format=args.format,
        )

        if args.format == "json":
            print_json(res)
            return

        rows = res.get("rows", [])
        columns = res.get("columns", [])
        if not columns and rows and isinstance(rows[0], dict):
            columns = list(rows[0].keys())

        print(f"### Hasil Agregasi `{args.aggregate.upper()}` ({len(rows)} baris):\n")
        print_markdown_table(columns, rows)

if __name__ == "__main__":
    main()
