// The browser tab title and the installed app's icon badge carry the count of
// the member's open Inbox items, as messaging apps do (task 91a69e4c): the
// same number as the Inbox entry's title, and none once all are answered.
// The title format itself is in ui/inbox.test.ts.

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { boot, inboxButton, inboxTitleCount, setUpInboxTests } =
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

async function answerOnInbox(view: View, id: string) {
  await act(async () => fireEvent.click(inboxButton(view)!));
  await act(async () =>
    fireEvent.click(
      view.container
        .querySelector(`[data-ask="${id}"]`)!
        .querySelector<HTMLButtonElement>('button[type="submit"]')!,
    ),
  );
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  await act(async () => {});
}

it("shows the open Inbox count in the tab title and on the app icon, and drops it as the asks are answered", async () => {
  const badge = fakeBadge();
  const view = await boot();
  // Scout's two asks; the hidden-room ask counts nowhere.
  expect(inboxTitleCount(view)).toBe(2);
  expect(titleCount()).toBe(2);
  expect(document.title).toContain("Test Office");
  expect(badge.shown).toBe(2);

  await answerOnInbox(view, "q1");
  expect(inboxTitleCount(view)).toBe(1);
  expect(titleCount()).toBe(1);
  expect(badge.shown).toBe(1);

  await answerOnInbox(view, "q2");
  expect(inboxTitleCount(view)).toBeNull();
  expect(titleCount()).toBeNull();
  expect(document.title.startsWith("(")).toBe(false);
  expect(document.title).toContain("Test Office");
  expect(badge.shown).toBeNull();
});
