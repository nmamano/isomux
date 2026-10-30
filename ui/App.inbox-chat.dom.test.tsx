// The Inbox entry in an agent's chat, through the real App and store: the
// chat bar has the same entry as the office bar, with the same badge, it opens
// the Inbox, and the close returns to that chat. The setup is in
// ui/test-support/inbox-fixture.tsx; the office bar's entry in
// ui/App.inbox.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  askCards,
  boot,
  inboxButton,
  page,
  selectedTab,
  setPages,
  setUpInboxTests,
  tab,
} = await import("./test-support/inbox-fixture.tsx");

setUpInboxTests();

// Scout's chat is open: its title and its own asks stack, and no Inbox tabs.
function expectScoutChat(view: Awaited<ReturnType<typeof boot>>) {
  expect(window.location.pathname).toBe("/");
  expect(document.title).toContain("Scout");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
}

it("opens the Inbox from an agent's chat, and the close returns to that chat", async () => {
  // One open page for this member and Scout's two open asks.
  setPages([page("p1", "u1")]);
  const view = await boot();
  // Into Scout's chat through the office bar's Inbox, the Asks tab and the
  // ask's agent name.
  await act(async () => fireEvent.click(inboxButton(view)!));
  await act(async () => fireEvent.click(tab(view, "asks")!));
  await act(async () =>
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-asks-agent="a1"]',
      )!,
    ),
  );
  expectScoutChat(view);

  // The chat bar has the Inbox entry, with the office bar's badge.
  const button = inboxButton(view);
  expect(button).toBeDefined();
  expect(button!.querySelector(".nav-action-badge")?.textContent).toBe("3");

  // It opens the Inbox on the tab the office bar opens: Asks, while an ask
  // is open.
  await act(async () => fireEvent.click(button!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(askCards(view)).toBe(2);
  expect(view.container.querySelector("[data-asks-stack]")).toBeNull();

  // The close leaves the Inbox for the chat it was opened from.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expectScoutChat(view);
  expect(inboxButton(view)).toBeDefined();
});
