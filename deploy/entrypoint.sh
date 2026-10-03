#!/bin/sh
set -eu
case "${1:-console}" in
  console) cd /app/apps/console-api; exec node --import tsx src/server.ts ;;
  ingest) cd /app/apps/ingest; exec node --import tsx src/server.ts ;;
  connector-gcp) cd /app/apps/connector-gcp; exec node --import tsx src/server.ts ;;
  migrate) cd /app/packages/db; exec node --import tsx src/migrate.ts ;;
  bundle-keygen) cd /app/apps/ingest; exec node --import tsx src/bundle-key.ts keygen ;;
  bundle-key) shift; cd /app/apps/ingest; exec node --import tsx src/bundle-key.ts "$@" ;;
  *) exec "$@" ;;
esac
