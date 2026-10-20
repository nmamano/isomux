import { describe, expect, it } from "bun:test";
import {
  buildConnectionsList,
  type ConnectionsListSources,
} from "./connections-list.ts";
import type { ProviderAccountWire } from "../shared/types.ts";
import type { SecretWire } from "../shared/contract-shapes.ts";

function account(
  provider: "claude" | "codex",
  scope: "office" | "personal",
  connected: boolean,
  accountLabel?: string,
): ProviderAccountWire {
  return {
    provider,
    scope,
    accountStatus: connected ? "connected" : "not_connected",
    loginStatus: "idle",
    canBrowserLogin: true,
    ...(accountLabel ? { accountLabel } : {}),
  };
}

function sources(
  overrides: Partial<ConnectionsListSources> = {},
): ConnectionsListSources {
  return {
    officeOwner: true,
    officeVariableNames: () => ["OFFICE_B", "OFFICE_A"],
    personalVariableNames: () => ["MINE"],
    officeVariableNotes: () => ({}),
    personalVariableNotes: () => ({}),
    accounts: async () => [
      account("codex", "office", true, "team@example.com"),
      account("codex", "personal", false),
      account("claude", "office", true, "boss@example.com"),
      account("claude", "personal", true),
    ],
    claudeConnectorDir: (scope) => `/claude/${scope}`,
    claudeConnectorsFor: (dir) =>
      dir === "/claude/office" ? { names: ["Gmail"], seenAt: 10 } : null,
    claudeConnectorStatusesFor: (dir) =>
      dir === "/claude/office" ? [{ name: "Gmail", status: "connected" }] : [],
    mcpServers: () => [],
    engineMcpServers: () => [],
    secrets: () => [],
    ...overrides,
  };
}

describe("buildConnectionsList", () => {
  it("lists variable names, connected sign-ins and each Claude sign-in's connectors", async () => {
    expect(await buildConnectionsList(sources())).toEqual({
      variables: [
        { scope: "office", name: "OFFICE_A", note: null },
        { scope: "office", name: "OFFICE_B", note: null },
        { scope: "personal", name: "MINE", note: null },
      ],
      signIns: [
        { scope: "office", engine: "codex", account: "team@example.com" },
        { scope: "office", engine: "claude", account: "boss@example.com" },
        { scope: "personal", engine: "claude", account: null },
      ],
      claudeConnectors: [
        {
          scope: "office",
          seenAt: 10,
          names: ["Gmail"],
          statuses: [{ name: "Gmail", status: "connected" }],
        },
        // Connected, but no Claude turn seen since the server started.
        { scope: "personal", seenAt: null, names: [], statuses: [] },
      ],
      mcpServers: [],
      engineMcpServers: [],
      secrets: [],
    });
  });

  it("passes on tool counts and the sign-in of a server set in Claude", async () => {
    const list = await buildConnectionsList(
      sources({
        claudeConnectorStatusesFor: () => [
          { name: "Gmail", status: "connected", tools: 12 },
        ],
        engineMcpServers: () => [
          {
            engine: "claude",
            name: "linear",
            source: "user",
            folder: null,
            signIn: "office",
            status: "connected",
            tools: 7,
          },
        ],
      }),
    );
    expect(list.claudeConnectors[0]?.statuses).toEqual([
      { name: "Gmail", status: "connected", tools: 12 },
    ]);
    expect(list.engineMcpServers).toEqual([
      expect.objectContaining({ signIn: "office", tools: 7 }),
    ]);
  });

  // Nil, ruling 2 (2026-10-13): members see the office items' names.
  it("gives a member the office variable names", async () => {
    const list = await buildConnectionsList(
      sources({ officeOwner: false, officeVariableNames: () => ["OFFICE_A"] }),
    );
    expect(list.variables).toEqual([
      { scope: "office", name: "OFFICE_A", note: null },
      { scope: "personal", name: "MINE", note: null },
    ]);
    // The office sign-in and its connectors are already visible to members.
    expect(list.signIns.some((signIn) => signIn.scope === "office")).toBe(true);
    expect(list.claudeConnectors[0]).toMatchObject({ scope: "office" });
  });

  it("lists no connectors for a Claude sign-in that is not connected or has no claude.ai login", async () => {
    const list = await buildConnectionsList(
      sources({
        accounts: async () => [
          account("claude", "office", true),
          account("claude", "personal", false),
        ],
        // The office runs on Bedrock or Vertex.
        claudeConnectorDir: (scope) =>
          scope === "office" ? null : "/claude/personal",
        claudeConnectorsFor: () => ({ names: ["Gmail"], seenAt: 1 }),
      }),
    );
    expect(list.claudeConnectors).toEqual([]);
  });

  it("keeps the variables when the sign-in probe fails", async () => {
    const list = await buildConnectionsList(
      sources({
        accounts: async () => {
          throw new Error("probe failed");
        },
      }),
    );
    expect(list.variables).toHaveLength(3);
    expect(list.signIns).toEqual([]);
    expect(list.claudeConnectors).toEqual([]);
  });

  it("lists secrets by name and hosts, with the identity check a Test runs", async () => {
    const secret = (
      name: string,
      hosts: string[],
      form: SecretWire["form"] = { kind: "authorization" },
    ): SecretWire => ({
      name,
      hosts,
      form,
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
      note: null,
      apps: [],
    });
    const list = await buildConnectionsList(
      sources({
        secrets: (scope) =>
          scope === "office"
            ? [secret("STRIPE_API_KEY", ["api.stripe.com", "files.stripe.com"])]
            : [
                secret("GH_TOKEN", ["api.github.com", "github.com"]),
                secret("CUSTOM", ["api.example.com"]),
                // The identity check sends an Authorization header only.
                secret("GH_HEADER", ["api.github.com"], {
                  kind: "header",
                  header: "x-token",
                }),
                // The check's host is not on the list.
                secret("GH_WEB", ["github.com"]),
              ],
      }),
    );
    expect(list.secrets).toEqual([
      {
        scope: "office",
        name: "STRIPE_API_KEY",
        hosts: ["api.stripe.com", "files.stripe.com"],
        test: "stripe",
        note: null,
      },
      {
        scope: "personal",
        name: "GH_TOKEN",
        hosts: ["api.github.com", "github.com"],
        test: "github",
        note: null,
      },
      {
        scope: "personal",
        name: "CUSTOM",
        hosts: ["api.example.com"],
        test: null,
        note: null,
      },
      {
        scope: "personal",
        name: "GH_HEADER",
        hosts: ["api.github.com"],
        test: null,
        note: null,
      },
      {
        scope: "personal",
        name: "GH_WEB",
        hosts: ["github.com"],
        test: null,
        note: null,
      },
    ]);
    // Names and hosts only: no field carries more of the store's record.
    for (const row of list.secrets ?? [])
      expect(Object.keys(row).sort()).toEqual([
        "hosts",
        "name",
        "note",
        "scope",
        "test",
      ]);
  });

  it("puts each variable's and secret's usage note on its row", async () => {
    const secretWire = (note: string | null): SecretWire => ({
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
      note,
      apps: [],
    });
    const owner = await buildConnectionsList(
      sources({
        officeVariableNotes: () => ({ OFFICE_B: "office note" }),
        personalVariableNotes: () => ({ MINE: "my note" }),
        secrets: (scope) =>
          scope === "personal" ? [secretWire("secret note")] : [],
      }),
    );
    expect(owner.variables.map((v) => [v.name, v.note])).toEqual([
      ["OFFICE_A", null],
      ["OFFICE_B", "office note"],
      ["MINE", "my note"],
    ]);
    expect(owner.secrets?.[0]?.note).toBe("secret note");
    // A member reads the office variable notes too.
    const member = await buildConnectionsList(
      sources({
        officeOwner: false,
        officeVariableNotes: () => ({ OFFICE_B: "office note" }),
      }),
    );
    expect(member.variables.map((v) => [v.scope, v.name, v.note])).toEqual([
      ["office", "OFFICE_A", null],
      ["office", "OFFICE_B", "office note"],
      ["personal", "MINE", null],
    ]);
  });

  // A member's office rows carry test null: only an owner may run a test
  // on an office secret. Their own secrets keep their test.
  it("gives a member the office secrets, with no test", async () => {
    const github: SecretWire = {
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      createdAt: 1,
      valueSetAt: 1,
      updatedAt: 1,
      note: "office note",
      apps: [],
    };
    const build = (officeOwner: boolean) =>
      buildConnectionsList(sources({ officeOwner, secrets: () => [github] }));
    expect((await build(false)).secrets).toEqual([
      {
        scope: "office",
        name: "GH_TOKEN",
        hosts: ["api.github.com"],
        test: null,
        note: "office note",
      },
      {
        scope: "personal",
        name: "GH_TOKEN",
        hosts: ["api.github.com"],
        test: "github",
        note: "office note",
      },
    ]);
    expect((await build(true)).secrets?.map((s) => s.test)).toEqual([
      "github",
      "github",
    ]);
  });

  it("drops only the secrets of a store that cannot be read", async () => {
    const list = await buildConnectionsList(
      sources({
        secrets: () => {
          throw new Error("unreadable");
        },
      }),
    );
    expect(list.secrets).toEqual([]);
    expect(list.variables).toHaveLength(3);
  });
});
