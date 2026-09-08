# Lobby presence and movement

Implementation: lane `lobby-ghosts`, 2026-09-08, task 365c5d69.

The server assigns each lobby connection a stable named spot id. The geometry
stays in `ui/office/lobby/layouts.ts`; `LOBBY_SPOT_IDS` in `shared/types.ts`
is the server vocabulary. `LobbyGhosts.test.ts` pins the two lists together.
The additive `PresenceInfo.lobbySpotId` is null for overflow and absent outside
the lobby. Older clients can ignore it. Older servers leave newer clients
without a seat assignment, so those ghosts use the overflow line.

`presence_update` reports `currentRoomId: "lobby"` on the lobby tab and while
viewing the receptionist. The sanitizer and per-viewer projection handle this
lobby room explicitly. A change to ordinary room grants preserves lobby
presence. Receptionist focus does not change the seat.

`assignLobbySpot` is pure and accepts a random source. Each entry selects a
random free spot without moving other ghosts. Repeated presence updates and
receptionist focus retain the seat. Leaving clears the seat; re-entry makes
a new random selection and can select the same seat again. There is no lobby
movement timer or dwell deadline.

A browser sends `{ type: "lobby_move", spotId }` for a free-seat click.
The server gets the mover from the authenticated socket, accepts the first
request for a free spot, and refuses taken or unknown spots without a change.
A connection outside the lobby cannot move a lobby ghost. The browser does
not move optimistically. Taken spots have no seat button; clicking a ghost
still opens user settings. Free-seat buttons stay 44×44 and clickable at
rest; their ring appears only on pointer hover or keyboard focus.

The lobby shows self and other connections with the same style, per the PM's
ruling. Ordinary rooms keep hiding self. Bodies and tags retain their connection
keys and DOM nodes when their seat changes, with the existing 220 ms slide.
Overflow ghosts have distinct positions beyond the SE wall. The lineup uses
the ordinary room constants and wraps upward at four columns with fixed
spacing. A named 110 px right margin keeps the lineup clear of zoom controls. Overflow
beyond the second row stacks on that last row. Overflow has no name chips;
the body retains its native name tooltip and user-settings click. Positions
depend on each connection’s line index, never the total viewer count. Overflow viewers stay in the overflow block until they click a free seat or
leave and re-enter. The server does not promote them automatically or reserve
empty seats for them. The visual lineup sorts by connection id. With all ten
spots occupied, new entries stay in overflow.


## Verification

Scoped tests follow the presence mechanism: pure assignment and map changes,
real WebSocket presence and click dispatch, room projection and authority,
HTTP route contract neighbors, lobby geometry and DOM wiring, and catalog
completeness. There is no existing ClientCommand pin in
`shared/contract-shapes.ts` or `server/test-support/routes-table.test.ts`:
those surfaces declare and pin HTTP contracts. The new DOM test checks the
exact typed command emitted by `send`.

Browser evidence (2026-09-08): two isolated Chrome contexts against the real
test server with temporary state. Both viewers see Avery and Blair; clicking
a free seat in Avery's browser changes Avery's position in Blair's browser.
The screenshot is `/home/nil/nil/lobby-ghosts-two.png`. The browser URL must
use the server's configured localhost origin, which differs from the harness's
127.0.0.1 fetch base. No production server was restarted.

No pre-lane test assertion is removed or replaced. New tests include a
negative unknown-room claim, taken and unknown-seat requests, an off-lobby
move, entry stability, full occupancy, overflow click movement, and ordinary
room self hiding.

## Review mutants

Run each mutation alone, then restore it. These lines name the property and
its failure oracle; the reviewer runs them on the review commit.

- C1 projection: change `if (p.currentRoomId !== LOBBY_ROOM_ID) {` in
  `buildPresenceListFor` to `if (true) {`. The `hasBoth` waiter in the
  `shows lobby occupants across viewers` socket test fails: no lobby entries.
- C2 sanitizer: replace `cmd.currentRoomId === LOBBY_ROOM_ID ||` with `false ||`.
  The same socket test's `hasBoth` waiter fails; ordinary-room tests still pass.
- C3 movement notification: delete `|| existing.lobbySpotId !== state.lobbySpotId`
  from `setPresence`'s return expression (including its preceding OR).
  The spot-only change assertion in `setPresence accepts entry randomness and
  returns true for a spot-only change` fails.
- C4 access clamp: delete `next.currentRoomId !== LOBBY_ROOM_ID &&`.
  `expect(getPresence("a")!.currentRoomId).toBe(LOBBY_ROOM_ID)` fails after
  the grant refresh (the preceding changed=false assertion also fails).
- Click ownership: replace `p.connectionId === connectionId` in
  `pickLobbySpot` with `true`. `expect(next[1]).toBe(before[1])` fails in
  `a click changes only the caller`.
- Taken seat: replace `presences.some((p) => p.lobbySpotId === spotId)` in
  `pickLobbySpot` with `false`. The refusal equality in that same pure test
  fails; the socket test also observes an unexpected presence broadcast.
- UI command: remove `onMoveGhost` from the LobbyScene call in OfficeView.
  The free-seat query in `reports lobby presence` is null and the test fails.
- UI seat: force `spot` in `lobbyGhostPlacements` to `undefined`.
  `expect(rows[0].left).toBeCloseTo(255.5)` fails; the DOM authoritative-seat
  test's changed-left assertion fails too.

## Copy and documentation surfaces

New UI label, including accessible name and native tooltip:

| English | Spanish | Catalan |
| --- | --- | --- |
| Move here | Moverse aquí | Mou-te aquí |

`internal-docs/documentation.md` lists the public copy surfaces. The PM ruled
that `docs/features.md` stays unchanged because this is ghost behavior, and
approved this addition in `api/chat.ts` only:

> In the lobby, everyone sees their own ghost too. Each visitor gets a random free spot; click a free spot to move there.

No new HTTP route, deployment setting, slash command, storage format, headline
feature, or public website API was added. Other indexed doc surfaces keep
their contracts. The lobby hand-off and integration audit are historical;
this document records the follow-up implementation.

A ghost spot must have no prop between it and the viewer, because ghosts
draw after all props rather than in painter’s order. The nilo spots satisfy
that constraint; the reviewed fish-tank screenshot confirms its back seat.

## Round 2 review coverage

- Entry tests use fixed random values to select both available seats while
  leaving existing and overflow rows unchanged. The presence-map test leaves
  and re-enters with fixed random values to prove a new selection.
- A socket test spies on interval registration after boot and connection:
  lobby entry starts no interval and retains receptionist focus.
- `setPresence` returns true when only `lobbySpotId` changes, and false on an
  exact repeat.
- The presence-map case now enters 18 connections. The geometry test checks
  18 and 40 viewers for scene bounds, including an upward wrap for the fifth
  overflow connection and stacking past the second row. A separate case
  checks that later arrivals do not move the existing 18 viewers.
- Ordinary-room self hiding is covered by the actual `useGhostTransitions`
  hook. Delete `&& p.connectionId !== ownConnectionId` from its filter:
  `expect(result.current.placements.map((p) => p.presence.connectionId)).toEqual(["peer"])`
  fails with an added self entry. The lobby-self case still passes.
- Entry mutant: replace the random free-seat index with zero. The assignment
  set equality in `assigns a random free entry seat without moving existing
  or overflow rows` fails.
- Overflow mutant: replace `(overflow % columns)` with `overflow` in
  `LobbyGhosts`. `expect(p.left + 40).toBeLessThanOrEqual(950)` fails in
  `wraps 18 viewers within the scene`.

The demo uses one simulated presence in its first ordinary room. It supplies
no lobby-self row, so no seat buttons appear there. `handleCommand` ignores
unhandled socket commands; `demoApi`'s HTTP route errors do not apply to this
socket command. This lane's browser checks use the real server.

Review the lane from base `e4ba0d73`, not a two-dot diff from a newer main.
The PM must rebase before merge to preserve later copy rulings. This lane
never edits the hosted address strings.

The round 2 Chrome check (2026-09-08) uses actual pointer hover and keyboard
Tab input. It measures zero painted seat borders at rest, one on hover, zero
after moving away, and one with keyboard focus. The target measures 44×44.
Evidence: `~/nil/lobby-ghosts-rest.png`, `lobby-ghosts-hover.png`, and
`lobby-ghosts-focus.png`. `lobby-ghosts-overflow.png` shows 18 viewers with the
wrapped row above the original line. DOM tests retain the click-without-hover
case; pseudo-class appearance is tested only in Chrome.


## Round 3 labels

The PM ruled that saved seat coordinates stay unchanged. Named-seat tags
stagger when their natural anchors are less than 144 scene pixels apart
horizontally and less than 32 pixels apart vertically. These thresholds cover
the 140 px chip width and adjacent seat rows. The pure function visits saved
layout order, giving each nearby occupied seat a tag level at least 24 px
above earlier neighbors. It reads only the occupied seat set, not arrival
order, connection ordering, or total viewer count. The body positions stay
at the saved coordinates. Tests reverse occupancy order and retain the same
tag positions, then check that a paired seat retains its solo body position.

The overflow geometry reserves the right-side zoom-control margin and omits
name chips. The DOM test checks that the body title remains while its chip is
absent. Chrome checks the body's accessible description through CDP because
native title popups do not appear in headless screenshots.


Round 3 Chrome evidence (2026-09-08): adjacent sofa tags are separated by 24
pixels, with bodies at the original seats. The 18-viewer screenshot has eight
overflow bodies, no overflow chips, and a clear gap before the zoom buttons.
CDP `Accessibility.getPartialAXTree` on the hovered overflow body returned
`{"ignored":false,"role":"generic","name":"","description":"Guest 16"}`.
The description equality passed. Evidence: `~/nil/lobby-ghosts-adjacent.png`
and `~/nil/lobby-ghosts-overflow.png`.

Assertion changes within this lane: the new `wraps 18 viewers within the
scene and keeps larger overflow lines within its bounds` test now expects a
maximum of 18 distinct positions (ten seats plus two four-body rows), down
from 22 with six columns. Its right bound is strengthened from 950 to 840,
and its wrap assertion checks row 14 rather than row 16. These reflect the
new zoom-control margin; no pre-lane assertion changed.

D3 mutant: iterate occupied ids rather than the saved `spots` order in
`lobbyTagTops` (resolve each id back to its spot). The reversed-occupancy
`expect(lobbyTagTops(spots, new Set([b, a]))).toEqual(first)` assertion fails.
D1 mutant: remove the `p.tagTop !== undefined` filter before GhostTag rendering.
The `keeps overflow body identification` DOM case finds two title nodes
instead of one. D2 mutant: set `LOBBY_OVERFLOW_RIGHT_MARGIN` to zero. The
literal `expect(p.left + 40).toBeLessThanOrEqual(840)` bound fails.

The accepted overflow clamp provides eight distinct overflow positions: four
columns and two rows. Above 18 simultaneous lobby connections (ten named
seats plus eight overflow positions), additional overflow bodies superimpose
on the second row. This is intended; the server still tracks each connection.
A chain of nearby occupied seats raises a tag 24 px per link. A future layout
with a larger seat cluster can therefore place a tag more than one level
above its natural anchor.

## Entry-only movement follow-up (2026-09-08)

Task `9607f41b`, lane `ghost-no-shuffle`, removes automatic movement per Nil.
Removed tests:

- `moves due ghosts in sequence into distinct free spots, leaving other deadlines alone`
- `keeps a full lobby stable, promotes overflow first, and uses the supplied random source`

Replaced tests:

- `assigns an entry with injected randomness without moving or dropping waiting rows`
  now checks all free entry seats without an automatic-promotion reservation.
- `broadcasts a due timer move and preserves receptionist focus in the lobby`
  now checks no interval starts on entry and retains the focus assertion.

The full-occupancy presence test retains ten unique seats and overflow checks;
its promotion assertion now requires a click. The grant-change test retains
its movement notification assertion through a click.
