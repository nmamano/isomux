// A member with the Task board, App store, Inbox, Automations or Settings open
// stands by that page's item on the wall of the room scene (tasks 35bdee4d,
// b781545f). The open page wins over the chat under it, and a ghost at a wall
// spot is not dimmed.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { renderHook } = await import("@testing-library/react");
const {
  useGhostTransitions,
  GHOST_WALL_SPOTS,
  GHOST_WALL_STACK_LEFT,
  GHOST_LOBBY_BASE_X,
  GHOST_LOBBY_BASE_Y,
  GHOST_LOBBY_GAP,
} = await import("./useGhostTransitions.ts");
const { DESK_SLOTS } = await import("../../shared/desks.ts");
const { SCENE_W, mobileSceneScale } = await import("./grid.ts");
const { PRESENCE_PAGES } = await import("../../shared/presence-pages.ts");

type PresenceInfo = import("../../shared/types.ts").PresenceInfo;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type GhostPlacement = import("./useGhostTransitions.ts").GhostPlacement;

const ROOM = "r1";

function ghost(
  connectionId: string,
  over: Partial<PresenceInfo> = {},
): PresenceInfo {
  return {
    connectionId,
    userId: connectionId,
    username: connectionId,
    device: null,
    avatarColor: "#7c9cf5",
    avatarVariant: "classic",
    currentRoomId: ROOM,
    focusedAgentId: null,
    viewMode: "office",
    ...over,
  };
}

// The hook reads only an agent's id and desk.
const agentAt = (desk: number) =>
  ({ id: `a${desk}`, desk, roomId: ROOM }) as AgentInfo;

function place(
  presences: PresenceInfo[],
  agents: AgentInfo[],
): Map<string, GhostPlacement> {
  const { result } = renderHook(() =>
    useGhostTransitions(
      presences,
      agents,
      ROOM,
      [{ id: ROOM }],
      "self",
      { left: 0, top: 0 },
      { left: 900, top: 0 },
    ),
  );
  return new Map(
    result.current.placements.map((p) => [p.presence.connectionId, p]),
  );
}

it("puts each open page's ghost at its wall spot, undimmed, over the chat under the page", () => {
  const placed = place(
    // Each page open over a chat with the agent at desk 0: the page wins.
    PRESENCE_PAGES.map((page) =>
      ghost(page, { viewMode: "away", focusedAgentId: "a0", page }),
    ),
    [agentAt(0)],
  );
  for (const page of PRESENCE_PAGES) {
    const p = placed.get(page)!;
    expect({ page, left: p.left, top: p.top, dimmed: p.dimmed }).toEqual({
      page,
      ...GHOST_WALL_SPOTS[page],
      dimmed: false,
    });
  }
});

it("an away ghost with no page stays dimmed at the desk or the lobby line, as from an older server", () => {
  const placed = place(
    [
      // Field absent: an older server.
      ghost("desk", { viewMode: "away", focusedAgentId: "a0" }),
      ghost("lobby", { viewMode: "away", page: null }),
      ghost("chat", { viewMode: "log", focusedAgentId: "a0" }),
    ],
    [agentAt(0)],
  );
  const desk = placed.get("desk")!;
  const chat = placed.get("chat")!;
  const lobby = placed.get("lobby")!;
  // "desk" and "chat" share desk 0's spot (stacked); neither is at a wall.
  expect(Math.abs(desk.left - chat.left)).toBeLessThan(GHOST_LOBBY_GAP);
  expect([lobby.left, lobby.top]).toEqual([
    GHOST_LOBBY_BASE_X,
    GHOST_LOBBY_BASE_Y,
  ]);
  expect([desk.dimmed, lobby.dimmed, chat.dimmed]).toEqual([true, true, false]);
  const wall = Object.values(GHOST_WALL_SPOTS);
  for (const p of [desk, lobby])
    expect(wall).not.toContainEqual({ left: p.left, top: p.top });
});

it("ghosts at a wall spot stack the way ghosts at one desk do", () => {
  const placed = place(
    [
      ghost("d1", { viewMode: "log", focusedAgentId: "a0" }),
      ghost("d2", { viewMode: "log", focusedAgentId: "a0" }),
      ghost("w1", { viewMode: "away", page: "tasks" }),
      ghost("w2", { viewMode: "away", page: "tasks", focusedAgentId: "a0" }),
    ],
    [agentAt(0)],
  );
  const step = (a: string, b: string) => {
    const pa = placed.get(a)!;
    const pb = placed.get(b)!;
    return [pb.left - pa.left, pb.top - pa.top];
  };
  expect(GHOST_WALL_STACK_LEFT.has("tasks")).toBe(false);
  expect(step("d1", "d2")).not.toEqual([0, 0]);
  expect(step("w1", "w2")).toEqual(step("d1", "d2"));
  expect([placed.get("w1")!.left, placed.get("w1")!.top]).toEqual([
    GHOST_WALL_SPOTS.tasks.left,
    GHOST_WALL_SPOTS.tasks.top,
  ]);
});

// Task 7d9d6655: stacked ghosts covered the Inbox tray, which is right of the
// spot, and their bodies and name tags took the taps meant for it. Task
// 25af4431: they stack away from the tray with the same step as everywhere.
it("Inbox ghosts stack leftward, away from the tray, with the desk stack step mirrored", () => {
  const spot = GHOST_WALL_SPOTS.inbox;
  const desk = [
    ...place(
      [
        ghost("d1", { viewMode: "log", focusedAgentId: "a0" }),
        ghost("d2", { viewMode: "log", focusedAgentId: "a0" }),
      ],
      [agentAt(0)],
    ).values(),
  ];
  const [dx, dy] = [desk[1]!.left - desk[0]!.left, desk[1]!.top - desk[0]!.top];
  expect(dx).toBeGreaterThan(0);
  for (const count of [2, 3, 7]) {
    const placed = place(
      Array.from({ length: count }, (_, i) =>
        ghost(`i${i}`, { viewMode: "away", page: "inbox" }),
      ),
      [],
    );
    for (let i = 0; i < count; i++) {
      const p = placed.get(`i${i}`)!;
      expect([p.left, p.top]).toEqual([spot.left - i * dx, spot.top + i * dy]);
    }
  }
});

it("the wall spots keep a ghost's width from each other, from every desk spot and from the lobby line", () => {
  // OfficeView draws a ghost 40 px wide (GHOST_SIZE).
  const GHOST_W = 40;
  // Each desk's ghost spot, read through the hook: one ghost per desk.
  const agents = DESK_SLOTS.map((_, desk) => agentAt(desk));
  const deskSpots = [
    ...place(
      agents.map((a) =>
        ghost(`at-${a.desk}`, { viewMode: "log", focusedAgentId: a.id }),
      ),
      agents,
    ).values(),
  ].map((p) => ({ left: p.left, top: p.top }));
  expect(deskSpots).toHaveLength(DESK_SLOTS.length);
  const lobbySpots = [0, 1, 2, 3, 4].map((i) => ({
    left: GHOST_LOBBY_BASE_X + i * GHOST_LOBBY_GAP,
    top: GHOST_LOBBY_BASE_Y,
  }));
  const apart = (
    a: { left: number; top: number },
    b: { left: number; top: number },
  ) => Math.hypot(a.left - b.left, a.top - b.top) >= GHOST_W;
  const spotsOf = (page: (typeof PRESENCE_PAGES)[number]) => [
    GHOST_WALL_SPOTS[page],
  ];
  const near: string[] = [];
  for (const page of PRESENCE_PAGES) {
    for (const spot of spotsOf(page)) {
      for (const other of PRESENCE_PAGES)
        if (other !== page && !spotsOf(other).every((o) => apart(spot, o)))
          near.push(`${page}~${other}`);
      deskSpots.forEach((d, i) => {
        if (!apart(spot, d)) near.push(`${page}~desk${i}`);
      });
      lobbySpots.forEach((l, i) => {
        if (!apart(spot, l)) near.push(`${page}~lobby${i}`);
      });
    }
  }
  expect(near).toEqual([]);
});

it("every wall spot is inside the part of the scene a phone shows", () => {
  // A phone fits less than the scene's width to the screen and crops both
  // wall ends equally (mobileSceneScale). A ghost is 40 px wide (GHOST_SIZE).
  const GHOST_W = 40;
  const shown = Math.min(screen.width, window.innerWidth) / mobileSceneScale();
  const crop = (SCENE_W - shown) / 2;
  expect(crop).toBeGreaterThan(0);
  const outside = PRESENCE_PAGES.filter((page) => {
    const { left } = GHOST_WALL_SPOTS[page];
    return left < crop || left + GHOST_W > SCENE_W - crop;
  });
  expect(outside).toEqual([]);
});
