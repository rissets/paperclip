#!/usr/bin/env python3
import os
import sys
import json
import argparse
import urllib.request
import urllib.parse
from typing import Optional, Dict, Any

DEFAULT_SERVICE_URL = os.getenv("MEETING_SERVICE_URL", "http://127.0.0.1:5001")

def make_request(path: str, query_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{DEFAULT_SERVICE_URL.rstrip('/')}{path}"
    if query_params:
        query_string = urllib.parse.urlencode(query_params)
        url = f"{url}?{query_string}"
        
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "PrimbonMeetingSkill/1.0",
            "Accept": "application/json"
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            return json.loads(data.decode("utf-8"))
    except Exception as e:
        print(f"Error communicating with Meeting Service at {url}: {e}", file=sys.stderr)
        return {"error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="Primbon Meeting Notes & Transcript Inspection Tool")
    parser.add_argument("--meeting-id", type=str, required=True, help="Meeting session ID")
    parser.add_argument("--format", type=str, choices=["text", "json"], default="text", help="Output format")
    
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--recent", action="store_true", help="Get recent transcript segments")
    group.add_argument("--full-transcript", action="store_true", help="Get full transcript of the meeting")
    group.add_argument("--search", type=str, metavar="QUERY", help="Search transcript for keywords or phrases")
    group.add_argument("--info", action="store_true", help="Get meeting metadata and status")
    
    parser.add_argument("--seconds", type=float, default=120.0, help="Window in seconds for --recent (default: 120)")
    
    args = parser.parse_args()
    
    if args.info:
        res = make_request(f"/api/meetings/{args.meeting_id}")
        if args.format == "json":
            print(json.dumps(res, indent=2))
        else:
            if "error" in res:
                print(f"Meeting not found: {res['error']}")
            else:
                print(f"### Meeting: {res.get('title')} ({res.get('status')})")
                print(f"- ID: {res.get('id')}")
                print(f"- Duration: {res.get('duration_seconds', 0):.1f}s")
                print(f"- Total Segments: {res.get('segment_count', 0)}")
                print(f"- Created At: {res.get('created_at')}")
        return

    if args.recent:
        res = make_request(f"/api/meetings/{args.meeting_id}/transcript/recent", {"seconds": args.seconds})
        if args.format == "json":
            print(json.dumps(res, indent=2))
        else:
            segments = res.get("segments", [])
            print(f"### Recent Discussion (Last {args.seconds} seconds, {len(segments)} segments):\n")
            if not segments:
                print("(No speech detected in this window)")
            for s in segments:
                print(f"[{s.get('speaker', 'Speaker')} ({s.get('start_seconds', 0):.1f}s)]: {s.get('text')}")
        return

    if args.full_transcript:
        res = make_request(f"/api/meetings/{args.meeting_id}/transcript")
        if args.format == "json":
            print(json.dumps(res, indent=2))
        else:
            segments = res.get("segments", [])
            print(f"### Full Transcript ({len(segments)} segments):\n")
            if not segments:
                print("(Meeting transcript is empty)")
            for s in segments:
                print(f"[{s.get('speaker', 'Speaker')} ({s.get('start_seconds', 0):.1f}s)]: {s.get('text')}")
        return

    if args.search:
        res = make_request(f"/api/meetings/{args.meeting_id}/transcript/search", {"q": args.search})
        if args.format == "json":
            print(json.dumps(res, indent=2))
        else:
            matches = res.get("results", [])
            print(f"### Search Results for '{args.search}' ({len(matches)} matches):\n")
            if not matches:
                print("No mentions found matching query.")
            for m in matches:
                print(f"- [{m.get('speaker', 'Speaker')} @ {m.get('start_seconds', 0):.1f}s]: {m.get('text')}")
        return

if __name__ == "__main__":
    main()
