// An ask's link through the real App and store: it opens its office page over
// the Inbox or the chat it was clicked on, and Back returns there; a link to
// the old Pages tab opens the Asks view. A link to an agent's chat is in
// ui/App.ask-agent-link.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { checkedFilterValues } =
  await import("./test-support/checkbox-filters.ts");
const {
  addRanger,
  ask,
  boot,
  chatFromInbox,
  go,
  inboxButton,
  officeLink,
  selectedTab,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");

setUpInboxTests();

// The Asks tab's cards, by id.
const askIds = (view: { container: HTMLElement }) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      "[data-asks-list] [data-ask]",
    ),
  ]
    .map((el) => el.dataset.ask)
    .sort();

it("opens an ask's office page over the Asks tab, and Back returns to the Asks tab", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
  // App provides the opener, so the card draws the link.
  expect(officeLink(view, "q1")).not.toBeNull();
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  // The Integrations page, on the MCP servers tab.
  expect(window.location.pathname).toBe("/integrations");
  expect(
    view.container
      .querySelector('[data-integrations-tab][aria-current="true"]')
      ?.getAttribute("data-integrations-tab"),
  ).toBe("mcp");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();

  await go("back");
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelectorAll("[data-asks-group]").length).toBe(1);
  expect(view.container.querySelector("[data-integrations-tab]")).toBeNull();
});

it("opens an ask's office page over the chat, and Back returns to the chat", async () => {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, "a1");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  expect(officeLink(view, "q2")).not.toBeNull();
  await act(async () => fireEvent.click(officeLink(view, "q2")!));
  expect(window.location.pathname).toBe("/settings");
  expect(view.container.querySelector("[data-asks-stack]")).toBeNull();

  await go("back");
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
});

// View in Inbox (tasks bc525a93, 586ebfe1): the chat's ask stack opens the
// Asks tab filtered to that agent, with the draft the member typed in the
// chat.
it("opens the Inbox from a chat's ask stack filtered to that agent, with the stack's draft, and Back returns to the chat", async () => {
  addRanger();
  setAsks([ask("q1", "a1"), ask("q2", "a1"), ask("r1", "a2")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  // Ranger's ask shows on the Asks tab, and the tab has no View in Inbox.
  expect(askIds(view)).toEqual(["q1", "q2", "r1"]);
  expect(view.container.querySelector("[data-asks-view-inbox]")).toBeNull();

  await chatFromInbox(view, "a1");
  const inStack = (selector: string) =>
    view.container.querySelector<HTMLElement>(
      `[data-asks-stack] [data-ask="q1"] ${selector}`,
    );
  const draft = "Yes, but only after the migration";
  await act(async () =>
    fireEvent.change(inStack("[data-ask-reply-input]")!, {
      target: { value: draft },
    }),
  );
  const link = view.container.querySelector<HTMLButtonElement>(
    "[data-asks-stack] [data-asks-view-inbox]",
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelector("[data-asks-stack]")).toBeNull();
  expect(view.container.querySelector("[data-asks-pinned]")).toBeNull();
  // Scout's asks only, Ranger's hidden by the agent filter.
  expect(askIds(view)).toEqual(["q1", "q2"]);
  expect(await checkedFilterValues(view.container, "agent")).toEqual(["a1"]);
  expect(
    view.container.querySelector<HTMLTextAreaElement>(
      '[data-ask="q1"] [data-ask-reply-input]',
    )?.value,
  ).toBe(draft);

  await go("back");
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
  // The ask is still open, and the chat's card still holds the draft.
  expect(
    (inStack("[data-ask-reply-input]") as HTMLTextAreaElement | null)?.value,
  ).toBe(draft);
});

// Task 74e8fc07, slice 4: the Pages tab is gone; an ask that still links
// to it keeps its button, which opens the Asks view.
it("keeps the button of an ask's link to the old Pages tab, and it opens the Asks view", async () => {
  setAsks([ask("q1", "a1", "/inbox/pages")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(selectedTab(view)).toBe("asks");
  expect(officeLink(view, "q1")).not.toBeNull();
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
});
