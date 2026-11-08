#!/usr/bin/env bash
# Clean-install smoke test: install one committed revision the way a hosting
# guide tells a new owner to, in a fresh container, and then run check.ts
# against the office it produces. Exit 0 is a pass. A failure names the path
# and the step, and prints the end of that step's log.
#
#   scripts/install-smoke/run.sh manual|installer|installer-gate|hosted|container|kubernetes [REVISION]
#
#   manual     docs/hosting/blocks/install.md on a fresh Ubuntu 24.04, as a
#              normal user: apt packages, Bun, git clone,
#              bun install, bun run dev, then the printed setup link.
#   installer  deploy/install.sh as root on a fresh Ubuntu 24.04 server with
#              systemd, as the VPS guide runs it, then
#              the saved owner invite link.
#   installer-gate
#              the installer path on a box image that already holds the
#              installer's apt packages (read from deploy/install.sh), so the
#              package step adds almost nothing. CI's install smoke stage runs
#              it (scripts/ci.ts); the GitHub workflow runs the fresh path.
#   hosted     the same installer with a staged enrollment, through owner
#              claim, first public address enable and invite. Excludes
#              configure_caddy (renewal helper, hosted Caddyfile),
#              write_loopback_bind_if_proxied and report.
#   container  the release image (deploy/container/Dockerfile) as Render runs
#              it: a data volume, ISOMUX_PUBLIC_URL and a setup key.
#   kubernetes the release image in a local k3d cluster with the owner overlay
#              of the Kubernetes guide (deploy/kubernetes-verify/run.sh), the
#              checks going through its HTTPS ingress. Needs k3d and kubectl,
#              and one such run at a time per machine (one cluster name).
#
# The revision is served from this checkout, so it need not be pushed. Needs
# Docker and git. No provider credentials are used: every agent stays signed
# out. SMOKE_LOG_DIR keeps the step logs (default: a temporary directory).
# SMOKE_FREE_AGENT=1 runs the weekly set, which also requires an answer from
# the Free Welcome Agent and so depends on OpenCode's service.
# SMOKE_DOCKER_LABEL (KEY=VALUE) labels the containers and volumes this run
# makes and the installer's box image, so that whoever started it can remove
# them when this script is killed before its own cleanup (scripts/ci-remote.sh
# does).
set -Eeuo pipefail
cd "$(dirname "$0")/../.."

usage() {
  echo "usage: scripts/install-smoke/run.sh manual|installer|installer-gate|hosted|container|kubernetes [REVISION]" >&2
  exit 2
}
[[ $# == 1 || $# == 2 ]] || usage
path=$1
case $path in manual | installer | installer-gate | hosted | container | kubernetes) ;; *) usage ;; esac
sha=$(git rev-parse --verify "${2:-HEAD}^{commit}")

suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
name=isomux-smoke-$path-$suffix
work=$(mktemp -d)
logs=${SMOKE_LOG_DIR:-$work/logs}
mkdir -p "$logs"
domain=office.example.com
[[ $path != hosted ]] || domain=smoke.isomux.app
images=()
check_set=()
labels=()
[[ -z ${SMOKE_DOCKER_LABEL:-} ]] || labels=(--label "$SMOKE_DOCKER_LABEL")
[[ ${SMOKE_FREE_AGENT:-} != 1 ]] || check_set=(--free-agent)
# A tag other than latest: Kubernetes would try to pull a :latest image.
k8s_image=$name-image:smoke
# The k3d cluster has a fixed name (isomux-verify). This run keeps its
# kubeconfig private, and k3d writes the cluster's context there only when
# this run's own create succeeds; cleanup deletes the cluster only then, so a
# cluster that someone else made is never touched.
export KUBECONFIG=$work/kubeconfig
k8s=(env ISOMUX_VERIFY_DIR="$work/k8s" ISOMUX_VERIFY_IMAGE="$k8s_image" bash deploy/kubernetes-verify/run.sh)
k8s_cluster=isomux-verify
created_cluster() { grep -qs "k3d-$k8s_cluster" "$KUBECONFIG"; }

log() { printf '[smoke:%s] %s\n' "$path" "$*"; }

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-data" >/dev/null 2>&1 || true
  if [[ $path == kubernetes ]] && created_cluster; then "${k8s[@]}" down >/dev/null 2>&1 || true; fi
  local image
  for image in "${images[@]}"; do docker image rm "$image" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# What the office logged, for a failure report.
office_log() {
  case $path in
    manual) docker exec "$name" tail -n 60 /home/smoke/dev.log ;;
    installer | installer-gate | hosted) docker exec "$name" journalctl -u isomux -n 60 --no-pager ;;
    container) docker logs --tail 60 "$name" 2>&1 ;;
    kubernetes)
      kubectl -n isomux get pods
      kubectl -n isomux logs deployment/isomux --all-containers --tail 60
      ;;
  esac
}

# step NAME COMMAND...: run COMMAND with its output in $logs/NAME.log.
step() {
  local step=$1 started=$SECONDS rc=0
  shift
  # A run stopped from outside ends on this line, which names the step.
  log "step $step"
  "$@" >"$logs/$step.log" 2>&1 || rc=$?
  if ((rc == 0)); then
    log "PASS $step ($((SECONDS - started))s)"
    return 0
  fi
  log "FAIL at step $step (exit $rc). End of $logs/$step.log:"
  tail -n 40 "$logs/$step.log" | sed 's/^/    /'
  if [[ $step == office-checks || $step == cluster ]]; then
    log "End of the office log:"
    office_log 2>&1 | tail -n 60 | sed 's/^/    /' || true
  fi
  exit 1
}

# A bare repository holding only $sha, as branch `smoke`, for the installs to
# clone in place of the GitHub repository. The fetch is local, but it once got
# a corrupt pack while the stored objects were intact (task cc5c205b). A
# failed first try gets one more, into a fresh repository; index-pack still
# verifies every object it keeps. Before the second try, fsck checks the
# source and the load is recorded, and a pass leaves a note for
# serve_revision_step. step runs this with errexit off: each command is
# checked.
serve_revision() {
  local repo=$work/isomux.git try rc first_error fsck_rc verdict load
  rm -f "$work/serve-revision.note" || return
  for try in 1 2; do
    rm -rf "$repo" || return
    git init --quiet --bare "$repo" || return
    rc=0
    git -C "$repo" fetch --quiet --depth 1 \
      --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' \
      "file://$PWD" "$sha:refs/heads/smoke" 2>"$work/fetch.err" || rc=$?
    cat "$work/fetch.err" >&2
    if ((rc == 0)); then
      if ((try == 2)); then
        printf 'serve-revision passed on the second try; first try: %s; fsck: %s; load1 %s\n' \
          "$first_error" "$verdict" "${load%% *}" >"$work/serve-revision.note" || return
      fi
      return 0
    fi
    ((try == 1)) || return "$rc"
    first_error=$(grep -m1 . "$work/fetch.err") || first_error="exit $rc, no output"
    # The verdict is evidence only: it never changes the result.
    fsck_rc=0
    timeout 60 git fsck --no-dangling --no-progress >&2 || fsck_rc=$?
    case $fsck_rc in
      0) verdict=ok ;;
      124) verdict=timeout ;;
      *) verdict=failed ;;
    esac
    load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null) || load=unknown
    echo "serve-revision: try 1 failed (exit $rc); source fsck: $verdict; loadavg: $load; $(grep -s MemAvailable /proc/meminfo)" >&2
  done
}

# The serve-revision step. A pass on the second try is printed in run.sh's
# own output: CI keeps that output, and the step log goes with $work.
serve_revision_step() {
  step serve-revision serve_revision
  [[ ! -s $work/serve-revision.note ]] || log "$(cat "$work/serve-revision.note")"
}

check_node_free() {
  local bun=$1 user=$2 repo=$3
  shift 3
  docker cp scripts/install-smoke/node-free.ts "$name:/tmp/isomux-node-free.ts"
  docker exec "$name" chmod a+r /tmp/isomux-node-free.ts
  if [[ $path == installer || $path == installer-gate || $path == hosted ]]; then
    # Read the running service environment as its user without printing it.
    # Container root lacks ptrace access to another user's /proc environment.
    # A Docker exec environment would prove a different PATH from the service.
    docker exec -u "$user" -w "$repo" "$name" bash -ec '
      pid=$(systemctl show -p MainPID --value isomux)
      [[ $pid =~ ^[1-9][0-9]*$ ]]
      mapfile -d "" -t service_env < "/proc/$pid/environ"
      exec env -i "${service_env[@]}" "$1" /tmp/isomux-node-free.ts "$2"
    ' bash "$bun" "$repo"
  else
    docker exec -u "$user" -w "$repo" "$name" "$bun" /tmp/isomux-node-free.ts "$repo" "$@"
  fi
}

run_checks() {
  local bun=$1 user=$2
  shift 2
  docker cp scripts/install-smoke "$name:/opt/install-smoke"
  docker exec "$name" chmod -R a+rX /opt/install-smoke
  docker exec -u "$user" "$name" "$bun" /opt/install-smoke/check.ts --path "$path" "${check_set[@]}" "$@"
}

manual() {
  as_user() { docker exec -u smoke -w /home/smoke "$name" bash -ic "$*"; }
  step machine docker run -d --name "$name" "${labels[@]}" --memory 6g ubuntu:24.04 sleep infinity
  # The guide's reader: a normal account with sudo on an Ubuntu machine that
  # already has curl.
  step account docker exec "$name" bash -c '
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y sudo curl ca-certificates &&
    useradd -m -s /bin/bash smoke &&
    echo "smoke ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/smoke'
  docker cp scripts/install-smoke/manual-steps.sh "$name:/usr/local/bin/manual-steps"
  serve_revision_step
  docker cp "$work/isomux.git" "$name:/srv/isomux.git"
  docker exec "$name" chown -R smoke:smoke /srv/isomux.git
  step packages as_user manual-steps packages
  step bun as_user manual-steps bun
  step runtimes as_user manual-steps runtimes
  step clone as_user "manual-steps clone /srv/isomux.git && git -C isomux checkout --quiet --detach origin/smoke"
  step bun-install as_user manual-steps install
  step node-free check_node_free /home/smoke/.bun/bin/bun smoke /home/smoke/isomux
  # `bun run dev` stays in the reader's terminal; here it runs detached.
  docker exec -d -u smoke -w /home/smoke/isomux "$name" bash -ic 'bun run dev > /home/smoke/dev.log 2>&1'
  step office-checks run_checks /home/smoke/.bun/bin/bun smoke \
    --base http://127.0.0.1:4000 --origin http://localhost:4000 \
    --claim setup-link --office-log /home/smoke/dev.log
}

# Keep the original failure even if the diagnostic replay succeeds.
run_hosted_install() {
  local rc=0 marker=""
  "$@" || rc=$?
  marker=$(docker exec "$name" cat /etc/isomux/install-kind) || true
  printf 'install-kind=%s\n' "$marker"
  if ((rc != 0)); then
    docker exec -e DOMAIN="$domain" "$name" bash -c '
      echo "replayed PUT /api/office/access after install failure:"
      if [[ ! -s /var/lib/isomux-install/session.cookies ]]; then
        echo "no installer cookie jar; replay unavailable"
        exit 0
      fi
      curl -sS --max-time 15 -b /var/lib/isomux-install/session.cookies \
        -X PUT http://127.0.0.1:4000/api/office/access \
        -H "Content-Type: application/json" \
        --data "$(jq -n --arg origin "https://$DOMAIN" "{externalAccess: true, publicOrigin: \$origin}")" \
        -w "\nreplay HTTP %{http_code}\n"' || true
    return "$rc"
  fi
  [[ $marker == hosted ]]
}

# The base apt packages that install_packages in the revision's installer
# installs: its one apt_install line of plain package names (the installer's
# other apt_install calls take variables or run in other functions). A package
# missed here costs time only: install.sh runs unchanged and installs it.
installer_packages() {
  local list
  list=$(git show "$sha:deploy/install.sh" | awk '/^install_packages\(\) \{/,/^}/' |
    sed -n 's/^ *apt_install \([a-z0-9][a-z0-9 .+-]*\)$/\1/p')
  if [[ -z $list || $list == *$'\n'* ]]; then
    echo "expected one apt_install line of package names in install_packages of deploy/install.sh, found: ${list:-none}" >&2
    return 1
  fi
  printf '%s\n' "$list"
}

installer() {
  images+=("$name-box")
  local packages=()
  if [[ $path == installer-gate ]]; then
    step packages-list installer_packages
    packages=(--build-arg "PACKAGES=$(cat "$logs/packages-list.log")")
  fi
  step box-image docker build -q -t "$name-box" "${labels[@]}" "${packages[@]}" -f scripts/install-smoke/box.Dockerfile scripts/install-smoke
  # systemd needs SYS_ADMIN for its mounts and the firewall step needs
  # NET_ADMIN. Both stay inside the container's own namespaces. Kernel-wide
  # settings (sysctl, swap, AppArmor) remain the host's: the installer warns
  # about them and carries on.
  step machine docker run -d --name "$name" "${labels[@]}" --hostname smoke-box --memory 6g \
    --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt apparmor=unconfined \
    --cgroupns=private --tmpfs /run --tmpfs /run/lock "$name-box"
  # Until systemd reports the boot finished. Early on it may not answer at
  # all (no bus yet), which counts as not finished.
  step boot docker exec "$name" bash -c '
    for _ in $(seq 240); do
      state=$(systemctl is-system-running 2>&1)
      case $state in running | degraded) echo "$state"; exit 0 ;; esac
      sleep 0.5
    done
    echo "systemd did not finish booting within 120s: $state"
    exit 1'
  # The guide's admin is connected over SSH when the installer runs.
  step ssh docker exec "$name" systemctl start ssh.service
  serve_revision_step
  # A root-owned repository served over git://, so that root and the service
  # account can both fetch it.
  docker cp "$work/isomux.git" "$name:/srv/isomux.git"
  docker exec "$name" bash -c 'chown -R root:root /srv/isomux.git &&
    git daemon --reuseaddr --base-path=/srv --export-all --listen=127.0.0.1 --detach'
  git show "$sha:deploy/install.sh" > "$work/install.sh"
  docker cp "$work/install.sh" "$name:/root/install.sh"
  local install_command=(bash /root/install.sh) install_runner=()
  if [[ $path == hosted ]]; then
    step enrollment docker exec "$name" bash -ec '
      install -d -m 0700 /etc/isomux/renewal
      printf "%s\n" "{\"endpoint\":\"http://127.0.0.1:9/unused\",\"token\":\"smoke-only\"}" > /etc/isomux/renewal/enrollment.json
      chmod 0600 /etc/isomux/renewal/enrollment.json'
    docker cp scripts/install-smoke/hosted-install.sh "$name:/root/hosted-install.sh"
    install_command=(bash /root/hosted-install.sh /root/install.sh)
    install_runner=(run_hosted_install)
  fi
  step install "${install_runner[@]}" docker exec -e DOMAIN="$domain" -e ISOMUX_REPO=git://127.0.0.1/isomux.git \
    -e ISOMUX_REF=smoke "$name" "${install_command[@]}"
  if [[ $path == hosted ]]; then
    sed -n "/^install-kind=/p" "$logs/install.log"
    step hosted-boundary grep -Fxq HOSTED_SMOKE_TLS_BOUNDARY "$logs/install.log"
    step hosted-state docker exec -e DOMAIN="$domain" "$name" bash -ec '
      [[ -s /var/lib/isomux-install/invite-url ]]
      jq -e --arg origin "https://$DOMAIN" \
        ".externalAccess == true and .publicOrigin == \$origin" \
        /home/isomux/.isomux/office-config.json'
  fi
  step node-free check_node_free /usr/local/bin/bun isomux /opt/isomux
  step office-checks run_checks /usr/local/bin/bun root \
    --base http://127.0.0.1:4000 --origin "https://$domain" \
    --claim invite --invite-file /var/lib/isomux-install/invite-url
}

installer-gate() { installer; }

hosted() { installer; }

container() {
  images+=("$name-image")
  step image bash deploy/container/build.sh "$sha" "$name-image"
  openssl rand -hex 32 > "$work/setup-key"
  # Created here, not by -v, so that it carries the label.
  step volume docker volume create "${labels[@]}" "$name-data"
  step machine docker run -d --name "$name" "${labels[@]}" --memory 4g --cpus 2 \
    -v "$name-data:/var/data" -e ISOMUX_PUBLIC_URL="https://$domain" \
    -e ISOMUX_SETUP_KEY="$(cat "$work/setup-key")" "$name-image"
  docker cp "$work/setup-key" "$name:/tmp/setup-key"
  docker exec "$name" chmod 644 /tmp/setup-key
  step node-free check_node_free /usr/local/bin/bun node /opt/isomux
  step office-checks run_checks bun node \
    --base http://127.0.0.1:10000 --origin "https://$domain" \
    --claim setup-key --setup-key-file /tmp/setup-key
}

cluster_free() {
  if k3d cluster get "$k8s_cluster" >/dev/null 2>&1; then
    echo "a k3d cluster named $k8s_cluster already exists; this run does not use or delete it"
    return 1
  fi
}

kubernetes() {
  images+=("$k8s_image")
  step image bash deploy/container/build.sh "$sha" "$k8s_image"
  # Creates the cluster, imports the image, applies the overlay and waits for
  # the rollout; the setup key is in $work/k8s/setup-key.
  step cluster-free cluster_free
  step cluster "${k8s[@]}" up
  mkdir -p "$work/k8s/install-smoke"
  cp scripts/install-smoke/*.ts "$work/k8s/install-smoke/"
  # A client container on the cluster network that resolves the office host
  # and trusts the test CA.
  step office-checks "${k8s[@]}" client env NODE_EXTRA_CA_CERTS=/work/ca.pem \
    bun /work/install-smoke/check.ts --path "$path" "${check_set[@]}" \
    --base https://office.k8s.test --origin https://office.k8s.test \
    --claim setup-key --setup-key-file /work/setup-key
}

started=$SECONDS
log "testing $sha"
"$path"
cat "$logs/office-checks.log"
# The checks run in the container or the cluster, which have no job summary:
# a check that did not run (check.ts FREE_LIMIT_NOT_CHECKED) goes there from
# here.
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  grep -F 'NOT CHECKED' "$logs/office-checks.log" >>"$GITHUB_STEP_SUMMARY" || true
fi
log "PASS in $((SECONDS - started))s"
