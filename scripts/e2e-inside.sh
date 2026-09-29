#!/usr/bin/env bash
# Runs under `firebase emulators:exec` so FIRESTORE_EMULATOR_HOST is set.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# shellcheck source=dev-common.sh
source "$root/scripts/dev-common.sh"

step "node scenarios and cloud functions"
pnpm --filter readmeter-e2e exec tsx run.ts

step "vite build"
pnpm --filter web build

step "vite preview"
start_detached "$root/target/dev/preview.pid" "$root/target/dev/preview.log" \
  pnpm --filter web preview
if ! wait_http "http://127.0.0.1:5173" 60; then
  echo "preview log:" >&2
  tail -n 80 "$root/target/dev/preview.log" >&2 || true
  exit 1
fi

step "playwright"
pnpm --filter web exec playwright test --reporter=line

step "browser findings in postgres"
pnpm --filter readmeter-e2e exec tsx run.ts --assert-only \
  firebase.firestore/unbounded-list \
  firebase.firestore/offset-pagination \
  firebase.database/duplicate-listeners

stop_pid "$root/target/dev/preview.pid"
