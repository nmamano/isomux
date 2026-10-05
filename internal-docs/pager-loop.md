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

- [ ] P1 - page record, store, agent route
- [ ] P2 - Discord delivery and member settings
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
