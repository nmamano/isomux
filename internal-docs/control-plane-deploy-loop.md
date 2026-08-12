# Control-plane deploy loop (standing orders)

Fourth control-plane loop: deploy the control plane for real - web app on
Vercel at cloud.isomux.com, store on Neon Postgres, provisioner on fly.io -
authorized by Nil 2026-08-11 (slice cut approved in chat). Conventions
identical to the previous loops; their standing orders live in git history:
`git show 08486cf:internal-docs/control-plane-loop.md`,
`git show b1213a9:internal-docs/control-plane-ui-loop.md`,
`git show 52e384e^:internal-docs/control-plane-pg-loop.md`.
Workers re-read this whole file each slice, plus
`internal-docs/control-plane-design.md` (rulings final) and
`control-plane/README.md`. Delete this file at loop close.

North star: the control plane running deployed - `next start` on Vercel
serving cloud.isomux.com against Neon, the provisioner ticking on fly.io
with the key master and provider credentials, and one full
signup -> provision -> handoff -> cancel pass through that deployed stack
against the recycled test box. The Postgres port broke the production wall
(committed evidence: `control-plane/web/e2e/production-server.e2e.ts`);
this loop walks through it.

Cut (approved 2026-08-11):

- D1: Neon readiness - the real Neon project carries the schema and passes
  the suites; bootstrap procedure codified. No new accounts, no deploys.
- D2: provisioner to fly.io - packaged, deployed, ticking, secrets held as
  fly secrets, attention surfacing verified.
- D3: web to Vercel - project, env wiring, production deploy, Google OAuth
  live, cloud.isomux.com serving.
- D4: end-to-end + ops floor - the full customer pass through the deployed
  stack against test box 203474835; operator runbook; close-out.

## Rulings (final)

1. All rulings of the previous three loops stand, including the design-doc
   rulings, R-2026-08-09-1 (fail-closed expiry ceiling), R-2026-08-09-3
   (30-day access-window backstop), R-2026-08-10-1-AMENDED (async one-shot
   invite seam), R-2026-08-10-2 (60s liveness cadence, 5-min claim),
   R-2026-08-10-3 (retention beats provider term), retention = 1 calendar
   month, grace week.
2. Deploy targets are fixed: web = Vercel (Nil's existing personal team;
   new project, default name `isomux-control-plane`), DB = the existing
   Neon project `isomux-control-plane` (pg18, Frankfurt), provisioner =
   fly.io. Public hostname: cloud.isomux.com (settled in
   `internal-docs/hosted-isomux-design.md`).
3. Vercel plan: Hobby through this loop; Pro upgrade when checkout goes
   live (Nil, 2026-08-11). isomux.com already runs on this team.
4. Neon branch discipline (Nil, 2026-08-11): suites and e2e runs target a
   CHILD branch of the Neon project, never the production branch. The
   bootstrap procedure is codified and run against the production branch's
   empty state (schema only - no test data ever lands there).
5. Neon connections use the DIRECT endpoint, not the pooled `-pooler`
   host (the pooled endpoint rejects the startup-parameter timeouts;
   `control-plane/README.md` documents this). DSN lives in
   `~/nil/secrets/control-plane-neon.env`; account-wide Neon API key in
   `~/nil/secrets/neon.token`.
6. DNS reality (Nil, 2026-08-11): only the isomux.app zone is on
   Cloudflare (migrated 2026-08-10). isomux.com is still on Namecheap
   BasicDNS and carries live email forwarding (llc@) - it is not migrated
   casually. The `cloud` CNAME is added by Nil in Namecheap when D3 hands
   him the exact record, unless the manager proposes an isomux.com
   migration mini-runbook first (isomux.app runbook pattern, with the
   email-forwarding branch handled). No DNS API token exists and nothing
   in this deployment automates DNS.
7. Cloud accounts: no worker creates or signs up for anything. The fly.io
   app is created at D2 start under Nil's account (approved 2026-08-11,
   pending his dashboard check for an existing app); the API token lands
   in ~/nil/secrets/ first, smallest machine tier, and any paid action is
   reported immediately. Provider spend target for customer boxes stays
   EUR 0: test box Contabo 203474835 only (paid through 2026-08-29),
   list first, never a second box. cp1.test.isomux.app is LE-rate-limited
   until ~2026-08-16; cp2.test.isomux.app has cert budget.
8. Secrets (two prior incidents; this is load-bearing): never shell-source
   an env file; env files carry single-quoted values; secrets are read
   inside the consuming process, never expanded in a logged shell; only
   boolean checks (`grep -qE` + echo ok/bad) and metadata on
   ~/nil/secrets/ files; never print any content-derived fragment of one.
9. Nil-side pre-launch items stay outside worker scope: Google OAuth
   client (Nil creates it before D3; manager re-sends the walkthrough at
   D3 dispatch), CONTROL_PLANE_MINT_TOKEN/URL, pricing (bf127061),
   terms/privacy final read (c1d6ed82), Vercel Pro upgrade.
10. R-2026-08-11-1 (connection governance, ruled on Isomuxer2's measured
   escalation): D3 deploys with the ungoverned web-tier worst-case
   aggregate recorded as a DATED FINDING (2026-08-11: Neon direct
   max_connections 901; Vercel publishes no concurrency ceiling on any
   plan; the pooled endpoint refuses the store's options string with
   SQLSTATE 08P01, correcting D1's README). The finding has a hard
   expiry: slice D3.5 lands an engine-or-pooler-enforced aggregate
   posture with a provisioner reserve BEFORE D4 begins, and D4 must not
   open any real signup path while the finding is open. Option B
   (role-level ALTER ROLE ... SET for both bounds, open-time read-back
   retained, pooled eligibility for the web tier) is the preferred
   shape; option A (a web role with CONNECTION LIMIT) may compose with
   it; the D3.5 plan-gate settles the design with measurements. Moving
   the bounds' enforcement point to the role while keeping the read-back
   that refuses to run unproved preserves the design's guarantee -
   implementation locus, not semantics. Per-instance pool hygiene stays
   an ordinary D3 plan-gate item.
11. R-2026-08-11-2 (D3 phase reorder): Vercel's automation bypass is
   REJECTED permanently - the bypass secret is injected into the app's
   runtime environment, a provider-side protection credential on the web
   tier. D3 therefore attaches the custom domain first (the only
   credential-free probe surface), Nil lands the CNAME, and the
   production deploy + full probe suite run as ONE sequence the moment
   DNS+TLS confirm; any failing probe detaches the domain before
   diagnosis. The public-before-probed interval is covered by the
   zero-customer justification and expires with it - this ordering is
   not a precedent for deploys after customers exist.
   AMENDED 2026-08-11 ~16:20Z: Vercel accepted the DNS (misconfigured
   false, ownership verified) but issued no certificate ~35 min on -
   plausibly because issuance waits for a production deployment
   (unproven hypothesis, worker-flagged). TLS confirmation moves INSIDE
   the one-sequence: production deploy first, bounded cert wait (15
   min, spaced reads), then the full probe suite over TLS. 'vercel
   certs issue' stays unapproved (LE rate-limit exposure on the loop's
   one hostname); if the bounded wait expires, park and escalate.

12. R-2026-08-11-3 (owner connection term; Nil delegated, manager ruled
   2026-08-11): Path 1 (ownership-transfer lockout of neondb_owner) is
   CLOSED INFEASIBLE on measurements - the reverse transfer requires
   membership in the old owner role, which nothing holds (0 members, 0
   admin-option grants) and which cannot be granted (42501), so the
   transferred state could be entered but never exited. The acceptance
   predicate is NARROWED to Isomux-created deployed automated consumers:
   W=40 (cp_web) + P=12 (cp_provisioner) = 52, each engine-enforced via
   rolconnlimit, vs usable ceiling 894 (842 unallocated, measured
   2026-08-11). neondb_owner is reclassified MANUAL BREAK-GLASS outside
   the aggregate: uncappable on managed Neon (ALTER refused 42501 from
   every available identity, measured 2026-08-11), DSN deployed nowhere
   after G3/G4 (held only in ~/nil/secrets/), used for
   migrations/bootstrap/tooling. Docs must state, dated: the owner term
   is provider-managed and uncappable; two provider login roles hold
   CONNECT outside our control; every aggregate claim is therefore
   scoped to roles we create (true of every design option, including
   the originally approved one). R-2026-08-11-1's closure condition
   adapts: post-G4 evidence shows legacy owner-DSN backends on
   Fly/Vercel drained/terminated, live per-role counts within 40/12,
   owner sessions zero in steady state; production evidence stays
   boolean (unchanged per table, accounts exactly 1). G2/G3/G4 remain
   separate reviewer gates; the live migration remains its own gated,
   reversible step.

## Lanes

Alternate Isomuxer1/Reviewer1 and Isomuxer2/Reviewer2 only (Nil,
2026-08-11); I3-I6 stay free for parallel work. The Postgres loop ended on
I1/R1, so: D1 = I2/R2, D2 = I1/R1, D3 = I2/R2, D4 = I1/R1. Manager clears
both lane sessions, then sets effort, then dispatches - in that order,
every slice. At most two worker lanes on this box, prefer one while any
lane runs builds or full suites.

## Standing rails (prohibitions)

As the previous loops, short: no commits/prettier by workers (manager owns
both), one slice in flight, work in main, freeze + fingerprint against the
merge base + formal reviewer approval on the exact fingerprint, end turn
after any gate request (silence is never approval), surface permission
denials instead of working around them, no isomux server code changes, no
restarts, no DNS writes, no new cloud accounts, no schema changes without
a plan-gate. Deploys are allowed only where the slice's pickup section
names them - nothing outside the named surface.

Gate baseline every slice: full `bun run ci` green (it typechecks; `bun
test` alone does not), plus the slice's own live evidence. Never pipe a
suite run through a filter in the same command - redirect to a file, then
`echo $?`.

Harness caveats: long foreground Bash calls can be auto-rejected mid-flight
and kill the backend - run gates as separate short calls, background the
full suite, never chain sleeps. If a session dies, the manager resumes it;
verify any mutation-cycle files are pristine before continuing.
next-env.d.ts is rewritten by any `next dev`/`next build`: restore it
(`git checkout control-plane/web/next-env.d.ts`) before fingerprinting.

## Process per slice, gates, decision protocol

Identical to the previous loops (see the git-history files above): worker
plan-gates with the reviewer before code, implements, runs gates, freezes,
fingerprints (`git add --intent-to-add . ; MB=$(git merge-base main HEAD);
git diff HEAD | wc -l` + `md5sum`), diff-gates on the announced
fingerprint until formal approval, then reports: what changed,
verification, verdict + fingerprint, all user-visible prose verbatim,
mutation statement, parked items. Worker-reviewer deadlocks go to the
manager; measured evidence beats plausible reasoning. Anything policy- or
money-shaped is PARKED FOR NIL in the end-of-loop queue unless it blocks
the slice.

## Slices

- [x] D1: Neon readiness (I2/R2) - approved fingerprint 98c6631 / 2297 /
      a6bc5ece31b244372d4f4b23eff9c089, commit 97c2821. Facts that outlive
      the slice: Neon silently drops timeouts sent as pool startup fields;
      they hold via the `options` startup parameter, and Store.open now
      verifies both bounds from the engine and refuses to open otherwise
      (measured 2026-08-11). A session proves its own branch
      (`neon.branch_id`); testing/target.ts fails closed on any remote
      target that cannot. Neon production is schema-ready and zero-user-data
      (bootstrapped 2026-08-11, idempotence re-run included); the `suites`
      child branch persists for D3/D4 - delete at loop close
      (`bun control-plane/exercises/neon.ts branch --delete suites`).
      Deployed DSNs: DIRECT host + sslmode=verify-full, no options needed.
      Full suite vs Neon: 732/0 in 9m15s (bun --timeout 30000 is
      load-bearing; no source timeout moved).
      ~/nil/secrets/control-plane-neon.env still holds the pooled host -
      tidiness item for Nil, nothing depends on it anymore. Three tests'
      assertions moved from engine prose to SQLSTATE codes (worker
      self-edit, reviewer-approved as stricter and portable).
- [x] D2: provisioner to fly.io (I1/R1) - approved fingerprint 77ab640 /
      2828 / f461eb8ed7d30d2ffdde65c0322e955e, commit dcef44f. Facts that
      outlive the slice: the provisioner is LIVE - app isomux-provisioner
      (org personal), machine 080e977db16d18 (shared-cpu-1x 256MB, fra),
      volume vol_rnz65n6qm378pn1r (1GB, encrypted, scheduled snapshots
      OFF - a manual snapshot would still carry 5-day retention, parked
      to the D4 ops floor with task 962965dc). Surface
      https://isomux-provisioner.fly.dev, bearer-enforced, /internal/health
      behind the same bearer. Spend: ~USD 1.94/mo machine + ~EUR 0.15/mo
      volume + Depot minutes (all reported live, 2026-08-11). Boot refuses
      without a proved branch pin or writable state marker; tick loop
      idles gracefully without Contabo creds (37-min measured window,
      zero operations, zero restarts). D3 reads the SAME bearer file
      (~/nil/secrets/control-plane-mint.env) and sets
      CONTROL_PLANE_MINT_URL to the fly surface. flyctl writes per-app
      bookkeeping into ~/.fly/config.yml - a changed md5 there is not an
      incident. Process lesson: scripted edits (sed) can silently no-op
      and report success - assert the change applied before running the
      check that depends on it.
- [x] D3: web to Vercel (I2/R2) - approved fingerprint 439ef15 / 9097 /
      35ff0b12590119c02b18c76ae4501a93, commits 439ef15 (mid-slice
      sign-in fix, so the archive artifact carried it) + ce7954d. Facts
      that outlive the slice: cloud.isomux.com LIVE, browser-verified by
      Nil 2026-08-11 - Google-only sign-in, dev-auth structurally absent,
      one idempotently-bound account row. Cert ordering (inference,
      bounded): attach -> DNS -> DEPLOY -> bounded TLS wait -> probe; the
      reverse produced no cert in 97 observed minutes. Pooled Neon host
      refuses the options channel outright (08P01) - D1's README claim
      corrected. AUTH_SECRET is write-only: synthetic authenticated
      probes are unrepeatable on redeploys, by design; real acceptance is
      a human in a private window. Vercel automation bypass permanently
      rejected (injects its secret into the app runtime). Carried into
      D3.5/D4 pickups: intent-to-add guard fix (classify against HEAD
      path set, not porcelain prefix); redeploy row expectation must
      become before/after comparison before customer #2; NO SIGN-OUT
      ROUTE in the app (task candidate). R-2026-08-11-1 stays OPEN, only
      its no-customers half standing - D3.5 closes it before D4. Process
      lesson (bitten twice this slice): scripted edits verified by grep
      after application, always.
- [x] D3.5: connection governance (I1/R1) - COMPLETE 2026-08-12,
      R-2026-08-11-1 CLOSED. Commits 84ceb32, 2ef3f7e, d6a1cb7, 070aaed,
      02939f2 + the close-out commit. G3 completed on retry via the reviewed
      executable (provisioner as cp_provisioner direct, probe accepted
      attempt 1, samples <=12, settled 1). G4 completed as a SUPERVISED
      MANUAL RUN by Nil after his proportionality call (executions-remaining
      rule: one run, one account, one-paste revert) - approved G4 tooling
      cancelled unimplemented, stash "D3.5 G4 tooling - CANCELLED by Nil
      2026-08-12" kept, task f5ed4b60 carries the redeploy-comparison fix.
      Facts that outlive the slice: web tier = cp_web on the DIRECT endpoint
      (40, engine-enforced); NO anonymous request opens the database - only
      an authenticated page load proves the serving role (applies to every
      future deploy acceptance, D4 included); the deployed-artifact LAG was
      the real G4 trap - cutover to a restricted role requires shipping the
      code that expects restriction (openRuntime existed since 84ceb32,
      never shipped; old artifact died 08P01 on pooled, 42501 on direct);
      the current build's pooled eligibility is suites-proved but NOT
      production-exercised - a future pooled move is its own gated step;
      pooled backends linger after client close and keep the last
      application_name - never read pid-absence-after-disconnect as
      evidence; vercel-env.ts has no update path (PATCH
      /v9/projects/{id}/env/{id} is the confirmed call, task-worthy if ever
      automated). Serving proof: signed-in GET -> cp_web backend 1, owner 0,
      provisioner 1; production-phase --redeploy from 02939f2 green (rows
      1/0/0/0, full anonymous suite). Executor deviations recorded: manager
      ran production-phase.ts --redeploy under Nil's explicit blanket
      approval; Nil personally ran the Neon SQL and Vercel dashboard steps.
      Reviewer1 evidence verdict at manual bar: see chat record 2026-08-12.
- [ ] D4: end-to-end + ops floor (I2/R2 - alternation shifted with the
      inserted D3.5 slice; pickup below)

## PICKUP - SLICE D4: end-to-end + ops floor (Isomuxer2 / Reviewer2)

Goal: the full customer pass through the DEPLOYED stack - signup ->
provision -> handoff -> cancel against Contabo test box 203474835 - plus
the operator runbook, closing the loop's north star.

Read first: this whole file end to end (the D3.5 tick note especially -
its findings bind D4's acceptance design), control-plane/README.md
("What the 2026-08-12 moves completed", connection posture, deploy
runbook), internal-docs/control-plane-design.md.

What exists (all 2026-08-12): both tiers deployed off the owner string -
web as cp_web (direct, 40), provisioner as cp_provisioner (direct, 12);
R-2026-08-11-1 closed; cloud.isomux.com serving with Google-only auth;
the fly surface bearer-guarded; production schema-ready with exactly
Nil's account row; the suites branch persists for rehearsal.

The work (plan-gate the exact cut with Reviewer2):
1. Contabo credentials into the provisioner (fly secrets, D2 wrappers,
   ruling 8 mechanics) - the first time real provider creds go live.
   Ruling 7 stands: test box 203474835 only, list-first, never a second
   box, every paid action reported the moment it happens.
2. The pass itself: one real invite minted through the deployed web,
   signup, provision onto the test box, handoff proof, cancel, asset
   teardown proof. cp1.test.isomux.app may still be LE-rate-limited
   (check date vs ~2026-08-16); cp2 has cert budget.
3. Acceptance design must honor the D3.5 finding: anonymous probes prove
   nothing about the serving role or store health - every store-backed
   acceptance step needs an authenticated or engine-side observation.
4. Ops floor: operator runbook (deploy, redeploy, rollback, break-glass
   owner use, the volume/snapshot question from task 962965dc), dated.
5. Cleanup at loop close: delete the suites branch, delete this file.

Traps: the deployed-artifact lag (ship code before relying on its
behavior); production carries REAL account data now - test data lands
only on the test box and suites branch, never production (ruling 4);
the row-expectation fix (f5ed4b60) is unmerged - do not let a signup
mid-slice trip the 1/0/0/0 redeploy expectation without planning it;
sign-out still absent (task edb7c76d).

Report to Isomux Manager with the standard format when done.

### D4 mid-slice ledger (tick 2026-08-12 ~08:45Z, G1-G4 complete, parked pre-G5)

Commits: 995139e (G2 provider readiness, approved 47b1d7a/1363/9b8d8b4a +
formatted re-gate 1379/a38779d6), 040b65b (G3 durable least-privilege
adoption proof, 995139e/257/571566e0, replaced the live suites rehearsal by
Reviewer2 ruling - SET ROLE is not the deployed session shape, role config
applies at login), b018373 (G4 credential landing protocol, 3 review rounds,
11 findings all real, 040b65b/3552/3b7216d0 + formatted 3570/5acb1199),
c11ac02 (D4-2 ruling-7 amendment, b018373/423/73a57df5 + formatted
428/4f71f1f5). Main ahead 4, push question pending with Nil.

Rulings this slice: R-2026-08-12-D4-1 (cancel-leg depth: no production
provider tail - retention is a calendar month; suites tail only against the
already-cancel-scheduled box, 422-reconcile path, precondition now formally
met by the amended step-8 reading; month-out teardown goes in the G8 runbook
with its real date). R-2026-08-12-D4-2 (ruling 7 restated: exactly one
instance THIS LOOP MAY TOUCH, id 203474835; strangers counted, never
inspected; >1 stranger = manager+Nil stop; prompted by the step-8 FULL STOP
that found Nil's own already-cancelled latency-test box - expires
2026-08-29 like ours). Wire ruling (both rails independently): protocol
states what it knows - expected_id_present + other_instances shipped in
both halves via a second gated activation rather than inferred locally.
N1 (Nil, in chat): Stripe TEST-mode keys on the public tier WINDOW-SCOPED
to the pass - in at G6, out immediately after with verified removal.

Live state: provisioner on fly serving the D4-2 image (proved by the
8-label protocol answer, NOT by the probe - health schema is
build-invariant, Reviewer2's correction), armed with the four Contabo
creds, healthy/pinned/ticking/state-persisted across two machine
replacements. Production: zero provider-linked assets, zero unfinished
provider ops, accounts=1. G4 ladder: 15 live commands, 1 deliberate stop,
0 ambiguous, 0 retries, 0 rollbacks. No Stripe credential has ever been on
the web tier.

Findings that outlive: the deployed web app has NO Stripe webhook route -
subscription state needs the operator-run consumer through the pass
(G7 plan-gates its mechanics); CONTROL_PLANE_PRICE_ID/STRIPE_TEST_SECRET_KEY
absent from Vercel by design until G6; provisioner-move-run --machine-state
is the designated zero-code first read after any ambiguous activation;
full lint took 13+ min under box load (vs ~5) twice.

Process lessons: the ruling-7 stop was the acceptance gate finding a true
world-fact everyone had assumed away, including the ruling itself; the
manager's commit-time prettier reflow no-oped three of the worker's
anchored test edits - passing tests are exactly what missing tests look
like, caught only because every new guard gets mutation-checked
(standing rule now: re-read from disk before editing any formatted file).
Executor note: all 15 live commands ran worker-side without classifier
blocks; the double-rail (reviewer form approval + manager live
authorization per command) held throughout.

Resume point: G5 recycle (fresh gate request, same double-rail), then
Nil's windows - G6 Stripe in/redeploy, G7 browser pass ~20min with the
webhook consumer running through it + verified key removal, then the
suites cancel-tail (own gate), then G8 runbook/docs/close-out. Boxes term
2026-08-29; nothing else expires.

### D4 mid-slice ledger 2 (tick 2026-08-12 ~14:15Z, G5 complete)

G5 COMPLETE, commit 44d678e (approved 8bdf303/2339/a593d3b6; formatted
re-gate 2362/bc6b8c9b PROVED formatting-only - Reviewer2 reproduced the
committed bytes by running prettier over the approved pre-format diff;
method note: formatted re-gates are proofs only if the pre-format diff is
kept). Box 203474835 rebuilt TWICE through the deployed provisioner
(EUR 0, cancel 2026-08-29 intact, account 2 rows / 1 stranger at every
reading; reinstall-to-SSH 73s and 78s, 2026-08-12).

The defect G5 caught and fixed: fly console execs resolve HOME=/root, not
the image's /data - config.ts derives STATE_ROOT from os.homedir(), so
every exec'd command wrote records/keys/audit to the EPHEMERAL filesystem
while init-started processes wrote the volume. volume_audit measured
false pre-remedy: the only audit rows in existence were ephemeral. Remedy
(in 44d678e): explicit HOME pin on every on-machine command, refuse-if-
unproved pre-check, acceptance = record+keys+audit on volume AND zero
delta in the legacy root. Channel facts now MEASURED (2026-08-12):
non-zero remote exits arrive non-zero, exit-one arrives as exactly one,
exit-0 reads work, env prefixes reach the child.

DECOY WARNING binding G7's plan-gate: /root still holds one reachable-
looking run record whose key the second rebuild INVALIDATED - left in
place deliberately (no unreviewed rm of key material; it dies with the
next machine replacement). Any UNPINNED on-machine command (adopt-run!)
would silently select it. Ruled: the G7 plan states pin carriage for
every on-machine command and PROVES volume reads in acceptance; step-3
promotion (machine-level HOME, replaces the machine - now legal, freeze
lifted after the second recycle) is the preferred shape CONTINGENT on
measuring that machine-level env reaches exec sessions (image ENV does
not). Room-memory machine lock added and removed same night.

Stripe CLI: not installed on this box (G7 consumer transport needs it).
Both rails approved install: v1.45.2 pinned, release artifact + same-
release checksums (transit integrity NOT provenance - keep that sentence
verbatim), target ~/nil/tools/bin, no root; STRUCTURAL AVOIDANCE of the
pre-existing ~/.config/stripe (every invocation carries --config to our
own file; never any `stripe config` command - it prints the file);
before/after stat booleans only, no content-derived values on disk.
Pre-existing mode-600 ~/.config/stripe/config.toml (90 bytes, 2026-08-09,
no CLI ever installed; inference: Stripe MCP cache) UNREAD - queued for
Nil as a dated secrets-surface fact. Executing one command at a time;
steps 5 and 8 are the decision points.

Carried, non-blocking: stranded rung-3 comment + Reviewer2's pin-first
ordering (ride the next legitimate edit); legacy guard outlives its
reason (one G8 runbook sentence: fires after machine replacement, remove
when /root is gone); README set -a line fixed at G8; import.meta.main
guard fact for the runbook (importing provider-account.ts without it
would have made a live provider call from a read-only diagnostic); N4
housekeeping now names two provider SSH secrets (run-20260812130101-hc5b,
run-20260812133231-c73w). Process: bytes-first review is the standing
rule for out-of-form mechanisms (the /tmp runner crossing showed post-hoc
detects but cannot prevent; verdict there: form defect on an unexercised
path, not an incident).

Resume point: Stripe CLI install (one command at a time), consumer
mechanics already plan-gated, then the G6/G7 window plan (step-3
measurement + promotion decision inside it), then Nil's window, suites
cancel-tail, G8. Nil briefed ~13:30Z; config.toml fact still to reach
him.

## PICKUP - SLICE D1: Neon readiness (Isomuxer2 / Reviewer2)

Goal: prove the store runs against the real Neon project and codify how
the production branch gets bootstrapped, so D3 can point a Vercel deploy
at it without ceremony.

What exists: the Neon project `isomux-control-plane` (pg18, Frankfurt),
created 2026-08-11, empty. Direct-endpoint DSN in
`~/nil/secrets/control-plane-neon.env`; account-wide API key in
`~/nil/secrets/neon.token`. The store and its suites are fully
Postgres-native since the last loop (local docker + CI service container);
`control-plane/web/e2e/production-server.e2e.ts` drives the production
web server against a real Postgres.

The work:

1. Child branch: use the Neon API (key above, read inside the consuming
   process per ruling 8) to create a child branch of production for test
   runs, and derive its direct-endpoint DSN. Decide with the reviewer:
   branch naming, per-run-create-and-delete vs a persistent suites
   branch, and how a run is pointed at it (existing `CONTROL_PLANE_DB`
   mechanics only - ruling: no new env var names without a plan-gate).
2. Suites against Neon: the store suites (store, pg-concurrency, and
   whatever the plan-gate scopes in) plus one production-server e2e run,
   all against the child branch. Expect remote-latency effects
   (Helsinki -> Frankfurt): decide with the reviewer what gets serialized
   and what timeouts move; a timeout bumped for latency needs a comment
   saying so.
3. Bootstrap: codify the procedure that takes the production branch from
   empty to schema-ready (script or documented command sequence - prefer
   whatever the repo already has for docker-Postgres setup), run it once
   against the real production branch, and leave production schema-ready
   and data-empty. No test data on production, ever (ruling 4).
4. Docs: `control-plane/README.md`'s Neon section currently says
   "undeployed / nothing has run against Neon" - update it to what is now
   verified, with dates on every measured claim. Check
   internal-docs/documentation.md for other surfaces.

Acceptance: a transcript showing (a) child branch created via API, (b)
suites green against it with exit codes captured, (c) one
production-server e2e green against it, (d) the bootstrap run against
production and a boolean check that production holds schema + zero rows
of user data, (e) README updated. Plus the standard gate baseline (full
`bun run ci` green locally - CI itself stays on the docker service
container; Neon runs are live evidence, not CI wiring).

Traps:
- The pooled `-pooler` endpoint rejects the startup-parameter timeouts -
  direct endpoint only (README documents it). A child branch has its own
  endpoint host; make sure the derived DSN is the branch's direct one.
- TLS: Neon requires it; the local docker DSN does not use it. If the
  driver config needs an ssl knob, that is config-shape work the reviewer
  sees in the plan, not an ad-hoc edit.
- Free-tier limits (connections, compute autosuspend): a suite that opens
  wide parallel connections may behave differently than docker. Measure,
  do not guess; serialize if needed and say so in the report.
- Secrets: the DSN never appears in output, logs, test names, or error
  dumps. Redaction applies to error paths too - a connection-refused
  error can embed the host; check what the driver prints before letting
  a failing run into the transcript.
- Locked: no Vercel, no fly.io, no DNS, no schema changes, no engine
  changes, no new env vars. A Neon incompatibility with existing SQL is
  a plan-gate escalation, not a workaround.

Report to Isomux Manager with the standard format when done.

(D1 closed 2026-08-11, commit 97c2821 - the pickup above is kept as history;
the tick note in the Slices list corrects what it got wrong, notably that the
env file held the pooled DSN.)

## PICKUP - SLICE D2: provisioner to fly.io (Isomuxer1 / Reviewer1)

Goal: the provisioner running as a fly.io app in Nil's `personal` org -
booted against Neon production with proved branch identity, tick loop idling
cleanly, secrets held as fly secrets, an HTTPS surface guarded by a bearer
for the web app to call later, and a documented, idempotent deploy
procedure. No customer-box operations in this slice.

What exists:
- fly token: ~/nil/secrets/fly.token (org-scoped, org `personal`, named
  isomux-control-plane, expires 2027-08-11). flyctl at ~/.fly/bin/flyctl.
  Pass the token per-command (env assignment reading the file); never
  source it, never echo it, never run `flyctl auth ...`. The machine-wide
  ~/.fly login belongs to wallgame deploys - do not use or mutate it, and
  do not touch any existing fly app.
- Neon production is schema-ready and empty (D1). The deployed
  CONTROL_PLANE_DB must use the DIRECT host and sslmode=verify-full; no
  options incantation - Store.open adds its own governed bounds and
  refuses to open if the engine drops them.
- Branch identity is provable from the session (D1's neon.branch_id
  mechanics in testing/target.ts / exercises/neon-api.ts) - reuse, do not
  reinvent.

The work:
1. Packaging: Dockerfile (Bun runtime) + fly.toml committed; app name
   default `isomux-provisioner`, region fra (Neon is Frankfurt). Machine
   size from a measurement, not a guess (shared-cpu-1x; 256MB vs 512MB).
2. Secrets: Neon DSN (direct host, built the D1 way) and the surface
   bearer as fly secrets. The mechanics must honor ruling 8 - `fly
   secrets set K=V` puts the value in argv; use an stdin path
   (`fly secrets import`) fed by a process that reads the env file.
   Plan-gate the exact mechanics.
3. Boot proof: on start the provisioner opens the store (governed bounds
   verified), proves the branch is production, and logs booleans only.
   A health surface reachable from outside reports the same booleans.
4. Tick loop: runs idle against the empty database over a measured
   window - no operations created, no crashes, no restarts by fly.
5. Web-callable surface: HTTPS + bearer (the mint-seam/transport notes in
   the design doc around "Transport, and the deploy-time note"). D2
   delivers the guarded surface; wiring Vercel to it is D3/D4.
6. Docs: deploy procedure (first deploy AND redeploy) with dates;
   README or internal-docs placement per documentation.md.

Decide with the reviewer:
- Contabo credentials in or out of this slice. Default OUT: the design
  says provisioning stalls gracefully when the provisioner lacks means -
  measure that the tick loop actually idles without provider creds; if
  it crashes instead, that is a real finding to report, not to patch
  silently. Real Contabo creds land no earlier than D4.
- Key-master persistence: read what keys.ts actually needs before
  deciding fly volume vs store-held material.
- What the health surface exposes (booleans only, per ruling 8).
- Machine memory size, from a measurement.

Traps:
- Any paid action (app create, machine create) is reported to the manager
  the moment it happens (ruling 7 - the spend itself is approved).
- The org token sees every app in `personal` (wallgame included): scope
  every flyctl invocation to the new app explicitly.
- Fly's builder may default to remote build (a paid builder machine can
  spin up): know what your deploy command does before running it.
- Locked: no Vercel, no DNS, no Contabo API calls (unless the plan-gate
  rules creds in - default is out), no store-semantics changes, no schema
  changes, no changes to D1's Neon machinery beyond reuse, no isomux
  server code, no restarts.

Acceptance: a transcript showing (a) app created and deployed via flyctl
with the token from the secrets file and no token or DSN in any output,
(b) boot logs with governed-bounds + production-branch booleans true,
(c) external health check green, (d) a measured idle window with zero
operations and zero restarts, (e) an idempotent redeploy, (f) full
`bun run ci` green locally, (g) docs updated with dates.

Report to Isomux Manager with the standard format when done.

(D2 closed 2026-08-11, commit dcef44f - pickup kept as history; the tick
note in the Slices list carries what outlives it.)

## PICKUP - SLICE D3.5: connection governance (Isomuxer1 / Reviewer1)

Goal: close the R-2026-08-11-1 finding (ruling 10) - give the deployed
tiers an engine-or-pooler-enforced aggregate connection posture with a
provisioner reserve, so D4 may open a real signup path. The acceptance
bar is Reviewer2's original predicate: a NUMERIC worst-case aggregate
that fits Neon's 901 with a stated reserve, engine- or pooler-enforced,
not client-promised.

Read first: this whole file (rulings 10 and 11 especially), the D1-D3
tick notes, control-plane/README.md (connection-posture section, Neon
sections, the deploy runbook), internal-docs/control-plane-design.md.

What exists (all measured 2026-08-11):
- Neon direct endpoint: max_connections 901; proves governed bounds and
  branch identity (D1 machinery in testing/target.ts, exercises/).
- The pooled -pooler endpoint REFUSES the store's options startup
  channel outright (SQLSTATE 08P01) - Store.open cannot open against it
  today. Vercel publishes no concurrency ceiling on any plan.
- Deployed consumers: the fly provisioner (one machine, direct DSN) and
  the Vercel web tier (direct DSN, per-instance pool).
- Ruling 10 pre-authorizes the shape: option B preferred - move the two
  bounds (statement_timeout, idle_in_transaction_session_timeout) to
  role level via ALTER ROLE ... SET, keeping the open-time read-back
  that refuses to run unproved (that preserves the design's guarantee;
  ruled implementation-locus, not semantics). Option A (a web role with
  CONNECTION LIMIT n) may compose with it. The plan-gate settles the
  design with measurements - including whether role-level bounds make
  the POOLED endpoint eligible for the web tier, which would hand the
  aggregate ceiling to the pooler where a serverless tier wants it.

The work (plan-gate the exact cut with Reviewer1):
1. Roles and bounds: the role/grant layout (e.g. a web role and the
   provisioner's role, each with engine-enforced limits and role-level
   bounds), expressed in bootstrap so a fresh database gets it, and
   applied to the live Neon production branch as a gated migration.
2. Store: keep the bounds read-back; adjust where the bounds come from
   (role SET vs options) per the plan; prove both endpoints' behavior
   with measurements on the suites branch first.
3. The numeric posture, written down: worst-case web aggregate + the
   provisioner reserve + headroom vs 901, in the README with dates.
4. Rotate the deployed configuration if the plan changes DSNs or roles:
   the provisioner via fly secrets (D2 wrappers), the web via a gated
   Vercel env change - note AUTH_SECRET is write-only and untouchable;
   only CONTROL_PLANE_DB may move, via its env id, PATCH not recreate.
5. Carried defects to fix in this slice (from D3, small and gated):
   the coordinator pre-flight guard classifies against the HEAD path
   set instead of porcelain prefixes (intent-to-add collision).
6. Docs: README posture section replaces the R-2026-08-11-1 finding
   with the enforced answer; the finding's expiry is recorded as met.

Traps:
- Production carries ONE real account row (Nil's). No test data on
  production, ever (ruling 4). Suites-branch first for every measured
  claim; the live migration is its own gated, reversible step.
- ALTER ROLE ... SET takes effect on NEW sessions: the running fly
  provisioner must be restarted or redeployed to inherit changes, and
  its boot proof must confirm the bounds post-change.
- The web tier's live deployment reads CONTROL_PLANE_DB at build/boot:
  a DSN change needs a redeploy (the --redeploy mode; remember its
  fixed 1/0/0/0 row expectation - it is correct while Nil is the only
  account, but do not let a test signup invalidate it mid-slice).
- Neon roles created via API vs SQL differ in password management -
  measure, do not assume; the API key is at ~/nil/secrets/neon.token,
  read in-process only (ruling 8 throughout).
- Locked: no signup-path changes, no Contabo, no fly app changes beyond
  configuration/redeploy, no schema changes to product tables, no
  customer copy. R-2026-08-11-2's detach lever and the TLS exception
  stand for any web redeploy.

Acceptance: (a) measured proof on the suites branch of the chosen
mechanism (bounds via role, read-back green, and the pooled-endpoint
answer settled with data); (b) the live migration applied and proved on
production (roles, limits, bounds - boolean evidence, zero user-data
changes, account count still exactly 1); (c) provisioner and web both
running under the new posture with their proofs green (fly boot line;
web probe subset); (d) the numeric aggregate + reserve documented with
dates; (e) the guard fix landed with tests; (f) full bun run ci green;
(g) docs updated per documentation.md.

Report to Isomux Manager with the standard format when done.

### D3.5 mid-slice ledger (tick 2026-08-12, G1-G3; G4 outcome in the
### slice tick above - manual supervised run, R-2026-08-11-1 closed)

Commits: 84ceb32 (G1 posture code, approved 31b5005/3947/91ebd3d9),
2ef3f7e (G3 credential-move executable, approved 84ceb32/5126/f411e94e),
d6a1cb7 (G3 remediation, approved 2ef3f7e/4334/dca7ed71), 070aaed
(owner-membership inertness exemption; drift episode: approved
250/a8000d18 pre-freeze-breach, committed bytes 287/a22e4e7d formally
approved post-hoc - freeze-HOLD rule instituted from it).

Live state (all 2026-08-12): G2 applied the posture to production (40
stmts, one txn); step-2 regovern applied the CURRENT exact matrix
(27 stmts, grants 42/42 -> 39/39, matching the digest-proved-reversible
suites rehearsal); G3 retry OUTCOME MOVED - the fly provisioner
authenticates as cp_provisioner on the direct endpoint, 12-backend
engine cap, probe accepted attempt 1, 21 samples all <=12, settled 1
steady. First G3 attempt rolled_back exit 3 (probe refused: the mint
seam's SELECT name_reservations was ungranted - statically established
by Reviewer1 against the worker's boot/tick-only callgraph; the
unrehearsed conservative recovery ran clean on production). Web tier
still on owner DSN; R-2026-08-11-1 OPEN pending G4 drain evidence.

Provider findings that outlive the loop: PG16+ grants a non-superuser
creator ADMIN membership in created roles (Neon differs from
superuser-owner local containers by construction); information_schema
is silently void for least-privileged roles - schema checks read
pg_catalog; Neon catalog visibility measured 0/7/42501 matching local.

Process rulings added mid-slice: PACE DIRECTIVE (Nil, via manager -
blockers only for production damage / ruling-8 / fail-open; all else
ledger notes; scope frozen at plan-gate); no steer:true to the manager
(steered messages abort in-flight manager commands - three phantom
rejections traced to it); freeze-HOLD rule (any edit to a frozen tree
announces HOLD to both counterpart and manager first); manager commits
re-verify the approved fingerprint atomically with the commit. Executor
deviations recorded: steps 2 and 3 run by the manager under Nil's
explicit chat approvals after the worker-side classifier refused both.

Close-out queue: README connection-posture + pre-live-predicates
sections rewrite (both predicates met; posture enforced - HOLD +
fingerprint like any edit); board tasks filed tonight: 7ddf0690 (ci
runtime), 282f135f (vacuous tests), d1a5a03b (exit-code system-prompt
line), ce58d34c (hook flake), edb7c76d (sign-out), d5619bbc (Managed
Payments wiring); loop task 99767a76 flips at loop close; unpushed
commits accumulate until Nil's push word.

## PICKUP - SLICE D3: web to Vercel (Isomuxer2 / Reviewer2)

Goal: the control-plane web app deployed on Vercel as a production build
under Node against Neon production, serving cloud.isomux.com with Google
sign-in live and dev-auth structurally absent, wired to the provisioner's
bearer surface. Hobby plan (ruling 3).

Nil-side dependencies - the manager owns chasing these; plan around them,
do not wait idle:
- Vercel API token at ~/nil/secrets/vercel.token (requested; boolean-check
  for presence).
- Google OAuth client id + secret at ~/nil/secrets/control-plane-oauth.env
  (requested; the redirect URI is
  https://cloud.isomux.com/api/auth/callback/google).
- The `cloud` CNAME lives in Namecheap and only Nil writes DNS: when the
  Vercel project names its target, hand the exact record to the manager
  and continue on what does not need the hostname.

What exists:
- Neon production: schema-ready, empty, direct-host DSN built the D1 way,
  sslmode=verify-full, no options incantation (Store.open self-governs
  and refuses if the engine drops the bounds). The `suites` branch is for
  tests; production never sees test data (ruling 4).
- The provisioner surface and bearer (D2 tick note above). D3 sets
  CONTROL_PLANE_MINT_URL to the fly surface and reads the SAME bearer
  file, in-process, per ruling 8.
- e2e/production-server.e2e.ts proves `next start` under Node serves
  store-backed authenticated pages; its session-cookie minting pattern is
  the documented way to prove store-backed pages without an interactive
  OAuth click (README documents it).
- Vercel: Nil's personal team. NEW project, default name
  isomux-control-plane; the existing `isomux` project is the landing page
  and is not touched.

The work:
1. Local production posture first (needs nothing from Nil): `next build`
   + `node next start` against Neon (suites branch), the full env
   contract enumerated and documented (names only, never values).
2. Vercel project via CLI with the token: root directory
   control-plane/web in a monorepo whose web app imports from ../
   (store, auth) - whether Vercel's build includes files outside the
   root directory is a MEASURED plan-gate item, not an assumption. So is
   the install path (the repo is bun.lock-only).
3. Env vars into Vercel without values in argv (vercel env add reads
   stdin) - ruling 8 mechanics, plan-gate the exact commands.
4. Preview deploy, verify, then production deploy. Add the domain; hand
   the exact DNS record to the manager for Nil; TLS follows DNS.
5. Auth: Google provider wired once Nil's client exists; prove from
   OUTSIDE the deployment that dev-auth is absent in the production
   build and that an unauthenticated request cannot reach store-backed
   pages. The interactive OAuth click-through lands in the acceptance as
   a Nil action at the end (his account, his browser) - stage it last.
6. Provisioner wiring: one authenticated round-trip from the deployed
   web to the fly surface (health is enough; minting real invites can
   wait for D4).
7. Docs with dates; documentation.md check.

Traps:
- The deployed web app holds NO provider credentials and no key material
  (design: that is the whole reason the provisioner exists).
- Vercel serverless means many concurrent connections: the DIRECT
  endpoint is correct for the always-on provisioner, but the web side's
  connection posture (direct vs pooled + how the driver pools per
  lambda) is a plan-gate topic with the D1 finding in hand - the pooled
  host drops governed bounds silently, so any pooled choice must prove
  its bounds the D1 way or be refused.
- next-env.d.ts is rewritten by any next command: restore before
  fingerprinting (standing caveat).
- Vercel CLI output can echo env NAMES freely but must never receive a
  value as an argument; deployment URLs are fine to print.
- Hobby-plan ceilings (function duration, no cron) are fine for this
  slice; anything that needs Pro is a finding, not a workaround.
- Locked: no Contabo, no fly.io changes (reading the D2 surface is not a
  change), no DNS writes, no schema changes, no pricing or customer copy
  changes (pricing sits with Nil), no store-semantics changes.

Acceptance: a transcript showing (a) local `node next start` production
posture green against Neon, (b) Vercel production deployment serving
store-backed authenticated pages against Neon production, (c) dev-auth
proven absent from outside, (d) unauthenticated requests refused, (e) one
bearer round-trip web -> provisioner, (f) the DNS record handed over and,
once Nil lands it, cloud.isomux.com serving with TLS, (g) full
`bun run ci` green locally, (h) docs dated. The final interactive Google
sign-in is verified by Nil and recorded as his action.

Report to Isomux Manager with the standard format when done.
