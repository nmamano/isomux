// The browser tab title and the installed app's icon badge carry the count
// the Inbox entry's red badge shows, as messaging apps do (task 91a69e4c):
// the open asks this browser has not shown on the Asks tab (task 598298ba,
// Nil at sign-off: the red count, not the total). An ask that is open but
// seen counts in neither. The title format itself is in ui/inbox.test.ts.

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { ask, boot, inboxButton, inboxOpen, inboxTitleCount, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// The Badging API on the window's navigator: the count the icon shows, null
// for none.
const nav = navigator as unknown as Record<string, unknown>;
function fakeBadge() {
  const state = { shown: null as number | null };
  Object.defineProperty(navigator, "setAppBadge", {
    configurable: true,
    value: async (n: number) => {
      state.shown = n === 0 ? null : n;
    },
  });
  Object.defineProperty(navigator, "clearAppBadge", {
    configurable: true,
    value: async () => {
      state.shown = null;
    },
  });
  return state;
}
afterEach(() => {
  delete nav.setAppBadge;
  delete nav.clearAppBadge;
});

// The "(N) " in front of the title; null without one.
const titleCount = () => {
  const m = /^\((\d+)\) /.exec(document.title);
  return m ? Number(m[1]) : null;
};
// The Inbox entry's red badge; null without one.
const barBadge = (view: View): number | null => {
  const text =
    inboxButton(view)?.querySelector(".nav-action-badge")?.textContent;
  return text ? Number(text) : null;
};
// Title, icon and red badge show one number at every step.
function expectAll(view: View, badge: { shown: number | null }, n: number) {
  expect(barBadge(view)).toBe(n === 0 ? null : n);
  expect(titleCount()).toBe(n === 0 ? null : n);
  expect(badge.shown).toBe(n === 0 ? null : n);
  expect(document.title).toContain("Test Office");
}

it("shows the Inbox's unseen count in the tab title and on the app icon, not the open count", async () => {
  const badge = fakeBadge();
  const view = await boot();
  // Scout's two asks, both unseen; the hidden-room ask counts nowhere.
  expect(inboxTitleCount(view)).toBe(2);
  expectAll(view, badge, 2);

  // The Asks tab shows both: seen in this browser, still open.
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(inboxOpen(view)).toBe(true);
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  await act(async () => {});
  expect(inboxOpen(view)).toBe(false);
  expect(inboxTitleCount(view)).toBe(2);
  expectAll(view, badge, 0);

  // A new ask is unseen and counts; once answered elsewhere, it does not.
  await act(async () =>
    shimEmit({ type: "ask_upserted", entry: ask("q9", "a1") } as never),
  );
  expect(inboxTitleCount(view)).toBe(3);
  expectAll(view, badge, 1);

  await act(async () => shimEmit({ type: "ask_removed", id: "q9" } as never));
  expect(inboxTitleCount(view)).toBe(2);
  expectAll(view, badge, 0);
});
