# Back room design (task 5b503e32)

Status: approved for build by Nil on 2026-10-15 (relayed by the PM and the
Lead). Mocks of the look: /tmp/b1042/mocks/r2 (the room size there is the
old fixed 10 × 10; the build grows the room as below).

## Concept

A room is one project, with one room prompt and one room memory. A room has
two areas:

- **Front**: the room view of today, with 8 desks, for the agents that people
  talk to.
- **Back room**: a basement on its own screen, reached through a trap door in
  the front floor. It is a sweatshop: long tables with stools, up to 100
  agents.

A back agent is a normal agent whose seat is in the back room: same settings,
own instructions and memory, clear, handoff, messaging, paging and spawning,
as any agent. Members chat with it. The only differences are where it is
drawn and how agent lists show it (one line per back room, see Discovery).

The lobby has no back room. It keeps its 1 slot.

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
seat. The room shrinks only when its outer ring is empty. A new agent takes the
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
  in every skin, always there in every ordinary room (task f0af4677). Light
  shows through the planks when a back agent works; badges above it:
  "{n} asking", "{n} error", each hidden at 0. A back agent's unread output
  lights nothing on the front, the room tab dot included: people rarely talk
  to the back room (Nil). An empty back room leaves it closed and quiet. A click opens the back screen. A desk
  dropped on it moves to the back. Phone tap box: 60 × 44 px.
- Room tabs during a desk drag: a drop on a tab moves the agent to that
  room's first free front desk; a "Back room" target beside each tab moves
  it to that room's back room. A full area takes no drop.
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

- A basement: brick walls, concrete floor, bulbs, "BACK ROOM" on the wall. One
  look in every skin. The ladder up to the trap door stands at the right end
  of the right wall, under the trap door; the board hangs between the back
  corner and the ladder. The brick courses wrap over the walls' cut ends and
  the tops show joints; the floor's checkerboard runs down the slab's sides,
  which reach out under the walls (task f0af4677). The bulbs hang above the
  "BACK ROOM" title and the board, spaced evenly from the floor's left corner
  to the ladder at staggered heights, so no bulb or cord is in line with
  another; the ladder shows a focus ring for keyboard focus only (task
  79c967a8).
- n tables of n stools. Each agent is its own `Character`, seated, with a
  small nameplate above the head (status light and name, the front's style), a
  purple "•••" bubble when unread, an amber "?" bubble when asking, and the
  error pose with a red light. Figures are static (no animation): measured
  2026-10-15, 100 static figures draw at the front view's frame time, 100
  animated ones 3 to 4 times slower.
- Zoom and pan as on the front (wheel, drag, pinch, +, - and 0, and the zoom
  buttons), with the front's useViewport and a saved view of its own. The rest
  view fits the room down to the smallest readable figure size (scale 0.83)
  and crops evenly below it; zoom goes out to 0.25, so a phone can show a full
  10 × 10 room. One finger pans at any scale (no room swipe here).
- A bar: "← {room}", "Back room", "+ New agent". Figure menu: "Move to front"
  (first free desk; disabled with "Front is full").
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
3. The back screen: the sweatshop, growth, fit and pan, phone.
4. The log strip, the demo with 1 back agent, docs.
