// Task fe7db5ac, moved by 1e119dfb and 3d440170: the chat's Cite pill on
// touch screens. On an iPhone it sits just above the message box (the
// composer's input row) at the right, also when the asks stack is shown, where
// it covers the stack's bottom-right. Where it would meet the jump-to-bottom
// button's place it moves left of that place, kept even while the button is
// hidden so a scroll never moves the pill. A selection in an ask of the chat's
// stack puts the pill at the same spot. It does not fight the native
// selection menu, and a scroll keeps it. On Android it is off. With a mouse it
// stays next to the selection and a scroll hides it. Which device gets which
// mode is the table in cite-mode.test.ts; this file proves LogView reads the
// device and places the pill by it.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
const { en } = await import("../../shared/i18n/en.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type LogEntry = import("../../shared/types.ts").LogEntry;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

const REPLY = "the build broke on a missing import";
const logs: LogEntry[] = [
  {
    id: "u1",
    agentId: "a1",
    timestamp: 1,
    kind: "user_message",
    content: "what broke",
    metadata: { username: "Nil" },
  },
  { id: "t1", agentId: "a1", timestamp: 2, kind: "text", content: REPLY },
];

const ASK_TEXT = "Ship the fix tonight?";
const ASK: AskEntry = {
  id: "aaaa0001",
  agentId: "a1",
  memberUserId: "u1",
  prompt: ASK_TEXT,
  createdAt: 1,
  updatedAt: 1,
};

function Page({ asks }: { asks: AskEntry[] }) {
  const state = useAppState();
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries: asks, revision: 0 });
  }, [dispatch, asks]);
  return (
    <StateCtx.Provider value={state}>
      <LogView
        agent={agent}
        logs={logs}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

// happy-dom has no layout: the test owns every box, keyed by selector. The
// message box (the composer's input row) is its bottom child; the composer's
// top is the scroller's bottom. The selection sits well above the bottom
// corner, so a pill next to it and a pill above the message box have
// different positions.
type Layout = Record<string, DOMRect>;
// No asks: the input row starts just under the composer's top.
const BARE: Layout = {
  ".chat-messages": new DOMRect(0, 100, 800, 500), // bottom 600
  "[data-chat-composer]": new DOMRect(0, 600, 800, 120), // top 600
  "[data-chat-input-row]": new DOMRect(11, 610, 777, 44), // top 610, right 788
};
// The asks stack open between the composer's top and the input row: the
// pill's place above the row is far below the jump button's place.
const WITH_ASKS: Layout = {
  ".chat-messages": new DOMRect(0, 100, 800, 200), // bottom 300
  "[data-chat-composer]": new DOMRect(0, 300, 800, 420), // top 300
  "[data-asks-body]": new DOMRect(11, 330, 777, 320), // 330 to 650
  "[data-ask]": new DOMRect(11, 340, 777, 300), // in the stack's view
  "[data-chat-input-row]": new DOMRect(11, 660, 777, 44), // top 660, right 788
};
// Inside the chat's view in both layouts.
const SELECTION = new DOMRect(100, 200, 200, 20); // top 200, right 300

const bounds = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
const rects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
afterEach(() => {
  // happy-dom defines it on Element.prototype: delete the stub, or it leaks
  // into the files after this one.
  if (bounds)
    Object.defineProperty(
      HTMLElement.prototype,
      "getBoundingClientRect",
      bounds,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
});

function stubLayout(layout: Layout) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    for (const [selector, box] of Object.entries(layout))
      if (this.matches(selector)) return box;
    // Anything else holds the selection, so the hook's visibility check
    // passes.
    return new DOMRect(0, 0, 2000, 2000);
  };
  Range.prototype.getClientRects = () =>
    Object.assign([SELECTION], {
      item: () => SELECTION,
    }) as unknown as DOMRectList;
}

const pill = () =>
  document.body.querySelector<HTMLElement>(
    `button[title="${en["logView.cite.hint"]}"]`,
  );

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function textNodeOf(root: Element, text: string): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(text)) return n as Text;
  return null;
}

async function select(root: Element, text: string) {
  const node = textNodeOf(root, text);
  // The setup must reach the text, or every "no pill" below is vacuous.
  expect(node === null).toBe(false);
  const at = node!.textContent!.indexOf(text);
  await act(async () => {
    const range = document.createRange();
    range.setStart(node!, at);
    range.setEnd(node!, at + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(text);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await settle();
}

// Renders the chat as `device` in `layout`, selects the reply's text, and
// returns the view and the scroller. The caller unmounts with the returned
// cleanup.
async function selectOn(
  device: { coarse: boolean; userAgent: string; platform: string },
  { layout = BARE, asks = [] }: { layout?: Layout; asks?: AskEntry[] } = {},
) {
  const undoPointer = primaryPointer(device.coarse);
  const values = {
    userAgent: device.userAgent,
    platform: device.platform,
    maxTouchPoints: device.coarse ? 5 : 0,
  };
  const descriptors = Object.getOwnPropertyDescriptors(navigator);
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(navigator, key, { configurable: true, value });
  stubLayout(layout);
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page asks={asks} />
    </StoreProvider>,
  );
  const cleanup = () => {
    window.getSelection()?.removeAllRanges();
    view.unmount();
    for (const key of Object.keys(values)) {
      if (descriptors[key])
        Object.defineProperty(navigator, key, descriptors[key]);
      else Reflect.deleteProperty(navigator, key);
    }
    undoPointer();
  };
  try {
    const scroller =
      view.container.querySelector<HTMLElement>(".chat-messages")!;
    await settle();
    // The boxes the layout gives belong to elements that exist: the markers
    // the pill's place is read from.
    for (const selector of Object.keys(layout))
      expect(view.container.querySelectorAll(selector).length).toBe(1);
    await select(scroller, REPLY);
    return { view, scroller, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const jumpButton = () =>
  document.body.querySelector<HTMLElement>("[data-jump-to-bottom]");

// The jump button's box in `layout`, from its own style: it is placed from
// the composer's top-right corner (bottom: calc(100% + gap), right).
function jumpBox(button: HTMLElement, layout: Layout) {
  const composer = layout["[data-chat-composer]"];
  const gap = /^calc\(100% \+ (\d+(?:\.\d+)?)px\)$/.exec(button.style.bottom);
  if (!gap) throw new Error(`unexpected jump bottom: ${button.style.bottom}`);
  const size = parseFloat(button.style.height);
  const width = parseFloat(button.style.width);
  const right = composer.right - parseFloat(button.style.right);
  const bottom = composer.top - parseFloat(gap[1]);
  return { left: right - width, right, top: bottom - size, bottom };
}

function pillBox(shown: HTMLElement) {
  const top = parseFloat(shown.style.top);
  const left = parseFloat(shown.style.left);
  return {
    top,
    left,
    right: left + parseFloat(shown.style.width),
    bottom: top + parseFloat(shown.style.height),
  };
}

// Just above the message box: its bottom a small gap over the input row's
// top, so it covers neither the row nor much above it.
function expectJustAboveRow(box: ReturnType<typeof pillBox>, row: DOMRect) {
  expect(box.bottom).toBeLessThanOrEqual(row.top);
  expect(box.bottom).toBeGreaterThanOrEqual(row.top - 12);
}

// Scrolls the chat up from far below its end, so it stops following the end
// and shows the jump-to-bottom button. happy-dom has no layout: the test owns
// the scroll sizes.
async function scrollUp(scroller: HTMLElement, layout: Layout) {
  for (const [key, value] of Object.entries({
    scrollHeight: 5000,
    clientHeight: layout[".chat-messages"].height,
  }))
    Object.defineProperty(scroller, key, { configurable: true, value });
  for (const top of [3000, 2500]) {
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: top,
    });
    await act(async () => {
      fireEvent.scroll(scroller);
    });
  }
  await settle();
}

it("on an iPhone, pins the pill just above the message box at the right, left of the jump button's place, and a scroll keeps it there", async () => {
  const { scroller, cleanup } = await selectOn({
    coarse: true,
    userAgent: IPHONE,
    platform: "iPhone",
  });
  try {
    // At the end of the chat: no jump button yet.
    expect(jumpButton() === null).toBe(true);
    const shown = pill();
    expect(shown === null).toBe(false);
    const before = pillBox(shown!);
    // Not next to the selection (top 200): just above the message box.
    expectJustAboveRow(before, BARE["[data-chat-input-row]"]);

    await scrollUp(scroller, BARE);
    const jump = jumpButton();
    expect(jump === null).toBe(false);
    const after = pill();
    expect(after === null).toBe(false);
    // The scroll that brought the jump button did not move the pill.
    expect(pillBox(after!)).toEqual(before);
    const j = jumpBox(jump!, BARE);
    // The two meet up and down, so the pill keeps left of the button, close
    // to it, and right of the selection.
    expect(before.top).toBeLessThan(j.bottom);
    expect(before.right).toBeLessThanOrEqual(j.left);
    expect(before.right).toBeGreaterThan(j.left - 16);
    expect(before.left).toBeGreaterThan(SELECTION.right);
  } finally {
    cleanup();
  }
});

it("on an iPhone with the asks stack open, the pill sits just above the message box at its right edge, over the stack, and a selection in an ask puts it at the same spot", async () => {
  const { view, scroller, cleanup } = await selectOn(
    { coarse: true, userAgent: IPHONE, platform: "iPhone" },
    { layout: WITH_ASKS, asks: [ASK] },
  );
  try {
    const row = WITH_ASKS["[data-chat-input-row]"];
    const shown = pill();
    expect(shown === null).toBe(false);
    const fromChat = pillBox(shown!);
    expectJustAboveRow(fromChat, row);
    // Over the stack's bottom-right.
    expect(fromChat.top).toBeLessThan(WITH_ASKS["[data-asks-body]"].bottom);
    // Far from the jump button's place up and down: no cut, the pill's right
    // edge is near the input row's.
    expect(fromChat.right).toBeLessThanOrEqual(row.right);
    expect(fromChat.right).toBeGreaterThan(row.right - 16);
    // The jump button's place does not count while it is hidden either: a
    // scroll that shows it leaves the pill.
    await scrollUp(scroller, WITH_ASKS);
    expect(jumpButton() === null).toBe(false);
    expect(pillBox(pill()!)).toEqual(fromChat);

    // The same spot for a selection in the ask's prompt.
    const prompt = view.container.querySelector("[data-ask-prompt]");
    expect(prompt === null).toBe(false);
    await select(prompt!, ASK_TEXT);
    const pills = [
      ...document.body.querySelectorAll<HTMLElement>(
        `button[title="${en["logView.cite.hint"]}"]`,
      ),
    ];
    expect(pills.length).toBe(1);
    expect(pillBox(pills[0])).toEqual(fromChat);
  } finally {
    cleanup();
  }
});

it("on an Android phone, shows no pill", async () => {
  const { cleanup } = await selectOn({
    coarse: true,
    userAgent: ANDROID,
    platform: "Linux armv8l",
  });
  try {
    expect(pill() === null).toBe(true);
  } finally {
    cleanup();
  }
});

it("with a mouse, puts the pill next to the selection in the ask's primary-button look, and a scroll hides it", async () => {
  const { view, scroller, cleanup } = await selectOn(
    { coarse: false, userAgent: MAC, platform: "MacIntel" },
    { asks: [ASK] },
  );
  try {
    const shown = pill();
    expect(shown === null).toBe(false);
    const top = parseFloat(shown!.style.top);
    const left = parseFloat(shown!.style.left);
    const width = parseFloat(shown!.style.width);
    // Just above the selection, its right edge on the selection's end.
    expect(top).toBeLessThan(SELECTION.top);
    expect(top).toBeGreaterThan(SELECTION.top - 50);
    expect(left + width).toBe(SELECTION.right);
    // The ask's Reply button look: one Cite look in every mode.
    const replyButton = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>(
        "[data-ask] button[type=submit]",
      );
      expect(el === null).toBe(false);
      return el!;
    });
    for (const key of ["background", "color", "border"] as const)
      expect(shown!.style[key]).toBe(replyButton.style[key]);

    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(pill() === null).toBe(true);
  } finally {
    cleanup();
  }
});
