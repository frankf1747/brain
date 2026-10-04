#!/usr/bin/env bash
# Copy the knowledge base's content from <source> into <target> (a database whose name ends in _eval, created by
# EVAL_DB=<target> scripts/prepare-eval-db.sh), replacing what the target held. No model or Voyage call is made:
# embeddings are copied as stored. Run by `npm run brain -- eval sync`.
#
# Both databases live on the local Supabase server, so the dump and the restore run inside its container with the
# server's own pg_dump and psql (same version; the backup steps of the phase plans use them too). pg_dump only reads: it runs in a
# read-only snapshot transaction, and the source is additionally opened with default_transaction_read_only=on.
# The restore is one transaction: truncate, copy, commit. If anything fails the target is left as it was.
set -euo pipefail

usage="usage: sync-eval-db.sh <source database> <target database ending in _eval>"
SRC="${1:?$usage}"
DST="${2:?$usage}"
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_brain}"
# Content tables, in no particular order (pg_dump orders the data by foreign keys). Registries (node_types,
# edge_types) come from the migrations on both sides; logs (retrieval_log, verification_log, tool_calls,
# provider_usage) are not copied.
TABLES=(documents chunks ingest_jobs nodes edges mentions facts extractions fact_events)

die() { echo "sync: $*" >&2; exit 1; }

for n in "$SRC" "$DST"; do
  [[ "$n" =~ ^[a-z_][a-z0-9_]*$ ]] || die "database names must be lower-case identifiers, got \"$n\""
done
[[ "$DST" == *_eval ]] || die "refusing to write to \"$DST\": the target database name must end in _eval"
[[ "$SRC" != *_eval ]] || die "the source \"$SRC\" is an eval database; sync copies the knowledge base into an eval database"
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]] || die "container $CONTAINER is not running (npm run db:start)"
if [[ -n "${SYNC_PORT:-}" ]]; then
  docker port "$CONTAINER" 5432/tcp | grep -q ":${SYNC_PORT}\$" || die "container $CONTAINER does not publish port ${SYNC_PORT}; the URLs name another server"
fi

src_psql() { docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d "$SRC" "$@"; }
dst_psql() { docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d "$DST" "$@"; }

list="$(printf "'%s'," "${TABLES[@]}")"
list="${list%,}"
missing="$(dst_psql -At -c "select coalesce(string_agg(t, ', '), '') from unnest(array[${list}]) t where to_regclass('brain.' || t) is null")"
[[ -z "$missing" ]] || die "$DST lacks brain tables ($missing); create it with EVAL_DB=$DST bash scripts/prepare-eval-db.sh"

counts_sql="$(for t in "${TABLES[@]}"; do printf "select '%s', count(*) from brain.%s union all " "$t" "$t"; done)"
counts_sql="${counts_sql% union all }"

dump_args=()
for t in "${TABLES[@]}"; do dump_args+=(-t "brain.$t"); done
truncate_list="$(printf "brain.%s, " "${TABLES[@]}")brain.retrieval_log, brain.verification_log"

errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT
# A failed pg_dump stops the group before "commit;", so psql reaches the end of its input inside the transaction and
# rolls it back: the target keeps what it had.
if ! {
  echo "begin;"
  echo "truncate ${truncate_list} restart identity;"
  docker exec -e PGOPTIONS="-c default_transaction_read_only=on" "$CONTAINER" \
    pg_dump -U postgres -d "$SRC" --data-only --no-owner --no-privileges "${dump_args[@]}" 2>"$errfile" || exit 1
  echo "commit;"
} | dst_psql >/dev/null; then
  cat "$errfile" >&2
  die "the copy failed; $DST is unchanged"
fi
# pg_dump warns that chunks, nodes and facts reference themselves (parent_id, merged_into, superseded_by). The copy
# of each table is one COPY statement, and foreign keys are checked at its end, so the order of rows within a table
# does not matter; the warning is dropped and anything else is shown.
grep -v -E '^pg_dump: (warning: there are circular foreign-key constraints on this table:|detail: (chunks|nodes|facts)$|hint: )' "$errfile" >&2 || true

src_counts="$(src_psql -At -F ' ' -c "$counts_sql")"
dst_counts="$(dst_psql -At -F ' ' -c "$counts_sql")"
[[ "$src_counts" == "$dst_counts" ]] || die "row counts differ after the copy (source vs target):
$(paste <(echo "$src_counts") <(echo "$dst_counts"))"
echo "synced $SRC -> $DST: $(echo "$dst_counts" | paste -sd ',' - | sed 's/,/, /g')"
