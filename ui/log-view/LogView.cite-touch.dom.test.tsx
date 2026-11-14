// Task fe7db5ac, moved by 1e119dfb: the chat's Cite pill on touch screens.
// On an iPhone it sits at the bottom-right of the chat, just above the
// message box, on the row of the jump-to-bottom button and left of that
// button's place, so the pill does not move when the button comes or goes.
// It does not fight the native selection menu, and a scroll keeps it. On
// Android it is off. With a mouse it stays next to the selection and a scroll
// hides it. Which device gets which mode is the table in cite-mode.test.ts;
// this file proves LogView reads the device and places the pill by it.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
const { en } = await import("../../shared/i18n/en.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
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

function Page() {
  const state = useAppState();
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

// happy-dom has no layout: the test owns the scroller's box and the
// selection's box. The selection sits well above the bottom corner, so a pill
// next to it and a pill in the corner have different positions. The message
// box starts where the scroller ends.
const SCROLLER = new DOMRect(0, 100, 800, 500); // top 100, bottom 600, right 800
const SELECTION = new DOMRect(100, 400, 200, 20); // top 400, right 300

const pill = () =>
  document.body.querySelector<HTMLElement>(
    `button[title="${en["logView.cite.hint"]}"]`,
  );

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

// Renders the chat as `device`, selects the reply's text, and returns the
// scroller. The caller unmounts with the returned cleanup.
async function selectOn(device: {
  coarse: boolean;
  userAgent: string;
  platform: string;
}) {
  const undoPointer = primaryPointer(device.coarse);
  const values = {
    userAgent: device.userAgent,
    platform: device.platform,
    maxTouchPoints: device.coarse ? 5 : 0,
  };
  const descriptors = Object.getOwnPropertyDescriptors(navigator);
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(navigator, key, { configurable: true, value });
  const rects = Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getClientRects",
  );
  Range.prototype.getClientRects = () =>
    Object.assign([SELECTION], {
      item: () => SELECTION,
    }) as unknown as DOMRectList;
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page />
    </StoreProvider>,
  );
  const cleanup = () => {
    window.getSelection()?.removeAllRanges();
    view.unmount();
    if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
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
    scroller.getBoundingClientRect = () => SCROLLER;
    await settle();
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (n.textContent?.includes(REPLY)) text = n as Text;
    // The setup must reach the reply, or every "no pill" below is vacuous.
    expect(text === null).toBe(false);
    await act(async () => {
      const range = document.createRange();
      range.setStart(text!, 0);
      range.setEnd(text!, REPLY.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toBe(REPLY);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await settle();
    return { scroller, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

const jumpButton = () =>
  document.body.querySelector<HTMLElement>("[data-jump-to-bottom]");

// The jump button's box, from its own style: it is placed from the message
// box's top-right corner (bottom: calc(100% + gap), right), and the message
// box starts at the scroller's bottom.
function jumpBox(button: HTMLElement) {
  const gap = /^calc\(100% \+ (\d+(?:\.\d+)?)px\)$/.exec(button.style.bottom);
  if (!gap) throw new Error(`unexpected jump bottom: ${button.style.bottom}`);
  const size = parseFloat(button.style.height);
  const width = parseFloat(button.style.width);
  const right = SCROLLER.right - parseFloat(button.style.right);
  const bottom = SCROLLER.bottom - parseFloat(gap[1]);
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

// Scrolls the chat up from far below its end, so it stops following the end
// and shows the jump-to-bottom button. happy-dom has no layout: the test owns
// the scroll sizes.
async function scrollUp(scroller: HTMLElement) {
  for (const [key, value] of Object.entries({
    scrollHeight: 5000,
    clientHeight: SCROLLER.height,
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

it("on an iPhone, pins the pill above the message box at the right, beside the jump button's place, and a scroll keeps it there", async () => {
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
    // Near the bottom of the chat, above the message box: not next to the
    // selection (top 400).
    expect(before.bottom).toBeLessThanOrEqual(SCROLLER.bottom);
    expect(before.top).toBeGreaterThan(SCROLLER.bottom - 80);

    await scrollUp(scroller);
    const jump = jumpButton();
    expect(jump === null).toBe(false);
    const after = pill();
    expect(after === null).toBe(false);
    // The scroll that brought the jump button did not move the pill.
    expect(pillBox(after!)).toEqual(before);
    const j = jumpBox(jump!);
    // On the jump button's row: the two centres line up.
    expect(
      Math.abs((before.top + before.bottom) / 2 - (j.top + j.bottom) / 2),
    ).toBeLessThanOrEqual(1);
    // Just left of the jump button, never under it; right of the selection.
    expect(before.right).toBeLessThanOrEqual(j.left);
    expect(before.right).toBeGreaterThan(j.left - 16);
    expect(before.left).toBeGreaterThan(SELECTION.right);
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

it("with a mouse, puts the pill next to the selection, and a scroll hides it", async () => {
  const { scroller, cleanup } = await selectOn({
    coarse: false,
    userAgent: MAC,
    platform: "MacIntel",
  });
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

    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(pill() === null).toBe(true);
  } finally {
    cleanup();
  }
});
