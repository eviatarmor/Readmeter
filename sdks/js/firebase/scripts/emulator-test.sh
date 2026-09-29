#!/usr/bin/env bash
# Firestore (8085) and Realtime Database (9000) emulators. Java is required by firebase-tools.
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
exec npx -y firebase-tools@latest emulators:exec --only firestore,database --project demo-readmeter --config test/firebase.json "node --import tsx --test --test-concurrency=1 --test-timeout 180000 test/emulator/web.test.ts && node --import tsx --test --test-force-exit --test-concurrency=1 --test-timeout 180000 test/emulator/admin.test.ts && node --import tsx --test --test-concurrency=1 --test-timeout 180000 test/emulator/database-web.test.ts && node --import tsx --test --test-force-exit --test-concurrency=1 --test-timeout 180000 test/emulator/database-admin.test.ts"
