#!/usr/bin/env bash
# Clean-install smoke test: install one committed revision the way a hosting
# guide tells a new owner to, in a fresh container, and then run check.ts
# against the office it produces. Exit 0 is a pass. A failure names the path
# and the step, and prints the end of that step's log.
#
#   scripts/install-smoke/run.sh manual|installer|container|kubernetes [REVISION]
#
#   manual     docs/hosting/blocks/install.md on a fresh Ubuntu 24.04, as a
#              normal user: Node.js through nvm, apt packages, Bun, git clone,
#              bun install, bun run dev, then the printed setup link.
#   installer  deploy/install.sh as root on a fresh Ubuntu 24.04 server with
#              systemd, as the VPS guide and hosted provisioning run it, then
#              the saved owner invite link.
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
set -Eeuo pipefail
cd "$(dirname "$0")/../.."

usage() {
  echo "usage: scripts/install-smoke/run.sh manual|installer|container|kubernetes [REVISION]" >&2
  exit 2
}
[[ $# == 1 || $# == 2 ]] || usage
path=$1
case $path in manual | installer | container | kubernetes) ;; *) usage ;; esac
sha=$(git rev-parse --verify "${2:-HEAD}^{commit}")

suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
name=isomux-smoke-$path-$suffix
work=$(mktemp -d)
logs=${SMOKE_LOG_DIR:-$work/logs}
mkdir -p "$logs"
domain=office.example.com
images=()
check_set=()
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
    installer) docker exec "$name" journalctl -u isomux -n 60 --no-pager ;;
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
# clone in place of the GitHub repository.
serve_revision() {
  git init --quiet --bare "$work/isomux.git"
  git -C "$work/isomux.git" fetch --quiet --depth 1 \
    --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' \
    "file://$PWD" "$sha:refs/heads/smoke"
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
  step machine docker run -d --name "$name" --memory 6g ubuntu:24.04 sleep infinity
  # The guide's reader: a normal account with sudo on an Ubuntu machine that
  # already has curl.
  step account docker exec "$name" bash -c '
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y sudo curl ca-certificates &&
    useradd -m -s /bin/bash smoke &&
    echo "smoke ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/smoke'
  docker cp scripts/install-smoke/manual-steps.sh "$name:/usr/local/bin/manual-steps"
  step serve-revision serve_revision
  docker cp "$work/isomux.git" "$name:/srv/isomux.git"
  docker exec "$name" chown -R smoke:smoke /srv/isomux.git
  step node as_user manual-steps node
  step packages as_user manual-steps packages
  step bun as_user manual-steps bun
  step runtimes as_user manual-steps runtimes
  step clone as_user "manual-steps clone /srv/isomux.git && git -C isomux checkout --quiet --detach origin/smoke"
  step bun-install as_user manual-steps install
  # `bun run dev` stays in the reader's terminal; here it runs detached.
  docker exec -d -u smoke -w /home/smoke/isomux "$name" bash -ic 'bun run dev > /home/smoke/dev.log 2>&1'
  step office-checks run_checks /home/smoke/.bun/bin/bun smoke \
    --base http://127.0.0.1:4000 --origin http://localhost:4000 \
    --claim setup-link --office-log /home/smoke/dev.log
}

installer() {
  images+=("$name-box")
  step box-image docker build -q -t "$name-box" -f scripts/install-smoke/box.Dockerfile scripts/install-smoke
  # systemd needs SYS_ADMIN for its mounts and the firewall step needs
  # NET_ADMIN. Both stay inside the container's own namespaces. Kernel-wide
  # settings (sysctl, swap, AppArmor) remain the host's: the installer warns
  # about them and carries on.
  step machine docker run -d --name "$name" --hostname smoke-box --memory 6g \
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
  step serve-revision serve_revision
  # A root-owned repository served over git://, so that root and the service
  # account can both fetch it.
  docker cp "$work/isomux.git" "$name:/srv/isomux.git"
  docker exec "$name" bash -c 'chown -R root:root /srv/isomux.git &&
    git daemon --reuseaddr --base-path=/srv --export-all --listen=127.0.0.1 --detach'
  git show "$sha:deploy/install.sh" > "$work/install.sh"
  docker cp "$work/install.sh" "$name:/root/install.sh"
  step install docker exec -e DOMAIN="$domain" -e ISOMUX_REPO=git://127.0.0.1/isomux.git \
    -e ISOMUX_REF=smoke "$name" bash /root/install.sh
  step office-checks run_checks /usr/local/bin/bun root \
    --base http://127.0.0.1:4000 --origin "https://$domain" \
    --claim invite --invite-file /var/lib/isomux-install/invite-url
}

container() {
  images+=("$name-image")
  step image bash deploy/container/build.sh "$sha" "$name-image"
  openssl rand -hex 32 > "$work/setup-key"
  step machine docker run -d --name "$name" --memory 4g --cpus 2 \
    -v "$name-data:/var/data" -e ISOMUX_PUBLIC_URL="https://$domain" \
    -e ISOMUX_SETUP_KEY="$(cat "$work/setup-key")" "$name-image"
  docker cp "$work/setup-key" "$name:/tmp/setup-key"
  docker exec "$name" chmod 644 /tmp/setup-key
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
log "PASS in $((SECONDS - started))s"
