#!/usr/bin/env bash
# Bring up Postgres, ingest, the console API, the console, and the local demo project. Idempotent.
# Git Bash on Windows, bash on Linux.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# shellcheck source=dev-common.sh
source "$root/scripts/dev-common.sh"

ENV_FILE="$root/.readmeter/local.env"

step "install workspace dependencies"
pnpm install

step "postgres"
if port_open 5442; then
  echo "postgres already listening on 5442"
else
  docker compose up -d --wait postgres
fi

step "migrate and seed"
pnpm db:migrate
pnpm db:seed

step "rules, server wasm, sdk"
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
./scripts/build-wasm-server.sh
pnpm sdk:build

step "demo project demo_local"
mkdir -p "$root/.readmeter"
pnpm --filter @readmeter/db exec tsx src/dev-project.ts

# shellcheck disable=SC1090
source "$ENV_FILE"

step "example env files"
cat >"$root/examples/web-firestore/.env" <<EOF
VITE_USE_EMULATOR=1
VITE_FIREBASE_CONFIG={"apiKey":"demo","projectId":"demo-readmeter"}
VITE_READMETER_API_KEY=$READMETER_API_KEY
VITE_READMETER_HASH_KEY=$READMETER_HASH_KEY
VITE_READMETER_ENDPOINT=$READMETER_ENDPOINT
EOF
cat >"$root/examples/functions/.env" <<EOF
READMETER_API_KEY=$READMETER_API_KEY
READMETER_HASH_KEY=$READMETER_HASH_KEY
READMETER_ENDPOINT=$READMETER_ENDPOINT
EOF

step "pack the sdk and build Cloud Functions"
(cd "$root/sdks/js/firebase" && pnpm pack --pack-destination .)
# The tarball name does not change when the SDK does. Drop the installed copy
# so npm reads the new pack instead of treating the dependency as up to date.
(
  cd "$root/examples/functions"
  # package-lock pins the previous tarball hash, so a same-name pack is ignored.
  rm -rf node_modules/@readmeter package-lock.json
  npm install --no-audit --no-fund
  npm run build
)

step "ingest"
mkdir -p "$root/target/dev"
stop_pid "$root/target/dev/ingest.pid"
if port_open 8090; then
  echo "port 8090 is still in use after stopping the recorded ingest pid" >&2
  exit 1
fi
start_detached "$root/target/dev/ingest.pid" "$root/target/dev/ingest.log" \
  pnpm --filter @readmeter/ingest start
if ! wait_http "http://127.0.0.1:8090/healthz" 90; then
  echo "ingest log:" >&2
  tail -n 80 "$root/target/dev/ingest.log" >&2 || true
  exit 1
fi
echo "ingest healthy at http://127.0.0.1:8090"

step "console api"
# Dev-only key so the console can store a service account. A real deployment sets its own.
export READMETER_SECRET_KEY="${READMETER_SECRET_KEY:-MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=}"
stop_pid "$root/target/dev/console-api.pid"
if port_open 8091; then
  echo "port 8091 is still in use after stopping the recorded console-api pid" >&2
  exit 1
fi
start_detached "$root/target/dev/console-api.pid" "$root/target/dev/console-api.log" \
  pnpm --filter @readmeter/console-api start
if ! wait_http "http://127.0.0.1:8091/healthz" 90; then
  echo "console-api log:" >&2
  tail -n 80 "$root/target/dev/console-api.log" >&2 || true
  exit 1
fi
echo "console api healthy at http://127.0.0.1:8091"

step "gcp connector"
stop_pid "$root/target/dev/connector-gcp.pid"
start_detached "$root/target/dev/connector-gcp.pid" "$root/target/dev/connector-gcp.log" \
  pnpm --filter @readmeter/connector-gcp start
ready=0
for ((i = 1; i <= 30; i++)); do
  if grep -q "connector started" "$root/target/dev/connector-gcp.log" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  echo "connector-gcp log:" >&2
  tail -n 80 "$root/target/dev/connector-gcp.log" >&2 || true
  exit 1
fi
echo "gcp connector started"

step "console web"
stop_pid "$root/target/dev/console-web.pid"
if port_open 5174; then
  echo "port 5174 is still in use after stopping the recorded console-web pid" >&2
  exit 1
fi
start_detached "$root/target/dev/console-web.pid" "$root/target/dev/console-web.log" \
  pnpm --filter console-web dev
if ! wait_http "http://127.0.0.1:5174" 90; then
  echo "console-web log:" >&2
  tail -n 80 "$root/target/dev/console-web.log" >&2 || true
  exit 1
fi
echo "console web healthy at http://localhost:5174"

cat <<EOF

Next:
  cd examples && npx -y firebase-tools@latest emulators:start --project demo-readmeter
  pnpm --filter web-firestore dev
  console http://localhost:5174
  login admin@readmeter.local / readmeter-dev
  workspace local, project demo_local

EOF
