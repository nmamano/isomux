import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  claudeAiConnectorNames,
  claudeConnectorGeneration,
  claudeConnectorsFor,
  clearClaudeConnectors,
  recordClaudeConnectors,
  recordClaudeConnectorsFromSession,
  resetClaudeConnectorsForTests,
} from "./claude-connectors.ts";
import { ProviderAccountManager } from "./provider-account-manager.ts";

afterEach(() => resetClaudeConnectorsForTests());

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
