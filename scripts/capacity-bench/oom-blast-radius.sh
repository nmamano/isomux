#!/usr/bin/env bash
# Tests what a MemoryMax breach actually DOES to a service shaped like the
# office, which internal-docs/sizing-tiers-design.md calls "a desired and
# testable outcome, not kernel semantics" and leaves open in sequencing item 2.
#
# A throwaway system unit stands in for isomux.service - same Restart=always,
# same OOMPolicy=stop, same User= - running a parent "server" that spawns two
# "agent" children. One child then grows until the cgroup hits its fence.
#
# The fixture is deliberately rigged so size alone would pick the WRONG victim:
# the parent holds more than either child at the moment the fence trips. That is
# what makes it discriminating. If the kernel takes the parent, the incident's
# blast radius is reproduced; if the oom_score_adj stamp flips the victim to a
# child, the fix shipped as task 37b194be does what it claims.
#
# Variants:
#   v1-nostamp    MemoryOOMGroup=0, descendants share the parent's score (the
#                 pre-37b194be world)
#   v2-stamp      MemoryOOMGroup=0, children raised to 300, matching
#                 AGENT_OOM_SCORE_ADJ in server/oom-stamp.ts
#   v3-oomgroup   MemoryOOMGroup=1, the cgroup killed atomically
#
#   usage: oom-blast-radius.sh [out-dir]
set -uo pipefail

OUT=${1:-/home/ubuntu/bench/results/oom-blast-radius}
UNIT=bench-victim
MEM_MAX=800M
PARENT_MB=400
CHILD_MB=150
AGENT_OOM_SCORE_ADJ=300

mkdir -p "$OUT"
PAYLOAD=/home/ubuntu/bench/victim-payload.sh

cat >"$PAYLOAD" <<'PAYLOAD_EOF'
#!/usr/bin/env bash
# $1 role, $2 mb, $3 stamp-score ("" = leave alone)
role=$1; mb=$2; stamp=${3:-}
[ -n "$stamp" ] && echo "$stamp" >/proc/self/oom_score_adj 2>/dev/null
adj=$(cat /proc/self/oom_score_adj)
echo "$(date +%s) $role pid=$$ mb=$mb oom_score_adj=$adj"
# Anonymous, touched, and held - a reclaim-proof charge on the cgroup.
python3 - "$mb" <<'PY' &
import sys, time
mb = int(sys.argv[1])
buf = bytearray(mb * 1024 * 1024)
for i in range(0, len(buf), 4096):
    buf[i] = 1
while True:
    time.sleep(1)
PY
wait
PAYLOAD_EOF
chmod +x "$PAYLOAD"

cat >/home/ubuntu/bench/victim-server.sh <<'SERVER_EOF'
#!/usr/bin/env bash
# Stands in for the office server: holds the largest single allocation, then
# spawns its "agents" as children so they inherit its oom_score_adj exactly the
# way the real server's descendants do.
PARENT_MB=$1; CHILD_MB=$2; STAMP=${3:-}
echo "$(date +%s) server pid=$$ oom_score_adj=$(cat /proc/self/oom_score_adj)"
python3 - "$PARENT_MB" <<'PY' &
import sys, time
mb = int(sys.argv[1])
buf = bytearray(mb * 1024 * 1024)
for i in range(0, len(buf), 4096):
    buf[i] = 1
while True:
    time.sleep(1)
PY
sleep 4
bash /home/ubuntu/bench/victim-payload.sh agent-a "$CHILD_MB" "$STAMP" &
sleep 3
# The runaway. It grows in steps so the fence trips while it is still smaller
# than the server, which is the whole point of the fixture.
bash -c '
  [ -n "'"$STAMP"'" ] && echo "'"$STAMP"'" >/proc/self/oom_score_adj 2>/dev/null
  echo "$(date +%s) agent-runaway pid=$$ oom_score_adj=$(cat /proc/self/oom_score_adj)"
  python3 -c "
import time
chunks = []
while True:
    b = bytearray(25 * 1024 * 1024)
    for i in range(0, len(b), 4096):
        b[i] = 1
    chunks.append(b)
    print(len(chunks) * 25, flush=True)
    time.sleep(0.7)
"' &
wait
SERVER_EOF
chmod +x /home/ubuntu/bench/victim-server.sh

# oom.group is NOT a systemd directive. The first run of this test wrote
# MemoryOOMGroup=1 into the unit; systemd does not know that name, ignored the
# line, and the kernel kept memory.oom.group=0 - so the "kill the cgroup
# atomically" variant silently tested the same thing as the default. It is a
# cgroup file, and root writes it directly after the unit starts.
# OOMPolicy= is the separate, systemd-side mechanism and is varied on its own.
run_variant() { # run_variant <name> <oom-group 0|1> <stamp-or-empty> <oom-policy> [mainpid]
  local name=$1 oomgroup=$2 stamp=$3 policy=${4:-stop} mainpid=${5:-0}
  local exec_line="/bin/bash /home/ubuntu/bench/victim-server.sh $PARENT_MB $CHILD_MB $stamp"
  # mainpid=1 puts the server's allocation in the unit's OWN MainPID, which is
  # the shape of isomux.service. With the bash wrapper the MainPID holds
  # nothing, so a kill can never land on it and the server-victim case cannot be
  # observed at all.
  [ "$mainpid" = 1 ] && exec_line="/usr/bin/python3 /home/ubuntu/bench/victim-main.py $PARENT_MB $CHILD_MB $stamp"
  echo "=== $(date -Is) $name (oom.group=$oomgroup stamp='${stamp:-none}' OOMPolicy=$policy mainpid=$mainpid)"
  sudo systemctl stop "$UNIT.service" 2>/dev/null
  sudo systemctl reset-failed "$UNIT.service" 2>/dev/null

  sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNIT_EOF
[Unit]
Description=Sacrificial stand-in for isomux.service (capacity benchmark)
[Service]
User=ubuntu
Restart=always
RestartSec=2
OOMPolicy=$policy
MemoryAccounting=yes
MemoryMax=$MEM_MAX
# MemorySwapMax=0 is what makes the fence a fence. The first run of this test
# set MemoryMax alone and recorded 4354 "max" events with ZERO kills: the cgroup
# hit its limit over and over and resolved each hit by reclaiming into swap,
# sailing past an 800 MiB cap to 1800 MiB of allocation. That is the design
# doc's own warning about MemorySwapMax, reproduced by accident - and it means
# the blast radius cannot be observed at all until swap is closed off.
MemorySwapMax=0
ExecStart=$exec_line
UNIT_EOF
  sudo systemctl daemon-reload
  local t0 dmesg0
  t0=$(date +%s)
  # Mark the current end of the kernel log. `dmesg -T` timestamps are not epoch,
  # so an awk time filter on them silently matches nothing - the first version of
  # this script passed `-v since=` and never referenced it, so every variant's
  # file contained every earlier variant's kills. Counting lines is exact.
  dmesg0=$(sudo dmesg 2>/dev/null | wc -l)
  sudo systemctl start "$UNIT.service"

  local cg=/sys/fs/cgroup/system.slice/$UNIT.service
  sudo sh -c "echo $oomgroup > $cg/memory.oom.group" 2>/dev/null

  # Config is read back NOW, while this cgroup is certainly the one that was
  # configured. Reading it at the end instead would sample a cgroup systemd may
  # have torn down and recreated on restart, which is how the first run reported
  # a setting that had never applied.
  local applied
  applied=$(
    echo "--- kernel readback at start"
    for f in memory.max memory.swap.max memory.oom.group; do
      printf '%s=%s\n' "$f" "$(cat "$cg/$f" 2>/dev/null)"
    done
    # MainPID at start, so a later "who died" line can be matched by PID
    # equality instead of inferred from the victim's size. v6/v7 identified the
    # victim by its unique footprint, which was sound but not self-proving.
    systemctl show "$UNIT.service" -p MainPID -p OOMPolicy -p Restart -p MemoryMax -p MemorySwapMax
  )
  for _ in $(seq 1 60); do
    [ "$(cat "$cg/memory.events.local" 2>/dev/null | awk '/^oom_kill/{print $2}')" != "0" ] && break
    [ -d "$cg" ] || break
    sleep 1
  done
  sleep 5

  {
    echo "### $name  oom.group=$oomgroup stamp=${stamp:-none} OOMPolicy=$policy MemoryMax=$MEM_MAX MemorySwapMax=0"
    echo "$applied"
    echo "--- NRestarts (the blast-radius question: did the whole unit recycle?)"
    systemctl show "$UNIT.service" -p NRestarts
    echo "--- memory.events.local"; cat "$cg/memory.events.local" 2>/dev/null
    echo "--- unit state"; systemctl is-active "$UNIT.service"; systemctl show "$UNIT.service" -p ActiveEnterTimestamp -p ExecMainStatus
    echo "--- who died (kernel), THIS variant only"
    sudo dmesg -T 2>/dev/null | tail -n +$((dmesg0 + 1)) |
      grep -E 'Memory cgroup out of memory|oom-kill|Killed process' | tail -20
    echo "--- unit journal"
    sudo journalctl -u "$UNIT.service" --since "@$t0" --no-pager 2>/dev/null | tail -40
  } >"$OUT/$name.txt" 2>&1

  sudo systemctl stop "$UNIT.service" 2>/dev/null
  sudo systemctl reset-failed "$UNIT.service" 2>/dev/null
  echo "  -> $OUT/$name.txt"
}

want() { [ -z "${BENCH_VARIANTS:-}" ] && return 0; case " $BENCH_VARIANTS " in *" $1 "*) return 0;; *) return 1;; esac; }

want v1-nostamp && run_variant v1-nostamp 0 "" stop
want v2-stamp && run_variant v2-stamp 0 "$AGENT_OOM_SCORE_ADJ" stop
want v3-oomgroup && run_variant v3-oomgroup 1 "" stop
want v4-oompolicy-kill && run_variant v4-oompolicy-kill 0 "$AGENT_OOM_SCORE_ADJ" kill
# The variant that decides whether a one-agent blast radius is reachable at all.
# v1-v4 all recycled the whole unit even when only a stamped child was killed,
# because OOMPolicy=stop stops the unit if ANY process in it is OOM-killed and
# Restart=always then brings it back. continue is the only policy that leaves
# the rest of the unit running.
want v5-oompolicy-continue && run_variant v5-oompolicy-continue 0 "$AGENT_OOM_SCORE_ADJ" continue

# v6/v7 put the server's memory in the unit's own MainPID, which v1-v5 could not
# do. Together they separate the two halves of the fix: the stamp decides WHO
# the kernel picks, and OOMPolicy decides whether the unit survives that pick.
# v6 is the case where OOMPolicy=continue is not enough on its own.
want v6-mainpid-nostamp && run_variant v6-mainpid-nostamp 0 "" continue 1
want v7-mainpid-stamp && run_variant v7-mainpid-stamp 0 "$AGENT_OOM_SCORE_ADJ" continue 1

sudo rm -f "/etc/systemd/system/$UNIT.service"
sudo systemctl daemon-reload
echo "=== $(date -Is) blast-radius test done; sacrificial unit removed"
