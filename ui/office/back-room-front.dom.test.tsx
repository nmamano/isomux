// The front view with a back room (task 5b503e32): back agents get no desk,
// and the trap door carries the back room's attention. The header's working
// count takes in the back room (task 0cd2807f).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, act, shimEmit } = fixture;
// A room as the server sends it: every room but the lobby has a back room,
// with no field for it (task e2fb9fa0).
const { room } = fixture;
const { deskOfBackSeat, DESK_COUNT } = await import("../../shared/desks.ts");
const { fireEvent } = fixture;
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const EN = translatorFor("en");
fixture.setupRoomDoorTests({ decorations: false });

function agent(id: string, desk: number, state: string) {
  return {
    id,
    name: id,
    desk,
    roomId: "first",
    cwd: "~",
    state,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    topic: null,
    topicGenerating: false,
    customInstructions: null,
    customInstructionsVersion: "0",
    permissionMode: "default",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  };
}

it("shows back agents only through the trap door", async () => {
  const view = mount([room("first")]);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [
        agent("Front", 0, "waiting_for_response"),
        agent("BackA", deskOfBackSeat({ table: 0, stool: 0 }), "thinking"),
        agent("BackB", deskOfBackSeat({ table: 0, stool: 1 }), "error"),
      ],
      rooms: [room("first")],
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const text = view.container.textContent ?? "";
  // A desk and nameplate only for the front agent; the back agents have none.
  expect(text).toContain("Front");
  expect(text).not.toContain("BackA");
  expect(text).not.toContain("BackB");
  // The trap door shows, its lamp red for the back room's error.
  const hatch = view.container.querySelector("[data-trap-door]");
  expect(hatch).not.toBeNull();
  expect(
    hatch
      ?.querySelector("[data-trap-door-lamp]")
      ?.getAttribute("data-trap-door-lamp"),
  ).toBe("error");
  // The two back agents, as a whole number in the label.
  expect(hatch?.getAttribute("aria-label")).toMatch(/(^|\D)2(\D|$)/);
});

// The header's counts (task 0cd2807f): on the front, working takes in the
// back room's working agents, while error and idle stay the front's; the back
// room's screen counts its own agents. No state but those three gets a count.
// The phone header shows working and error only.
const backDesk = (stool: number) => deskOfBackSeat({ table: 0, stool });
const countedAgents = [
  agent("F0", 0, "thinking"),
  agent("F1", 1, "waiting_for_response"),
  agent("F2", 2, "error"),
  agent("F3", 3, "idle"),
  agent("B0", backDesk(0), "thinking"),
  agent("B1", backDesk(1), "tool_executing"),
  agent("B2", backDesk(2), "waiting_for_response"),
  agent("B3", backDesk(3), "error"),
  agent("B4", backDesk(4), "error"),
  agent("B5", backDesk(5), "idle"),
  agent("B6", backDesk(6), "stopped"),
];
// Each count is a dot followed by "<n> <label>".
function headerCounts(container: HTMLElement) {
  return [...container.querySelectorAll("div")]
    .filter(
      (d) =>
        d.firstElementChild?.tagName === "SPAN" &&
        d.firstElementChild.textContent === "" &&
        d.children.length === 1 &&
        /^\d+ \S/.test(d.textContent ?? ""),
    )
    .map((d) => d.textContent);
}
const chip = (n: number, key: Parameters<typeof EN.t>[0]) =>
  `${n} ${EN.t(key as never)}`;
const headerCases: { screen: string; mobile: boolean; want: string[] }[] = [
  {
    screen: "front",
    mobile: false,
    want: [
      chip(3, "office.status.working"),
      chip(1, "office.status.error"),
      chip(1, "office.status.idle"),
    ],
  },
  {
    screen: "back",
    mobile: false,
    want: [
      chip(2, "office.status.working"),
      chip(2, "office.status.error"),
      chip(2, "office.status.idle"),
    ],
  },
  {
    screen: "front",
    mobile: true,
    want: [chip(3, "office.status.working"), chip(1, "office.status.errShort")],
  },
  {
    screen: "back",
    mobile: true,
    want: [chip(2, "office.status.working"), chip(2, "office.status.errShort")],
  },
];
it.each(headerCases)(
  "the $screen header counts (phone: $mobile)",
  async ({ screen, mobile, want }) => {
    fixture.setBackRoomOpen(screen === "back");
    const view = mount([room("first")]);
    await act(async () => {
      fixture.dispatch({ type: "set_mobile", isMobile: mobile });
    });
    await act(async () =>
      shimEmit({
        type: "full_state",
        agents: countedAgents,
        rooms: [room("first")],
        office: { name: "Back room test", prompt: null },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never),
    );
    // The screen under test is drawn: front desks or back figures.
    const text = view.container.textContent ?? "";
    if (screen === "front") {
      expect(text).toContain("F0");
      expect(view.container.querySelector("[data-back-figure]")).toBeNull();
    } else {
      expect(
        view.container.querySelector('[data-back-figure="B0"]'),
      ).not.toBeNull();
    }
    expect(fixture.snapshot.isMobile).toBe(mobile);
    expect(headerCounts(view.container)).toEqual(want);
  },
);

it("names the trap door in the footer drag hint", async () => {
  const view = mount([room("first")]);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [agent("Front", 0, "idle")],
      rooms: [room("first")],
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  expect(view.container.textContent).toContain("Front");
  expect(view.container.querySelector("[data-trap-door]")).not.toBeNull();
  // The other hint stays in the footer, hidden, to keep its size (task
  // f158d7f9).
  expect(EN.t("office.hints.dragDesk")).not.toBe(
    EN.t("office.hints.dragDeskTrapDoor"),
  );
  const dragHint = () => view.container.querySelectorAll("[data-drag-hint]");
  expect(dragHint().length).toBe(1);
  expect(dragHint()[0]?.textContent).toBe(
    EN.t("office.hints.dragDeskTrapDoor"),
  );
  const reserve = [...(dragHint()[0]?.parentElement?.children ?? [])];
  expect(reserve).toHaveLength(2);
  expect(
    reserve.filter((e) => e.getAttribute("aria-hidden") === "true"),
  ).toHaveLength(1);
});

// A full front is not a full room: the back room still has seats, so a door
// takes the drop into a next room whose front is full.
it("a door moves an agent into a next room with a full front", async () => {
  const moves: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/move")) moves.push(body);
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
  const rooms = [room("first"), room("second")];
  const full = Array.from({ length: DESK_COUNT }, (_, d) => ({
    ...agent(`S${d}`, d, "idle"),
    roomId: "second",
  }));
  const view = mount(rooms);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [agent("Mover", 0, "idle"), ...full],
      rooms,
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const drop = async () =>
    act(async () => {
      fireEvent.drop(
        view.container.querySelector('[data-door-drop="right"]')!,
        {
          dataTransfer: { getData: () => "0" },
        },
      );
    });
  await drop();
  expect(moves).toEqual([{ targetRoomId: "second" }]);
});

// The ladder is the trap door's mirror (task c18ef3e8): a back figure dropped
// on it goes to the first free front desk, and a full front refuses the drop
// at once, before any request.
it("a back figure dropped on the ladder moves to the first free front desk, unless the front is full", async () => {
  const moves: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/move")) moves.push(body);
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
  fixture.setBackRoomOpen(true);
  const back = agent("Back", deskOfBackSeat({ table: 0, stool: 0 }), "idle");
  const emit = (front: number[]) =>
    act(async () =>
      shimEmit({
        type: "full_state",
        agents: [back, ...front.map((d) => agent(`F${d}`, d, "idle"))],
        rooms: [room("first")],
        office: { name: "Back room test", prompt: null },
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never),
    );
  const view = mount([room("first")]);
  // Desks 0 and 2 are taken: desk 1 is the first free one.
  await emit([0, 2]);
  // Drags the figure over the ladder and drops it there; returns the state
  // the ladder showed during the drag.
  const dropOnLadder = async () => {
    await act(async () => {
      fireEvent.dragStart(
        view.container.querySelector('[data-back-figure="Back"]')!,
        { dataTransfer: { setData: () => {} } },
      );
    });
    const ladder = view.container.querySelector("[data-back-ladder]")!;
    await act(async () => {
      fireEvent.dragOver(ladder, { dataTransfer: { dropEffect: "" } });
    });
    const shown = view.container
      .querySelector("[data-back-ladder-target]")
      ?.getAttribute("data-back-ladder-target");
    await act(async () => {
      fireEvent.drop(ladder, { dataTransfer: { getData: () => "Back" } });
    });
    return shown;
  };
  expect(await dropOnLadder()).toBe("open");
  expect(moves).toEqual([{ targetRoomId: "first", desk: 1 }]);
  // Every front desk taken: the ladder shows it refuses, and takes no drop.
  await emit(Array.from({ length: DESK_COUNT }, (_, d) => d));
  expect(await dropOnLadder()).toBe("full");
  expect(moves).toEqual([{ targetRoomId: "first", desk: 1 }]);
});

// A back figure dragged from the back screen reaches the room tabs (task
// 335384f8): the drag lights them, a drop on another room's tab moves the
// agent there, and the figure's dragend puts them out.
it("a back figure dragged onto another room's tab moves there", async () => {
  const moves: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path.endsWith("/move")) moves.push({ path, body });
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
  fixture.setBackRoomOpen(true);
  const rooms = [room("first"), room("second")];
  const view = mount(rooms);
  await act(async () =>
    shimEmit({
      type: "full_state",
      agents: [
        agent("Back", deskOfBackSeat({ table: 0, stool: 0 }), "idle"),
        { ...agent("S0", 0, "idle"), roomId: "second" },
      ],
      rooms,
      office: { name: "Back room test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never),
  );
  const figure = () =>
    view.container.querySelector('[data-back-figure="Back"]')!;
  const tabTarget = (key: string) =>
    view.container.querySelector(`[data-desk-drop="${key}"]`);
  expect(tabTarget("second:front")).toBeNull();
  await act(async () => {
    fireEvent.dragStart(figure(), { dataTransfer: { setData: () => {} } });
  });
  expect(tabTarget("second:front")).not.toBeNull();
  await act(async () => {
    fireEvent.dragEnd(figure());
  });
  expect(tabTarget("second:front")).toBeNull();
  await act(async () => {
    fireEvent.dragStart(figure(), { dataTransfer: { setData: () => {} } });
  });
  await act(async () => {
    fireEvent.drop(tabTarget("second:front")!);
  });
  expect(moves).toEqual([
    {
      path: "/api/agents/Back/move",
      body: { targetRoomId: "second", desk: 1 },
    },
  ]);
});
