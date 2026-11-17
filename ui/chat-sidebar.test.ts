// The desktop chat sidebar's decisions (task c61316be): when it starts open,
// which rooms it lists and where, the order of a room's agents, and where a
// new agent sits. The DOM around them is in ui/App.chat-sidebar*.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import {
  agentAttention,
  CHAT_SIDEBAR_MIN_OPEN_WIDTH,
  CHAT_SIDEBAR_SHAPE_DEFAULT,
  CHAT_SIDEBAR_SHAPE_MAX_ITEMS,
  CHAT_SIDEBAR_SHAPE_MAX_PX,
  CHAT_SIDEBAR_SECTIONS_DEFAULT,
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  CHAT_SIDEBAR_WIDTH_MAX,
  CHAT_SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  moveRoom,
  newAgentSeat,
  parseChatSidebarPages,
  parseChatSidebarShape,
  pinnedRows,
  recentAgentsList,
  roomSummary,
  roomAgents,
  sidebarRooms,
  sidebarSectionsForAnchor,
  sidebarStartsOpen,
  type ChatSidebarSections,
  type ChatSidebarPage,
  type ChatSidebarShape,
} from "./chat-sidebar.ts";
import { BACK_SEAT_BASE, DESK_COUNT } from "../shared/desks.ts";
import {
  LOBBY_ROOM_ID,
  type AgentInfo,
  type AgentState,
  type RoomWire,
} from "../shared/types.ts";

const agent = (
  id: string,
  roomId: string,
  desk: number,
  state: AgentState = "idle",
): AgentInfo => ({ id, roomId, desk, state }) as unknown as AgentInfo;

const room = (id: string): RoomWire => ({ id, name: id }) as RoomWire;
const ids = (list: readonly { id: string }[]) => list.map((x) => x.id);

describe("sidebarStartsOpen", () => {
  it("follows the member's choice on this device at any width, and with none opens only on a wide window", () => {
    const wide = CHAT_SIDEBAR_MIN_OPEN_WIDTH;
    expect([
      sidebarStartsOpen(null, wide),
      sidebarStartsOpen(null, wide - 1),
      sidebarStartsOpen(null, 1920),
      sidebarStartsOpen("closed", 1920),
      sidebarStartsOpen("open", 800),
    ]).toEqual([true, false, true, false, true]);
    // The agreed threshold (design, 2026-11-11).
    expect(wide).toBe(1100);
  });
});

describe("sidebarRooms", () => {
  const rooms = ["r1", "r2", "r3", "r4"].map(room);
  const tucked = ["r2", "r4"];

  it("lists the shown rooms in the member's order and puts tucked rooms under More rooms", () => {
    const out = sidebarRooms({ rooms, tucked }, null);
    expect({ shown: ids(out.shown), more: ids(out.more) }).toEqual({
      shown: ["r1", "r3"],
      more: ["r2", "r4"],
    });
  });

  it("shows the open agent's room even when it is tucked, and only once", () => {
    const out = sidebarRooms({ rooms, tucked }, "r4");
    expect({ shown: ids(out.shown), more: ids(out.more) }).toEqual({
      shown: ["r1", "r3", "r4"],
      more: ["r2"],
    });
  });

  it("does not fail when the open agent's room is not in the list (a Lobby agent, or a room the member does not see)", () => {
    for (const open of [LOBBY_ROOM_ID, "gone"]) {
      const out = sidebarRooms({ rooms, tucked }, open);
      expect({ open, shown: ids(out.shown), more: ids(out.more) }).toEqual({
        open,
        shown: ["r1", "r3"],
        more: ["r2", "r4"],
      });
    }
  });
});

describe("roomAgents", () => {
  it("gives the room's front desks in desk order and its back room with the waiting and failed agents first, then desk order", () => {
    const agents = [
      agent("f3", "r1", 3),
      agent("b0", "r1", BACK_SEAT_BASE, "idle"),
      agent("f0", "r1", 0),
      agent("b1", "r1", BACK_SEAT_BASE + 1, "thinking"),
      agent("b3", "r1", BACK_SEAT_BASE + 3, "waiting_for_response"),
      agent("f1", "r1", 1),
      agent("b2", "r1", BACK_SEAT_BASE + 2, "error"),
      agent("b4", "r1", BACK_SEAT_BASE + 4, "stopped"),
      // Another room's agents are not this room's.
      agent("x0", "r2", 2),
      agent("x8", "r2", BACK_SEAT_BASE),
    ];
    const out = roomAgents(agents, "r1");
    expect({ front: ids(out.front), back: ids(out.back) }).toEqual({
      front: ["f0", "f1", "f3"],
      back: ["b2", "b3", "b0", "b1", "b4"],
    });
  });
});

describe("newAgentSeat", () => {
  it("is the room's first free front desk; back agents and other rooms do not take one", () => {
    const cases = [
      // A gap at desk 2.
      {
        agents: [agent("a", "r1", 0), agent("b", "r1", 1), agent("c", "r1", 3)],
        want: 2,
      },
      // Empty room, with only back agents and another room's desk 0.
      {
        agents: [agent("a", "r1", BACK_SEAT_BASE), agent("b", "r2", 0)],
        want: 0,
      },
      // Another room's desk 2 does not fill this room's desk 2.
      {
        agents: [agent("a", "r1", 0), agent("b", "r1", 1), agent("c", "r2", 2)],
        want: 2,
      },
    ];
    expect(cases.map((c) => newAgentSeat(c.agents, "r1"))).toEqual(
      cases.map((c) => c.want),
    );
  });

  it("is null, the back room, when every front desk is taken", () => {
    const full = Array.from({ length: DESK_COUNT }, (_, desk) =>
      agent(`d${desk}`, "r1", desk),
    );
    expect(newAgentSeat(full, "r1")).toBeNull();
    // One desk short of full: the last desk.
    expect(newAgentSeat(full.slice(0, -1), "r1")).toBe(DESK_COUNT - 1);
  });
});

// The sections a new anchor opens (task c23f23d0). The anchor is the open
// agent's room, else the room in view. Its key is stored with the sections,
// so a reload to the same anchor leaves the member's collapsed sections
// alone. The reload itself is in ui/App.chat-sidebar-reload.dom.test.tsx.
describe("sidebarSectionsForAnchor", () => {
  const left: ChatSidebarSections = {
    rooms: ["r2"],
    back: [],
    more: false,
    lobby: false,
    pinned: false,
    recent: true,
    anchor: "a1|r1|0",
  };
  const anchor = (
    key: string,
    room: string | null,
    back = false,
    tucked = false,
  ) => ({ key, room, back, tucked });

  it("before the view is restored, changes nothing and does not take the anchor", () => {
    const out = sidebarSectionsForAnchor(left, anchor("|r3|0", "r3"), false);
    expect(out).toBe(left);
    // The restored anchor, one render later, is still the stored one.
    expect(sidebarSectionsForAnchor(out, anchor("a1|r1|0", "r1"), true)).toBe(
      left,
    );
  });

  it("the stored anchor again (a reload) keeps a room the member collapsed closed", () => {
    expect(sidebarSectionsForAnchor(left, anchor("a1|r1|0", "r1"), true)).toBe(
      left,
    );
  });

  it("a new anchor opens its room, its back room for a back agent and Tucked rooms for a tucked room, and keeps the rest", () => {
    const cases = [
      {
        a: anchor("a3|r1|1", "r1", true),
        want: { ...left, rooms: ["r2", "r1"], back: ["r1"], anchor: "a3|r1|1" },
      },
      {
        a: anchor("a7|r3|0", "r3", false, true),
        want: { ...left, rooms: ["r2", "r3"], more: true, anchor: "a7|r3|0" },
      },
      // Its room already open: only the anchor is taken.
      { a: anchor("a4|r2|0", "r2"), want: { ...left, anchor: "a4|r2|0" } },
      // No room (none to show): the anchor is taken, nothing opens.
      { a: anchor("||0", null), want: { ...left, anchor: "||0" } },
    ];
    expect(cases.map((c) => sidebarSectionsForAnchor(left, c.a, true))).toEqual(
      cases.map((c) => c.want),
    );
  });

  it("on a first visit, the first anchor opens its room beside the open Lobby", () => {
    expect(
      sidebarSectionsForAnchor(
        CHAT_SIDEBAR_SECTIONS_DEFAULT,
        anchor("a1|r1|0", "r1"),
        true,
      ),
    ).toEqual({
      rooms: ["r1"],
      back: [],
      more: false,
      lobby: true,
      pinned: true,
      recent: true,
      anchor: "a1|r1|0",
    });
  });
});

// Task 5dac6b9b: the sidebar width, the folded room summary, Pinned, Recent
// and the drop order. The DOM around them is in
// ui/App.chat-sidebar-lists.dom.test.tsx.
describe("clampSidebarWidth", () => {
  it("holds the width within the range, rounded, and takes the default for a value that is not a number", () => {
    const cases: [number, number][] = [
      [CHAT_SIDEBAR_WIDTH_MIN - 50, CHAT_SIDEBAR_WIDTH_MIN],
      [CHAT_SIDEBAR_WIDTH_MAX + 1, CHAT_SIDEBAR_WIDTH_MAX],
      [300.6, 301],
      [CHAT_SIDEBAR_WIDTH_MIN, CHAT_SIDEBAR_WIDTH_MIN],
      [CHAT_SIDEBAR_WIDTH_MAX, CHAT_SIDEBAR_WIDTH_MAX],
      [Number.NaN, CHAT_SIDEBAR_WIDTH_DEFAULT],
      [Number.POSITIVE_INFINITY, CHAT_SIDEBAR_WIDTH_DEFAULT],
    ];
    expect(cases.map(([w]) => clampSidebarWidth(w))).toEqual(
      cases.map(([, want]) => want),
    );
    expect([
      CHAT_SIDEBAR_WIDTH_MIN,
      CHAT_SIDEBAR_WIDTH_DEFAULT,
      CHAT_SIDEBAR_WIDTH_MAX,
    ]).toEqual([200, 260, 440]);
  });
});

describe("agentAttention and roomSummary", () => {
  const withPrompt = (a: AgentInfo, prompt: string | undefined): AgentInfo =>
    ({ ...a, pendingPrompt: prompt }) as unknown as AgentInfo;

  it("a row counts its open asks plus one for a permission prompt, and nothing for another prompt", () => {
    const a = agent("a", "r1", 0);
    expect([
      agentAttention(a, 0),
      agentAttention(a, 2),
      agentAttention(withPrompt(a, "permission"), 0),
      agentAttention(withPrompt(a, "permission"), 2),
      agentAttention(withPrompt(a, "resume"), 1),
    ]).toEqual([0, 2, 1, 3, 1]);
  });

  it("a folded room counts its working agents (thinking or running a tool) and the sum of its row badges", () => {
    const agents = [
      agent("t", "r1", 0, "thinking"),
      agent("x", "r1", 1, "tool_executing"),
      agent("i", "r1", 2, "idle"),
      withPrompt(agent("p", "r1", 3, "waiting_for_response"), "permission"),
      agent("e", "r1", 4, "error"),
    ];
    const asks = new Map([
      ["i", 2],
      ["p", 1],
      ["gone", 5], // an agent not in this room
    ]);
    expect(roomSummary(agents, asks)).toEqual({ working: 2, attention: 4 });
    // The badge is the sum of the rows the member sees when it unfolds.
    expect(roomSummary(agents, asks).attention).toBe(
      agents.reduce((n, a) => n + agentAttention(a, asks.get(a.id) ?? 0), 0),
    );
    expect(roomSummary([], asks)).toEqual({ working: 0, attention: 0 });
  });

  it("a folded room leaves out the agents shown elsewhere (an open Pinned or Recent): neither their work nor their badges count", () => {
    const agents = [
      agent("t", "r1", 0, "thinking"),
      agent("x", "r1", 1, "tool_executing"),
      agent("i", "r1", 2, "idle"),
      withPrompt(agent("p", "r1", 3, "waiting_for_response"), "permission"),
    ];
    const asks = new Map([
      ["t", 1],
      ["i", 2],
    ]);
    // Shown elsewhere: t (works, asks) and p (a prompt). Left: x works, i asks.
    expect(roomSummary(agents, asks, new Set(["t", "p"]))).toEqual({
      working: 1,
      attention: 2,
    });
    // All shown elsewhere: nothing left. None shown: all count.
    expect(roomSummary(agents, asks, new Set(agents.map((a) => a.id)))).toEqual(
      { working: 0, attention: 0 },
    );
    expect(roomSummary(agents, asks, new Set())).toEqual({
      working: 2,
      attention: 4,
    });
  });
});

describe("pinnedRows and recentAgentsList", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) =>
    agent(id, "r1", i),
  );

  it("Pinned lists the pinned agents and live members the client has, mixed in the member's order", () => {
    const members = [
      { id: "m1", removed: false },
      { id: "m2", removed: true },
    ];
    const rows = pinnedRows(
      ["c", "gone", "member:m1", "a", "member:m2", "member:mx"],
      all,
      members,
    );
    expect(
      rows.map((r) =>
        r.kind === "agent" ? `agent ${r.agent.id}` : `member ${r.member.id}`,
      ),
    ).toEqual(["agent c", "member m1", "agent a"]);
    expect(rows.map((r) => r.key)).toEqual(["c", "member:m1", "a"]);
    expect(pinnedRows([], all, members).length).toBe(0);
  });

  it("Recent lists the newest five that are not pinned and that the client has, filling from older ones", () => {
    const recent = ["b", "gone", "a", "c", "d", "e", "f", "g", "h"];
    expect(ids(recentAgentsList(recent, ["a", "c"], all))).toEqual([
      "b",
      "d",
      "e",
      "f",
      "g",
    ]);
    // Fewer than five left: all of them, newest first.
    expect(ids(recentAgentsList(["e", "a"], ["a"], all))).toEqual(["e"]);
    expect(ids(recentAgentsList(recent, [], all, 2))).toEqual(["b", "a"]);
  });
});

describe("moveRoom", () => {
  const order = ["r1", "r2", "r3", "r4"];
  it("puts the dropped id before or after the target and keeps the rest in order", () => {
    expect([
      moveRoom(order, "r4", "r2", true),
      moveRoom(order, "r4", "r2", false),
      moveRoom(order, "r1", "r3", false),
      moveRoom(order, "r1", "r4", false),
      moveRoom(order, "r3", "r1", true),
      // A drop onto its own place.
      moveRoom(order, "r2", "r3", true),
    ]).toEqual([
      ["r1", "r4", "r2", "r3"],
      ["r1", "r2", "r4", "r3"],
      ["r2", "r3", "r1", "r4"],
      ["r2", "r3", "r4", "r1"],
      ["r3", "r1", "r2", "r4"],
      ["r1", "r2", "r3", "r4"],
    ]);
  });

  it("returns the order unchanged when an id is missing or the two are the same", () => {
    expect([
      moveRoom(order, "r9", "r2", true),
      moveRoom(order, "r2", "r9", true),
      moveRoom(order, "r2", "r2", false),
    ]).toEqual([order, order, order]);
  });
});

// The stored shape of the sidebar's lists, for their placeholders while they
// load (task 4dcad6bf; since task f66e07e3 the page rows draw at load and
// only the lists have a shape), and of its head (task 73b5c130: the office
// name, working count and Inbox badge widths). The DOM side is in
// ui/App.chat-sidebar-skeleton.dom.test.tsx and
// ui/App.chat-sidebar-head.dom.test.tsx.
describe("parseChatSidebarShape", () => {
  const head = { name: 117, working: 64, inbox: 22 };
  const lists = {
    H: 120,
    items: [
      { kind: "header" as const, top: 0, h: 26 },
      { kind: "row" as const, top: 27, h: 38 },
      { kind: "nav" as const, top: 66, h: 29 },
    ],
  };
  const block = (n: number, px = 10) => ({
    H: px,
    items: Array.from({ length: n }, () => ({ kind: "row", top: px, h: px })),
  });

  it("keeps a sane shape as it is, up to the item and px caps", () => {
    expect(
      parseChatSidebarShape(JSON.parse(JSON.stringify({ lists, head }))),
    ).toEqual({ lists, head });
    // An empty block is a shape too: a list with nothing in it; a head with
    // nothing drawn is too.
    const empty = {
      lists: { H: 0, items: [] },
      head: { name: 0, working: 0, inbox: 0 },
    };
    expect(parseChatSidebarShape(empty)).toEqual(empty);
    const atCaps = {
      lists: block(CHAT_SIDEBAR_SHAPE_MAX_ITEMS, CHAT_SIDEBAR_SHAPE_MAX_PX),
      head: {
        name: CHAT_SIDEBAR_SHAPE_MAX_PX,
        working: CHAT_SIDEBAR_SHAPE_MAX_PX,
        inbox: CHAT_SIDEBAR_SHAPE_MAX_PX,
      },
    };
    expect(parseChatSidebarShape(atCaps)).toEqual(atCaps as ChatSidebarShape);
    // The default is a sane shape.
    expect(parseChatSidebarShape(CHAT_SIDEBAR_SHAPE_DEFAULT)).toEqual(
      CHAT_SIDEBAR_SHAPE_DEFAULT,
    );
  });

  it("reads a value stored before task f66e07e3 for its lists, whatever its top block holds", () => {
    const top = {
      H: 75,
      items: [
        { kind: "nav", top: 0, h: 29 },
        { kind: "divider", top: 67, h: 1 },
      ],
    };
    const head = CHAT_SIDEBAR_SHAPE_DEFAULT.head;
    expect(parseChatSidebarShape({ top, lists })).toEqual({ lists, head });
    expect(
      parseChatSidebarShape({ top: { H: -1, items: "x" }, lists }),
    ).toEqual({ lists, head });
  });

  it("reads a value stored before task 73b5c130 (no head) with its lists and the default head", () => {
    expect(parseChatSidebarShape({ lists })).toEqual({
      lists,
      head: CHAT_SIDEBAR_SHAPE_DEFAULT.head,
    });
    // The default head has no working count and no Inbox badge: a device
    // with no stored head draws no placeholder for them.
    expect(CHAT_SIDEBAR_SHAPE_DEFAULT.head.working).toBe(0);
    expect(CHAT_SIDEBAR_SHAPE_DEFAULT.head.inbox).toBe(0);
    expect(CHAT_SIDEBAR_SHAPE_DEFAULT.head.name).toBeGreaterThan(0);
  });

  it("reads anything else as none, without throwing", () => {
    const item = lists.items[0];
    const withLists = (l: unknown) => ({ lists: l });
    const withItem = (over: Record<string, unknown>) =>
      withLists({ ...lists, items: [{ ...item, ...over }] });
    const withHead = (h: unknown) => ({ lists, head: h });
    const withHeadPart = (over: Record<string, unknown>) =>
      withHead({ ...head, ...over });
    const bad: [string, unknown][] = [
      ["null", null],
      ["a string", "shape"],
      ["an array", [lists]],
      ["no lists", { top: lists }],
      ["a block with no items", withLists({ H: 10 })],
      ["items not a list", withLists({ H: 10, items: {} })],
      ["a block with no H", withLists({ items: lists.items })],
      ["H a string", withLists({ ...lists, H: "75" })],
      ["H negative", withLists({ ...lists, H: -1 })],
      [
        "H over the cap",
        withLists({ ...lists, H: CHAT_SIDEBAR_SHAPE_MAX_PX + 1 }),
      ],
      ["H infinite", withLists({ ...lists, H: Infinity })],
      ["H NaN", withLists({ ...lists, H: NaN })],
      ["an unknown kind", withItem({ kind: "room" })],
      ["no kind", withItem({ kind: undefined })],
      ["an item with no top", withItem({ top: undefined })],
      ["top negative", withItem({ top: -5 })],
      ["top over the cap", withItem({ top: CHAT_SIDEBAR_SHAPE_MAX_PX + 1 })],
      ["h a string", withItem({ h: "29" })],
      ["h infinite", withItem({ h: Infinity })],
      ["an item that is null", withLists({ ...lists, items: [null] })],
      ["one item too many", withLists(block(CHAT_SIDEBAR_SHAPE_MAX_ITEMS + 1))],
      ["a head that is null", withHead(null)],
      ["a head that is a string", withHead("head")],
      ["a head that is a list", withHead([117, 64, 22])],
      ["a head with no name", withHeadPart({ name: undefined })],
      ["a head with no working", withHeadPart({ working: undefined })],
      ["a head with no inbox", withHeadPart({ inbox: undefined })],
      ["a head name as a string", withHeadPart({ name: "117" })],
      ["a negative working", withHeadPart({ working: -1 })],
      [
        "an inbox over the cap",
        withHeadPart({ inbox: CHAT_SIDEBAR_SHAPE_MAX_PX + 1 }),
      ],
      ["a NaN name", withHeadPart({ name: NaN })],
      ["an infinite working", withHeadPart({ working: Infinity })],
    ];
    for (const [why, raw] of bad)
      expect(parseChatSidebarShape(raw), why).toBeNull();
  });
});

// The page rows a permission pack can hide, as this device last drew them
// (task f66e07e3). The DOM side is in ui/App.chat-sidebar-skeleton.dom.test.tsx.
describe("parseChatSidebarPages", () => {
  it("keeps the known page rows, and an empty list as empty", () => {
    const all: ChatSidebarPage[] = ["apps", "tasks", "cronjobs", "skills"];
    expect([...parseChatSidebarPages(all)!].sort()).toEqual([...all].sort());
    expect(parseChatSidebarPages(["tasks"])).toEqual(["tasks"]);
    // A pack with none of the areas: no row, not "all".
    expect(parseChatSidebarPages([])).toEqual([]);
  });

  it("leaves out what is not a page row a pack can hide", () => {
    expect(
      parseChatSidebarPages([
        "tasks",
        "asks",
        "office",
        "settings",
        "integrations",
        "Tasks",
        7,
        null,
        { tasks: true },
      ]),
    ).toEqual(["tasks"]);
  });

  it("reads a value that is not a list as none (every row draws), without throwing", () => {
    for (const raw of [null, undefined, "tasks", 3, { tasks: true }, true])
      expect(parseChatSidebarPages(raw), String(raw)).toBeNull();
  });
});
