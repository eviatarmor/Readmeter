#!/usr/bin/env bash
# Verify the release image against a fresh database, without development seeds.
set -euo pipefail
cd "$(dirname "$0")/.."
export READMETER_IMAGE=${READMETER_IMAGE:-readmeter:test}
export POSTGRES_PASSWORD=readmeter_smoke_only
export BETTER_AUTH_SECRET=readmeter-smoke-only-secret-at-least-32-chars
export READMETER_SECRET_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export CONSOLE_PORT=${CONSOLE_PORT:-18091} INGEST_PORT=${INGEST_PORT:-18090}
export CONSOLE_ORIGIN=http://localhost:$CONSOLE_PORT
export INGEST_PUBLIC_URL=http://localhost:$INGEST_PORT
compose=(docker compose -p "readmeter-smoke-${GITHUB_RUN_ID:-$$}" -f deploy/compose.yml)
cleanup() {
  "${compose[@]}" --profile gcp logs --no-color
  "${compose[@]}" --profile gcp down --volumes
}
trap cleanup EXIT
"${compose[@]}" --profile gcp up -d --wait --wait-timeout 180 console ingest connector-gcp
node --input-type=module <<'EOF'
import assert from 'node:assert/strict';
const consoleUrl = process.env.CONSOLE_ORIGIN;
for (const url of [consoleUrl, process.env.INGEST_PUBLIC_URL]) {
  const health = await fetch(`${url}/healthz`);
  assert.equal(health.status, 200);
}
const page = await fetch(`${consoleUrl}/sign-in`);
assert.equal(page.status, 200);
assert.match(page.headers.get('content-type'), /text\/html/);
const html = await page.text();
const asset = html.match(/src="([^"]+\.js)"/);
assert.ok(asset, 'Console JavaScript asset missing');
const js = await fetch(new URL(asset[1], consoleUrl));
assert.equal(js.status, 200);
assert.match(js.headers.get('content-type'), /javascript/);
const signup = await fetch(`${consoleUrl}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: consoleUrl },
  body: JSON.stringify({ email: 'smoke@example.com', password: 'smoke-password-only', name: 'Smoke Test' }),
});
assert.equal(signup.status, 200, await signup.text());
const bundle = await fetch(`${process.env.INGEST_PUBLIC_URL}/v1/bundle`);
assert.equal(bundle.status, 401);
console.log('Docker smoke passed: migrations, Rust core, console assets, signup, ingest auth');
EOF
