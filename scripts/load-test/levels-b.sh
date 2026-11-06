#!/usr/bin/env bash
# Tier B levels, on the generator as ubuntu. Each line of the levels file is
# NAME VAR=val ...; SHARDS=<n> splits the sockets over n generator processes.
# A level with B/<name>/gen-0.json is skipped, so a rerun resumes.
# usage: levels-b.sh <levels file>
LEVELS=$(realpath "$1")
GEN=$HOME/isomux/scripts/load-test/gen.ts
cd ~/lt || exit 1
ulimit -n 65536
HOST=$(python3 -I -c "import json; print(json.load(open('B/server.json'))['origin'].split('//')[1])")
while read -r name rest; do
  if [ -z "$name" ] || [ "${name#\#}" != "$name" ]; then continue; fi
  [ -f "B/$name/gen-0.json" ] && continue
  mkdir -p "B/$name"
  echo "$(date -u +%FT%TZ) start $name $rest" >> B/levels.log
  SH=$(echo "$rest" | grep -o 'SHARDS=[0-9]*' | cut -d= -f2)
  for s in $(seq 0 $((${SH:-1} - 1))); do
    # shellcheck disable=SC2086
    env LT_DIR=B LT_OUT="B/$name" LT_RUN="$name" LT_HOST="$HOST" LT_SCHEME=https LT_SHARD="$s" $rest \
      bun run "$GEN" > "B/$name/gen-$s.log" 2>&1 &
  done
  c0=$(head -1 /proc/stat)
  wait
  c1=$(head -1 /proc/stat)
  python3 -I -c "
a = list(map(int, '$c0'.split()[1:])); b = list(map(int, '$c1'.split()[1:]))
d = [y - x for x, y in zip(a, b)]; print('gen_cpu_busy', round(1 - (d[3] + d[4]) / sum(d), 3))" > "B/$name/gencpu.txt"
  echo "$(date -u +%FT%TZ) end $name" >> B/levels.log
  sleep 20
done < "$LEVELS"
