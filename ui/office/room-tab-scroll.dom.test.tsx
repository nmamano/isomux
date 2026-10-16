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
  // A touch scrolls the bar only when it lands on the scroller or inside it.
  // The scroller reaches below the bar for the ghost stickers and takes no
  // pointer events there, so the office below stays reachable; the track
  // inside it takes them and fills the bar, so no part of the bar is dead.
  it("puts every tab and sticker in one track that takes pointer events and fills the bar", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    expect(scroller.style.pointerEvents).toBe("none");
    expect(scroller.children.length).toBe(1);
    const track = scroller.children[0] as HTMLElement;
    expect(track.style.pointerEvents).toBe("auto");
    expect(track.style.height).toBe("100%");
    expect(track.style.minWidth).toBe("100%");

    const tabs = [...container.querySelectorAll("[draggable]")];
    const stickers = [...container.querySelectorAll("[draggable] svg")];
    expect(tabs.length).toBe(3);
    expect(stickers.length).toBe(2);
    for (const el of [
      container.querySelector("[data-lobby-tab]")!,
      ...tabs,
      ...stickers,
    ])
      expect(track.contains(el)).toBe(true);
  });

  it("scrolls on a mouse wheel that lands on the track between tabs", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    const track = scroller.children[0] as HTMLElement;
    Object.defineProperty(scroller, "scrollWidth", { value: 800 });
    Object.defineProperty(scroller, "clientWidth", { value: 390 });
    const wheel = new WheelEvent("wheel", {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    track.dispatchEvent(wheel);
    expect(scroller.scrollLeft).toBe(100);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
