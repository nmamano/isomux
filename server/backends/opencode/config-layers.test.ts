import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import {
  OPENCODE_PLACEHOLDER_KEYS_ENV,
  OPENCODE_V2_DATABASE,
  openCodeConfigOverride,
  openCodeMcpServerConfig,
  openCodeServerTmpDir,
  openCodeShellProfileValues,
  openCodeShellUserValues,
  openCodeUserConfigDir,
} from "./config-layers.ts";
import {
  OPENCODE_CRON_AGENT,
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  openCodeAgentRules,
  openCodeDefaultConfig,
} from "./supervisor.ts";
import { OPENCODE_STOP_AGENTS, openCodeStopAgentRules } from "./stop-rules.ts";
import type { AgentAccess } from "../../../shared/agent-access.ts";

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

// Task 956b994b: the seven variables a shell takes from the agents' OS user.
describe("the shell variables the agents' OS user gives back", () => {
  it("maps each profile folder, and names the database copy for OPENCODE_DB", () => {
    const profileDir = "/state/opencode/profiles/k";
    const env = { TMPDIR: "/srv/os-tmp" };
    expect(openCodeShellProfileValues(profileDir, env)).toEqual({
      HOME: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "config"),
      XDG_DATA_HOME: join(profileDir, "data"),
      XDG_STATE_HOME: join(profileDir, "state"),
      XDG_CACHE_HOME: join(profileDir, "cache"),
      // Task 3811ffe2: the server's temp folder, outside the profile.
      TMPDIR: openCodeServerTmpDir(profileDir, env),
      OPENCODE_DB: OPENCODE_V2_DATABASE,
    });
  });

  it("takes each value from the env; an empty or missing one counts as none", () => {
    const values = openCodeShellUserValues({
      HOME: "/users-home",
      XDG_CONFIG_HOME: "",
      XDG_DATA_HOME: "/users-xdg-data",
    });
    expect(values.HOME).toBe("/users-home");
    expect(values.XDG_CONFIG_HOME).toBeNull();
    expect(values.XDG_DATA_HOME).toBe("/users-xdg-data");
    expect(values.XDG_STATE_HOME).toBeNull();
    expect(values.XDG_CACHE_HOME).toBeNull();
    expect(values.TMPDIR).toBeNull();
  });

  it("never takes OPENCODE_DB from the env: a shell opens no database copy", () => {
    expect(
      openCodeShellUserValues({ OPENCODE_DB: "/users/other.db" }).OPENCODE_DB,
    ).toBeNull();
  });
});

// Task 3811ffe2 (GitHub issue 65): OpenCode tells its agents to use
// <server TMPDIR>/opencode, and the safety policy denies every write under the
// state root. So the server's TMPDIR is one folder per profile directly in the
// OS temp folder.
describe("the OpenCode server's temp folder", () => {
  const profile = (root: string) => join(root, "opencode", "profiles", "k");

  it("is a folder directly in the env's TMPDIR, outside the state root and the profile", () => {
    for (const tmp of ["/srv/os-tmp", "/srv/os-tmp/"]) {
      const folder = openCodeServerTmpDir(profile(STATE_ROOT), { TMPDIR: tmp });
      expect(dirname(folder), tmp).toBe("/srv/os-tmp");
      expect(folder.startsWith(STATE_ROOT + "/"), tmp).toBe(false);
    }
  });

  it("is /tmp's when TMPDIR is missing, empty or not an absolute path", () => {
    // MUTANT: a relative TMPDIR kept, which resolves from the server's cwd.
    for (const TMPDIR of [undefined, "", "  ", "tmp", "~/tmp"])
      expect(
        dirname(openCodeServerTmpDir(profile(STATE_ROOT), { TMPDIR })),
        String(TMPDIR),
      ).toBe("/tmp");
  });

  it("is the same for one profile at every start, and differs between profiles", () => {
    const env = { TMPDIR: "/srv/os-tmp" };
    const one = openCodeServerTmpDir(profile("/a/.isomux"), env);
    // The plugin build and the server env compute it apart (start-server.ts).
    expect(openCodeServerTmpDir(profile("/a/.isomux"), { ...env })).toBe(one);
    // Another member's profile, and a second office's profile of the same
    // name on this computer.
    // MUTANT: a name from the profile folder's last segment only.
    const others = [
      openCodeServerTmpDir(
        join("/a/.isomux", "opencode", "profiles", "j"),
        env,
      ),
      openCodeServerTmpDir(profile("/b/.isomux"), env),
    ];
    for (const other of others) expect(other).not.toBe(one);
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
  // MUTANT: OpenCode's own schedules start turns Isomux does not show.
  rule("opencode_schedule_create", "deny"),
  rule("opencode_schedule_resume", "deny"),
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
    // The stop agents below Standard (merge C2): a session is created as
    // one, so the server must know it.
    const stops = Object.entries(OPENCODE_STOP_AGENTS);
    expect(Object.keys(config.agents).sort()).toEqual(
      [...AGENTS, ...stops.map(([, agent]) => agent)].sort(),
    );
    for (const agent of AGENTS)
      expect(config.agents[agent].permissions, agent).toEqual(
        openCodeAgentRules(agent),
      );
    for (const [stop, agent] of stops) {
      expect(config.agents[agent].permissions, agent).toEqual(
        openCodeStopAgentRules(stop as AgentAccess),
      );
      expect(config.agents[agent].mode, agent).toBe("primary");
    }
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
    const top = openCodeConfigOverride(
      config,
      "/profile/isomux-safety-plugin",
      {},
    );
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

// Task 82639464: OpenCode 2.2.5 reads the google key from GOOGLE_API_KEY
// first, so a Maps key or a secret placeholder under that name breaks Gemini
// for a member who set GEMINI_API_KEY. The live proof that 2.2.5 follows the
// list is in supervisor.test.ts.
describe("openCodeConfigOverride: the google key order", () => {
  const plugin = "/profile/isomux-safety-plugin";
  const geminiFirst = [
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const googleEnv = (top: Record<string, unknown>) =>
    (top.providers as { google?: { env?: unknown } } | undefined)?.google?.env;

  it("puts the Gemini names first when GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY has a value", () => {
    for (const name of ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
      const top = openCodeConfigOverride(openCodeDefaultConfig(), plugin, {
        [name]: "fake-gemini-value",
        GOOGLE_API_KEY: "fake-maps-value",
      });
      expect(googleEnv(top), name).toEqual(geminiFirst);
    }
  });

  it("adds no provider without a Gemini key: none, only GOOGLE_API_KEY, or a blank one", () => {
    // With the list and no key, OpenCode lists google models that cannot
    // run. A blank GEMINI_API_KEY first would beat a working GOOGLE_API_KEY.
    for (const env of [
      {},
      { GOOGLE_API_KEY: "fake-google-value" },
      { GEMINI_API_KEY: "", GOOGLE_API_KEY: "fake-google-value" },
      {
        GEMINI_API_KEY: "  ",
        GOOGLE_GENERATIVE_AI_API_KEY: "\n",
        GOOGLE_API_KEY: "fake-google-value",
      },
    ]) {
      const top = openCodeConfigOverride(openCodeDefaultConfig(), plugin, env);
      expect(Object.hasOwn(top, "providers"), Object.keys(env).join()).toBe(
        false,
      );
    }
  });

  it("keeps the other providers and the other google settings, and leaves the given config as it was", () => {
    const config = {
      ...openCodeDefaultConfig(),
      providers: {
        gate: { name: "Gate", env: [] },
        google: { settings: { baseURL: "http://127.0.0.1:1/v1beta" } },
      },
    };
    const before = structuredClone(config);
    const top = openCodeConfigOverride(config, plugin, {
      GEMINI_API_KEY: "fake-gemini-value",
    });
    expect(top.providers).toEqual({
      gate: { name: "Gate", env: [] },
      google: {
        settings: { baseURL: "http://127.0.0.1:1/v1beta" },
        env: geminiFirst,
      },
    });
    expect(config).toEqual(before);
    // Without a Gemini key, the given providers pass through as they are.
    expect(openCodeConfigOverride(config, plugin, {}).providers).toEqual(
      before.providers,
    );
  });
});

// Task d0e4679b: a GOOGLE_API_KEY secret's placeholder never reaches Google's
// model hosts. With no Gemini name set, OpenCode would list google models
// that fail every turn, so the top layer disables the provider. The live
// proof that 2.2.5 hides them is in supervisor.test.ts.
describe("openCodeConfigOverride: google behind a GOOGLE_API_KEY secret", () => {
  const plugin = "/profile/isomux-safety-plugin";
  const placeholderKeys = JSON.stringify(["GOOGLE_API_KEY"]);
  const disabled = (top: Record<string, unknown>): unknown[] =>
    Array.isArray(top.disabled_providers) ? top.disabled_providers : [];
  const googleOff = (top: Record<string, unknown>) =>
    disabled(top).includes("google");

  it("disables google when GOOGLE_API_KEY is a placeholder and no Gemini name has a value", () => {
    for (const env of [
      { GOOGLE_API_KEY: "fake-placeholder" },
      {
        GOOGLE_API_KEY: "fake-placeholder",
        GEMINI_API_KEY: " ",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
      },
    ]) {
      const top = openCodeConfigOverride(openCodeDefaultConfig(), plugin, {
        ...env,
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: placeholderKeys,
      });
      expect(googleOff(top), Object.keys(env).join()).toBe(true);
    }
  });

  it("keeps the config's own disabled providers, with google once, and leaves the given config as it was", () => {
    const env = {
      GOOGLE_API_KEY: "fake-placeholder",
      [OPENCODE_PLACEHOLDER_KEYS_ENV]: placeholderKeys,
    };
    const config = {
      ...openCodeDefaultConfig(),
      disabled_providers: ["fake-provider"],
    };
    const before = structuredClone(config);
    expect(
      [...disabled(openCodeConfigOverride(config, plugin, env))].sort(),
    ).toEqual(["fake-provider", "google"]);
    expect(config).toEqual(before);
    const already = {
      ...openCodeDefaultConfig(),
      disabled_providers: ["google"],
    };
    expect(disabled(openCodeConfigOverride(already, plugin, env))).toEqual([
      "google",
    ]);
  });

  it("leaves google on with a Gemini key, with no placeholder list, or with one that names another key", () => {
    const cases: Record<string, string>[] = [
      {
        GOOGLE_API_KEY: "fake-placeholder",
        GEMINI_API_KEY: "fake-gemini-value",
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: placeholderKeys,
      },
      {
        GOOGLE_API_KEY: "fake-placeholder",
        GOOGLE_GENERATIVE_AI_API_KEY: "fake-gemini-value",
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: placeholderKeys,
      },
      { GOOGLE_API_KEY: "fake-google-value" },
      {
        GOOGLE_API_KEY: "fake-google-value",
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: JSON.stringify(["OTHER_API_KEY"]),
      },
      {
        GOOGLE_API_KEY: "fake-google-value",
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: "[]",
      },
    ];
    for (const env of cases) {
      const top = openCodeConfigOverride(openCodeDefaultConfig(), plugin, env);
      expect(googleOff(top), JSON.stringify(env)).toBe(false);
    }
  });

  it("does not throw on a malformed placeholder list, and leaves google on", () => {
    for (const value of ["not json", "{}", '"GOOGLE_API_KEY"', "[1]", "null"]) {
      const top = openCodeConfigOverride(openCodeDefaultConfig(), plugin, {
        GOOGLE_API_KEY: "fake-google-value",
        [OPENCODE_PLACEHOLDER_KEYS_ENV]: value,
      });
      expect(googleOff(top), value).toBe(false);
    }
  });
});
