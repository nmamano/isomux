import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  claudeAiConnectorNames,
  claudeConnectorGeneration,
  claudeConnectorStatusesFor,
  claudeConnectorsFor,
  claudeEngineServersFor,
  clearClaudeConnectors,
  recordClaudeConnectors,
  recordClaudeConnectorsFromSession,
  recordClaudeEngineServers,
  resetClaudeConnectorsForTests,
  resetClaudeEngineServersForTests,
} from "./claude-connectors.ts";
import { ProviderAccountManager } from "./provider-account-manager.ts";

afterEach(() => {
  resetClaudeConnectorsForTests();
  resetClaudeEngineServersForTests();
});

const gmail = {
  name: "claude.ai Gmail",
  status: "pending",
  source: "claudeai",
};
const drive = {
  name: "claude.ai Google Drive",
  status: "connected",
  source: "claudeai",
};

describe("claudeAiConnectorNames", () => {
  it("keeps claude.ai connectors by source and drops the name prefix", () => {
    expect(claudeAiConnectorNames([drive, gmail])).toEqual([
      "Gmail",
      "Google Drive",
    ]);
  });

  it("trusts the source, not the name", () => {
    expect(
      claudeAiConnectorNames([
        // A server the member configured can carry any name.
        { name: "claude.ai Lookalike", status: "connected", source: "user" },
        { name: "claude.ai Unsourced", status: "connected" },
        { name: "isomux", status: "connected", source: "sdk" },
      ]),
    ).toEqual([]);
  });

  it("drops a connector that is turned off", () => {
    expect(
      claudeAiConnectorNames([
        gmail,
        { name: "claude.ai Calendar", status: "disabled", source: "claudeai" },
      ]),
    ).toEqual(["Gmail"]);
  });
});

describe("recordClaudeConnectorsFromSession", () => {
  const launch = {
    agentType: "claude",
    launchedClaudeConfigDir: "/tmp/connectors-office",
    launchedClaudeCloud: false,
  };

  it("records the names against the launched sign-in, with the time seen", () => {
    expect(
      recordClaudeConnectorsFromSession(
        launch,
        { mcpServers: [gmail], apiKeySource: "none", from: "init" },
        1234,
      ),
    ).toBe(true);
    expect(claudeConnectorsFor("/tmp/connectors-office/")).toEqual({
      names: ["Gmail"],
      seenAt: 1234,
    });
  });

  it("records a sign-in that really has none as an empty list, not as unseen", () => {
    recordClaudeConnectorsFromSession(
      launch,
      { mcpServers: [], apiKeySource: "none", from: "status" },
      5,
    );
    expect(claudeConnectorsFor(launch.launchedClaudeConfigDir)).toEqual({
      names: [],
      seenAt: 5,
    });
  });

  it("lets an init that has no claude.ai servers yet leave the record as it was", () => {
    // The connector fetch can still be running when a turn's init is sent.
    const early = {
      mcpServers: [],
      apiKeySource: "none",
      from: "init" as const,
    };
    expect(recordClaudeConnectorsFromSession(launch, early, 1)).toBe(false);
    expect(claudeConnectorsFor(launch.launchedClaudeConfigDir)).toBeNull();
    recordClaudeConnectors(launch.launchedClaudeConfigDir, [gmail], 2);
    expect(recordClaudeConnectorsFromSession(launch, early, 3)).toBe(false);
    expect(claudeConnectorsFor(launch.launchedClaudeConfigDir)).toEqual({
      names: ["Gmail"],
      seenAt: 2,
    });
  });

  it("never lets a cloud or API-key session overwrite a real list", () => {
    recordClaudeConnectors(launch.launchedClaudeConfigDir, [gmail], 1);
    const empty = { mcpServers: [], from: "status" as const };
    expect(
      recordClaudeConnectorsFromSession(
        { ...launch, launchedClaudeCloud: true },
        { ...empty, apiKeySource: "none" },
        2,
      ),
    ).toBe(false);
    expect(
      recordClaudeConnectorsFromSession(
        launch,
        { ...empty, apiKeySource: "ANTHROPIC_API_KEY" },
        3,
      ),
    ).toBe(false);
    expect(recordClaudeConnectorsFromSession(launch, empty, 4)).toBe(false);
    expect(
      recordClaudeConnectorsFromSession(
        { ...launch, agentType: "codex" },
        { ...empty, apiKeySource: "none" },
        5,
      ),
    ).toBe(false);
    expect(claudeConnectorsFor(launch.launchedClaudeConfigDir)).toEqual({
      names: ["Gmail"],
      seenAt: 1,
    });
  });
});

describe("ProviderAccountManager clears a sign-in's connectors", () => {
  it("on a completed Claude sign-in", async () => {
    let complete!: () => void;
    let clients = 0;
    const dir = "/tmp/connectors-homes/user-a/claude";
    const manager = new ProviderAccountManager(
      () => {},
      (() => ({
        start: async () => {},
        read: async () => ({ connected: false }),
        close: async () => {},
      })) as never,
      undefined,
      undefined,
      () => ({}),
      (() => {
        clients++;
        if (clients === 1)
          return {
            start: async () => {},
            login: async () => ({ authUrl: "https://claude.com/oauth/" }),
            waitForCompletion: () =>
              new Promise<void>((resolvePromise) => {
                complete = resolvePromise;
              }),
            read: async () => ({ connected: false }),
            close: async () => {},
          };
        return {
          start: async () => {},
          read: async () => ({ connected: true }),
          close: async () => {},
        };
      }) as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
      () => dir,
      () => dir,
      () => false,
      () => {},
    );
    recordClaudeConnectors(dir, [gmail], 1);
    await manager.startLogin("user-a", "claude", "personal", "browser");
    expect(claudeConnectorsFor(dir)).not.toBeNull();
    complete();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(claudeConnectorsFor(dir)).toBeNull();
  });

  it("on a Claude sign-out", async () => {
    const root = mkdtempSync("/tmp/connectors-disconnect-");
    const home = resolve(root, "user-a", "claude");
    mkdirSync(home, { recursive: true });
    writeFileSync(resolve(home, ".credentials.json"), "fixture");
    const disconnected = () => ({
      start: async () => {},
      read: async () => ({ connected: false }),
      close: async () => {},
    });
    const manager = new ProviderAccountManager(
      () => {},
      disconnected as never,
      undefined,
      undefined,
      () => ({}),
      disconnected as never,
      () => ({}),
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
      () => home,
      () => home,
      () => true,
      () => {},
      () => {},
    );
    recordClaudeConnectors(home, [gmail], 1);
    const result = await manager.disconnect("user-a", "claude", "personal");
    expect(result.ok).toBe(true);
    expect(claudeConnectorsFor(home)).toBeNull();
    rmSync(root, { recursive: true });
  });
});

describe("ProviderAccountManager.claudeConnectorDir", () => {
  const manager = (officeEnv: Record<string, string>) =>
    new ProviderAccountManager(
      () => {},
      undefined,
      undefined,
      undefined,
      () => ({}),
      undefined,
      () => officeEnv,
      () => ({}),
      () => ({}),
      () => [{ id: "user-a" }],
      () => "/tmp/connectors-homes/user-a/claude",
    );

  it("names the directory of each scope's Claude sign-in", () => {
    const accounts = manager({ CLAUDE_CONFIG_DIR: "/tmp/connectors-office" });
    expect(accounts.claudeConnectorDir("user-a", "office")).toBe(
      "/tmp/connectors-office",
    );
    expect(accounts.claudeConnectorDir("user-a", "personal")).toBe(
      "/tmp/connectors-homes/user-a/claude",
    );
  });

  it("has none for a sign-in on Bedrock or Vertex, which has no claude.ai login", () => {
    expect(
      manager({
        CLAUDE_CONFIG_DIR: "/tmp/connectors-office",
        CLAUDE_CODE_USE_BEDROCK: "1",
      }).claudeConnectorDir("user-a", "office"),
    ).toBeNull();
  });

  // Claude's own settings live in the directory on Bedrock or Vertex too.
  it("names the config directory of each scope, cloud or not", () => {
    const accounts = manager({
      CLAUDE_CONFIG_DIR: "/tmp/connectors-office",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(accounts.claudeConfigDir("user-a", "office")).toBe(
      "/tmp/connectors-office",
    );
    expect(accounts.claudeConfigDir("user-a", "personal")).toBe(
      "/tmp/connectors-homes/user-a/claude",
    );
  });
});

describe("a status read that started before a clear", () => {
  it("does not put the old account's names back", () => {
    const dir = "/tmp/connectors-generation";
    const launch = {
      agentType: "claude",
      launchedClaudeConfigDir: dir,
      launchedClaudeCloud: false,
    };
    const generation = claudeConnectorGeneration(dir);
    clearClaudeConnectors(dir);
    expect(
      recordClaudeConnectorsFromSession(launch, {
        mcpServers: [gmail],
        apiKeySource: "none",
        from: "status",
        generation,
      }),
    ).toBe(false);
    expect(claudeConnectorsFor(dir)).toBeNull();
    // A read that starts after the clear records as usual.
    expect(
      recordClaudeConnectorsFromSession(launch, {
        mcpServers: [gmail],
        apiKeySource: "none",
        from: "status",
        generation: claudeConnectorGeneration(dir),
      }),
    ).toBe(true);
  });
});

describe("MCP statuses (A3)", () => {
  const dir = "/tmp/connectors-status";
  const launch = {
    agentType: "claude",
    launchedClaudeConfigDir: dir,
    launchedClaudeCloud: false,
  };
  const report = (
    mcpServers: { name: string; status: string; source: string }[],
    from: "init" | "status",
  ) =>
    recordClaudeConnectorsFromSession(launch, {
      mcpServers,
      apiKeySource: "none",
      from,
    });

  it("keeps a connector's status from the status read only", () => {
    report([gmail, drive], "init");
    // The init's "pending" is not a status read.
    expect(claudeConnectorStatusesFor(dir)).toEqual([]);
    report(
      [
        { ...gmail, status: "failed" },
        { ...drive, status: "connected" },
      ],
      "status",
    );
    const read = [
      { name: "Gmail", status: "failed" as const },
      { name: "Google Drive", status: "connected" as const },
    ];
    expect(claudeConnectorStatusesFor(dir)).toEqual(read);
    // The next turn's init leaves the read statuses as they were.
    report([gmail, drive], "init");
    expect(claudeConnectorStatusesFor(dir)).toEqual(read);
    clearClaudeConnectors(dir);
    expect(claudeConnectorStatusesFor(dir)).toEqual([]);
  });

  it("keeps only the SDK's own status values", () => {
    report(
      [
        { ...gmail, status: "needs-auth" },
        { ...drive, status: "something-new" },
      ],
      "status",
    );
    expect(claudeConnectorStatusesFor(dir)).toEqual([
      { name: "Gmail", status: "needs-auth" },
    ]);
  });

  // A read right after a short turn can see "pending" for a connector an
  // earlier read saw connect (probe, 2026-10-13).
  describe("a pending read", () => {
    const connected = { ...gmail, status: "connected" };

    it("keeps a status an earlier read knew", () => {
      report([connected], "status");
      report([gmail], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "connected" },
      ]);
    });

    it("shows pending for a name with no earlier status", () => {
      report([connected], "status");
      report([connected, { ...drive, status: "pending" }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "connected" },
        { name: "Google Drive", status: "pending" },
      ]);
    });

    it("drops a name the read no longer lists", () => {
      report([connected, drive], "status");
      report([{ ...drive, status: "pending" }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Google Drive", status: "connected" },
      ]);
    });

    it("does not keep a status past a sign-in or sign-out", () => {
      report([connected], "status");
      clearClaudeConnectors(dir);
      report([gmail], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "pending" },
      ]);
    });

    it("leaves any other read status in place of a known one", () => {
      report([connected], "status");
      report([{ ...gmail, status: "failed" }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "failed" },
      ]);
      report([{ ...gmail, status: "needs-auth" }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "needs-auth" },
      ]);
    });
  });

  it("gives a server set in Claude its status from the status read, null before", () => {
    const user = { name: "linear", status: "pending", source: "user" };
    recordClaudeEngineServers("agent-1", "/work", [user], "init");
    expect(claudeEngineServersFor(["agent-1"])).toEqual([
      {
        engine: "claude",
        name: "linear",
        source: "user",
        folder: null,
        signIn: null,
        status: null,
      },
    ]);
    recordClaudeEngineServers(
      "agent-1",
      "/work",
      [{ ...user, status: "failed" }],
      "status",
    );
    recordClaudeEngineServers("agent-1", "/work", [user], "init");
    expect(claudeEngineServersFor(["agent-1"])[0]?.status).toBe("failed");
    recordClaudeEngineServers(
      "agent-1",
      "/work",
      [{ ...user, status: "bogus" }],
      "status",
    );
    expect(claudeEngineServersFor(["agent-1"])[0]?.status).toBeNull();
  });

  describe("tool counts", () => {
    const connected = { ...gmail, status: "connected", tools: 12 };
    const reportTools = (
      mcpServers: {
        name: string;
        status: string;
        source: string;
        tools?: number;
      }[],
      from: "init" | "status",
    ) =>
      recordClaudeConnectorsFromSession(launch, {
        mcpServers,
        apiKeySource: "none",
        from,
      });

    it("keeps a connector's tool count from a status read", () => {
      reportTools([connected, { ...drive, tools: 1.5 }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "connected", tools: 12 },
        { name: "Google Drive", status: "connected" },
      ]);
    });

    it("keeps the count past a pending read", () => {
      reportTools([connected], "status");
      reportTools([{ ...gmail, status: "pending" }], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "connected", tools: 12 },
      ]);
    });

    it("keeps the count past an init report", () => {
      reportTools([connected], "status");
      reportTools([gmail], "init");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "connected", tools: 12 },
      ]);
    });

    it("loses the count with a sign-in or sign-out", () => {
      reportTools([connected], "status");
      clearClaudeConnectors(dir);
      reportTools([gmail], "status");
      expect(claudeConnectorStatusesFor(dir)).toEqual([
        { name: "Gmail", status: "pending" },
      ]);
    });

    const linear = { name: "linear", source: "user" };

    it("keeps a server set in Claude its count from a status read", () => {
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "connected", tools: 7 }],
        "status",
      );
      expect(claudeEngineServersFor(["agent-1"])[0]?.tools).toBe(7);
    });

    it("keeps a server's count past an init report and a pending read", () => {
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "connected", tools: 7 }],
        "status",
      );
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "pending" }],
        "init",
      );
      expect(claudeEngineServersFor(["agent-1"])[0]).toMatchObject({
        status: "connected",
        tools: 7,
      });
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "pending" }],
        "status",
      );
      expect(claudeEngineServersFor(["agent-1"])[0]).toMatchObject({
        status: "connected",
        tools: 7,
      });
    });

    it("drops the count when a read says failed", () => {
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "connected", tools: 7 }],
        "status",
      );
      recordClaudeEngineServers(
        "agent-1",
        "/work",
        [{ ...linear, status: "failed" }],
        "status",
      );
      expect(claudeEngineServersFor(["agent-1"])[0]).toEqual(
        expect.not.objectContaining({ tools: 7 }),
      );
    });
  });

  it("prefers a read status when two agents report one server", () => {
    const user = { name: "linear", status: "connected", source: "user" };
    recordClaudeEngineServers("agent-1", "/a", [user], "status");
    recordClaudeEngineServers("agent-2", "/b", [user], "init");
    expect(
      claudeEngineServersFor(["agent-1", "agent-2"]).map((row) => row.status),
    ).toEqual(["connected"]);
    expect(
      claudeEngineServersFor(["agent-2", "agent-1"]).map((row) => row.status),
    ).toEqual(["connected"]);
  });
});

// User and local servers live in the Claude config directory of the sign-in
// the agent launched with; project servers belong to the folder (Lead,
// 2026-10-13).
describe("servers set in Claude, by sign-in", () => {
  const signInOf = (dir: string) =>
    dir === resolve("/cfg/office")
      ? ("office" as const)
      : dir === resolve("/cfg/personal")
        ? ("personal" as const)
        : null;
  const servers = [
    { name: "linear", status: "connected", source: "user" },
    { name: "notes", status: "connected", source: "local" },
    { name: "stripe", status: "connected", source: "project" },
  ];

  it("names the sign-in of a user or local server, none for a project one", () => {
    recordClaudeEngineServers(
      "agent-1",
      "/work",
      servers,
      "status",
      "/cfg/office",
    );
    expect(
      claudeEngineServersFor(["agent-1"], signInOf).map((row) => [
        row.name,
        row.folder,
        row.signIn,
      ]),
    ).toEqual([
      ["linear", null, "office"],
      ["notes", resolve("/work"), "office"],
      ["stripe", resolve("/work"), null],
    ]);
  });

  it("keeps one user server from two sign-ins as two rows", () => {
    const user = [servers[0]];
    recordClaudeEngineServers("agent-1", "/a", user, "status", "/cfg/office");
    recordClaudeEngineServers("agent-2", "/b", user, "status", "/cfg/personal");
    expect(
      claudeEngineServersFor(["agent-1", "agent-2"], signInOf).map(
        (row) => row.signIn,
      ),
    ).toEqual(["office", "personal"]);
  });

  it("names no sign-in for a directory neither sign-in uses now", () => {
    recordClaudeEngineServers(
      "agent-1",
      "/work",
      servers,
      "status",
      "/cfg/old",
    );
    recordClaudeEngineServers("agent-2", "/work", servers, "status");
    expect(
      claudeEngineServersFor(["agent-1", "agent-2"], signInOf).map(
        (row) => row.signIn,
      ),
    ).toEqual([null, null, null]);
  });
});
