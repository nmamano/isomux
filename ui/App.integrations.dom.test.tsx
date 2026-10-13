// The Integrations page in App (task 911c9bbb): its door in the office bar,
// its own path, its row in Settings that replaced the two connections panes,
// and the member profile's one-shot link (Lead, ruling 2). The way back from
// an MCP sign-in is in ui/App.integrations-sign-in.dom.test.tsx (the 5 s
// budget is per file).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
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

const OWNER = {
  ...initialState,
  hasReceivedInitialState: true,
  sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
  users: USERS,
} as unknown as typeof initialState;

let pushState: ReturnType<typeof spyOn<History, "pushState">>;
beforeEach(() => {
  new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Beth",
  ]).install();
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
  pushState = spyOn(window.history, "pushState");
});
afterEach(() => pushState.mockRestore());

async function app() {
  const view = render(
    createElement(StateCtx.Provider, { value: OWNER }, createElement(App, {})),
  );
  await act(async () => {});
  return view;
}

const page = (view: ReturnType<typeof render>) =>
  view.baseElement.querySelector("[data-integrations-page]");
const member = (view: ReturnType<typeof render>) =>
  view.baseElement
    .querySelector('[data-integrations-card="personal"]')
    ?.getAttribute("data-integrations-member") ?? null;

async function clickTitle(view: ReturnType<typeof render>, title: string) {
  await act(async () => {
    view.getByTitle(title).click();
  });
}

describe("the Integrations page in the office", () => {
  it("opens from the office bar at its own path, in one pushed entry, and closes back to the office", async () => {
    const view = await app();
    await clickTitle(view, t("common.integrations"));
    expect(page(view)).not.toBeNull();
    expect(window.location.pathname).toBe("/integrations");
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0]).toEqual([
      { isomux: true, page: "integrations" },
      "",
      "/integrations",
    ]);
    await act(async () => {
      view.getByRole("button", { name: t("settings.backToOffice") }).click();
    });
    expect(page(view)).toBeNull();
  });

  it("opens at /integrations on a cold load", async () => {
    window.history.replaceState(null, "", "/integrations");
    const view = await app();
    expect(page(view)).not.toBeNull();
    expect(member(view)).toBeNull();
  });

  it("replaces the two connections rows in Settings with one row that opens the page", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = await app();
    expect(
      view.queryByRole("button", { name: /Office-wide connections/ }),
    ).toBeNull();
    expect(
      view.queryByRole("button", { name: /Individual connections/ }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("common.integrations") }),
      );
    });
    expect(page(view)).not.toBeNull();
    expect(window.location.pathname).toBe("/integrations");
    expect(member(view)).toBeNull();
  });

  it("opens on the member from their profile once; the next open is on You", async () => {
    window.history.replaceState(null, "", "/settings");
    const view = await app();
    const row = view
      .getAllByRole("button")
      .find((el) => (el.textContent ?? "").startsWith("Beth"));
    await act(async () => {
      fireEvent.click(row!);
    });
    const link = view.baseElement.querySelector(
      "[data-member-integrations-link]",
    )!;
    expect(link.textContent).toContain("Beth");
    await act(async () => {
      fireEvent.click(link.querySelector("button")!);
    });
    expect(page(view)).not.toBeNull();
    expect(member(view)).toBe("Beth");

    await act(async () => {
      view.getByRole("button", { name: t("settings.backToOffice") }).click();
    });
    await clickTitle(view, t("common.integrations"));
    expect(page(view)).not.toBeNull();
    expect(member(view)).toBeNull();
  });
});
