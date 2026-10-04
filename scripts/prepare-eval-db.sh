#!/usr/bin/env bash
# Create an eval database from the migrations if it does not exist, so the eval never touches the real knowledge base
# (the `postgres` database of the same local server). EVAL_DB names it: brain_eval (default) holds the fixture corpus,
# brain_real_eval the copy of the real base that `brain eval sync` fills; the name must end in _eval. Pass --reset to
# drop and recreate it; the ingested corpus costs model and embedding calls, so by default it is kept.
set -euo pipefail

ADMIN_URL="${EVAL_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"
EVAL_DB="${EVAL_DB:-brain_eval}"
if [[ ! "$EVAL_DB" =~ ^[a-z_][a-z0-9_]*_eval$ ]]; then
  echo "EVAL_DB must be a lower-case name ending in _eval, got \"${EVAL_DB}\"" >&2
  exit 1
fi
EVAL_URL="${ADMIN_URL%/*}/${EVAL_DB}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--reset" ]]; then
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "drop database if exists ${EVAL_DB} with (force)"
fi

exists="$(psql "$ADMIN_URL" -At -c "select 1 from pg_database where datname = '${EVAL_DB}'")"
if [[ "$exists" == "1" ]]; then
  echo "${EVAL_DB} exists; pass --reset to recreate it" >&2
  exit 0
fi

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "create database ${EVAL_DB}"
psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -c "create schema if not exists extensions"
for f in "$HERE"/supabase/migrations/*.sql; do
  PGOPTIONS="--client-min-messages=warning" psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "${EVAL_DB} ready ($(ls "$HERE"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations)" >&2
