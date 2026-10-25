#!/usr/bin/env bash
# One tick of the automatic deploy of isomux.com.
#
#   /opt/isomux-site/ops/auto-deploy.sh
#
# isomux-site-autodeploy.timer runs it as root every five minutes. It is nilmamano.com's
# auto-deploy.sh (ops/self-host/ in that repo), itself bigOspeedrun's, which follows
# Hosted Isomux's (control-plane/deploy/vps/auto-deploy.sh): one lock for the whole tick,
# stopped and hold markers, a failed list, a rollback that checks what runs, and the same
# status.json fields. There is no build on the VPS: GitHub Actions
# (.github/workflows/site-image.yml) tests, builds and pushes an image to GHCR, and moves
# the `main` tag to it; a push that changes no served file moves the tag to the same
# image, so the digest stays and the tick swaps nothing. A tick reads that tag's digest;
# a new digest is the target. It pulls by digest, swaps with compose, checks, and rolls
# back by itself.
# After the new container passes its checks:
#   - Image cleanup: only the running image and the one before it (the rollback) stay.
#   - Cloudflare purge of the site's names (purge_hosts), not the whole zone: the
#     isomux.com zone also holds cloud.isomux.com (Hosted Isomux). The purge-only token
#     is in $env_dir/purge-token. A failed purge is retried and logged and does not fail
#     the deploy: pages carry s-maxage=300, so the edge heals in 5 minutes.
#
# GitHub reads: the registry (ghcr.io) for the tag, which is not the api.github.com rate
# limit; and one conditional api.github.com request per tick (the image workflow's newest
# run, for `waiting`). It sends the last ETag; a 304 answer does not count against the
# shared 60/h unauthenticated limit.
#
# Per-host values come from $env_dir/auto-deploy.env (0600), plain KEY=value, never run:
#   ISOMUX_SITE_IMAGE           ghcr.io/nmamano/isomux-site
#   ISOMUX_SITE_GITHUB_REPO     nmamano/isomux
#   ISOMUX_SITE_IMAGE_WORKFLOW  site-image.yml
#   ISOMUX_SITE_CF_ZONE         the Cloudflare zone ID of isomux.com; optional (no purge without it)
#   ISOMUX_SITE_TAG             the tag to follow; optional, default main. A rehearsal
#                               follows rehearsal-good or rehearsal-bad
#                               (site-image-rehearsal.yml), which never move main.
# For a local run and the tests: ISOMUX_SITE_ROOT, ISOMUX_SITE_ENV_DIR, ISOMUX_SITE_UNIT_DIR,
# ISOMUX_SITE_SYSTEMCTL, ISOMUX_SITE_DOCKER, ISOMUX_SITE_REGISTRY (registry base URL),
# ISOMUX_SITE_GITHUB_API, ISOMUX_SITE_CF_API, ISOMUX_SITE_SOCKET, ISOMUX_SITE_RETRY_SLEEP.
set -euo pipefail
umask 077

main() {
  env_dir=${ISOMUX_SITE_ENV_DIR:-/etc/isomux-site}
  root=${ISOMUX_SITE_ROOT:-/opt/isomux-site}
  unit_dir=${ISOMUX_SITE_UNIT_DIR:-/etc/systemd/system}
  systemctl=${ISOMUX_SITE_SYSTEMCTL:-systemctl}
  docker=${ISOMUX_SITE_DOCKER:-docker}
  registry=${ISOMUX_SITE_REGISTRY:-https://ghcr.io}
  api=${ISOMUX_SITE_GITHUB_API:-https://api.github.com}
  cf_api=${ISOMUX_SITE_CF_API:-https://api.cloudflare.com/client/v4}
  retry_sleep=${ISOMUX_SITE_RETRY_SLEEP:-5}
  socket=${ISOMUX_SITE_SOCKET:-/run/isomux-site/site.sock}
  # Every name the site answers on. One list for every install: a purge of a name that
  # is not proxied yet does nothing.
  purge_hosts=(isomux.com www.isomux.com stage.isomux.com)
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  state=$root/auto-deploy

  # The status fields. `result` is this tick's outcome; the attempt fields are the last
  # deploy attempt's, kept across ticks. `deployed` and `target` are commits (the image's
  # org.opencontainers.image.revision label).
  result=error phase=start target="" deployed="" waiting=false units=unchecked
  mkdir -p "$state/attempts"
  trap write_status EXIT

  config || return 0
  deployed=$(deployed_commit) || deployed=""

  exec 9>"$root/deploy.lock"
  if ! flock -n 9; then
    result=locked phase=lock
    return 0
  fi
  converge_units

  if [[ -e $state/stopped ]]; then
    result=stopped phase=marker
    return 0
  fi
  if [[ -e $env_dir/auto-deploy.hold ]]; then
    result=held phase=marker
    return 0
  fi
  # The first install is by hand: release.env names the image that runs.
  if [[ ! -f $root/release.env || ! -f $root/compose.yaml ]]; then
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
  image="" repo="" workflow="" tag=main zone=""
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    key=${line%%=*} value=${line#*=}
    case $key in
    ISOMUX_SITE_IMAGE) image=$value ;;
    ISOMUX_SITE_GITHUB_REPO) repo=$value ;;
    ISOMUX_SITE_IMAGE_WORKFLOW) workflow=$value ;;
    ISOMUX_SITE_TAG) tag=$value ;;
    ISOMUX_SITE_CF_ZONE) zone=$value ;;
    esac
  done <"$file"
  [[ $image =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ && $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $workflow =~ ^[A-Za-z0-9_.-]+\.ya?ml$ && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ && $zone =~ ^([0-9a-f]{32})?$ ]] || {
    phase=config
    say "FAIL $file must name ISOMUX_SITE_IMAGE (registry/path), ISOMUX_SITE_GITHUB_REPO (owner/repo) and ISOMUX_SITE_IMAGE_WORKFLOW (file name); ISOMUX_SITE_TAG must be a tag and ISOMUX_SITE_CF_ZONE a zone ID"
    return 1
  }
  image_path=${image#*/}
}

# The installed units follow this directory's copies, as in Hosted's auto-deploy.sh.
converge_units() {
  local name
  for name in isomux-site-autodeploy.service isomux-site-autodeploy.timer; do
    if [[ ! -f $unit_dir/$name ]]; then
      units=absent
      return 0
    fi
  done
  for name in isomux-site-autodeploy.service isomux-site-autodeploy.timer; do
    cmp -s "$here/$name" "$unit_dir/$name" && continue
    : >"$state/units-pending"
    if ! install -m 644 "$here/$name" "$unit_dir/$name"; then
      units=error
      say "FAIL could not install $name"
      return 0
    fi
  done
  if [[ -e $state/units-pending ]]; then
    if ! "$systemctl" daemon-reload || ! "$systemctl" restart isomux-site-autodeploy.timer; then
      units=error
      say "FAIL the units did not reload"
      return 0
    fi
    rm -f "$state/units-pending"
    say "units: installed this directory's copies"
  fi
  units=ok
}

release_digest() { sed -n 's/^ISOMUX_SITE_IMAGE=.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$1" 2>/dev/null; }

deployed_commit() {
  local commit
  commit=$(cat "$root/release.commit" 2>/dev/null) || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ && -n $(release_digest "$root/release.env") ]] || return 1
  echo "$commit"
}

tick_error() {
  result=tick_error phase=$1
  [[ -f $state/tick-error-since ]] || date -u +%FT%TZ >"$state/tick-error-since"
  say "FAIL $2"
}

# One conditional request: the newest run of the image workflow on main. A 304 reuses the
# saved body and does not count against the API rate limit. Prints the run's status.
image_run_status() {
  local etag code tmp
  local -a conditional=()
  tmp=$(mktemp "$state/.run.XXXXXX")
  etag=$(cat "$state/github.etag" 2>/dev/null || true)
  # Only reuse the ETag together with the body it belongs to.
  [[ -n $etag && -f $state/github.json ]] && conditional=(-H "If-None-Match: $etag")
  code=$(curl -sS -o "$tmp" -D "$tmp.headers" -w '%{http_code}' --max-time 20 \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${conditional[@]}" "$api/repos/$repo/actions/workflows/$workflow/runs?branch=main&per_page=1") || code=000
  case $code in
  200)
    mv "$tmp" "$state/github.json"
    tr -d '\r' <"$tmp.headers" | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' >"$state/github.etag"
    ;;
  304) rm -f "$tmp" ;;
  *)
    rm -f "$tmp" "$tmp.headers"
    return 1
    ;;
  esac
  rm -f "$tmp.headers"
  python3 -c 'import json,sys; runs=json.load(open(sys.argv[1])).get("workflow_runs") or [{}]; print(runs[0].get("status") or "none")' "$state/github.json"
}

# The digest the followed tag (ISOMUX_SITE_TAG, default main) points to (a HEAD request; anonymous
# pull token).
main_digest() {
  local token digest
  token=$(curl -sS --max-time 20 "$registry/token?scope=repository:$image_path:pull" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') || return 1
  digest=$(curl -sS -I --max-time 20 -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "$registry/v2/$image_path/manifests/$tag" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *\(sha256:[0-9a-f]\{64\}\)$/\1/p') || return 1
  [[ -n $digest ]] || return 1
  echo "$digest"
}

select_target() {
  local status attempts
  if ! status=$(image_run_status); then
    tick_error api "the image workflow runs could not be read"
    return 1
  fi
  if ! digest=$(main_digest); then
    tick_error registry "the registry's $tag tag could not be read"
    return 1
  fi
  rm -f "$state/tick-error-since"
  # A run that has not completed may still push a new image.
  if [[ $status != completed && $status != none ]]; then
    waiting=true
    [[ -f $state/waiting-since ]] || date -u +%FT%TZ >"$state/waiting-since"
  else
    rm -f "$state/waiting-since"
  fi
  if [[ $digest == "$(release_digest "$root/release.env")" ]]; then
    if $waiting; then result=waiting phase=image_runs; else result=up_to_date phase=select; fi
    return 1
  fi
  if grep -qx "$digest" "$state/failed" 2>/dev/null; then
    result=failed_target phase=select
    return 1
  fi
  # A pull can fail for a passing reason (network, registry). Two more ticks, then the
  # digest is marked failed.
  if ! "$docker" pull --quiet "$image@$digest" >/dev/null; then
    attempts=$(($(cat "$state/attempts/$digest" 2>/dev/null || echo 0) + 1))
    echo "$attempts" >"$state/attempts/$digest"
    if ((attempts >= 3)); then
      result=failed phase=pull
      echo "$digest" >>"$state/failed"
      rm -f "$state/attempts/$digest"
    else
      result=build_failed phase=pull
    fi
    return 1
  fi
  target=$("$docker" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image@$digest") || target=""
  if [[ ! $target =~ ^[0-9a-f]{40}$ ]]; then
    result=refused phase=label
    target=""
    say "$digest has no commit label: not deployed"
    return 1
  fi
  return 0
}

compose() { "$docker" compose -p isomux-site -f "$root/compose.yaml" --env-file "$root/release.env" "$@"; }

# Which image digest runs healthy now: prints it, or fails.
running_digest() {
  local id health digest headers
  id=$(compose ps -q site) || return 1
  [[ -n $id ]] || return 1
  health=$("$docker" inspect --format '{{.State.Health.Status}}' "$id") || return 1
  [[ $health == healthy ]] || return 1
  digest=$("$docker" inspect --format '{{.Config.Image}}' "$id") || return 1
  # What Caddy reaches: the socket answers the home page and robots.txt, and the home
  # page's Markdown answer is never cacheable (the Cloudflare cache rule depends on it;
  # site-host/deploy/README.md).
  curl -fsS --max-time 10 --unix-socket "$socket" -o /dev/null http://localhost/ || return 1
  curl -fsS --max-time 10 --unix-socket "$socket" -o /dev/null http://localhost/robots.txt || return 1
  headers=$(curl -fsS --max-time 10 --unix-socket "$socket" -o /dev/null -D - \
    -H 'Accept: text/markdown' http://localhost/ | tr -d '\r') || return 1
  grep -qi '^content-type: *text/markdown' <<<"$headers" || return 1
  grep -qi '^cache-control:.*no-store' <<<"$headers" || return 1
  echo "${digest##*@}"
}

deploy_target() {
  local previous_commit=$deployed previous_digest running
  phase=deploy
  previous_digest=$(release_digest "$root/release.env")
  say "deploying $target ($digest) over $deployed"
  date -u +%FT%TZ >"$state/attempt-at"
  echo "$target" >"$state/attempt-target"
  cp "$root/release.env" "$root/previous.env"
  # Keep the other lines (ISOMUX_SITE_UID, ISOMUX_SITE_GID); replace only the image.
  {
    grep -v '^ISOMUX_SITE_IMAGE=' "$root/release.env" || true
    printf 'ISOMUX_SITE_IMAGE=%s@%s\n' "$image" "$digest"
  } >"$root/release.env.tmp"
  mv "$root/release.env.tmp" "$root/release.env"

  if compose up -d --wait --wait-timeout 120 >/dev/null 2>&1 && running=$(running_digest) && [[ $running == "$digest" ]]; then
    echo "$target" >"$root/release.commit"
    result=deployed phase='done'
    deployed=$target
    rm -f "$state/attempts/$digest"
    remove_old_images "$digest" "$previous_digest"
    purge_edge
  else
    say "$target did not run healthy: rolling back to $previous_commit"
    mv "$root/previous.env" "$root/release.env"
    if compose up -d --wait --wait-timeout 120 >/dev/null 2>&1 && running=$(running_digest) && [[ $running == "$previous_digest" ]]; then
      result=rolled_back phase=health
      echo "$digest" >>"$state/failed"
      # The edge may hold pages from the failed container.
      purge_edge
    else
      stop "the rollback to $previous_commit does not run healthy"
    fi
  fi
  echo "$result" >"$state/attempt-result"
}

# Removes this site's other images; keeps the running one and the rollback. Only images of
# $image are touched, never another project's. A failure here is logged, not fatal.
remove_old_images() {
  local keep_running=$1 keep_previous=$2 ref
  while IFS= read -r ref; do
    [[ $ref == "$image@$keep_running" || $ref == "$image@$keep_previous" ]] && continue
    [[ $ref == "$image@sha256:"* ]] || continue
    if "$docker" image rm "$ref" >/dev/null 2>&1; then
      say "removed old image $ref"
    else
      say "could not remove old image $ref"
    fi
  done < <("$docker" image ls --digests --format '{{.Repository}}@{{.Digest}}' "$image" 2>/dev/null | sort -u)
}

# Purges the site's names at Cloudflare: three tries, then a log line. Never fails the
# tick. The token goes to curl on stdin (--config), so it is not in any process's argv.
purge_edge() {
  local token_file=$env_dir/purge-token token try out purge_body
  if [[ -z $zone || ! -f $token_file ]]; then
    say "purge skipped: no ISOMUX_SITE_CF_ZONE or no $token_file"
    return 0
  fi
  token=$(head -n1 "$token_file" | tr -d '[:space:]')
  purge_body=$(printf '{"hosts":[%s]}' "$(printf '"%s",' "${purge_hosts[@]}" | sed 's/,$//')")
  for try in 1 2 3; do
    out=$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl -sS --max-time 20 -K - -X POST -H 'Content-Type: application/json' \
        --data "$purge_body" "$cf_api/zones/$zone/purge_cache" 2>/dev/null) || out=""
    if python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("success") is True else 1)' "$out" 2>/dev/null; then
      say "purged the Cloudflare cache (try $try)"
      date -u +%FT%TZ >"$state/purged-at"
      return 0
    fi
    if ((try < 3)); then sleep $((retry_sleep * try)); fi
  done
  say "FAIL the Cloudflare purge failed 3 times; pages heal within s-maxage (5 minutes)"
  date -u +%FT%TZ >"$state/purge-failed-at"
  return 0
}

# Nothing unattended runs again until an operator deletes the marker.
stop() {
  result=rollback_failed phase=check
  date -u +%FT%TZ >"$state/stopped"
  say "STOPPED $1; delete $state/stopped once the site is recovered"
}

# The same fields, order and encoding as Hosted Isomux's status.json.
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
