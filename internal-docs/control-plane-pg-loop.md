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

- [x] Slice P1: async API flip (Isomuxer1 / Reviewer1). DONE
      2026-08-10: approved pre-format fingerprint
      6ecceb711011a42d8b4125dceab77e99 (verified byte-exact before
      formatting), committed 4dbecab. 87 files; suite 4076/0 incl.
      691 control-plane; SQL-multiset and expect-line audits prove no
      semantic drift. Key facts for P2: Store.open replaces new Store
      (constructor private, init failure closes the handle and
      rethrows unwrapped); raw SQL goes through sqlAll/sqlGet/sqlRun
      (db private; tx control routes through sqlRun so the
      failed-COMMIT injection seam survives); type-aware lint fence
      lives in BOTH eslint configs (root config ignores
      control-plane/web); interim caller rule "a tx body may await
      only store calls, never remote I/O or timers" is a P1 stopgap
      that P2 replaces with per-transaction connections; four
      pre-existing dropped audit awaits fixed (reboot, resume,
      deprovision, stripe/suspension); unawaited expect(p).rejects is
      deliberate (awaiting trips await-thenable under bun types).
      Product-visible consequences: none (README section only).
      Three 6957e90d harness kills during the slice, all recovered by
      same-session resume.
- [x] Slice P2: engine swap to Postgres (Isomuxer2 / Reviewer2). DONE
      2026-08-10: approved pre-format fingerprint
      4847347df6a93b0974288d43996038fd (verified byte-exact), committed
      8fb8b8d. 59 files, +2586/-581. First diff gate REJECTED with two
      measured 23505 races (liveness + account initializers) - the
      reviewer measured, the worker reproduced on the frozen tree
      before fixing; both now have invariant-specific recovery and
      barriered two-backend tests. Key facts for P3: driver pg 8.23.0
      in root AND web packages (Node needs it at next build); tx via
      AsyncLocalStorage per-transaction connections (concurrent tx
      legal, nesting throws); Store.recoverable savepoint scope at 4
      catch-and-carry-on sites; FOR SHARE authority read; COMMIT-tag
      false-receipt guard; bigint parser is pool-scoped; tests need
      the isomux-cp-pg container (port 5433, schema recycling -
      96.5ms fresh vs 23ms recycled); CONTROL_PLANE_DB is now a DSN
      with no default and redacted in every error; web store-per-
      request is now pool-per-request (P3 deployment question);
      request-time dynamic import's remaining reason is module-graph
      only (P3 topic); README runtime matrix dated pre-port - Node
      next start is P3's to measure. One flake worth remembering: a
      lock-wait test that passed alone and failed in-suite (waiter
      outran holder) - "passed in isolation" is how that class
      survives. 14/14 mutations caught. Contributor README wording
      queued for Nil sign-off at close.
- [ ] Slice P3: production server, live proof, Neon-readiness, docs
      (Isomuxer1 / Reviewer1) - pickup finalized after P2 lands

## PICKUP: Slice P2 - engine swap to Postgres (Isomuxer2 / Reviewer2)

Goal: store.ts and the billing-store speak Postgres through a driver
that runs under BOTH Node and Bun; every semantic in ruling 3
preserved; tests run against a real local Postgres with per-test
isolation; GitHub CI gains a Postgres service; bun:sqlite leaves
control-plane entirely. P1 froze the API so this slice touches
callers only where the connection string and error shapes force it.

Load-bearing mechanics and traps:

- Driver: `pg` presumed (standing defaults); argue any alternative at
  the plan gate. The bigint problem is real: every time column is
  epoch MILLISECONDS and must become `bigint` in Postgres, and pg
  returns bigint as a STRING by default - parser config must return JS
  numbers (safe: ms epochs sit far below 2^53), pinned by a test that
  round-trips a written timestamp and asserts typeof number.
- Placeholders: sqlite's `?` becomes `$1..$n`. P1 deliberately froze
  SQL text; P2 is where it legitimately changes. The SQL-multiset
  audit does not apply this slice - the reviewer reviews SQL changes
  directly instead. No semantic change rides along with the syntax
  change; `returning *`, partial unique indexes, check constraints
  and the sequences-row bump all carry over as-is.
- tx: per-transaction connection (pool checkout), replacing the P1
  single-connection stopgap and its no-I/O-inside-tx caller rule.
  What replaces the depth guard is a plan-gate topic with a hard
  requirement either way: nesting must still throw, and the
  transaction boundary comments in store.ts (which statements commit
  together) must hold on the wire - statements of one tx must not
  interleave onto another tx's connection.
- Isolation: READ COMMITTED per standing defaults, argued from the
  one-statement arbiters. Every CAS is a single UPDATE carrying its
  predicate, so row locks resolve the races the concurrency suites
  pin. If any invariant needs more, escalate to the manager - no
  silent isolation bump.
- Durability: the store header's "a commit that has not reached the
  disk is not a latch" survives as synchronous_commit=on (the
  default; do not turn it off anywhere, and note Neon honors it).
  The pragma calls go away; busy_timeout has no equivalent needed
  (row locks queue), but pick and justify connect/statement timeouts
  at the plan gate.
- Error mapping: signup.ts's isUniqueViolation must recognize
  Postgres unique_violation (SQLSTATE 23505) - it currently matches
  SQLITE_CONSTRAINT codes and sqlite message text. Sweep for every
  caller that catches constraint failures (name reservation, create
  latch, liveness ensure, billing inserts), and pin the mapping with
  a test that provokes a real 23505.
- assertSchemaIsCurrent: `pragma table_info` becomes
  information_schema.columns (same refuse-by-name behavior, same
  error message shape naming the database instead of the file).
- Connection config: CONTROL_PLANE_DB keeps its name, value becomes a
  postgres:// URL (standing default). Everything that passed a file
  path to Store.open flips: cli, billing-cli, exercises, fixtures,
  web services.server.ts (CONTROL_PLANE_DB is already its env
  contract), and every test. HOME-override state roots stop carrying
  the database (they still carry keys/artifacts).
- Test infra: one local Postgres (docker, postgres:16 to match Neon's
  major) with per-test isolation - database-per-test-file or
  schema-per-test, mechanics plan-gated; the bar is the current suite
  stays green and does not blow past roughly 2x its present runtime.
  A run without Postgres fails loudly with one-line instructions
  (docker run command included); no silent skip anywhere. GitHub
  build.yml gains a postgres service container so CI cannot skip;
  validate the workflow change by running the same steps locally
  against the same service configuration.
- bun:sqlite: after this slice `grep -rn "bun:sqlite" control-plane/`
  (excluding web/node_modules) returns nothing. web/bun-types.d.ts
  loses its shim if that was its only purpose.
- The five preserved injection seams from P1 (failed COMMIT among
  them) must survive the swap - they route through sqlRun, so they
  should; the reviewer verifies reachability, not just presence.
- Concurrency suites get STRONGER here: racing name reservation,
  overlapping liveness claims, lost successor, stale fences now run
  on genuinely concurrent connections. If any of them was quietly
  depending on bun:sqlite's single-writer serialization, this slice
  is where that surfaces - treat such a failure as information about
  the test or the invariant, never patch it silent.

Acceptance:

1. Full `bun run ci` green with the dockerized Postgres up; the
   control-plane suite (691+) green against real Postgres.
2. The concurrency suites demonstrably exercising Postgres (show the
   connection evidence, not just green).
3. bigint-as-number parser and 23505 mapping each pinned by a test.
4. bun:sqlite gone from control-plane; boundary tests still green.
5. build.yml carries the postgres service; the CI steps run green
   locally against an identical service config.
6. Exercises and CLIs run against a local Postgres (document the
   one-liner that starts it).
7. Mutation statement, no fewer than 6 sites across: a version
   predicate removed from a CAS (test must fail), the lease predicate
   removed from tryLease, the bigint parser config removed, the 23505
   mapping broken, a per-transaction connection reuse bug simulated,
   the partial-index predicate dropped. Name which net catches each.
8. No deploy, no Neon calls (no credentials exist; Neon-readiness is
   P3 documentation work).

Decide with the reviewer: driver final call; pool sizing and
lifecycle (a CLI one-shot vs the long-lived tick process); tx
nesting-guard mechanism; placeholder translation approach (rewrite in
place vs a tiny translator - bias to rewrite in place, the SQL is the
readable artifact); per-test isolation mechanics and teardown; how
the docker requirement lands in `bun run ci` (compose file vs raw
docker run vs testcontainers).

Locked: standing rails; ruling 3 semantics; row-type interfaces keep
their shapes (numbers stay numbers); no new env var names;
CONTROL_PLANE_DB reuse; READ COMMITTED unless escalated; the P1 lint
fence stays exactly as pinned; contributor-story README wording gets
drafted here but its copy sign-off waits for loop close.

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
