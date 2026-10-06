#!/usr/bin/env bash
# Deploy one source commit of Hosted Isomux to this Docker host.
#
#   control-plane/deploy/vps/deploy.sh [--prepare] <commit>
#
# Run it from any clone of the repository that has the commit. It builds from a
# `git archive` of that commit, never from the working tree. On the production
# host it runs as root with the defaults below; the four variables point a
# local run at a throwaway project, env dir, release root and ports.
#
# The first run on a host (no generated/ directory and neither named volume)
# generates every database password, the seam token and the database identity,
# creates the roles, bootstraps the schema and stamps the identity. Every later
# run only builds, replaces the two app containers and checks them: it never
# bootstraps, regrants, resets a password or stamps the identity.
#
# --prepare does the first install and stops before any app starts: no
# provisioner, no web. It is for a move, where the database is restored and the
# provisioner state imported before the provisioner first runs (README, "Moving
# Hosted Isomux to a Docker host"). The next run without it starts the apps.
#
# Once the new release starts to replace the running one, any failure puts the
# previous release back (provisioner and web only, never the database) and
# checks that it serves: exit 5 when it does, exit 6 when it does not. A first
# install has nothing to go back to and exits 1. auto-deploy.sh runs this
# script with ISOMUX_HOSTED_LOCK_INHERITED=1 and the deploy lock held on fd 9.
#
# Output is step lines and booleans. No value from an env file is printed, put
# on a command line, baked into an image or written to a log.
set -euo pipefail
umask 077

project=${ISOMUX_HOSTED_PROJECT:-isomux-hosted}
env_dir=${ISOMUX_HOSTED_ENV_DIR:-/etc/isomux-hosted}
root=${ISOMUX_HOSTED_ROOT:-/opt/isomux-hosted}
web_port=${ISOMUX_HOSTED_WEB_PORT:-3100}
provisioner_port=${ISOMUX_HOSTED_PROVISIONER_PORT:-4311}

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  say "FAIL $*"
  exit 1
}
# shellcheck source=running.sh
source "$(dirname "$0")/running.sh"

prepare=false
if [[ ${1:-} == --prepare ]]; then
  prepare=true
  shift
fi
[[ $# -eq 1 ]] || die "usage: deploy.sh [--prepare] <commit>"
[[ $project =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "the project name must be lowercase letters, digits and dashes"
[[ $web_port =~ ^[0-9]+$ && $provisioner_port =~ ^[0-9]+$ ]] || die "the ports must be numbers"
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
commit=$(git -C "$repo" rev-parse --verify --quiet "$1^{commit}") || die "no commit $1 in $repo"

# --- The env dir: operator files present, nothing readable by others. ---
private_dir() {
  [[ -d $1 && ! -L $1 && -O $1 ]] || die "$1 must be a directory owned by the deploying user"
  [[ $(stat -c %a "$1") == 700 ]] || die "$1 must be mode 0700"
}
private_file() {
  [[ -f $1 && ! -L $1 && -O $1 ]] || die "$1 must be a file owned by the deploying user"
  [[ $(stat -c %a "$1") == 600 ]] || die "$1 must be mode 0600"
}
private_dir "$env_dir"
private_file "$env_dir/web.env"
private_file "$env_dir/provisioner.env"

mkdir -p "$root/releases"
if [[ ${ISOMUX_HOSTED_LOCK_INHERITED:-} == 1 ]]; then
  # The caller holds the lock on this descriptor; reopening the file here
  # would not be the caller's lock.
  [[ $(readlink /proc/$$/fd/9 2>/dev/null) == "$(realpath "$root/deploy.lock")" ]] ||
    die "ISOMUX_HOSTED_LOCK_INHERITED is set but fd 9 is not $root/deploy.lock"
  flock -n 9 || die "the inherited deploy lock is not held"
else
  exec 9>"$root/deploy.lock"
  flock -n 9 || die "another deploy holds $root/deploy.lock"
fi

# --- First install, redeploy, or a state to refuse. The install is the
# generated credentials and the two named volumes together: the database, and
# the provisioner state (the keys that revoke access, the intent records and
# the ACME account). Nothing is created over a part of it that is missing. ---
generated=$env_dir/generated
db_volume=${project}_pgdata
state_volume=${project}_provisioner-state
present() { [[ $1 == volume ]] && docker volume inspect "$2" >/dev/null 2>&1 || [[ $1 == path && -e $2 ]]; }
have=()
for part in "path $generated" "volume $db_volume" "volume $state_volume"; do
  # shellcheck disable=SC2086
  present $part && have+=(1) || have+=(0)
done
case "${have[*]}" in
"0 0 0")
  first_install=true
  ;;
"1 1 1")
  # Exit 3: an install that was started and not finished. Its database may
  # hold data, so nothing is removed or continued here.
  [[ -f $generated/installed ]] || {
    say "FAIL an earlier first install did not finish ($generated/installed is missing). Inspect the database and the install state before you change anything"
    exit 3
  }
  first_install=false
  private_dir "$generated"
  for f in db.env owner-db.env web-db.env provisioner-db.env seam.env; do
    private_file "$generated/$f"
  done
  ;;
*)
  # Exit 4: a part of the install is missing. Credentials are never
  # regenerated for existing volumes, and no volume is created in place of
  # a lost one.
  label() { [[ $1 == 1 ]] && echo present || echo missing; }
  say "FAIL the install is incomplete: $generated $(label "${have[0]}"), volume $db_volume $(label "${have[1]}"), volume $state_volume $(label "${have[2]}"). Restore the missing part; nothing was changed"
  exit 4
  ;;
esac
! $prepare || $first_install || die "--prepare is for a first install only; nothing was changed"
# A prepared install whose apps have not started yet. Its provisioner state
# has nothing to persist until the first start.
first_start=false
[[ -f $generated/prepared ]] && first_start=true

# --- The release: the commit's own tree, unpacked fresh for every deploy, so
# that only the commit's bytes reach the build that is labelled with it. ---
release=$root/releases/$commit
tmp=$(mktemp -d "$root/releases/.unpack-XXXXXX")
# The images copy file modes from the tree, and the storefront runs as an
# unprivileged user, so the tree gets ordinary modes whatever this umask is.
(umask 022 && git -C "$repo" archive "$commit" | tar -x --no-same-owner -C "$tmp")
if [[ -e $release ]]; then
  old=$(mktemp -d "$root/releases/.replaced-XXXXXX")
  mv "$release" "$old/tree"
  mv "$tmp" "$release"
  rm -rf -- "$old"
else
  mv "$tmp" "$release"
fi
compose_file=$release/control-plane/deploy/vps/compose.yaml
[[ -f $compose_file ]] || die "commit $commit has no control-plane/deploy/vps/compose.yaml"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
started_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
deployment_id=${commit:0:12}-$stamp
web_image=$project-web:${commit:0:12}-$stamp
provisioner_image=$project-provisioner:${commit:0:12}-$stamp
# Build and Compose output can carry a database error with connection detail,
# so it goes to a private log rather than to this transcript.
log=$root/deploy-$stamp.log
quiet() { "$@" >>"$log" 2>&1 || die "$1 ${2:-} failed; see $log"; }

# --- Build both images in a builder with its own memory and CPU ceiling. A
# scope around `docker build` would not cap it: the build runs in the daemon. ---
builder=$project-build-${stamp,,}
cleanup_builder() { docker buildx rm "$builder" >/dev/null 2>&1 || true; }
trap cleanup_builder EXIT
printf '[worker.oci]\n  max-parallelism = 2\n' >"$root/buildkitd.toml"
quiet docker buildx create --name "$builder" --driver docker-container \
  --driver-opt memory=3g --driver-opt memory-swap=3g \
  --driver-opt cpu-period=100000 --driver-opt cpu-quota=200000 \
  --buildkitd-config "$root/buildkitd.toml"
quiet docker buildx inspect --bootstrap "$builder"
limits=$(docker inspect "buildx_buildkit_${builder}0" --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.CpuQuota}}')
[[ $limits == "3221225472 3221225472 200000" ]] || die "the builder does not carry its limits"
say "builder: 3 GiB, no swap, 2 CPUs, parallelism 2"
build() {
  quiet docker buildx build --builder "$builder" --load --progress=plain \
    --label "org.opencontainers.image.revision=$commit" "$@" "$release"
}
build -t "$provisioner_image" -f "$release/control-plane/deploy/Dockerfile" \
  --build-arg "ISOMUX_RELEASE_COMMIT=$commit" --build-arg "ISOMUX_DEPLOY_STARTED_AT=$started_at"
build -t "$web_image" -f "$release/control-plane/deploy/vps/web.Dockerfile"
cleanup_builder
trap - EXIT
say "built: provisioner and web at $commit"

# --- The generated values, on first install only. ---
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
write_private() { # path, then the content on stdin; atomic, 0600
  local tmp
  tmp=$(mktemp "$1.XXXXXX")
  cat >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$1"
}
if $first_install; then
  mkdir -m 700 "$generated"
  superuser_pw=$(hex 24) owner_pw=$(hex 24) web_pw=$(hex 24) provisioner_pw=$(hex 24)
  identity=$(hex 16) seam_token=$(hex 32)
  dsn() { printf 'postgres://%s:%s@db:5432/isomux' "$1" "$2"; }
  printf 'POSTGRES_PASSWORD=%s\n' "$superuser_pw" | write_private "$generated/db.env"
  printf 'CONTROL_PLANE_DB=%s\nCONTROL_PLANE_DB_IDENTITY=%s\n' "$(dsn cp_owner "$owner_pw")" "$identity" |
    write_private "$generated/owner-db.env"
  printf 'CONTROL_PLANE_DB=%s\nCONTROL_PLANE_DB_IDENTITY=%s\n' "$(dsn cp_web "$web_pw")" "$identity" |
    write_private "$generated/web-db.env"
  printf 'CONTROL_PLANE_DB=%s\nCONTROL_PLANE_DB_IDENTITY=%s\n' "$(dsn cp_provisioner "$provisioner_pw")" "$identity" |
    write_private "$generated/provisioner-db.env"
  printf 'CONTROL_PLANE_MINT_TOKEN=%s\n' "$seam_token" | write_private "$generated/seam.env"
  say "generated: database passwords, identity and seam token"
fi

# The release this one replaces, kept for a rollback. Its values are saved
# before release.env is written.
previous_release=$(readlink "$root/current" 2>/dev/null || true)
previous_images=()
if [[ -f $root/release.env ]]; then
  mapfile -t previous_images < <(sed -n 's/^ISOMUX_\(WEB\|PROVISIONER\)_IMAGE=//p' "$root/release.env")
  cp -p "$root/release.env" "$root/release.env.previous"
fi
can_roll_back=false
if ! $first_install && [[ -n $previous_release && -f $root/release.env.previous &&
  -f $previous_release/control-plane/deploy/vps/compose.yaml ]]; then
  can_roll_back=true
fi

# --- From the first write below, a failure puts the previous release back. ---
roll_back() {
  local previous_commit reason
  previous_commit=$(basename "$previous_release")
  say "FAIL the new release did not come up; rolling back to $previous_commit"
  cp -p "$root/release.env.previous" "$root/release.env"
  ln -sfn "$previous_release" "$root/current"
  dcp() { docker compose --env-file "$root/release.env" -f "$previous_release/control-plane/deploy/vps/compose.yaml" "$@"; }
  # --no-deps: the database stays as it is.
  if ! dcp up -d --no-deps --wait --wait-timeout 240 provisioner web >>"$log" 2>&1; then
    say "FAIL rollback: the previous release did not start; see $log"
    return 6
  fi
  if ! reason=$(release_healthy "$previous_commit" "$web_port" dcp); then
    say "FAIL rollback: $reason"
    return 6
  fi
  say "ROLLED BACK $project to $previous_commit; it serves"
  return 5
}
armed=false
on_exit() {
  local status=$?
  if $armed && [[ $status -ne 0 ]]; then
    armed=false
    set +e
    roll_back
    exit $?
  fi
}
trap on_exit EXIT
trap 'exit 1' INT TERM
$can_roll_back && armed=true

# --- The values compose.yaml interpolates. Nothing secret. ---
cat <<EOF | write_private "$root/release.env"
ISOMUX_HOSTED_PROJECT=$project
ISOMUX_HOSTED_ENV_DIR=$env_dir
ISOMUX_HOSTED_WEB_PORT=$web_port
ISOMUX_HOSTED_PROVISIONER_PORT=$provisioner_port
ISOMUX_WEB_IMAGE=$web_image
ISOMUX_PROVISIONER_IMAGE=$provisioner_image
ISOMUX_DEPLOYMENT_ID=$deployment_id
EOF
ln -sfn "$release" "$root/current"
dc() { docker compose --env-file "$root/release.env" -f "$compose_file" "$@"; }

quiet dc up -d --wait --wait-timeout 180 db
say "db: healthy"

if $first_install; then
  # The superuser works through the container's local socket only. The
  # passwords travel on stdin, never on argv.
  printf '%s\n' \
    "create role cp_owner login password '$owner_pw' nosuperuser createrole nocreatedb noreplication;" \
    "create database isomux owner cp_owner;" |
    quiet dc exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres
  quiet dc run --rm owner bun control-plane/cli.ts bootstrap
  # After bootstrap: its preflight refuses runtime roles that can log in.
  printf '%s\n' \
    "alter role cp_web login password '$web_pw';" \
    "alter role cp_provisioner login password '$provisioner_pw';" |
    quiet dc exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d isomux
  quiet dc run --rm owner bun control-plane/cli.ts set-database-identity
  if $prepare; then
    # The state volume, created by Compose with no process of the provisioner
    # running in it, so it stays empty for the import.
    quiet dc run --rm --no-deps -T provisioner true
    : >"$generated/prepared"
    chmod 600 "$generated/prepared"
  fi
  : >"$generated/installed"
  chmod 600 "$generated/installed"
  say "db: owner and runtime roles, schema and identity in place"
fi
if $prepare; then
  say "PASS $project prepared at $commit: no app started"
  exit 0
fi

quiet dc up -d --wait --wait-timeout 240 provisioner web
say "provisioner and web: healthy"

# --- Proof: what runs is what was built, from this commit. ---
for service in provisioner web; do
  image=$web_image
  [[ $service == provisioner ]] && image=$provisioner_image
  container=$(dc ps -q "$service")
  [[ -n $container ]] || die "$service is not running"
  running=$(docker inspect "$container" --format '{{.Image}}')
  [[ $running == "$(docker image inspect "$image" --format '{{.Id}}')" ]] ||
    die "$service runs another image than the one built"
  [[ $(docker image inspect "$running" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$commit" ]] ||
    die "$service's image does not carry revision $commit"
done
say "images: both running containers carry revision $commit"

health=$(dc exec -T provisioner bun -e '
const r = await fetch("http://127.0.0.1:4311/internal/health", {
  headers: { authorization: "Bearer " + process.env.CONTROL_PLANE_MINT_TOKEN },
});
const h = await r.json();
console.log([h.ok, h.database_identity, h.state_persisted, h.release_source?.commit ?? "unknown"].join(" "));
') || die "the provisioner health read failed"
read -r ok identity persisted running_commit <<<"$health"
[[ $ok == true && $identity == true && $running_commit == "$commit" ]] ||
  die "provisioner health is not ok with database_identity true at $commit (ok $ok, database_identity $identity, commit $([[ $running_commit == "$commit" ]] && echo match || echo mismatch))"
# A redeploy must find the state the last release left. ok does not count it,
# because on a first install there is nothing to find.
$first_install || $first_start || [[ $persisted == true ]] || die "the provisioner state did not persist across the redeploy"
rm -f "$generated/prepared"
say "provisioner health: ok true, database_identity true, state_persisted $persisted, commit $commit"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$web_port/") || code=none
[[ $code == 200 ]] || die "the storefront home page answered $code"
say "web: home page 200 on 127.0.0.1:$web_port"

[[ -z $(docker port "$(dc ps -q db)") ]] || die "the database publishes a port"
say "db: no published port"
# The new release serves: nothing after this point rolls it back.
armed=false

# --- Keep this release and the one before it; remove older ones. ---
keep=" $web_image $provisioner_image ${previous_images[*]} "
while read -r image; do
  [[ $keep == *" $image "* ]] && continue
  docker image rm "$image" >>"$log" 2>&1 || say "prune: kept $image, it is in use"
done < <(docker image ls --filter "reference=$project-*" --format '{{.Repository}}:{{.Tag}}')
for dir in "$root"/releases/*; do
  [[ $(basename "$dir") =~ ^[0-9a-f]{40}$ ]] || continue
  [[ $dir == "$release" || $dir == "$previous_release" ]] && continue
  rm -rf -- "$dir"
done
say "prune: older images and release trees removed"
say "PASS $project at $commit (deployment $deployment_id)"
