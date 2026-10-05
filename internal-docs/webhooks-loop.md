# Webhooks loop (standing orders)

Slice loop authorized by Nil 2026-10-05 for board task d500f765. It runs at the
same time as the pager loop (internal-docs/pager-loop.md) and two batch lanes,
so it works in a worktree, not in main. Lanes alternate: Isomux Worker 1 /
Isomux Reviewer 1 on odd slices, Isomux Worker 2 / Isomux Reviewer 2 on even
slices. One worktree, `loop-webhooks` (branch `loop-webhooks`), kept for the
whole loop. At every slice start the worker runs `git reset --hard main` in it
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
- [ ] S2 - registry, API, auth
- [ ] S3 - ingress and the agent target
- [ ] S4 - cronjob target, and the "none" schedule (ruling 7)
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
