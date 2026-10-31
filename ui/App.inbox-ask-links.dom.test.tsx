// An ask's link through the real App and store: it opens its office page over
// the Inbox or the chat it was clicked on, and Back returns there; a link to
// the Pages tab switches the tab. A link to an agent's chat is in
// ui/App.ask-agent-link.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const {
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

it("switches to the Pages tab for an ask's link to it, and closes out of the Inbox", async () => {
  setAsks([ask("q1", "a1", "/inbox/pages")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(selectedTab(view)).toBe("asks");
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  expect(window.location.pathname).toBe("/inbox/pages");
  expect(selectedTab(view)).toBe("pager");
  // The tabs do not stack: the close leaves the Inbox, not the Asks tab.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(window.location.pathname).toBe("/");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
});

// A step ask (task c71cb60f): its link opens the step's tab, and the tab
// marks the setting the step is done in. The marks per kind are in
// ui/integrations/IntegrationsView.step-focus.dom.test.tsx.
it("opens a step ask's tab with the step's setting marked; a plain ask's link marks nothing", async () => {
  setAsks([
    {
      ...ask("q1", "a1", "/integrations/browser"),
      step: { kind: "browser-pairing" },
    },
    ask("q2", "a1", "/integrations/browser"),
  ]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await act(async () => fireEvent.click(officeLink(view, "q2")!));
  expect(window.location.pathname).toBe("/integrations");
  expect(view.container.querySelector("[data-step-focus]")).toBeNull();
  await go("back");
  await act(async () => fireEvent.click(officeLink(view, "q1")!));
  expect(
    view.container
      .querySelector('[data-integrations-tab][aria-current="true"]')
      ?.getAttribute("data-integrations-tab"),
  ).toBe("browser");
  await waitFor(() =>
    expect(
      [...view.container.querySelectorAll("[data-step-focus]")].map((el) =>
        el.getAttribute("data-step-focus"),
      ),
    ).toEqual(["browser-pairing"]),
  );
});
