#!/bin/sh
set -eu
case "${1:-console}" in
  console) cd /app/apps/console-api; exec node --import tsx src/server.ts ;;
  ingest) cd /app/apps/ingest; exec node --import tsx src/server.ts ;;
  connector-gcp) cd /app/apps/connector-gcp; exec node --import tsx src/server.ts ;;
  migrate) cd /app/packages/db; exec node --import tsx src/migrate.ts ;;
  *) exec "$@" ;;
esac
