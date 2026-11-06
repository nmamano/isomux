#!/usr/bin/env bash
# Tier A levels, as root on the office VM with the isomux service stopped.
# Runs tier-a-server.ts from /opt/lt-src (a copy of the installed checkout,
# with dev dependencies) pinned to CPUs 0-3, and the generator on CPUs 4-7.
# Each line of the levels file is NAME AGENTS=<n> LT_...=...; a level with
# A/<name>/gen-0.json is skipped.
# usage: levels-a.sh <levels file>
LEVELS=$(realpath "$1")
SRC=/opt/lt-src
cd /root/lt || exit 1
ulimit -n 65536
mkdir -p A tmp
while read -r name rest; do
  if [ -z "$name" ] || [ "${name#\#}" != "$name" ]; then continue; fi
  [ -f "A/$name/gen-0.json" ] && continue
  D=/root/lt/A/$name
  mkdir -p "$D"
  AG=$(echo "$rest" | grep -o 'AGENTS=[0-9]*' | cut -d= -f2)
  echo "$(date -u +%FT%TZ) start $name $rest" >> A/levels.log
  (cd $SRC && LT_DIR=$D LT_AGENTS=$AG LT_MEMBERS=1 TMPDIR=/root/lt/tmp taskset -c 0-3 \
    bun test ./scripts/load-test/tier-a-server.ts > "$D/server.log" 2>&1) &
  for _ in $(seq 1 300); do [ -f "$D/server.json" ] && break; sleep 1; done
  c0=$(head -1 /proc/stat)
  # shellcheck disable=SC2086
  env LT_DIR="$D" LT_RUN="$name" $rest taskset -c 4-7 bun run $SRC/scripts/load-test/gen.ts > "$D/gen-0.log" 2>&1
  c1=$(head -1 /proc/stat)
  touch "$D/stop"
  wait
  python3 -I -c "
a = list(map(int, '$c0'.split()[1:])); b = list(map(int, '$c1'.split()[1:]))
d = [y - x for x, y in zip(a, b)]; print('box_cpu_busy', round(1 - (d[3] + d[4]) / sum(d), 3))" > "$D/boxcpu.txt"
  echo "$(date -u +%FT%TZ) end $name" >> A/levels.log
  sleep 10
done < "$LEVELS"
