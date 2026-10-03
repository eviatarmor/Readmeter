#!/usr/bin/env bash
# Firestore (8085), Realtime Database (9000), Cloud Storage (9199), Auth (9099), and Functions (5001) emulators. Java is required by firebase-tools.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v java >/dev/null 2>&1; then
  echo "Java is required to run the Firestore emulator. Install a JDK and re-run test:emulator." >&2
  exit 1
fi
# One emulator, then each file on its own. Web seeds first; admin wipes what it reads.
# Separate processes so the two SDKs do not share prototype patches or the core client.
# Admin keeps a gRPC channel open after deleteApp. --test-force-exit lets that process end
# once the assertions have finished. Web exits on its own.
if [ ! -d test/functions/node_modules/firebase-functions ]; then
  npm install --prefix test/functions --no-audit --no-fund
fi
# EMULATOR_SUITE=web runs only the web SDK files (CI uses it for each supported firebase major).
web=(web database-web storage-web auth-web functions-web)
all=(web admin database-web database-admin storage-web storage-admin auth-web auth-admin functions-web functions-admin)
if [ "${EMULATOR_SUITE:-all}" = web ]; then files=("${web[@]}"); else files=("${all[@]}"); fi
cmd=""
for f in "${files[@]}"; do
  timeout=180000
  [ "$f" = storage-web ] && timeout=300000
  force=""
  case "$f" in *admin) force="--test-force-exit " ;; esac
  step="node --import tsx --test ${force}--test-concurrency=1 --test-timeout $timeout test/emulator/$f.test.ts"
  cmd="${cmd:+$cmd && }$step"
done
exec npx -y firebase-tools@latest emulators:exec --only firestore,database,storage,auth,functions --project demo-readmeter --config test/firebase.json "$cmd"
