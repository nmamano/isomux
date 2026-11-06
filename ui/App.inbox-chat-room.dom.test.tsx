// The Inbox keeps its content clear of its open chat panel (task 938698b7),
// through the real App and store: while the panel is open, the tab's content
// (the Asks or Pages list under the tabs) keeps a reserve on the panel's side,
// right on a desktop and bottom on a phone, where the panel takes half the
// window. The panel's own behavior is in ui/App.inbox-agent-chat.dom.test.tsx.
// happy-dom does no layout: the reserve is read from the content's style, and
// its exact size is checked in a browser.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { CHAT_PANEL_WIDTH, CHAT_PANEL_RIGHT } =
  await import("./AppWidgetPage.tsx");
const {
  ask,
  boot,
  chatComposer,
  chatPanel,
  inboxButton,
  selectedTab,
  setAsks,
  setUpInboxTests,
  tab,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// The tab's content: the element that holds the Asks or Pages list.
function content(view: View): HTMLElement {
  const panel = view.container.querySelector<HTMLElement>('[role="tabpanel"]');
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

it("keeps the Inbox's content clear of the open panel on a desktop, on both tabs, and gives the room back when the panel closes", async () => {
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

  // The panel stays open on the Pages tab, and so does the reserve.
  await act(async () => fireEvent.click(tab(view, "pager")!));
  expect(selectedTab(view)).toBe("pager");
  expect(chatPanel(view)).not.toBeNull();
  reserved();

  await closePanel(view);
  expect([
    unset(content(view).style.paddingRight),
    unset(content(view).style.paddingBottom),
  ]).toEqual([true, true]);
  view.unmount();
});

it("gives the open panel half of a phone's window and keeps the Inbox's content above it; with the keyboard up the panel fills the visible area", async () => {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const height = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const layoutHeight = 800;
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    offsetLeft: 0,
    height: layoutHeight,
    width: 390,
    scale: 1,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: layoutHeight,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
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
    const panel = chatPanel(view)!;
    // A phone panel, across the window's width.
    expect(panel.classList.contains("app-widget-panel-phone")).toBe(true);
    const box = () => {
      const h = parseFloat(panel.style.height);
      const inset = parseFloat(panel.style.bottom);
      expect([Number.isFinite(h), Number.isFinite(inset)]).toEqual([
        true,
        true,
      ]);
      return { height: h, inset };
    };
    // Half the window, near its bottom.
    const down = box();
    expect(Math.abs(down.height - layoutHeight / 2)).toBeLessThanOrEqual(1);
    expect(down.inset).toBeLessThanOrEqual(20);
    // The content holds a reserve under it, not beside it.
    const style = content(view).style;
    expect(unset(style.paddingBottom)).toBe(false);
    expect(unset(style.paddingRight)).toBe(true);

    // The keyboard opens: the panel fills the visible area, as before.
    Object.assign(viewport, { height: 400 });
    await act(async () => {
      viewport.dispatchEvent(new Event("resize"));
    });
    const up = box();
    expect(up.height).toBeGreaterThanOrEqual(0.9 * 400);
    expect(layoutHeight - up.inset).toBeLessThanOrEqual(400);

    await closePanel(view);
    expect(unset(content(view).style.paddingBottom)).toBe(true);
  } finally {
    view?.unmount();
    Reflect.deleteProperty(window, "visualViewport");
    if (width) Object.defineProperty(window, "innerWidth", width);
    if (height) Object.defineProperty(window, "innerHeight", height);
    window.dispatchEvent(new Event("resize"));
  }
});
