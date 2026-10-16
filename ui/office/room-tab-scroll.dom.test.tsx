import { afterAll, beforeEach, describe, expect, it } from "bun:test";
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

describe("room tab bar scrolling (task 17537680)", () => {
  // iOS does not scroll an overflow box with pointer-events none, even when
  // its children take pointer events (WebKit bug 183870). The stickers move
  // with their tabs only as part of the scrolled content, so the scroller
  // reaches below the bar to show them and keeps its pointer events.
  it("keeps pointer events on every node from the scroller up", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
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
  });

  it("puts every sticker inside its own tab, in the scrolled content", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const tabs = [...container.querySelectorAll("[draggable]")];
    expect(tabs.length).toBe(3);
    for (const el of [container.querySelector("[data-lobby-tab]")!, ...tabs])
      expect(scroller.contains(el)).toBe(true);
    const stickers = [...container.querySelectorAll("svg")].filter((svg) =>
      svg.closest("[data-room-tab-button]"),
    );
    expect(stickers.length).toBe(2);
    for (const svg of stickers) {
      expect(scroller.contains(svg)).toBe(true);
      expect(
        svg
          .closest("[data-room-tab-button]")!
          .getAttribute("data-room-tab-button"),
      ).toBe("b");
    }
  });

  // The stickers stick out below the bar; the scroller clips its content, so
  // it reaches below the bar by the strip it keeps clear in its padding.
  it("reaches below the bar by its bottom padding", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const strip = scroller.style.paddingBottom;
    expect(parseFloat(strip)).toBeGreaterThan(0);
    expect(scroller.style.height).toBe(`calc(100% + ${strip})`);
  });

  it("selects the room on a click on its sticker", () => {
    const { container } = mount();
    const activeTab = () =>
      container
        .querySelector('[data-active-room-tab="true"] [data-room-tab-button]')
        ?.getAttribute("data-room-tab-button");
    expect(activeTab()).not.toBe("b");
    const sticker = container.querySelector('[data-room-tab-button="b"] svg')!;
    act(() => {
      sticker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(activeTab()).toBe("b");
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
