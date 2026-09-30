#!/usr/bin/env python3
"""
Paperclip Universal Data Sources Discovery & Routing Tool (Python CLI)
Inspect, list, and verify enterprise data sources (Unstructured RAG documents, Structured tables, and External databases).

Usage:
    # 1. List all active data sources in the company:
    python3 data_sources.py --list

    # 2. Filter data sources by type:
    python3 data_sources.py --type rag_document
    python3 data_sources.py --type database
    python3 data_sources.py --type csv

    # 3. Check details and health of a specific data source:
    python3 data_sources.py --id <data_source_id>
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error

def get_env_or_default(key, default=None):
    return os.environ.get(key, default)

def make_request(url, method="GET", payload=None, api_key=None, agent_id=None):
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
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
        description="Inspect and list company enterprise data sources.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--list", action="store_true", help="List all company data sources")
    parser.add_argument("--type", choices=["rag_document", "csv", "excel", "database", "mariadb", "mysql", "postgres"], help="Filter by source type")
    parser.add_argument("--id", type=str, help="Get detailed status and schema of a specific data source")
    parser.add_argument("--format", choices=["table", "json"], default="table", help="Output format")

    parser.add_argument("--company-id", type=str, default=get_env_or_default("PAPERCLIP_COMPANY_ID"))
    parser.add_argument("--agent-id", type=str, default=get_env_or_default("PAPERCLIP_AGENT_ID"))
    parser.add_argument("--api-url", type=str, default=get_env_or_default("PAPERCLIP_API_URL", "http://localhost:3100"))
    parser.add_argument("--api-key", type=str, default=get_env_or_default("PAPERCLIP_API_KEY"))

    args = parser.parse_args()
    base_url = args.api_url.rstrip("/")
    api_prefix = base_url if "/api" in base_url else f"{base_url}/api"
    company_id = args.company_id
    agent_id = args.agent_id
    access_mode = get_env_or_default("PAPERCLIP_DATA_SOURCES_MODE", "all")
    assigned_raw = get_env_or_default("PAPERCLIP_ASSIGNED_DATA_SOURCES", "")
    assigned_ids = set([x.strip() for x in assigned_raw.split(",") if x.strip()])

    if not company_id:
        print("Error: Company ID is required (set $PAPERCLIP_COMPANY_ID or pass --company-id)", file=sys.stderr)
        sys.exit(1)

    url = f"{api_prefix}/companies/{company_id}/data-sources"
    if agent_id:
        url += f"?agentId={agent_id}"
    sources = make_request(url, api_key=args.api_key, agent_id=agent_id)

    # Enforce assigned access mode
    if access_mode == "none":
        sources = []
    elif access_mode == "selected" and assigned_ids:
        sources = [ds for ds in sources if ds.get("id") in assigned_ids]

    if args.id:
        if access_mode == "none":
            print("Error: Akses ditolak. Agen ini tidak memiliki izin akses ke data source apa pun.", file=sys.stderr)
            sys.exit(1)
        if access_mode == "selected" and assigned_ids:
            found_in_assigned = any(ds.get("id") == args.id or ds.get("name", "").lower() == args.id.lower() for ds in sources)
            if not found_in_assigned and args.id not in assigned_ids:
                print(f"Error: Akses ditolak. Data source '{args.id}' tidak ditugaskan ke agen ini.", file=sys.stderr)
                sys.exit(1)

        found = next((ds for ds in sources if ds.get("id") == args.id or ds.get("name", "").lower() == args.id.lower()), None)
        if not found:
            print(f"Data source '{args.id}' not found.", file=sys.stderr)
            sys.exit(1)
        if args.format == "json":
            print(json.dumps(found, indent=2))
        else:
            print(f"### Data Source: `{found.get('name')}`")
            print(f"- **ID**: `{found.get('id')}`")
            print(f"- **Type**: `{found.get('sourceType')}`")
            print(f"- **Status**: `{found.get('status')}`")
            print(f"- **Description**: {found.get('description') or '-'}")
            tables = found.get("tables", [])
            if tables:
                print(f"- **Tables Count**: {len(tables)}")
                tbl_rows = [{"Table Name": t.get("tableName"), "Rows": f"{t.get('rowCount', 0):,}", "Cols": t.get("columnCount", 0)} for t in tables]
                print_markdown_table(["Table Name", "Rows", "Cols"], tbl_rows)
        return

    # Filter by type if requested
    if args.type:
        target_t = args.type.lower()
        if target_t == "database":
            sources = [ds for ds in sources if ds.get("sourceType", "").lower() in ["database", "mariadb", "mysql", "postgres", "postgresql"]]
        else:
            sources = [ds for ds in sources if ds.get("sourceType", "").lower() == target_t]

    if args.format == "json":
        print(json.dumps(sources, indent=2))
        return

    if not sources:
        if access_mode == "none":
            print("*(Agen tidak memiliki akses data source yang ditugaskan. Mode: Terisolasi)*")
        elif access_mode == "selected":
            print("*(Tidak ada data source yang cocok di antara data source yang ditugaskan ke agen)*")
        else:
            print("*(Tidak ada data source yang terdaftar)*")
        return

    title_label = "Data Source Ditugaskan" if access_mode == "selected" else "Enterprise Data Sources"
    print(f"### {title_label} ({len(sources)} sumber aktif):\n")
    ds_rows = []
    for ds in sources:
        ds_type = ds.get("sourceType", "")
        item_count = len(ds.get("tables", []))
        item_label = f"{item_count} tables" if item_count > 0 else "-"
        ds_rows.append({
            "Name": ds.get("name"),
            "Type": ds_type.upper(),
            "Status": ds.get("status"),
            "Details": item_label,
            "ID": ds.get("id")
        })

    print_markdown_table(["Name", "Type", "Status", "Details", "ID"], ds_rows)

if __name__ == "__main__":
    main()
