#!/usr/bin/env bash
set -euo pipefail

backup_directory="${1:-}"
restore_prefix="${2:-}"
helper_image="${DATASOURCE_VOLUME_ARCHIVE_IMAGE:-alpine:3.22.1}"
logical_volumes=(pgdata paperclip-data datasource-local-uploads clickhouse-data minio-data)

if [[ -z "$backup_directory" || -z "$restore_prefix" ]]; then
  echo "Usage: $0 <backup-directory> <new-volume-prefix>" >&2
  exit 2
fi
if [[ ! "$restore_prefix" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Invalid restore volume prefix" >&2
  exit 2
fi
if [[ ! -d "$backup_directory" || ! -f "$backup_directory/manifest.tsv" || ! -f "$backup_directory/volumes.tsv" || ! -f "$backup_directory/SHA256SUMS" ]]; then
  echo "Backup directory is missing its manifest or checksums" >&2
  exit 1
fi
backup_directory="$(cd "$backup_directory" && pwd)"
if ! grep -q $'^format\tpaperclip-data-plane-volume-backup-v1$' "$backup_directory/manifest.tsv"; then
  echo "Unsupported data-plane backup format" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is unavailable" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$backup_directory" && sha256sum --check SHA256SUMS)
else
  (cd "$backup_directory" && shasum -a 256 -c SHA256SUMS)
fi

for logical_volume in "${logical_volumes[@]}"; do
  restored_volume="${restore_prefix}_${logical_volume}"
  if docker volume inspect "$restored_volume" >/dev/null 2>&1; then
    echo "Refusing to overwrite existing Docker volume '$restored_volume'" >&2
    exit 1
  fi
done

for logical_volume in "${logical_volumes[@]}"; do
  archive="$backup_directory/$logical_volume.tar.gz"
  if [[ ! -f "$archive" ]] || ! awk -F '\t' -v volume="$logical_volume" '$1 == volume { found = 1 } END { exit !found }' "$backup_directory/volumes.tsv" \
    || ! grep -Eq "  \\.\/${logical_volume}\\.tar\\.gz$" "$backup_directory/SHA256SUMS"; then
    echo "Backup does not contain required volume '$logical_volume'" >&2
    exit 1
  fi

  restored_volume="${restore_prefix}_${logical_volume}"
  if ! docker run --rm --network none --read-only \
    --volume "$backup_directory:/backup:ro" \
    "$helper_image" sh -ec 'tar -tzf "/backup/$1.tar.gz" | awk '\''/^\// || /(^|\/)\.\.(\/|$)/ { bad = 1 } END { exit bad }'\''' sh "$logical_volume"; then
    echo "Backup archive for '$logical_volume' has an unsafe path" >&2
    exit 1
  fi
  docker volume create --label "paperclip.restore.prefix=$restore_prefix" "$restored_volume" >/dev/null
  docker run --rm --network none --read-only --user 0:0 \
    --volume "$restored_volume:/target" \
    --volume "$backup_directory:/backup:ro" \
    "$helper_image" sh -ec 'tar -xzf "/backup/$1.tar.gz" -C /target' sh "$logical_volume"
done

override_file="$backup_directory/compose-restore-volumes.yml"
{
  printf 'volumes:\n'
  for logical_volume in "${logical_volumes[@]}"; do
    printf '  %s:\n    external: true\n    name: "%s_%s"\n' "$logical_volume" "$restore_prefix" "$logical_volume"
  done
} > "$override_file"
chmod 600 "$override_file"
printf 'Volumes restored under prefix %s\n' "$restore_prefix"
printf 'Compose volume override: %s\n' "$override_file"
printf 'Start an isolated restore with the base and data-plane Compose files plus this override; validate it before changing production traffic.\n'
