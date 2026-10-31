// The Inbox through the real App and store: the office bar entry counts the
// open pages and asks, opens the first tab (Asks) when an ask is open, the
// tabs switch in place, and an old path lands on its tab. The rule for the
// tab the entry opens is pinned in ui/inbox.test.ts, and the chat bar's entry
// in ui/App.inbox-chat.dom.test.tsx. An ask's link is in
// ui/App.inbox-ask-links.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx, and the tabs' own views in
// ui/components/PagerView.dom.test.tsx and AsksView.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  askCards,
  boot,
  chatFromInbox,
  inboxButton,
  page,
  pageRows,
  pushCount,
  selectedTab,
  setPages,
  setUpInboxTests,
  tab,
  tabCount,
} = await import("./test-support/inbox-fixture.tsx");

setUpInboxTests();

it("counts open pages plus open asks, and opens on Asks, the first tab, while an ask is open", async () => {
  // One page for this member, one for someone else: only the first counts.
  setPages([page("p1", "u1"), page("p2", "u2")]);
  const view = await boot();
  const button = inboxButton(view)!;
  expect(button).toBeDefined();
  // The hidden-room ask is in the store but neither counted nor listed.
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("3");
  await act(async () => fireEvent.click(button));
  // An open page does not pick the tab while an ask is open.
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  // Asks is the first tab.
  expect(
    [...view.container.querySelectorAll('[role="tab"]')].map((t) =>
      t.getAttribute("data-inbox-tab"),
    ),
  ).toEqual(["asks", "pager"]);
  expect(tabCount(view, "pager")).toBe("1");
  expect(tabCount(view, "asks")).toBe("2");
  expect(askCards(view)).toBe(2);
  expect(pageRows(view)).toBe(0);
  // The panel is labelled by the selected tab.
  const panel = view.container.querySelector('[role="tabpanel"]')!;
  expect(panel.getAttribute("aria-labelledby")).toBe(tab(view, "asks")!.id);
});

it("opens on Asks with no open page, and an agent's chat from there", async () => {
  // Someone else's page is listed on Pages but does not pick the tab.
  setPages([page("p2", "u2")]);
  const view = await boot();
  const button = inboxButton(view)!;
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("2");
  await act(async () => fireEvent.click(button));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(tabCount(view, "pager")).toBeNull();
  expect(askCards(view)).toBe(2);
  await chatFromInbox(view, "a1");
  // The page closed and the chat is open: the chat's own stack shows
  // Scout's asks, and the page's groups are gone.
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector("[data-asks-group]")).toBeNull();
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
});

it("switches tabs in place, and closes from either tab to what was under the Inbox", async () => {
  setPages([page("p2", "u2")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(selectedTab(view)).toBe("asks");
  const pushes = pushCount();
  const entries = window.history.length;
  await act(async () => fireEvent.click(tab(view, "pager")!));
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  expect(pageRows(view)).toBe(1);
  expect(askCards(view)).toBe(0);
  await act(async () => fireEvent.click(tab(view, "asks")!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(askCards(view)).toBe(2);
  await act(async () => fireEvent.click(tab(view, "pager")!));
  // A tab switch adds no history entry.
  expect(pushCount()).toBe(pushes);
  expect(window.history.length).toBe(entries);
  // The close leaves the Inbox, not the tab the member came from.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  expect(inboxButton(view)).toBeDefined();
});

// One old path: the alias table is pinned in ui/routes.test.ts and the
// canonical rewrite in ui/App.deeplink.dom.test.tsx. This proves the boot page
// reaches the Inbox as its tab.
it("lands the old /asks path on the Asks tab", async () => {
  const view = await boot("/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(window.location.pathname).toBe("/inbox/asks");
});
