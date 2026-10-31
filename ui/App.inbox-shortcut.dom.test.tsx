// The "i" shortcut through the real App and store (task d866bef9): it opens
// the Inbox on the tab the bar's Inbox button opens, from the office and from
// an agent chat, and "i" again closes it. Which flags it sets is the table in
// ui/routes.test.ts; the setup is in ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  ask,
  boot,
  chatFromInbox,
  page,
  selectedTab,
  setAsks,
  setPages,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const inboxOpen = (view: View) =>
  view.container.querySelector('[role="tablist"]') !== null;
// The full chat's own ask stack: it shows only in an agent's chat.
const fullChatOpen = (view: View) =>
  view.container.querySelector("[data-asks-stack]") !== null;

it("opens the Inbox from the office on the tab its button opens, and i again closes it", async () => {
  setAsks([]);
  const view = await boot();
  expect(inboxOpen(view)).toBe(false);
  await press("i");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  await press("i");
  expect(inboxOpen(view)).toBe(false);
  expect(window.location.pathname).toBe("/");

  // A page arrives while nothing else changes: only Pages has open items
  // now, so the next "i" opens Pages, like the button.
  await act(async () =>
    shimEmit({ type: "pager_upserted", entry: page("p1", "u1") } as never),
  );
  await press("i");
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
});

it("opens the Inbox from an agent chat on the tab that chat's button opens, and i again returns to the chat", async () => {
  // The office counts Scout's ask, so its Inbox opens on Asks. Scout's chat
  // shows that ask already, so its Inbox leaves it out and opens on Pages.
  setAsks([ask("q1", "a1")]);
  setPages([page("p1", "u1")]);
  const view = await boot();
  await press("i");
  expect(window.location.pathname).toBe("/inbox/asks");

  await chatFromInbox(view, "a1");
  expect(fullChatOpen(view)).toBe(true);
  expect(inboxOpen(view)).toBe(false);
  await press("i");
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  expect(fullChatOpen(view)).toBe(false);

  await press("i");
  expect(inboxOpen(view)).toBe(false);
  expect(fullChatOpen(view)).toBe(true);
  expect(window.location.pathname).toBe("/");
});
