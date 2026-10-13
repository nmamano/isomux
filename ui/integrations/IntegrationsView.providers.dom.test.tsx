// The Model providers tab, and a page that meets an older server (ported from
// the Settings App.settings-connections and App.settings-mcp-servers tests):
// the account check settles whatever the answer, Refresh runs it again, and a
// route that answers with another shape costs only its own list.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StateCtx, initialState } = await import("../store.tsx");
const { ApiError, setApiShim } = await import("../api.ts");
const { IntegrationsView } = await import("./IntegrationsView.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

const OWNER = {
  ...initialState,
  hasReceivedInitialState: true,
  sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
  users: new Map([["ricky", { id: "u1", name: "Ricky", role: "owner" }]]),
} as unknown as typeof initialState;

let accounts: () => Promise<unknown>;
let connections: () => unknown;
let mcp: () => unknown;
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
  mcp = () => ({ servers: [] });
  setApiShim(async (method, path) => {
    sent.push(`${method} ${path}`);
    if (path.startsWith("/api/me/provider-accounts")) return accounts();
    if (path === "/api/me/connections") return connections();
    if (path.endsWith("/mcp-servers")) return mcp();
    if (path.endsWith("/secrets")) return { secrets: [] };
    if (path.endsWith("/env")) return { mode: "managed", values: {} };
    return {};
  });
});

async function open() {
  const view = render(
    createElement(
      StateCtx.Provider,
      { value: OWNER },
      createElement(IntegrationsView, { onClose: () => {} }),
    ),
  );
  await act(async () => {});
  return view;
}

const states = (view: ReturnType<typeof render>, state: string) =>
  view.container.querySelectorAll(`[data-provider-account-state="${state}"]`);

it("keeps account rows in the loading state until the request settles", async () => {
  accounts = () => new Promise(() => {});
  const view = await open();
  // Codex and Claude, on the office card and on yours.
  expect(states(view, "checking")).toHaveLength(4);
});

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

for (const [label, answer] of [
  ["answers {}", () => ({})],
  [
    "answers 404",
    () => {
      throw new ApiError(404, "not_found", "Not found");
    },
  ],
] as const)
  it(`shows the MCP list's load failure when its route ${label}, and the page renders`, async () => {
    mcp = answer;
    const view = await open();
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-integrations-tab="mcp"]')!,
      );
    });
    const office = view.container.querySelector(
      '[data-mcp-servers-path="/api/office/mcp-servers"]',
    )!;
    expect(office.querySelector('[role="alert"]')!.textContent).toBe(
      t("settings.mcpServers.loadFailed"),
    );
    expect(
      view.container.querySelector('[data-integrations-card="personal"]'),
    ).not.toBeNull();
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
