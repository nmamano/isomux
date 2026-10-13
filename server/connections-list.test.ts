import { describe, expect, it } from "bun:test";
import {
  buildConnectionsList,
  type ConnectionsListSources,
} from "./connections-list.ts";
import type { ProviderAccountWire } from "../shared/types.ts";

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
    accounts: async () => [
      account("codex", "office", true, "team@example.com"),
      account("codex", "personal", false),
      account("claude", "office", true, "boss@example.com"),
      account("claude", "personal", true),
    ],
    claudeConnectorDir: (scope) => `/claude/${scope}`,
    claudeConnectorsFor: (dir) =>
      dir === "/claude/office" ? { names: ["Gmail"], seenAt: 10 } : null,
    mcpServers: () => [],
    engineMcpServers: () => [],
    ...overrides,
  };
}

describe("buildConnectionsList", () => {
  it("lists variable names, connected sign-ins and each Claude sign-in's connectors", async () => {
    expect(await buildConnectionsList(sources())).toEqual({
      variables: [
        { scope: "office", name: "OFFICE_A" },
        { scope: "office", name: "OFFICE_B" },
        { scope: "personal", name: "MINE" },
      ],
      signIns: [
        { scope: "office", engine: "codex", account: "team@example.com" },
        { scope: "office", engine: "claude", account: "boss@example.com" },
        { scope: "personal", engine: "claude", account: null },
      ],
      claudeConnectors: [
        { scope: "office", seenAt: 10, names: ["Gmail"] },
        // Connected, but no Claude turn seen since the server started.
        { scope: "personal", seenAt: null, names: [] },
      ],
      mcpServers: [],
      engineMcpServers: [],
    });
  });

  it("gives a member no office variable names and never reads them", async () => {
    let officeRead = false;
    const list = await buildConnectionsList(
      sources({
        officeOwner: false,
        officeVariableNames: () => {
          officeRead = true;
          return ["OFFICE_A"];
        },
      }),
    );
    expect(list.variables).toEqual([{ scope: "personal", name: "MINE" }]);
    expect(officeRead).toBe(false);
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
});
