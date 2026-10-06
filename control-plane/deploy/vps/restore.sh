#!/usr/bin/env bash
# Restore the old database's dump into a prepared install, for a move.
#
#   control-plane/deploy/vps/restore.sh <dump> <source fingerprint>
#
# <dump> is `pg_dump -Fc` of the old database, and <source fingerprint> is
# `restore-check.ts fingerprint` of it, both taken with every writer stopped.
# It runs only on an install that `deploy.sh --prepare` left and whose apps have
# never started, with the same variables as deploy.sh.
#
# A fresh bootstrap can order a table's columns differently from the old
# database, so a data-only restore does not compare equal. In one transaction,
# this drops the bootstrap's tables, restores the dump's tables owned by
# cp_owner, and grants the bootstrap's privileges again; it commits only when
# every table's owner and privileges are the bootstrap's. Then the owner stamps
# this install's identity, and the restored copy is compared with the source.
# A failure before the commit leaves the database as it was, and the script can
# run again until the apps first start.
set -euo pipefail
umask 077

project=${ISOMUX_HOSTED_PROJECT:-isomux-hosted}
env_dir=${ISOMUX_HOSTED_ENV_DIR:-/etc/isomux-hosted}
root=${ISOMUX_HOSTED_ROOT:-/opt/isomux-hosted}

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  say "FAIL $*"
  exit 1
}

[[ $# -eq 2 ]] || die "usage: restore.sh <dump> <source fingerprint>"
dump=$1 source=$2
[[ -f $dump && -r $dump ]] || die "$dump is not a readable file"
[[ -f $source && -r $source ]] || die "$source is not a readable file"

generated=$env_dir/generated
[[ -f $generated/installed && -f $generated/prepared ]] ||
  die "$project is not a prepared install: run deploy.sh --prepare first. A database whose apps have started is never restored over"
exec 9>"$root/deploy.lock"
flock -n 9 || die "a deploy holds $root/deploy.lock"
dc() { docker compose --env-file "$root/release.env" -f "$root/current/control-plane/deploy/vps/compose.yaml" "$@"; }
[[ -z $(dc ps -aq provisioner web) ]] || die "an app container exists; nothing was changed"
# A database error can quote a row, so the restore's output goes to a private
# log rather than to this transcript.
log=$root/restore-$(date -u +%Y%m%dT%H%M%SZ).log

psql_db() { dc exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d isomux "$@"; }
# Every table's owner and sorted privileges, one line per table.
acl="select coalesce(string_agg(c.relname || ' ' || pg_get_userbyid(c.relowner) || ' ' ||
  coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), ''),
  E'\n' order by c.relname), '')
  from pg_catalog.pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')"

grants=$(dc exec -T db pg_dump -U postgres -d isomux -s | grep -E '^(GRANT|REVOKE) ') ||
  die "the prepared database has no grants to keep"
expected=$(psql_db -c "$acl")
[[ $expected != *'$acl$'* ]] || die "a table name holds the quoting tag"
say "kept: the bootstrap's $(wc -l <<<"$grants") grants on $(wc -l <<<"$expected") tables"

# pg_restore writes the restore as SQL, and psql runs all of it in one
# transaction. When pg_restore fails, the stream ends before the commit and
# PostgreSQL rolls the transaction back.
{
  printf '%s\n' 'begin;' \
    "do \$\$ declare r record; begin for r in select tablename from pg_tables where schemaname = 'public' loop execute format('drop table public.%I cascade', r.tablename); end loop; end \$\$;"
  dc exec -T db pg_restore -f - --no-owner --no-acl --role=cp_owner <"$dump" 2>>"$log" || exit 1
  printf '%s\n' 'reset role;' "$grants"
  printf 'do $do$ begin if (%s) is distinct from $acl$%s$acl$ then raise exception %s; end if; end $do$;\n' \
    "$acl" "$expected" "'the restored tables do not have the bootstrap''s owner and privileges'"
  printf '%s\n' 'commit;'
} | psql_db >>"$log" 2>&1 || die "the restore did not commit; the database is as it was. See $log"
say "restored: $(psql_db -c "select count(*) from pg_tables where schemaname = 'public'") tables, owned by cp_owner with the bootstrap's privileges"

dc run --rm -T owner bun control-plane/cli.ts set-database-identity >>"$log" 2>&1 ||
  die "set-database-identity failed; see $log"
say "identity: stamped for this install"

# The fingerprints are counts, hashes and definitions, with no row data.
dc run --rm -T owner sh -c 'cat >/tmp/source.json &&
  bun control-plane/restore-check.ts fingerprint >/tmp/target.json &&
  bun control-plane/restore-check.ts compare /tmp/source.json /tmp/target.json' <"$source" ||
  die "the restored copy differs from the source (above)"
say "PASS $project restored from $dump"
