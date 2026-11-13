// An owner who picks a member sees that member's sign-in accounts and the
// connectors and Claude-set MCP servers of the member's agents, read from the
// member's own list (task b85f4051), and never the owner's own in their place.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ApiError, setApiShim } = await import("../api.ts");
const { IntegrationsFake, EMPTY_CONNECTIONS } =
  await import("../test-support/integrations-fake.ts");
const { card, open, pick, tab } =
  await import("../test-support/integrations-page-fixture.ts");
const { act } = await import("@testing-library/react");
afterAll(() => setApiShim(null));

const OWNER_ACCOUNT = "ricky-own@example.com";
const OFFICE_ACCOUNT = "office-account@example.com";
const MEMBER_CLAUDE = "stephen-claude@example.com";
const MEMBER_CODEX = "stephen-codex@example.com";

// The owner's own connections: what must never show under the member.
const OWNER_LIST = {
  ...EMPTY_CONNECTIONS,
  signIns: [
    {
      scope: "personal" as const,
      engine: "claude" as const,
      account: OWNER_ACCOUNT,
    },
    {
      scope: "office" as const,
      engine: "claude" as const,
      account: OFFICE_ACCOUNT,
    },
  ],
  claudeConnectors: [
    {
      scope: "personal" as const,
      seenAt: 1,
      names: ["Ricky Gmail"],
      statuses: [],
    },
  ],
  engineMcpServers: [
    {
      engine: "claude" as const,
      name: "ricky-local",
      source: "user" as const,
      folder: null,
      signIn: "personal" as const,
      status: "connected" as const,
    },
    {
      engine: "claude" as const,
      name: "ricky-project",
      source: "project" as const,
      folder: "/home/ricky/repo",
      signIn: null,
      status: "connected" as const,
    },
  ],
};

// Stephen's list as the server builds it for him: his personal sign-ins and
// the office one, his connectors, and the servers his agents reported.
const MEMBER_LIST = {
  ...EMPTY_CONNECTIONS,
  signIns: [
    {
      scope: "personal" as const,
      engine: "claude" as const,
      account: MEMBER_CLAUDE,
    },
    {
      scope: "personal" as const,
      engine: "codex" as const,
      account: MEMBER_CODEX,
    },
    {
      scope: "office" as const,
      engine: "claude" as const,
      account: OFFICE_ACCOUNT,
    },
  ],
  claudeConnectors: [
    {
      scope: "personal" as const,
      seenAt: 1,
      names: ["Stephen Drive"],
      statuses: [],
    },
    {
      scope: "office" as const,
      seenAt: 1,
      names: ["Office Slack"],
      statuses: [],
    },
  ],
  engineMcpServers: [
    {
      engine: "claude" as const,
      name: "stephen-local",
      source: "user" as const,
      folder: null,
      signIn: "personal" as const,
      status: "connected" as const,
    },
    {
      engine: "claude" as const,
      name: "stephen-project",
      source: "project" as const,
      folder: "/home/stephen/repo",
      signIn: null,
      status: "connected" as const,
    },
  ],
};

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
  fake.connections = OWNER_LIST;
  fake.accounts = [
    {
      provider: "claude",
      scope: "personal",
      accountStatus: "connected",
      accountLabel: OWNER_ACCOUNT,
      loginStatus: "idle",
      canBrowserLogin: true,
    },
  ];
  fake.providers = [
    { provider: "claude", status: "connected" },
    { provider: "codex", status: "connected" },
  ];
  fake.memberConnections.set("stephen", MEMBER_LIST);
});

const count = (root: Element, selector: string) =>
  root.querySelectorAll(selector).length;

it("shows the member's own Claude and Codex accounts on Model providers", async () => {
  const view = await open();
  await tab(view, "providers");
  await pick(view, "Stephen");
  expect(
    fake.requests("GET", "/api/users/Stephen/connections").length,
  ).toBeGreaterThan(0);
  const theirs = card(view, "personal");
  expect(
    theirs.querySelector('[data-member-provider="claude"]')!.textContent,
  ).toContain(MEMBER_CLAUDE);
  expect(
    theirs.querySelector('[data-member-provider="codex"]')!.textContent,
  ).toContain(MEMBER_CODEX);
  // Their personal sign-ins only: neither the owner's nor the office's.
  expect(theirs.textContent).not.toContain(OWNER_ACCOUNT);
  expect(theirs.textContent).not.toContain(OFFICE_ACCOUNT);

  // A member with no personal sign-in account, whose agents use the office
  // sign-in: no account on their rows, neither the office one nor one
  // borrowed from the owner or another member.
  fake.memberConnections.set("lena", {
    ...EMPTY_CONNECTIONS,
    signIns: [
      { scope: "office", engine: "claude", account: OFFICE_ACCOUNT },
      { scope: "office", engine: "codex", account: OFFICE_ACCOUNT },
    ],
  });
  await pick(view, "Lena");
  const lena = card(view, "personal");
  for (const provider of ["claude", "codex"])
    expect(
      lena.querySelector(`[data-member-provider="${provider}"]`)!.textContent,
    ).not.toContain("@");
});

it("shows the member's connectors and Claude-set MCP servers on MCP servers, not the owner's", async () => {
  const view = await open();
  await tab(view, "mcp");
  await pick(view, "Stephen");
  const theirs = card(view, "personal");
  expect(count(theirs, '[data-claude-connector="Stephen Drive"]')).toBe(1);
  expect(
    theirs.querySelector('[data-claude-connectors="personal"]')!.textContent,
  ).toContain(MEMBER_CLAUDE);
  expect(count(theirs, '[data-engine-mcp="stephen-local"]')).toBe(1);
  // A server in a project folder of the member's agents has no sign-in; the
  // owner sees it only here.
  expect(count(theirs, '[data-engine-mcp="stephen-project"]')).toBe(1);
  // The office sign-in's connectors stay on the office card.
  expect(count(theirs, '[data-claude-connector="Office Slack"]')).toBe(0);
  for (const own of ["Ricky Gmail"])
    expect(count(view.container, `[data-claude-connector="${own}"]`)).toBe(0);
  for (const own of ["ricky-local", "ricky-project"])
    expect(count(theirs, `[data-engine-mcp="${own}"]`)).toBe(0);
  expect(theirs.textContent).not.toContain(OWNER_ACCOUNT);
});

it("shows none of the owner's own lists under the member while the member's list loads", async () => {
  const release = fake.hold("/api/users/Stephen/connections");
  const view = await open();
  await tab(view, "mcp");
  await pick(view, "Stephen");
  const loading = card(view, "personal");
  // The read is under way, so the empty card is the wait, not an answer.
  expect(
    fake.requests("GET", "/api/users/Stephen/connections").length,
  ).toBeGreaterThan(0);
  expect(count(loading, "[data-claude-connector]")).toBe(0);
  expect(count(loading, "[data-engine-mcp]")).toBe(0);
  expect(loading.textContent).not.toContain(OWNER_ACCOUNT);
  await act(async () => release());
  const loaded = card(view, "personal");
  expect(count(loaded, '[data-claude-connector="Stephen Drive"]')).toBe(1);
  expect(count(loaded, '[data-engine-mcp="stephen-local"]')).toBe(1);
});

it("says so on the member's MCP servers card when their list cannot be read", async () => {
  const shim = fake.handle.bind(fake);
  setApiShim(async (method, path, body) => {
    if (path === "/api/users/Stephen/connections")
      throw new ApiError(500, "internal", "x");
    return shim(method, path, body);
  });
  const view = await open();
  await tab(view, "mcp");
  await pick(view, "Stephen");
  // An empty card would read as "no connectors": the failure is said, as it
  // is for the caller's own list, and the owner's own items stay off it.
  expect(count(view.container, "[data-connections-failed]")).toBe(1);
  expect(count(card(view, "personal"), "[data-claude-connector]")).toBe(0);
  // A member whose list reads clears it.
  await pick(view, "Lena");
  expect(count(view.container, "[data-connections-failed]")).toBe(0);
});
