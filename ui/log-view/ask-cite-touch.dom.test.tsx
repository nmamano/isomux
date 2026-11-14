// Cite on an ask card on touch screens (task ad4b51ac, after fe7db5ac). On an
// iPhone the pill is pinned to the top-right of the part of the card its
// scroller shows, stays on scroll while the card shows, and a tap cites into
// the reply field without focusing it (the keyboard would move the buttons).
// On Android there is no pill. Which device gets which mode is the table in
// cite-mode.test.ts; this file proves AskCard reads the device and places the
// pill by it. The mouse behavior is ask-cite.dom.test.tsx.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
const { AskCard } = await import("./AskCard.tsx");
const { citationBlock } = await import("./cite.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const ASK: AskEntry = {
  id: "ab12cd34",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "First point here. Second point there.",
  options: ["Approve", "Reject"],
  recommended: "Approve",
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
};

const IPHONE = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
};
const ANDROID = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
};

// The pill's size and gaps (CiteSelectionButton.tsx).
const PILL_WIDTH = 64;
const PILL_GAP = 6;
const PILL_EDGE_PAD = 4;

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});
beforeEach(() => setApiShim(async () => undefined));
afterAll(() => setApiShim(null));

// happy-dom has no layout: the test owns every box. `boxes` maps a selector
// to the box of the element that matches it; anything else is a big box that
// holds the selection, so the hook's visibility check passes.
const SELECTION = new DOMRect(30, 200, 100, 20);
const SCROLLER = new DOMRect(0, 100, 600, 400); // top 100, bottom 500
const CARD = new DOMRect(20, 150, 500, 300); // top 150, right 520
let boxes: Record<string, DOMRect> = {};

const rectsDesc = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const boundsDesc = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
let undoDevice: (() => void) | null = null;

beforeEach(() => {
  boxes = { "[data-test-scroller]": SCROLLER, "[data-ask]": CARD };
  Range.prototype.getClientRects = () =>
    Object.assign([SELECTION], {
      item: () => SELECTION,
    }) as unknown as DOMRectList;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    for (const [selector, box] of Object.entries(boxes))
      if (this.matches(selector)) return box;
    return new DOMRect(0, 0, 2000, 2000);
  };
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  const putBack = (target: object, name: string, d?: PropertyDescriptor) => {
    if (d) Object.defineProperty(target, name, d);
    else Reflect.deleteProperty(target, name);
  };
  putBack(Range.prototype, "getClientRects", rectsDesc);
  putBack(HTMLElement.prototype, "getBoundingClientRect", boundsDesc);
  undoDevice?.();
  undoDevice = null;
});

// A coarse pointer and the device's navigator fields, before the mount: the
// card reads the device once.
function onDevice(device: { userAgent: string; platform: string }) {
  const undoPointer = primaryPointer(true);
  const values = { ...device, maxTouchPoints: 5 };
  const descriptors = Object.getOwnPropertyDescriptors(navigator);
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(navigator, key, { configurable: true, value });
  undoDevice = () => {
    for (const key of Object.keys(values)) {
      if (descriptors[key])
        Object.defineProperty(navigator, key, descriptors[key]);
      else Reflect.deleteProperty(navigator, key);
    }
    undoPointer();
  };
}

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "users_list",
      users: [
        {
          id: "u1",
          name: "alice",
          role: "member",
          avatarColor: "#336699",
          avatarVariant: 0,
          createdAt: 1,
        },
      ] as unknown as import("../../shared/types.ts").UserPublicWire[],
    });
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "alice",
        role: "member",
      } as import("../../shared/types.ts").SessionContext,
    });
  }, [dispatch]);
  return <>{children}</>;
}

// The card in a scroller of its own, as in the Inbox list and the asks
// stack; `scroller: false` puts it straight in the page.
async function mount({ scroller = true } = {}) {
  const cardEl = <AskCard entry={ASK} isMobile={true} />;
  const view = render(
    <StoreProvider>
      <Seed>
        {scroller ? (
          <div data-test-scroller="" style={{ overflowY: "auto" }}>
            {cardEl}
          </div>
        ) : (
          cardEl
        )}
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask-prompt]").length).toBe(1),
  );
  if (scroller) {
    // The enabling state of the scroller lookup.
    const el = view.container.querySelector<HTMLElement>(
      "[data-test-scroller]",
    )!;
    expect(getComputedStyle(el).overflowY).toBe("auto");
  }
  return view;
}

function textNodeOf(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(text)) return n as Text;
  throw new Error(`no text node holds ${text}`);
}

// The pill is portalled into <body>: the buttons outside the rendered tree.
function pills(view: ReturnType<typeof render>): HTMLButtonElement[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((b) => !view.container.contains(b));
}

// Past the hook's frame and the pill's scroll frame.
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function selectInPrompt(view: ReturnType<typeof render>, text: string) {
  const prompt = view.container.querySelector("[data-ask-prompt]")!;
  const node = textNodeOf(prompt, text);
  const at = node.textContent!.indexOf(text);
  await act(async () => {
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.toString()).toBe(text);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await settle();
}

function place(pill: HTMLElement) {
  return {
    left: parseFloat(pill.style.left),
    top: parseFloat(pill.style.top),
  };
}

// Where a pinned pill sits for a container whose right edge and top are given.
function pinnedAt(right: number, top: number) {
  return { left: right - PILL_WIDTH - PILL_EDGE_PAD, top: top + PILL_GAP };
}

async function scrollTo(view: ReturnType<typeof render>, card: DOMRect) {
  boxes["[data-ask]"] = card;
  const scroller = view.container.querySelector("[data-test-scroller]")!;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await settle();
}

it("on an iPhone, pins the pill to the card's top-right, not next to the selection", async () => {
  onDevice(IPHONE);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(CARD.right, CARD.top));
});

it("on an iPhone, a card that starts above its scroller gets the pill at the scroller's top", async () => {
  onDevice(IPHONE);
  boxes["[data-ask]"] = new DOMRect(20, 50, 500, 300); // top 50 < 100
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(CARD.right, SCROLLER.top));
});

it("on an iPhone with no scroller around the card, the window's top bounds it", async () => {
  onDevice(IPHONE);
  boxes = { "[data-ask]": new DOMRect(20, -50, 500, 300) };
  const view = await mount({ scroller: false });
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(CARD.right, 0));
});

it("on an iPhone, a scroll that moves the card moves the pill and keeps it", async () => {
  onDevice(IPHONE);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(CARD.right, CARD.top));
  const lower = new DOMRect(20, 230, 500, 300);
  await scrollTo(view, lower);
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(lower.right, lower.top));
  // The selection is still there.
  expect(window.getSelection()?.isCollapsed).toBe(false);
});

it("on an iPhone, no pill while the card is out of its scroller's view, and the pill comes back with it", async () => {
  onDevice(IPHONE);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  // Above the view: the card's bottom (90) is over the scroller's top (100).
  await scrollTo(view, new DOMRect(20, -210, 500, 300));
  expect(pills(view).length).toBe(0);
  // Back in view, with the same selection.
  await scrollTo(view, CARD);
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(pinnedAt(CARD.right, CARD.top));
  // Below the view: the card's top (510) is under the scroller's bottom (500).
  await scrollTo(view, new DOMRect(20, 510, 500, 300));
  expect(pills(view).length).toBe(0);
});

it("on an iPhone, a tap cites into the reply field and leaves it unfocused", async () => {
  onDevice(IPHONE);
  const view = await mount();
  const input = view.container.querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
  expect(input.value).toBe("Approve");
  expect(document.activeElement === input).toBe(false);
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  await act(async () => {
    fireEvent.pointerDown(pills(view)[0], { button: 0 });
  });
  await waitFor(() =>
    expect(input.value).toBe(citationBlock("First point here.")),
  );
  await settle();
  expect(document.activeElement === input).toBe(false);
  expect(pills(view).length).toBe(0);
  expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
});

it("on an Android phone, shows no pill", async () => {
  onDevice(ANDROID);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(0);
});
