// The Inbox keeps its content clear of its open chat panel (task 938698b7),
// through the real App and store: while the panel is open, the Inbox's content
// (the asks list under the header) keeps a reserve right of the panel on a
// desktop. On a phone the panel covers the Inbox and stays in the visible
// area as the keyboard opens and closes (task f2e2e953). The panel's own
// behavior is in ui/App.inbox-agent-chat.dom.test.tsx. happy-dom does no
// layout: the reserve and the box are read from the elements' styles, and
// their look is checked in a browser.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { recordRawStyles, rawStyle } =
  await import("./test-support/raw-style.ts");
recordRawStyles();
const { act, fireEvent } = await import("@testing-library/react");
const { CHAT_PANEL_WIDTH, CHAT_PANEL_RIGHT } =
  await import("./AppWidgetPage.tsx");
const {
  ask,
  boot,
  chatComposer,
  chatPanel,
  inboxButton,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// The Inbox's content: the element that holds the asks list.
function content(view: View): HTMLElement {
  const panel = view.container.querySelector<HTMLElement>(
    "[data-inbox] [data-inbox-content]",
  );
  expect(panel).not.toBeNull();
  return panel!;
}
// A plain px padding (the desktop reserve) as a number; unset is 0.
const px = (value: string) => (value === "" ? 0 : parseFloat(value));
const unset = (value: string) => value === "" || parseFloat(value) === 0;

async function openPanel(view: View, agentId: string) {
  const name = view.container.querySelector<HTMLButtonElement>(
    `[data-asks-agent="${agentId}"]`,
  );
  expect(name).not.toBeNull();
  await act(async () => fireEvent.click(name!));
  expect(chatPanel(view)).not.toBeNull();
}
async function closePanel(view: View) {
  await act(async () =>
    fireEvent.keyDown(chatComposer(view)!, { key: "Escape" }),
  );
  expect(chatPanel(view)).toBeNull();
}

it("keeps the Inbox's content clear of the open panel on a desktop and gives the room back when the panel closes", async () => {
  setAsks([ask("q1", "a1")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  // No panel: no reserve.
  expect(chatPanel(view)).toBeNull();
  expect([
    unset(content(view).style.paddingRight),
    unset(content(view).style.paddingBottom),
  ]).toEqual([true, true]);

  await openPanel(view, "a1");
  // A desktop panel, beside the content.
  expect(chatPanel(view)!.classList.contains("app-widget-panel-phone")).toBe(
    false,
  );
  const reserved = () => {
    const style = content(view).style;
    // The panel's width and its gap to the window's edge, at least.
    expect(px(style.paddingRight)).toBeGreaterThanOrEqual(
      CHAT_PANEL_WIDTH + CHAT_PANEL_RIGHT,
    );
    // The panel ends above the bottom margin; nothing is held under it.
    expect(unset(style.paddingBottom)).toBe(true);
  };
  reserved();

  await closePanel(view);
  expect([
    unset(content(view).style.paddingRight),
    unset(content(view).style.paddingBottom),
  ]).toEqual([true, true]);
  view.unmount();
});

// The phone panel's box as CSS (task f2e2e953): its top and height are px
// from the visible area, combined in CSS with the status bar's inset and,
// in the site demo, the banner's height. This evaluates such an expression
// with given values for the two: px, calc, max and min only, so a box in
// any other unit (dvh, %) fails here.
function cssPx(value: string, vars: { inset: number; banner: number }): number {
  const text = value
    .replace(/env\(\s*safe-area-inset-top\s*(,[^()]*)?\)/g, `${vars.inset}px`)
    .replace(/var\(\s*--banner-h\s*(,[^()]*)?\)/g, `${vars.banner}px`)
    .replace(/(-?\d*\.?\d+)px/g, "$1")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\bmin\(/g, "Math.min(");
  if (!/^(Math\.(max|min)|[\d\s.+\-*/(),])*$/.test(text))
    throw new Error(`not a px expression: ${value}`);
  return Number(new Function(`return (${text});`)());
}

// A phone (390 px wide) with an 800 px window and a stand-in visualViewport,
// and the demo's banner height as --banner-h when `banner` is not 0. The
// Inbox opens with a chat panel; `run` moves the viewport and checks.
async function onPhone(
  banner: number,
  run: (
    view: View,
    move: (next: {
      innerHeight: number;
      offsetTop: number;
      height: number;
    }) => Promise<void>,
  ) => Promise<void>,
) {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const height = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    offsetLeft: 0,
    height: 800,
    width: 390,
    scale: 1,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  if (banner)
    document.documentElement.style.setProperty("--banner-h", `${banner}px`);
  let view: View | undefined;
  try {
    setAsks([ask("q1", "a1")]);
    // The phone's bar has no Inbox button: the Inbox opens from its address.
    view = await boot("/inbox/asks");
    // The store reads the width again on a resize, after its 150 ms debounce.
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await openPanel(view, "a1");
    expect(chatPanel(view)!.classList.contains("app-widget-panel-phone")).toBe(
      true,
    );
    await run(view, async (next) => {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: next.innerHeight,
      });
      Object.assign(viewport, {
        offsetTop: next.offsetTop,
        height: next.height,
      });
      await act(async () => {
        viewport.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
      });
    });
  } finally {
    view?.unmount();
    document.documentElement.style.removeProperty("--banner-h");
    Reflect.deleteProperty(window, "visualViewport");
    if (width) Object.defineProperty(window, "innerWidth", width);
    if (height) Object.defineProperty(window, "innerHeight", height);
    window.dispatchEvent(new Event("resize"));
  }
}

// The panel's box in window px for a status-bar inset, checked to lie in
// the visible area [visibleTop, visibleBottom]: placed by its top (a bottom
// placement is measured from the full screen's bottom, which the iPhone
// Home Screen keyboard covers), clear of the phone's top bar (task
// d60726c7, which covers the status bar), and in the demo under the banner.
function checkBox(
  view: View,
  banner: number,
  visibleTop: number,
  visibleBottom: number,
): { top: number; height: number }[] {
  const style = chatPanel(view)!.style;
  expect(style.bottom === "" || style.bottom === "auto").toBe(true);
  const bars = view.baseElement.querySelectorAll<HTMLElement>(
    "[data-phone-top-bar]",
  );
  expect(bars.length).toBe(1);
  const barHeight = rawStyle(bars[0]).get("height") ?? "";
  return [0, 59].map((inset) => {
    const top = cssPx(style.top, { inset, banner });
    const height = cssPx(style.height, { inset, banner });
    // Top is in the office box's coordinates, which start under the banner,
    // as the bar's do.
    expect(top).toBeGreaterThanOrEqual(cssPx(barHeight, { inset, banner }));
    expect(top + banner).toBeGreaterThanOrEqual(visibleTop);
    expect(height).toBeGreaterThan(0);
    expect(top + banner + height).toBeLessThanOrEqual(visibleBottom);
    return { top: top + banner, height };
  });
}

for (const banner of [0, 40]) {
  it(`gives the open panel most of a phone's window with the keyboard closed and keeps it in the visible area with the keyboard open${banner ? ", under the demo's banner" : ""}`, async () => {
    await onPhone(banner, async (view, move) => {
      // Keyboard closed: the panel spans most of the window, not half.
      for (const box of checkBox(view, banner, banner, 800))
        expect(box.height).toBeGreaterThanOrEqual(0.8 * (800 - banner) - 59);
      // The panel covers the asks: the content keeps no reserve under it,
      // so the asks list keeps its height and its scroll.
      expect(unset(content(view).style.paddingBottom)).toBe(true);
      expect(unset(content(view).style.paddingRight)).toBe(true);

      // Safari's keyboard: the visible area shrinks, the window does not,
      // and iOS can scroll the visible area down.
      await move({ innerHeight: 800, offsetTop: 0, height: 400 });
      for (const box of checkBox(view, banner, banner, 400))
        expect(box.height).toBeGreaterThanOrEqual(0.8 * (400 - banner) - 59);
      await move({ innerHeight: 800, offsetTop: 120, height: 400 });
      checkBox(view, banner, 120, 520);

      // The Home Screen app's keyboard: the window shrinks too, and WebKit
      // reports an offsetTop the shrunk window cannot hold (e829a1b56).
      await move({ innerHeight: 420, offsetTop: 380, height: 420 });
      for (const box of checkBox(view, banner, banner, 420))
        expect(box.height).toBeGreaterThanOrEqual(0.8 * (420 - banner) - 59);
      expect(unset(content(view).style.paddingBottom)).toBe(true);

      // The keyboard closes: most of the window again.
      await move({ innerHeight: 800, offsetTop: 0, height: 800 });
      for (const box of checkBox(view, banner, banner, 800))
        expect(box.height).toBeGreaterThanOrEqual(0.8 * (800 - banner) - 59);

      await closePanel(view);
      expect(unset(content(view).style.paddingBottom)).toBe(true);
    });
  });
}
