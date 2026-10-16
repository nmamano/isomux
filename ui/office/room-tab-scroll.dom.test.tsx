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
const { CSS } = await import("../styles.ts");

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
  // reaches below the bar to show them. Its stylesheet class lets that strip
  // pass clicks to the office everywhere but iOS (task d4f9210e), and a
  // track that fills the bar takes the bar's pointer events.
  it("leaves the scroller's pointer events to its class, and the track takes them", () => {
    const { container } = mount();
    const scroller = scrollerOf(container);
    expect(scroller.classList.contains("room-tab-scroller")).toBe(true);
    expect(scroller.style.pointerEvents).toBe("");
    const track = scroller.querySelector<HTMLElement>("[data-room-tab-track]")!;
    expect(track.parentElement).toBe(scroller);
    expect(track.style.pointerEvents).toBe("auto");
    expect(track.style.height).toBe("100%");
    for (const el of [
      container.querySelector("[data-lobby-tab]")!,
      ...container.querySelectorAll("[draggable]"),
    ])
      expect(track.contains(el)).toBe(true);
    const off: string[] = [];
    for (
      let node: HTMLElement | null = scroller.parentElement;
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

  // The class rule: no pointer events, except under the iOS-only feature
  // test, where the scroller keeps them so it still scrolls.
  it("turns the scroller's pointer events off except on iOS", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    const declared = (rules: CSSRuleList) =>
      [...rules]
        .filter(
          (r): r is CSSStyleRule =>
            r instanceof CSSStyleRule &&
            r.selectorText === ".room-tab-scroller",
        )
        .map((r) => r.style.pointerEvents);
    expect(declared(sheet.cssRules)).toEqual(["none"]);
    const ios = [...sheet.cssRules].filter(
      (r): r is CSSSupportsRule =>
        r instanceof CSSSupportsRule &&
        r.conditionText.replace(/\s/g, "") === "(-webkit-touch-callout:none)",
    );
    expect(ios.flatMap((r) => declared(r.cssRules))).toEqual(["auto"]);
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
