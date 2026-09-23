#!/usr/bin/env bash
# Reviewed root updater-chain acceptance, not a full fresh-host installation.
# Excluded installer stages:
# - preflight: full host-install checks; the fixture uses its own bounded checks.
# - GitHub installer/revision lookup and first image selection: unpublished lane
#   artifacts from the recorded local bare origin/registry replace those inputs.
# - packages, Caddy validation/install/enable, firewall, unattended updates:
#   forbidden mutations of the live host. Their installer tests remain required.
# Production helper execution, system units, updater, revision checks, owner
# authorization and container replacement are never stubbed.
# Setup cleans partial failure. Teardown works even if the client check failed.
# Run only after PM has reviewed this script and Nil authorizes root execution.
set -Eeuo pipefail
[[ $EUID == 0 && $# == 3 ]] || { echo 'Usage (root): verify-container-update-root.sh setup|teardown CHECKOUT COMMIT'; exit 2; }
ROOT=$(cd "$2" && pwd)
EXPECTED=$3
INPUT=$(dirname "$ROOT")/container-updater-fixture-artifacts
FIXTURE=/var/lib/isomux-update-fixture
REGISTRY=isomux-update-fixture-registry
UNITS=(isomux-container.service isomux-container-update.socket isomux-container-update@.service isomux-update@.service)
PATHS=(/opt/isomux-container /var/lib/isomux-update /etc/isomux/update.conf /usr/local/sbin/isomux-update /usr/local/lib/isomux/container-update-helper.py /run/isomux-update /srv/isomux-data)
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root
unset ISOMUX_UPDATE_CONF ISOMUX_REF ISOMUX_INSTALL_MODE ISOMUX_REPO DRY_RUN
head=$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)
[[ $head == "$EXPECTED" ]] || { echo "Checkout revision differs from the reviewed commit"; exit 1; }
echo "laneCommit=$head"

teardown() {
  [[ -f $FIXTURE/owned && ! -L $FIXTURE && $(stat -c %u "$FIXTURE") == 0 ]] || { echo 'No owned root fixture'; return 1; }
  [[ $(cat "$FIXTURE/owned") == isomux-container-updater-fixture-v1 ]] || return 1
  # Only the two known synthetic update instances and the fixture socket/service.
  systemctl stop isomux-update@v2099.1.1.service isomux-update@v2099.1.2.service || true
  systemctl disable --now isomux-container-update.socket isomux-container.service || true
  if [[ -f /opt/isomux-container/compose.yaml && -f /opt/isomux-container/office.env ]]; then
    (cd /opt/isomux-container && docker compose --env-file office.env -f compose.yaml down --timeout 30) || return 1
  fi
  for unit in "${UNITS[@]}"; do rm -f -- "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  systemctl reset-failed isomux-container.service isomux-update@v2099.1.1.service isomux-update@v2099.1.2.service 2>/dev/null || true
  if mountpoint -q /srv/isomux-data; then
    [[ $(findmnt -nr -o SOURCE --mountpoint /srv/isomux-data) == /dev/loop* ]] || return 1
    [[ $(losetup -n -O BACK-FILE "$(findmnt -nr -o SOURCE --mountpoint /srv/isomux-data)") == "$FIXTURE/data.ext4" ]] || return 1
    umount /srv/isomux-data
  fi
  if [[ -f $FIXTURE/loop ]]; then
    local loop
    loop=$(cat "$FIXTURE/loop")
    [[ $loop == /dev/loop* ]] || return 1
    if losetup "$loop" >/dev/null 2>&1; then
      [[ $(losetup -n -O BACK-FILE "$loop") == "$FIXTURE/data.ext4" ]] || return 1
      losetup -d "$loop"
    fi
  fi
  for path in "${PATHS[@]}"; do rm -rf -- "$path"; done
  # Parent dirs can predate the fixture; remove only if empty.
  rmdir /usr/local/lib/isomux /etc/isomux 2>/dev/null || true
  echo "teardown laneCommit=$head"
  rm -rf -- "$FIXTURE"
}

case $1 in
  teardown) teardown; exit ;;
  setup) ;;
  *) exit 2 ;;
esac
[[ ! -e $FIXTURE && ! -L $FIXTURE ]] || { echo 'Root fixture already exists'; exit 1; }
for parent in /opt /var/lib /etc /etc/isomux /usr/local /usr/local/sbin /usr/local/lib /usr/local/lib/isomux /run /srv; do
  [[ ! -L $parent ]] || { echo "Symlink parent: $parent"; exit 1; }
  if [[ -e $parent ]]; then
    [[ $(stat -c %u "$parent") == 0 ]] || exit 1
    [[ -z $(find "$parent" -maxdepth 0 -perm /022 -print) ]] || exit 1
  fi
done
for path in "${PATHS[@]}"; do [[ ! -e $path && ! -L $path ]] || { echo "Occupied path: $path"; exit 1; }; done
for unit in "${UNITS[@]}"; do
  [[ ! -e /etc/systemd/system/$unit && ! -L /etc/systemd/system/$unit ]] || exit 1
  if systemctl cat "$unit" >/dev/null 2>&1; then echo "Occupied unit: $unit"; exit 1; fi
done
[[ -z $(systemctl list-units --all --no-legend 'isomux-update@*' 'isomux-container-update@*') ]] || { echo 'Updater instances exist'; exit 1; }
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=isomux) ]] || { echo 'Compose project is occupied'; exit 1; }
[[ -z $(docker ps -aq --filter name='^/isomux-office-1$') ]] || exit 1
for container in $(docker ps -aq); do
  if docker inspect "$container" | jq -e 'any(.[0].Mounts[]?; .Source == "/srv/isomux-data")' >/dev/null; then
    echo 'A Docker container already references the fixture mount'; exit 1
  fi
done
python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 10000))
PY
[[ $(jq -r .laneCommit "$INPUT/manifest.json") == "$head" ]] || { echo 'Fixture and lane commits differ'; exit 1; }
[[ $(docker inspect "$REGISTRY" --format '{{index .Config.Labels "isomux.updater-fixture"}}') == "$head" ]] || exit 1
install -d -m 755 "$FIXTURE"
printf '%s\n' isomux-container-updater-fixture-v1 > "$FIXTURE/owned"
trap 'rc=$?; if ((rc)); then teardown || echo "Partial cleanup failed: run teardown"; fi' EXIT
cp "$INPUT/manifest.json" "$FIXTURE/manifest.json"
git clone -q --bare --no-hardlinks "$INPUT/origin.git" "$FIXTURE/origin.git"
# Root owns every updater input. Reject a changed manifest/source pair.
from=$(jq -r .fromCommit "$FIXTURE/manifest.json")
to=$(jq -r .toCommit "$FIXTURE/manifest.json")
[[ $(git -C "$FIXTURE/origin.git" rev-parse refs/tags/v2099.1.1) == "$from" && $(git -C "$FIXTURE/origin.git" rev-parse refs/tags/v2099.1.2) == "$to" ]] || exit 1
truncate -s 4G "$FIXTURE/data.ext4"
mkfs.ext4 -q -F "$FIXTURE/data.ext4"
loop=$(losetup --find --show "$FIXTURE/data.ext4")
printf '%s\n' "$loop" > "$FIXTURE/loop"
mkdir /srv/isomux-data
mount "$loop" /srv/isomux-data
# Exclude only the main invocation to call installer steps explicitly.
[[ $(tail -n 1 "$ROOT/deploy/install.sh") == 'main "$@"' ]] || { echo 'Installer entry point changed'; exit 1; }
source <(sed '$d' "$ROOT/deploy/install.sh")
ISOMUX_REF=v2099.1.1
ISOMUX_REPO=$FIXTURE/origin.git
DOMAIN=fixture.example.invalid
CONTAINER_REVISION=$from
CONTAINER_INSTALLER=$ROOT/deploy/install.sh
CONTAINER_STAGE=$(mktemp -d /opt/.isomux-updater-fixture.XXXXXXXX)
trap 'rc=$?; [[ -z ${CONTAINER_STAGE:-} ]] || rm -rf -- "$CONTAINER_STAGE"; if ((rc)); then teardown || echo "Partial cleanup failed: run teardown"; fi' EXIT
umask 077
container_require_root
container_mount_identity
container_assets "$CONTAINER_STAGE"
container_render_caddy "$CONTAINER_STAGE/Caddyfile"
container_check_other_office
container_check_docker_version
container_check_docker
CONTAINER_DIGEST=$(docker image inspect localhost:15000/isomux-fixture:v2099.1.1 --format '{{json .RepoDigests}}' | jq -er '[.[] | select(startswith("localhost:15000/isomux-fixture@sha256:"))] | if length == 1 then .[0] else error("digest") end')
[[ $(docker image inspect "$CONTAINER_DIGEST" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$from" ]] || exit 1
container_install_updater
container_write_settings
container_start
# Synthetic setup secret is read only by the fixture client, never printed.
sed -n 's/^ISOMUX_SETUP_KEY=//p' /opt/isomux-container/office.env > "$FIXTURE/setup-key"
chmod 644 "$FIXTURE/setup-key" "$FIXTURE/manifest.json"
[[ $(stat -c '%u:%g:%a' /run/isomux-update/request.sock) == 0:0:666 ]]
[[ $(stat -c '%u:%a' /usr/local/lib/isomux/container-update-helper.py) == 0:644 ]]
systemctl is-active --quiet isomux-container-update.socket isomux-container.service
trap - EXIT
echo "setup complete laneCommit=$head; run the unprivileged client, then teardown"
