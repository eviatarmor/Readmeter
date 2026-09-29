#!/usr/bin/env bash
# Bring up Postgres, ingest, and the local demo project. Idempotent.
# Git Bash on Windows, bash on Linux.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# shellcheck source=dev-common.sh
source "$root/scripts/dev-common.sh"

PROJECT=demo_local
ENV_FILE="$root/.readmeter/local.env"
ORIGINS="http://127.0.0.1:5173,http://localhost:5173"
ENDPOINT="http://127.0.0.1:8090"

field() {
  local name=$1 text=$2
  printf '%s\n' "$text" | awk -v n="$name" '$1 == n { print $2; exit }'
}

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

step "demo project ${PROJECT}"
mkdir -p "$root/.readmeter"
need_key=1
if [[ -f $ENV_FILE ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if [[ -n ${READMETER_API_KEY:-} && -n ${READMETER_HASH_KEY:-} && ${READMETER_ORIGINS:-} == "$ORIGINS" ]]; then
    need_key=0
    echo "reusing $ENV_FILE"
  fi
fi

if [[ $need_key -eq 1 ]]; then
  set +e
  create_out=$(pnpm run --silent rm project create "$PROJECT" 2>&1)
  create_status=$?
  set -e
  printf '%s\n' "$create_out"
  if [[ $create_status -eq 0 ]]; then
    hash_key=$(field hash_key "$create_out")
  elif printf '%s\n' "$create_out" | grep -q "already exists"; then
    hash_key=$(node "$root/scripts/read-hash-key.mjs" "$PROJECT")
  else
    exit "$create_status"
  fi
  if [[ -z ${hash_key:-} ]]; then
    echo "project create did not print a hash_key" >&2
    exit 1
  fi
  set +e
  key_out=$(pnpm run --silent rm key create "$PROJECT" \
    --origin "http://127.0.0.1:5173" \
    --origin "http://localhost:5173" 2>&1)
  key_status=$?
  set -e
  printf '%s\n' "$key_out"
  if [[ $key_status -ne 0 ]]; then
    exit "$key_status"
  fi
  api_key=$(field key "$key_out")
  if [[ -z ${api_key:-} ]]; then
    echo "key create did not print a key" >&2
    exit 1
  fi
  cat >"$ENV_FILE" <<EOF
READMETER_PROJECT=$PROJECT
READMETER_API_KEY=$api_key
READMETER_HASH_KEY=$hash_key
READMETER_ENDPOINT=$ENDPOINT
READMETER_ORIGINS=$ORIGINS
EOF
fi

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

cat <<EOF

Next:
  cd examples && npx -y firebase-tools@latest emulators:start --project demo-readmeter
  pnpm --filter web-firestore dev
  pnpm run rm findings --project $PROJECT

EOF
