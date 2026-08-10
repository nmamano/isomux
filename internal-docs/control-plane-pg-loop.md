# Control-plane Postgres loop (standing orders)

Third control-plane loop: port the store from bun:sqlite to Postgres,
authorized by Nil 2026-08-10 (roadmap settled at handoff; provider for
deploy is Neon). Same conventions as the previous loops (their standing
orders live in git history: `git show
08486cf:internal-docs/control-plane-loop.md` and `git show
b1213a9:internal-docs/control-plane-ui-loop.md`). Workers re-read this
whole file each slice, plus `internal-docs/control-plane-design.md`
(rulings final) and `control-plane/README.md`. Delete this file at loop
close.

North star: a control plane whose store runs on Postgres under BOTH Bun
and Node, preserving every CAS/lease/transaction semantic slices 2-5
built, so the deploy loop (web on Vercel, provisioner on a small host,
database on Neon) stops being blocked by the measured wall: `next start`
under Node dies on bun:sqlite, `bun --bun next start` dies in Next's
compiled runtime - there is no working production server today
(measured 2026-08-10).

The port is a REPLACEMENT, not a second engine: bun:sqlite leaves the
tree. The store's concurrency suites are the safety net, and a safety
net that exercises an engine we no longer ship would guard nothing.

Cut (the async flip and the engine swap are separated so each diff is
reviewable - the first is wide but shallow, the second narrow but deep):

- P1: async API flip - Store and billing-store become Promise-based,
  every caller awaits, engine unchanged, zero behavior change.
- P2: engine swap - Postgres schema and driver, transaction/CAS
  semantics preserved, test infra (local docker + GitHub CI service),
  bun:sqlite deleted.
- P3: the payoff - production web server under Node against Postgres,
  live exercise transcripts, Neon-readiness, docs.

## Rulings (final)

1. All design-doc rulings stand, plus every ruling of the previous
   loops: R-2026-08-09-1 (fail-closed expiry ceiling), R-2026-08-09-3
   (30-day access-window backstop), R-2026-08-10-1-AMENDED (async
   one-shot invite seam), R-2026-08-10-2 (60s liveness cadence, 5-min
   claim), R-2026-08-10-3 (retention beats provider term).
2. Nothing deploys during this loop. No Vercel, no fly.io, no DNS
   writes. Neon account/project creation is Nil's pre-deploy action
   (end-of-loop queue); no worker creates or signs up for anything.
3. Store semantics are LOAD-BEARING and survive the port unchanged:
   version-CAS on every mutation with losers re-reading, one-statement
   arbiters (lease take, liveness claim, deadline flag, name
   reservation), the two-boundary lease rule (time fences beginning
   work, version/holder fences recording results), partial-unique-index
   arbitration, audit append only inside a transaction, the
   billing-store's writer-set split. Any place the port cannot express
   one of these identically is a plan-gate topic, never a silent
   approximation.
4. Money rails: Stripe test mode only; real-box work uses the recycled
   test box 203474835 only (paid through 2026-08-29), list first, never
   a second box, report any paid action immediately. Provider spend
   target: EUR 0. cp1.test.isomux.app is LE-rate-limited until
   ~2026-08-16; cp2.test.isomux.app has cert budget.
5. No secrets in code. Boolean checks only on ~/nil/secrets/. The
   Postgres connection string is configuration, not a secret to embed;
   test credentials for the local dockerized Postgres are throwaway and
   may be plain.

## Manager-accepted defaults (reversible unless marked)

- Driver: must run under BOTH Node and Bun (this is the point of the
  port). `pg` (node-postgres) is the presumed choice; `postgres`
  (porsager) is acceptable if the plan-gate argues it. Bun.sql is
  REJECTED (Bun-only, marked non-reversible).
- Times stay integer epoch milliseconds, but the columns must be
  `bigint` in Postgres (ms epochs overflow 32-bit `integer`), and the
  driver must return them as JS numbers, not strings (pg returns
  bigint as string by default - parser config is part of the work, and
  a test must pin it).
- Booleans stay 0/1 integers; JSON stays serialized TEXT parameters;
  ids stay text; the audit seq stays the `sequences`-row bump. The
  row-type interfaces in store.ts keep their shapes.
- Isolation level: READ COMMITTED, argued from the one-statement
  arbiters (every mutation is a single UPDATE/INSERT carrying its own
  predicate, so no lost update needs SERIALIZABLE). If the plan-gate
  finds a multi-statement invariant that read committed cannot hold,
  that is a manager escalation, not a silent isolation bump.
- `CONTROL_PLANE_DB` keeps its name; its value becomes a postgres://
  connection string. No new env vars without a plan-gate reason.
- Tests run against a REAL local Postgres (docker, e.g. postgres:16
  matching Neon's major) with per-test isolation; GitHub build.yml
  gains a postgres service so the suite runs unconditionally in CI. A
  local run without Postgres fails loudly with instructions - no
  silent skip anywhere, and CI must be structurally unable to skip.
- The web app keeps its store boundary (services.server.ts remains the
  only opener, boundary test stands). Whether the request-time dynamic
  import stays (its bun:sqlite reason dies with the port; its
  module-graph reason may stand) is a P3 plan-gate topic.

## Standing rails (prohibitions)

Same as the previous loops, restated short: no commits/prettier by
workers (manager owns both), one slice in flight, work in main, freeze
+ fingerprint against the merge base + formal reviewer approval on the
exact fingerprint, end turn after any gate request, surface permission
denials instead of working around them, no isomux server code changes,
no restarts, no DNS writes, no deploys, no new cloud accounts.

Harness caveat (task 6957e90d): long-running foreground Bash calls can
be auto-rejected mid-flight and kill the backend. Run gates as separate
short calls; use harness-tracked background commands for the full
suite; never chain sleeps or poll in until-loops. If your session dies
this way, the manager resumes it - report the interruption, verify any
mutation-cycle files are pristine before continuing.

next-env.d.ts is rewritten by any `next dev`/`next build` run: restore
it (`git checkout control-plane/web/next-env.d.ts`) before
fingerprinting.

## Process per slice, gates, decision protocol

Identical to the previous loops (see `git show
08486cf:internal-docs/control-plane-loop.md`, sections "Process per
slice", "Gates", "Decision protocol"). Gate baseline every slice: full
`bun run ci` green, eslint clean on touched files, mutation statement,
all user-visible prose verbatim in the report.

## End-of-loop queue

- Nil pre-deploy action (does not stall the loop): create the Neon
  project for the control plane, store the connection string under
  ~/nil/secrets/. Joins the existing pre-launch list (Google OAuth
  client, CONTROL_PLANE_MINT_TOKEN/URL).
- Operator note carried from the previous loop: the pre-slice-2 file
  at ~/.isomux-control-plane/control-plane.db is now doubly obsolete
  (sqlite itself retired). Proposal at close: Nil deletes it.
- P2 makes `bun run ci` require a local Postgres (docker). This
  changes the contributor story for the public repo - README wording
  for it gets copy sign-off at close.

## Slice checklist

- [ ] Slice P1: async API flip (Isomuxer1 / Reviewer1)
- [ ] Slice P2: engine swap to Postgres (Isomuxer2 / Reviewer2) -
      pickup finalized after P1 lands
- [ ] Slice P3: production server, live proof, Neon-readiness, docs
      (Isomuxer1 / Reviewer1) - pickup finalized after P2 lands

## PICKUP: Slice P1 - async API flip (Isomuxer1 / Reviewer1)

Goal: `Store`, the billing-store functions, and every module-level
helper over them become Promise-based; every caller awaits; the engine
stays bun:sqlite; behavior is byte-identical. The whole suite is the
oracle: it must pass unchanged in what it asserts (test code gains
awaits, never different expectations).

Load-bearing mechanics and traps:

- `tx` becomes `async tx<T>(fn: () => Promise<T> | T): Promise<T>`.
  The depth guard STAYS and its "nested transaction" error must still
  fire; under the single sqlite connection a concurrent `tx` entered
  during an await inside another `tx` is a programming error surfaced
  by that same guard (P2 revisits concurrency with per-transaction
  connections; not P1's business).
- Every method flips, readers included (`getInstance`, `listInstances`,
  `auditEvents`, ...). A half-async API would make P2's engine swap
  change signatures again and re-touch every caller twice.
- The dangerous defect class is a DROPPED AWAIT: `if (!store.casX(...))`
  is always-truthy on a Promise and silently deletes the "loser
  re-reads" path. The fence is type-aware eslint
  (`@typescript-eslint/no-floating-promises` +
  `no-misused-promises`) scoped to control-plane, added in this slice
  and left permanently in the config. Plan-gate the config mechanics
  (type-aware linting needs parserOptions.project); the rule landing
  is acceptance, not optional.
- Call-site classes to sweep: loops with CAS inside (mechanical);
  `Array.prototype.map/filter/find` callbacks that become async
  (NOT mechanical - a map over an async fn yields Promise[]; each site
  needs a deliberate for-loop or Promise.all with an ordering
  argument); expression positions like ternaries and `??` chains over
  reads. Files: driver, handlers, tick, lifecycle-tick, lifecycle,
  liveness, liveness-watch, cancel, deprovision, reboot, resume,
  signup, requests, intents, invite-hold, mint-seam, progress, ops,
  operations, attention, attention-ack, audit, instance, report,
  run-record, create-latch, create-coordinator, access, operator,
  operator-admin, keys, cli, billing-cli, stripe/*, exercises/*,
  fixtures/*, web/lib/services.server.ts, and every test.
- web: services.server.ts internals gain awaits; its exported
  signatures are already Promises, so pages should not change. The
  web-boundary test must stay green untouched.
- Do not reorder statements around awaits inside `tx` bodies: the
  transaction boundary comments in store.ts state which statements
  commit together, and P1 must not move any statement across a
  boundary.

Acceptance:

1. Full `bun run ci` green (includes ci:web - the Next build must
   still pass with the async seam).
2. The new eslint rules active on control-plane and the tree clean
   under them.
3. Mutation statement: at no fewer than 8 sites spread across store
   semantics, driver/tick logic, and billing reconciliation, remove a
   single `await` (or re-truthy-test a Promise) and show a test OR the
   lint fails - naming which caught each. At least 3 of the 8 must be
   caught by a TEST, not only the lint (the lint could be
   misconfigured; the suite is the deeper net).
4. No behavioral diff: no test expectation changed, no SQL changed, no
   schema changed.

Decide with the reviewer: eslint type-aware config mechanics (flat
config + projectService vs project list); whether exercises/CLIs get
a top-level-await pattern or a main() wrapper; Promise.all vs
sequential at multi-read sites (default sequential - this is a
correctness refactor, not a performance pass).

Locked: standing rails; no engine change, no schema change, no SQL
text change, no new runtime deps (dev-deps for lint tooling fine), no
semantic change anywhere; store.ts comments updated only where they
say "synchronous".
