# Hosted sizing and tiers

Design for task f057617f (memory capacity, OOM isolation, per-office resource
defaults). Companion to `hosted-isomux-design.md` (single-tenant-per-VPS) and
the Contabo supplier pilot (task b223ebc3).

## Already shipped: reference, do not re-design

`deploy/install.sh` (`configure_oom_protection`, installed as the re-runnable
`/usr/local/sbin/isomux-oom-protect`, `--dry-run` supported) already gives every
new box:

- **earlyoom** at `-m 10,5 -s 100,100`, `--avoid`
  `systemd*|sshd|tailscaled|caddy|earlyoom|bun`, `--prefer`
  `claude|codex|node|chrome`. Something is killed while there is still memory to
  act with, instead of the box thrashing into the kernel's last-resort killer,
  and the regexes are what express the intent that the victim be an agent.
- **`OOMScoreAdjust` tiers** written to unit drop-ins and to the running PIDs,
  so applying them restarts nothing but earlyoom: ssh + tailscaled `-900`,
  caddy + isomux `-500`.
- **`vm.swappiness = 10`**, and a **2 GiB swapfile** created only when the box
  reports zero total swap, `/` has the space, and `/swapfile` does not already
  exist. Existing swap of any size is left untouched.

The 2 GiB figure is a deliberate reversal of the 8 GB swapfile added by hand
during the incident: large swap lets a box keep allocating long past the point
it can still respond. Tier work builds on the small-swap stance, it does not
undo it (but see decision 4).

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
  biased toward a `claude` process instead. Worth fixing by protecting the server's PID rather
  than the name `bun`; out of scope here, and noted in the follow-ups.
- The `OOMScoreAdjust` tiers protect *reachability*: ssh and tailscaled at
  `-900` sit far below anything else on the box, so they go last. Those two are
  system units in every deployment shape, so that half holds everywhere. The
  office's own `-500` is the part that varies by shape (measured below): on a
  system-level install it applies and is over-broad, since it shields everything
  the office spawns as well; on a user-level install the shipped drop-in targets
  a system unit that does not exist, and a hand-placed user drop-in is silently
  ineffective anyway.

What the tiers do **not** do is order agents against the office server.
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
is silently ineffective there and the protection is a no-op; the cause is not
established. Note that the incident work verified a user manager *accepts* the
directive, which is exactly the trap: acceptance of a written value says nothing
about the effective one.

**Design principle from this.** Assert the effective value, not the written
config. Any memory or OOM setting this design adds should be verified by reading
back what the kernel actually holds for the process, the same lesson the
harden-ssh work reached independently.

**Proposed fix, cheap and unprivileged.** Have the office stamp a positive
`oom_score_adj` on each agent process at spawn. Raising the value needs no
privilege; only lowering it does. Verified on the office box: a process at
`100` can set itself to `300`, and is denied at `50` without
`CAP_SYS_RESOURCE`. So a server at `-500` can put its own agents decisively
above itself, and the kernel-side order stops depending on badness-score
heuristics. Descendants inherit the stamp, so a build inherits its agent's.

This is a **scope addition**: it is code on the spawn path, not a provisioning
default like the rest of this design, and it needs Nil's acceptance before being
sequenced as mandatory. It also has to be applied on the user-unit path to fix
that case, which is desirable given the no-op measured above.

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
MemorySwapMax = <set explicitly> # see below; unlimited by default
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
swap, so without it an office can push into swap up to whatever the box has.
Today that is bounded only by the shipped 2 GiB swapfile, which makes the
reachability argument depend on a global default rather than on the unit's own
limits. Decide it with decision 4, since the two interact.

earlyoom stays as the box-wide layer, unchanged, and the two layers cover
different failures. earlyoom does not observe cgroup-local pressure; when host
`MemAvailable` remains above its threshold, it will not intervene before a
cgroup reaches `MemoryMax`. Under genuinely global pressure both can fire.

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
| Team | Contabo ~24 GB tier (vCPU + disk to confirm at order) | **EUR 11-13** | 23 GB | 2-3 (est) | ~55 (est) |
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

  The requirement is therefore that the limits be recomputed on activation, not
  written once at install. How to implement that needs care rather than a
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
  swapfile is a fixed 2 GiB, not derived from box RAM, and existing swap is
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
4. **OPEN. Hosted swap: keep 2 GiB, or go larger on the entry tier?** Larger
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
   config. The spawn-time `oom_score_adj` stamp belongs here too, but only if
   Nil accepts it as a scope addition.
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
  office server. Detail in the mechanism section above.
- **c5b4e89e (P2)**: user-level installs' OOM protection is a no-op, config
  `-500` against runtime `100`, cause unestablished. Acceptance requires reading
  back `/proc/PID/oom_score_adj` rather than trusting `systemctl show`, since
  that is precisely how this trap was set.
- **21bc0e19 (P3)**: `isomux-oom-protect`'s kill-order comment contradicts
  itself and would mislead a maintainer about who dies. Behavior is fine; the
  comment is not.

The spawn-time `oom_score_adj` stamp is likewise a Nil call, being a scope
addition rather than a provisioning default.
