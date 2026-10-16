import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { RoomTabBar } = await import("./RoomTabBar.tsx");
const { StoreProvider, FeaturesProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");

type RoomWire = import("../../shared/types.ts").RoomWire;
type PresenceInfo = import("../../shared/types.ts").PresenceInfo;

const room = (id: string): RoomWire => ({
  id,
  name: `Room ${id}`,
  prompt: null,
  canCloseWhenEmpty: false,
});
const noop = () => {};

function presence(connectionId: string, roomId: string): PresenceInfo {
  return {
    connectionId,
    userId: `u-${connectionId}`,
    username: `Name ${connectionId}`,
    device: null,
    avatarColor: "#123456",
    avatarVariant: "classic",
    currentRoomId: roomId,
    focusedAgentId: null,
    viewMode: "office",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setApiShim(async (_method, path) => {
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

function mount() {
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
        userId: "u-self",
        username: "Tester",
        role: "member",
        currentSessionPrefix: "s",
        connectionId: "c-self",
      },
    });
    shimEmit({
      type: "full_state",
      agents: [],
      rooms: ["a", "b", "c"].map(room),
      office: { name: "Tab test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    });
    shimEmit({
      type: "presence_list",
      entries: [presence("c1", "b"), presence("c2", "b")],
      totalOnlineUsers: 3,
      onlineUserIds: ["u-c1", "u-c2", "u-self"],
    });
  });
  return view;
}

// The element that scrolls the tabs: the nearest horizontal scroller above
// the Lobby tab.
function scrollerOf(container: HTMLElement): HTMLElement {
  let el = container.querySelector<HTMLElement>("[data-lobby-tab]");
  while (el && el.style.overflowX !== "auto") el = el.parentElement;
  if (!el) throw new Error("no scroller");
  return el;
}

function stickerClusters(container: HTMLElement, roomId: string) {
  const all = [
    ...container.querySelectorAll<HTMLElement>(
      `[data-sticker-room="${roomId}"]`,
    ),
  ];
  const painted = all.filter((el) => el.closest("[aria-hidden]"));
  const hit = all.filter((el) => !el.closest("[aria-hidden]"));
  return { painted, hit };
}

// The nearest ancestor that sets pointer events, or "" if none does.
function pointerEventsOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement)
    if (node.style.pointerEvents) return node.style.pointerEvents;
  return "";
}

describe("room tab bar scrolling (task 17537680)", () => {
  // iOS does not scroll an overflow box with pointer-events none, even when
  // its children take pointer events (WebKit bug 183870). The scroller keeps
  // them and stays inside the bar; the stickers live outside it.
  it("keeps pointer events on a scroller that fills the bar and holds every tab", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    // No node from the scroller up to the mount point turns pointer events
    // off: on iOS any of them would stop the swipe.
    const off: string[] = [];
    for (
      let node: HTMLElement | null = scroller;
      node && node !== container.parentElement;
      node = node.parentElement
    )
      if (
        node.style.pointerEvents === "none" ||
        getComputedStyle(node).pointerEvents === "none"
      )
        off.push(node.outerHTML.slice(0, 80));
    expect(off).toEqual([]);
    expect(scroller.style.height).toBe("100%");
    const tabs = [...container.querySelectorAll("[draggable]")];
    expect(tabs.length).toBe(3);
    for (const el of [container.querySelector("[data-lobby-tab]")!, ...tabs])
      expect(scroller.contains(el)).toBe(true);
    expect(scroller.querySelectorAll("svg").length).toBe(0);
  });

  it("draws the stickers outside the scroller, in a layer that takes no pointer events", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const { painted } = stickerClusters(container, "b");
    expect(painted.length).toBe(1);
    expect(painted[0].querySelectorAll("svg").length).toBe(2);
    expect(scroller.contains(painted[0])).toBe(false);
    expect(pointerEventsOf(painted[0])).toBe("none");
    expect(stickerClusters(container, "a").painted.length).toBe(0);
  });

  it("selects the room on a click on the part of its sticker below the bar", () => {
    const { container } = mount();
    const { hit } = stickerClusters(container, "b");
    expect(hit.length).toBe(1);
    expect(pointerEventsOf(hit[0])).toBe("auto");
    // The hit copy's layer starts at the bottom of the bar.
    expect(hit[0].parentElement!.parentElement!.style.top).toBe("100%");
    const activeTab = () =>
      container
        .querySelector('[data-active-room-tab="true"] [data-room-tab-button]')
        ?.getAttribute("data-room-tab-button");
    expect(activeTab()).not.toBe("b");
    act(() => {
      hit[0]
        .querySelector("svg")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(activeTab()).toBe("b");
  });

  it("hangs each sticker on the bottom center of its tab pill", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const pill = container.querySelector<HTMLElement>(
      '[data-room-tab-button="b"]',
    )!;
    const rect = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      }) as DOMRect;
    scroller.getBoundingClientRect = () => rect(10, 5, 390, 31);
    Object.defineProperty(scroller, "clientHeight", { value: 31 });
    scroller.scrollLeft = 30;
    // A 24px-tall pill with a 1px border: its padding box ends 1px above the
    // bottom of its border box.
    pill.getBoundingClientRect = () => rect(110, 9, 80, 24);
    Object.defineProperty(pill, "clientTop", { value: 1 });
    Object.defineProperty(pill, "clientHeight", { value: 22 });
    // A render measures the anchors again.
    act(() => {
      shimEmit({
        type: "presence_list",
        entries: [presence("c1", "b")],
        totalOnlineUsers: 2,
        onlineUserIds: ["u-c1", "u-self"],
      });
    });
    const { painted, hit } = stickerClusters(container, "b");
    // x: 110 - 10 + 30 + 80 / 2; y: 9 - 5 + 1 + 22.
    expect(painted[0].style.left).toBe("170px");
    expect(painted[0].style.top).toBe("27px");
    expect(hit[0].style.left).toBe("170px");
    expect(hit[0].style.top).toBe(`${27 - 31}px`);
  });

  it("moves the sticker strips with the tabs on a scroll", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const { painted, hit } = stickerClusters(container, "b");
    // The first scroll also renders (the left edge hint appears); the
    // second one does not, so only the scroll listener can move the strips.
    for (const scrollLeft of [120, 200]) {
      scroller.scrollLeft = scrollLeft;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      for (const cluster of [painted[0], hit[0]])
        expect(cluster.parentElement!.style.transform).toBe(
          `translateX(${-scrollLeft}px)`,
        );
    }
  });

  // The bar renders on every app state change; each observe() queues a
  // notification and so a second measure.
  it("observes the tab boxes again only when the set of tabs changes", () => {
    const observe = spyOn(ResizeObserver.prototype, "observe");
    try {
      mount();
      observe.mockClear();
      act(() => {
        shimEmit({
          type: "presence_list",
          entries: [presence("c1", "b")],
          totalOnlineUsers: 2,
          onlineUserIds: ["u-c1", "u-self"],
        });
      });
      expect(observe).toHaveBeenCalledTimes(0);
      act(() => {
        shimEmit({
          type: "full_state",
          agents: [],
          rooms: ["a", "b", "c", "d"].map(room),
          office: { name: "Tab test", prompt: null },
          recentCwds: [],
          killedAgents: [],
          interactions: [],
        });
      });
      expect(observe.mock.calls.length).toBeGreaterThan(0);
    } finally {
      observe.mockRestore();
    }
  });

  it("scrolls on a mouse wheel that lands on a tab", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    Object.defineProperty(scroller, "scrollWidth", { value: 800 });
    Object.defineProperty(scroller, "clientWidth", { value: 390 });
    const wheel = new WheelEvent("wheel", {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    container.querySelector("[draggable]")!.dispatchEvent(wheel);
    expect(scroller.scrollLeft).toBe(100);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
