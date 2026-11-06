// The Inbox entry in an agent's chat, through the real App and store: the
// chat bar has the office bar's entry, its badge leaves out the asks of the
// agent whose chat is open (its own stack shows them), it opens the Inbox,
// and the close returns to that chat. The setup is in
// ui/test-support/inbox-fixture.tsx; the office bar's entry in
// ui/App.inbox.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  addRanger,
  ask,
  askCards,
  boot,
  chatFromInbox,
  inboxButton,
  inboxOpen,
  selectedTab,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");

setUpInboxTests();

type View = Awaited<ReturnType<typeof boot>>;

// Scout's chat is open: its title and its own asks stack, and no Inbox.
function expectScoutChat(view: View) {
  expect(window.location.pathname).toBe("/");
  expect(document.title).toContain("Scout");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  expect(inboxOpen(view)).toBe(false);
}

// Into an agent's chat through the office bar's Inbox and the ask's agent
// name.
async function openChat(view: View, agentId: string) {
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, agentId);
}

const badge = (view: View) =>
  inboxButton(view)!.querySelector(".nav-action-badge")?.textContent ?? null;

it("opens the Inbox from an agent's chat on the Asks view, and the close returns to that chat", async () => {
  const view = await boot();
  await openChat(view, "a1");
  expectScoutChat(view);

  // The chat bar has the Inbox entry. Scout's asks show in this chat's
  // stack, so nothing lights its badge.
  const button = inboxButton(view);
  expect(button).toBeDefined();
  expect(badge(view)).toBeNull();

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
});

// The chat bar's badge counts, of the other agents' asks, only those not yet
// shown on the Asks tab (task a930c9d6); the tab it opens and the tab counts
// still go by every open ask.
it("counts in a chat the new asks of the other agents, and opens Asks while another agent's ask is open", async () => {
  // No page; Scout's two asks and one from Ranger.
  addRanger();
  setAsks([ask("q1", "a1"), ask("q2", "a1"), ask("q4", "a2")]);
  const view = await boot();
  expect(badge(view)).toBe("3");

  // Into Scout's chat through the Asks tab, which showed all three: nothing
  // new, but Ranger's ask is still open, so the entry opens Asks.
  await openChat(view, "a1");
  expectScoutChat(view);
  expect(badge(view)).toBeNull();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(askCards(view)).toBe(3);

  // In Ranger's chat a new ask of Scout lights the badge; a new one of
  // Ranger shows in this chat's stack and does not.
  await chatFromInbox(view, "a2");
  expect(document.title).toContain("Ranger");
  expect(badge(view)).toBeNull();
  await act(async () =>
    shimEmit({ type: "ask_upserted", entry: ask("q5", "a1") } as never),
  );
  expect(badge(view)).toBe("1");
  await act(async () =>
    shimEmit({ type: "ask_upserted", entry: ask("q6", "a2") } as never),
  );
  expect(badge(view)).toBe("1");
});
