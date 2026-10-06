#!/bin/sh
set -eu
set +x

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${MINIO_APP_ACCESS_KEY:?MINIO_APP_ACCESS_KEY is required}"
: "${MINIO_APP_SECRET_KEY:?MINIO_APP_SECRET_KEY is required}"

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing local/paperclip-data >/dev/null
mc version enable local/paperclip-data >/dev/null

if ! mc admin policy info local paperclip-datasources >/dev/null 2>&1; then
  mc admin policy create local paperclip-datasources /policies/datasource-policy.json >/dev/null
fi
if ! mc admin user info local "$MINIO_APP_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add local "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY" >/dev/null
fi
mc admin policy attach local paperclip-datasources --user "$MINIO_APP_ACCESS_KEY" >/dev/null
