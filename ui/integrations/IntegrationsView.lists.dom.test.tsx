// What the page reads and when: the caller's connections list (reloaded
// after a change, and missed out loud when it fails), which variables route
// each card reads for each role, names from a service or a member rendered as
// text, and the office card's pointer to the personal one.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ApiError, setApiShim } = await import("../api.ts");
const { IntegrationsFake, EMPTY_CONNECTIONS } =
  await import("../test-support/integrations-fake.ts");
const { notifyConnectionsChanged, notifyManagedEnvSaved } =
  await import("../connections-events.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { OWNER, card, click, open, tab } =
  await import("../test-support/integrations-page-fixture.ts");
const { act } = await import("@testing-library/react");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const XSS = '<img src=x onerror="window.__pwned=1">';

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]).install();
});

const reads = () => fake.requests("GET", "/api/me/connections").length;

describe("the caller's connections list", () => {
  it("reloads after a variables save and after a secret or server change", async () => {
    await open();
    const first = reads();
    expect(first).toBeGreaterThan(0);
    await act(async () => notifyManagedEnvSaved());
    expect(reads()).toBe(first + 1);
    await act(async () => notifyConnectionsChanged());
    expect(reads()).toBe(first + 2);
  });

  it("says so on the MCP servers tab when it cannot be read", async () => {
    const shim = fake.handle.bind(fake);
    setApiShim(async (method, path, body) => {
      if (path === "/api/me/connections")
        throw new ApiError(500, "internal", "x");
      return shim(method, path, body);
    });
    const view = await open();
    expect(
      view.container.querySelector("[data-connections-failed]"),
    ).toBeNull();
    await tab(view, "mcp");
    expect(
      view.container.querySelector("[data-connections-failed]")!.textContent,
    ).toBe(t("integrations.connectionsFailed"));
  });

  it("renders a connector name and a note as text", async () => {
    fake.connections = {
      ...EMPTY_CONNECTIONS,
      claudeConnectors: [
        { scope: "personal", seenAt: 1, names: [XSS], statuses: [] },
      ],
    };
    fake.scope("Ricky").values = { A: "1" };
    fake.scope("Ricky").notes = { A: XSS };
    const view = await open();
    await tab(view, "mcp");
    expect(view.container.querySelector("img")).toBeNull();
    expect(card(view, "personal").textContent).toContain(XSS);
    await tab(view, "variables");
    expect(view.container.querySelector("img")).toBeNull();
    expect(
      card(view, "personal").querySelector("[data-connection-note]")!
        .textContent,
    ).toBe(XSS);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

// A member's reads are in IntegrationsView.access.
describe("which variables route each card reads", () => {
  it("an owner: the office's values, and their own", async () => {
    const view = await open(OWNER);
    await tab(view, "variables");
    expect(fake.requests("GET", "/api/office/env")).toHaveLength(1);
    expect(fake.requests("GET", "/api/users/Ricky/env")).toHaveLength(1);
    expect(fake.requests("GET", "/api/office/env/names")).toHaveLength(0);
  });
});

it("moves from the office sign-in's pointer to the personal card", async () => {
  fake.accounts = [
    {
      provider: "claude",
      scope: "office",
      accountStatus: "not_connected",
      loginStatus: "idle",
      shared: true,
      canBrowserLogin: true,
    },
  ] as never;
  const view = await open();
  // On the card itself, not on a shared prototype another file reads.
  const personal = card(view, "personal");
  let scrolled = 0;
  personal.scrollIntoView = () => {
    scrolled++;
  };
  await click(card(view, "office").querySelector("[data-settings-link]"));
  expect(scrolled).toBe(1);
});
