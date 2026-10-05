import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { RoomTabBar } = await import("./RoomTabBar.tsx");
const { tuckedChipSummary, presentMemberNames } =
  await import("./TuckedRoomsChip.tsx");
const { StoreProvider, FeaturesProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");

type RoomWire = import("../../shared/types.ts").RoomWire;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type PresenceInfo = import("../../shared/types.ts").PresenceInfo;
type UserRecord = import("../../shared/types.ts").UserRecord;

const room = (id: string): RoomWire => ({
  id,
  name: `Room ${id}`,
  prompt: null,
  canCloseWhenEmpty: false,
});
const noop = () => {};
const SELF = "u-self";

function self(tucked: string[]): UserRecord {
  return {
    id: SELF,
    name: "Tester",
    notifRooms: [],
    createdAt: 0,
    role: "member",
    avatarColor: "#4a90d9",
    avatarVariant: "classic",
    allowedRooms: [],
    hidden: [],
    order: [],
    tucked,
    memberPrompt: null,
    language: null,
  };
}

function presence(
  connectionId: string,
  userId: string,
  roomId: string,
): PresenceInfo {
  return {
    connectionId,
    userId,
    username: `Name ${userId}`,
    device: null,
    avatarColor: "#123456",
    avatarVariant: "classic",
    currentRoomId: roomId,
    focusedAgentId: null,
    viewMode: "office",
  };
}

function agent(id: string, roomId: string, state: AgentInfo["state"]) {
  return { id, roomId, state } as AgentInfo;
}

// Each PUT /api/me/view/tucked waits here until the test answers it.
let writes: {
  tucked: string[];
  resolve: () => void;
  reject: (e: Error) => void;
}[] = [];

beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  setApiShim(async (method, path, body) => {
    if (method === "PUT" && path === "/api/me/view/tucked") {
      return new Promise<void>((resolve, reject) =>
        writes.push({
          tucked: (body as { tucked: string[] }).tucked,
          resolve,
          reject,
        }),
      );
    }
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
});
afterAll(() => {
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});

function mount(ids: string[], tucked: string[]) {
  setShim(noop);
  const view = render(
    <StoreProvider>
      <LanguageProvider>
        <FeaturesProvider features={PRODUCTION_FEATURES}>
          <RoomTabBar />
        </FeaturesProvider>
      </LanguageProvider>
    </StoreProvider>,
  );
  act(() => {
    shimEmit({
      type: "session_context",
      context: {
        userId: SELF,
        username: "Tester",
        role: "member",
        currentSessionPrefix: "s",
        connectionId: "c-self",
      },
    });
    shimEmit({
      type: "full_state",
      agents: [],
      rooms: ids.map(room),
      office: { name: "Tab test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    });
    shimEmit({ type: "user_self_updated", user: self(tucked) });
  });
  return view;
}

// The bar's own tabs; the pinned tab of an active tucked room is not one.
const barIds = (c: HTMLElement) =>
  [...c.querySelectorAll("[draggable]:not([data-tucked-room-tab])")].map(
    (el) => el.textContent?.match(/Room ([a-z])/)?.[1] ?? "?",
  );
const chip = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-tucked-chip]");
const chipButton = (c: HTMLElement) =>
  chip(c)?.querySelector("button") as HTMLButtonElement;
const listIds = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-tucked-room]")].map((el) =>
    el.getAttribute("data-tucked-room"),
  );

describe("tucked rooms in the tab bar", () => {
  it("moves tucked rooms off the bar into the chip, which lists them on click", () => {
    const { container } = mount(["a", "b", "c"], ["b", "c"]);
    expect(barIds(container)).toEqual(["a"]);
    expect(chipButton(container).textContent).toContain("2");
    expect(listIds(container)).toEqual([]);
    act(() => {
      fireEvent.click(chipButton(container));
    });
    expect(listIds(container)).toEqual(["b", "c"]);
  });

  it("shows no chip when nothing is tucked", () => {
    const { container } = mount(["a", "b"], []);
    expect(chip(container)).toBeNull();
    expect(barIds(container)).toEqual(["a", "b"]);
  });

  it("ignores a tucked id whose room is not in the member's rooms (hidden wins)", () => {
    const { container } = mount(["a", "b"], ["x"]);
    expect(chip(container)).toBeNull();
    expect(barIds(container)).toEqual(["a", "b"]);
  });

  it("names the members present in each tucked room", () => {
    const { container } = mount(["a", "b"], ["b"]);
    act(() => {
      shimEmit({
        type: "presence_list",
        entries: [
          presence("c1", "u1", "b"),
          presence("c2", "u1", "b"),
          presence("c3", "u2", "b"),
        ],
        totalOnlineUsers: 2,
        onlineUserIds: ["u1", "u2"],
      });
    });
    act(() => {
      fireEvent.click(chipButton(container));
    });
    const row = container.querySelector('[data-tucked-room="b"]')!;
    expect(row.textContent).toContain("Name u1, Name u2");
  });

  it("tucks a tab dropped on the chip at once, and untucks on failure", async () => {
    const { container } = mount(["a", "b", "c"], ["c"]);
    const dataTransfer = { setData: noop, effectAllowed: "", dropEffect: "" };
    const tabB = [...container.querySelectorAll("[draggable]")][1];
    act(() => {
      fireEvent.dragStart(tabB, { dataTransfer });
    });
    act(() => {
      fireEvent.dragOver(chip(container)!, { dataTransfer });
    });
    act(() => {
      fireEvent.drop(chip(container)!, { dataTransfer });
    });
    expect(writes.map((w) => w.tucked)).toEqual([["c", "b"]]);
    expect(barIds(container)).toEqual(["a"]);
    await act(async () => writes[0].reject(new Error("offline")));
    expect(barIds(container)).toEqual(["a", "b"]);
  });

  it("shows the chip as a drop target during a drag even with nothing tucked", () => {
    const { container } = mount(["a", "b"], []);
    const dataTransfer = { setData: noop, effectAllowed: "", dropEffect: "" };
    act(() => {
      fireEvent.dragStart(container.querySelectorAll("[draggable]")[0], {
        dataTransfer,
      });
    });
    expect(chip(container)).not.toBeNull();
    act(() => {
      fireEvent.drop(chip(container)!, { dataTransfer });
    });
    expect(writes.map((w) => w.tucked)).toEqual([["a"]]);
  });

  it("untucks from the list at once; the server record confirms it", async () => {
    const { container } = mount(["a", "b", "c"], ["b", "c"]);
    act(() => {
      fireEvent.click(chipButton(container));
    });
    const untuck = container.querySelectorAll(
      '[data-tucked-room="b"] button',
    )[1] as HTMLButtonElement;
    act(() => {
      fireEvent.click(untuck);
    });
    expect(writes.map((w) => w.tucked)).toEqual([["c"]]);
    expect(barIds(container)).toEqual(["a", "b"]);
    act(() => {
      shimEmit({ type: "user_self_updated", user: self(["c"]) });
    });
    await act(async () => writes[0].resolve());
    expect(barIds(container)).toEqual(["a", "b"]);
    expect(chipButton(container).textContent).toContain("1");
  });

  it("drags the last untucked tab onto the chip", () => {
    const { container } = mount(["a", "b"], ["b"]);
    const dataTransfer = { setData: noop, effectAllowed: "", dropEffect: "" };
    const lone = container.querySelector(
      "[draggable]:not([data-tucked-room-tab])",
    )!;
    expect(lone.getAttribute("draggable")).toBe("true");
    act(() => {
      fireEvent.dragStart(lone, { dataTransfer });
    });
    act(() => {
      fireEvent.drop(chip(container)!, { dataTransfer });
    });
    expect(writes.map((w) => w.tucked)).toEqual([["b", "a"]]);
  });

  it("scrolls the active tab into view when a tuck pins it at the end", () => {
    const scrolled: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { container } = mount(["a", "b", "c"], []);
      scrolled.length = 0;
      // Room a is active; tuck it from the record, as another device would.
      act(() => {
        shimEmit({ type: "user_self_updated", user: self(["a"]) });
      });
      const pinned = container.querySelector("[data-tucked-room-tab]");
      expect(pinned).not.toBeNull();
      expect(scrolled.includes(pinned!)).toBe(true);
    } finally {
      if (original)
        Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("gives an active tucked room a pinned, active tab and keeps it in the list", () => {
    const { container } = mount(["a", "b"], ["b"]);
    act(() => {
      fireEvent.click(chipButton(container));
    });
    act(() => {
      fireEvent.click(
        container.querySelector(
          '[data-tucked-room="b"] button',
        ) as HTMLButtonElement,
      );
    });
    const pinned = container.querySelector("[data-tucked-room-tab]")!;
    expect(pinned.textContent).toContain("Room b");
    expect(pinned.getAttribute("data-active-room-tab")).toBe("true");
    expect(pinned.getAttribute("draggable")).toBe("false");
    expect(chipButton(container).textContent).toContain("1");
  });
});

describe("tuckedChipSummary", () => {
  const rooms = [room("b"), room("c")];
  const presences = new Map([
    ["b", [presence("c1", "u1", "b")]],
    ["c", [presence("c2", "u2", "c")]],
  ]);

  it("aggregates presence and activity over the tucked rooms", () => {
    const summary = tuckedChipSummary(
      rooms,
      null,
      [agent("x", "b", "idle"), agent("y", "c", "thinking")],
      new Set(["x"]),
      presences,
    );
    expect(summary.presences.map((p) => p.connectionId)).toEqual(["c1", "c2"]);
    expect(summary.dotColor).toBe("var(--green)");
  });

  it("shows attention when no tucked room has a working agent", () => {
    const summary = tuckedChipSummary(
      rooms,
      null,
      [agent("x", "b", "idle")],
      new Set(["x"]),
      presences,
    );
    expect(summary.dotColor).toBe("var(--purple)");
  });

  it("leaves out the active room, which has its own tab", () => {
    const summary = tuckedChipSummary(
      rooms,
      "c",
      [agent("y", "c", "thinking")],
      new Set(),
      presences,
    );
    expect(summary.presences.map((p) => p.connectionId)).toEqual(["c1"]);
    expect(summary.dotColor).toBeNull();
  });

  it("lists each present member once", () => {
    expect(
      presentMemberNames([
        presence("c1", "u1", "b"),
        presence("c2", "u1", "b"),
        presence("c3", "u2", "b"),
      ]),
    ).toEqual(["Name u1", "Name u2"]);
  });
});
