#!/usr/bin/env bash
# isomux-oom-protect - keep a memory spike from taking the whole box down.
#
# When an isomux box runs out of memory, the kernel's own last-resort killer
# arrives too late: by then the machine is already swapping so hard that
# nothing responds, including the SSH and VPN daemons you would need to fix it.
# The box looks dead and only a console reboot brings it back.
#
# This sets up the cheap version of the fix:
#   - earlyoom kills ONE process while there is still memory left to act with,
#   - the kill order is tiered so the things that keep the box reachable go
#     last and agent processes go first,
#   - swap is kept small and the kernel is told to prefer dropping file caches
#     over swapping live memory, so pressure turns into a kill instead of
#     hours of disk grinding.
#
# Losing one agent is a papercut; losing the box is an outage.
#
# deploy/install.sh installs this at /usr/local/sbin/isomux-oom-protect and
# runs it during an install. It is re-runnable, and runs straight from a
# checkout on a box that was set up before it existed:
#
#   sudo bash deploy/oom-protect.sh --dry-run   # show what would change
#   sudo bash deploy/oom-protect.sh
#
# Nothing here restarts a service other than earlyoom: the new kill order is
# written to the already-running processes directly, so applying it does not
# interrupt SSH, the VPN, or the office.
#
# NOTE FOR MAINTAINERS: this file is embedded verbatim in deploy/install.sh,
# which is fetched on its own by curl | bash and so cannot read repo files. The
# two copies are pinned equal by deploy/install-sh.test.ts - edit here, then
# run `bun run scripts/embed-deploy-scripts.ts` to update the copy there.
#
# Usage (as root):
#   isomux-oom-protect             apply
#   isomux-oom-protect --dry-run   print what it would do, change nothing
#   isomux-oom-protect --help

set -Eeuo pipefail

TAG=isomux-oom-protect
DRY_RUN=""
SWAPFILE=/swapfile
SWAP_SIZE_MIB=2048
SYSCTL_CONF=/etc/sysctl.d/60-isomux-memory.conf
# Where to read and write process state. A seam for deploy/oom-protect.test.ts,
# which points it at a fake tree so the kill-order logic can be tested without
# real pids to race against. Never changed in production.
PROC_ROOT=/proc

log() { printf '[%s] %s\n' "$TAG" "$*"; }
warn() { log "warning: $*"; }

run() {
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

write_file() {
  local path=$1 mode=$2
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would write $path (mode $mode) with:"
    sed 's/^/    /'
  else
    install -d -m 755 "$(dirname "$path")"
    install -m "$mode" /dev/null "$path"
    cat >"$path"
  fi
}

usage() {
  cat <<EOF
Usage: isomux-oom-protect [--dry-run]

  (no option)  install and configure earlyoom, tier the OOM kill order, set
               swap and swappiness
  --dry-run    print what would change, change nothing
EOF
}

# --- earlyoom ---------------------------------------------------------------

install_earlyoom() {
  if command -v earlyoom >/dev/null; then
    log "earlyoom already installed"
    return 0
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would apt-get install -y -o Dpkg::Options::=--force-confold earlyoom"
    return 0
  fi
  # --force-confold for the same reason as the installer's apt_install: a
  # noninteractive frontend does not answer dpkg's conffile prompt, and a run
  # with nothing on stdin dies at it. Keep whatever the operator has; this
  # script drives earlyoom through a drop-in and never reads
  # /etc/default/earlyoom anyway.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold earlyoom >/dev/null 2>&1 || {
    warn "could not install earlyoom (it lives in Ubuntu's universe component). The kill order and swap settings below still apply, but nothing will step in early under memory pressure. Install it later with: apt-get install earlyoom"
    return 1
  }
  log "installed earlyoom"
}

# Thresholds and preferences, as a drop-in rather than /etc/default/earlyoom:
# the packaged command line is replaced outright, so there is exactly one place
# that decides how the daemon runs.
#
# -m 10,5      warn-kill at 10% memory left, force-kill at 5%
# -s 100,100   ignore swap entirely. The default only kills once BOTH memory
#              and swap are nearly full, which on a box with a large swap file
#              means the kill never arrives: the machine spends the whole
#              descent thrashing instead.
# --avoid      the daemons that keep the box reachable and the office alive
# --prefer     agent processes: the memory hogs, and the cheapest to lose
#
# Both lists match a process NAME, which is why the office server is shielded as
# `isomux` and not as `bun`. It runs under bun, so its name used to be `bun` - 
# and so is every `bun install` and `bun run build` an agent starts. Shielding
# that name shielded the multi-GB build spike this whole setup exists to kill,
# while the server gained nothing its own workload did not also get. The server
# now names itself `isomux` at startup (server/process-name.ts) so the two can
# be told apart. A build keeps the name `bun` and is a candidate again.
#
# An office older than that rename is still called `bun` and so is not matched
# here. What it falls back on is the OOMScoreAdjust tier, the stronger of the
# two shields - either the one its system unit already carries, or the one this
# tool stamps onto it below. Note that an old USER-level office that this tool
# has never been run against has neither, since its configured tier is the
# ineffective one. Keeping `bun` in the list to cover that case is what caused
# the bug, so it stays out.
configure_earlyoom() {
  write_file /etc/systemd/system/earlyoom.service.d/isomux.conf 644 <<'EOF'
# Written by isomux-oom-protect. Replaces the packaged command line, so
# /etc/default/earlyoom is not consulted.
[Service]
ExecStart=
ExecStart=/usr/bin/earlyoom -m 10,5 -s 100,100 -r 3600 --avoid '^(systemd|systemd-.+|sshd|tailscaled|caddy|earlyoom|isomux)$' --prefer '^(claude|codex|node|chrome)$'
# The process that decides who dies must never be a candidate itself.
OOMScoreAdjust=-1000
Nice=-20
EOF
  run systemctl daemon-reload
  run systemctl enable earlyoom
  run systemctl restart earlyoom
}

# --- kill order -------------------------------------------------------------

# Lower score = killed later. A best-effort bias, not a guarantee: the kernel
# combines it with its own "roughly biggest" heuristic.
#
#   -900  ssh, tailscaled   keep the box reachable
#   -500  isomux, caddy     keep the office up
#
# Two facts worth remembering. Descendants inherit the server's score, so
# these tiers cannot tell the server apart from the agents and builds it
# spawns - steering the kill toward an agent is earlyoom's job (--prefer
# above), not theirs. And on a user-level office (systemctl --user) the -500
# from the unit file does not apply: Ubuntu's user manager lacks the
# privilege to lower scores, the write fails silently, and everything runs
# at 100. This script repairs the running server from root instead, which
# lasts until the office restarts. `systemctl show` echoes the configured
# value either way; only /proc/PID/oom_score_adj tells the truth, which is
# why every write below is read back.

# A process's start time; together with its pid it identifies it uniquely
# (a pid on its own can be recycled). Field 22 of PROC_ROOT/PID/stat,
# reached by dropping everything up to the last ')' because the process
# name in field 2 may contain spaces.
proc_starttime() {
  sed 's/.*) //' "$PROC_ROOT/$1/stat" 2>/dev/null | awk '{ print $20 }'
}

# Set the kill order on a running process and read it back from /proc. The
# readback is the point: a refused write is silent and `systemctl show`
# reports what was ASKED for, not what took (task c5b4e89e).
stamp_pid() {
  local pid=$1 score=$2 what=$3
  [[ -n $pid && $pid != 0 && -r $PROC_ROOT/$pid/stat ]] || return 1
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would set oom_score_adj=$score on the running $what (pid $pid)"
    return 0
  fi
  # Start time is read before the write and re-read only AFTER the readback,
  # so one identity check covers both; a recycled pid cannot fake a success.
  local before after actual
  before=$(proc_starttime "$pid")
  printf '%s\n' "$score" >"$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null || true
  actual=$(cat "$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null) || actual=""
  after=$(proc_starttime "$pid")
  if [[ -z $before || -z $after || $after != "$before" ]]; then
    warn "$what (pid $pid) exited mid-write; nothing verified. Re-run this tool."
    return 1
  fi
  if [[ $actual != "$score" ]]; then
    warn "kill order NOT applied to $what (pid $pid): asked for $score, the kernel reports $actual."
    return 1
  fi
  log "  $what (pid $pid): oom_score_adj=$actual confirmed"
  return 0
}

oom_tier() {
  local unit=$1 score=$2
  write_file "/etc/systemd/system/$unit.d/isomux-oom.conf" 644 <<EOF
# Written by isomux-oom-protect.
[Service]
OOMScoreAdjust=$score
EOF
  # A unit file only takes effect at the next start, and restarting sshd or
  # tailscaled to pick it up is exactly the disruption this script exists to
  # avoid. Write it to the running process too.
  local pid
  pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null) || pid=0
  stamp_pid "$pid" "$score" "$unit" || true
}

# The office on a `systemctl --user` install ----------------------------------
#
# The tier above writes a drop-in for a SYSTEM unit. An office installed the
# self-hosted way (docs/self-hosted.md) has no isomux.service on the system bus,
# so that drop-in is inert - and the obvious repair, a matching drop-in under
# the user's own systemd, does not work either.
#
# Measured on a live office box, 2026-07-31. Ubuntu starts every user manager at
# OOMScoreAdjust=100 (/usr/lib/systemd/system/user@.service) and its services
# inherit that. Lowering a score needs CAP_SYS_RESOURCE, which a user manager
# does not have, so its request for -500 is refused by the kernel - while
# `systemctl --user show` still cheerfully reports -500 and the service starts
# clean. The server reads 100.
#
# Root is not subject to that limit and can write the score straight onto the
# running process, which is what this does. Two honest limits come with it:
# the value is lost when the office restarts, until this tool runs again; and
# agents started AFTER the stamp inherit the server's new score, because a score
# is inherited at fork. Ordering agents against the office is a separate piece
# of work (task C in the sizing design).
#
# Making the value survive a restart would mean lowering the whole user manager,
# putting every process in that operator's login session under the same
# protection - a policy decision this script does not get to make on its own.

# Print the pid of a running user-level isomux service, if there is one.
#
# Found by cgroup rather than by asking systemd: there is no user D-Bus session
# to reach into from here, and this works the same whether the operator happens
# to be logged in or not. The service and everything it spawns share one cgroup,
# so the server is the one whose parent is outside it.
find_user_isomux_pid() {
  local proc pid ppid
  for proc in "$PROC_ROOT"/[0-9]*; do
    pid=${proc##*/}
    grep -qs '/user@[0-9]*\.service/.*/isomux\.service' "$proc/cgroup" || continue
    ppid=$(awk '/^PPid:/ { print $2 }' "$proc/status" 2>/dev/null) || continue
    grep -qs '/user@[0-9]*\.service/.*/isomux\.service' \
      "$PROC_ROOT/$ppid/cgroup" && continue
    printf '%s\n' "$pid"
    return 0
  done
  return 1
}

configure_user_level_office() {
  local pid
  pid=$(find_user_isomux_pid) || return 0
  log "found a user-level office (pid $pid); setting its kill order from root"
  if stamp_pid "$pid" -500 "user-level office"; then
    log "  NOTE: lasts until the office restarts; re-run this tool after restarts."
  fi
}

configure_kill_order() {
  # Written whether or not the unit exists yet: tailscale is often installed
  # after the office, and the drop-in is inert until there is a unit to attach
  # to.
  oom_tier ssh.service -900
  oom_tier tailscaled.service -900
  oom_tier caddy.service -500
  oom_tier isomux.service -500
  run systemctl daemon-reload
  configure_user_level_office
}

# --- swap and swappiness ----------------------------------------------------

configure_swappiness() {
  write_file "$SYSCTL_CONF" 644 <<'EOF'
# Written by isomux-oom-protect.
# Prefer dropping cached file pages over swapping out memory that is in use.
# At the default of 60, a memory spike on a box with a large swap file turns
# into minutes of disk grinding rather than one process being killed.
vm.swappiness = 10
EOF
  run sysctl -q -p "$SYSCTL_CONF"
}

# A small swap file is a useful cushion for pages nothing has touched in days.
# A large one is a trap: it lets the box keep allocating long past the point
# where it can still respond. Existing swap is left alone - resizing it out
# from under a running system is not this script's business.
configure_swap() {
  local total_kib
  total_kib=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)
  if [[ ${total_kib:-0} -gt 0 ]]; then
    log "swap already set up: $((total_kib / 1024)) MiB"
    if [[ $total_kib -gt $((4 * 1024 * 1024)) ]]; then
      log "  that is on the large side; earlyoom ignores swap when deciding, so it still kills on time"
    fi
    return 0
  fi
  local avail_mib
  avail_mib=$(df --output=avail -m / | tail -1 | tr -d ' ')
  if [[ ${avail_mib:-0} -lt $((SWAP_SIZE_MIB + 4096)) ]]; then
    warn "not creating a swap file: only ${avail_mib:-0} MiB free on /"
    return 0
  fi
  if [[ -e $SWAPFILE ]]; then
    warn "$SWAPFILE already exists but is not in use; leaving it alone"
    return 0
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would create a ${SWAP_SIZE_MIB} MiB swap file at $SWAPFILE and add it to /etc/fstab"
    return 0
  fi
  if ! fallocate -l "${SWAP_SIZE_MIB}M" "$SWAPFILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_SIZE_MIB" status=none || {
      rm -f "$SWAPFILE"
      warn "could not create $SWAPFILE; continuing without swap"
      return 0
    }
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  grep -qs "^$SWAPFILE " /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAPFILE" >>/etc/fstab
  log "created a ${SWAP_SIZE_MIB} MiB swap file at $SWAPFILE"
}

# --- main -------------------------------------------------------------------

main() {
  case ${1:-} in
    "") ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 3
      ;;
  esac
  [[ $EUID -eq 0 ]] || {
    log "ERROR: must run as root (try: sudo isomux-oom-protect)"
    exit 3
  }
  local have_earlyoom=1
  install_earlyoom || have_earlyoom=""
  [[ -z $have_earlyoom ]] || configure_earlyoom
  configure_kill_order
  configure_swappiness
  configure_swap
  log ""
  if [[ -n $have_earlyoom ]]; then
    log "Out-of-memory protection is on: when free memory drops under 10%, one"
    log "agent process is killed instead of the whole box becoming unresponsive."
    log "SSH and the office server are killed last (and Tailscale, if this box"
    log "uses it). Re-kick the agent and carry on."
  else
    log "Kill order and swap settings applied, but earlyoom is not installed, so"
    log "nothing steps in early under memory pressure."
  fi
}

main "$@"
