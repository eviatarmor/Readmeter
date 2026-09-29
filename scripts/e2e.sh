#!/usr/bin/env bash
# Local loop: dev-up, Firestore + Functions emulators, web scenarios, HTTP
# functions, Postgres findings, then a real Chromium pass through Vite.
# Git Bash on Windows, bash on Linux.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
# shellcheck source=dev-common.sh
source "$root/scripts/dev-common.sh"

cleanup() {
  stop_pid "$root/target/dev/preview.pid" || true
  # emulators:exec owns these processes. On Windows the JVM can outlive it.
  node "$root/scripts/free-emulator-port.mjs" 8085 || true
  node "$root/scripts/free-emulator-port.mjs" 5001 || true
}
trap cleanup EXIT

./scripts/dev-up.sh

step "typecheck examples"
pnpm --filter web-firestore exec tsc -p . --noEmit
pnpm --filter readmeter-e2e exec tsc -p . --noEmit

step "playwright chromium"
# The browser check is required when the installer can run. A failed install fails the script.
pnpm --filter web-firestore exec playwright install chromium

# firebase-tools requires JDK 21 or newer. CI sets JAVA_HOME to 21.
# JDK 17 is installed on some dev machines and must not be selected.
step "java for the firestore emulator"
java_line=$(java -version 2>&1 | tr -d '\r' | head -n 1 || true)
java_major=$(printf '%s\n' "$java_line" | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p')
if [[ ${java_major:-0} -lt 21 ]]; then
  found=""
  shopt -s nullglob
  for candidate in \
    "/c/Program Files/Java/jdk-21"* \
    "/c/Program Files/Java/jdk-25"* \
    "/c/Program Files/Java/jdk-24"* \
    "/usr/lib/jvm/"*21* \
    "/usr/lib/jvm/"*25*
  do
    if [[ -x "$candidate/bin/java" ]]; then
      found=$candidate
      break
    fi
  done
  shopt -u nullglob
  if [[ -z $found ]]; then
    echo "firebase emulators need JDK 21 or newer; found: ${java_line:-none}" >&2
    exit 1
  fi
  export JAVA_HOME=$found
  export PATH="$JAVA_HOME/bin:$PATH"
  echo "using $JAVA_HOME"
else
  echo "java: ${java_line:-unknown}"
fi

step "firebase emulators"
node "$root/scripts/free-emulator-port.mjs" 8085
node "$root/scripts/free-emulator-port.mjs" 5001
npx -y firebase-tools@latest emulators:exec \
  --only firestore,functions \
  --project demo-readmeter \
  --config "$root/examples/firebase.json" \
  "bash scripts/e2e-inside.sh"
