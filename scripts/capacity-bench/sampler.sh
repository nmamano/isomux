#!/usr/bin/env bash
# Samples one cgroup and the box around it, once every INTERVAL seconds, as CSV
# on stdout. Companion to agentsim.ts; see internal-docs/sizing-tiers-design.md.
#
# Counters that are cumulative in the kernel (memory.events.local, PSI totals,
# CPU steal) are emitted as deltas since the previous sample, per the doc's
# "snapshot deltas rather than reading the cumulative counters raw". Gauges
# (memory.current, pressure avg10, loadavg) are emitted as read.
set -uo pipefail

CG=${1:?usage: sampler.sh <cgroup-path> [interval-seconds]}
INTERVAL=${2:-2}

field() { awk -v k="$2" '$1==k{print $2; found=1} END{if(!found) print -1}' "$1" 2>/dev/null || echo -1; }
readnum() { cat "$1" 2>/dev/null || echo -1; }
psi() { # psi <file> <some|full> <avg10|total>
  awk -v line="$2" -v key="$3" '$1==line{for(i=2;i<=NF;i++){split($i,p,"=");if(p[1]==key){print p[2];f=1}}} END{if(!f) print -1}' "$1" 2>/dev/null || echo -1
}

echo "ts,mem_current,mem_peak,mem_swap_current,anon,file,swapcached,shmem,slab,ev_low,ev_high,ev_max,ev_oom,ev_oom_kill,psi_mem_some_avg10,psi_mem_full_avg10,d_psi_mem_some_us,d_psi_mem_full_us,psi_cpu_some_avg10,psi_io_full_avg10,d_psi_io_full_us,load1,d_steal_jiffies,mem_available_kb,swap_free_kb,procs_running,d_pswpin,d_pswpout,d_pgmajfault,d_cpu_throttled_us,cpu_nr_throttled,host_psi_mem_some_avg10,host_psi_mem_full_avg10,host_psi_io_full_avg10,host_psi_cpu_some_avg10,nonbench_mem_mb,sys_slice_kb,user_slice_kb,mem_free_kb,cached_kb,sreclaimable_kb,sunreclaim_kb"

prev_low=0 prev_high=0 prev_max=0 prev_oom=0 prev_oomkill=0
prev_some=0 prev_full=0 prev_iofull=0 prev_steal=0 first=1
prev_swpin=0 prev_swpout=0 prev_majflt=0 prev_throttled=0
MEMTOTAL_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)

while :; do
  ts=$(date +%s)
  cur=$(readnum "$CG/memory.current")
  peak=$(readnum "$CG/memory.peak")
  swapcur=$(readnum "$CG/memory.swap.current")
  anon=$(field "$CG/memory.stat" anon)
  filec=$(field "$CG/memory.stat" file)
  swapcached=$(field "$CG/memory.stat" swapcached)
  shmem=$(field "$CG/memory.stat" shmem)
  slab=$(field "$CG/memory.stat" slab)

  low=$(field "$CG/memory.events.local" low)
  high=$(field "$CG/memory.events.local" high)
  maxe=$(field "$CG/memory.events.local" max)
  oom=$(field "$CG/memory.events.local" oom)
  oomkill=$(field "$CG/memory.events.local" oom_kill)

  msome=$(psi "$CG/memory.pressure" some avg10)
  mfull=$(psi "$CG/memory.pressure" full avg10)
  msome_t=$(psi "$CG/memory.pressure" some total)
  mfull_t=$(psi "$CG/memory.pressure" full total)
  csome=$(psi "$CG/cpu.pressure" some avg10)
  iofull=$(psi "$CG/io.pressure" full avg10)
  iofull_t=$(psi "$CG/io.pressure" full total)

  # Swap traffic, not swap residency: memory.stat swapcached says how much is
  # cached, never how hard the box is paging. pswpin/pswpout is the arm's signal.
  swpin=$(awk '/^pswpin /{print $2}' /proc/vmstat)
  swpout=$(awk '/^pswpout /{print $2}' /proc/vmstat)
  majflt=$(awk '/^pgmajfault /{print $2}' /proc/vmstat)
  throttled=$(field "$CG/cpu.stat" throttled_usec)
  nr_throttled=$(field "$CG/cpu.stat" nr_throttled)

  hmsome=$(psi /proc/pressure/memory some avg10)
  hmfull=$(psi /proc/pressure/memory full avg10)
  hiofull=$(psi /proc/pressure/io full avg10)
  hcsome=$(psi /proc/pressure/cpu some avg10)

  load1=$(awk '{print $1}' /proc/loadavg)
  procs_running=$(awk '{print $4}' /proc/loadavg)
  steal=$(awk '/^cpu /{print $9}' /proc/stat)
  memavail=$(field /proc/meminfo MemAvailable:)
  swapfree=$(field /proc/meminfo SwapFree:)

  if [ "$first" = 1 ]; then
    d_low=0 d_high=0 d_max=0 d_oom=0 d_oomkill=0 d_some=0 d_full=0 d_iofull=0 d_steal=0
    d_swpin=0 d_swpout=0 d_majflt=0 d_throttled=0
    first=0
  else
    d_low=$((low - prev_low)) d_high=$((high - prev_high)) d_max=$((maxe - prev_max))
    d_oom=$((oom - prev_oom)) d_oomkill=$((oomkill - prev_oomkill))
    d_some=$((msome_t - prev_some)) d_full=$((mfull_t - prev_full)) d_iofull=$((iofull_t - prev_iofull))
    d_steal=$((steal - prev_steal))
    d_swpin=$((swpin - prev_swpin)) d_swpout=$((swpout - prev_swpout))
    d_majflt=$((majflt - prev_majflt)) d_throttled=$((throttled - prev_throttled))
  fi
  prev_low=$low prev_high=$high prev_max=$maxe prev_oom=$oom prev_oomkill=$oomkill
  prev_some=$msome_t prev_full=$mfull_t prev_iofull=$iofull_t prev_steal=$steal
  prev_swpin=$swpin prev_swpout=$swpout prev_majflt=$majflt prev_throttled=$throttled

  # Everything on the box that is not the benchmark cgroup - what the 1 GiB
  # reserve is supposed to protect.
  #
  # WARNING, and the reason the columns beside it exist: this figure mixes
  # incompatible quantities. MemAvailable is an ESTIMATE of allocatable memory
  # that already counts reclaimable page cache, while memory.current is a charge
  # that also includes the cgroup's own reclaimable cache - so subtracting one
  # from the other can double-discount cache. Treat nonbench_mem_mb as a rough
  # sanity signal only. The sibling-cgroup charges and the raw meminfo fields
  # after it are the inputs a defensible decomposition needs.
  nonbench=$(( (MEMTOTAL_KB - memavail) / 1024 - cur / 1048576 ))
  sysslice=$(readnum /sys/fs/cgroup/system.slice/memory.current)
  userslice=$(readnum /sys/fs/cgroup/user.slice/memory.current)
  memfree=$(field /proc/meminfo MemFree:)
  cached=$(field /proc/meminfo Cached:)
  sreclaim=$(field /proc/meminfo SReclaimable:)
  sunreclaim=$(field /proc/meminfo SUnreclaim:)

  echo "$ts,$cur,$peak,$swapcur,$anon,$filec,$swapcached,$shmem,$slab,$d_low,$d_high,$d_max,$d_oom,$d_oomkill,$msome,$mfull,$d_some,$d_full,$csome,$iofull,$d_iofull,$load1,$d_steal,$memavail,$swapfree,$procs_running,$d_swpin,$d_swpout,$d_majflt,$d_throttled,$nr_throttled,$hmsome,$hmfull,$hiofull,$hcsome,$nonbench,$((sysslice/1024)),$((userslice/1024)),$memfree,$cached,$sreclaim,$sunreclaim"
  sleep "$INTERVAL"
done
