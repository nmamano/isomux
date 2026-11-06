// The "i" shortcut through the real App and store (task d866bef9): it opens
// the Inbox's Asks view from the office and from an agent chat, and "i" again
// closes it. Which flags it sets is the table in ui/routes.test.ts; the setup
// is in ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  ask,
  boot,
  chatFromInbox,
  inboxOpen,
  selectedTab,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

// The full chat's own ask stack: it shows only in an agent's chat.
const fullChatOpen = (view: View) =>
  view.container.querySelector("[data-asks-stack]") !== null;

it("opens the Inbox from the office on the Asks view, and i again closes it", async () => {
  setAsks([]);
  const view = await boot();
  expect(inboxOpen(view)).toBe(false);
  await press("i");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  await press("i");
  expect(inboxOpen(view)).toBe(false);
  expect(window.location.pathname).toBe("/");
});

it("opens the Inbox from an agent chat on the Asks view, and i again returns to the chat", async () => {
  setAsks([ask("q1", "a1")]);
  const view = await boot();
  await press("i");
  expect(window.location.pathname).toBe("/inbox/asks");

  await chatFromInbox(view, "a1");
  expect(fullChatOpen(view)).toBe(true);
  expect(inboxOpen(view)).toBe(false);
  await press("i");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(fullChatOpen(view)).toBe(false);

  await press("i");
  expect(inboxOpen(view)).toBe(false);
  expect(fullChatOpen(view)).toBe(true);
  expect(window.location.pathname).toBe("/");
});
