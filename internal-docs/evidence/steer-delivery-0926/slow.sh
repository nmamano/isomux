#!/usr/bin/env bash
# Simulated long job: writes one line per step to progress.txt.
for i in $(seq 1 ${1:-12}); do echo "step $i $(date +%T)" >> progress.txt; sleep 5; done
echo "DONE" >> progress.txt
