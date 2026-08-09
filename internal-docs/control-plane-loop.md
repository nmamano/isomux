# Control-plane slice loop (standing orders)

Loop file for the hosted control-plane implementation loop. Manager-owned;
workers re-read this whole file at the start of every slice, plus
`internal-docs/control-plane-design.md` (the design; its rulings are final)
and `internal-docs/hosted-isomux-design.md` (the product context).
Delete this file when the loop closes; history stays in git.

Kickoff approved by Nil 2026-08-09. Scope: slices 1, 2, 3 of the design
doc's slice plan. Slices 1 and 2 are the declared risk; each slice lands
solid before the next starts.

## North star

One command turns a Contabo API call into a live HTTPS office with an
invite in hand and our key removed, with the removal proven by a failed
reconnect using the removed key (slice 1). Then the schema, operations,
leases and deadlines behind that command, exercised against real boxes on
the ambiguous-create, crashed-install and failed-revocation paths
(slice 2). Then Stripe test mode: auth, Checkout, coupons, webhooks,
dunning (slice 3).

## Rulings (final - never relitigated in this loop)

1. All 11 rulings in `control-plane-design.md` stand as written. The
   design doc is the spec; do not reopen it.
2. Code lives in the public isomux repo. No secrets in code, ever.
3. Provider is Contabo only. No second-provider adapter (parked, task
   7ed70b22).
4. Money: provider spend ceiling EUR 20 for the whole loop, target about
   EUR 7. Buy at most ONE box-month. Recycle the box via Contabo
   reinstall (~5 min, free within the paid month) for every e2e cycle.
   List the account before any create - the July pilot (task b223ebc3)
   may have left a box to adopt.
5. Deployed provisioner target is fly.io. Scale-to-zero vs always-on tick
   loop is a deploy-time question: record the tradeoff where it comes up,
   do not solve it. Nothing deploys during this loop.
6. The driver runs as CLI/tests from this box, isolated from the live
   office. This loop does not touch isomux server code and needs no
   office restart.
7. DNS: the Cloudflare migration (task 523eec92) stays parked. No DNS
   automation in this loop. The test name's A record is a one-time manual
   step (see Box ledger).
8. Slice 3 uses the Stripe TEST key from `~/nil/secrets/stripe-test.env`
   only. The live-mode Stripe MCP key never appears in code or env.
9. The design doc's verify-at-implementation list is slice 1/3 work. In
   particular: test that Ubuntu 24.04 OpenSSH honors the
   `expiry-time` authorized_keys option (authenticate on both sides of
   the boundary, and boot a box whose deadline passed while powered
   off) - never assume it.

## Mid-loop rulings (manager)

- R-2026-08-09-1 (slice 1, sent verbatim to both lanes): (1) Fail closed
  at the driver layer - the driver refuses to rewrite an authorized_keys
  line without an absolute expiry instant; a missing ceiling stops the
  run at argument parsing AND as a driver precondition. Slice 2 inherits
  the property. (2) Slice 1 takes the access window as a required CLI
  parameter, no default; the acceptance run uses a short value. (3) The
  product default (design ruling 7's mechanism: ~30-day fail-safe
  backstop vs genuinely no expiry until customer confirmation) is
  PARKED FOR NIL in the end-of-loop queue; nothing in slices 1-3
  hardcodes either choice.

- R-2026-08-09-2 (slice 1, sent verbatim to both lanes): install.sh
  product bug, manager-verified. The systemd-unit heredoc at
  deploy/install.sh:2877 is unquoted and two comment lines contain
  backticks; on a fresh box the substitution splices ERR-path log text
  into the unit and the install dies at install-service ("Bad
  message"). Broken on main since b0264e5 (2026-08-03); releases
  unaffected; the documented curl-from-main VPS install is affected.
  Authorized inside the slice-1 diff: remove the backticks from the two
  comment lines (delimiter stays unquoted - the block expands real
  vars), add a rendered-unit regression test that goes red pre-fix,
  scan all other unquoted heredocs for the same mechanism. One diff,
  one gate. Push urgency queued for Nil.

- R-2026-08-09-3 (post-loop, Nil delegated the call 2026-08-09): the
  product access-window default is option (a) - a ~30-day fail-safe
  expiry backstop on our provisioning key, with customer-confirmed
  early revocation as the normal path and dashboard nagging until
  confirmation. This honors design ruling 7's intent (never lock
  ourselves out before the customer arrives - 30 days is far past any
  real arrival) while keeping the design's holds-without-us guarantee
  (an unconfirming customer's box still self-expires our key). Slices
  4-5 implement it; the design doc's "still open" item 3 is settled.

## Manager-accepted defaults (reversible unless marked)

- Code home: `control-plane/` at the repo root. TypeScript on Bun, the
  repo's existing toolchain; tests are ordinary `bun test` files under
  `control-plane/` so the repo-wide CI picks them up.
- Runtime state (generated keypairs, run records, audit JSONL) lives
  outside the repo in `~/.isomux-control-plane/`. Private key material
  never enters the repo tree, not even gitignored.
- Contabo credentials: scripts read standard env vars, sourced from
  `~/nil/secrets/contabo.env` by the caller. Code never reads the
  secrets file path directly and never logs env values.
- Region: EU (pilot pricing EUR 5.50/mo, product V153, no non-EU
  surcharge).
- Test hostname: `cp1.test.isomux.app`. A more-specific record overrides
  the existing `*.test.isomux.app` wildcard. Manager asks Nil for the
  record once the box IP is known; the IP survives reinstalls so this
  happens once.
- Audit log in slices 1-2 is an append-only JSONL file (actor, action,
  target, outcome, timestamp) - the schema row comes with slice 2+.
- Measurements (create-to-IP, install duration, HTTPS delay, step
  timings) get recorded by editing the deadline numbers section of
  `control-plane-design.md` with a "measured YYYY-MM-DD" note.

## Standing rails (prohibitions)

- Never call the provider create endpoint outside the one-command flow,
  and never retry a create blind. An ambiguous create (timeout, 5xx,
  dropped connection) is resolved by list/find only. A second paid box is
  never created; if the flow seems to need one, stop and escalate to the
  manager.
- Report every paid provider action (create, any action with a price) in
  the slice report the moment it happens.
- Secrets: never print any content-derived fragment of a file under
  `~/nil/secrets/` - no substrings, no prefixes, no awk fields, no
  key=value echoes. Verify with boolean checks only
  (`grep -qE '^NAME=' file && echo ok || echo missing`) plus metadata
  (`ls -l`, `wc -c`). This applies to your own debugging output too.
- Do not modify `deploy/install.sh` behavior; if the driver needs a
  change there, flag it to the manager instead.
- No isomux server code changes, no office restart, no worktrees (work
  in main, one slice in flight), no commits (manager commits), no
  prettier (manager runs it post-approval), no DNS writes.
- ESLint clean on touched files; `bun run build:ui` and `bun test` must
  stay green repo-wide (your new dir is part of CI).
- After sending any gate request (plan gate or diff gate), end the turn
  and wait idle. Silence is never approval.

## Process per slice

1. Manager authors the slice pickup below, commits the loop-file edit,
   clears and dispatches worker + reviewer (lanes alternate; both
   sessions cleared between slices; effort high).
2. Worker re-reads this file + both design docs, then plan-gates with
   the reviewer before writing code.
3. Worker implements, runs the gates, freezes the tree, fingerprints
   against HEAD (`git add --intent-to-add . && git diff HEAD | wc -l`
   and `git diff HEAD | md5sum`), announces the fingerprint, diff-gates
   with the reviewer until formal approval on that exact fingerprint.
4. Worker report: what changed; how verified (gate transcripts); reviewer
   verdict + approved fingerprint; all user-visible prose verbatim;
   mutation statement (which assertions were mutation-checked and how);
   measurements; paid actions; parked items.
5. Manager: re-verify the fingerprint byte-exact, `bunx prettier --write`
   on touched files, full `bun run ci` (redirect to a file, check
   `echo exit=$?` - never pipe the run through a filter), ONE commit
   ("Implemented by IsomuxerN; reviewed by ReviewerN" + Co-Authored-By
   trailer), tick the checklist with a lessons note, author the next
   pickup.

## Gates (exact commands)

- Unit/stub tier: `bun test control-plane` - adapter logic against
  recorded/fixture responses, driver logic against a fake transport. At
  least the load-bearing assertions mutation-checked (revert the code
  under test, confirm the test fails, restore; verify the pristine file
  by diff afterwards).
- Repo tier: `bun run lint` on touched files, `bunx tsc --noEmit`,
  `bun test > /tmp/t.log 2>&1; echo exit=$?`.
- Live tier (slices 1-2): the real command against the real box, full
  transcript in the report, timings captured. Recycle via reinstall
  between cycles; never a second box.

## Decision protocol

- Worker + reviewer settle: implementation detail, library choice, CLI
  shape, fixture strategy, wrapper script text (its invariants are fixed
  by the design doc), test structure.
- Manager settles: anything touching money, scope, the box, deadlines
  between slices, worker-reviewer deadlocks. Measured evidence beats
  plausible reasoning - measure before arguing.
- PARKED FOR NIL (end-of-loop queue, not mid-loop pings): pricing
  numbers, published promises/copy, any reinterpretation of a design
  ruling, push approval.

## Box ledger (manager-maintained)

- ADOPTED (2026-08-09): Contabo instanceId 203474835, ipv4 169.58.97.2,
  V153, EU, created 2026-07-30 ("latency-test"), already cancelled, paid
  through 2026-08-29, no further charge. Not pristine (an earlier test
  ran install.sh on it); first reinstall exercises the recycle path.
  Loop provider spend so far: EUR 0.
- RESOLVED: instanceId 203474533 (169.58.96.127, the old steal-monitor
  box) cancelled by the manager 2026-08-09 with Nil's approval; service
  ends 2026-08-29, no further renewals (was renewing at EUR 5.50/mo).
- DNS record `cp1.test.isomux.app -> 169.58.97.2`: requested from Nil
  2026-08-09 (queued for his morning).
- Manager-accepted (2026-08-09): the live create path is NOT exercised
  this loop (adoption avoids a ~EUR 5.50+ spend). Coverage = stub-tier
  fixtures + the July pilot's live evidence (create-to-SSH 110s). The
  create idempotency-key question is settled from API docs/fixtures and
  documented as such in control-plane/README.md, marked "not live-
  verified".
- Let's Encrypt duplicate-cert limit (5/week per identical name set)
  budgets at most 4 cert-issuing e2e cycles; non-HTTPS work runs on
  non-issuing cycles (worker-raised, manager-accepted).

## End-of-loop queue (for Nil at close; do not ping mid-loop)

- DECISION: product access-window default (ruling R-2026-08-09-1 clause
  3): ~30-day fail-safe backstop with confirmed revocation as the
  normal path, vs genuinely no expiry until customer confirmation.
- COPY SIGN-OFF (customer-visible strings from slice 1, verbatim in the
  close-out report): the access-record message, two systemd Description
  lines.
- TASK CANDIDATE: pre-existing flake server/test-support/
  app-ws-relay.test.ts ("carries the client's close code and reason to
  the app") - teardown race under full-suite load; bit `bun run ci`
  once 2026-08-09, passed on rerun and 6/6 isolated.
- TASK CANDIDATE (papercut, found by Isomuxer1 2026-08-09): the safety
  hook guarding ~/.isomux/ prefix-matches instead of path-boundary
  matching, so it also blocks ~/.isomux-control-plane/ and any future
  ~/.isomux-something. Worker surfaced it per the no-workaround rule
  and used a temp-DB pattern instead.
- RECORD: box 203474533 cancelled 2026-08-09 (Nil-approved), ends
  2026-08-29. Slice-1 push done 2026-08-09 (Nil-approved).

## Slice checklist

- [x] Slice 1: Contabo adapter + SSH driver (Isomuxer2 / Reviewer2).
      DONE 2026-08-09: approved fingerprint 5d9466c5951a3ededc91f4a5ab906a10,
      committed 6f00881, pushed to origin/main same day (Nil-approved;
      the push also shipped the install.sh heredoc fix, so fresh
      self-hosted installs from main work again). EUR 0 spend. Lessons
      folded into slice 2: (1) a box is NOT ready when SSH answers -
      boot-time apt holds the dpkg lock (observed at T+2min on a box
      SSH-able at T+88s); wait-for-package-manager is its own step and
      needs its own typed operation + deadline in slice 2. (2) Measured
      2026-08-09: reinstall-to-SSH 88s, install 236s (largest
      inter-marker gap 67s - Chrome download), install-exit to HTTPS
      200 16s, box clock skew 0-2s (sshd evaluates expiry-time on the
      BOX clock). 8-min inactivity deadline has ~7x margin. Create-to-IP
      still only the pilot's 110s (no live create this loop). (3)
      Contabo reinstall PRESERVES cancelDate - recycling a cancelled box
      keeps its paid-through date. (4) Slice-2 candidate from the lane:
      retime the cleanup timer to a near instant at revocation so the
      units do not outlive a proven revocation. (5) For Nil's list:
      access-window product default still parked; customer-visible
      strings exist (access-record message, two systemd Descriptions) -
      queued for copy sign-off at loop close.
- [x] Slice 2: schema, operations, leases, deadlines (Isomuxer1 /
      Reviewer1). DONE 2026-08-09: approved fingerprint
      0f4d496c3d59f92b2c36444814748eca (round-8 formal approval),
      committed 3a4d4ed (+ measurements doc commit 53c1764). EUR 0
      spend. Eight diff-gate rounds, 45 mutations (3 first-pass
      survivors, each led to a change). Live exercises all passed on
      box 203474835: crashed installer, failed revocation (chattr +i),
      ambiguous create at the transport seam (find-only recovery),
      provisioner SIGKILL mid-provision. Lessons: (1) errored-agent
      recovery = POST /resume with same sessionId (abort does not clear
      it) - relevant to task 64b36bee. (2) Reviewer context refresh
      mid-slice (clear + re-brief with open items) worked well; fresh
      full-tree pass caught new real issues. (3) Contabo displayName
      rejects colons - slice-1 intent stamp format was fixed. (4) No
      schema migration ships; pre-slice dev DBs refuse to open by name.
- [ ] Slice 3: Stripe test mode - NOT RUN. Entry gate checked
      2026-08-09 at slice-2 close: STRIPE_TEST_SECRET_KEY still
      missing from ~/nil/secrets/stripe-test.env (Nil's roll pending).
      Loop closed at slice 2 per standing orders; slice 3 queued for
      the morning. This file stays until slice 3 lands or Nil retires
      the loop.

## PICKUP: Slice 1 - adapter + SSH driver

Goal: one command (`bun control-plane/cli.ts ...`, exact shape yours to
design with the reviewer) that goes from a Contabo API call to a live
HTTPS office at `https://cp1.test.isomux.app` with an owner invite
printed to the operator and our key removed, the removal proven by a
failed reconnect that authenticates with the removed key. Plus the
recycle path (reinstall) so later cycles and slice 2 are cheap.

Load-bearing mechanics from the design doc (read the full sections; this
is the index, not the spec):

- Adapter interface: `create/get/reboot/powerOff/powerOn/cancel/find`
  with outcome classes, not throws. Settle and document Contabo's `find`
  semantics and whether create has an idempotency key - that
  documentation is a slice-1 deliverable.
- First contact: rewrite the injected authorized_keys line to carry
  `expiry-time="YYYYMMDDHHMMSSZ"` before anything else, read back to
  confirm. Arm the root systemd cleanup timer (`Persistent=true`).
  Early revocation is the normal path; remove the key, remove the
  wrapper and run dir, then prove removal by reconnecting with the
  removed key and requiring failure. Destroy the private half after.
- Driver protocol: per-run generation dirs
  `/var/lib/isomux-cp/runs/<runId>/{pid,started,exit,log}`, atomic
  `current` pointer, single-quoted EXIT trap capturing `$?` at fire
  time, append-only log, `flock -n` single-flight, tick reads exit file
  then PID then last `--- step:` marker.
- Install: drive `deploy/install.sh` over SSH (it logs `--- step:`
  markers, is idempotent, mints the invite). Invite is printed, never
  persisted. Host key pinned on first contact; a later mismatch is a
  hard stop.
- Expiry-time verification (ruling 9): a real test on the box that
  authenticates successfully before the deadline and fails after it,
  plus the powered-off-across-the-deadline variant. Transcript in the
  report.
- Measurements: create-to-IP, create-to-SSH, install duration, install
  exit to HTTPS-ok, step-by-step timings. These become the design doc's
  deadline numbers.

Money procedure (rails above apply): first list the account with the
pilot credentials and report what exists. If a usable box is present,
adopt it (record identity, reinstall to a clean Ubuntu 24.04). Only if
the account is empty, create ONE V153 EU box. Either way report the
box identity and any charge immediately; the manager updates the Box
ledger and asks Nil for the DNS record. Until the record exists, HTTPS
will pend (Caddy retries HTTP-01) - do everything else first; the
HTTPS+invite acceptance run happens after the record lands.

Acceptance (isolated-instance demo transcript in the report):

1. Command runs end to end against the real box: create-or-adopt ->
   key-with-expiry confirmed -> timer armed -> install driven with step
   markers visible -> HTTPS 200 on the office at the test name ->
   invite URL printed -> revoke -> reconnect with removed key FAILS ->
   private half destroyed.
2. Expiry-time test transcripts (both variants).
3. Unit/stub tier green with the mutation statement.
4. Contabo `find`/idempotency semantics documented in
   `control-plane/README.md`.

Decide with the reviewer: SSH transport (shell out to system ssh vs a
library), CLI/command shape, fixture strategy for the stub tier, wrapper
script text, how the recycle subcommand looks.

Locked: everything in Standing rails; the adapter interface signatures
(design doc); no web app, no schema/leases yet (slice 2), no Stripe
(slice 3).

## PICKUP: Slice 2 - schema, operations, leases, deadlines
(Isomuxer1 / Reviewer1)

Goal: put the design doc's operations model behind slice 1's command.
The four state axes (service, provider asset, subscription as a stub
cache, attention), typed operation rows with durable ids, status,
attempt count, next_attempt_at, lease_until, inactivity + absolute
deadlines and last evidence; a tick loop that leases due operations by
CAS and reconciles provider truth from get(); deadlines that flag
(raise attention) rather than conclude. The slice-1 CLI keeps working,
now driven through operations, and a provisioner crash mid-flight
recovers deterministically on restart.

Load-bearing mechanics (design doc sections: "Provisioning: coarse
state, explicit operations", "Concurrency", "Deadlines flag; they do
not conclude", "Ordering a paid box exactly once"):

- Every transition is a version-column CAS; losers re-read. Leases via
  lease_until CAS; only the leaseholder acts; expired leases are
  adoptable. One active operation per (instance, kind) where status in
  pending/running/ambiguous. Backoff is persisted next_attempt_at;
  nothing sleeps inside a tick.
- create_intent keeps its slice-1 fail-closed latch semantics; the
  15-min ambiguous-create quarantine polls find; exact adopts,
  unproven/nothing raises attention with the instance still
  provisioning. A second intent is never opened automatically.
- revoke_access is never quietly abandoned: a closed access window plus
  failed revocation is an attention case (the box-local timer makes it
  a broken when, not a broken guarantee).
- New typed operation from slice 1's lesson: wait_for_package_manager
  (boot-time apt holds the dpkg lock past SSH-readiness) with its own
  deadline. Deadline numbers seed from the measured values in the
  design doc (dated 2026-08-09).
- Slice-1 lane candidate, adopt unless the reviewer kills it: at proven
  revocation, retime the cleanup timer/units to a near instant instead
  of letting them ride to the original ceiling.
- Attention is persisted (reason, severity, raised_at, acknowledged),
  not derived; raise and clear both write audit_events.

Exercises against the real box (203474835 - recycle first, it has no
key on it and its old cleanup timer self-removed at 18:04Z):

1. Crashed install: kill the installer mid-run on the box; the tick
   must classify crash (exit file absent + dead PID) vs progress, and
   a retry must run under a fresh runId with the old generation's
   verdict untouched.
2. Failed revocation: force the revoke command to fail; attention
   raised, timer stays armed, retry succeeds, then the proof-of-removal
   reconnect requirement still holds.
3. Ambiguous create: money rail forbids a live create, so the create
   call is faulted at the transport seam (timeout/5xx after "sent")
   while find runs against the REAL account; the quarantine must adopt
   on exact, raise attention on unproven, and never open a second
   intent. Document that the live-create leg stays "not live-verified".
4. Provisioner kill mid-provision: kill the tick process while an
   install runs; on restart, recovery is deterministic from the
   persisted rows (no duplicate installer run - the box wrapper's flock
   plus run generations must be what arbitrates).

Acceptance (isolated-instance demo transcript in the report): the full
slice-1 chain executed as leased operations end to end on the real box,
plus transcripts of exercises 1-4, plus unit/stub tier green with a
mutation statement covering the CAS/lease/deadline logic.

Decide with the reviewer: datastore (bun:sqlite default for the loop vs
Postgres-first; deploy target is managed Postgres on fly.io - record
the tradeoff where it is decided, do not solve deployment); tick cadence
and how ticks are driven in CLI mode; schema file layout; how the
audit JSONL from slice 1 migrates into or coexists with audit_events.

Locked: everything in Standing rails; the adapter seam and slice-1
driver semantics (extend, do not rewrite); no web app, no Stripe, no
DNS automation; subscription state is a stub column, not an
integration.

## PICKUP: Slice 3 - Stripe test mode (Isomuxer2 / Reviewer2)

Entry gate (verified by the manager before dispatch):
`grep -qE '^STRIPE_TEST_SECRET_KEY=sk_test_' ~/nil/secrets/stripe-test.env`.

Goal: the billing machinery of the design doc's Billing section, built
and exercised entirely in Stripe TEST mode: Checkout session creation,
the 100%-off coupon path, webhooks as the only writer of subscription
state, and the dunning ladder including the couponed-account diversion.
No web app, no deploy: modules + a locally-runnable webhook endpoint
driven by `stripe listen` (Stripe CLI) or recorded events, plus CLI
commands mirroring the slice-1/2 pattern.

Hard rails specific to this slice:

- TEST KEY ONLY, read from the environment
  (source ~/nil/secrets/stripe-test.env). The office's Stripe MCP tools
  are LIVE-mode on the real Isomux LLC account - never use them in this
  work, read or write. Nothing live-mode, ever; sk_live anywhere is a
  stop-and-escalate.
- Secrets rails unchanged (boolean checks only; no printed fragments;
  no key material in code, fixtures, logs, or test snapshots - webhook
  fixtures must have secrets scrubbed before they land in the repo).
- Stripe test-mode objects are free; there is no spend ceiling concern,
  but create test clocks/customers with a recognizable prefix and
  delete them in cleanup so the test account stays legible.

Load-bearing mechanics (design doc "Billing" + rulings 1 and the
coupon paragraph):

- Webhooks are the ONLY writer of subscription state; the local row is
  a cache of Stripe truth. Events: checkout.session.completed,
  customer.subscription.updated, customer.subscription.deleted,
  invoice.payment_failed. Verify signatures, dedupe by event id
  (durable), tolerate out-of-order and replayed delivery.
- No trial. Checkout collects a card and charges immediately; a
  100%-off coupon sets payment_method_collection to if_required so no
  card is collected. "Comped" is not a flag: it is the presence of an
  active 100% discount, cached from webhooks.
- Coupon lapse: next invoice has amount due and no payment method ->
  past_due -> for formerly-couponed accounts this raises attention and
  notifies, does NOT enter the dunning ladder, with a 14-day deadline
  after which the ordinary ladder resumes.
- Dunning: Stripe's retry schedule runs; on exhaustion the design says
  suspension via provider power_off - in this slice that boundary is a
  typed operation enqueued into the slice-2 machine (exercised with a
  stubbed provider; no real power action needed).
- Verify-at-implementation items owned by this slice: Stripe's actual
  payment_method_collection: if_required behaviour on a 100%-off
  subscription, and what really happens at coupon lapse - use test
  clocks, record the observed behaviour dated, in the design doc.

Manager-accepted defaults (reversible): Google/Auth.js sign-in is
slice-4 work (it needs the web app); slice 3 builds the accounts +
subscriptions schema rows it writes into (extending the slice-2
store). Test-clock-driven time travel replaces waiting for real
renewal dates.

Acceptance (transcripts in the report):

1. Checkout session created against the real test account; completion
   (test card via Stripe CLI/API) delivers checkout.session.completed
   through signature verification into a subscription row.
2. The coupon path: a 100%-off session collects no card; the
   subscription shows the discount; coupon lapse under a test clock
   produces the observed-and-documented past_due behaviour and the
   attention diversion with its 14-day deadline.
3. Dunning: a failing card under a test clock walks the retry
   schedule; exhaustion enqueues the suspension operation exactly once
   (idempotent under replayed webhooks).
4. Event-id dedupe and out-of-order tolerance pinned by tests; stub
   tier green; mutation statement covering the state-transition and
   dedupe logic.

Decide with the reviewer: module layout under control-plane/ (e.g.
stripe/ subdir), fixture strategy (recorded vs synthesized events),
how the webhook endpoint runs locally (Bun.serve + stripe listen
forwarding vs direct fixture injection - at least one leg must go
through real Stripe delivery), test-clock lifecycle helpers.

Locked: everything in Standing rails; the slice-2 store and operation
semantics (extend, do not rewrite); no provider actions against real
boxes this slice; no web UI; no deployment.
