// Browser Use moved from Settings to the Integrations Browser tab (task
// f2d5cf9f). For one release the old Settings row stays and holds a pointer;
// its link opens Integrations on the Browser tab, in place of every page that
// was open, so a page stacked under Settings never shows instead.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { IntegrationsFake } =
  await import("./test-support/integrations-fake.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { createElement } = await import("react");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

function user(over: Record<string, unknown>) {
  return {
    allowedRooms: [],
    notifRooms: [],
    hidden: [],
    order: [],
    memberPrompt: null,
    language: null,
    avatarColor: "#4A90D9",
    avatarVariant: 0,
    createdAt: 0,
    ...over,
  };
}

const USERS = new Map<string, unknown>([
  ["ricky", user({ id: "u1", name: "Ricky", role: "owner" })],
  ["beth", user({ id: "u2", name: "Beth", role: "member" })],
]);

const stateFor = (username: string, userId: string, role: string) =>
  ({
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username, userId, role },
    users: USERS,
  }) as unknown as typeof initialState;

beforeEach(() => {
  new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Beth",
  ]).install();
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
});

type View = ReturnType<typeof render>;

async function app(state = stateFor("Ricky", "u1", "owner")) {
  const view = render(
    createElement(StateCtx.Provider, { value: state }, createElement(App, {})),
  );
  await act(async () => {});
  return view;
}

const integrations = (view: View) =>
  view.baseElement.querySelector("[data-integrations-page]");
const selectedTab = (view: View) =>
  view.baseElement
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute("data-integrations-tab") ?? null;

async function followPointer(view: View) {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: t("browser.title") }));
  });
  const pointer = view.baseElement.querySelector("[data-browser-moved]");
  expect(pointer).not.toBeNull();
  // The pointer replaces the pane: nothing pairs from Settings any more.
  expect(
    view.baseElement.querySelector('[data-testid="browser-settings"]'),
  ).toBeNull();
  await act(async () => {
    fireEvent.click(pointer!.querySelector("[data-browser-moved-link]")!);
  });
}

describe("the Settings pointer to the Browser tab", () => {
  for (const [who, state] of [
    ["an owner", stateFor("Ricky", "u1", "owner")],
    ["a member", stateFor("Beth", "u2", "member")],
  ] as const)
    it(`opens Integrations on the Browser tab for ${who}`, async () => {
      window.history.replaceState(null, "", "/settings");
      const view = await app(state);
      expect(integrations(view)).toBeNull();
      await followPointer(view);
      expect(integrations(view)).not.toBeNull();
      expect(window.location.pathname).toBe("/integrations");
      expect(selectedTab(view)).toBe("browser");
      expect(
        view.baseElement.querySelector('[data-testid="browser-settings"]'),
      ).not.toBeNull();
      expect(view.baseElement.querySelector("[data-browser-moved]")).toBeNull();
    });

  it("lands on Integrations, not on a page that was open under Settings", async () => {
    window.history.replaceState(null, "", "/tasks");
    const view = await app();
    const tasks = () => view.baseElement.querySelector("[data-tasks-page]");
    const settings = () =>
      view.baseElement.querySelector('[data-testid="settings-content"]');
    expect(tasks()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "s" });
    });
    // Settings is over Tasks now.
    expect(settings()).not.toBeNull();
    expect(tasks()).toBeNull();
    await followPointer(view);
    expect(settings()).toBeNull();
    expect(tasks()).toBeNull();
    expect(integrations(view)).not.toBeNull();
    expect(selectedTab(view)).toBe("browser");
    expect(window.location.pathname).toBe("/integrations");
    // Tasks is closed, not hidden: closing Integrations goes to the office.
    await act(async () => {
      fireEvent.click(view.baseElement.querySelector("[data-page-close]")!);
    });
    expect(integrations(view)).toBeNull();
    expect(tasks()).toBeNull();
  });

  it("takes the Settings entry, so Back goes to the office", async () => {
    const view = await app();
    await act(async () => {
      fireEvent.keyDown(window, { key: "s" });
    });
    expect(window.location.pathname).toBe("/settings");
    await followPointer(view);
    expect(window.location.pathname).toBe("/integrations");
    await act(async () => {
      window.history.back();
    });
    // popstate lands asynchronously; wait for the route to settle.
    const deadline = Date.now() + 2000;
    while (window.location.pathname !== "/" && Date.now() < deadline)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    expect(window.location.pathname).toBe("/");
    expect(integrations(view)).toBeNull();
    expect(
      view.baseElement.querySelector('[data-testid="settings-content"]'),
    ).toBeNull();
  });
});
