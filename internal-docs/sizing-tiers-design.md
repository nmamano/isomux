# Hosted sizing and tiers

Design for task f057617f (memory capacity, OOM isolation, per-office resource
defaults). Companion to `hosted-isomux-design.md` (single-tenant-per-VPS) and
the Contabo supplier pilot (task b223ebc3).

## STATUS 2026-08-20: the launch gate (read this first)

The converged story (Nil + Isomux PM + Personal Site Agent, 2026-08-18/19) is
four measures in a causal chain, each answering one question:

1. **The cap** (how far a problem spreads): the office-unit
   `MemoryMax`/`MemoryHigh`/`MemorySwapMax` drop-in. `MemoryHigh` contains
   gradual pressure; on Poweruser, earlyoom can act before the hard fence.
2. **The swapfile** (turns a kill into slowness): only does work *inside* the
   cap. Measured 2026-08: at the moment earlyoom fired in the unconstrained
   arm, swap was 100% free - "in the global regime the swapfile is largely
   bypassed" (benchmark note). The cap creates the regime in which swap helps.
3. **Kill order + `OOMPolicy=continue`** (who dies, without a cascade): flat
   stamp on all descendants, size breaks the tie, one kill costs one tool call.
4. **earlyoom** (when anyone dies at all): the backstop for memory the cap
   cannot see - the OS reserve and anything else the customer runs.

All four measures ship in code as of 2026-08-20. Measure 1 is the system-unit
drop-in installed by `isomux-oom-protect` (task fa00291e). Paid launch still
waits on the measured run of that shipped config at N=24 plus a build on a
release-shaped Entry box (task 5a8e4b08). That run also settles the provisional
1 GiB reserve. Until it passes, the benchmark headline numbers remain
cap-conditional and not quotable for a shipped box, and the hosted blog post's
memory section must not be published.

The per-agent scopes ruling (task 8859f52b) is NOT part of the launch gate:
the office-level cap is split out of it as fa00291e. PM's 2026-08-18 proposal
to re-scope the remainder as an isolation-and-visibility feature (off the
memory-safety path) is pending Nil's ruling.

## Already shipped: reference, do not re-design

`deploy/install.sh` (`configure_oom_protection`, installed as the re-runnable
`/usr/local/sbin/isomux-oom-protect`, `--dry-run` supported) already gives every
new box:

- **earlyoom** at `-m 10,5 -s 100,100`, `--avoid`
  `^(systemd|systemd-.+|sshd|tailscaled|caddy|earlyoom|isomux)$`, `--prefer`
  `^(claude|codex|node|chrome)$`. Something is killed while there is still
  memory to act with, instead of the box thrashing into the kernel's
  last-resort killer. The `--avoid` list originally shielded `bun`, which
  protected the builds themselves; fixed 2026-07-31 (a51393e7): the server
  renames itself `isomux` and that name is shielded instead. Whether
  `--prefer` still earns its place is open (task 416a473f).
- **`OOMScoreAdjust` tiers** written to unit drop-ins and to the running PIDs,
  so applying them restarts nothing but earlyoom: ssh + tailscaled `-900`;
  systemd-resolved, systemd-networkd and systemd-logind `-900` plus
  `StartLimitIntervalSec=0` so a killed critical daemon always restarts (the
  fixes from the 2026-08-02 DNS cascade); caddy + isomux `-500`.
- **`vm.swappiness = 10`**, and an **8 GiB swapfile** (decision 4, ruled
  2026-08-02, shipped as task 99d7f273) created only when the box reports zero
  total swap and the disk has room. Existing swap of any size is reported and
  left untouched.
- **The office-unit memory cap** on installer-managed system services:
  `MemoryMax` is box RAM minus a provisional 1 GiB reserve, `MemoryHigh` is 85%
  of that result, and `MemorySwapMax` is a fixed 6 GiB. Boxes below 4 GiB RAM
  are left uncapped rather than made unusable by an Entry-tier reserve. The
  tool reads all three cgroup values back when the service is already running.
  User-level self-hosted services do not receive this system-unit drop-in.

The 8 GiB figure reverses this doc's original 2 GiB small-swap stance, by
measurement: what hurts is running *out* of swap mid-spike, not swap existing.
See decision 4 for the numbers and for the withdrawn auto-replacement.

**Two mechanisms, doing different jobs.** These are easy to conflate, and
`isomux-oom-protect`'s own comments do conflate them (see the follow-up at the
end of this doc):

- earlyoom's regexes are the mechanism intended to steer the victim toward an
  agent: it ranks candidates by `oom_score`, with `--prefer` adding 300 to a
  match and `--avoid` subtracting 300. That is a strong preference, not a
  one-agent guarantee, and the score still participates, so a match can lose to
  another candidate.

  Two consequences worth knowing, both from earlyoom's own documentation. For
  `--prefer` matches a negative `oom_score_adj` is ignored and the effective
  score is at least 300, so earlyoom already neutralizes the inherited `-500`
  for anything matching `claude|codex|node|chrome`. And `--avoid` matches
  process *names*, so the `bun` entry that protects the office server also
  protects every `bun install` and `bun run build` an agent starts. The
  multi-GB build spike this whole design is sized around is therefore the one
  thing earlyoom is currently biased *against* killing, and its selection is
  biased toward a `claude` process instead.

  **Fixed 2026-07-31 (task a51393e7)**, in earlyoom's own idiom rather than
  around it: the office server writes `isomux` to `/proc/self/comm` at startup,
  and `--avoid` shields that name instead of `bun`. A name is reset by exec, so
  an agent's build stays `bun` and is a candidate again. An office older than
  the rename keeps its `OOMScoreAdjust` tier, the stronger of the two shields,
  and simply loses this one until it is updated.
- The `OOMScoreAdjust` tiers protect *reachability*: ssh and tailscaled at
  `-900` sit far below anything else on the box, so they go last. Those two are
  system units in every deployment shape, so that half holds everywhere. The
  office's own `-500` is the part that varies by shape (measured below): on a
  system-level install it applies and is over-broad, since it shields everything
  the office spawns as well; on a user-level install the shipped drop-in targets
  a system unit that does not exist, and a hand-placed user drop-in is silently
  ineffective anyway.

What the tiers do **not** do is order agents against the office server (fixed
2026-08-01, elsewhere: see "What shipped" below).
`oom_score_adj` is inherited across fork and preserved across exec, so every
agent and every build the office spawns carries the server's own value. The
kernel's last-resort tier therefore does not distinguish the server from its
descendants at all, and the selected task can be the server. Measured, on two
deployment shapes:

| Install shape | Written config | Effective at runtime |
| --- | --- | --- |
| System unit (hosted; Contabo box, Isomuxer1, 2026-07-30) | `-500` | server `-500`, descendants `-500` |
| User unit (`systemctl --user`; this office box, 2026-07-30) | `-500` | server `100`, every descendant sampled `100` |

On the user-level box a drop-in is present under `~/.config/systemd/user/` and
systemd's user manager reports `OOMScoreAdjust=-500`, yet the running process
reads `100`. The negative value
is silently ineffective there and the protection is a no-op. Note that the
incident work verified a user manager *accepts* the
directive, which is exactly the trap: acceptance of a written value says nothing
about the effective one.

**Cause, established 2026-07-31 (task c5b4e89e).** Ubuntu starts every user
manager at `OOMScoreAdjust=100`
(`/usr/lib/systemd/system/user@.service`), and services inherit it. The kernel
only permits *lowering* `oom_score_adj` with `CAP_SYS_RESOURCE`, which a user
manager does not hold - the office box's has `CapEff=0000000800000000`,
`CAP_WAKE_ALARM` alone. The request for `-500` is therefore refused, and the
service still starts clean, so nothing surfaces. Confirmed from both ends with
throwaway units: a *system* unit asking for `-500` gets `-500` at runtime and
its child inherits `-500`; a *user* unit asking for the same gets `100`. Same
directive, same systemd, different manager privileges, opposite outcome. The bug
also reproduces on an unrelated box, so it is not a quirk of this one.

**Fix shipped 2026-07-31, deliberately conservative.** `isomux-oom-protect`
already runs as root, and root is not subject to that restriction: it can write
the score onto the running process directly (verified - `0` to `-500` on a live
unprivileged process). So the tool now finds a user-level office by its cgroup
and stamps it from root. Two limits are stated in its output rather than papered
over: the value is lost when the office restarts until the tool runs again, and
agents started after the stamp inherit the server's new score, because a score is
inherited at fork.

**Both limits are closed as of 2026-08-01.** The first by task b584901d: the tool
now installs a root-owned oneshot and timer (`isomux-oom-restamp`,
`OnUnitActiveSec=1min`) that re-applies the stamp within a minute of an office
restart, prints nothing when there is nothing to do, and is installed on every
box - on a hosted one it finds no user-level office and stays silent, which is
cheaper than deciding at install time whether the box will ever need it. The
timer runs `--restamp`, a mode of the same tool, from
`/usr/local/sbin/isomux-oom-protect`, which the tool refreshes with its own copy
when it is run from a checkout: a pre-`--restamp` copy sitting at that path would
otherwise fail every minute. The second limit by task 37b194be above, since
descendants no longer keep the server's score at all.

Making it survive a restart *natively* would mean lowering the whole user
manager, which puts every process in that operator's login session under the same
protection. That is a host-policy decision with the wrong failure bias - it would
also protect the agent and build workloads that are supposed to be sacrificed -
so it is queued for Nil rather than settled in the patch, and the timer above is
what makes it not urgent.

**And every write is now read back.** `stamp_pid` compares
`/proc/PID/oom_score_adj` against what was asked for and warns loudly on a
mismatch, naming the value the kernel will actually use. It also compares the
process start time either side of the write, so a pid that exits mid-stamp and
gets recycled cannot be reported as a success. `systemctl show` is never used as
verification anywhere in the tool.

**Design principle from this.** Assert the effective value, not the written
config. Any memory or OOM setting this design adds should be verified by reading
back what the kernel actually holds for the process, the same lesson the
harden-ssh work reached independently.

**Proposed fix, cheap and unprivileged. Accepted by Nil as decision D4 on
2026-07-31 and shipped 2026-08-01 (task 37b194be); the paragraphs below are the
design as proposed, with what actually landed noted at the end.** Have the office
stamp a positive `oom_score_adj` on each agent process at spawn. Raising the value needs no
privilege; only lowering it does. Verified on the office box: a process at
`100` can set itself to `300`, and is denied at `50` without
`CAP_SYS_RESOURCE`. So a server at `-500` can put its own agents decisively
above itself, and the kernel-side order stops depending on badness-score
heuristics. Descendants inherit the stamp, so a build inherits its agent's.

This is a **scope addition**: it is code on the spawn path, not a provisioning
default like the rest of this design, and it needs Nil's acceptance before being
sequenced as mandatory. Still open as of 2026-07-31, and still needed: the two
fixes shipped that day correct earlyoom's *selection* and make the user-level
tier real, but neither orders agents against the office. On both install shapes
the descendants still carry the server's own score, so the kernel's own killer
cannot tell them apart.

One implementation note found while fixing the other two. The Claude SDK owns
the spawn - `query()` in `server/backends/claude.ts` starts the `claude` binary
internally - so isomux has no pid to stamp at spawn time. Doing this means
either a periodic sweep of the server's descendants in `/proc` or a hook in the
SDK, neither of which is a one-liner. Size it accordingly.

**What shipped, 2026-08-01 (task 37b194be).** The sweep, in the server rather
than in a root unit (Nil's direction: one code path that behaves identically on a
hosted system unit and a self-hosted user unit). `server/oom-stamp.ts` walks
`/proc` every ten seconds, takes the transitive descendants of its own pid, and
raises each to `AGENT_OOM_SCORE_ADJ = 300`; `runOfficeMain()` starts it next to
`setProcessName()`, and it is a no-op off Linux. Three properties are worth
carrying forward. It only ever raises, so it needs no privilege and cannot
undo a deliberate value. It reads every write back and re-checks the process
identity either side, the same discipline as `stamp_pid`. And one value for all
descendants is deliberate: with the bias equal, what separates them is size, so
the heavier ones are the likelier victims - a bias, not an ordering the kernel
owes us, and earlyoom's name preference still layers on top. 300 was picked
against measurement rather than
taste - on an 8 GB box `+100` of `oom_score_adj` moves `oom_score` by ~67 points
while a 1.2 GB difference in RSS moves it by ~51, so 300 clears a user-level
office's forced 100 by a margin equivalent to roughly 3 GB of office growth on
that box.

Two things this does *not* settle, both left to Nil. Once descendants carry 300,
earlyoom's `--prefer '^(claude|codex|node|chrome)$'` bonus of +300 can still pick
a smaller `claude` over the bigger `bun` build underneath it, so that list may
now be doing more harm than good. And the `user@<uid>.service` floor below stays
open.

## What the incident task assumed, and what changed

f057617f called noisy-neighbor across customers the headline risk. Hosted is
single-tenant-per-VPS, so that risk is bought off by the architecture. The
in-box version of it is what remains and it is still real: the office server
and every agent it spawns live in **one cgroup** (`isomux.service`,
`User=isomux`), with `MemoryMax`/`MemoryHigh` at infinity. A build spike
therefore competes with sshd, caddy and tailscaled, and an unreachable box is
an outage a customer cannot self-serve out of.

So per-unit memory caps are for **reachability**, not tenancy. They are not a
tenancy boundary and must not be treated as one later: if isomux ever packs
several customers onto a host, isolation gets redesigned from
`isolation-design.md`'s escalation ladder, not extended from `MemoryMax`.

## Measured unit costs

| Item | Cost | Source |
| --- | --- | --- |
| Office server | ~132 MB | incident measurement, 2026-07-24 |
| Active agent | ~250 MB avg, 291 MB heaviest | same |
| Active agent (spot check) | 336 MB, 309 MB, codex 132 MB | office box, 2026-07-30 |
| Idle agent | ~0 (sessions are released when idle) | - |
| Build/test spike | multi-GB, **not yet measured precisely** | incident measurement, 2026-07-24 |
| Non-office daemons | ~200 MB (tailscaled 55, journald 149) | office box, 2026-07-30 |
| Kernel slab, box-wide | ~500 MB, not attributable to one unit | office box, 2026-07-30 |

Two things follow. Builds, not agent count, are the risk, and running builds
*is* the product, so the spike is inherent. And an accurate build-spike number
is the one input the tier table is missing; measure `bun install` +
`build:ui` + the full test suite peak RSS on the idle Contabo pilot box before
the numbers below are published anywhere customer-facing.

Also pending: the claude-agent-sdk bump (task c641fff6) carries three upstream
memory-leak fixes matching isomux's usage pattern. Land it and re-measure
before treating per-agent RSS as final.

## Per-office defaults

Applied as a drop-in on `isomux.service`, computed from box RAM at install time:

```
RESERVE       = 1024 MB          # measured daemons + box-wide slab + a login shell
MemoryMax     = RAM - RESERVE    # hard fence, so the box stays reachable
MemoryHigh    = MemoryMax - 15%  # soft: reclaim + throttle before anything dies
MemorySwapMax = 6144 MB          # fixed; measured on Entry, see below
```

Both figures are **provisional validation parameters**, not measured constants.
The 1 GB reserve is sized to cover the ~200 MB of measured non-office daemons
plus the ~500 MB of box-wide kernel slab, which no unit limit accounts for, plus
a login shell for the operator who has to fix things. The 15% headroom is an
engineering starting value with nothing behind it yet. The stress test below is
what should settle both.

`MemoryHigh` is the load-bearing half. Under it the kernel reclaims and throttles
the cgroup rather than killing, which converts a spike into slowness plus a
signal. `MemoryMax` is the last defense.

`MemorySwapMax` needs setting explicitly: `MemoryMax` does not cap a cgroup's
swap. The fixed 6 GiB value is about 1.4x the observed uncapped peak of the
2026-08-03 Entry load. It stays 6 GiB on a box with less total swap because the
global supply binds first; scaling the cgroup cap down would recreate the
measured exhaustion cliff sooner. **Known open item:** the 6 GiB cap has not
been measured at the Poweruser tier's estimated agent population, so the Entry
finding that it does not bind must not be generalized to Poweruser.

earlyoom stays as the box-wide layer, unchanged, and the two layers cover
different failures. earlyoom does not observe cgroup-local pressure. On Entry,
its 10% trigger sits just inside the provisional 1 GiB reserve; on Poweruser,
10% is about 2.4 GiB, so earlyoom can act about 1.4 GiB before the fixed-reserve
`MemoryMax` fence. `MemoryHigh` is still reached first on both tiers and starts
reclaim and throttling. Under gradual overload the measured capped arms killed
nothing: the customer sees increasing latency while the office degrades inside
its bounds. A sudden runaway can still reach the hard fence and lose a process.

What a `MemoryMax` breach does needs stating as a semantic rather than a
guarantee. With `memory.oom.group = 0` (the default, confirmed on the office
box) the cgroup OOM killer selects an individual task first rather than killing
the cgroup atomically, and it can be invoked again if that does not relieve the
charge. Because all descendants share the server's `oom_score_adj`, the selected
task may be the bun server itself; if `MainPID` dies, systemd's `OOMPolicy` and
`Restart=always` can recycle the whole unit, which is the original incident's
blast radius rather than a contained one.

So a one-agent blast radius is a **desired and testable outcome, not kernel
semantics**. The implementation slice must verify the actual
`MemoryOOMGroup` / `OOMPolicy` / `Restart` combination, and the spawn-time
`oom_score_adj` stamp proposed above is what would make the desired outcome
likely rather than accidental.

**Diagnosability: narrowing the gap, not closing it.** The incident could not be
attributed because kernel OOM detail needs root. Two files the service user can
already read change that, verified on the office box including for a
`root`-owned *system* unit's cgroup, which is the hosted shape:

- `<cgroup>/memory.events` and `memory.events.local`: `high`, `max`, `oom`,
  `oom_kill` counters, `root:root` mode `0444`. Prefer `.local` for
  non-hierarchical attribution, and snapshot deltas rather than reading the
  cumulative counters raw.
- `<cgroup>/memory.pressure`: PSI stall time.

Combined with the exit signal (the office spawns its agents, so it sees their
SIGKILL directly), that answers one specific question without privilege: *was
this a cgroup OOM, and which agent that we were watching died?* Record it with a
timestamp and the PID-to-agent mapping, and surface it in that agent's chat as
"stopped under memory pressure" instead of a generic crash. In the incident that
would have named the victim, which the unit-level systemd message could not. It
would not have established the cause, which remains unknown and should stay
that way in writing rather than be guessed at.

It is not full incident attribution. It does not retain the kernel's memory
breakdown or the allocation that triggered the spike, it will not name a killed
grandchild such as a build subprocess, and the correlation can race when several
processes exit at once.

**Pressure signal.** PSI is the right control input, but it measures reclaim and
stall *impact*, not distance to a byte limit, and it has no universal safe
watermark: any threshold needs calibrating against the real workload. Read
`memory.current` and `memory.stat` alongside it for cap headroom and telemetry,
just not as the harm signal on their own. On the office box `memory.current`
reads 2.1 GB against 578 MB anonymous, so much of it is file cache that is
usually reclaimable, though reclaim is never free and cache can be active or
dirty.

**Graceful degradation.** Whether the office degrades at all is decision 2. If
Nil picks option (b) there, the proposed implementation is: sample own-cgroup
PSI on a timer and, above a calibrated watermark, refuse to *start* new turns
with a visible office banner while letting in-flight turns finish. Refusing is
cheap and reversible; being SIGKILLed is neither.

## Tiers

RAM sizes resident-agent capacity; build and tool concurrency sizes CPU
capacity. Agent orchestration is normally API-wait-bound: measured on the
4-vCPU office box, a live agent process averages 1-6% of one core over its
lifetime. That is a lifetime average, so it does not prove that tool bursts
across agents cannot coincide, and how much the two columns actually overlap is
for the stress test to settle rather than something to assert here.

| Tier | Box | Price/mo | MemoryMax | Concurrent builds | Active agents |
| --- | --- | --- | --- | --- | --- |
| Entry | Contabo V153, 4 vCPU / 8 GB / 100 GB SSD | **EUR 5.50** (verified: ordered 2026-07-29, 1-month term, no setup fee) | 7 GB | 1 (est) | ~12 (est) |
| Poweruser | Contabo V155, 8 vCPU / 24 GB / 300 GB SSD (Contabo account read, 2026-08-20) | **EUR 11.90** (confirmed by Nil 2026-08-20; our supplier cost, customer price adds margin) | 23 GB | 2-3 (est) | ~55 (est) |
| Large | Contabo 48 GB, or VDS M dedicated 32 GB | **EUR 20** / **EUR 43** | 47 / 31 GB | 4+ (est) | ~150 / ~100 (est) |

**Both tiers ship** (Nil, 2026-07-31). Entry is positioned for customers who do
not run many agents at once, with the larger tier alongside it rather than
replacing it. That makes the upgrade path a first-class concern rather than an
afterthought, which is why it has its own section below.

These figures are for internal sizing only. **No concurrency numbers go in
public copy** (Nil, 2026-07-31): keep customer-facing wording vague and
capability-phrased, per the copy rules. A published cap becomes a support
surface and a comparison axis, and the numbers here are not solid enough to
defend.

Every capacity figure in that table is an estimate. Entry-tier arithmetic:
8 GB - 1 GB reserve - 0.15 GB server - 3 GB for one build = 3.85 GB = ~12 active
agents. With no build running the same box holds ~20, which matches the incident
measurement on 7.7 GB. The 3 GB build figure is the one number that moves every
row, and the per-agent figure is the one the SDK bump (c641fff6) may change.
The upper rows are pure arithmetic: nobody has run 55 concurrent agents on
anything. Publish none of these until the benchmark below has run.

**RAN 2026-08-02. Results in `sizing-tiers-benchmark-results.md`**, which
supersedes the capacity estimates in the table above and largely answers decision
4. Four things it changed: entry-tier capacity is ~14 agents with a build and ~20
without (the estimates were conservative); no constrained capacity arm ever
reached cgroup OOM, because the office thrashes rather than dies;
`isomux.service` needs `OOMPolicy=continue`, *paired with* the `oom_score_adj`
stamp, before a one-agent blast radius is possible at all; and the shipped 2 GiB
swapfile is the worst of the tested options at load, which reverses the
small-swap rationale above. One thing it did **not** settle and which the note
is explicit about: the 1 GiB reserve, which stays provisional. The
`MemorySwapMax` value it also left open was measured on 2026-08-03 in a
follow-up arm (task 99d7f273), in the same note. The spec of the run follows,
unchanged.

**The benchmark that would make them real** (filed as task 6ce6b700). Run it on
the idle-but-paid Contabo box 169.58.97.2, cancelled but paid through
2026-08-29, and **not** on 169.58.96.127, which is running the week-long steal
monitor due 2026-08-02 that a memory stress test would ruin. With the proposed
`MemoryHigh`/`MemoryMax`/`MemorySwapMax` limits applied: drive N simultaneous
representative turns, sweeping N upward, with and without a concurrent
`bun install` + `build:ui` + full test suite. Record per-turn latency, PSI stall
time, load average, steal time, `memory.current` and `memory.stat`, and
`memory.events.local` deltas. That yields the three things the table is missing at
once: the real build-spike reserve, the PSI watermark for decision 2, and whether
RAM or CPU actually binds first.

**The swap arm answers a question Nil raised** (2026-07-31): is leaning on disk
swap, instead of selling a box with more RAM, a usability problem? It is the
cheapest way to buy headroom, and under the pricing philosophy below that
matters. But swap trades a kill for a stall, and a stalled office is something
the customer feels on every keystroke while an OOM kill costs one agent. Run the
2 GiB-versus-larger comparison under the same load and report the difference in
per-turn latency and PSI, not just whether the office survived. Survival is not
the bar; the bar is whether the office still feels usable while swapping. That
evidence settles decision 4.

Cost caveats that are not in the sticker price: Contabo bills monthly-minimum
with no hourly, charges a **non-EU surcharge** (a Seattle box for a US customer
costs more than the EU figure) plus metered traffic, and benchmarks worst in
class for CPU steal (0% on the pilot box day 1, with a week-long readout due
2026-08-02). Auto-backup was declined in the pilot, so its price is unknown;
the Hetzner-era assumption in `hosted-isomux-design.md` was +20% of box price.

**Pricing philosophy** (Nil, 2026-07-31): a small margin above cost, optimising
for growth rather than revenue. That inverts how the numbers above should be
read. The competitor reference points in `hosted-isomux-design.md`
(EUR 14.99 / 25.99 / 49.99) are a ceiling to stay well under, not a target to
match: entry costs EUR 5.50, so pricing it near EUR 14.99 would be a ~170%
markup, which is the opposite of the intent.

What the philosophy demands instead is that the *cost* side be complete, since
a thin margin has no room to absorb a surprise. The known additions per box are
Stripe fees, the non-EU surcharge for US customers, metered traffic, and
backups, whose price is unknown because auto-backup was declined in the pilot
(the Hetzner-era assumption in `hosted-isomux-design.md` was +20% of box price).
Those need real figures before a price is set, and the US surcharge is decision
5.

## Upgrade path

Since both tiers ship, a customer who outgrows entry has to be able to move up
easily. What Contabo offers, **documentation-reviewed, not upgrade-tested**:

- **Upgrades are supported and cost no fee of their own.** The price difference
  for the remaining prepaid period is prorated per day.
- **Two provisioning methods.** *Live migration* keeps the data and needs a
  short reboot, a few minutes, once the migration completes. *New deployment* is
  faster but destroys all data on the box. Which methods are offered depends on
  the source and target configuration; live migration is not available when the
  storage type changes.
- **The IP address is preserved** in every upgrade scenario per Contabo's
  current consolidated upgrade documentation, which would leave DNS and the
  issued certificate untouched. Treat this as their claim rather than a verified
  invariant: an older help article says a new deployment gets a new IP, and the
  two conflict. Confirm before any flow depends on it.
- **Downgrades do not exist as an operation.** Moving to a smaller plan means
  ordering a new box, migrating the data, and cancelling the old one. Note that
  new orders can carry a one-time setup fee depending on product and term, so a
  downgrade is not merely slower than an upgrade, it can cost extra. The pilot
  verified no setup fee for V153 on a 1-month term, but that must be re-checked
  at whatever tier a customer lands on.
- **There is an API path to validate**:
  `POST /v1/compute/instances/{instanceId}/upgrade` exists in Contabo's
  published spec. Endpoint existence is not proof that our specific
  V153-to-target transition, provisioning mode and billing flow are
  API-supported; that needs a dry-run before self-serve upgrades are promised.

What an upgrade means for a running office:

- The reboot ends every in-flight turn, exactly like a restart. Upgrades need
  the same "this will interrupt running agents" treatment the update path
  already has, and are worth scheduling rather than firing on click.
- **The memory limits go stale, and this is the trap.** This design computes
  `MemoryMax` and `MemoryHigh` from box RAM *at install time* and writes them as
  absolute byte values. After a resize the office cgroup keeps its old cap, so
  it gains none of the added RAM as office capacity, silently. The host and the
  other daemons do get the headroom; the office does not.

  The shipped code does not yet meet the activation-time requirement: it
  computes the limits when the installer or `isomux-oom-protect` runs, and an
  ordinary `isomux-update` does not refresh them. After a resize the operator
  must run `sudo isomux-oom-protect`. Self-serve resize is not shipped.

  Recomputing the limits on activation still needs care rather than a
  one-liner: systemd establishes a unit's resource properties around activation,
  and a process inside the unit cannot casually rewrite its own parent cgroup
  policy. The clearest candidate is a **oneshot unit ordered before
  `isomux.service`** that computes the values and applies them to the
  still-inactive office unit; test it for ordering, idempotence and kernel
  readback. Two shapes that look equivalent are not. `ExecStartPre=` inside
  `isomux.service` is too late, since by then the unit's own activation and
  cgroup setup are already underway. A systemd generator runs at manager startup
  or `daemon-reload`, not on every ordinary service start, so it satisfies "on
  activation" only where the workflow guarantees a reload or a reboot. A plain
  systemd percentage (`MemoryMax=85%`) is tempting and does auto-track box size, but it
  cannot express "RAM minus a fixed reserve": 1 GB is 12.5% of an 8 GB box and
  4.2% of a 24 GB one, so one percentage either over-reserves on large boxes or
  under-reserves on small ones. Whichever shape is chosen, read the value back
  from the kernel afterwards rather than trusting that it applied.
- **Swap is a separate question and is not fixed by the above.** The shipped
  swapfile is a fixed 8 GiB, not derived from box RAM, and existing swap is
  deliberately left untouched. So recomputing the memory limits does nothing for
  swap. Whether swap should scale with RAM or tier at all is decision 4. If Nil
  chooses scaled swap, resize it during the upgrade's provisioning workflow, not
  on an ordinary service restart, since resizing live swap is disruptive.
- Where the target plan increases disk, that is the moment to revisit swap
  sizing, if it is being scaled at all.
- Because downgrades require a new box and a manual migration, the customer-
  facing job is to show the target's resources and cost clearly and to warn that
  moving back down means migrating. Do not advise upgrading one tier at a time:
  that only trades one disruptive upgrade for two.

## Decisions for Nil

**Ruled 2026-07-31**: decision 1 (ship both tiers, entry positioned for
customers not running many agents at once) and decision 3 (publish no
concurrency numbers). Both are folded into the sections above and left here for
the record. Decision 2 is **deferred** (Nil, 2026-07-31): the
refuse-above-pressure mechanism reads as too finicky for now; the hard fence
stands alone, revisit only if it proves to be the needed piece. Decisions 4
and 5 remain open, and 4 wants the benchmark's swap arm first.

Note on decision 2, since it came up: the cap under discussion is a **memory**
cap, not a disk cap. Disk is not scarce on these boxes; a 100 GB SSD comfortably
holds an office, and it is RAM that runs out.

1. **RULED: ship both tiers.** 8 GB fits one build plus ~12 agents, and a
   customer who kicks off a second build loses a process to the OOM killer,
   ideally an agent but see the blast-radius caveat above. Rather than choose
   between margin and a never-degrading first experience, entry ships positioned
   for customers who do not run many agents at once, with the larger tier
   alongside it. The degradation risk is therefore real but self-selected, which
   raises the stakes on decision 2 (what the office does at its cap) and on the
   upgrade path being easy.
2. **What an office at its cap does.** (a) Hard fence only: a process is
   selected and killed, today's behavior, zero build. (b) Refuse new turns above
   a watermark with a banner. (c) Queue them and drain as memory frees. I'd ship (b): queueing
   invites a customer to pile up work that then all lands at once. But whether
   a paid product may say "not now" is a product call, not mine.
3. **RULED: publish no concurrency numbers.** Public copy stays vague and
   capability-phrased, per the copy rules. The figures in this doc are for
   internal sizing only.
4. **RULED (Nil, 2026-08-02): the swapfile goes to 8 GiB.** What hurts is swap
   *exhaustion*, not swap size: at a load where 2 GiB is used to the last
   megabyte, p95 turn latency is 30.7 s against 3.4 s with 8 GiB under identical
   load. Keeping 2 GiB is the worst of the three tested options, and the question
   behind the decision is answered - leaning on disk instead of RAM is a
   usability problem at any size, since even 8 GiB runs ~12x the unloaded p95, so
   swap is a safety net and not headroom to sell.

   Shipped in task 99d7f273: `deploy/oom-protect.sh` makes an 8 GiB swapfile on
   a box that has none, taking the largest whole GiB a small disk can hold
   rather than nothing, floored at the 2 GiB boxes used to get.

   **Swap a box already has is reported and left alone**, so an existing box
   keeps its 2 GiB until an operator changes it - the run prints the commands.
   Automatic replacement was written and then withdrawn in review: it needs a
   `swapoff` and then a window where the old file is deleted and the new one is
   not yet proven, and a failure in that window leaves a live box with no swap
   at all. `/swapfile` is also the conventional path on Ubuntu and cloud images,
   so its presence is no evidence isomux created it. Doing this automatically
   needs an ownership marker and a rollback that re-enables the old file on
   every failure path; that is a separate change from a size constant.

   The `MemorySwapMax` value the benchmark could not settle was measured
   separately - see "The MemorySwapMax cap, measured" in the results note. It
   is an input to item 2 of the sequencing below, not something the swapfile
   change ships on its own: a swap cap without the `MemoryMax` fence beside it
   would change behaviour under global pressure in a regime nothing has
   measured. The original framing follows.

   **OPEN. Hosted swap: keep 2 GiB, or go larger on the entry tier?** Larger
   swap lets an 8 GB box ride out a build spike instead of losing a process, at
   the cost of a slow office. This contradicts the shipped small-swap rationale,
   which is why it is here rather than decided. It also sets `MemorySwapMax`,
   and it is the same question as "is leaning on disk swap instead of more RAM a
   usability problem?". The swap arm of benchmark 6ce6b700 answers it; do not
   decide it from first principles.
5. **OPEN. US pricing.** Contabo's non-EU surcharge plus metered traffic makes a
   US-West customer structurally more expensive. Absorb it into one global
   price, or price regions separately? Sharper under a thin-margin philosophy: a
   single global price has to be set by the most expensive region, which means
   EU customers subsidise US ones.

## Sequencing

Ships with the provisioning-hardening pass alongside eeaa8b4d (root
reachability), per f057617f. Order:

1. Land the SDK bump (c641fff6), then run benchmark 6ce6b700 on the pilot box.
   Everything numeric here depends on it, including decision 4.
2. The cgroup drop-in (`MemoryHigh` / `MemoryMax` / `MemorySwapMax`), with the
   `MemoryOOMGroup`/`OOMPolicy`/`Restart` interaction verified rather than
   assumed, and every value read back from the kernel rather than trusted from
   config. The `oom_score_adj` stamp on agent processes belonged here too, but
   it was accepted (D4) and shipped ahead of the rest on 2026-08-01, as an
   in-server sweep rather than at spawn time. `OOMPolicy=continue` followed it
   on 2026-08-02 (task e05a5cd4) for the same reason and the opposite one: the
   interaction is no longer assumed (it was measured, seven ways), and the
   policy is worth nothing without the stamp the box already had. The cgroup
   drop-in shipped in code on 2026-08-20 with the measured `MemorySwapMax`
   value (task fa00291e). Paid-launch acceptance remains the N=24-plus-build
   run on a release-shaped box (task 5a8e4b08). See the STATUS section at the
   top.
3. PSI and `memory.events.local` telemetry, and the "stopped under memory
   pressure" attribution in the agent's chat.
4. Graceful degradation, once decision 2 is settled.
5. Recompute `MemoryHigh`/`MemoryMax` on activation rather than writing them
   once at install, so a resized box picks up its new size, via a oneshot unit
   ordered before the office (not `ExecStartPre=`). `MemorySwapMax` is applied
   or recomputed as decision 4 dictates: unlike the other two it may end up a
   fixed policy rather than RAM-derived. Swapfile sizing is separate again and
   only in scope if decision 4 chooses scaled swap. See the upgrade path.

Tier prices stay provisional until the 2026-08-02 steal readout confirms
Contabo as the supplier.

## Follow-ups, all filed as their own tasks

This lane found three problems in shipped code and fixed none of them, being
doc-only. Each is now tracked separately, and the fix design in each is queued
for Nil rather than settled here:

- **a51393e7 (P2)**: earlyoom's `--avoid` shields agent-spawned `bun` builds,
  because it matches process names and `bun` is on the list to protect the
  office server. Detail in the mechanism section above. **Fixed 2026-07-31**:
  the server names its own process `isomux` at startup and `--avoid` shields
  that instead, so a build stays `bun` and stays a candidate.
- **c5b4e89e (P2)**: user-level installs' OOM protection is a no-op, config
  `-500` against runtime `100`. Acceptance requires reading
  back `/proc/PID/oom_score_adj` rather than trusting `systemctl show`, since
  that is precisely how this trap was set. **Cause established and fixed
  2026-07-31**, see the mechanism section above.
- **21bc0e19 (P3)**: `isomux-oom-protect`'s kill-order comment contradicts
  itself and would mislead a maintainer about who dies. Behavior is fine; the
  comment is not.

The `oom_score_adj` stamp on agent processes was likewise a Nil call, being a
scope addition rather than a provisioning default. **Accepted 2026-07-31 (D4) and
shipped 2026-08-01 as task 37b194be**, in the server rather than at spawn time.
Two follow-ups it leaves behind, both his: whether earlyoom's `--prefer` list
still earns its place now that agents carry their own bias, and the
`user@<uid>.service` floor.
