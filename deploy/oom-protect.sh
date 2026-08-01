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
# Nothing here restarts a service other than earlyoom, and the only unit it
# starts is a small re-stamp timer of its own: the new kill order is written to
# the already-running processes directly, so applying it does not interrupt SSH,
# the VPN, or the office.
#
# NOTE FOR MAINTAINERS: this file is embedded verbatim in deploy/install.sh,
# which is fetched on its own by curl | bash and so cannot read repo files. The
# two copies are pinned equal by deploy/install-sh.test.ts - edit here, then
# run `bun run scripts/embed-deploy-scripts.ts` to update the copy there.
#
# Usage (as root):
#   isomux-oom-protect             apply
#   isomux-oom-protect --dry-run   print what it would do, change nothing
#   isomux-oom-protect --restamp   re-apply a user-level office's kill order
#   isomux-oom-protect --help

set -Eeuo pipefail

TAG=isomux-oom-protect
DRY_RUN=""
RESTAMP=""
SWAPFILE=/swapfile
SWAP_SIZE_MIB=2048
SYSCTL_CONF=/etc/sysctl.d/60-isomux-memory.conf
# Where deploy/install.sh puts this tool, and what the re-stamp timer runs.
OOM_TOOL_PATH=/usr/local/sbin/isomux-oom-protect
RESTAMP_UNIT=isomux-oom-restamp
# How long a restarted office can go unprotected. Short, because the window is
# the whole point of the timer; the run itself is a scan of /proc.
RESTAMP_INTERVAL=1min
# What the office server is tiered at, on either install shape.
OFFICE_SCORE=-500
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
Usage: isomux-oom-protect [--dry-run] [--restamp]

  (no option)  install and configure earlyoom, tier the OOM kill order, set
               swap and swappiness
  --restamp    only re-apply the kill order to a running user-level office,
               and stay quiet when it is already right. This is what the
               $RESTAMP_UNIT timer runs every $RESTAMP_INTERVAL.
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
# Two facts worth remembering. A score is inherited at fork, so these tiers
# would hand the office's own agents and builds the same protection as the
# office - the office undoes that from inside the server by raising its
# descendants back above itself (server/oom-stamp.ts), and earlyoom's --prefer
# above steers by name on top. Neither is this table's job. And on a user-level
# office (systemctl --user) the -500 from the unit file does not apply: Ubuntu's
# user manager lacks the privilege to lower scores, the write fails silently,
# and everything runs at 100. This script repairs the running server from root
# instead, and installs a timer that repeats the repair after every office
# restart. `systemctl show` echoes the configured value either way; only
# /proc/PID/oom_score_adj tells the truth, which is why every write below is
# read back.

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
# running process, which is what this does. Because it is written to a process
# rather than to a config, it dies with it: an office that restarts comes back at
# 100 again. The re-stamp timer further down is what puts it back, so nobody has
# to re-run this tool by hand after every restart.
#
# The other half of the problem - ordering the office's own agents against the
# office - is not solved here at all. The office does that for itself, on every
# install shape, by raising its descendants' scores from inside the server
# (server/oom-stamp.ts): raising a score needs no privilege, only lowering one
# does.
#
# Making the value survive natively would mean lowering the whole user manager,
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
  local pid current
  pid=$(find_user_isomux_pid) || return 0
  current=$(cat "$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null) || current=""
  # The timer below runs this every $RESTAMP_INTERVAL. When the office has not
  # restarted there is nothing to do, and nothing worth a line in the journal.
  if [[ -n $RESTAMP && $current == "$OFFICE_SCORE" ]]; then
    return 0
  fi
  log "found a user-level office (pid $pid); setting its kill order from root"
  if stamp_pid "$pid" "$OFFICE_SCORE" "user-level office"; then
    return 0
  fi
  # In the timer's mode systemd is the only thing watching, so an attempted but
  # unverified stamp has to come back as a failed run. Exiting 0 here would
  # record a minute-by-minute history of success for protection that is not
  # there, which is the exact shape of the bug this whole tool came from.
  # The full install path stays best-effort: it has other work to finish, and
  # stamp_pid has already said what went wrong either way.
  if [[ -n $RESTAMP ]]; then
    return 1
  fi
  return 0
}

# Keeping that stamp applied --------------------------------------------------
#
# Polling, once every $RESTAMP_INTERVAL, rather than reacting to the restart: a
# path unit would need one fixed file to watch, and this tool deliberately does
# not know which user runs the office - it scans /proc for it precisely because
# of that.
#
# Installed on every box, including a hosted one whose office is a system unit
# and already carries the score in its unit file. There the timer finds no
# user-level office and says nothing. The alternative, installing it only when an
# office happens to be running at the moment this tool runs, silently skips the
# operator who sets a box up before starting the office.
#
# One thing to know on a box with more than one login: whoever can create their
# own systemd user unit named isomux.service gets this -500 on it. That is
# already true of running this tool by hand, and an isomux box is a
# single-operator box - everyone with an office account effectively has a shell
# on it (docs/self-hosted.md).
install_restamp_timer() {
  # The unit runs the copy at $OOM_TOOL_PATH, so that copy has to be THIS
  # version of the tool: one installed before --restamp existed would answer
  # every single run with a usage error.
  local self
  self=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null) || self=""
  if [[ -z $self || ! -r $self ]]; then
    warn "could not find this script on disk, so the automatic re-stamp was not set up. A user-level office loses its kill order at the next restart until this tool is run again."
    return 0
  fi
  if [[ $self != "$OOM_TOOL_PATH" ]]; then
    # Into a sibling and then renamed, never written in place: the timer may be
    # starting a run from that exact path at this moment, and truncating the
    # file underneath it would feed the shell half a script. A rename swaps the
    # name atomically and the running copy keeps the old inode. Sibling so it is
    # the same filesystem, which is what makes the rename atomic.
    #
    # -D so a box without /usr/local/sbin gets it made rather than aborting the
    # run here, after the kill order has been applied but before the swap steps.
    local staged="$OOM_TOOL_PATH.new.$$"
    if run install -D -m 755 "$self" "$staged" && run mv -f "$staged" "$OOM_TOOL_PATH"; then
      [[ -n $DRY_RUN ]] || log "installed this tool at $OOM_TOOL_PATH, which is where the re-stamp timer runs it from"
    else
      run rm -f "$staged"
      warn "could not install this tool at $OOM_TOOL_PATH, so the automatic re-stamp was not set up. A user-level office will lose its kill order at its next restart until this tool is run again."
      return 0
    fi
  fi
  write_file "/etc/systemd/system/$RESTAMP_UNIT.service" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
Description=Re-apply the isomux office kill order

[Service]
Type=oneshot
ExecStart=$OOM_TOOL_PATH --restamp
# This runs on a $RESTAMP_INTERVAL timer and normally has nothing to say, but
# each run still costs systemd a "Starting"/"Finished" pair. LogLevelMax drops
# those. Measured on systemd 255 with throwaway units rather than taken from the
# manual: it filters what the manager writes ABOUT a unit, leaves the unit's own
# output alone, and a failed run still records at warning. SyslogLevel then puts
# this tool's own lines at that same ceiling instead of below it, so they keep
# surviving if the filter is ever applied to them as well, which is what the
# documentation says it already does.
SyslogLevel=notice
LogLevelMax=notice
EOF
  write_file "/etc/systemd/system/$RESTAMP_UNIT.timer" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
Description=Re-apply the isomux office kill order after an office restart

[Timer]
OnBootSec=$RESTAMP_INTERVAL
OnUnitActiveSec=$RESTAMP_INTERVAL
# Without this systemd may batch the wakeup up to a minute late, which would
# double the window this timer exists to close.
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  # Not fatal if it will not start: everything above this point has already been
  # applied to the running box, and losing the automatic repeat is worth saying
  # out loud rather than aborting the rest of the run over.
  if run systemctl enable --now "$RESTAMP_UNIT.timer"; then
    log "$RESTAMP_UNIT.timer will re-apply a user-level office's kill order within $RESTAMP_INTERVAL of a restart"
  else
    warn "could not start $RESTAMP_UNIT.timer. A user-level office will lose its kill order at its next restart until this tool is run again."
  fi
}

configure_kill_order() {
  # Written whether or not the unit exists yet: tailscale is often installed
  # after the office, and the drop-in is inert until there is a unit to attach
  # to.
  oom_tier ssh.service -900
  oom_tier tailscaled.service -900
  oom_tier caddy.service -500
  oom_tier isomux.service "$OFFICE_SCORE"
  run systemctl daemon-reload
  configure_user_level_office
  install_restamp_timer
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
  while [[ $# -gt 0 ]]; do
    case $1 in
      --dry-run) DRY_RUN=1 ;;
      --restamp) RESTAMP=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage
        exit 3
        ;;
    esac
    shift
  done
  [[ $EUID -eq 0 ]] || {
    log "ERROR: must run as root (try: sudo isomux-oom-protect)"
    exit 3
  }
  # The timer's job, and only that: everything else here is either already in a
  # unit file that survives a restart on its own, or a one-time provisioning
  # step. Doing it every minute would restart earlyoom every minute.
  if [[ -n $RESTAMP ]]; then
    configure_user_level_office || exit 1
    exit 0
  fi
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
