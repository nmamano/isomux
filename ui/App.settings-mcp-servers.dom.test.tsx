// A UI built before a server restart meets a server without the A2 routes or
// fields (Reviewer 2, C9; the A1 case is 33799c2d). The MCP servers editor
// shows its load failure, the integrations list treats missing MCP fields as
// empty lists, and the rest of the Connections pane renders.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim, ApiError } = await import("./api.ts");
const { createElement } = await import("react");
const { translatorFor } = await import("../shared/i18n/translate.ts");

const { t } = translatorFor("en");

const A1_SHAPE = {
  variables: [{ scope: "office", name: "GH_TOKEN" }],
  signIns: [],
  claudeConnectors: [],
};
let connectionsResponse: () => unknown = () => A1_SHAPE;
let mcpServersResponse: () => unknown = () => ({ servers: [] });
setApiShim(async (_method, path) => {
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path.startsWith("/api/me/provider-accounts")) return { accounts: [] };
  if (path === "/api/me/connections") return connectionsResponse();
  if (path.endsWith("/mcp-servers")) return mcpServersResponse();
  if (path.endsWith("/secrets")) return { secrets: [] };
  if (path === "/api/office/env") return { values: {} };
  return {};
});
afterAll(() => setApiShim(null));

const SIGNED_IN = {
  ...initialState,
  hasReceivedInitialState: true,
  sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
  users: new Map([
    [
      "ricky",
      {
        id: "u1",
        name: "Ricky",
        allowedRooms: [],
        notifRooms: [],
        hidden: [],
        order: [],
        memberPrompt: null,
        language: null,
        avatarColor: "#4A90D9",
        avatarVariant: 0,
        role: "owner",
      },
    ],
  ]),
} as unknown as typeof initialState;

beforeEach(() => {
  connectionsResponse = () => A1_SHAPE;
  mcpServersResponse = () => ({ servers: [] });
  window.history.replaceState(null, "", "/settings");
});

async function openOfficeConnections() {
  const view = render(
    createElement(
      StateCtx.Provider,
      { value: SIGNED_IN },
      createElement(App, {}),
    ),
  );
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: "Office-wide connections" }),
    );
  });
  await act(async () => {});
  return view;
}

function expectRestOfPane(view: ReturnType<typeof render>) {
  const { container } = view;
  expect(
    container.querySelector('[data-managed-env-path="/api/office/env"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-secrets-path="/api/office/secrets"]'),
  ).not.toBeNull();
}

for (const [label, answer] of [
  ["answers {}", () => ({})],
  [
    "answers 404",
    () => {
      throw new ApiError(404, "not_found", "Not found");
    },
  ],
] as const)
  it(`the MCP servers editor shows its load failure when its route ${label}, and the pane renders`, async () => {
    mcpServersResponse = answer;
    const view = await openOfficeConnections();
    const editor = view.container.querySelector(
      '[data-mcp-servers-path="/api/office/mcp-servers"]',
    )!;
    expect(editor.querySelector('[role="alert"]')?.textContent).toBe(
      t("settings.mcpServers.loadFailed"),
    );
    expectRestOfPane(view);
    view.unmount();
  });

it("an A1 server's connections answer, with no MCP fields, still lists its rows", async () => {
  const view = await openOfficeConnections();
  const list = view.container.querySelector("[data-connections-list]")!;
  expect(list.querySelector('[role="alert"]')).toBeNull();
  expect(
    [...list.querySelectorAll<HTMLElement>("[data-connection-row]")].map(
      (row) => row.dataset.connectionRow,
    ),
  ).toEqual(["variable"]);
  expectRestOfPane(view);
  view.unmount();
});

it("an MCP or secrets field of another shape loses only its own rows", async () => {
  connectionsResponse = () => ({
    ...A1_SHAPE,
    mcpServers: "nope",
    engineMcpServers: {},
    secrets: "nope",
  });
  const view = await openOfficeConnections();
  const list = view.container.querySelector("[data-connections-list]")!;
  expect(list.querySelector('[role="alert"]')).toBeNull();
  expect(list.querySelectorAll("[data-connection-row]")).toHaveLength(1);
  view.unmount();
});
