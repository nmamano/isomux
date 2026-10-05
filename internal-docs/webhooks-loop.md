# Webhooks loop (standing orders)

Slice loop authorized by Nil 2026-10-05 for board task d500f765. It runs at the
same time as the pager loop (internal-docs/pager-loop.md) and two batch lanes,
so it works in a worktree, not in main. Lanes alternate: Isomux Worker 1 /
Isomux Reviewer 1 on odd slices, Isomux Worker 2 / Isomux Reviewer 2 on even
slices. One worktree, `loop-webhooks` (branch `loop-webhooks`), kept for the
whole loop. At every slice start the worker runs `git merge --ff-only main` in it (the safety hook blocks `git reset --hard`)
(the PM has merged the previous slice into main by then). The worker re-reads
this whole file at every slice. Delete this file at loop close.

North star: an external service (GitHub first) triggers work in an office
through a signed, public webhook. A delivery starts a cronjob run or sends a
message to an agent. The design is internal-docs/webhooks-design.md; read it in
full at every slice. Where this file and the design disagree, this file wins.

## Rulings (final)

1. D1: one target per hook, as the design says.
2. D2: the Webhooks panel is a second tab on the Schedules page.
3. D3: the dry-run route is in.
4. D4: no member-supplied secret. The server generates every secret.
5. D5: backups exclude `webhooks/secrets.json`. After a restore, the owner
   rotates once per hook.
6. D6: a webhook run follows the manual overlap rule (each delivery starts a
   run, bounded by the dispatch limit).
7. D7 (overrides the design's "disabled cronjob" text in section 4b): a
   cronjob that runs only from webhooks has an explicit schedule choice,
   `Schedule` variant `{ type: "none" }`. The scheduler never fires it. Run
   now and webhooks run it. The cronjob dialog offers it as a schedule option.
   `enabled` keeps its meaning (gates the clock only); a webhook can still run
   a disabled cronjob, as Run now can. Older state files need no migration;
   every place that switches on `Schedule["type"]` is found by grep, not
   assumed.
8. D8: the limit values in the design stand: ingress 300 per minute with a
   burst of 60; dispatch 10 per minute and 500 per day; 500 log rows; 24-hour
   dedup; 5 MiB body; 100 hooks per office; 20 rules per hook. Constants, not
   env vars.

## Gates (every hand-off, on the committed hash)

- `bun run build:ui` (plus `bun run build:demo` when the diff touches
  ui/demo-server.ts or shared/storage-labels.ts)
- scoped tests on the touched area; a slice that adds or changes a route also
  runs server/test-support/routes-table.test.ts and
  routes-agents-manifest.test.ts
- a slice that adds a capability also runs
  server/test-support/identity-tokens.test.ts (it pins each scope's exact set)
- a slice that names a route in an agent-reference page or the system prompt
  also runs server/backends/opencode/authority-broker.prompt-routes.test.ts
- eslint on touched files
- `bunx tsc --noEmit`

The PM runs the full suite once at loop close, not per slice.

## Prohibitions

- No prettier, no server restart, no push.
- No edits outside the slice's scope. A file that the pager loop or a batch
  lane also changes (routes table, ROUTE_LABELS, system prompt, agent-reference
  index, i18n catalogs) gets only additions; never reorder or reformat its
  existing lines.
- The secret never appears in a response, log row, event, prompt or message,
  except the two human secret routes.

## Decision protocol

- Worker and reviewer settle implementation details between them.
- The PM settles anything the design or this file does not settle, and any
  policy or API-shape question. Ask the PM by message; do not guess.
- Anything that needs Nil is written as PARKED FOR NIL in the slice report,
  with the proposed answer. The loop does not stop for it.

## Slice report (worker to PM, once, after the reviewer's final approval)

What changed; how it was verified; the approved hash; all user-visible and
agent-facing copy verbatim; any removed or replaced test assertion, named;
PARKED FOR NIL items.

## Slices

- [x] S1 - pure core (verify, match, block): 541fcef2, 102 tests; intro line variants for hmac-sha256 and empty event or delivery id are in block.ts
- [x] S2 - registry, API, auth: 19845377; the system-prompt line landed here (system-prompt.test requires every reference topic to be advertised)
- [x] S3 - ingress and the agent target: d022a0e8; a cronjob target answers target_unavailable ("cronjob targets are not supported yet") until S4
- [x] S4 - cronjob target, and the "none" schedule (ruling 7): 54addcfc; "none" reads "On demand"
- [ ] S5 - UI and docs

## PICKUP S1 (Worker 1 / Reviewer 1)

Goal: design section 11, S1, verbatim scope: `server/webhooks/verify.ts`,
`server/webhooks/match.ts`, `server/webhooks/block.ts`, with the tests listed
there. No wiring, no routes, no state.

Mechanics and traps:
- Verify compares in constant time (`crypto.timingSafeEqual` on equal-length
  buffers) and never throws on a malformed header. Check GitHub's documented
  vector locally before trusting the value in the design.
- The block budget (design section 4, "Size budget") measures escaped length
  and cuts on code points. The budget numbers in the design are claims from a
  Bun check on 2026-10-05; the tests decide.
- Types that later slices need (rule, args, block input) go in the module or in
  shared/types.ts, whichever the reviewer agrees; keep the surface small.

Acceptance: every S1 test in design section 11 exists and passes; a mutant that
removes the `<` escape or the surrogate-pair guard fails a test.

Decide with the reviewer: module boundaries and type names.

Locked: rulings above; the design's rule language and block format.

## PICKUP S2 (Worker 2 / Reviewer 2)

Goal: design section 11, S2: `server/webhooks/registry.ts` (records and
secrets, design section 2), the agent routes of design section 7 (all except
`hooks.deliver`, which is S3), capabilities `webhook:read`/`webhook:write`, the
owner guard, the `webhookTargetAllowed` precondition, events, the backup
exclusion, the storage label, the `webhooks` agent-reference page and the
ROUTE_LABELS entries (four locales). Dry run uses the S1 core and writes no
row. No ingress, no dispatch, no UI.

What S1 left (merged as one commit on main): `server/webhooks/{verify,match,block}.ts`
with exported limit constants; `WebhookScheme` and `WebhookRule` in
shared/types.ts. Reuse them for validation; do not redefine the limits.

Mechanics and traps:
- PATCH merges the request into the stored record and runs the target check on
  the whole result, also when the request does not name `target` (design
  section 4, "Who may point a hook at what").
- The secret lives only in `webhooks/secrets.json` (0600, dir 0700). The test
  that no webhook route response contains the secret covers every route.
- Secret routes accept `scope === "user"` only: an agent, a privileged agent, a
  cron run, an app and an API token get 403.
- `shared/storage-labels.ts` is touched, so `bun run build:demo` is in the
  gates.
- The pager loop adds its own reference page, capabilities and ROUTE_LABELS
  entries in parallel. Additions only; on a rebase conflict, keep both sides.
- The reference page text in design section 7 is a draft for Nil to cut: put
  the final text verbatim in the slice report.
- The cronjob target check uses the existing cronjob guards; ruling 7's "none"
  schedule is S4, not here.

Acceptance: every S2 test in design section 11 exists and passes, through the
real route table.

Decide with the reviewer: module split between registry and handlers, the wire
shape details not fixed by the design.

Locked: rulings above; design sections 2 and 7.

## PICKUP S3 (Worker 1 / Reviewer 1)

Goal: design section 11, S3: `server/webhooks/ingress.ts` (the public
`POST /hooks/:id` handler, design section 1 stages), `server/webhooks/deliveries.ts`
(the log, the dedup index and the counters, design sections 5 and 6), the
wiring in `buildServer` before the auth wall, `hooks.deliver` in
`PUBLIC_ROUTES`, and the agent target: the `webhook` sender kind in the four
places design section 4a names, delivered with `prepareEnqueue` and
`enqueueMessage` without steer. The cronjob target is S4: until then a
delivery whose hook targets a cronjob gets `target_unavailable` with a detail
that says so, and S4 replaces that branch.

What S2 left (merged as 19845377): `server/webhooks/registry.ts` (records,
secrets, a read-only `readDeliveries`, which may move to deliveries.ts),
`formatWebhookSenderPrefix` in shared/identity.ts, the routes and the dry run.
`counters`/`countersSince` on the wire come from a deps hook that returns `{}`
and boot time today; S3 feeds it the real counters.

Mechanics and traps:
- Match the raw event header exactly, and treat `ping` as ping only for
  `github-hmac-sha256`, as the dry run does. Reuse the S1 core and the dry
  run's code path; do not write a second matcher.
- Stages 1 to 6 write no row; an anonymous caller can only raise a counter.
  Unknown ids get 404 before the rate limiter.
- The claim (stage 7) is one synchronous step with no await between lookup and
  append. The dedup window rebuilds from deliveries.json at boot, and a
  `pending` row left by a crash becomes `target_unavailable` ("server
  restarted").
- The body cap is enforced while reading the stream, also without
  `Content-Length`. The global `maxRequestBodySize` is not the cap.
- Reuse `createAppMessageLimiter()` for the dispatch limit (rename to a
  neutral module only if needed).
- The route does not depend on forwarding headers, and an app hostname never
  reaches the handler.
- Tests go through `buildServer`'s fetch with a real HMAC, as design section
  11 lists, with a fake clock for the window tests.

Acceptance: every S3 test in design section 11 exists and passes; a mutant that
puts an await between the dedup lookup and the append fails the concurrent
test; a mutant that writes a row for a bad signature fails.

Decide with the reviewer: the module split between ingress and deliveries, the
deps shape for the office wiring.

Locked: rulings above; design sections 1, 5 and 6.

## PICKUP S4 (Worker 2 / Reviewer 2)

Goal: design section 11, S4: the cronjob target. `runCronjobFromWebhook` in
server/cronjob-manager.ts calls `fire(job, "webhook", ...)`; the first user
message is `job.prompt`, a blank line, and the data block; `promptSnapshot`
stores that text; `CronjobRunTrigger` gains `"webhook"`; `CronjobRun.webhook`
links the run to the delivery row; the cronjob system prompt gets the one
sentence for webhook runs (design section 4b). The S3 ingress branch that
answers `target_unavailable` for a cronjob target is replaced by the real
dispatch. Plus ruling 7: the `{ type: "none" }` schedule.

What S3 left (merged as d022a0e8): the ingress, the delivery log, the
dispatch path for agent targets, and the placeholder cronjob branch with the
detail "cronjob targets are not supported yet".

Mechanics and traps:
- Ruling 7: every place that switches on `Schedule["type"]` is found by grep:
  the scheduler (never fires "none"), next-run computation, validation, the
  cronjob dialog (offers it as a schedule option), the list and run views,
  the cronjob agent-reference page, and anything that formats a schedule for
  humans or agents. An older state file with no "none" job loads unchanged.
- At dispatch time the cronjob must exist and the hook owner must still own it
  or be an office owner (design section 4, "Who may point a hook at what").
  A deleted cronjob gives `target_unavailable`.
- Overlap follows ruling 6: a webhook run ignores the in-flight skip and never
  blocks a scheduled run. The usage cap, timeout and run token still apply,
  because they live in `fire()`.
- A webhook run of a disabled cronjob runs, as Run now does.
- The run row links to the delivery row, and the delivery row's `target`
  names the run id.
- Tests for the cronjob side go in cronjob-manager.di.test.ts, as the design
  says; the ingress side extends the S3 route tests.

Acceptance: every S4 test in design section 11 exists and passes; a "none"
job never fires on the clock (fake clock) and runs from Run now and from a
webhook; a mutant that lets the scheduler fire a "none" job fails.

Decide with the reviewer: how the dialog presents "none", the human-readable
schedule text for it (put it verbatim in the report).

Locked: rulings above; design section 4b except where ruling 7 overrides it.

## PICKUP S5 (Worker 1 / Reviewer 1)

Goal: design section 11, S5, and design sections 8 and 9: the Webhooks panel
as a second tab on the Schedules page (ruling 2), with the list, the hook
detail ("Set up in GitHub" with the URL, content type, the secret behind
"Show" for members only, the rule event names, and "Rotate secret" with a
confirm step), rules and target editing in a dialog like `CronjobDialog`, the
counters, the delivery log, and the dry run. The run views show webhook runs
with the hook name and link to the delivery. The docs surfaces in
internal-docs/documentation.md.

What S1-S4 left (merged up to 54addcfc): every route, the events
`webhook_upserted`/`webhook_deleted`, the sender label in the log view, the
trigger keys `schedules.trigger.webhook`/`webhookBy`, and the "On demand"
schedule.

Also in this slice:
- Flake risk: server/webhooks/deliveries.test.ts "trims to the row limit, and
  a trimmed body is new again" takes 2-4 s alone against the 5 s default and
  timed out once in S4's scoped batch. Make it fast (for example a smaller
  injected row limit or cheaper setup); do not raise its timeout. Measure it
  before and after, and give both numbers in the report.
- The cronjob list's "Last run" reads `lastFireAt`, which only scheduled fires
  set, so an "On demand" job always shows "-". PM ruling: "Last run" shows the
  newest run of any trigger (scheduled, manual or webhook).

Mechanics and traps:
- The secret is shown only to a human session; the "Show" and "Rotate"
  controls are absent for anyone the routes refuse. The UI never caches the
  secret beyond the open detail.
- Design section 9: the panel always shows "GitHub must reach this address
  from the internet." under the URL, and says the office has no public address
  when the public origin is localhost or loopback.
- Glyphs are SVG or `StatusShape`, never dingbats (iOS renders them as
  emoji).
- Mobile: the panel works at 390px.
- Docs: README and landing are Nil's copy; propose wording in the report only.
  docs/features.md and api/chat.ts (both still describe recurring schedules
  only) get short drafts in the slice, quoted verbatim in the report. The
  agent-reference page text from S2 and S3 is also up for Nil's cut: quote its
  final form.
- `ui/demo-server.ts` gets a fixture hook so the demo shows the panel; that
  adds `build:demo` to the gates.

Acceptance: DOM tests for the list, the secret button (hidden for non-owners
and agents), the dry run, and the "Last run" fix; the four-locale i18n test;
the system-prompt snapshot if touched; headless-Chrome screenshots of the
panel at desktop and 390px width, and of a webhook run in the run view.

Decide with the reviewer: the panel layout, the dialog fields.

Locked: rulings above; design sections 8 and 9.
