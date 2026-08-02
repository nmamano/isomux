# Capacity benchmark: results

Evidence for `sizing-tiers-design.md`, which specifies this benchmark under
"The benchmark that would make them real" and leaves decision 4 (hosted swap
sizing) waiting on its swap arm. Task 6ce6b700.

Read the design doc first: this note is the measurement, not the argument.

## What this is, and what it is not

This is a **resource-envelope and sensitivity benchmark**, not a
representative-turn capacity measurement. The distinction is load-bearing and
the numbers below should not be quoted without it.

The spec asks for "N simultaneous representative turns". Real turns need model
API credentials on the box under test, and no key of Nil's was put there. The
load is therefore synthetic: it reproduces the *resource* profile of an agent
process, not its behaviour. That is sufficient for every question in scope,
because each of them - the build-spike reserve, the PSI watermark, whether RAM
or CPU binds first, whether swap is a usability problem - is a question about a
resource profile. It is **not** sufficient to turn N into the tier table's
"~12 active agents" as an empirical fact. What it gives instead is a capacity
*function* of measured per-agent memory at a stated CPU duty and working-set
heat, which the sensitivity arms bound.

## Box under test

Contabo V153, the entry-tier candidate. `169.58.97.2`, cancelled but paid
through 2026-08-29, idle otherwise. Deliberately **not** `169.58.96.127`, which
was running the week-long steal monitor due 2026-08-02.

| | |
| --- | --- |
| CPU / RAM | 4 vCPU, `MemTotal` 8131784 kB = **7941 MiB** |
| Disk | 96 GB, ~88 GB free |
| OS / kernel | Ubuntu 24.04.4, 6.8.0-136-generic |
| Swap | 2 GiB `/swapfile`, `vm.swappiness=10` (the shipped default) |
| Isomux | installed as a **system** unit at `/opt/isomux`, `User=isomux` |
| KSM | `run=0` - no page dedup, so the fixture is not silently compacted |
| zswap | `enabled=N` - swap really goes to disk, which the swap arm depends on |

## Limits under test

The design computes `MemoryMax = RAM - RESERVE` with `RESERVE = 1024 MB`, and
`MemoryHigh = MemoryMax - 15%`. Stated exactly, because the rounding matters at
the cliff:

```
MemoryMax  = 7941 MiB - 1024 MiB = 6917 MiB
MemoryHigh = 6917 MiB - 15% of MemoryMax = 5879 MiB
```

The doc's `MemoryMax - 15%` is ambiguous about what the 15% is of; this reads it
as 15% of `MemoryMax`, and that reading is what was tested.

A casual `MemoryMax=7G` is 7168 MiB and quietly returns 251 MiB of the reserve
to the office. The coarse sweep was run before this was caught and carries the
7168 MiB cap; every later arm uses 6917 MiB. Each table below states its cap.

## The synthetic agent, and how it was calibrated

`scripts/capacity-bench/agentsim.ts`. One process per simulated agent, holding
its "context" in `Buffer`s - real anonymous memory, a genuine swap candidate,
and stable under the GC so a change in RSS means something. Each turn it walks a
random slice of that context (one read and one write per 4 KiB page, which is
what makes a reclaimed or swapped page cost something), burns a fixed slice of
CPU, and sleeps for a jittered interval standing in for API wait.

Calibration is not from the design doc's figures but from **live agents on the
office box, sampled after the SDK bump** (task c641fff6, done; 0.3.219
installed), via `smaps_rollup`. The design sequences this benchmark after that
bump precisely because per-agent memory might move, so the fixture is sized
against post-bump reality rather than the pre-bump numbers in the tier table:

| Live process | n | RSS MB | PSS MB | anon MB | CPU duty over lifetime |
| --- | --- | --- | --- | --- | --- |
| `claude` | 8 | 314-421 (mean 358) | 213-318 | 199-301 (mean 241) | 1.90-6.11% (mean 4.3%) |
| `codex` | 4 | 136-158 | 65-83 | 41-57 | 0.50-2.55% |

The fixture is set at 280 MB of context, which measures **327 MB RSS**, and a
200 ms burn against a ~3.2 s period, which is a **6.25% duty**. Both sit at the
high end of the live distribution, which is the direction to err in.

One asymmetry to keep in view: a real `claude` is 358 MB RSS but only 241 MB
anon, and `PSS 257 < RSS 358` means much of the remainder is *shared*
file-backed mapping. The fixture is heavier in anon and lighter in file-backed
than the real thing - conservative on the axis that drives OOM and swap,
optimistic on page cache.

`TOUCH_FRACTION` (how much context is walked per turn) and `CPU_MS` are the two
parameters with no measurement behind them. They are swept as independent axes
rather than asserted; see the sensitivity section.

## Harness and topology

All load runs in a single transient systemd scope
(`isomux-bench.scope`, `--slice=system.slice`) carrying the limits above. Every
agent and the entire build tree are plain child **processes** of that one
cgroup, so the topology is flat: verified that the scope cgroup has zero
subdirectories and that `memory.events` and `memory.events.local` are identical
field for field. Both are recorded anyway.

What the flat scope buys: the kernel mechanics under test - `MemoryHigh`
throttling, the `MemoryMax` fence, the cgroup's own OOM killer, PSI - are the
same ones a hosted office meets.

What it cannot do, stated rather than papered over:

- It cannot reproduce *hierarchical* `MemoryHigh` throttling between a server
  parent and agent children, because there is no child cgroup.
- It cannot exercise service-only systemd semantics: `OOMPolicy`, `Restart`,
  `MemoryOOMGroup` are unit properties a scope does not carry the same way. That
  question is answered separately by the sacrificial-service test below, which
  is behaviour rather than a config readback.

Every limit is **read back from the kernel** after being set, per the design's
own principle of asserting the effective value rather than the written config.

Reachability is probed from **off the box** (`probe-external.sh`, run from the
office box) as connect-and-run-a-command, not a TCP banner: a box that accepts
connections but cannot fork a shell has still failed the customer. A loopback
probe was kept only as a fallback series, since it shares the page cache and run
queue it is supposed to be judging.

## Two boundaries, never collapsed

"What N breaks the box" is reported as two separate thresholds, because they
have different consequences and land at different N:

- **Hard failure**: any `memory.events.local` `oom_kill`, an agent or the
  service dying, an external probe failure, or an unrecovered unit failure.
- **Usability boundary**: p95 active-phase latency and throughput against the
  *same N* running unconstrained, plus PSI. The per-N unconstrained baseline is
  what separates memory damage from ordinary CPU contention; without it, "slower
  at N=16" cannot be attributed to the memory limits at all.

Per-turn latency is **active-phase only** - the timer starts after the idle
sleep - so it measures touch plus burn, not the wait. Throughput and period
drift are reported alongside it, because a loop that falls behind its own period
can still show a healthy per-turn latency.

## Arm 0: the build spike alone

The one number the design says "moves every row" of the tier table, and which it
carries as a 3 GB estimate with the note "not yet measured precisely".

Cycle is `bun install` + `bun run build:ui` + the full suite (1900 tests across
122 files), with `node_modules` removed first so the install actually allocates.
No agents.

| Variant | sampling | cgroup `memory.peak` | anon at peak | file at peak | gap to peak |
| --- | --- | --- | --- | --- | --- |
| cold `node_modules`, warm bun cache | 2 s | **3028 MB** | ~1531 MB | ~1394 MB | 8 MB |
| cold `node_modules`, cold bun cache | 0.2 s | **2992 MB** | ~1691 MB | ~1209 MB | 8 MB |

**The 3 GB estimate was right.** Three independent arms put the spike at
2992-3028 MB, and it reproduces to within 1% when agents are running alongside
(see the concurrent sweep: peak minus N x 289 MB gives 3024 MB at N=4 and
2994 MB at N=8).

The composition is quoted as approximate on purpose. `memory.peak` is an
instantaneous kernel maximum while anon and file come from sampled
`memory.stat` reads, so the two are not one atomic snapshot; the "gap to peak"
column is the distance between `memory.peak` and the `memory.current` of the
nearest sample, and is the error bar on the split. At 0.2 s sampling it is 8 MB.

**Do not read the ~1.5 GB anon figure as a smaller reserve, and do not
mechanically substitute it for the ~3 GB either.** An isolated build requires
~3 GB of total charge, and that is the answer to "how much memory does a build
need". The file-backed part is reclaimable but neither free nor necessarily
promptly reclaimable - those are `node_modules` pages the test suite reads back,
and evicting them turns memory pressure into IO stalls that land on the agents.

How much of it actually overlaps with agents is a question only the concurrent
sweep can answer, and it answers it empirically rather than by accounting: on
this fixture the usability boundary fits ~1.5-1.7 GB of build anon, with cache
reclaim cheap at N=14 but no longer cheap from N=16. That fit is what the
capacity function below uses, and its caveats live there.

Timing, which reframes what "build load" even means here: the entire spike is
`bun install` (25-46 s). `build:ui` is 0.6 s, and the 1900-test suite runs 75 s
at ~200 MB. An office whose agents mostly run tests rather than installs has a
far smaller footprint than this reserve implies.

One arm (`arm0-build-cold-fast`) lost its final cgroup snapshot entirely and is
excluded: `inner.sh` exited while `run-arm.sh` was still 15 s from sampling, and
systemd tore the scope down in between. Fixed by holding the scope open past the
snapshot; noted here because the empty file is in the artifact.

## Per-agent cost, measured

Across the agents-only sweep the cgroup charge is almost perfectly linear:

| N | 4 | 8 | 12 | 16 | 20 |
| --- | --- | --- | --- | --- | --- |
| `memory.peak` MB | 1159 | 2317 | 3474 | 4631 | 5785 |
| MB per agent | 290 | 290 | 289 | 289 | 289 |

**289 MB per agent** is the number tier arithmetic should use - not the 327 MB
RSS the same process reports. RSS double-counts shared file-backed mappings that
the cgroup charges once, and the gap widens with agent count.

## The two boundaries

Reported against the *same N running unconstrained*, which is what separates
memory damage from ordinary CPU contention. Cap 6917 / 5879 MiB.

**Agents only:**

| N | p95 constrained | p95 unconstrained | ratio | swap used | PSI full | oom_kill |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 276 ms | - | - | 0 | 0 | 0 |
| 21 | 429 | 292 | 1.5x | 1048 MB | 10.9 | 0 |
| 22 | 827 | 300 | 2.8x | 1136 MB | 12.1 | 0 |
| 23 | 1337 | 330 | 4.1x | 1135 MB | 19.3 | 0 |
| 24 | 1855 | n/a | ~5.6x | 1242 MB | 21.9 | 0 |

**Agents plus a concurrent cold build** (two repeats per N):

| N | p95 constrained | p95 unconstrained | ratio | swap used | PSI full | oom_kill |
| --- | --- | --- | --- | --- | --- | --- |
| 14 | 283 / 283 ms | 289 | **1.0x** | 0 | 1.8 | 0 |
| 16 | 461 / 369 | 282 | 1.5-1.6x | 1170-1355 MB | 11-18 | 0 |
| 18 | 704 / 576 | 346 | 1.7-2.0x | 1640-1798 MB | 12-19 | 0 |
| 20 | 945 / 1024 | 291 | 3.3-3.5x | 1743-1838 MB | 22-28 | 0 |

The unconstrained column is flat - 282-346 ms with a build, 292-330 ms without -
across every N tested. **CPU is not what binds.** All of the degradation is
attributable to the memory limits, which is a claim that cannot be made without
the per-N baseline.

Two readings, depending on where the line is drawn. At "p95 no worse than 2x the
same load unconstrained": **~18 agents with a build, ~22 without**. At 1.5x:
**~15 with a build, ~21 without**.

Either way the design's estimate of ~12 active agents alongside a build is
**conservative**, not optimistic: 14 agents run at parity with an unlimited box.

**Throttling is not the boundary.** At N=14 with a build the cgroup pins at
5880 MB - exactly its `MemoryHigh` - and absorbs 2348 `high` events at no
measurable cost. What hurts is not crossing `MemoryHigh`, it is running out of
cheap pages to reclaim: latency tracks swap traffic, not throttle count. This
matters for decision 2, because it means a PSI watermark can be set well above
the first sign of throttling.

## No constrained capacity arm reached cgroup OOM

Scoped deliberately: the excluded unconstrained arm *did* produce kills, by
earlyoom at the host level, and the sacrificial-unit arms OOM-killed processes on
purpose. The claim here is about the constrained capacity arms only.

Across every one of them - twelve coarse, twenty refined, N up to 24 with and
without a build - `oom_kill` is **0**. `memory.events.local` `max` is 0 too: the
cgroup never reached `MemoryMax` at all, because `MemoryHigh` plus swap absorbed
everything first.

That reframes the design's premise. The doc anticipates that a customer who
starts a second build "loses a process to the OOM killer, ideally an agent". In
practice, with these limits, **the office does not lose a process - it thrashes**.
At the coarse sweep's worst point (24 agents, concurrent build, 7168 MiB cap) p95
turn latency reached **30.3 s**, the worst single turn **157 s**, throughput fell
66%, PSI full hit 85%, and swap was exhausted at exactly 2048 MB - with all 24
agents still alive at the end of the measurement window, and the box still
answering ssh. (Liveness is counted when the arm's duration elapses, before the
teardown snapshot, so it describes the measured window rather than the whole
process lifetime.)

A customer feels that far more than losing one agent, and no crash-based health
check would notice it.

**Corollary, found the hard way, and worth stating precisely.** A sacrificial
unit capped at `MemoryMax=800M` with swap left unlimited recorded **4354 `max`
events and zero kills** while its allocation passed 1800 MiB.

`MemoryMax` was doing its job throughout: those 4354 events *are* the limit being
enforced, and the cgroup's RAM charge stayed at the cap. What the configuration
lacked is a bound on the **combined memory-plus-swap footprint**, because swap is
accounted separately. Two consequences that must not be collapsed into each
other:

- `MemoryMax` alone still protects the host's RAM reserve - the reachability
  argument the design makes for it holds.
- `MemoryMax` alone does **not** bound total footprint and does **not** guarantee
  an OOM kill at the cap. A cgroup can sit at its limit indefinitely, paging, for
  as long as swap lasts.

So `MemorySwapMax` is not a detail to settle alongside decision 4: it is what
turns the limit into a bound on how much a runaway can consume in total, and it
is required for the fence to produce a kill rather than unbounded paging.

## The 1 GiB reserve: still provisional

The sampled `nonbench_mem_mb` series reads **677-949 MB** under the build arms
and ~1228 MB in one agents-only arm, which *looks* like a validation of the
1024 MB `RESERVE`. It is not one, and should not be quoted as such.

The metric mixes incompatible quantities: it is `MemTotal - MemAvailable -
<cgroup memory.current>`, but `MemAvailable` is an estimate of allocatable memory
that already counts reclaimable page cache, while `memory.current` is a charge
that also includes the cgroup's own reclaimable cache. Subtracting one from the
other can double-discount cache, so the number is a rough sanity signal - it says
the reserve is not wildly wrong - and nothing more.

The inputs for a defensible decomposition (sibling `system.slice` and
`user.slice` charges, `MemFree`, `Cached`, reclaimable and unreclaimable slab)
were not sampled during these runs. They are sampled now, so the next run can
settle it. **Until then the 1024 MB reserve stays provisional**, exactly as the
design has it.

## Without the cap, the box goes down

The unconstrained baseline at N=24 (~6.9 GB of agents, no cgroup limit) drove the
**host** into global memory pressure. earlyoom fired at 9.28% `MemAvailable` and
killed its way down the badness list - `(sd-pam)`, `fwupd`, `udisksd`, and the
benchmark orchestrator itself - aborting two later phases. The *constrained* arm
at the same N had been fine.

That is the reachability argument the cgroup limits exist to make, demonstrated
rather than asserted. The arm is excluded from the tables above as invalid; the
event is the result.

**And it exposes a second regime for decision 4.** At the moment earlyoom fired:

```
mem avail: 736 of 7941 MiB (9.28%), swap free: 2047 of 2047 MiB (100.00%)
```

Swap was **100% free while RAM was exhausted**. Under global pressure with
`vm.swappiness=10`, earlyoom's 10% threshold trips before the box makes
meaningful use of its swapfile, so swap size buys nothing there. Under *cgroup*
pressure the opposite holds: `MemoryHigh` drove up to 2048 MB into swap. Decision
4 has to be answered for the cgroup regime; in the global regime the swapfile is
largely bypassed.

**And earlyoom leaves a box pingable but not functional.** Its cascade killed
`systemd-resolved`, which stayed `failed` for about three hours. The box answered
ssh and every liveness probe throughout, while no process on it could resolve a
hostname - which silently emptied the build load out of a later phase (see
"Arms excluded" below). For a hosted product this is the more dangerous failure
shape than a crash: nothing reports it.

## The blast radius, measured

Sequencing item 2 asks for the actual `MemoryOOMGroup`/`OOMPolicy`/`Restart`
combination to be verified rather than assumed, and the design calls a one-agent
blast radius "a desired and testable outcome, not kernel semantics". It is
testable, so it was tested: a throwaway system unit shaped like the office - same
`Restart=always`, same `User=`, a parent "server" holding 400 MB and two "agent"
children - capped at 800 MiB with `MemorySwapMax=0`, with one child growing until
the fence trips.

The fixture is rigged so that size alone picks the *wrong* victim: the server
holds more than either child at the moment the cgroup OOMs.

Run in two shapes, because the difference turned out to matter. In v1-v5 the
service's `ExecStart` is a shell and the server's memory sits in a *child* of it,
so the unit's MainPID holds nothing and can never be the victim. In v6-v7 the
allocation is in the unit's own MainPID, which is the shape of `isomux.service`,
where the bun server is itself `MainPID`.

| Variant | MainPID holds the memory | Kernel's victim | Unit outcome |
| --- | --- | --- | --- |
| v1 no stamp, `stop` | no | largest **descendant** (403 MB, `adj:0`) | failed, `NRestarts=1` |
| v2 +300 stamp, `stop` | no | a stamped **agent** (`adj:300`) | failed, `NRestarts=1` |
| v3 `memory.oom.group=1` | no | **all processes atomically** | failed, `NRestarts=1` |
| v4 +300 stamp, `OOMPolicy=kill` | no | a stamped **agent** (`adj:300`) | failed, `NRestarts=1` |
| v5 +300 stamp, `continue` | no | a stamped **agent** (`adj:300`) | **`NRestarts=0`, `active`** |
| **v6 no stamp, `continue`** | **yes** | **the MainPID server** (404 MB, `adj:0`) | **`NRestarts=1`** |
| **v7 +300 stamp, `continue`** | **yes** | a stamped **agent** (247 MB, `adj:300`) | **`NRestarts=0`, `active`** |

**Both halves of the fix are required, and neither is sufficient alone.**

- **The stamp decides who dies.** `AGENT_OOM_SCORE_ADJ = 300`, shipped in task
  37b194be, moves the victim off the server every time - v7 kills a 247 MB
  stamped agent in preference to the 404 MB server sitting right next to it.
  Without it (v6) the kernel takes the server, which is the incident's blast
  radius reproduced with the server genuinely as `MainPID`.
- **`OOMPolicy` decides whether the unit survives that death.** systemd's default
  is `stop`, which stops the unit when *any* process in its cgroup is OOM-killed;
  `Restart=always` then recycles the office. **isomux ships no explicit
  `OOMPolicy`**, so today one OOM-killed agent restarts every agent on the box -
  v2 and v4 show a correctly-selected agent dying and the unit recycling anyway.
- **`continue` does not rescue a dead server.** v6 has `OOMPolicy=continue` and
  still restarts, because when `MainPID` exits the service exits regardless of
  policy. So `continue` without the stamp buys nothing; the stamp without
  `continue` buys nothing. v7 is the only configuration that contains the blast
  radius to one agent.

Note the naming is counterintuitive: `stop` sounds conservative and is the wider
blast radius, and `kill` is wider still.

What this test does **not** establish: that a real bun office would select the
same victims. The fixture's processes are python allocators with flat, mostly
anonymous footprints, and selection is a badness score over real memory. It
establishes the *mechanism* - that the stamp reorders the kernel's choice and
that `OOMPolicy` governs the unit's fate - not the outcome for any particular
office workload.

## Swap: decision 4

Same load three ways, at two loads chosen from measurement: N=20, where the
shipped 2 GiB is under pressure but not exhausted, and N=24, where it is
exhausted. Concurrent cold build in every arm. Cap 6917 / 5879 MiB.

**N=20 with a build:**

| Config | p95 | p99 | worst turn | throughput | swap used | PSI full | `high` events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 GiB (shipped) | 1163 ms | 2289 | 3628 | 17.52 | 1666 MB | 21.2 | 7 749 |
| 8 GiB | **916** | 1823 | 4286 | 17.58 | 3945 MB | 17.8 | 7 304 |
| swap denied | **589** | 1178 | **13 827** | 15.00 | 0 | **88.2** | **302 634** |

**N=24 with a build:**

| Config | p95 | p99 | worst turn | throughput | swap used | PSI full | `high` events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 GiB (shipped) | **30 679 ms** | 72 580 | 120 535 | **6.59** | 2048 (exhausted) | 93.0 | 150 796 |
| 8 GiB | **3 436** | 5 561 | 9 853 | **14.40** | 4235 MB | 33.7 | 22 313 |
| swap denied | **708** | 1 268 | 2 330 | 12.99 | 0 | 92.2 | 254 985 |

Zero OOM kills in all six.

Each cell is a **single run**, and repeat variation elsewhere in this benchmark
is about 8%, so read the two loads differently: the N=24 result is decisive, the
N=20 one is suggestive.

**The cliff is swap *exhaustion*, not swap *existence*.** At N=20, where 2 GiB
still has room, 8 GiB is worth 21% on p95 - above the noise floor but not far
above it, and not on its own a reason to change anything. At N=24, where 2 GiB is
used to the last megabyte, the same comparison is **9x on p95 and 2.2x on
throughput**, which no amount of run-to-run variation explains. A swapfile that
runs out mid-spike is far worse than either a larger one or none at all.

**This reverses the design's stated rationale.** The doc keeps swap small
because "large swap lets a box keep allocating long past the point it can still
respond". Measured, 8 GiB does not do that - it responds *better* than 2 GiB at
every load tested, because what destroys responsiveness is thrashing against an
exhausted swapfile, not the swapfile's size.

**Denying the cgroup swap entirely is the surprise.** It gives the best p95 and
p99 at both loads, because agent memory is anonymous and therefore unswappable
under `MemorySwapMax=0`: agents stay resident and their turns stay fast. The cost
is paid by the build, and it is heavy - 300 000 `high` events, PSI full near 90%,
throughput down, and the worst single turn at N=20 is 13.8 s, the worst number in
the whole matrix. It trades a smooth median for a long tail, and it starves
whatever is doing file IO.

**Answering Nil's question** ("is leaning on disk swap instead of more RAM a
usability problem?"): **yes, at the margin, whatever the size.** Even 8 GiB at
N=24 gives a p95 of 3.4 s against a ~290 ms unconstrained baseline - roughly
12x degraded. Swap keeps the office alive; it does not keep it pleasant. Swap is
a safety net, not capacity, and it should not be sold as headroom.

What follows for the entry tier is in the recommendation below.

## Sensitivity: how much the invented parameters matter

`TOUCH_FRACTION` had nothing behind it and drives how much of an agent's context
stays hot, so it decides how badly swap hurts. At N=18 with a build:

| Touch fraction | p95 | p99 | swap out (pages) | PSI full |
| --- | --- | --- | --- | --- |
| 1% | 315 ms | 433 | 389 307 | 9.4 |
| 5% | 509 | 812 | 706 917 | 16.8 |
| 15% (used above) | 705 | 1659 | 823 409 | 21.6 |

**p95 varies 2.2x across the plausible range**, and the 15% used for the headline
numbers is the pessimistic end. At a middling 5%, N=18 sits at 1.5x its
unconstrained baseline rather than 2.0x. In boundary terms the usability limit
moves by roughly **plus or minus two agents** depending on how hot a real agent's
context actually is - which is the honest error bar on every capacity figure
here, and the reason they are quoted as a range.

`CPU_MS` was the other invented value. It turns out to matter through memory, not
through CPU. Same N=18 with a build:

| CPU duty | p50 | p95 | swap used | PSI full | throughput |
| --- | --- | --- | --- | --- | --- |
| 100 ms/turn (3.1%) | 133 ms | **271** | 624 MB | 8.8 | 18.87 |
| 200 ms/turn (6.25%) | 250 | **650** | 1782 MB | 19.4 | 17.86 |

Halving the duty cuts p95 by 2.4x and swap traffic by nearly two thirds. The
mechanism is not CPU contention - the unconstrained baselines are flat
throughout - it is that a shorter active phase means fewer agents are touching
their context at any instant, so the instantaneous working set is smaller and
the kernel has more slack to reclaim smoothly.

That matters for reading everything above, because **the fixture's 6.25% duty is
above the top of the measured live range** (1.90-6.11%, mean 4.3%). Real agents
sit between these two rows and nearer the faster one. The headline numbers are
pessimistic on this axis as well as on working-set heat.

Two runs of the same configuration (`sens-cpu200-n18` and `sens-touch0.15-n18`
are the same operating point) gave p95 650 ms and 705 ms, so run-to-run variation
is about 8% - well inside the sensitivity above.

## Arms excluded, and why

`results-summary.csv` carries `valid` and `excluded_reason` columns so a reader
cannot mistake one of these for a measurement. Two of the four are still in the
raw artifact; the other two were overwritten by their own re-runs and survive
only as this description, which is worse and is stated rather than glossed.

- **`base-b0-n24`** (unconstrained, 24 agents): drove the host into global
  memory pressure and was killed mid-run. Not a measurement; the event is
  reported above as a result.
- **`arm0-build-cold-fast`**: lost its entire final cgroup snapshot to a race
  between `inner.sh` exiting and `run-arm.sh` sampling. Fixed by holding the
  scope open past the snapshot.
- **First `oom-blast-radius` run (v1)**: `MemoryMax` was set without
  `MemorySwapMax`, so no kill could occur, and `MemoryOOMGroup=` was written as a
  unit directive systemd does not recognise. Superseded by
  `oom-blast-radius-v2`.
- **First `sens-*` and `swap-*` runs** (*not retained* - the re-runs reuse the
  same directory names and overwrote them): ran with no build load at all,
  because the box's DNS had been dead since the earlyoom cascade and every cold
  `bun install` failed in under a second against a cache an earlier phase had
  emptied. Detectable only as a cgroup peak ~3 GB below expectation. Re-run after
  restoring `systemd-resolved`; `inner.sh` now writes an explicit
  `BUILD-INSTALL-FAILED` marker, which immediately caught one further arm (that
  one *was* re-run and its replacement is clean).

- **First MainPID blast-radius attempt** (*not retained*, same reason): forked
  the agent children *after* the server allocated, so each child inherited the
  server's 400 MB copy-on-write and the kernel read a 245 MB runaway as 645 MB.
  Both variants then killed the runaway regardless of stamping, which would have
  looked like a clean result and proved nothing. Fixed by forking before
  allocating.

## A capacity function, not a capacity number

The tier table wants one number per row. The measurements support something more
useful: an **empirical fit** whose terms are anonymous memory, which is the part
that has nowhere to go but swap.

```
agents ~= (MemoryHigh - build_anon) / per_agent_anon
```

| Term | Measured | Source |
| --- | --- | --- |
| `per_agent_anon` | **288 MB** | cgroup `memory.stat` anon / N, flat across N=4..20 |
| per-agent total charge | 289-290 MB | `memory.peak` / N, same arms |
| `build_anon` | **~1.5-1.7 GB** | anon at peak, 0.2 s sampling |
| `MemoryHigh` | 5879 MiB | `RAM - 1024 - 15%` on this box |

Checked against both arms:

- With a build: `(5879 - 1600) / 288 = 14.9`. Measured: **14 agents at parity
  with an uncapped box**, 16 first showing cost.
- Without: `5879 / 288 = 20.4`. Measured: **20 clean**, 21 first showing cost.

**This is a fitted predictor, not an accounting identity**, and three caveats
travel with it or it will be misapplied:

1. **It is not a contradiction of the ~3 GB build reserve.** The isolated build
   peak is ~3 GB and that remains the figure for "how much memory does a build
   need". The formula subtracts only the ~1.5 GB anon part because that is where
   the *usability boundary* empirically falls, not because the other ~1.4 GB of
   `node_modules` page cache is free. The concurrent arms show reclaiming it was
   cheap **at N=14 on this fixture** - that is one operating point, not a general
   law, and at N=16 and beyond the same reclaim is visibly no longer cheap.
2. **`per_agent_anon` is a property of the synthetic fixture, not of a real
   agent.** The fixture is anon-dominated by construction (288 MB anon against a
   289-290 MB total charge, so ~1 MB of file per agent). A live `claude` is not:
   358 MB RSS against 241 MB anon, with much of the difference in *shared*
   file-backed mappings. Substituting a real agent's anon into this formula is
   reasonable; substituting its RSS is not.
3. Both coefficients are stated at one operating point - 6.25% CPU duty, 15%
   working-set touch. The sensitivity section shows the boundary moving about two
   agents across the plausible range of those, so the formula's output is a
   central estimate with a plus-or-minus-two-agent band, not a threshold.

## Recommendation for the entry tier

**1. The entry tier is sound, and the doc's estimate was conservative.**
4 vCPU / 8 GB genuinely carries **~14 agents with a build running continuously**
and **~20 with none**, against the table's estimate of ~12 and ~20. Nothing here
argues against shipping it. RAM binds; CPU never did, at any N tested.

**2. Ship `OOMPolicy=continue` on `isomux.service`.** This is the highest-value
line in the whole benchmark. isomux currently inherits systemd's default of
`stop`, which means one OOM-killed agent restarts every agent on the box.

   It only works **paired with the `oom_score_adj` stamp already shipped**, and
   the pairing is the point: the stamp keeps the victim off the server, and
   `continue` keeps the unit alive when a non-MainPID process dies. Neither
   alone contains the blast radius - a server killed under `continue` still ends
   the service, because a dead `MainPID` exits it whatever the policy says.

**3. Set `MemorySwapMax` explicitly, and treat it as load-bearing rather than a
detail of decision 4.** `MemoryMax` on its own bounds the cgroup's RAM - and
keeps protecting the host reserve - but it does not bound the combined
memory-plus-swap footprint and does not guarantee a kill at the cap: measured, a
cgroup sat at an 800 MiB limit and paged its way past 1800 MiB of allocation.
`MemorySwapMax` is what makes the limit bound total consumption. Its *value* is
unmeasured; see 4.

**4. On swap size (decision 4): do not keep 2 GiB as the entry-tier default.**
It is the worst of the three configurations tested at load, because exhaustion is
catastrophic rather than graceful - a 30.7 s p95 against 3.4 s at 8 GiB under the
same load. The small-swap rationale in the design - that large swap lets a box
allocate past the point it can respond - is not what the measurements showed.

   **8 GiB is the candidate, not a validated setting.** Both alternatives are
   still unsatisfying and neither is ready to ship as-is:

   - 8 GiB with swap unlimited is far better than 2 GiB at the load that matters,
     but 3.4 s p95 is roughly 12x the unloaded baseline. That is survival, not
     comfort, and it should not be described as behaving well.
   - `MemorySwapMax=0` gives the best median at both loads but the worst tail in
     the entire matrix (13.8 s worst turn at N=20) and near-total PSI stall for
     anything doing file IO, because it protects agent anon by starving the
     build.

   **What is missing is the cap value, and this benchmark did not measure it.**
   Every 8 GiB arm ran with `MemorySwapMax=infinity` and used up to 4235 MB, so
   the obvious pairing - a larger swapfile with the cgroup capped below it - is
   an untested configuration. A cap set below observed demand would recreate
   exactly the exhaustion cliff this section is warning about, just at a
   different threshold. Before shipping: benchmark explicit `MemorySwapMax`
   values against a swapfile large enough not to bind, and pick from that.

**5. Do not sell swap as headroom.** Even at 8 GiB, a swapping office runs ~12x
its unloaded p95. Swap buys survival, not capacity. This is the direct answer to
the question of whether disk can substitute for RAM: it cannot, though it is
worth having as a safety net.

**6. Keep the 1024 MB reserve, still provisional.** The sampled figure is a rough
sanity signal rather than a measurement (see the reserve section), so nothing
here justifies trimming it - or defending it. The inputs to settle it are
sampled now.

**7. Publish none of these numbers**, per decision 3, which this benchmark does
not revisit. They are internal sizing inputs, and the sensitivity section is the
reason: the usability boundary moves by about two agents depending on how hot a
real agent's working set is, and that is not a number to defend in public copy.

## Where the raw data is

Every number above is reduced from `scripts/capacity-bench/results-summary.csv`,
which holds one row per arm and is committed. The full raw capture - per-arm
2 s (or 0.2 s) sample series, every agent's per-turn jsonl, cgroup snapshots,
kernel and journal excerpts - is 28 MB across 1146 files and is **deliberately
not committed** to a public repo for a one-off run. It lives at:

- `~/nil/capacity-benchmark-raw/` and `~/nil/capacity-benchmark-raw-2026-08-02.tar.gz`
  on the office box
- `/home/ubuntu/bench/results/` on 169.58.97.2, which is paid through 2026-08-29

## Reproducing

Harness in `scripts/capacity-bench/`. On the box under test:

```
run-arm.sh <name> <n-agents> <build:0|1> <duration>   # one arm
run-sweep.sh [duration]                               # coarse sweep
run-refined.sh <build> <dur> <reps> <n>...            # refined, with baselines
run-sensitivity.sh <n> <build> <dur>                  # touch/CPU axes
run-swap-arm.sh <build> <dur> <n-below> <n-above>     # decision 4
oom-blast-radius.sh [out-dir]                         # OOMPolicy/oom.group
```

`probe-external.sh` runs on a *different* box. `analyze.ts` reduces result
directories to the tables above; point `BENCH_PROBE_FILE` at the external probe
CSV to have it sliced per arm.

Preconditions worth asserting before any long run, each learned the hard way:
swap present and the expected size, the npm registry reachable, `node_modules`
present, and the orchestrator itself protected with a negative
`OOMScoreAdjust` so it is not a victim of the killer it is measuring.
