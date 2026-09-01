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
#   - the kill order is tiered so the things that keep the box reachable and
#     usable go last and agent processes go first,
#   - swap is sized not to run out mid-spike, and the kernel is told to prefer
#     dropping file caches over swapping live memory.
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
# which is downloaded and run on its own and so cannot read repo files. The
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
SWAP_SIZE_MIB=8192
SYSCTL_CONF=/etc/sysctl.d/60-isomux-memory.conf
OFFICE_MEMORY_DROPIN=/etc/systemd/system/isomux.service.d/20-memory.conf
MEMINFO_PATH=/proc/meminfo
CGROUP_ROOT=/sys/fs/cgroup
OFFICE_MEMORY_MIN_MIB=4096
OFFICE_MEMORY_RESERVE_MIB=1024
OFFICE_SWAP_MAX_MIB=6144
# Where deploy/install.sh puts this tool, and what the re-stamp timer runs.
OOM_TOOL_PATH=/usr/local/sbin/isomux-oom-protect
RESTAMP_UNIT=isomux-oom-restamp
# How long a restarted office can go unprotected. Short, because the window is
# the whole point of the timer; the run itself is a scan of /proc.
RESTAMP_INTERVAL=1min
# What the office server is tiered at, on either install shape.
OFFICE_SCORE=-500
# How long a unit this tool protects waits before restarting. Paired with the
# StartLimitIntervalSec=0 in the same drop-in: with the rate limit gone, a unit
# that cannot start at all would otherwise retry as fast as the machine allows.
RESTART_BACKOFF=5s
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

# --- office memory bounds --------------------------------------------------

# Keep a hosted office inside the box instead of letting its build and agent
# processes consume the operator's last login shell. The 1 GiB reserve is a
# provisional entry-tier value, pending the release-shaped acceptance run. It
# is not sensible on a small self-hosted box: below 4 GiB it would remove too
# much of the RAM that made the office usable before this tool ran, so those
# boxes keep their existing uncapped behavior.
#
# MemorySwapMax stays at 6 GiB even when the box has less swap. In that case the
# global swap supply binds first, so scaling this cgroup value down would only
# make the measured exhaustion cliff arrive sooner.
#
# This is the system-unit shape installed by deploy/install.sh. A user-level
# office needs its own user-manager drop-in and reload; writing one here without
# reloading that manager would be a silent no-op until restart.
configure_office_memory_cap() {
  local mem_total_kib mem_total_mib memory_max_mib memory_high_mib
  mem_total_kib=$(awk '$1 == "MemTotal:" { print $2; exit }' "$MEMINFO_PATH" 2>/dev/null || true)
  if [[ ! $mem_total_kib =~ ^[0-9]+$ ]]; then
    warn "could not read MemTotal from $MEMINFO_PATH, so the office memory cap was not written"
    return 0
  fi
  mem_total_mib=$((mem_total_kib / 1024))
  if ((mem_total_mib < OFFICE_MEMORY_MIN_MIB)); then
    warn "this box has ${mem_total_mib} MiB RAM; leaving the office uncapped because the measured 1 GiB reserve is not suitable below ${OFFICE_MEMORY_MIN_MIB} MiB"
    return 0
  fi
  memory_max_mib=$((mem_total_mib - OFFICE_MEMORY_RESERVE_MIB))
  memory_high_mib=$((memory_max_mib * 85 / 100))

  write_file "$OFFICE_MEMORY_DROPIN" 644 <<EOF
# Written by isomux-oom-protect from this box's RAM at the time the tool ran.
[Service]
MemoryMax=${memory_max_mib}M
MemoryHigh=${memory_high_mib}M
MemorySwapMax=${OFFICE_SWAP_MAX_MIB}M
EOF
  run systemctl daemon-reload
  [[ -n $DRY_RUN ]] && return 0

  local cgroup expected_max expected_high expected_swap actual_max actual_high actual_swap
  cgroup=$(systemctl show isomux.service --property=ControlGroup --value 2>/dev/null || true)
  if [[ -z $cgroup || ! -d $CGROUP_ROOT$cgroup ]]; then
    log "office memory cap written; it will take effect when isomux.service starts"
    return 0
  fi
  expected_max=$((memory_max_mib * 1024 * 1024))
  expected_high=$((memory_high_mib * 1024 * 1024))
  expected_swap=$((OFFICE_SWAP_MAX_MIB * 1024 * 1024))
  actual_max=$(cat "$CGROUP_ROOT$cgroup/memory.max" 2>/dev/null || true)
  actual_high=$(cat "$CGROUP_ROOT$cgroup/memory.high" 2>/dev/null || true)
  actual_swap=$(cat "$CGROUP_ROOT$cgroup/memory.swap.max" 2>/dev/null || true)
  if [[ $actual_max == "$expected_max" && $actual_high == "$expected_high" && $actual_swap == "$expected_swap" ]]; then
    log "office memory cap confirmed in the running cgroup: MemoryMax=${memory_max_mib}M, MemoryHigh=${memory_high_mib}M, MemorySwapMax=${OFFICE_SWAP_MAX_MIB}M"
  else
    warn "office memory cap NOT confirmed in the running cgroup: asked for $expected_max/$expected_high/$expected_swap bytes, kernel reports ${actual_max:-unreadable}/${actual_high:-unreadable}/${actual_swap:-unreadable}"
  fi
}

# --- kill order -------------------------------------------------------------

# Lower score = killed later. A best-effort bias, not a guarantee: the kernel
# combines it with its own "roughly biggest" heuristic.
#
#   -900  ssh, tailscaled                    keep the box reachable
#   -900  resolved, networkd, logind         keep it usable once reached
#   -500  isomux, caddy                      keep the office up
#
# The second row is there because of a measured incident, not a theory. During
# the capacity benchmark a box under global memory pressure had earlyoom kill
# its way down the process table at about four kills a second - apparmor_parser,
# rsyslogd, three agettys, systemd-resolved, systemd-timesyncd, systemd-logind -
# and resolved never came back (see the restart note below). The box then
# answered ssh and every liveness probe for three hours while no process on it
# could resolve a hostname.
#
# Two things made that possible, and both are worth knowing before touching this
# table. earlyoom ranks by the kernel's oom_score, which is (1000 + adj) * 2/3
# for anything small: every idle daemon on the box sits at exactly 666,
# regardless of how little memory it holds. So the ordering among small processes
# is arbitrary, and the gap between a 5 MiB daemon and a 300 MB agent is only
# about 20 points. On top of that, the earlyoom drop-in of the day had `bun` in
# its --avoid list, which took 300 off every agent process and left the system
# daemons as the highest-scoring candidates on the box. That part is already
# fixed above; this table fixes the rest, by putting the daemons that must
# survive far below the 666 floor rather than a nudge below it.
#
# --avoid alone would not do it: it is a 300-point bias applied by earlyoom, and
# it does not exist for the kernel's own killer. A negative score is both.
#
# Two are left alone because Ubuntu 24.04 already ships them below the floor,
# measured on a box: `systemd-journald.service` at -250, and `dbus.service` at
# -900, which is exactly what this table would have written anyway. That says
# nothing about `dbus-broker.service`, a different unit that some distributions
# ship instead; it is not tiered here because no box isomux supports runs it.
#
# What this table does NOT fix, and what actually turned that incident into a
# three-hour outage: a daemon that does get killed may not come back. resolved
# was SIGKILLed five times in two seconds, hit systemd's default start limit of
# five starts per ten seconds, logged "Start request repeated too quickly" and
# stayed failed until someone noticed. Surviving the spike and recovering from
# it are separate problems; this is the first one.
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
  local unit=$1 score=$2 restart=${3:-} restart_line="" restart_note=""
  if [[ -n $restart ]]; then
    printf -v restart_line 'Restart=%s\n' "$restart"
    printf -v restart_note '%s\n' \
      "# The Caddy package ships no Restart= policy, so this drop-in adds" \
      "# Restart=$restart with RestartSec=$RESTART_BACKOFF and no start limit." \
      "# This deliberate crash loop is better than a dark front door."
  fi
  write_file "/etc/systemd/system/$unit.d/isomux-oom.conf" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
# Being killed under memory pressure must not be permanent. systemd gives up
# after 5 starts in 10 seconds and leaves the unit failed, and these daemons
# restart at RestartSec=0 out of the box - measured, systemd-resolved spent all
# five inside two seconds during an earlyoom cascade and then stayed dead for
# three hours while the box went on answering ssh and every liveness probe.
# Retry forever instead, with the backoff below so forever is not a spin.
${restart_note}StartLimitIntervalSec=0

[Service]
OOMScoreAdjust=$score
${restart_line}RestartSec=$RESTART_BACKOFF
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
  # A box that answers ssh but cannot resolve a hostname, configure its network,
  # or start a user service is broken in a way nothing reports. Measured on an
  # Ubuntu 24.04 box, all three of these run at 0 and are killed as readily as
  # anything else. Inert where the unit does not exist, same as tailscaled above.
  oom_tier systemd-resolved.service -900  # DNS. The one that actually went down.
  oom_tier systemd-networkd.service -900  # addresses and routes
  oom_tier systemd-logind.service -900    # ssh sessions, and `systemctl --user`
  oom_tier caddy.service -500 on-failure
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

# Swap is a safety net, not capacity. An office that is swapping is already
# degraded - measured, an entry-tier box swapping under load runs about 12x its
# unloaded turn latency whatever the file size - so none of this buys headroom.
# What the size decides is how the bad case ends.
#
# It used to be 2 GiB here, on the reasoning that a large swap file lets a box
# keep allocating past the point where it can still respond. Measured, that is
# not what happens: at one load, a 2 GiB file used to the last megabyte gave a
# p95 of 30.7 s where 8 GiB under the identical load gave 3.4 s, with 2.2x the
# throughput. The cliff is swap EXHAUSTION, not swap size - a file that runs out
# mid-spike is worse than either a bigger one or none at all. Hence 8 GiB.
# (internal-docs/sizing-tiers-benchmark-results.md, "Swap: decision 4".)
SWAP_HEADROOM_MIB=4096
# What a small disk falls back to: the size every box got before the measurement
# above, so this change can only ever leave a box with more swap than it had.
SWAP_MIN_SIZE_MIB=2048
# How far under the target still counts as "already that size". mkswap spends a
# page on its header and SwapTotal is reported in kB, so an 8192 MiB file comes
# back as 8191 MiB - without this the tool would decide, on every single run,
# that the swap file it made last time is too small and rebuild it.
SWAP_SIZE_SLACK_MIB=64

# How much swap the kernel currently has, in MiB, and where. Read through the
# seam so deploy/oom-protect.test.ts can drive the decisions below against a box
# it invents rather than the one it runs on.
swap_total_mib() { awk '/^SwapTotal:/ { print int($2 / 1024) }' "$PROC_ROOT/meminfo"; }
# Every swap device the kernel has on, one path per line.
swap_devices() { awk 'NR > 1 { print $1 }' "$PROC_ROOT/swaps"; }

# Free space on the filesystem holding the swapfile, in MiB.
swap_fs_avail_mib() { df --output=avail -m "$(dirname "$SWAPFILE")" | tail -1 | tr -d ' '; }

configure_swap() {
  local total_mib
  total_mib=$(swap_total_mib)
  if [[ ${total_mib:-0} -gt 0 ]]; then
    report_existing_swap "$total_mib"
    return 0
  fi
  swap_size_for_disk || return 0
  local size_mib=$SWAP_SIZE_CHOSEN
  if [[ -e $SWAPFILE ]]; then
    warn "$SWAPFILE already exists but is not in use; leaving it alone"
    return 0
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would create a ${size_mib} MiB swap file at $SWAPFILE and add it to /etc/fstab"
    return 0
  fi
  if ! make_swapfile "$size_mib"; then
    warn "could not create $SWAPFILE; continuing without swap"
    return 0
  fi
  grep -qs "^$SWAPFILE " /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAPFILE" >>/etc/fstab
  log "created a ${size_mib} MiB swap file at $SWAPFILE"
}

# Sets SWAP_SIZE_CHOSEN to the biggest swap file this disk can take; non-zero
# when the answer is "none". A global rather than stdout because this function
# also has something to say to the operator, and a $(...) around it would
# capture the explanation as part of the number.
#
# The full size plus its headroom asks for 12 GiB of disk where the old 2 GiB
# default asked for 6, so on a small disk this change would otherwise turn a box
# that used to get swap into one that gets none - the worst of the three
# outcomes. Rather than that, take what fits, down to the size boxes used to get.
SWAP_SIZE_CHOSEN=""
swap_size_for_disk() {
  local avail_mib fits
  avail_mib=$(swap_fs_avail_mib)
  fits=$(((${avail_mib:-0} - SWAP_HEADROOM_MIB) / 1024 * 1024)) # whole GiB
  if [[ $fits -ge $SWAP_SIZE_MIB ]]; then
    SWAP_SIZE_CHOSEN=$SWAP_SIZE_MIB
    return 0
  fi
  if [[ $fits -lt $SWAP_MIN_SIZE_MIB ]]; then
    warn "not creating a swap file: ${avail_mib:-0} MiB free on $(dirname "$SWAPFILE") leaves no room for one once ${SWAP_HEADROOM_MIB} MiB is kept back for the box itself"
    return 1
  fi
  warn "only ${avail_mib} MiB free on $(dirname "$SWAPFILE"): making a ${fits} MiB swap file instead of ${SWAP_SIZE_MIB} MiB. A swap file that runs out mid-spike is the worst case measured, so give this box more disk if you can."
  SWAP_SIZE_CHOSEN=$fits
}

# Allocate, format and enable $SWAPFILE at the given size in MiB. fallocate can
# leave a hole-punched file behind on a filesystem that took the call but cannot
# back it, so a failure removes the file rather than leaving a half-made one for
# the next run to find and skip.
make_swapfile() {
  local size_mib=$1
  if ! fallocate -l "${size_mib}M" "$SWAPFILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$size_mib" status=none || {
      rm -f "$SWAPFILE"
      return 1
    }
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null || { rm -f "$SWAPFILE"; return 1; }
  swapon "$SWAPFILE" || { rm -f "$SWAPFILE"; return 1; }
  return 0
}

# A box installed before the size went up already has swap, so the branch above
# never runs on the boxes that would most benefit from it. This tool does not
# resize it for them, and the reason is worth writing down, because an earlier
# draft did and it was wrong on two counts.
#
# Replacing live swap means `swapoff` first, which reads every swapped-out page
# back into RAM, and then a window where the old file is gone and the new one is
# not yet proven. fallocate, mkswap or swapon failing anywhere in that window
# leaves a running box with no swap at all - a worse state than the small
# swapfile it started with, arrived at unattended, during what is often an
# installer run. Disk and memory prechecks narrow that window; they do not close
# it.
#
# And "only resize the file we made" is not something this tool can actually
# establish. /swapfile is the conventional path on Ubuntu and most cloud images:
# finding swap there says nothing about who put it there or what they expect of
# it. There is no ownership marker to check.
#
# So: existing swap is reported and left exactly as it is, with the command to
# change it if the operator wants to, on their own timing and with the box in a
# state they can see. Anything more needs an ownership marker and a rollback
# that re-enables the old file on every failure path, which is a bigger change
# than the size constant this task is about.
report_existing_swap() {
  local total_mib=$1
  local devices
  devices=$(swap_devices)
  log "swap already set up: ${total_mib} MiB on $(printf '%s' "${devices:-an unreadable device list}" | tr '\n' ' ')"
  if [[ $total_mib -ge $((SWAP_SIZE_MIB - SWAP_SIZE_SLACK_MIB)) ]]; then
    return 0
  fi
  log "  that is under the ${SWAP_SIZE_MIB} MiB this tool makes on a box with no swap, and a swap"
  log "  file that runs out mid-spike is the worst case measured. Resizing swap under a running"
  log "  office is not something to do behind your back, so it is left as it is."
  # The recipe below is only right for a box whose swap is exactly the file this
  # tool would have made. Printing it anyway would tell someone running on a
  # partition or a zram device to swapoff a path that is not their swap, and
  # then to fallocate over whatever happens to be sitting there - the same
  # unfounded assumption about /swapfile that kept the automatic version of this
  # out of the tree, just aimed at the operator instead of the box.
  if [[ $devices != "$SWAPFILE" ]]; then
    log "  How to change that depends on how this box's swap is set up; the devices named above"
    log "  are the ones to look at."
    return 0
  fi
  log "  To do it yourself, on a quiet box:"
  log "    swapoff $SWAPFILE && fallocate -l ${SWAP_SIZE_MIB}M $SWAPFILE &&"
  log "      chmod 600 $SWAPFILE && mkswap $SWAPFILE && swapon $SWAPFILE"
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
  configure_office_memory_cap
  configure_kill_order
  configure_swappiness
  configure_swap
  log ""
  if [[ -n $have_earlyoom ]]; then
    log "Out-of-memory protection is on: when free memory drops under 10%, one"
    log "agent process is killed instead of the whole box becoming unresponsive."
    log "SSH, DNS, networking and the office server are killed last (and Tailscale,"
    log "if this box uses it). Re-kick the agent and carry on."
  else
    log "Kill order and swap settings applied, but earlyoom is not installed, so"
    log "nothing steps in early under memory pressure."
  fi
}

main "$@"
