#!/usr/bin/env bash
# Recreate the brain_test database from the migrations, so integration tests never touch
# the real knowledge base (which lives in the `postgres` database of the same local server).
set -euo pipefail

ADMIN_URL="${TEST_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"
TEST_DB="brain_test"
TEST_URL="${ADMIN_URL%/*}/${TEST_DB}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 \
  -c "drop database if exists ${TEST_DB} with (force)" \
  -c "create database ${TEST_DB}"
psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -c "create schema if not exists extensions"
for f in "$HERE"/supabase/migrations/*.sql; do
  PGOPTIONS="--client-min-messages=warning" psql "$TEST_URL" -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "brain_test ready ($(ls "$HERE"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations)" >&2
