#!/usr/bin/env bash
# Re-runs the sensitivity and swap phases, which were lost to a silent failure.
#
# What happened: earlyoom's cascade during the unconstrained N=24 arm killed
# systemd-resolved along with everything else it took. The box kept answering
# ssh but could no longer resolve a hostname, so every subsequent cold
# `bun install` failed in under a second against a bun cache that phase 2 had
# deliberately emptied. Those arms then ran with NO build load at all and said
# so only in a cgroup peak ~3 GB lower than it should have been. DNS was down
# for about three hours before anything surfaced it.
#
# Preconditions are now asserted up front, and inner.sh records an explicit
# BUILD-INSTALL-FAILED marker rather than letting a missing build look like a
# quiet result.
set -uo pipefail
BENCH_DIR=/home/ubuntu/bench
cd "$BENCH_DIR" || exit 1
DUR=300

swap_mib=$(awk '/^SwapTotal/{print int($2/1024)}' /proc/meminfo)
[ "${swap_mib:-0}" -ge 2000 ] || { echo "FATAL: swap is ${swap_mib} MiB, expected the shipped 2 GiB"; exit 1; }
timeout 20 curl -sSf -o /dev/null https://registry.npmjs.org/ || { echo "FATAL: no npm registry reachable; the build load would silently not run"; exit 1; }
[ -d "$BENCH_DIR/isomux/node_modules" ] || { echo "FATAL: no node_modules to reinstall over"; exit 1; }
echo "$(date -Is) preconditions ok: ${swap_mib} MiB swap, registry reachable, node_modules present"

echo "############ $(date -Is) PHASE 6 (rerun 2): sensitivity, with a real build"
bash run-sensitivity.sh 18 1 "$DUR"

echo "############ $(date -Is) PHASE 7 (rerun 2): swap arm (decision 4), with a real build"
bash run-swap-arm.sh 1 "$DUR" 20 24

echo "############ $(date -Is) CHAIN4 COMPLETE"
