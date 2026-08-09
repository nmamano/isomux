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
- NOT OURS TO TOUCH: instanceId 203474533 (169.58.96.127, the old
  steal-monitor box) has no cancelDate and renews at EUR 5.50/mo; its
  purpose concluded 2026-08-02 (task b223ebc3). Queued for Nil as a
  cancel decision - outside this loop.
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

## Slice checklist

- [ ] Slice 1: Contabo adapter + SSH driver (Isomuxer2 / Reviewer2)
- [ ] Slice 2: schema, operations, leases, deadlines
- [ ] Slice 3: Stripe test mode (gate: stripe-test.env verifies by
      boolean check; if not, the loop closes at slice 2)

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

## PICKUP: Slice 2 - (authored after slice 1 lands)

Placeholder. Will fold in slice 1's measurements and lessons. Known
decide-with-reviewer item: datastore for the operations/leases schema
(bun:sqlite default for the loop vs Postgres-first; deploy target is
managed Postgres - record the tradeoff).

## PICKUP: Slice 3 - (authored after slice 2 lands)

Placeholder. Entry gate: `grep -qE '^STRIPE_TEST_SECRET_KEY=sk_test_'
~/nil/secrets/stripe-test.env && echo ok || echo missing` must print ok
(the file's previous key was burned and awaits Nil's roll). If missing,
the loop closes at slice 2 and slice 3 queues for the morning.
