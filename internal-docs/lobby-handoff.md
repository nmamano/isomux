# Lobby: hand-off to the PM

Written 2026-09-07 by Nil's Direct Helper, at Nil's request, as the single
record of what the lobby work is, where it lives, what Nil has ruled, and what
is left. Everything below is the state of branch `lobby`, not of main.

## Where the work is

- Worktree `~/nil/isomux-worktrees/lobby`, branch `lobby`, clean.
- 30 commits ahead of main and 123 behind it (2026-09-07). **Do not rebase
  until the PM says so** (Nil's instruction). The Apps screen Nil wants in the
  lobby lives in main past this branch, so it arrives with the rebase.
- Three loops produced these commits: the lobby scene, the members chat, and
  the receptionist. Each left its standing orders in `plans/`.
- Gates on the tip: `bun run build:ui`, `bun test ui/office` (98 pass),
  `bunx tsc --noEmit`, eslint on the touched files. All green.

## What exists

**The scene.** `ui/office/lobby/` draws an agent-free room in the office's
isometric space (same 950x700 box and viewBox, so it drops into the same
viewport rig). `OfficeView` renders it instead of the desk room when the lobby
tab is open. It carries the office's own window (day and night), its clock, its
clouds and sun rays - shared from `ui/office/Floor.tsx`, which now exports
`Cloud` and `SunRays`, not copied. The window still toggles the theme and the
clock still opens cronjobs.

**Colour.** The lobby is warm wood in every theme; only dark and light change
anything, and each theme already declares its mode. The backdrop around the
room keeps the active theme, so Nord looks like Nord. The theme-coloured
palette and the checker floor were gutted on Nil's ruling.

**Props.** `props.tsx` is a registry of families and variants (sofas, armchairs,
tables, fireplaces, shelving, fish, lamps, rugs, plants, wall pieces, cats,
directory, counter, Employee-of-the-Minute plaque). A layout in `layouts.ts`
places variants in floor-tile units, with `flip`, `scale`, `z` (a painter's
order nudge) and `facing`. Each variant declares how many ways it faces: 4 when
it has a drawn back (the three sofas, the club chair, the counter), 2 for a
plain mirror, 1 for rugs and anything carrying text. The scene and the editor
offer only what a prop can do.

**Employee of the Minute.** Already office-global (`lobby/employee.ts`): the
agent that acted last in any room the viewer can see, receptionist excluded,
held for 60 s so a streaming agent does not flicker the face. Nil's list said
this still had to change; it does not.

**Receptionist.** A lobby agent with its own prompt, its ACL, persistence and
UI locks (commits 43d8e0c, bc94fb2, 980a261). The scene draws it at the
layout's `receptionist` slot, in painter's order with the props.

**Members chat.** A human-only chat with a month-file store, paging, edits,
deletes and read pointers, its own capability and wire events, mounted as a
panel beside the lobby (commits c462e4a to d553e24). Privileged agents can post
into it.

**Door.** The lobby has the office's own door on its right wall, opening the
first room. The matching door back needs no drawing: the office already gives a
left door to any room that is not the first, so it appears once the lobby is
room index 0.

**The layout editor.** `ui/office/lobby/LobbyEditor.tsx` plus
`scripts/lobby-editor-server.ts`, registered as the isomux app `lobby-editor`.
Drag props, add and remove them, set variant, wall, height, scale, draw order
and facing, save named layouts on the box and load them back, or paste a
layout's JSON into the text box. Nil's ruling: this is **internal tooling**, to
be kept and reused for future room types, not a user-facing feature. Its output
and save directories are env vars (`LOBBY_EDITOR_OUT_DIR`,
`LOBBY_EDITOR_SAVE_DIR`), falling back to the app data directory isomux hands
it.

## Nil's rulings (locked)

1. Warm wood only; six themes map to dark or light; the backdrop keeps the
   theme.
2. Ghosts in ordinary rooms keep floating past the SE wall: that is what shows
   which room a boss is watching.
3. In the lobby, ghosts stand at named spots and **should move around** - Nil,
   2026-09-07: the shuffling is funnier than a stable seat. So do NOT pin a
   ghost to its spot by connection id.
4. The Lobby tab's browser title is the Office Name setting, never "Lobby".
5. The layout editor is internal tooling.
6. The final room arrangement is the saved profile `nilo`
   (`<save dir>/nilo.json`), which also carries `ghostSpots`.

## The final layout and its ghost spots

`nilo.json` holds the placements, the receptionist slot and ten ghost spots:
two on the blue sofa, one in each of the three armchairs, two on the
chesterfield, one at the fish tank under the cat, one in front of the
bookshelf, one at the record player. Fold it into `layouts.ts` as the lobby's
layout when the branch lands.

## Open, for the PM

- **Room type.** Nil predicts more room styles. Introduce a room type now: the
  lobby is a normal room with one agent slot and its own visuals. The seam is
  already there - the lobby is a synthetic room injected at the projection
  layer, with no stored record.
- **Receptionist as a profile.** Make "Isomux Receptionist" a pre-loaded agent
  profile, so the receptionist is an ordinary agent that happens to start from
  it and resetting it needs no new machinery. Then decide, leaning permissive:
  it can be killed, it can message other agents, it has a room prompt and
  memories like anyone else.
- **Ghost movement.** Spots exist; make them move. Also file-tracked: clicking a
  seat to move your own ghost is task 365c5d69 (P1).
- **Door that creates a room.** Not lobby-specific: the last room visible to a
  user always shows a door which, clicked, opens a small "Open new room?"
  confirmation, and confirming creates the room and goes there. This also
  settles offices with zero rooms.
- **Members chat.** Unread dot in the room nav bar; a home on mobile. Pending.
- **Docs.** Every surface in `internal-docs/documentation.md` that a room type,
  the lobby, the receptionist or the members chat makes stale. Pending, before
  merge.
- **Mobile.** Nil is gutting the agent-list view, so the lobby only has to work
  in the rendered office.
- **Apps screen in the lobby.** Nil's request; the code for it is in main past
  this branch, so it lands after the rebase.

## Loose ends at hand-off (2026-09-07)

- A stash sits on this branch, `seating rewrite (Marc asked to revert
  2026-09-06)`. Superseded by what landed; drop it (`git stash drop`) unless
  someone wants the padded-arm experiment back.
- The `lobby-editor` app runs FROM THIS WORKTREE
  (`cwd ~/nil/isomux-worktrees/lobby`). Moving or removing the worktree breaks
  it; point its cwd at wherever the code ends up, or delete the app
  (`DELETE /api/apps/lobby-editor`) once the branch lands.
- One eslint warning stands in `LobbyEditor.tsx`: setState inside the effect
  that fetches the saved-layout list (`react-hooks/set-state-in-effect`).
  Harmless, and the only warning in the lobby files.
- The trap that cost time today: the editor's `GET /rebuild` rebuilds the
  BROWSER bundle only. A change to `scripts/lobby-editor-server.ts` needs an
  app restart, or the old process keeps answering (it replied to every saved
  layout with plain "not found", which read as a JSON syntax error).

## Running it

- Preview one layout or the prop sheet:
  `bash scripts/lobby-preview.sh <out-subdir> <name>="<query>"`, which builds
  `ui/office/lobby/preview-entry.tsx`, serves it on port 9877 and screenshots
  with headless Chrome. Query params: `mode`, `theme`, `layout`, `sheet=props`,
  `ghosts=N`, `v=family:variant`, `p=<placement JSON>`, `edit=1`.
- The editor app: `curl -s localhost:4000/api/apps/lobby-editor` for its port
  and URL. `GET /rebuild` rebuilds the browser bundle; changing the SERVER file
  needs an app restart, which is the trap that made saved layouts fail to load
  once.

## Integration audit (2026-09-08)

The merge preparation and current findings are in [lobby-audit.md](lobby-audit.md).
The PM ruled that lobby ghost rendering, placement and movement all stay in
the follow-up; the saved nilo spots land without a live consumer.
