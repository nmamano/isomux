// The Browser Use tab (task f2d5cf9f): Browser Use moved here from Settings. It
// pairs the viewer's own Chrome only, so it has no office card and no member
// picker. It is remembered like the other tabs (IntegrationsView.polish).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { OWNER, card, open, pick, selectedTab, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

type View = Awaited<ReturnType<typeof open>>;
const selected = selectedTab;
// The sidebar holds no cards, so the whole page stands for the open tab.
const panel = (view: View) => view.container;

describe("the Browser Use tab", () => {
  it("shows an owner their own Chrome while a member is picked, and keeps the pick for the other tabs", async () => {
    const view = await open();
    // The cards are up on the first tab, so their absence below is the tab's.
    expect(
      panel(view).querySelectorAll("[data-integrations-card]").length,
    ).toBe(2);
    await pick(view, "Stephen");
    expect(
      card(view, "personal").getAttribute("data-integrations-member"),
    ).toBe("Stephen");
    await tab(view, "browser");
    expect(selected(view)).toBe("browser");
    expect(
      panel(view).querySelector('[data-testid="browser-settings"]'),
    ).not.toBeNull();
    // The Chrome pairing pane alone: no cards, no member picker.
    expect(
      panel(view).querySelectorAll("[data-integrations-card]").length,
    ).toBe(0);
    expect(
      view.container.querySelector("[data-integrations-picker]"),
    ).toBeNull();
    expect(
      view.container.querySelector("[data-integrations-member]"),
    ).toBeNull();
    expect(view.container.textContent).not.toContain("Stephen");
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
});
