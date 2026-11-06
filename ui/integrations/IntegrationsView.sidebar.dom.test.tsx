// The Integrations sidebar (task db800fd8): the tabs became the Settings
// sidebar, and Pager and API tokens moved here from Settings. Both are the
// viewer's own, so they need a session and never follow the member picker. On
// a phone the list shows first, like Settings.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { OWNER, click, open, selectedTab, tab } =
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
const rows = (view: View) =>
  [...view.container.querySelectorAll("[data-integrations-tab]")].map((el) =>
    el.getAttribute("data-integrations-tab"),
  );
const cards = (view: View) =>
  view.container.querySelectorAll("[data-integrations-card]").length;
const noSession = { ...OWNER, sessionContext: null } as unknown as typeof OWNER;
const phone = { ...OWNER, isMobile: true };

describe("the sidebar", () => {
  it("lists the tabs in order, the viewer's own (Pager, API tokens, WhatsApp) last, and selects by row", async () => {
    const view = await open();
    // GitHub issues is an owner's tab; where it sits is not this test's.
    expect(rows(view).filter((id) => id !== "github")).toEqual([
      "providers",
      "mcp",
      "secrets",
      "variables",
      "voice",
      "browser",
      "pager",
      "api-tokens",
      "messaging",
    ]);
    expect(selectedTab(view)).toBe("providers");
    await tab(view, "mcp");
    expect(selectedTab(view)).toBe("mcp");
    expect(
      view.container.querySelectorAll(
        '[data-integrations-tab][aria-current="true"]',
      ).length,
    ).toBe(1);
    expect(window.localStorage.getItem(TAB_KEY)).toBe("mcp");
  });

  it("shows the viewer's own API tokens on API tokens", async () => {
    fake.apiTokens = [
      {
        id: "tok1",
        name: "laptop",
        tokenPrefix: "abcd1234",
        createdAt: 1_760_000_000_000,
        expiresAt: null,
        lastUsedAt: null,
      },
    ];
    const view = await open();
    await tab(view, "api-tokens");
    expect(selectedTab(view)).toBe("api-tokens");
    expect(
      view.container.querySelector('[data-api-token="tok1"]'),
    ).not.toBeNull();
    expect(cards(view)).toBe(0);
    expect(fake.requests("GET", "/api/me/api-tokens")).toHaveLength(1);
  });

  it("opens on a requested Pager tab", async () => {
    window.localStorage.setItem(TAB_KEY, "secrets");
    const view = await open(OWNER, { request: { tab: "pager" } });
    expect(selectedTab(view)).toBe("pager");
    expect(
      view.container.querySelector('[data-testid="pager-settings"]'),
    ).not.toBeNull();
  });
});

describe("without a session", () => {
  it("has no Pager, API tokens or WhatsApp row, and asks for none", async () => {
    const view = await open(noSession);
    expect(rows(view)).toEqual([
      "providers",
      "mcp",
      "secrets",
      "variables",
      "voice",
      "browser",
    ]);
    expect(
      fake.requests("GET", /pager-settings|api-tokens|whatsapp/),
    ).toHaveLength(0);
  });

  it("falls back to Model providers from a remembered or requested Pager or API tokens tab", async () => {
    window.localStorage.setItem(TAB_KEY, "pager");
    const remembered = await open(noSession);
    expect(selectedTab(remembered)).toBe("providers");
    expect(cards(remembered)).toBe(2);
    remembered.unmount();

    const requested = await open(noSession, {
      request: { tab: "api-tokens" },
    });
    expect(selectedTab(requested)).toBe("providers");
    expect(cards(requested)).toBe(2);
  });
});

describe("on a phone", () => {
  const back = (view: View) =>
    view.container.querySelector("[data-integrations-back]");

  it("shows the list first, a row opens its tab, and the back row returns to the list", async () => {
    let closed = 0;
    const view = await open(phone, { onClose: () => closed++ });
    expect(rows(view)).toHaveLength(10);
    expect(cards(view)).toBe(0);
    expect(back(view)).toBeNull();

    await tab(view, "secrets");
    expect(cards(view)).toBe(2);
    expect(rows(view)).toHaveLength(0);
    expect(back(view)).not.toBeNull();
    expect(window.localStorage.getItem(TAB_KEY)).toBe("secrets");

    await click(back(view));
    expect(rows(view)).toHaveLength(10);
    expect(cards(view)).toBe(0);

    // Escape on a tab goes back to the list, not out of the page.
    await tab(view, "mcp");
    expect(cards(view)).toBe(2);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(rows(view)).toHaveLength(10);
    expect(cards(view)).toBe(0);
    expect(closed).toBe(0);
  });

  // An armed confirm step takes Escape to end itself (task c6589760): the
  // tab stays, and the next Escape goes back to the list.
  it("Escape on an armed Revoke ends the confirm and keeps the tab", async () => {
    fake.apiTokens = [
      {
        id: "tok1",
        name: "laptop",
        tokenPrefix: "abcd1234",
        createdAt: 1_760_000_000_000,
        expiresAt: null,
        lastUsedAt: null,
      },
    ];
    const view = await open(phone);
    await tab(view, "api-tokens");
    const revoke = view.container.querySelector<HTMLElement>(
      '[data-api-token="tok1"] button',
    )!;
    await click(revoke);
    expect(revoke.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => {
      fireEvent.keyDown(revoke, { key: "Escape" });
    });
    expect(revoke.hasAttribute("data-confirm-armed")).toBe(false);
    expect(back(view)).not.toBeNull();
    expect(rows(view)).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(revoke, { key: "Escape" });
    });
    expect(rows(view)).toHaveLength(10);
    expect(fake.requests("DELETE", "/api/me/api-tokens/tok1")).toHaveLength(0);
  });

  it("opens straight on a requested tab", async () => {
    const view = await open(phone, { request: { tab: "variables" } });
    expect(cards(view)).toBe(2);
    expect(back(view)).not.toBeNull();
    expect(rows(view)).toHaveLength(0);
  });
});
