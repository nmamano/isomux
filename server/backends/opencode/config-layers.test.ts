import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  openCodeConfigOverride,
  openCodeMcpServerConfig,
  openCodeUserConfigDir,
} from "./config-layers.ts";
import {
  OPENCODE_CRON_AGENT,
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  openCodeAgentRules,
  openCodeDefaultConfig,
} from "./supervisor.ts";

describe("openCodeUserConfigDir", () => {
  it("uses the member's absolute OPENCODE_CONFIG_DIR", () => {
    expect(
      openCodeUserConfigDir({
        OPENCODE_CONFIG_DIR: "/srv/member/opencode",
        XDG_CONFIG_HOME: "/srv/xdg",
      }),
    ).toBe("/srv/member/opencode");
  });

  it("falls back to the OS user's XDG config directory", () => {
    expect(openCodeUserConfigDir({ XDG_CONFIG_HOME: "/srv/xdg" })).toBe(
      "/srv/xdg/opencode",
    );
    expect(openCodeUserConfigDir({})).toBe(
      join(homedir(), ".config", "opencode"),
    );
  });

  it("ignores relative directories, as Isomux expands no paths", () => {
    expect(
      openCodeUserConfigDir({
        OPENCODE_CONFIG_DIR: "~/opencode",
        XDG_CONFIG_HOME: "xdg",
      }),
    ).toBe(join(homedir(), ".config", "opencode"));
  });
});

// Task 4b354a81, gate C1: Isomux's config in the 2.1.4 keys. The rules follow
// evidence/2.1.4/pm-p1-expected.json, plus the ask for paths outside the
// folder that a key-for-key rename loses.
const rule = (action: string, effect: "ask" | "allow" | "deny") => ({
  action,
  resource: "*",
  effect,
});
const BASE = [
  rule("shell", "ask"),
  rule("edit", "ask"),
  rule("question", "deny"),
  rule("external_directory", "ask"),
];
// 2.1.4 takes the last matching rule; no action repeats here, so the order
// of the list is free.
const byAction = (rules: { action: string }[]) =>
  [...rules].sort((left, right) => left.action.localeCompare(right.action));
const AGENTS = [
  "build",
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  OPENCODE_CRON_AGENT,
];

describe("Isomux's OpenCode 2 config (C1)", () => {
  it("gives each agent Isomux runs its full rule list", () => {
    expect(byAction(openCodeAgentRules("build"))).toEqual(byAction(BASE));
    expect(
      byAction(openCodeAgentRules(OPENCODE_INTERACTIVE_BYPASS_AGENT)),
    ).toEqual(byAction([...BASE, rule("subagent", "allow")]));
    // MUTANT: an unattended run that may start subagents.
    expect(byAction(openCodeAgentRules(OPENCODE_CRON_AGENT))).toEqual(
      byAction([...BASE, rule("subagent", "deny")]),
    );
  });

  it("repeats each agent's rules in its block, in the 2.1.4 keys only", () => {
    const config = openCodeDefaultConfig() as Record<string, unknown> & {
      agents: Record<string, Record<string, unknown>>;
    };
    expect(config.update).toBe("disable");
    expect(config.default_agent).toBe("build");
    expect(config.permissions).toEqual(openCodeAgentRules("build"));
    expect(Object.keys(config.agents).sort()).toEqual([...AGENTS].sort());
    for (const agent of AGENTS)
      expect(config.agents[agent].permissions, agent).toEqual(
        openCodeAgentRules(agent),
      );
    for (const agent of [
      OPENCODE_INTERACTIVE_BYPASS_AGENT,
      OPENCODE_CRON_AGENT,
    ])
      expect(config.agents[agent].mode, agent).toBe("primary");
    // MUTANT: a 1.18.35 key left over, which 2.1.4 ignores or refuses.
    for (const key of [
      "permission",
      "agent",
      "autoupdate",
      "plugin",
      "provider",
      "mcp",
    ])
      expect(Object.hasOwn(config, key), key).toBe(false);
    const text = JSON.stringify(config);
    for (const name of [
      "bash",
      "task",
      "write",
      "patch",
      "isomux_safety_active",
    ])
      expect(text, name).not.toContain(`"${name}"`);
  });

  const docs = {
    name: "isomux-docs",
    url: "https://docs.example.com/mcp",
    headers: { authorization: "Bearer fake-header-value" },
  };

  it("gives an Isomux MCP server to OpenCode in the 2.1.4 shape, as direct tools", () => {
    // codemode false: the tools keep their names in tool events and
    // permission asks (core/src/tool.ts:236-237 puts the rest behind
    // "execute"). 2.1.4 has `disabled`, not `enabled`.
    expect(openCodeMcpServerConfig(docs)).toEqual({
      type: "remote",
      url: docs.url,
      headers: docs.headers,
      oauth: false,
      codemode: false,
    });
  });

  it("keeps MCP servers out of both config layers, and loads the safety plugin last", () => {
    // 2.1.4 takes each MCP server whole from the last layer that names it
    // (config/plugin/mcp.ts:46-50), so headers in a lower layer are lost;
    // the transport adds the servers at run time instead.
    const config = { ...openCodeDefaultConfig(), plugins: ["member-plugin"] };
    expect(Object.hasOwn(openCodeDefaultConfig(), "mcp")).toBe(false);
    const top = openCodeConfigOverride(config, "/profile/isomux-safety-plugin");
    expect(top.plugins).toEqual([
      "member-plugin",
      "/profile/isomux-safety-plugin",
    ]);
    expect(Object.hasOwn(top, "plugin")).toBe(false);
    const { plugins: _plugins, ...rest } = top;
    const { plugins: _given, ...expected } = config;
    expect(rest).toEqual(expected);
  });
});
