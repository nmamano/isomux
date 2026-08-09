# Control-plane UI loop (standing orders)

Second control-plane loop: slices 4-5 of `control-plane-design.md`,
authorized by Nil 2026-08-09 ("S4/5", manager's call on session). Same
conventions as the slices 1-3 loop (its standing orders live in git
history: `git show 08486cf:internal-docs/control-plane-loop.md`).
Workers re-read this whole file each slice, plus
`internal-docs/control-plane-design.md` (rulings final) and
`control-plane/README.md`. Delete this file at loop close.

Cut: the design's slice 4 is split for reviewability. Loop slices:
- 4a: web app skeleton - auth, signup/Checkout wiring, provisioning
  progress (read side).
- 4b: handoff and the access window - invite handoff, revoke, reboot,
  liveness display.
- 5: cancel, deprovision, and the ops floor (operator alerting view).

## Rulings (final)

1. All design-doc rulings stand, plus this loop inherits every ruling
   of the slices 1-3 loop: R-2026-08-09-1 (fail-closed expiry ceiling;
   required parameter), R-2026-08-09-2 (n/a here), R-2026-08-09-3 (the
   product access-window default is a ~30-day fail-safe backstop with
   customer-confirmed early revocation as the normal path).
2. Nothing deploys during this loop. The web app runs locally (dev
   server / local build). Vercel + domain wiring is post-loop work.
3. No secrets in code; the Stripe rails from slice 3 stand unchanged
   (test key only, live MCP tools untouchable, fixtures scrubbed).
4. No live provider create. Real-box work uses the recycled test box
   203474835 only (paid through 2026-08-29), same money rails as
   before: list first, never a second box, report any paid action
   immediately. Provider spend target for this loop: EUR 0.
5. Google sign-in ships as Auth.js with the Google provider, but the
   loop's e2e runs use a dev-credentials provider behind the same
   session abstraction (no real Google OAuth client exists yet -
   creating one is Nil's pre-launch action, flagged in the queue, and
   must not stall the loop).
6. Copy: operator-facing strings follow slice-3 precedent (report
   verbatim, sign-off at close). Customer-facing strings say "Hosted
   Isomux Provisioning" for the provisioning actor (Nil, 2026-08-09).
   Anything that reads like marketing gets PARKED for Nil - the loop
   ships functional copy only.

## Manager-accepted defaults (reversible unless marked)

- The web app lives at `control-plane/web/` (Next.js, App Router),
  sharing the repo. It talks to the control-plane store and modules
  server-side; no new HTTP surface between web and store in this loop.
- Same bun:sqlite store as slices 2-3; the Postgres port stays recorded
  debt, not this loop's work.
- The web app must not hold key material or originate SSH (design's
  blast-radius section): anything privileged goes through typed
  operations the provisioner executes, same as the CLI does today.
- Repo CI must stay green; if Next.js build tooling fights the repo
  gates, the integration approach is a plan-gate topic, not a
  workaround.

## Standing rails (prohibitions)

Same as the previous loop, restated short: no commits/prettier by
workers (manager owns both), one slice in flight, work in main, freeze
+ fingerprint + formal reviewer approval on the exact fingerprint, end
turn after any gate request, boolean checks only on ~/nil/secrets/,
surface permission denials instead of working around them, no isomux
server code changes, no restarts, no DNS writes, no deploys.

Harness caveat (task 6957e90d, three hits on 2026-08-09): long-running
foreground Bash calls can be auto-rejected mid-flight and kill the
backend. Run gates as separate short calls; use harness-tracked
background commands for the full suite; never chain sleeps or poll in
until-loops. If your session dies this way, the manager resumes it -
report the interruption, verify any mutation-cycle files are pristine
before continuing.

## Process per slice, gates, decision protocol

Identical to the slices 1-3 loop (see `git show
08486cf:internal-docs/control-plane-loop.md`, sections "Process per
slice", "Gates", "Decision protocol"). Additional gate for web slices:
a scripted headless-browser transcript (the repo's established
playwright-core + system Chrome pattern) demonstrating each acceptance
flow against a local instance seeded via `exercises/seed-instance.ts`.

## End-of-loop queue

- Nil pre-launch action (does not stall the loop): create the Google
  OAuth client (web app), store creds under ~/nil/secrets/.
- Nil decision pending from the last loop: the Stripe
  cancel-at-exhaustion account setting (he is flipping it to "mark
  unpaid"; verify with a test-clock run when he confirms, then close
  the design-doc note).
- Copy sign-off at close, slice-3 precedent.

## Slice checklist

- [ ] Slice 4a: web skeleton - auth, signup/Checkout, progress
      (Isomuxer1 / Reviewer1)
- [ ] Slice 4b: handoff + access window (Isomuxer2 / Reviewer2)
- [ ] Slice 5: cancel, deprovision, ops floor (Isomuxer1 / Reviewer1)

## PICKUP: Slice 4a - web skeleton: auth, signup, progress

Goal: a locally-running Next.js app at `control-plane/web/` where a
dev-authenticated user can sign up (name + plan -> Checkout in Stripe
test mode -> webhook lands -> account/subscription/instance rows), see
the provisioning progress the operations rows already model (human
step labels from operation kinds + evidence, the design's "Dashboard"
section), and see attention states rendered read-only.

Load-bearing mechanics:

- Auth.js: Google provider configured but inert without creds; a dev
  credentials provider drives all loop testing (ruling 5). Sessions
  are the web app's own; no isomux-office auth involvement.
- Signup: name validated as a DNS label, refused against the design's
  reserved list, uniqueness enforced via a durable reservation row
  (this is the "slice 4 signup reservation" deferred from slice 3 -
  it links accounts to instances and closes the no-linked-instance
  attention gap noted there).
- Checkout: reuse control-plane/stripe/checkout.ts wholesale; the web
  route only assembles inputs. Webhook ingestion stays the slice-3
  server/reconcile path - the web app does NOT process webhooks.
- Progress: read-only projection of operations/attention rows for the
  signed-in account's instance. No operator actions in 4a.
- Provisioning itself may be exercised against the real box via the
  existing CLI/tick (seed-instance + run) - the web app OBSERVES.

Acceptance (headless-browser transcript + tests):

1. Dev sign-in -> signup form -> name validation (bad label, reserved
   name, taken name all refused with the actual copy captured) ->
   Checkout session created in test mode (100%-off coupon leg
   included) -> webhook completes -> rows exist and the dashboard
   shows the subscription.
2. With a seeded + running provision on the real box: the progress
   view tracks live step labels through to HTTPS-ok; a raised
   attention renders visibly.
3. Unit/stub tier green; mutation statement covering the reservation
   uniqueness, name validation, and progress projection; repo CI
   green including the Next build integration.

Decide with the reviewer: Next.js/bun integration mechanics, dev
provider shape, how the web reads the store (direct module import in
server components vs a thin internal API - keep it server-side either
way), progress polling cadence.

Locked: standing rails; slice-1/2/3 module semantics (extend, do not
rewrite); no webhook processing in the web app; no operator actions;
no deploy config beyond what `next build` needs to pass locally.

## PICKUP: Slice 4b - (authored after 4a lands)

Placeholder: invite handoff (mint via the existing two-hop path as a
typed operation), the "Revoke isomux's access" confirmed-handoff flow
(R-2026-08-09-3 semantics), resend inside the window, reboot button,
liveness ladder display. Real-box acceptance.

## PICKUP: Slice 5 - (authored after 4b lands)

Placeholder: cancel (grace-week semantics per ruling 9), deprovision
operations (power_off / remove_dns stub / cancel_asset), the operator
attention/alert view, audit trail surfacing.
