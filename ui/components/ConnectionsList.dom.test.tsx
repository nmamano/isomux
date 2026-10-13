import { afterAll, expect, test } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { ConnectionsList } = await import("./ConnectionsList");
const { setApiShim } = await import("../api");
const { notifyManagedEnvSaved } = await import("../connections-events");
afterAll(() => setApiShim(null));

type List = import("../../shared/contract-shapes").ConnectionsListRes;

const list: List = {
  variables: [{ scope: "personal", name: "MINE" }],
  signIns: [{ scope: "office", engine: "claude", account: "boss@example.com" }],
  claudeConnectors: [
    // Connector names come from the claude.ai account: text only.
    { scope: "office", seenAt: 1, names: ['<img src=x onerror="boom">'] },
    { scope: "personal", seenAt: 2, names: ["Drive"] },
  ],
  mcpServers: [],
  engineMcpServers: [],
};

test("each row shows its scope tag, and only the office sign-in's connectors say every Claude agent can use them", async () => {
  setApiShim(async () => list);
  const view = render(<ConnectionsList username="Ann" half="office" />);
  await act(async () => {});
  const rows = [
    ...view.container.querySelectorAll<HTMLElement>("[data-connection-row]"),
  ];
  expect(
    rows.map((row) => [
      row.dataset.connectionRow,
      row.querySelector<HTMLElement>("[data-connection-tag]")?.dataset
        .connectionTag,
      row.querySelector("[data-every-claude-agent]") !== null,
    ]),
  ).toEqual([
    ["signIn", "office", false],
    ["connectors", "office", true],
    ["connectors", "personal", false],
    ["variable", "personal", false],
  ]);
  const officeConnector = rows[1];
  expect(
    officeConnector.querySelector("[data-connection-detail]")?.textContent,
  ).toBe('<img src=x onerror="boom">');
  expect(view.container.querySelector("img")).toBeNull();
  for (const link of view.container.querySelectorAll<HTMLAnchorElement>(
    '[data-connection-link="claude"]',
  ))
    expect(link.getAttribute("href")).toBe(
      "https://claude.ai/settings/connectors",
    );
  // The account the sign-in shows is the one the service sees.
  expect(rows[0].textContent).toContain("boss@example.com");
  view.unmount();
});

test("a link in this half scrolls to the editor; one in the other half moves there first", async () => {
  setApiShim(async () => list);
  let moved = 0;
  const view = render(
    <div>
      <ConnectionsList
        username="Ann"
        half="office"
        onGoToOtherHalf={() => moved++}
      />
      <section data-provider-card="claude" />
    </div>,
  );
  await act(async () => {});
  const scrolled: string[] = [];
  const card = view.container.querySelector<HTMLElement>(
    '[data-provider-card="claude"]',
  )!;
  card.scrollIntoView = () => scrolled.push("claude-card");
  const pageLinks = view.container.querySelectorAll<HTMLElement>(
    '[data-connection-link="page"]',
  );
  // Sign-in (office half), then the variable (personal half).
  await act(async () => fireEvent.click(pageLinks[0]));
  expect(scrolled).toEqual(["claude-card"]);
  expect(moved).toBe(0);
  await act(async () => fireEvent.click(pageLinks[1]));
  expect(moved).toBe(1);
  expect(scrolled).toEqual(["claude-card"]);
  // The page keeps this list mounted and moves it to the other half; the
  // held link lands on that half's editor once it is there.
  view.rerender(
    <div>
      <ConnectionsList
        username="Ann"
        half="personal"
        onGoToOtherHalf={() => moved++}
      />
      <div data-managed-env-path="/api/users/Ann/env" />
    </div>,
  );
  view.container.querySelector<HTMLElement>(
    '[data-managed-env-path="/api/users/Ann/env"]',
  )!.scrollIntoView = () => scrolled.push("personal-editor");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(scrolled).toEqual(["claude-card", "personal-editor"]);
  view.unmount();
});

test("an unseen sign-in reads as pending, and a variables save reloads the list", async () => {
  let calls = 0;
  let current: List = {
    variables: [],
    signIns: [{ scope: "office", engine: "claude", account: null }],
    claudeConnectors: [{ scope: "office", seenAt: null, names: [] }],
    mcpServers: [],
    engineMcpServers: [],
  };
  setApiShim(async (method, path) => {
    expect([method, path]).toEqual(["GET", "/api/me/connections"]);
    calls++;
    return current;
  });
  const view = render(<ConnectionsList username="Ann" half="personal" />);
  await act(async () => {});
  expect(
    [
      ...view.container.querySelectorAll<HTMLElement>("[data-connection-row]"),
    ].map((row) => row.dataset.connectionRow),
  ).toEqual(["signIn", "connectorsPending"]);
  current = { ...current, variables: [{ scope: "personal", name: "NEW" }] };
  await act(async () => notifyManagedEnvSaved());
  await act(async () => {});
  expect(calls).toBe(2);
  expect(
    view.container.querySelector('[data-connection-row="variable"]'),
  ).not.toBeNull();
  view.unmount();
});

test("a variables editor save tells the list to reload", async () => {
  const { ManagedEnvEditor } = await import("./ManagedEnvEditor");
  const { onManagedEnvSaved } = await import("../connections-events");
  setApiShim(async (method) =>
    method === "GET" ? { mode: "managed", values: { A: "1" } } : undefined,
  );
  let saves = 0;
  const stop = onManagedEnvSaved(() => saves++);
  const view = render(<ManagedEnvEditor path="/api/office/env" />);
  await act(async () => {});
  const value = view.container.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  await act(async () => fireEvent.change(value, { target: { value: "2" } }));
  const buttons = view.container.querySelectorAll("button");
  await act(async () => fireEvent.click(buttons[buttons.length - 1]));
  expect(saves).toBe(1);
  stop();
  view.unmount();
});

test("an MCP server row shows its host and credential, a replaced office one says so, and Claude's own say where they are set", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t } = translatorFor("en");
  setApiShim(async () => ({
    variables: [],
    signIns: [],
    claudeConnectors: [],
    mcpServers: [
      {
        scope: "office",
        name: "linear",
        host: "mcp.linear.app",
        credential: true,
        secret: null,
        problem: null,
        overridden: true,
      },
      {
        scope: "personal",
        name: "docs",
        host: "docs.example.com",
        credential: true,
        secret: "DOCS_TOKEN",
        problem: "secret_missing",
        overridden: false,
      },
    ],
    engineMcpServers: [
      { engine: "claude", name: "repo", source: "project", folder: "/w/app" },
    ],
  }));
  const view = render(<ConnectionsList username="Ann" half="office" />);
  await act(async () => {});
  const rows = [
    ...view.container.querySelectorAll<HTMLElement>("[data-connection-row]"),
  ];
  expect(rows.map((row) => row.dataset.connectionRow)).toEqual([
    "mcpServer",
    "mcpServer",
    "engineMcp",
  ]);
  const detail = (row: HTMLElement) =>
    row.querySelector("[data-connection-detail]")!.textContent;
  expect(detail(rows[0])).toBe(
    `mcp.linear.app · ${t("settings.connections.list.mcpCredential")}`,
  );
  expect(rows[0].querySelector("[data-mcp-overridden]")).not.toBeNull();
  expect(detail(rows[1])).toBe(
    `docs.example.com · ${t("settings.connections.list.mcpSecretMissing")}`,
  );
  expect(rows[1].querySelector("[data-mcp-overridden]")).toBeNull();
  expect(rows[2].textContent).toContain(
    t("settings.connections.list.setInProject", { file: "/w/app/.mcp.json" }),
  );
  // Who gets a server set in Claude depends on its Claude file, not on an
  // Isomux scope: no Office-wide or Individual tag, and the detail says who.
  expect(rows[2].querySelector("[data-connection-tag]")).toBeNull();
  expect(rows[0].querySelector("[data-connection-tag]")).not.toBeNull();
  expect(detail(rows[2])).toBe(
    t("settings.connections.list.engineMcpFolder", { folder: "/w/app" }),
  );
  view.unmount();
});
