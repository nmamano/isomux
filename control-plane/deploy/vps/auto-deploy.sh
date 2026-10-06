#!/usr/bin/env bash
# One tick of the automatic deploy of Hosted Isomux from main.
#
#   /opt/isomux-hosted/current/control-plane/deploy/vps/auto-deploy.sh
#
# isomux-hosted-autodeploy.timer runs it as root every five minutes, always
# from the release that last passed deploy.sh. It fetches main from the public
# repository into a dedicated clone and deploys T, the newest commit on main
# after the deployed one whose GitHub Build is green, when the commits up to T
# change a Hosted input: any path under control-plane/, deploy/install.sh or
# the root .dockerignore. It deploys with T's own deploy.sh, under the deploy
# lock it holds for the whole tick, and then checks from this release what
# runs. It never does a first install.
#
# Every tick writes $root/auto-deploy/status.json (fixed fields; README, "Deploying
# from main"). It fails closed: a fetch or API error deploys nothing and marks
# no commit.
#
# Per-host values come from $env_dir/auto-deploy.env (0600):
#   ISOMUX_HOSTED_SRC          the dedicated clone; origin is the public repo
#   ISOMUX_HOSTED_GITHUB_REPO  owner/repo, for the Build runs
# The other ISOMUX_HOSTED_* variables are deploy.sh's, plus these for a local
# run: ISOMUX_HOSTED_GITHUB_API, ISOMUX_HOSTED_BUN (run build-runs.ts with this
# runtime instead of in the provisioner image), ISOMUX_HOSTED_PROBE (a command
# that replaces the check of what runs), ISOMUX_HOSTED_UNIT_DIR and
# ISOMUX_HOSTED_SYSTEMCTL.
set -euo pipefail
umask 077

main() {
  project=${ISOMUX_HOSTED_PROJECT:-isomux-hosted}
  env_dir=${ISOMUX_HOSTED_ENV_DIR:-/etc/isomux-hosted}
  root=${ISOMUX_HOSTED_ROOT:-/opt/isomux-hosted}
  web_port=${ISOMUX_HOSTED_WEB_PORT:-3100}
  api=${ISOMUX_HOSTED_GITHUB_API:-https://api.github.com}
  unit_dir=${ISOMUX_HOSTED_UNIT_DIR:-/etc/systemd/system}
  systemctl=${ISOMUX_HOSTED_SYSTEMCTL:-systemctl}
  # The physical release directory, not the `current` link: a deploy moves the
  # link, and everything this run loads must stay the release that started it.
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  state=$root/auto-deploy
  # shellcheck source=running.sh
  source "$here/running.sh"

  # The status fields. `result` is this tick's outcome; the attempt fields are
  # the last deploy attempt's, kept across ticks.
  result=error phase=start target="" deployed="" waiting=false units=unchecked
  mkdir -p "$state/attempts"
  trap write_status EXIT

  config || return 0
  # Read again under the lock below; this one is for the status of a tick
  # that stops before it.
  deployed=$(deployed_commit) || deployed=""

  exec 9>"$root/deploy.lock"
  if ! flock -n 9; then
    result=locked phase=lock
    return 0
  fi
  # Under the lock: no deploy is moving `current` while the units follow it.
  converge_units

  if [[ -e $state/stopped ]]; then
    result=stopped phase=marker
    return 0
  fi
  if [[ -e $env_dir/auto-deploy.hold ]]; then
    result=held phase=marker
    return 0
  fi

  if [[ ! -f $env_dir/generated/installed || -e $env_dir/generated/prepared ]]; then
    result=refused phase=install
    return 0
  fi
  deployed=$(deployed_commit) || {
    result=refused phase=current
    return 0
  }

  select_target || return 0
  deploy_target
}

say() { printf '%s auto-deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Only the two named keys, parsed as plain KEY=value lines: the file is never
# run as shell.
config() {
  local file=$env_dir/auto-deploy.env line key value
  [[ -d $env_dir && ! -L $env_dir && -O $env_dir && $(stat -c %a "$env_dir") == 700 ]] || {
    phase=config
    say "FAIL $env_dir must be a directory owned by this user, mode 0700"
    return 1
  }
  [[ -f $file && ! -L $file && -O $file && $(stat -c %a "$file") == 600 ]] || {
    phase=config
    say "FAIL $file must be a file owned by this user, mode 0600"
    return 1
  }
  src="" repo=""
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    key=${line%%=*} value=${line#*=}
    case $key in
    ISOMUX_HOSTED_SRC) src=$value ;;
    ISOMUX_HOSTED_GITHUB_REPO) repo=$value ;;
    esac
  done <"$file"
  [[ $src == /* && -d $src/.git && $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    phase=config
    say "FAIL $file must name ISOMUX_HOSTED_SRC (an absolute path to a clone) and ISOMUX_HOSTED_GITHUB_REPO (owner/repo)"
    return 1
  }
}

# The installed units follow this release's copies. Units that were never
# installed are left alone: the first install is by hand. New bytes leave a
# pending marker that only a successful reload and timer restart remove, so a
# failed activation is tried again on the next run.
converge_units() {
  local name
  for name in isomux-hosted-autodeploy.service isomux-hosted-autodeploy.timer; do
    if [[ ! -f $unit_dir/$name ]]; then
      units=absent
      return 0
    fi
  done
  for name in isomux-hosted-autodeploy.service isomux-hosted-autodeploy.timer; do
    cmp -s "$here/$name" "$unit_dir/$name" && continue
    : >"$state/units-pending"
    if ! install -m 644 "$here/$name" "$unit_dir/$name"; then
      units=error
      say "FAIL could not install $name"
      return 0
    fi
  done
  if [[ -e $state/units-pending ]]; then
    if ! "$systemctl" daemon-reload; then
      units=error
      say "FAIL systemctl daemon-reload failed"
      return 0
    fi
    if ! "$systemctl" restart isomux-hosted-autodeploy.timer; then
      units=error
      say "FAIL the timer did not restart"
      return 0
    fi
    rm -f "$state/units-pending"
    say "units: installed this release's copies"
  fi
  units=ok
}

deployed_commit() {
  local commit
  commit=$(basename "$(readlink "$root/current" 2>/dev/null)")
  [[ $commit =~ ^[0-9a-f]{40}$ && -f $root/release.env ]] || return 1
  echo "$commit"
}

is_input() {
  case $1 in
  control-plane/* | deploy/install.sh | .dockerignore) return 0 ;;
  esac
  return 1
}

inputs_changed() { # from, to
  local path
  while IFS= read -r path; do
    is_input "$path" && return 0
  done < <(git -C "$src" diff --name-only --no-renames "$1" "$2")
  return 1
}

# A fetch or API problem is a tick error: nothing is deployed and no commit is
# marked. Its start time is kept until a tick reads the API again.
tick_error() {
  result=tick_error phase=$1
  [[ -f $state/tick-error-since ]] || date -u +%FT%TZ >"$state/tick-error-since"
  say "FAIL $2"
}

select_target() {
  local candidates newest
  if ! git -C "$src" fetch --quiet origin +refs/heads/main:refs/remotes/origin/main 2>/dev/null; then
    tick_error fetch "git fetch of main failed"
    return 1
  fi
  main=$(git -C "$src" rev-parse --verify --quiet refs/remotes/origin/main) || {
    tick_error fetch "no origin/main after the fetch"
    return 1
  }
  if ! git -C "$src" merge-base --is-ancestor "$deployed" "$main" 2>/dev/null; then
    result=diverged phase=select
    say "the deployed commit $deployed is not on main"
    return 1
  fi
  if [[ $main == "$deployed" ]] || ! inputs_changed "$deployed" "$main"; then
    rm -f "$state/tick-error-since" "$state/waiting-since"
    result=up_to_date phase=select
    return 1
  fi
  waiting=true
  [[ -f $state/waiting-since ]] || date -u +%FT%TZ >"$state/waiting-since"
  mapfile -t candidates < <(git -C "$src" rev-list --ancestry-path "$deployed..$main")
  if ! newest=$(green "${candidates[@]}"); then
    tick_error api "the Build runs could not be read"
    return 1
  fi
  rm -f "$state/tick-error-since"
  if [[ $newest == none ]] || ! inputs_changed "$deployed" "$newest"; then
    result=waiting phase=build_runs
    return 1
  fi
  target=$newest
  if grep -qx "$target" "$state/failed" 2>/dev/null; then
    result=failed_target phase=select
    return 1
  fi
  if git -C "$src" diff --name-only --no-renames "$deployed" "$target" |
    grep -qx 'control-plane/deploy/vps/compose.yaml'; then
    result=manual_deploy_needed phase=select
    say "$target changes compose.yaml: deploy it by hand"
    return 1
  fi
  return 0
}

# The newest green candidate, or `none`; fails on any API problem.
green() {
  local image out
  if [[ -n ${ISOMUX_HOSTED_BUN:-} ]]; then
    out=$("$ISOMUX_HOSTED_BUN" "$here/build-runs.ts" "$api" "$repo" "$@") || return 1
  else
    image=$(sed -n 's/^ISOMUX_PROVISIONER_IMAGE=//p' "$root/release.env")
    [[ -n $image ]] || return 1
    # Host networking reaches the API base a local run points at; the image
    # gets no env file, no volume and no state.
    out=$(docker run --rm --network host --cap-drop ALL --security-opt no-new-privileges \
      --read-only --tmpfs /tmp --user 65534 -e BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$image" \
      bun control-plane/deploy/vps/build-runs.ts "$api" "$repo" "$@") || return 1
  fi
  [[ $out == none || $out =~ ^[0-9a-f]{40}$ ]] || return 1
  echo "$out"
}

# Which commit runs healthy now: prints it, or fails.
running_commit() {
  local commit reason
  if [[ -n ${ISOMUX_HOSTED_PROBE:-} ]]; then
    "$ISOMUX_HOSTED_PROBE"
    return
  fi
  commit=$(basename "$(readlink "$root/current")")
  dc() { docker compose --env-file "$root/release.env" -f "$root/current/control-plane/deploy/vps/compose.yaml" "$@"; }
  reason=$(release_healthy "$commit" "$web_port" dc) || {
    say "check: $reason"
    return 1
  }
  echo "$commit"
}

deploy_target() {
  local code=0 attempts running
  phase=deploy
  if [[ -n $(git -C "$src" status --porcelain) ]]; then
    tick_error clone "the clone $src has local changes"
    return 0
  fi
  if ! git -C "$src" checkout --quiet --detach "$target"; then
    tick_error clone "could not check out $target in $src"
    return 0
  fi
  say "deploying $target over $deployed"
  date -u +%FT%TZ >"$state/attempt-at"
  echo "$target" >"$state/attempt-target"
  ISOMUX_HOSTED_LOCK_INHERITED=1 "$src/control-plane/deploy/vps/deploy.sh" "$target" || code=$?

  # What runs, read from this release and not from the candidate's script.
  running=$(running_commit) || running=""
  case $code in
  0)
    if [[ $running == "$target" ]]; then
      result=deployed phase=done
      deployed=$target
      rm -f "$state/attempts/$target" "$state/waiting-since"
      waiting=false
      if [[ $main != "$target" ]] && inputs_changed "$target" "$main"; then
        waiting=true
        date -u +%FT%TZ >"$state/waiting-since"
      fi
    else
      stop "deploy.sh passed but $target does not run healthy"
    fi
    ;;
  5)
    if [[ $running == "$deployed" ]]; then
      result=rolled_back phase=health
      echo "$target" >>"$state/failed"
    else
      stop "deploy.sh reported a rollback but $deployed does not run healthy"
    fi
    ;;
  *)
    if [[ $running != "$deployed" ]]; then
      stop "deploy.sh exited $code and $deployed does not run healthy"
      return 0
    fi
    # Before the swap: a build can fail for a passing reason (apt, a
    # download, a registry). Two more ticks, then the commit is marked.
    attempts=$(($(cat "$state/attempts/$target" 2>/dev/null || echo 0) + 1))
    echo "$attempts" >"$state/attempts/$target"
    if ((attempts >= 3)); then
      result=failed phase=build
      echo "$target" >>"$state/failed"
      rm -f "$state/attempts/$target"
    else
      result=build_failed phase=build
    fi
    ;;
  esac
  echo "$result" >"$state/attempt-result"
}

# Nothing unattended runs again until an operator deletes the marker.
stop() {
  result=rollback_failed phase=check
  date -u +%FT%TZ >"$state/stopped"
  say "STOPPED $1; delete $state/stopped once the host is recovered"
}

write_status() {
  local tmp
  tmp=$(mktemp "$state/.status.XXXXXX") || return 0
  {
    printf '{"tick_at":"%s",' "$(date -u +%FT%TZ)"
    printf '"deployed":%s,' "$(json_or_null "$deployed")"
    printf '"result":"%s","phase":"%s",' "$result" "$phase"
    printf '"target":%s,' "$(json_or_null "$target")"
    printf '"stopped":%s,' "$([[ -e $state/stopped ]] && echo true || echo false)"
    printf '"held":%s,' "$([[ -e $env_dir/auto-deploy.hold ]] && echo true || echo false)"
    printf '"waiting":%s,' "$waiting"
    printf '"waiting_since":%s,' "$(json_or_null "$($waiting && cat "$state/waiting-since" 2>/dev/null)")"
    printf '"tick_error_since":%s,' "$(json_or_null "$(cat "$state/tick-error-since" 2>/dev/null)")"
    printf '"units":"%s",' "$units"
    printf '"last_attempt":{"at":%s,"target":%s,"result":%s}}\n' \
      "$(json_or_null "$(cat "$state/attempt-at" 2>/dev/null)")" \
      "$(json_or_null "$(cat "$state/attempt-target" 2>/dev/null)")" \
      "$(json_or_null "$(cat "$state/attempt-result" 2>/dev/null)")"
  } >"$tmp"
  mv "$tmp" "$state/status.json"
}

# Every value here is a commit, a timestamp or a fixed word: nothing to escape.
json_or_null() { [[ -n $1 ]] && printf '"%s"' "$1" || printf 'null'; }

main "$@"
