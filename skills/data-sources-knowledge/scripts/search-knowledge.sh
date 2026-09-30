#!/usr/bin/env bash
# Fast Knowledge RAG retrieval helper for Paperclip agents.
# Usage:
#   bash search-knowledge.sh "<query>" [limit] [dataSourceId]

set -e

QUERY="$1"
LIMIT="${2:-6}"
DS_ID="$3"

if [ -z "$QUERY" ]; then
  echo "Error: Query string is required." >&2
  echo "Usage: $0 \"<search query>\" [limit] [dataSourceId]" >&2
  exit 1
fi

BASE_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID}"

if [ -z "$COMPANY_ID" ]; then
  echo "Error: PAPERCLIP_COMPANY_ID environment variable is not set." >&2
  exit 1
fi

AUTH_HEADER=()
if [ -n "$PAPERCLIP_API_KEY" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $PAPERCLIP_API_KEY")
fi

PAYLOAD=$(python3 -c "
import json, sys
data = {'query': sys.argv[1], 'limit': int(sys.argv[2])}
if len(sys.argv) > 3 and sys.argv[3]:
    data['dataSourceId'] = sys.argv[3]
print(json.dumps(data))
" "$QUERY" "$LIMIT" "$DS_ID")

TMP_OUT="/tmp/rag_search_${COMPANY_ID}_$$.json"
trap 'rm -f "$TMP_OUT"' EXIT

HTTP_CODE=$(curl -sS -w "%{http_code}" -X POST "$BASE_URL/api/companies/$COMPANY_ID/data-sources/search-knowledge" \
  "${AUTH_HEADER[@]}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -o "$TMP_OUT")

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "Search failed with HTTP $HTTP_CODE" >&2
  cat "$TMP_OUT" >&2
  exit 1
fi

# Format results cleanly for agent consumption
python3 -c "
import json, sys

try:
    with open('$TMP_OUT', 'r') as f:
        results = json.load(f)
except Exception as e:
    print('Failed to parse search results:', e)
    sys.exit(1)

if not results:
    print('Tidak ditemukan dokumen atau potongan kebijakan yang relevan.')
    sys.exit(0)

print(f'=== Ditemukan {len(results)} rujukan relevan (Hybrid BM25 + Vector) ===\n')
for idx, r in enumerate(results, 1):
    source = r.get('dataSourceName', 'Dokumen')
    title = r.get('title') or 'Bagian Terkait'
    score = r.get('score', 0)
    content = r.get('content', '').strip()
    print(f'[{idx}] Sumber: {source} | Bagian: {title} (Relevansi: {score:.3f})')
    print('------------------------------------------------------------')
    print(content)
    print('\n')
"
