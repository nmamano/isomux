// The claude.ai connectors and the MCP servers set in Claude's files, on the
// MCP servers tab (Nil, 2026-10-13: a bullet list whose name and status never
// look alike, and a (?) that explains Pending).

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { ConnectorList, EngineMcpList } = await import("./ClaudeLists.tsx");
const { MyConnectionsProvider } = await import("./my-connections.tsx");
const { EMPTY_CONNECTIONS } =
  await import("../test-support/integrations-fake.ts");
const { CLAUDE_CONNECTORS_URL } = await import("../connection-rows.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t, tn } = translatorFor("en");

async function mount(list: unknown, child: ReturnType<typeof createElement>) {
  setApiShim(async () => list);
  const view = render(createElement(MyConnectionsProvider, null, child));
  await act(async () => {});
  return view;
}

it("lists each connector with its own status pill, and Pending explains itself", async () => {
  const view = await mount(
    {
      ...EMPTY_CONNECTIONS,
      signIns: [
        { scope: "office", engine: "claude", account: "boss@example.com" },
      ],
      claudeConnectors: [
        {
          scope: "office",
          seenAt: 1,
          names: ["Gmail", "Drive", "Slack"],
          statuses: [
            { name: "Gmail", status: "connected", tools: 12 },
            { name: "Drive", status: "needs-auth", tools: 5 },
          ],
        },
      ],
    },
    createElement(ConnectorList, { scope: "office" }),
  );
  const block = view.container.querySelector(
    '[data-claude-connectors="office"]',
  )!;
  expect(block.textContent).toContain(
    t("integrations.connectors.title", { account: "boss@example.com" }),
  );
  // The account is data, in its own element.
  expect(block.querySelector("[data-integrations-data]")!.textContent).toBe(
    "boss@example.com",
  );
  const item = (name: string) =>
    block.querySelector(`[data-claude-connector="${name}"]`)!;
  expect(block.querySelectorAll("li")).toHaveLength(3);
  expect(item("Gmail").querySelector("[data-claude-status]")!.textContent).toBe(
    t("integrations.status.connected"),
  );
  expect(item("Drive").querySelector("[data-claude-status]")!.textContent).toBe(
    t("integrations.status.needsAuth"),
  );
  // The tool count shows with Connected only.
  expect(item("Gmail").querySelector("[data-claude-tools]")!.textContent).toBe(
    tn("settings.connections.test.tools", 12),
  );
  expect(item("Drive").querySelector("[data-claude-tools]")).toBeNull();
  // A name with no status read yet is Pending, with a (?).
  expect(item("Slack").querySelector("[data-claude-status]")!.textContent).toBe(
    t("integrations.status.pending"),
  );
  expect(item("Gmail").querySelector("[data-help-tip]")).toBeNull();
  const tip = item("Slack").querySelector("[data-help-tip]")!;
  await act(async () => fireEvent.click(tip));
  expect(item("Slack").querySelector('[role="note"]')!.textContent).toBe(
    t("integrations.connectors.pendingHelp"),
  );
  expect(
    block.querySelector<HTMLAnchorElement>('[data-connection-link="claude"]')!
      .href,
  ).toBe(CLAUDE_CONNECTORS_URL);
});

it("tells a sign-in with no turn seen from one that has no connectors", async () => {
  const unseen = await mount(
    {
      ...EMPTY_CONNECTIONS,
      claudeConnectors: [{ scope: "personal", seenAt: null, names: [] }],
    },
    createElement(ConnectorList, { scope: "personal" }),
  );
  expect(
    unseen.container.querySelector("[data-connectors-unknown]")!.textContent,
  ).toBe(t("integrations.connectors.unknown"));
  unseen.unmount();
  const none = await mount(
    {
      ...EMPTY_CONNECTIONS,
      claudeConnectors: [{ scope: "personal", seenAt: 1, names: [] }],
    },
    createElement(ConnectorList, { scope: "personal" }),
  );
  expect(none.container.querySelector("[data-claude-connectors]")).toBeNull();
});

// A folder's .mcp.json shows on the office card; user and local settings on
// the card of the sign-in that holds them; a directory neither sign-in uses
// now, nowhere (Lead, 2026-10-13).
const ENGINE_SERVERS = {
  ...EMPTY_CONNECTIONS,
  engineMcpServers: [
    {
      engine: "claude",
      name: "notes",
      source: "user",
      folder: null,
      signIn: "personal",
      status: "connected",
      tools: 3,
    },
    {
      engine: "claude",
      name: "repo",
      source: "project",
      folder: "/home/ann/app",
      signIn: null,
      status: null,
    },
    {
      engine: "claude",
      name: "office-local",
      source: "local",
      folder: "/srv/site",
      signIn: "office",
      status: "failed",
      tools: 4,
    },
    {
      engine: "claude",
      name: "stale",
      source: "user",
      folder: null,
      signIn: null,
      status: "connected",
    },
  ],
};

it("lists the MCP servers set in Claude's files on the card where they apply", async () => {
  const names = (view: Awaited<ReturnType<typeof mount>>) =>
    [...view.container.querySelectorAll("[data-engine-mcp]")].map((row) =>
      row.getAttribute("data-engine-mcp"),
    );
  const office = await mount(
    ENGINE_SERVERS,
    createElement(EngineMcpList, { scope: "office" }),
  );
  expect(names(office)).toEqual(["repo", "office-local"]);
  const row = (name: string) =>
    office.container.querySelector(`[data-engine-mcp="${name}"]`)!;
  // The folder is data, in its own element.
  expect(
    row("repo").querySelector("[data-integrations-data]")?.textContent,
  ).toBe("/home/ann/app/.mcp.json");
  expect(row("repo").textContent).toContain(t("integrations.status.pending"));
  expect(
    row("office-local").querySelector("[data-integrations-data]")?.textContent,
  ).toBe("/srv/site");
  // A count shows with Connected only.
  expect(row("office-local").querySelector("[data-claude-tools]")).toBeNull();
  office.unmount();

  const personal = await mount(
    ENGINE_SERVERS,
    createElement(EngineMcpList, { scope: "personal" }),
  );
  expect(names(personal)).toEqual(["notes"]);
  const notes = personal.container.querySelector('[data-engine-mcp="notes"]')!;
  expect(notes.textContent).toContain(
    t("settings.connections.list.setInClaudeUser"),
  );
  expect(notes.querySelector("[data-claude-tools]")?.textContent).toBe(
    tn("settings.connections.test.tools", 3),
  );
  personal.unmount();

  // An older server or a stub: nothing, not a crash.
  const old = await mount(
    { unexpected: true },
    createElement(EngineMcpList, { scope: "office" }),
  );
  expect(old.container.innerHTML).toBe("");
});
