# Back room design (task 5b503e32)

Status: approved for build by Nil on 2026-10-15 (relayed by the PM and the
Lead). Mocks of the look: /tmp/b1042/mocks/r2.

## Concept

A room is one project, with one room prompt and one room memory. A room has
two areas:

- **Front**: the room view of today, with 8 desks, for the agents that people
  talk to.
- **Back room**: a basement on its own screen, reached through a trap door in
  the front floor: long tables with a laptop at each agent's place, up to
  100 agents.

A back agent is a normal agent whose seat is in the back room: same settings,
own instructions and memory, clear, handoff, messaging, paging and spawning,
as any agent. Members chat with it. The only differences are where it is
drawn and how agent lists show it (one line per back room, see Discovery).

The lobby has no back room. It keeps its 1 slot.

## Always there (task e2fb9fa0)

Every room except the lobby has a back room (Nil, 2026-10-30: "one fewer
setting"). From task b16f1e6a until then it was a per-room setting, off for a
new room.

- A stored `backRoom` field on a room in agents.json, true or false, is
  ignored at load and not written again. An older release reads the absent
  field as off unless back agents sit there, so a downgrade loses no agent.
- `PATCH /api/rooms/:roomId` ignores a `backRoom` key, whatever its value, so
  an older client gets no error. A body with only that key is a 204 no-op for
  a room that exists, the lobby included, and 404 for one that does not.
- The lobby has none: `desk: null` there is 422 `invalid_desk`.

## Seats and storage

One field, `desk: number`, on `AgentInfo` and `PersistedAgent`:
- 0 to 7: a front desk, as today.
- 8 to 107: a back seat.

shared/desks.ts holds the format and the helpers. Every consumer goes through
them; no consumer writes `desk - 8` or `desk >= 8` inline.
- `BACK_SEAT_BASE = 8` is a storage format: a literal that must not follow
  `DESK_SLOTS`, so that a front layout change never re-reads stored seats.
- A seat is (table, stool), numbered `table * 10 + stool`. The stride is the
  max side (10), so growth and shrinking never renumber a seat.
- `isFrontDesk`, `isBackSeat`, `backSeatOf`, `deskOfBackSeat`,
  `isValidPlacement` (front desk, or back seat outside the lobby).
  `isValidDesk` stays the front-only check.

No migration: every existing state file holds 0 to 7. A current release that
reads a seat (after a manual downgrade, or a tab with the old bundle) does not
draw the agent; the agent still runs (Reviewer 1's trace of DeskUnit.tsx,
useGhostTransitions.ts and Seasonal.tsx, round 1).

## Size of the back room

The room is always n × n seats, from 3 × 3 up to 10 × 10. n is derived from the
seats in use, with no stored state (`backRoomSide`):
- at least 3, and wide enough for the outermost seat in use;
- one more when every seat of that square is taken, so a free seat always
  exists until 100.

Growth adds one stool to every table and one new table, so no agent changes
seat. The building does not grow (task dc9786a8; Nil: "going down shouldn't
change the building size"): the back room draws the front's floor and walls at
the front's place and scale. The tables sit centred on the floor at full size
up to 6 × 6; in a larger room, tables, stools and figures shrink together to
fit. The room shrinks only when its outer ring is empty. A new agent takes the
first free seat of the smallest square that has one (`firstFreeBackSeat`):
ring by ring from the inner corner, by table and then stool. Past 100, a spawn
or move fails with 409 `back_room_full`, "The back room is full (100 agents)."

## Placement rules

**Spawn** (`POST /api/agents`, `desk?: number | null`):
- A free front desk: that desk. A taken one: the first free front desk, then a
  back seat.
- `null` or no desk: a back seat.
- A back seat number: 422 `invalid_desk`. The server assigns seats.
- The UI: a click on an empty front slot spawns there; "+ New agent" on the
  back screen spawns into the back.
- The internal spawn with no desk (welcome-agent bootstrap): the first free
  front desk, then a back seat.

**Move** (`POST /api/agents/:id/move`, `{targetRoomId, desk?}`):
- A free front desk: that desk, in any room, the agent's own room included.
- `null`: a back seat.
- No desk: the agent keeps its area. A front agent takes the first free front
  desk, then a back seat; a back agent takes a back seat.
- A taken desk: 409 `desk_taken`. There is no trade.
- The agent's own room with no desk, or its own area: a no-op, 200 with the
  unchanged agent (as today's same-room move).

**Revive** (`POST /api/agents/:id/revive`, `desk?: number | null`): a free
front desk, or a back seat for `null` or no desk. A taken desk stays 409
`desk_taken`.

**Lobby**: no back room. No desk there means its one desk (desk 0) for
spawn, move and revive, whatever the agent's area. `desk: null` for the lobby
is 422 `invalid_desk`; a full lobby stays 409 `no_free_desk`.

Behaviour changes: a spawn with a desk into a full front, and a move with no
desk into a full front, returned 409 `no_free_desk`. Both now take a back
seat.

`swapDesks` stays front-only.

## Discovery

Approved by the Lead, 2026-10-15.
- `GET /agents` from an agent or a cron run: front agents (and the lobby) as
  today, and per room with back agents one summary entry
  `{name: "{n} in the back room", backRoom: true, roomId, roomName, room,
  agents, busy, pendingPrompt}`, in place of the first back agent. It has a
  string name (jq name filters keep working) and no id (not a message
  target). Rooms come from the caller's room access, as for every entry.
- `GET /agents?back=1` from any caller: every agent; back agents carry
  `backRoom: true`. A member cookie or API token gets this list by default.
- `back` accepts only `1`, and never with `killed`: anything else is a 400.
  The `?killed=1` branch is unchanged.
- `/isomux-all-hands`: front agents as today, plus one line per room,
  "{n} in the back room".
- The four peer skills (soft-handoff, second-opinion, peer-review,
  pair-programming) look peers up with `?back=1`.

## The front

- The trap door: a wooden hatch on the front floor at scene point (445, 310),
  in every skin, always there in every room but the lobby (tasks
  f0af4677, e2fb9fa0). Light
  shows through the planks when a back agent works; badges above it:
  "{n} asking", "{n} error", each hidden at 0. A back agent's unread output
  lights nothing on the front: people rarely talk to the back room (Nil).
  An empty back room leaves it closed and quiet. A click opens the back screen. A desk
  dropped on it moves to the back. The b key goes between the front and the
  back screen. Phone tap box: 60 × 44 px.
- Room tabs during a desk drag, or a figure drag on the back screen: a drop
  on a tab moves the agent to that room's first free front desk; a "Back
  room" target beside each tab moves it to that room's back room. A full
  area takes no drop, and the agent's own room offers only the area the
  agent is not in (task 335384f8).
- "Move to Room" in the agent dialog: each room offers its front and, outside
  the lobby, its back room. The agent's own room offers only the area the
  agent is not in.
- No room shows an agent count: the room tab (RoomTabBar.tsx:598), the
  tucked-room list (TuckedRoomsChip.tsx:282) and the "Move to room" buttons
  (EditAgentDialog.tsx:1426). The tucked-rooms chip keeps its count of
  rooms.
- The office header counts what the screen draws: front agents on the front,
  back agents on the back screen.
- Desk menu: "Move to back room".

## The back screen

- A basement: brick walls, a wood parquet floor, pendant lamps, a plant in
  the back corner and one in the front corner (task a442aa4f). One look in
  every skin. The ladder up to the trap door stands at the right end of the
  right wall, under the trap door; the "BACK ROOM" stencil sits between the
  back corner and the ladder. The brick courses wrap over the walls' cut ends
  and the tops show joints; the floor's blocks run down the slab's sides,
  which reach out under the walls (task f0af4677). The lamps hang above the
  stencil and the board, spaced evenly from the floor's left corner to the
  ladder at staggered heights, so no lamp or cord is in line with another;
  the ladder shows a focus ring for keyboard focus only (task 79c967a8).
  A phone crops the wall ends, so there the ladder and the board's left end
  move in by the crop and show at the default fit (task d9d919db).
- The board fills the left wall (task a442aa4f): a line per seated agent in
  seat order, with a status dot, the name and the topic, each cut to its
  column; the full text is the line's tooltip. A click, Enter or Space on a
  line opens that agent's log. The columns are as many as the wall holds, so
  a 3x3 room shows all nine seats; past the board's slots, its last slot
  counts the rest.
- n tables of n seats; an empty seat is a chair. Each agent is its own
  `Character`, seated behind a laptop, with a
  small nameplate above the head (status light and name, the front's style), a
  purple "•••" bubble when unread, an amber "?" bubble when asking, and the
  error pose with a red light. Figures are static (no animation): measured
  2026-10-15, 100 static figures draw at the front view's frame time, 100
  animated ones 3 to 4 times slower.
- Zoom and pan as on the front (mouse wheel, trackpad pinch or Ctrl+wheel, drag, touch pinch, +, - and 0, and the zoom
  buttons), with the front's useViewport, rest view and frame, and the
  front's one saved view, so going down or up keeps the zoom and pan. One
  finger pans at any scale (no room swipe here). The embed does not zoom it,
  as on the front.
- A bar over the top of the room: "← {room}", "Back room", "+ New agent". It
  takes no height, so the room's view is the front's size. Figure menu: "Move to front"
  (first free desk; disabled with "Front is full").
- On a desktop, a figure dragged onto the ladder moves to the first free
  front desk, the mirror of the trap door; during the drag the ladder shows
  "Move to front", or "Move to front (full)" and takes no drop when every
  front desk is taken (task c18ef3e8). The room tabs take the drag too.
- The screen's edge darkens as the front's does, stronger (task c18ef3e8).
- Navigation: a deep level over today's one-entry history model. Back from a
  back agent's log returns to the back screen; a reload lands on the front.
  A click on any room tab, this room's included, or on the ladder opens a
  front.
- The log of a back agent has a strip: "In the back room of {room}. People talk
  to the front:" with a chip per front agent.

## Demo

The demo office shows 1 back agent.

## Slices

1. Storage and server: seats, spawn, move and revive, the cap, growth and
   shrink rules. Then discovery, once the Lead settles the shape.
2. The front: trap door, drag onto it, no room counts, header counts.
3. The back screen: the room, growth, fit and pan, phone.
4. The log strip, the demo with 1 back agent, docs.
