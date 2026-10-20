// An ask's link to an agent's chat (task 9aaec0eb), through the real App and
// store: the card's button on the Inbox's Asks tab closes the Inbox, switches
// to the agent's room and opens its chat, over the back screen for a back-room
// agent. Links to office pages are covered in App.inbox.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const { activeRoom, backScreen, boot, escape, setAsks, setUpAgentLinkTests } =
  await import("./test-support/agent-link-fixture.tsx");
type AskEntry = import("../shared/types.ts").AskEntry;
type View = import("./test-support/agent-link-fixture.tsx").View;

setUpAgentLinkTests();

const ask = (id: string, agentId: string, link?: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...(link ? { link } : {}),
});

// Open the Inbox on its Asks tab and click the link on ask q1.
async function clickLink(view: View) {
  const inbox = [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  )!;
  await act(async () => fireEvent.click(inbox));
  expect(
    view.container
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-inbox-tab"),
  ).toBe("asks");
  const link = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] [data-ask-office-link]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
}

it("opens the chat of the agent an ask links to, in that agent's room, out of the Inbox", async () => {
  setAsks([ask("q1", "a1", "/agents/a2"), ask("q2", "a2")]);
  const view = await boot();
  // The office opens away from Faraway's room.
  expect(activeRoom(view)).not.toBe("r2");
  await clickLink(view);
  // The Inbox closed and Faraway's chat is open: its own stack shows its ask.
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(document.title).toContain("Faraway");
  expect(
    view.container
      .querySelector("[data-asks-stack] [data-ask]")
      ?.getAttribute("data-ask"),
  ).toBe("q2");
  // Out of the chat, the office is on Faraway's room, at the front.
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(false);
  view.unmount();
});

it("opens a back-room agent's chat over its room's back screen", async () => {
  setAsks([ask("q1", "a1", "/agents/a3")]);
  const view = await boot();
  expect(activeRoom(view)).not.toBe("r2");
  expect(backScreen(view)).toBe(false);
  await clickLink(view);
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(document.title).toContain("Backbencher");
  // Out of the chat, the back screen of Backbencher's room is open.
  await escape();
  expect(document.title).not.toContain("Backbencher");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(true);
  view.unmount();
});

it("opens a front agent's chat at the front, from a back agent's chat over the back screen", async () => {
  setAsks([ask("q1", "a1", "/agents/a3"), ask("q2", "a3", "/agents/a2")]);
  const view = await boot();
  await clickLink(view);
  expect(document.title).toContain("Backbencher");
  // Backbencher's chat, over the back screen, has its own ask's link.
  const link = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-stack] [data-ask="q2"] [data-ask-office-link]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
  expect(document.title).toContain("Faraway");
  // Out of Faraway's chat, the office is on the front of its room.
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(false);
  view.unmount();
});
