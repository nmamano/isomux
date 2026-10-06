#!/usr/bin/env bash
# The acceptance run for deploy.sh on a Docker host that is not production:
# a throwaway project, env dir, release root, ports and volumes, synthetic
# values (Stripe test mode, staging certificate target, no provider account),
# torn down at the end whether it passes or not.
#
#   control-plane/deploy/vps/local-proof.sh <commit>
#
# It installs the commit the way a move does: `deploy.sh --prepare`, which must
# start no app, then a provisioner state import into the empty state volume,
# then a normal run that starts the apps, whose provisioner must take the
# imported create latch into its database. A third run is a redeploy that must
# keep the database identity, the generated credentials, the data and the
# provisioner state, and must build the commit's bytes even when the cached
# release tree was changed. Around them it checks each container's resource
# ceiling, and that deploy.sh refuses an unfinished or incomplete install (exit
# 3 and 4) before it builds or creates anything. Last, one auto-deploy.sh tick
# from a local origin deploys a commit whose provisioner cannot start, under
# the lock that a manual deploy.sh meanwhile cannot take, and deploy.sh puts
# the previous release back.
set -euo pipefail
umask 077

[[ $# -eq 1 ]] || {
  echo "usage: local-proof.sh <commit>" >&2
  exit 2
}
here=$(cd "$(dirname "$0")" && pwd)
export ISOMUX_HOSTED_PROJECT=isomux-hosted-proof
export ISOMUX_HOSTED_WEB_PORT=13100
export ISOMUX_HOSTED_PROVISIONER_PORT=14311
work=$(mktemp -d /tmp/isomux-hosted-proof.XXXXXX)
export ISOMUX_HOSTED_ENV_DIR=$work/env
export ISOMUX_HOSTED_ROOT=$work/root
project=$ISOMUX_HOSTED_PROJECT

say() { printf '%s proof: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  say "FAIL $*"
  exit 1
}

leftovers() {
  docker ps -aq --filter "label=com.docker.compose.project=$project"
  docker volume ls -q --filter "label=com.docker.compose.project=$project"
  docker volume ls -q --filter "name=^${project}_"
  docker network ls -q --filter "label=com.docker.compose.project=$project"
  docker image ls -q --filter "reference=$project-*"
  docker buildx ls --format '{{.Name}}' 2>/dev/null | grep "^$project-build-" || true
}
[[ -z $(leftovers) ]] || die "a previous $project run left containers, volumes, networks, images or builders"

api_pid=""
teardown() {
  local status=$?
  [[ -z $api_pid ]] || kill "$api_pid" 2>/dev/null || true
  # On failure, keep the logs: every value in this run is synthetic.
  if [[ $status -ne 0 && -d $work/root ]]; then
    local kept
    kept=$(mktemp -d /tmp/isomux-hosted-proof-logs.XXXXXX)
    cp "$work"/root/deploy-*.log "$kept"/ 2>/dev/null || true
    [[ -f $work/root/release.env ]] && docker compose --env-file "$work/root/release.env" \
      -f "$work/root/current/control-plane/deploy/vps/compose.yaml" \
      logs --no-color >"$kept/compose.log" 2>&1 || true
    say "logs kept in $kept"
  fi
  if [[ -f $work/root/release.env ]]; then
    docker compose --env-file "$work/root/release.env" \
      -f "$work/root/current/control-plane/deploy/vps/compose.yaml" \
      --profile owner down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker image ls -q --filter "reference=$project-*" | sort -u | xargs -r docker image rm -f >/dev/null 2>&1 || true
  docker buildx ls --format '{{.Name}}' 2>/dev/null | grep "^$project-build-" |
    xargs -r -n1 docker buildx rm >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap teardown EXIT

mkdir -m 700 "$work/env"
cat >"$work/env/web.env" <<EOF
AUTH_URL=http://127.0.0.1:$ISOMUX_HOSTED_WEB_PORT
AUTH_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
CONTROL_PLANE_STRIPE_MODE=test
STRIPE_TEST_SECRET_KEY=sk_test_synthetic
CONTROL_PLANE_ENTRY_PRICE_ID=price_synthetic_entry
CONTROL_PLANE_POWERUSER_PRICE_ID=price_synthetic_poweruser
EOF
cat >"$work/env/provisioner.env" <<'EOF'
CONTROL_PLANE_STRIPE_MODE=test
STRIPE_TEST_SECRET_KEY=sk_test_synthetic
STRIPE_WEBHOOK_SECRET=whsec_synthetic
ISOMUX_CF_ZONE_ID=synthetic-zone
ISOMUX_CF_TOKEN=synthetic-token
ISOMUX_ACME_EMAIL=proof@example.com
ISOMUX_CERT_TARGET=staging
ISOMUX_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory
ISOMUX_CF_API=http://127.0.0.1:9
EOF
chmod 600 "$work/env/web.env" "$work/env/provisioner.env"

commit=$(git -C "$here" rev-parse --verify "$1^{commit}")
dc() {
  docker compose --env-file "$work/root/release.env" \
    -f "$work/root/current/control-plane/deploy/vps/compose.yaml" "$@"
}
refuses() { # expected exit code, then why
  local code=0
  "$here/deploy.sh" "$commit" >"$work/refusal.log" 2>&1 || code=$?
  [[ $code == "$1" ]] || die "deploy.sh exited $code, not $1, with $2"
}
project_images() { docker image ls -q --filter "reference=$project-*" | sort -u | wc -l; }

# A state volume left from something else is not a fresh install.
docker volume create "${project}_provisioner-state" >/dev/null
refuses 4 "a provisioner state volume but no install"
docker volume rm "${project}_provisioner-state" >/dev/null
[[ ! -e $work/env/generated ]] || die "a refused deploy generated credentials"
say "refusal: a leftover state volume blocks a first install"

"$here/deploy.sh" --prepare "$commit"
[[ -z $(dc ps -aq provisioner web) ]] || die "--prepare created an app container"
[[ -f $work/env/generated/installed && -f $work/env/generated/prepared ]] ||
  die "--prepare did not finish the install"
[[ -z $(dc run --rm --no-deps -T provisioner ls -A /data) ]] || die "the prepared state volume is not empty"
images_before=$(project_images)
code=0
"$here/deploy.sh" --prepare "$commit" >"$work/refusal.log" 2>&1 || code=$?
[[ $code == 1 && $(project_images) -eq $images_before ]] || die "a second --prepare did not refuse before it built"
say "prepare: install finished, no app container, state volume empty; a second --prepare refuses"

sql() { dc exec -T db psql -qAt -v ON_ERROR_STOP=1 -U postgres -d isomux; }
account() { echo "select count(*) from accounts where id = '$1';" | sql; }
columns() { echo "select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'accounts'::regclass and attnum > 0 and not attisdropped;" | sql; }
unchanged() { [[ $(account stray-account) == 1 && $(account moved-account) == 0 && $(columns) == "$target_columns" ]]; }

# The old database of a move: a column where a fresh bootstrap does not put it,
# a row, and another install's identity.
sql <<'EOF'
alter table accounts drop column google_subject;
alter table accounts add column google_subject text;
insert into accounts (id, email, version, created_at, updated_at, google_subject) values ('moved-account', 'moved@example.com', 1, 0, 0, 'moved');
update schema_meta set value = 'the old database' where key = 'database_identity';
EOF
source_columns=$(columns)
dc run --rm -T owner bun control-plane/restore-check.ts fingerprint >"$work/source.json"
dc exec -T db pg_dump -U postgres -Fc -d isomux >"$work/source.dump"
# The target: another column order, and a row the restore must remove.
sql <<'EOF'
delete from accounts;
alter table accounts drop column stripe_customer_id;
alter table accounts add column stripe_customer_id text;
insert into accounts (id, email, version, created_at, updated_at) values ('stray-account', 'stray@example.com', 1, 0, 0);
EOF
target_columns=$(columns)
[[ $target_columns != "$source_columns" ]] || die "the target's column order is the source's"

head -c "$(($(stat -c %s "$work/source.dump") / 2))" "$work/source.dump" >"$work/cut.dump"
code=0
"$here/restore.sh" "$work/cut.dump" "$work/source.json" >"$work/refusal.log" 2>&1 || code=$?
[[ $code == 1 ]] && unchanged || die "a restore of a cut dump did not fail with the database as it was"
say "restore: a cut dump fails and leaves the database as it was"

# A pg_restore that writes the whole restore and then fails. The image puts
# /usr/local/bin before /usr/bin on PATH.
dc exec -T db sh -c 'printf "%s\n" "#!/bin/sh" "/usr/bin/pg_restore \"\$@\" && touch /tmp/restore-written" "exit 1" >/usr/local/bin/pg_restore && chmod 755 /usr/local/bin/pg_restore'
code=0
"$here/restore.sh" "$work/source.dump" "$work/source.json" >"$work/refusal.log" 2>&1 || code=$?
dc exec -T db test -e /tmp/restore-written || die "the failing pg_restore did not write the restore"
dc exec -T db rm /usr/local/bin/pg_restore /tmp/restore-written
[[ $code == 1 ]] && unchanged || die "a pg_restore that failed after writing the restore did not leave the database as it was"
say "restore: a pg_restore that fails after its output leaves the database as it was"

"$here/restore.sh" "$work/source.dump" "$work/source.json"
[[ $(account moved-account) == 1 && $(account stray-account) == 0 ]] || die "the restore did not replace the data"
[[ $(columns) == "$source_columns" ]] || die "the restore did not bring the old database's column order"
[[ $(echo "select value from schema_meta where key = 'database_identity';" | sql) == "$(sed -n 's/^CONTROL_PLANE_DB_IDENTITY=//p' "$work/env/generated/owner-db.env")" ]] ||
  die "the restore did not stamp this install's identity"
say "restore: the old database's rows and column order, this install's identity"

# The provisioner state a move brings: one latched create and one audit event.
cat >"$work/state.json" <<'EOF'
{"format":"isomux-provisioner-state","version":1,"exportedAt":"2026-10-06T00:00:00.000Z","intents":[{"intentId":"proof-latched","state":"intended","latchedAt":1700000000000,"plan":"V153","region":"EU"}],"audit":[{"ts":"2026-08-12T10:00:00.000Z","actor":"control-plane-cli","action":"reinstall","target":"100200","outcome":"succeeded"}],"left":{"revokedRuns":0,"auditLinesDropped":0}}
EOF
dc run --rm --no-deps -T provisioner bun control-plane/state-move.ts import <"$work/state.json" >>"$work/import.log" 2>&1 ||
  die "the state import failed"
code=0
dc run --rm --no-deps -T provisioner bun control-plane/state-move.ts import <"$work/state.json" >>"$work/import.log" 2>&1 || code=$?
[[ $code == 1 ]] || die "a second state import did not refuse"
say "import: the state loads into the empty volume; a second import refuses"

"$here/deploy.sh" "$commit"
[[ ! -e $work/env/generated/prepared ]] || die "the first start left the prepared marker"
code=0
"$here/restore.sh" "$work/source.dump" "$work/source.json" >"$work/refusal.log" 2>&1 || code=$?
[[ $code == 1 && $(account moved-account) == 1 ]] || die "a restore after the apps started did not refuse"
say "refusal: no restore once the apps have started"

# The ceilings as the engine applied them, not as the file asks.
for expected in "db 1000000000 2147483648" "provisioner 500000000 536870912" "web 500000000 805306368"; do
  read -r service cpus memory <<<"$expected"
  actual=$(docker inspect "$(dc ps -q "$service")" --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}')
  [[ $actual == "$cpus $memory $memory" ]] || die "$service runs with ceilings $actual"
done
say "ceilings: db 1.0 CPU / 2 GiB, provisioner 0.5 / 512 MiB, web 0.5 / 768 MiB, no swap"

[[ $(echo "select rolsuper::text from pg_roles where rolname = 'cp_owner';" | sql) == false ]] ||
  die "the owner role is a superuser"
echo "insert into accounts (id, email, version, created_at, updated_at) values ('proof-account', 'proof@example.com', 1, 0, 0);" | sql
identity_before=$(echo "select md5(value) from schema_meta where key = 'database_identity';" | sql)
[[ -n $identity_before ]] || die "no identity row after the first install"
[[ $(echo "select state from create_intents where intent_id = 'proof-latched';" | sql) == intended ]] ||
  die "the provisioner did not take the imported latch into its database"
say "first start: the provisioner holds the imported latch"
generated_before=$(cat "$work/env/generated"/* | sha256sum)
first_provisioner=$(dc ps -q provisioner)
dc exec -T provisioner sh -c 'echo proof >/data/proof-sentinel'

# An unfinished or incomplete install refuses before anything is built.
images_before=$(project_images)
mv "$work/env/generated/installed" "$work/installed"
refuses 3 "no installed marker"
mv "$work/installed" "$work/env/generated/installed"
mv "$work/env/generated" "$work/generated"
refuses 4 "the volumes but no generated/"
mv "$work/generated" "$work/env/generated"
[[ $(project_images) -eq $images_before ]] || die "a refused deploy built an image"
say "refusals: unfinished install and missing credentials, nothing built"

# Changed bytes in the cached release tree must not reach the build.
cached=$work/root/releases/$commit/control-plane
echo '// changed after the archive' >>"$cached/stripe/mode.ts"
touch "$cached/injected.ts"

# A release older than the previous one, for the redeploy to prune.
docker image tag "$(docker image ls -q --filter "reference=$project-web" | head -1)" "$project-web:older"
stale_release=$work/root/releases/$(printf '0%.0s' {1..40})
mkdir "$stale_release"

"$here/deploy.sh" "$commit"
[[ $(docker image ls --filter "reference=$project-*" --format '{{.Repository}}:{{.Tag}}' | grep -vc ':older$') -eq 4 ]] ||
  die "the redeploy did not keep both the new and the previous images"
[[ -z $(docker image ls -q "$project-web:older") && ! -e $stale_release ]] ||
  die "the redeploy did not prune the older release"
say "prune: previous release kept for a rollback, older one removed"
[[ $(dc ps -q provisioner) != "$first_provisioner" ]] || die "the redeploy did not replace the provisioner"
[[ $(echo "select md5(value) from schema_meta where key = 'database_identity';" | sql) == "$identity_before" ]] ||
  die "the redeploy changed the database identity"
[[ $(echo "select count(*) from accounts where id = 'proof-account';" | sql) == 1 ]] || die "the redeploy lost data"
[[ $(cat "$work/env/generated"/* | sha256sum) == "$generated_before" ]] || die "the redeploy changed the generated credentials"
[[ $(dc exec -T provisioner cat /data/proof-sentinel) == proof ]] || die "the redeploy lost the provisioner state"
for service in provisioner web; do
  dc exec -T "$service" cat /app/control-plane/stripe/mode.ts |
    cmp -s - <(git -C "$here" show "$commit:control-plane/stripe/mode.ts") ||
    die "$service was built from bytes that are not the commit's"
  [[ $(dc exec -T "$service" sh -c 'test -e /app/control-plane/injected.ts && echo present || echo absent') == absent ]] ||
    die "$service was built with a file that is not in the commit"
done
say "redeploy: identity, generated credentials, data and provisioner state kept; built from the commit's bytes; containers replaced"

# A manual deploy refuses while another holds the lock, before it builds.
bash -c 'exec 9>"$0"; flock 9; exec sleep 600' "$work/root/deploy.lock" &
holder=$!
sleep 1
images_before=$(project_images)
refuses 1 "the deploy lock held by another process"
kill "$holder"
wait "$holder" 2>/dev/null || true
[[ $(project_images) -eq $images_before ]] || die "a deploy refused by the lock built an image"
say "lock: a manual deploy refuses while another holds the lock, nothing built"

# One auto-deploy tick: a local origin whose main has a commit after this one
# that stops the provisioner from starting, and a stub of the Build-runs API
# that calls it green.
git init -q --bare -b main "$work/origin.git"
git -C "$here" push -q --no-verify "$work/origin.git" "$commit:refs/heads/main"
git clone -q -b main "$work/origin.git" "$work/src"
printf 'if (process.argv[2] === "run") process.exit(1);\n' |
  cat - "$work/src/control-plane/cli.ts" >"$work/cli.ts"
mv "$work/cli.ts" "$work/src/control-plane/cli.ts"
git -C "$work/src" -c user.name=proof -c user.email=proof@example.com commit -qam "a provisioner that cannot start"
git -C "$work/src" push -q --no-verify origin HEAD:main
broken=$(git -C "$work/src" rev-parse HEAD)
cat >"$work/api.ts" <<'API'
const runs = [{ head_sha: process.env.BROKEN, run_number: 1, status: "completed", conclusion: "success" }];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ workflow_runs: runs }) });
await Bun.write(process.env.PORT_FILE!, String(server.port));
API
BROKEN=$broken PORT_FILE=$work/api.port bun "$work/api.ts" &
api_pid=$!
for _ in {1..50}; do
  [[ -s $work/api.port ]] && break
  sleep 0.1
done
[[ -s $work/api.port ]] || die "the stub API did not start"
printf 'ISOMUX_HOSTED_SRC=%s\nISOMUX_HOSTED_GITHUB_REPO=owner/repo\n' "$work/src" >"$work/env/auto-deploy.env"
chmod 600 "$work/env/auto-deploy.env"
mkdir "$work/units"
ISOMUX_HOSTED_GITHUB_API=http://127.0.0.1:$(cat "$work/api.port") ISOMUX_HOSTED_UNIT_DIR=$work/units \
  "$work/root/current/control-plane/deploy/vps/auto-deploy.sh" >"$work/auto-deploy.log" 2>&1 ||
  die "auto-deploy.sh exited non-zero"
status=$(cat "$work/root/auto-deploy/status.json")
[[ $status == *'"result":"rolled_back"'* && $status == *"\"deployed\":\"$commit\""* &&
  $status == *"\"target\":\"$broken\""* && $status == *'"stopped":false'* ]] ||
  die "the tick did not end rolled back to $commit: $status"
grep -qx "$broken" "$work/root/auto-deploy/failed" || die "the broken commit is not marked failed"
[[ $(readlink "$work/root/current") == "$work/root/releases/$commit" ]] || die "current does not point at $commit"
# shellcheck source=running.sh
reason=$(source "$here/running.sh" && release_healthy "$commit" "$ISOMUX_HOSTED_WEB_PORT" dc) ||
  die "the previous release does not serve after the rollback: $reason"
[[ $(echo "select count(*) from accounts where id = 'proof-account';" | sql) == 1 ]] || die "the rollback lost data"
[[ $(dc exec -T provisioner cat /data/proof-sentinel) == proof ]] || die "the rollback lost the provisioner state"
say "auto-deploy: a green commit whose provisioner cannot start rolls back to $commit, which serves; the commit is marked failed"

# A lost state volume refuses: no empty volume is created in its place.
dc rm -sf provisioner >/dev/null 2>&1
docker volume rm "${project}_provisioner-state" >/dev/null
images_before=$(project_images)
refuses 4 "the state volume missing"
[[ $(project_images) -eq $images_before ]] || die "a refused deploy built an image"
! docker volume inspect "${project}_provisioner-state" >/dev/null 2>&1 || die "a refused deploy created a state volume"
say "refusal: a missing state volume blocks a redeploy, nothing built or created"

trap - EXIT
teardown
[[ -z $(leftovers) ]] || die "teardown left containers, volumes, networks, images or builders"
[[ ! -e $work ]] || die "teardown left $work"
say "teardown: no container, volume, network, image, builder or file left"
say "PASS"
