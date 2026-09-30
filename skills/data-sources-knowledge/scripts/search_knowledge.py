#!/usr/bin/env python3
"""
Paperclip Fast Knowledge Retrieval Tool (Python CLI)
Search, retrieve, and format passages from unstructured enterprise documents (RAG).

Usage:
    python3 search_knowledge.py --query "<search_query>" [--limit 6] [--data-source-id <id>] [--format compact|markdown|json]
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error

def parse_args():
    parser = argparse.ArgumentParser(
        description="Search enterprise knowledge documents via Paperclip RAG retrieval engine.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--query", "-q",
        type=str,
        required=True,
        help="Search query or question to retrieve knowledge for",
    )
    parser.add_argument(
        "--limit", "-l",
        type=int,
        default=6,
        help="Maximum number of relevant chunks to retrieve",
    )
    parser.add_argument(
        "--data-source-id", "-d",
        type=str,
        default=None,
        help="Optional specific data source ID to scope retrieval to",
    )
    parser.add_argument(
        "--format", "-f",
        choices=["compact", "markdown", "json"],
        default="compact",
        help="Output format: compact (concise passages), markdown (structured markdown), json (raw JSON)",
    )
    parser.add_argument(
        "--agent-id",
        type=str,
        default=os.environ.get("PAPERCLIP_AGENT_ID"),
        help="Agent ID (defaults to $PAPERCLIP_AGENT_ID)",
    )
    parser.add_argument(
        "--company-id",
        type=str,
        default=os.environ.get("PAPERCLIP_COMPANY_ID"),
        help="Company ID (defaults to $PAPERCLIP_COMPANY_ID)",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default=os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100"),
        help="Paperclip API URL (defaults to $PAPERCLIP_API_URL or http://localhost:3100)",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.environ.get("PAPERCLIP_API_KEY"),
        help="Paperclip API Bearer token (defaults to $PAPERCLIP_API_KEY)",
    )
    return parser.parse_args()

def main():
    args = parse_args()

    api_url = args.api_url.rstrip("/")
    if not api_url.endswith("/api") and "/api" not in api_url:
        endpoint = f"{api_url}/api/companies/{args.company_id}/data-sources/search-knowledge"
    else:
        endpoint = f"{api_url}/companies/{args.company_id}/data-sources/search-knowledge"

    if not args.company_id:
        # Fallback to general search endpoint if company_id is not set
        endpoint = f"{api_url}/api/data-sources/search-knowledge" if "/api" not in api_url else f"{api_url}/data-sources/search-knowledge"

    payload = {
        "query": args.query,
        "limit": args.limit,
    }

    mode = os.environ.get("PAPERCLIP_DATA_SOURCES_MODE", "all")
    if mode == "none":
        print("*(Agen tidak memiliki izin akses ke basis pengetahuan dokumen RAG. Mode: Terisolasi)*")
        sys.exit(0)

    assigned_raw = os.environ.get("PAPERCLIP_ASSIGNED_DATA_SOURCES", "")
    assigned = [x.strip() for x in assigned_raw.split(",") if x.strip()]

    if args.data_source_id:
        if mode == "selected" and assigned and args.data_source_id not in assigned:
            print(f"Error: Akses ditolak. Data source '{args.data_source_id}' tidak ditugaskan ke agen ini.", file=sys.stderr)
            sys.exit(1)
        payload["dataSourceId"] = args.data_source_id
    elif mode == "selected" and assigned:
        payload["dataSourceIds"] = assigned

    agent_id = args.agent_id or os.environ.get("PAPERCLIP_AGENT_ID")
    if agent_id:
        payload["agentId"] = agent_id

    req_data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if args.api_key:
        headers["Authorization"] = f"Bearer {args.api_key}"

    req = urllib.request.Request(endpoint, data=req_data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw_body = resp.read().decode("utf-8")
            data = json.loads(raw_body)
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        print(f"Error ({e.code}) retrieving knowledge: {err_msg}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Network error communicating with Paperclip API ({endpoint}): {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, list):
        data = data.get("results", data.get("chunks", []))

    if args.format == "json":
        print(json.dumps(data, indent=2))
        return

    if not data:
        print("Tidak ditemukan dokumen atau bagian yang relevan untuk kueri tersebut.")
        return

    if args.format == "markdown":
        print(f"### Ditemukan {len(data)} Bagian Dokumen Relevan:\n")
        for idx, item in enumerate(data, 1):
            source_name = item.get("dataSourceName", "Dokumen")
            title = item.get("title") or "Bagian Utama"
            score = item.get("similarityScore") or item.get("score")
            score_str = f" (Skor: {score:.2f})" if score is not None else ""
            content = item.get("content", "").strip()

            print(f"#### [{idx}] {source_name} — {title}{score_str}")
            print(f"{content}\n")
            print("---")
        return

    # Compact format (default)
    print(f"=== {len(data)} HASIL RETRIEVAL DOKUMEN RELEVAN ===")
    for idx, item in enumerate(data, 1):
        source_name = item.get("dataSourceName", "Dokumen")
        title = item.get("title") or "Bagian Dokumen"
        content = item.get("content", "").strip()
        print(f"\n[{idx}] {source_name} | {title}")
        print(content)
        print("-" * 50)

if __name__ == "__main__":
    main()
