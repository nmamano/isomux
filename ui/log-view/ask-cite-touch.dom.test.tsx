// Cite on an ask card on touch screens (task ad4b51ac, after fe7db5ac, moved
// by 1e119dfb). On an iPhone, a card with no chat composer around it (the
// Inbox) pins the pill just above the card's reply field at the right, inside
// the part of the card its scroller shows; a card in a chat's asks stack
// takes the chat's spot instead (LogView.cite-touch.dom.test.tsx). The pill
// stays on scroll while the card shows, and a tap cites into the agent's chat
// draft and asks its composer for focus, as "Discuss in chat" does on a phone
// (task d9a347a6).
// On Android there is no pill. Which device gets which mode is the table in
// cite-mode.test.ts; this file proves AskCard reads the device and places the
// pill by it. The mouse behavior is ask-cite.dom.test.tsx.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
const { AskCard } = await import("./AskCard.tsx");
const { citationBlock } = await import("./cite.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = import("../store.tsx").AppState;

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
const PILL_HEIGHT = 26;
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
// The reply field near the card's bottom, above the Reply row.
const FIELD_TOP = 230; // from the card's top
function fieldOf(card: DOMRect) {
  return new DOMRect(card.left + 10, card.top + FIELD_TOP, card.width - 20, 36);
}
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
  boxes = { "[data-test-scroller]": SCROLLER };
  setCard(CARD);
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

// The store as of the last commit.
const latest: { state: AppState | null } = { state: null };
function Probe() {
  const state = useAppState();
  useEffect(() => {
    latest.state = state;
  });
  return null;
}
afterEach(() => {
  latest.state = null;
});

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
        <Probe />
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

// The card and its reply field, which moves with it.
function setCard(card: DOMRect) {
  boxes["[data-ask]"] = card;
  boxes["[data-ask-reply-input]"] = fieldOf(card);
}

// Where a pinned pill sits for a container whose right edge and bottom are
// given: its right edge in from the container's, its bottom a gap above.
function pinnedAbove(right: number, bottom: number) {
  return {
    left: right - PILL_WIDTH - PILL_EDGE_PAD,
    top: bottom - PILL_GAP - PILL_HEIGHT,
  };
}

async function scrollTo(view: ReturnType<typeof render>, card: DOMRect) {
  setCard(card);
  const scroller = view.container.querySelector("[data-test-scroller]")!;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await settle();
}

it("on an iPhone, pins the pill just above the reply field at the right, not next to the selection", async () => {
  onDevice(IPHONE);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(CARD.right, fieldOf(CARD).top),
  );
});

it("on an iPhone, a reply field below the scroller's view puts the pill at the bottom of the card's visible part", async () => {
  onDevice(IPHONE);
  const card = new DOMRect(20, 300, 500, 300); // field top 530 > bottom 500
  setCard(card);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(card.right, SCROLLER.bottom),
  );
});

it("on an iPhone with no scroller around the card, the window's bottom bounds it", async () => {
  onDevice(IPHONE);
  // The field starts 30px under the window's bottom.
  const card = new DOMRect(20, window.innerHeight - FIELD_TOP + 30, 500, 300);
  boxes = {};
  setCard(card);
  const view = await mount({ scroller: false });
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(card.right, window.innerHeight),
  );
});

it("on an iPhone, a reply field scrolled above the view keeps the pill inside the card's visible part", async () => {
  onDevice(IPHONE);
  // Field top 60 is over the scroller's top (100); the card's bottom row
  // (100 to 130) is still in view.
  const card = new DOMRect(20, -170, 500, 300);
  setCard(card);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  const { left, top } = place(pills(view)[0]);
  expect(left).toBe(card.right - PILL_WIDTH - PILL_EDGE_PAD);
  expect(top).toBeGreaterThanOrEqual(SCROLLER.top);
  expect(top + PILL_HEIGHT).toBeLessThanOrEqual(card.bottom);
});

it("on an iPhone, a scroll that moves the card moves the pill and keeps it", async () => {
  onDevice(IPHONE);
  const view = await mount();
  await selectInPrompt(view, "First point here.");
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(CARD.right, fieldOf(CARD).top),
  );
  const lower = new DOMRect(20, 200, 500, 300); // field top 430, in view
  await scrollTo(view, lower);
  expect(pills(view).length).toBe(1);
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(lower.right, fieldOf(lower).top),
  );
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
  expect(place(pills(view)[0])).toEqual(
    pinnedAbove(CARD.right, fieldOf(CARD).top),
  );
  // Below the view: the card's top (510) is under the scroller's bottom (500).
  await scrollTo(view, new DOMRect(20, 510, 500, 300));
  expect(pills(view).length).toBe(0);
});

it("on an iPhone, a tap cites into the agent's chat draft and asks for the composer's focus, leaving the reply field", async () => {
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
  const block = citationBlock("First point here.");
  await waitFor(() =>
    expect(latest.state?.drafts.get(ASK.agentId)).toBe(block),
  );
  expect(latest.state?.pendingComposerFocus.get(ASK.agentId)).toBe(
    block.length,
  );
  await settle();
  expect(latest.state?.askDrafts.has(ASK.id)).toBe(false);
  expect(input.value).toBe("Approve");
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
