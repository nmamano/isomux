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
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
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
  ).toContain('<img src=x onerror="boom">');
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
        canTestOffice
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
        canTestOffice
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
  const view = render(
    <ConnectionsList username="Ann" half="personal" canTestOffice />,
  );
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
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
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
  // No status read yet: pending, not an error.
  expect(detail(rows[2])).toBe(
    `${t("settings.connections.list.engineMcpFolder", { folder: "/w/app" })} · ${t("settings.connections.status.pending")}`,
  );
  view.unmount();
});

// The Test button (integrations A3).
const testList: List = {
  variables: [
    { scope: "office", name: "OFFICE_VAR" },
    { scope: "personal", name: "MINE" },
  ],
  signIns: [{ scope: "office", engine: "claude", account: "boss@example.com" }],
  claudeConnectors: [
    {
      scope: "office",
      seenAt: 1,
      names: ["Gmail", "Drive"],
      statuses: [{ name: "Gmail", status: "failed" }],
    },
  ],
  mcpServers: [
    {
      scope: "office",
      name: "linear",
      host: "mcp.linear.app",
      credential: true,
      secret: null,
      problem: null,
      overridden: false,
    },
    {
      scope: "personal",
      name: "docs",
      host: "docs.example.com",
      credential: true,
      secret: "DOCS_TOKEN",
      problem: "secret_host",
      overridden: false,
    },
    {
      scope: "personal",
      name: "wiki",
      host: "wiki.example.com",
      credential: false,
      secret: null,
      problem: null,
      overridden: false,
    },
  ],
  engineMcpServers: [
    {
      engine: "claude",
      name: "repo",
      source: "user",
      folder: null,
      status: "connected",
    },
  ],
  secrets: [
    {
      scope: "office",
      name: "GH_TOKEN",
      hosts: ["api.github.com", "github.com"],
      test: "github",
    },
    {
      scope: "personal",
      name: "CUSTOM",
      hosts: ["api.example.com"],
      test: null,
    },
  ],
};

function rowsOf(view: { container: HTMLElement }) {
  return [
    ...view.container.querySelectorAll<HTMLElement>("[data-connection-row]"),
  ];
}

// For each row: its kind, whether it has a Test button, and the text in the
// button's place when it has none.
function slots(view: { container: HTMLElement }) {
  return rowsOf(view).map((row) => [
    row.dataset.connectionRow,
    row.querySelector("[data-connection-test]") !== null,
    row.querySelector("[data-connection-no-test]")?.textContent ?? null,
  ]);
}

test("a Test button on each row Isomux can test, and the reason on the rest", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t } = translatorFor("en");
  setApiShim(async () => testList);
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  const none = t("settings.connections.test.none");
  expect(slots(view)).toEqual([
    ["signIn", true, null],
    // Claude's own rows show the status Claude reported instead.
    ["connectors", false, null],
    ["mcpServer", true, null],
    ["secret", true, null],
    ["variable", false, none],
    ["mcpServer", false, none],
    ["mcpServer", true, null],
    ["engineMcp", false, null],
    ["secret", false, t("settings.connections.test.noHostTest")],
    ["variable", false, none],
  ]);
  // The variables' reason is said once, not on each row.
  expect(
    view.container.querySelectorAll("[data-variables-no-test]"),
  ).toHaveLength(1);
  const detail = (row: HTMLElement) =>
    row.querySelector("[data-connection-detail]")!.textContent;
  const rows = rowsOf(view);
  // A connector with no status read yet is pending, not failed.
  expect(detail(rows[1])).toBe(
    [
      t("settings.connections.list.nameStatus", {
        name: "Gmail",
        status: t("settings.connections.status.failed"),
      }),
      t("settings.connections.list.nameStatus", {
        name: "Drive",
        status: t("settings.connections.status.pending"),
      }),
    ].join(", "),
  );
  expect(detail(rows[7])).toContain(t("settings.connections.status.connected"));
  // A secret row lists its hosts and links to the Secrets list.
  expect(detail(rows[3])).toBe("api.github.com, github.com");
  expect(rows[3].textContent).toContain(t("settings.secrets.title"));
  view.unmount();
});

test("a member cannot test office secrets and MCP servers, and is told owners can", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t } = translatorFor("en");
  setApiShim(async () => testList);
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice={false} />,
  );
  await act(async () => {});
  const owners = t("settings.connections.test.ownersOnly");
  const office = slots(view).filter(
    ([kind]) => kind === "mcpServer" || kind === "secret",
  );
  expect(office).toEqual([
    ["mcpServer", false, owners],
    ["secret", false, owners],
    ["mcpServer", false, t("settings.connections.test.none")],
    ["mcpServer", true, null],
    ["secret", false, t("settings.connections.test.noHostTest")],
  ]);
  view.unmount();
});

test("Test shows the account or the tool count, or a reason, and runs once at a time", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t, tn } = translatorFor("en");
  const sent: string[] = [];
  let release: () => void = () => {};
  let secretFails = false;
  let secretAnswer: unknown = {
    result: {
      ok: true,
      kind: "secret",
      host: "api.github.com",
      account: "octocat",
    },
  };
  setApiShim(async (method, path) => {
    if (method === "GET") return testList;
    sent.push(`${method} ${path}`);
    if (path === "/api/office/secrets/GH_TOKEN/test") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (secretFails) throw new Error("gone");
      return secretAnswer;
    }
    if (path === "/api/users/Ann/mcp-servers/wiki/test")
      return {
        result: {
          ok: true,
          kind: "mcp",
          host: "wiki.example.com",
          server: "Wiki",
          tools: 3,
        },
      };
    throw new Error("unexpected call");
  });
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  const rows = rowsOf(view);
  const button = (row: HTMLElement) =>
    row.querySelector<HTMLButtonElement>("[data-connection-test]")!;
  const result = (row: HTMLElement) =>
    row.querySelector<HTMLElement>("[data-connection-test-result]");

  await act(async () => fireEvent.click(button(rows[3])));
  expect(button(rows[3]).disabled).toBe(true);
  expect(button(rows[3]).textContent).toBe(
    t("settings.connections.test.running"),
  );
  await act(async () => fireEvent.click(button(rows[3])));
  await act(async () => release());
  expect(sent).toEqual(["POST /api/office/secrets/GH_TOKEN/test"]);
  expect(result(rows[3])?.dataset.connectionTestResult).toBe("ok");
  expect(result(rows[3])?.textContent).toBe(
    `${t("settings.connections.test.works")} · octocat`,
  );

  await act(async () => fireEvent.click(button(rows[6])));
  expect(result(rows[6])?.textContent).toBe(
    `${t("settings.connections.test.works")} · Wiki · ${tn("settings.connections.test.tools", 3)}`,
  );

  // A wrong credential: the reason names the host.
  secretAnswer = {
    result: { ok: false, host: "api.github.com", reason: "refused" },
  };
  await act(async () => fireEvent.click(button(rows[3])));
  await act(async () => release());
  expect(result(rows[3])?.dataset.connectionTestResult).toBe("failed");
  expect(result(rows[3])?.textContent).toBe(
    t("settings.connections.test.refused", { host: "api.github.com" }),
  );

  // 403 is its own reason: the credential is known.
  secretAnswer = {
    result: { ok: false, host: "api.github.com", reason: "forbidden" },
  };
  await act(async () => fireEvent.click(button(rows[3])));
  await act(async () => release());
  expect(result(rows[3])?.textContent).toBe(
    t("settings.connections.test.forbidden", { host: "api.github.com" }),
  );

  // The request itself fails (for example, the secret was just deleted).
  secretFails = true;
  await act(async () => fireEvent.click(button(rows[3])));
  await act(async () => release());
  expect(result(rows[3])?.dataset.connectionTestResult).toBe("error");
  view.unmount();
});

test("a sign-in's Test runs the account check and reads its own scope", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t } = translatorFor("en");
  let connected = true;
  const sent: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET") return testList;
    sent.push(`${method} ${path}`);
    return {
      accounts: [
        {
          provider: "claude",
          scope: "personal",
          accountStatus: "connected",
          accountLabel: "me@example.com",
        },
        {
          provider: "claude",
          scope: "office",
          accountStatus: connected ? "connected" : "not_connected",
          accountLabel: "boss@example.com",
        },
      ],
    };
  });
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  const row = rowsOf(view)[0];
  const button = row.querySelector<HTMLButtonElement>(
    "[data-connection-test]",
  )!;
  await act(async () => fireEvent.click(button));
  expect(sent).toEqual(["POST /api/me/provider-accounts/refresh"]);
  expect(row.querySelector("[data-connection-test-result]")?.textContent).toBe(
    `${t("settings.connections.test.works")} · boss@example.com`,
  );
  connected = false;
  await act(async () => fireEvent.click(button));
  expect(row.querySelector("[data-connection-test-result]")?.textContent).toBe(
    t("settings.connections.test.signedOut"),
  );
  view.unmount();
});

test("an older server's answer, without secrets or statuses, loads as pending with no secret rows", async () => {
  const { translatorFor } = await import("../../shared/i18n/translate");
  const { t } = translatorFor("en");
  setApiShim(async () => ({
    variables: [],
    signIns: [{ scope: "office", engine: "claude", account: null }],
    claudeConnectors: [{ scope: "office", seenAt: 1, names: ["Gmail"] }],
    mcpServers: [],
    engineMcpServers: [
      { engine: "claude", name: "repo", source: "user", folder: null },
      // A status this UI does not know reads as pending.
      {
        engine: "claude",
        name: "other",
        source: "user",
        folder: null,
        status: "rebooting",
      },
    ],
  }));
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  const rows = rowsOf(view);
  expect(rows.map((row) => row.dataset.connectionRow)).toEqual([
    "signIn",
    "connectors",
    "engineMcp",
    "engineMcp",
  ]);
  const pending = t("settings.connections.status.pending");
  for (const row of rows.slice(1))
    expect(
      row.querySelector("[data-connection-detail]")!.textContent,
    ).toContain(pending);
  view.unmount();
});

test("a secret whose test this UI does not know has no Test button", async () => {
  setApiShim(async () => ({
    ...testList,
    secrets: [
      { scope: "personal", name: "NEW_KIND", hosts: ["x.example"], test: "x" },
      { scope: "personal", name: "OLD", hosts: ["api.github.com"] },
      // Not a secret row at all.
      { scope: "personal" },
    ],
  }));
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  expect(slots(view).filter(([kind]) => kind === "secret")).toEqual([
    ["secret", false, expect.any(String)],
    ["secret", false, expect.any(String)],
  ]);
  view.unmount();
});
