# Pager loop (standing orders)

Slice loop authorized by Nil 2026-10-05 for board task cb34ffc9. It runs at the
same time as the webhooks loop (internal-docs/webhooks-loop.md) and two batch
lanes, so it works in a worktree, not in main. Lanes alternate: Isomux Worker 3
/ Isomux Reviewer 3 on odd slices, Isomux Worker 4 / Isomux Reviewer 4 on even
slices. One worktree, `loop-pager` (branch `loop-pager`), kept for the whole
loop. At every slice start the worker runs `git reset --hard main` in it (the
PM has merged the previous slice into main by then). The worker re-reads this
whole file at every slice. Delete this file at loop close.

North star: a member whose browser is closed learns that something in their
office needs them. Agents and apps raise a page; the server sends it to the
member's Discord and repeats it until someone acks it; a pager view lists all
pages. The design is internal-docs/pager-design.md (agreed with Nil
2026-10-05); read it in full at every slice. Where this file and the design
disagree, this file wins.

## Rulings (final)

1. Scope is the design's "v0 scope". Its "Out of scope" list stays out,
   including the watchdog pages for agent failures.
2. Code names use `Pager`/`PagerEntry`; user-facing copy says "page". Never
   reuse the UI's existing `page` view field for a pager record.
3. The Discord webhook URL is a credential. It is never logged, never in a
   page record, never in an event or a response other than its masked form,
   and never in an agent's environment.
4. The default repeat interval is a constant (5 minutes), not an env var.
5. Visibility follows room access, the same as tasks.

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
- No real Discord sends from tests. Tests stub the HTTP call; the one live
  check against a real Discord webhook is the PM's, with Nil.
- No edits outside the slice's scope. A file that the webhooks loop or a batch
  lane also changes (routes table, ROUTE_LABELS, system prompt, agent-reference
  index, i18n catalogs, Settings → You) gets only additions; never reorder or
  reformat its existing lines.

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

- [x] P1 - page record, store, agent route: dabd298e; the reference page says pages are not sent yet, which P2 must change
- [x] P2 - Discord delivery and member settings: 2b90953a; link shape `<origin>/?pager=<id>` (pagerLink in server/pager-delivery.ts)
- [ ] P3 - app route
- [ ] P4 - pager view, badge, docs

## PICKUP P1 (Worker 3 / Reviewer 3)

Goal: the page record (design "The page record"), persisted with the same
storage pattern as the task board, and the agent routes: raise
(`POST /api/pager`, `{title, body?, key?}`, source and target from the token),
dedupe by key (design "Raising a page"), resolve by the source, and list, ack
and resolve for members. Events so a UI can follow changes later. Agent
reference page `pager`, ROUTE_LABELS entries, and the system-prompt line from
the design. No delivery, no UI view.

Mechanics and traps:
- Read the task board's store and routes first and copy their shape
  (persistence, room visibility, events, version handling if the board uses
  it).
- The target is the source's owner: the agent's manager. Find where an agent's
  manager is recorded; do not assume a field name.
- A raise on an acked page updates it and does not re-open it. A raise after
  resolve creates a new page.
- Bound title and body length with constants (sanity bounds only), and bound
  open pages per source so a looping agent cannot fill the store.
- Leave a clean seam for P2: a delivery state on the record that P1 sets to
  "not delivered", and one place where a new or re-raised page is handed to
  delivery.

Acceptance: raise, dedupe, ack, resolve and list work through the real route
table; an agent cannot set source or target; a member without room access
cannot see or act on a page; state survives a restart (reload from disk in the
test).

Decide with the reviewer: route shapes for list/ack/resolve, the bounds,
the store file layout (backward compatible: a missing file means no pages).

Locked: rulings above; the design's state machine (`open`, `acked`,
`resolved`).

## PICKUP P2 (Worker 4 / Reviewer 4)

Goal: design "Delivery: Discord": the member settings (webhook URL, Discord
user ID, repeat interval or never, a "send test page" button) in Settings →
You, the sender, the repeat while a page is `open`, the one "resolved"
message, failure classes on the record, and the 429 `retry_after` wait. Wire
it into the P1 seam (`onRaised` in server/pager-store.ts, a no-op in
isomux-office.ts today). Update server/agent-reference/pager.md, which says
pages are not sent yet.

What P1 left (merged as dabd298e): the store, the routes, `pager_upserted`,
`delivery: {state: "not_delivered", sends, lastAttemptAt?, lastFailure?}` on
each record, and the seam.

Mechanics and traps:
- Ruling 3: the Discord URL never reaches an agent. The per-member env file
  behind Settings → You → Individual connections is injected into agents, so it
  is the wrong home. Find or add a server-side per-member store that no agent
  path reads, and say in the report where it lives and why no agent route
  returns it.
- The server POSTs to a URL a member typed, so accept only Discord webhook URLs
  (https, host discord.com or discordapp.com, path /api/webhooks/...). Anything
  else is refused at save time.
- `allowed_mentions` names only the member's Discord user ID; no @everyone,
  no role pings, whatever the title or body holds.
- The message links to the page in the office. The pager view lands in P4, so
  settle the link shape now (for example a query parameter the UI reads) and
  record it in the report; P4 implements the receiving side. The office origin
  comes from where other absolute office links come from: find it.
- The repeat survives a restart: on boot, open pages resume their schedule from
  `delivery.lastAttemptAt`, without a burst of sends.
- Tests stub the HTTP call (prohibition: no real Discord sends).

Acceptance: a new page reaches the stub once with the mention and the link; an
open page repeats at the interval and stops on ack and on resolve; resolve
sends one "resolved" message; a 429 waits `retry_after`; each failure class
lands on the record without the URL or the response body; a member with no URL
gets `no_webhook` and nothing is sent; the URL appears in no response, event or
log line except its masked form.

Decide with the reviewer: the settings route shape, the timer design, the
message layout.

Locked: rulings above; Discord as the only channel.

## PICKUP P3 (Worker 3 / Reviewer 3)

Goal: design "Raising a page", the app half. An app raises a page with its app
token on a new app route next to `apps.sendMessage` (`POST /api/app/message`),
and resolves its own page, so a health app can page when its agent is down and
resolve when the check passes again. The source is the app (its name and its
room); the target is the app's owner. Dedupe, bounds, delivery and events work
as for agents, through the P1 store and the P2 delivery.

What P1 and P2 left (merged as dabd298e and 2b90953a): the store with
`source: {kind: "agent", ...}`, the agent routes, the `onRaised` and
`onTransitioned` seams, and the delivery module.

Mechanics and traps:
- The APP scope holds only `app:message` today, and
  server/test-support/identity-tokens.test.ts and routes-table.test.ts pin that
  an app reaches exactly one route. PM ruling: the APP scope also gets
  `pager:raise`, and an app reaches exactly the app raise and app resolve
  routes besides `apps.sendMessage`. Change those pins on purpose and name each
  changed assertion in the report.
- `source` becomes a union with an app variant. Every place that reads
  `source.agentId` is found by grep, not assumed; members list, ack and resolve
  app pages under the same room-access rule.
- An app resolves only its own pages: same app identity, never another app's
  or an agent's.
- Find where an app's owner and room are recorded; do not assume field names.
- The apps agent-reference page tells agents how their app code calls the app
  routes: add the page route there, and to the pager page.
- ROUTE_LABELS covers agent-facing routes only; check whether app routes have
  labels today and follow that.

Acceptance: an app token raises, dedupes and resolves its own page through the
real route table; it cannot resolve another source's page or reach any other
route; the page reaches the app owner's Discord stub; a member with room access
sees and acks it.

Decide with the reviewer: route paths, the source union shape.

Locked: rulings above; the PM ruling on the APP scope in this pickup.
