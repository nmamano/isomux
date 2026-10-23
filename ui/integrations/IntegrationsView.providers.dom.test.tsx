// The Model providers tab, and a page that meets an older server (ported from
// the Settings App.settings-connections and App.settings-mcp-servers tests):
// the account check settles whatever the answer, Refresh runs it again, and a
// route that answers with another shape costs only its own list.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ApiError, setApiShim } = await import("../api.ts");
const { notifyConnectionsChanged, notifyManagedEnvSaved } =
  await import("../connections-events.ts");
const { open } = await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

let accounts: () => Promise<unknown>;
let connections: () => unknown;
const sent: string[] = [];
beforeEach(() => {
  sent.length = 0;
  accounts = async () => ({ accounts: [] });
  // An A1 server: no MCP or secret fields at all.
  connections = () => ({
    variables: [{ scope: "office", name: "GH_TOKEN" }],
    signIns: [],
    claudeConnectors: [],
  });
  setApiShim(async (method, path) => {
    sent.push(`${method} ${path}`);
    if (path.startsWith("/api/me/provider-accounts")) return accounts();
    if (path === "/api/me/connections") return connections();
    if (path.endsWith("/mcp-servers")) return { servers: [] };
    if (path.endsWith("/secrets")) return { secrets: [] };
    if (path.endsWith("/env")) return { mode: "managed", values: {} };
    return {};
  });
});

const states = (view: Awaited<ReturnType<typeof open>>, state: string) =>
  view.container.querySelectorAll(`[data-provider-account-state="${state}"]`);

it("finishes the account check when a loaded response has no account rows", async () => {
  const view = await open();
  expect(states(view, "unavailable")).toHaveLength(4);
});

it("finishes the account check when loading the account rows fails, and says so", async () => {
  accounts = async () => {
    throw new ApiError(500, "internal", "Could not reach the provider");
  };
  const view = await open();
  expect(states(view, "checking")).toHaveLength(0);
  const office = view.container.querySelector(
    '[data-integrations-card="office"]',
  )!;
  expect(office.querySelector('[role="alert"]')!.textContent).toBe(
    "Could not reach the provider",
  );
});

it("runs the account check again from Refresh", async () => {
  const view = await open();
  await act(async () => {
    fireEvent.click(view.container.querySelector("[data-providers-refresh]")!);
  });
  expect(sent).toContain("POST /api/me/provider-accounts/refresh");
});

it("points API keys at the Variables tab", async () => {
  const view = await open();
  const hint = view.container.querySelector("[data-api-keys-hint]")!;
  expect(hint.textContent).toContain("ANTHROPIC_API_KEY");
  await act(async () => {
    fireEvent.click(hint.querySelector("[data-go-variables]")!);
  });
  expect(
    view.container
      .querySelector('[data-integrations-tab="variables"]')!
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("renders every tab when the connections answer has another shape", async () => {
  connections = () => ({});
  const view = await open();
  for (const id of ["mcp", "secrets", "variables"]) {
    await act(async () => {
      fireEvent.click(
        view.container.querySelector(`[data-integrations-tab="${id}"]`)!,
      );
    });
    expect(
      view.container.querySelector('[data-integrations-card="office"]'),
    ).not.toBeNull();
  }
});

// A saved variable or secret can change the OPENAI_API_KEY the Codex card
// names (task a704657a): the page reads the accounts again, without the
// probe that Refresh starts and without going back to "checking".
it("reads the accounts again after a variable or secret save", async () => {
  accounts = async () => ({
    accounts: [
      {
        provider: "codex",
        scope: "office",
        accountStatus: "not_connected",
        loginStatus: "idle",
        canBrowserLogin: true,
      },
    ],
  });
  const view = await open();
  const reads = () =>
    sent.filter((request) =>
      request.startsWith("GET /api/me/provider-accounts"),
    ).length;
  const first = reads();
  expect(first).toBeGreaterThan(0);

  await act(async () => notifyManagedEnvSaved());
  expect(reads()).toBe(first + 1);
  await act(async () => notifyConnectionsChanged());
  expect(reads()).toBe(first + 2);
  expect(sent).not.toContain("POST /api/me/provider-accounts/refresh");
  expect(states(view, "checking")).toHaveLength(0);

  view.unmount();
  await act(async () => {
    notifyManagedEnvSaved();
    notifyConnectionsChanged();
  });
  expect(reads()).toBe(first + 2);
});
