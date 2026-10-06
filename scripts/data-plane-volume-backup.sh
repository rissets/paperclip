#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_name="${2:-${COMPOSE_PROJECT_NAME:-$(basename "$repo_root")}}"
backup_root="${1:-}"
helper_image="${DATASOURCE_VOLUME_ARCHIVE_IMAGE:-alpine:3.22.1}"
logical_volumes=(pgdata paperclip-data datasource-local-uploads clickhouse-data minio-data)

if [[ -z "$backup_root" ]]; then
  echo "Usage: $0 <backup-root-directory> [compose-project-name]" >&2
  exit 2
fi
if [[ ! "$project_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Invalid Compose project name" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is unavailable" >&2
  exit 1
fi

running_containers="$(docker ps -q --filter "label=com.docker.compose.project=$project_name")"
if [[ -n "$running_containers" ]]; then
  echo "Stop every container in Compose project '$project_name' before taking a consistent data-plane volume backup" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd)"
output_directory="$backup_root/$timestamp"
if [[ -e "$output_directory" ]]; then
  echo "Backup directory already exists: $output_directory" >&2
  exit 1
fi
mkdir "$output_directory"
chmod 700 "$backup_root" "$output_directory"

for logical_volume in "${logical_volumes[@]}"; do
  matches=()
  while IFS= read -r volume_name; do
    [[ -n "$volume_name" ]] && matches+=("$volume_name")
  done < <(docker volume ls -q \
    --filter "label=com.docker.compose.project=$project_name" \
    --filter "label=com.docker.compose.volume=$logical_volume")
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected one Compose volume '$logical_volume' for project '$project_name'; found ${#matches[@]}" >&2
    exit 1
  fi

  volume_name="${matches[0]}"
  printf '%s\t%s\n' "$logical_volume" "$volume_name" >> "$output_directory/volumes.tsv"
  docker run --rm --network none --read-only --user 0:0 \
    --volume "$volume_name:/source:ro" \
    --volume "$output_directory:/backup" \
    "$helper_image" sh -ec 'tar -czf "/backup/$1.tar.gz" -C /source .' sh "$logical_volume"
  chmod 600 "$output_directory/$logical_volume.tar.gz"
done

{
  printf 'format\tpaperclip-data-plane-volume-backup-v1\n'
  printf 'created_at_utc\t%s\n' "$timestamp"
  printf 'compose_project\t%s\n' "$project_name"
  printf 'included_volumes\t%s\n' "${logical_volumes[*]}"
} > "$output_directory/manifest.tsv"
chmod 600 "$output_directory/manifest.tsv" "$output_directory/volumes.tsv"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_directory" && sha256sum ./*.tar.gz) > "$output_directory/SHA256SUMS"
else
  (cd "$output_directory" && shasum -a 256 ./*.tar.gz) > "$output_directory/SHA256SUMS"
fi
chmod 600 "$output_directory/SHA256SUMS"
printf 'Backup created at %s\n' "$output_directory"
