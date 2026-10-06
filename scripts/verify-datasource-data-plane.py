#!/usr/bin/env python3
"""Probe real disposable Compose services; does not qualify AI/model inference."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--project", required=True)
parser.add_argument("--env-file", required=True, type=Path)
parser.add_argument("--override", required=True, type=Path)
args = parser.parse_args()
if not args.project.startswith("paperclip-datasource-verify"):
    parser.error("Use a disposable paperclip-datasource-verify project")
root = Path(__file__).resolve().parent.parent
compose = ["docker", "compose", "--project-name", args.project, "--env-file", str(args.env_file.resolve()),
           "-f", str(root / "docker/docker-compose.yml"), "-f", str(root / "docker/docker-compose.data-plane.yml"),
           "-f", str(args.override.resolve())]


def run(arguments, stdin=None):
    result = subprocess.run(compose + arguments, cwd=root, input=stdin, text=True, capture_output=True, timeout=60)
    # Provider errors may include credentials; only report the operation label.
    if result.returncode:
        raise RuntimeError("Datasource data-plane probe failed: " + arguments[0])
    return result.stdout.strip()


pg = run(["exec", "-T", "db", "psql", "-U", "paperclip", "-d", "paperclip", "-v", "ON_ERROR_STOP=1", "-At"],
         "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT extversion FROM pg_extension WHERE extname='vector';\n")
assert "0.8.6" in pg, "Pinned pgvector extension version mismatch"

table = "verification_" + uuid.uuid4().hex
ch = run(["exec", "-T", "clickhouse", "sh", "-ec",
          'exec clickhouse-client --user paperclip --password "$CLICKHOUSE_PASSWORD" --multiquery'],
         f"CREATE TABLE paperclip.{table} (id UInt64, amount Float64) ENGINE=MergeTree ORDER BY id;\n"
         f"INSERT INTO paperclip.{table} VALUES (1,10.5),(2,20.25),(3,5.0);\n"
         f"SELECT count(), sum(amount) FROM paperclip.{table} FORMAT TabSeparated;\n"
         f"DROP TABLE paperclip.{table};\n")
assert ch == "3\t35.75", "ClickHouse aggregation mismatch"

redis = run(["exec", "-T", "redis-cache", "sh", "-ec",
             'export REDISCLI_AUTH="$REDIS_PASSWORD"; '
             'redis-cli SET verification:datasource smoke EX 30 >/dev/null; '
             'test "$(redis-cli GET verification:datasource)" = smoke; '
             'test "$(redis-cli TTL verification:datasource)" -gt 0; '
             'redis-cli DEL verification:datasource >/dev/null; '
             'redis-cli CONFIG GET maxmemory-policy'])
assert "noeviction" in redis, "Redis must not evict active distributed query permits"

objects = run(["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-init", "-ec", r'''
set +x
mc alias set app http://minio:9000 "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY" >/dev/null
mc alias set root http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
printf 'id,amount\n1,10.5\n' >/tmp/probe.csv
mc cp /tmp/probe.csv app/paperclip-data/verification/probe.csv >/dev/null
mc cat app/paperclip-data/verification/probe.csv >/tmp/read.csv
cmp /tmp/probe.csv /tmp/read.csv
if mc admin info app >/dev/null 2>&1; then exit 1; fi
mc mb --ignore-existing root/verification-denied >/dev/null
if mc cp /tmp/probe.csv app/verification-denied/probe.csv >/dev/null 2>&1; then exit 1; fi
mc rm app/paperclip-data/verification/probe.csv >/dev/null
mc rb root/verification-denied >/dev/null
mc version info root/paperclip-data
'''])
assert "enabled" in objects.lower(), "MinIO versioning is not enabled"
print(json.dumps({"postgres_pgvector": "passed", "clickhouse_aggregation": "passed",
                  "redis_ttl_noeviction": "passed", "minio_app_io_scope_versioning": "passed"}, indent=2))
