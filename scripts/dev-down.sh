#!/usr/bin/env bash
# Stop ingest, the console API, the console, and the compose Postgres container. The volume is kept.
# Pass --keep-postgres to leave the container running.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# shellcheck source=dev-common.sh
source "$root/scripts/dev-common.sh"

step "stop ingest, console api, and console web"
stop_pid "$root/target/dev/ingest.pid"
stop_pid "$root/target/dev/console-api.pid"
stop_pid "$root/target/dev/connector-gcp.pid"
stop_pid "$root/target/dev/console-web.pid"
stop_pid "$root/target/dev/preview.pid"

if [[ ${1:-} == "--keep-postgres" ]]; then
  echo "postgres left running"
  exit 0
fi

step "docker compose down"
docker compose down
echo "postgres container stopped; volume kept"
