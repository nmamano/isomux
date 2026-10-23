// The Integrations page on a cold load: a pasted tab URL, and the way back
// from an MCP sign-in, at the new path
// (/integrations?mcpSignIn=<code>) and at the old one an in-flight sign-in
// still uses (/settings?mcpSignIn=<code>; Lead, ruling 1). The result shows on
// the server's row, in the card it belongs to (b1035).

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

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { rememberSignIn } = await import("./integrations/sign-in-return.ts");
const { IntegrationsFake, server } =
  await import("./test-support/integrations-fake.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { getIntegrationsTab, setIntegrationsTab } =
  await import("./device-settings.ts");
const { INTEGRATIONS_TABS } = await import("../shared/office-links.ts");
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
let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Beth",
  ]).install();
  const signedIn = { oauth: { clientId: null, signedIn: true } };
  fake.scope("office").servers.push(server("linear", signedIn));
  fake.scope("Ricky").servers.push(server("notes", signedIn));
  fake.scope("Beth").servers.push(server("linear", signedIn));
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

type View = ReturnType<typeof render>;
const page = (view: View) =>
  view.baseElement.querySelector("[data-integrations-page]");
const member = (view: View) =>
  view.baseElement
    .querySelector('[data-integrations-card="personal"]')
    ?.getAttribute("data-integrations-member") ?? null;
const notices = (view: View) => [
  ...view.baseElement.querySelectorAll("[data-mcp-sign-in-notice]"),
];
// The notice's place: the card and the row it sits in, or "top".
const placeOf = (notice: Element) => ({
  card:
    notice
      .closest("[data-integrations-card]")
      ?.getAttribute("data-integrations-card") ?? "top",
  row:
    notice
      .closest("[data-mcp-server-name]")
      ?.getAttribute("data-mcp-server-name") ?? null,
  kind: notice.getAttribute("data-mcp-sign-in-notice"),
  text: notice.textContent,
});
const only = (view: View) => {
  const all = notices(view);
  expect(all).toHaveLength(1);
  return placeOf(all[0]);
};

describe("back from an MCP sign-in", () => {
  // A tab path names a tab too (task df206fe3): the sign-in result wins.
  // The old /settings return is pageForLocation's (ui/routes.test.ts); App
  // takes the page from it the same way.
  for (const path of ["/integrations", "/integrations/variables"])
    it(`lands on the MCP servers tab from ${path}, on the member's row`, async () => {
      // No saved spot: the restore would open the page whatever the path says.
      localStorage.clear();
      rememberSignIn({
        server: "linear",
        target: { kind: "member", username: "Beth" },
      });
      window.history.replaceState(null, "", `${path}?mcpSignIn=ok`);
      const view = await app();
      expect(page(view)).not.toBeNull();
      expect(window.location.pathname).toBe("/integrations");
      expect(window.location.search).toBe("");
      expect(
        view.baseElement
          .querySelector('[data-integrations-tab="mcp"]')!
          .getAttribute("aria-selected"),
      ).toBe("true");
      // The card shows whose server it was; the row, which one.
      expect(member(view)).toBe("Beth");
      expect(only(view)).toEqual({
        card: "personal",
        row: "linear",
        kind: "ok",
        text: t("integrations.mcp.signedIn"),
      });
      // Read once: the note is gone.
      expect(sessionStorage.length).toBe(0);
    });

  it("puts an office sign-in on the office row, and your own on yours", async () => {
    rememberSignIn({ server: "linear", target: { kind: "office" } });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const office = await app();
    expect(only(office)).toMatchObject({ card: "office", row: "linear" });
    expect(member(office)).toBeNull();
    office.unmount();

    rememberSignIn({
      server: "notes",
      target: { kind: "self", username: "Ricky" },
    });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const own = await app();
    expect(only(own)).toMatchObject({ card: "personal", row: "notes" });
    expect(member(own)).toBeNull();
  });

  it("explains a failed sign-in by its code at the top without a note", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=denied");
    const view = await app();
    expect(only(view)).toEqual({
      card: "top",
      row: null,
      kind: "error",
      text: t("settings.mcpServers.signInError.denied"),
    });
  });

  it("puts a failed sign-in on its row, as a success", async () => {
    rememberSignIn({
      server: "linear",
      target: { kind: "member", username: "Beth" },
    });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=denied");
    const view = await app();
    expect(member(view)).toBe("Beth");
    expect(only(view)).toEqual({
      card: "personal",
      row: "linear",
      kind: "error",
      text: t("settings.mcpServers.signInError.denied"),
    });
  });

  it("puts the result under the card's list when its row is gone", async () => {
    rememberSignIn({ server: "gone", target: { kind: "office" } });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const view = await app();
    expect(only(view)).toMatchObject({ card: "office", row: null });
  });

  it("names no server with no note, and a later sign-in replaces an abandoned one", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const generic = await app();
    expect(only(generic)).toMatchObject({
      card: "top",
      text: t("settings.mcpServers.signInDone"),
    });
    generic.unmount();

    // A start for Beth that never came back, then your own.
    rememberSignIn({
      server: "linear",
      target: { kind: "member", username: "Beth" },
    });
    rememberSignIn({
      server: "notes",
      target: { kind: "self", username: "Ricky" },
    });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const view = await app();
    expect(member(view)).toBeNull();
    expect(only(view)).toMatchObject({ card: "personal", row: "notes" });
  });

  it("clears the row notice on the next action on its card only", async () => {
    rememberSignIn({ server: "linear", target: { kind: "office" } });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const view = await app();
    const card = (kind: string) =>
      view.baseElement.querySelector(`[data-integrations-card="${kind}"]`)!;
    // An action on the other card leaves it.
    await act(async () => {
      (
        card("personal").querySelector("[data-mcp-edit]") as HTMLElement
      ).click();
    });
    expect(notices(view)).toHaveLength(1);
    // A click on its card that is not an action leaves it too.
    await act(async () => {
      (
        card("office").querySelector("[data-card-title]") as HTMLElement
      ).click();
    });
    expect(notices(view)).toHaveLength(1);
    await act(async () => {
      (card("office").querySelector("[data-mcp-edit]") as HTMLElement).click();
    });
    expect(notices(view)).toHaveLength(0);
  });

  it("shows the notice once: the next open has none", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const view = await app();
    expect(notices(view)).toHaveLength(1);
    await act(async () => {
      view.getByRole("button", { name: t("common.back") }).click();
    });
    await act(async () => {
      view.getByTitle(t("nav.integrationsShortcut")).click();
    });
    await act(async () => {
      (
        view.baseElement.querySelector(
          '[data-integrations-tab="mcp"]',
        ) as HTMLElement
      ).click();
    });
    expect(page(view)).not.toBeNull();
    expect(notices(view)).toHaveLength(0);
  });
});

describe("a pasted tab URL", () => {
  it("opens a pasted tab URL on that tab, not the saved one, and shows /integrations", async () => {
    // No saved spot: an earlier case leaves the page saved, and the restore
    // would open it whatever the path says.
    localStorage.clear();
    setIntegrationsTab("mcp");
    window.history.replaceState(null, "", "/integrations/variables");
    const view = await app();
    expect(page(view)).not.toBeNull();
    const selected = [
      ...view.baseElement.querySelectorAll(
        '[data-integrations-tab][aria-selected="true"]',
      ),
    ].map((el) => el.getAttribute("data-integrations-tab"));
    expect(selected).toEqual(["variables"]);
    expect(window.location.pathname).toBe("/integrations");
    expect(pushState).not.toHaveBeenCalled();
    // The tab counts as picked, so a reload of /integrations opens it again.
    expect(getIntegrationsTab(INTEGRATIONS_TABS)).toBe("variables");
  });
});
