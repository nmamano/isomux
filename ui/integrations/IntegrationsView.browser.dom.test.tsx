// The Browser Use tab (task f2d5cf9f): Browser Use moved here from Settings. It
// pairs the viewer's own Chrome only, so it has no office card and no member
// picker, and it is remembered like the other tabs.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { OWNER, MEMBER, card, open, pick, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const TAB_KEY = "isomux-integrations-tab";

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

type View = Awaited<ReturnType<typeof open>>;
const selected = (view: View) =>
  view.container
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.getAttribute("data-integrations-tab") ?? null;
const panel = (view: View) =>
  view.container.querySelector('[role="tabpanel"]')!;

describe("the Browser Use tab", () => {
  it("is the sixth tab", async () => {
    const view = await open();
    const tabs = [
      ...view.container.querySelectorAll("[data-integrations-tab]"),
    ].map((el) => el.getAttribute("data-integrations-tab"));
    expect(tabs).toEqual([
      "providers",
      "mcp",
      "secrets",
      "variables",
      "voice",
      "browser",
    ]);
  });

  for (const [who, state] of [
    ["an owner", OWNER],
    ["a member", MEMBER],
  ] as const)
    it(`shows ${who} the Chrome pairing pane alone: no cards, no member picker`, async () => {
      const view = await open(state);
      // The cards are up on the first tab, so their absence below is the tab's.
      expect(
        panel(view).querySelectorAll("[data-integrations-card]").length,
      ).toBe(2);
      await tab(view, "browser");
      expect(selected(view)).toBe("browser");
      expect(
        panel(view).querySelector('[data-testid="browser-settings"]'),
      ).not.toBeNull();
      expect(
        panel(view).querySelectorAll("[data-integrations-card]").length,
      ).toBe(0);
      expect(
        view.container.querySelector("[data-integrations-picker]"),
      ).toBeNull();
      expect(fake.requests("GET", "/api/me/browser").length).toBeGreaterThan(0);
    });

  it("shows an owner their own Chrome while a member is picked, and keeps the pick for the other tabs", async () => {
    const view = await open();
    await pick(view, "Stephen");
    expect(
      card(view, "personal").getAttribute("data-integrations-member"),
    ).toBe("Stephen");
    await tab(view, "browser");
    expect(
      view.container.querySelector("[data-integrations-picker]"),
    ).toBeNull();
    expect(
      view.container.querySelector("[data-integrations-member]"),
    ).toBeNull();
    expect(view.container.textContent).not.toContain("Stephen");
    expect(
      panel(view).querySelector('[data-testid="browser-settings"]'),
    ).not.toBeNull();
    // The pane reads only the viewer's own route, never the member's.
    expect(fake.requests("GET", "/api/me/browser").length).toBeGreaterThan(0);
    expect(
      fake
        .requests("GET", /\/browser/)
        .every((c) => c.path === "/api/me/browser"),
    ).toBe(true);
    await tab(view, "secrets");
    expect(
      card(view, "personal").getAttribute("data-integrations-member"),
    ).toBe("Stephen");
  });

  it("renders no pane, and asks for nothing, without a session", async () => {
    const noSession = {
      ...OWNER,
      sessionContext: null,
    } as unknown as typeof OWNER;
    const view = await open(noSession);
    await tab(view, "browser");
    expect(selected(view)).toBe("browser");
    expect(
      view.container.querySelector('[data-testid="browser-settings"]'),
    ).toBeNull();
    expect(fake.requests("GET", "/api/me/browser")).toHaveLength(0);
  });

  it("is remembered on the device", async () => {
    const first = await open();
    await tab(first, "browser");
    expect(window.localStorage.getItem(TAB_KEY)).toBe("browser");
    first.unmount();
    const next = await open();
    expect(selected(next)).toBe("browser");
  });

  it("opens on a request that names it, over the remembered tab, and is remembered", async () => {
    window.localStorage.setItem(TAB_KEY, "secrets");
    let handled = 0;
    const view = await open(OWNER, {
      request: { tab: "browser" },
      onRequestHandled: () => handled++,
    });
    expect(selected(view)).toBe("browser");
    expect(handled).toBe(1);
    expect(window.localStorage.getItem(TAB_KEY)).toBe("browser");
  });
});
