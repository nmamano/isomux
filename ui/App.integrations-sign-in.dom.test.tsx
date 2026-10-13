// The way back to the Integrations page from an MCP sign-in, at the new path
// (/integrations?mcpSignIn=<code>) and at the old one an in-flight sign-in
// still uses (/settings?mcpSignIn=<code>; Lead, ruling 1).

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

describe("back from an MCP sign-in", () => {
  for (const path of ["/integrations", "/settings"])
    it(`lands on the MCP servers tab from ${path}, naming whose server it was`, async () => {
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
      expect(
        view.baseElement.querySelector('[data-mcp-sign-in-notice="ok"]')!
          .textContent,
      ).toBe(
        t("integrations.mcp.signedInTo.member", {
          member: "Beth",
          name: "linear",
        }),
      );
      // Read once: the page on You, and the note is gone.
      expect(member(view)).toBeNull();
      expect(sessionStorage.length).toBe(0);
    });

  it("explains a failed sign-in by its code, naming no one without a note", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=denied");
    const view = await app();
    expect(
      view.baseElement.querySelector('[data-mcp-sign-in-notice="error"]')!
        .textContent,
    ).toBe(t("settings.mcpServers.signInError.denied"));
  });

  it("names the member on a failed sign-in, as on a success", async () => {
    rememberSignIn({
      server: "linear",
      target: { kind: "member", username: "Beth" },
    });
    window.history.replaceState(null, "", "/integrations?mcpSignIn=denied");
    const view = await app();
    const notice = view.baseElement.querySelector(
      '[data-mcp-sign-in-notice="error"]',
    )!.textContent;
    expect(notice).toContain(
      t("integrations.mcp.signInFailedFor.member", {
        member: "Beth",
        name: "linear",
      }),
    );
    expect(notice).toContain(t("settings.mcpServers.signInError.denied"));
  });

  it("names no one with no note, and a later sign-in replaces an abandoned one", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const generic = await app();
    expect(
      generic.baseElement.querySelector('[data-mcp-sign-in-notice="ok"]')!
        .textContent,
    ).toBe(t("settings.mcpServers.signInDone"));
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
    const text = view.baseElement.querySelector(
      '[data-mcp-sign-in-notice="ok"]',
    )!.textContent;
    expect(text).toBe(t("integrations.mcp.signedInTo.self", { name: "notes" }));
    expect(text).not.toContain("Beth");
  });

  it("shows the notice once: the next open has none", async () => {
    window.history.replaceState(null, "", "/integrations?mcpSignIn=ok");
    const view = await app();
    expect(
      view.baseElement.querySelector("[data-mcp-sign-in-notice]"),
    ).not.toBeNull();
    await act(async () => {
      view.getByRole("button", { name: t("settings.backToOffice") }).click();
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
    expect(
      view.baseElement.querySelector("[data-integrations-page]"),
    ).not.toBeNull();
    expect(
      view.baseElement.querySelector("[data-mcp-sign-in-notice]"),
    ).toBeNull();
  });
});
