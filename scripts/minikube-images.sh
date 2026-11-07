#!/usr/bin/env bash
set -euo pipefail

profile=nest-crud
rebuild=false
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  cat <<'HELP'
Usage: bash scripts/minikube-images.sh [--rebuild] [--profile NAME]

Prepare nest-api:latest, nest-migrate:latest, and postgres:17-bookworm
in a running, single-node Minikube cluster using containerd.

Existing host images are reused. Missing application images are built;
missing PostgreSQL is pulled on the host. --rebuild rebuilds both app images.
Images are saved to temporary archives, imported, and checked through CRI.
No application workloads are deployed by this script.
HELP
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --rebuild) rebuild=true; shift ;;
    --profile)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail '--profile requires a name'
      profile=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
done

for tool in docker minikube python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required tool not found: $tool"
done

docker info >/dev/null || fail 'Docker is unavailable. Start Docker and check your permissions.'
printf 'Host Docker context: %s\n' "$(docker context show)"
if [[ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]]; then
  printf 'A Docker endpoint/context environment override is set. All host operations use that same setting.\n'
fi
minikube -p "$profile" status || fail "Start the cluster first: minikube start -p $profile --driver=docker --container-runtime=containerd"

retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      printf 'Command failed (attempt %s/3); retrying in 2 seconds...\n' "$attempt" >&2
      sleep 2
    fi
  done
  return 1
}

prepare_app() {
  local image=$1 target=$2
  if [[ "$rebuild" == true ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '\nBuilding %s from Dockerfile target %s...\n' "$image" "$target"
    retry docker build --target "$target" -t "$image" "$project_dir" ||
      fail "Build failed for $image. If auth.docker.io timed out, the host must regain registry connectivity before building."
  else
    printf 'Reusing host image %s (use --rebuild after editing code).\n' "$image"
  fi
}

prepare_app nest-api:latest runtime
prepare_app nest-migrate:latest migrate
if ! docker image inspect postgres:17-bookworm >/dev/null 2>&1; then
  printf '\nPulling PostgreSQL on the host...\n'
  retry docker pull postgres:17-bookworm ||
    fail 'The host could not pull PostgreSQL. Resolve its registry/network error, then rerun. No node-side pull is required.'
else
  printf 'Reusing host image postgres:17-bookworm.\n'
fi

archive_dir=$(mktemp -d "${TMPDIR:-/tmp}/nest-crud-images.XXXXXX")
trap 'rm -rf -- "$archive_dir"' EXIT

for image in nest-api:latest nest-migrate:latest postgres:17-bookworm; do
  archive="$archive_dir/${image%%:*}.tar"
  printf '\nExporting %s from host Docker...\n' "$image"
  docker image save --output "$archive" "$image"

  # CRI uses the image config digest. Docker's .Id can instead be an index
  # digest with the containerd image store, so derive it from the saved config.
  expected_id=$(python3 - "$archive" <<'PY'
import hashlib
import json
import sys
import tarfile

with tarfile.open(sys.argv[1]) as archive:
    manifests = json.load(archive.extractfile('manifest.json'))
    if len(manifests) != 1:
        raise SystemExit('Expected one platform image in the archive; check the host image platform.')
    config = archive.extractfile(manifests[0]['Config']).read()
    print('sha256:' + hashlib.sha256(config).hexdigest())
PY
  )

  printf 'Importing the archive into Minikube profile %s...\n' "$profile"
  minikube -p "$profile" image load "$archive" --overwrite=true

  if ! node_id=$(minikube -p "$profile" ssh -- \
    "sudo crictl inspecti --output go-template --template '{{.status.id}}' 'docker.io/library/$image'"); then
    fail "$image is missing from the node runtime after import. Inspect Minikube load errors and available disk space."
  fi
  node_id=${node_id//$'\r'/}
  [[ "$node_id" == "$expected_id" ]] ||
    fail "The node has a different image for $image (expected $expected_id, got $node_id). The imported image was not verified."

  printf 'Verified %s (%s).\n' "$image" "$node_id"
  rm -f -- "$archive"
done

printf '\nAll three images verified in Minikube profile %s. Continue with the README namespace and dry-run steps.\n' "$profile"
