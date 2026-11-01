// Codex at chat and office (task e77304b1): the thread config that turns
// every tool source off, the discovery readers that find the member's MCP
// servers and skills, the version gate, and the empty folder. The adapter
// tests drive these through a session; the live proof that the model then
// sees only request_user_input and apply_patch is
// server/backends/codex-access.live.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  CODEX_BELOW_STANDARD_CONFIG,
  CODEX_BELOW_STANDARD_PROVEN_VERSION,
  CODEX_EMPTY_CWD_ROOT,
  codexBelowStandardThreadConfig,
  codexConfigMcpServerNames,
  codexEmptyCwd,
  codexProjectLayerRefusal,
  codexRunsBelowStandard,
  codexSkillPaths,
  codexStopThreadConfig,
} from "./access.ts";
import { getCodexPinnedVersion } from "./native-bin.ts";
import { STATE_ROOT } from "../../config.ts";
import { effectiveCodexConfig } from "../../test-support/codex-config.ts";

// Every feature flag that adds a tool, a tool source or a way out, in Codex
// 0.164.0. Each one is set false, so a member config.toml that turns it on
// loses.
const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "goals",
  "multi_agent",
  "multi_agent_v2",
  "sleep_tool",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "memories",
  "request_permissions_tool",
  "code_mode",
  "code_mode_only",
  "standalone_web_search",
];

// The base config, read the way Codex reads it.
const BASE = {
  features: Object.fromEntries(FEATURES_OFF.map((key) => [key, false])),
  web_search: "disabled",
  project_doc_max_bytes: 0,
  skills: { include_instructions: false },
  memories: { use_memories: false, generate_memories: false },
};

describe("CODEX_BELOW_STANDARD_CONFIG", () => {
  it("sets exactly the agreed keys: every tool feature off, no web search, no project doc, no skill instructions, no memories", () => {
    // Exact: a key added later (a network switch, a skill root) is a change
    // to this contract, not a silent extra.
    expect(effectiveCodexConfig(CODEX_BELOW_STANDARD_CONFIG)).toEqual(BASE);
  });
});

describe("codexBelowStandardThreadConfig", () => {
  it("adds a disable for each discovered MCP server except the kept ones, and for each skill", () => {
    const config = codexBelowStandardThreadConfig(
      ["planted", "a.b", "isomux"],
      [
        "/home/m/.codex/skills/one/SKILL.md",
        "/home/m/.codex/skills/.system/imagegen/SKILL.md",
      ],
      ["isomux"],
    );
    expect(effectiveCodexConfig(config)).toEqual({
      ...BASE,
      // A name with a dot is one server: Codex refuses the thread when a
      // dotted key splits it (measured on 0.164.0).
      mcp_servers: { planted: { enabled: false }, "a.b": { enabled: false } },
      skills: {
        include_instructions: false,
        config: [
          { path: "/home/m/.codex/skills/one/SKILL.md", enabled: false },
          {
            path: "/home/m/.codex/skills/.system/imagegen/SKILL.md",
            enabled: false,
          },
        ],
      },
    });
  });

  it("with nothing discovered, is the base config; at chat nothing is kept", () => {
    expect(
      effectiveCodexConfig(codexBelowStandardThreadConfig([], [], [])),
    ).toEqual(BASE);
    expect(
      effectiveCodexConfig(codexBelowStandardThreadConfig(["isomux"], [], [])),
    ).toEqual({ ...BASE, mcp_servers: { isomux: { enabled: false } } });
  });
});

describe("codexConfigMcpServerNames", () => {
  it("reads the server names of a config/read result", () => {
    // The shape Codex 0.164.0 answers (one stdio, one remote, one dotted name).
    const result = {
      config: {
        model: null,
        mcp_servers: {
          remote: { url: "https://example.com/mcp", enabled: true },
          plain: { command: "/bin/true", args: [], enabled: true },
          "a.b": { command: "/bin/true", args: [], enabled: true },
        },
      },
      origins: {},
      layers: null,
    };
    expect(codexConfigMcpServerNames(result)?.sort()).toEqual([
      "a.b",
      "plain",
      "remote",
    ]);
    expect(
      codexConfigMcpServerNames({ config: { mcp_servers: {} }, origins: {} }),
    ).toEqual([]);
  });

  it("is null for a shape it cannot read, so the start is refused", () => {
    // Codex always sends mcp_servers (an empty table when there is none), so
    // a missing one is a shape this code does not know.
    const unreadable: unknown[] = [
      null,
      "config",
      {},
      { config: null },
      { config: {} },
      { config: { mcp_servers: null } },
      { config: { mcp_servers: [] } },
      { config: { mcp_servers: ["planted"] } },
      { config: { mcp_servers: "planted" } },
    ];
    for (const result of unreadable)
      expect({ result, names: codexConfigMcpServerNames(result) }).toEqual({
        result,
        names: null,
      });
  });
});

describe("codexSkillPaths", () => {
  const CWD = "/state/codex/no-folder/agent-1";
  const skill = (path: string, enabled = true) => ({
    name: path.split("/").at(-2),
    description: "d",
    path,
    scope: "user",
    enabled,
    pluginId: null,
  });

  it("reads every skill path of the entry for the cwd, system skills too, and ignores a skill Codex could not load", () => {
    const result = {
      data: [
        {
          cwd: "/elsewhere",
          skills: [skill("/elsewhere/.codex/skills/x/SKILL.md")],
          errors: [],
        },
        {
          cwd: CWD,
          skills: [
            skill("/home/m/.codex/skills/one/SKILL.md"),
            skill("/home/m/.codex/skills/.system/imagegen/SKILL.md"),
            skill("/home/m/.codex/skills/off/SKILL.md", false),
          ],
          errors: [
            {
              path: "/home/m/.codex/skills/broken/SKILL.md",
              message: "missing YAML frontmatter delimited by ---",
            },
          ],
        },
      ],
    };
    expect(codexSkillPaths(result, CWD)?.sort()).toEqual([
      "/home/m/.codex/skills/.system/imagegen/SKILL.md",
      "/home/m/.codex/skills/off/SKILL.md",
      "/home/m/.codex/skills/one/SKILL.md",
    ]);
    expect(
      codexSkillPaths({ data: [{ cwd: CWD, skills: [], errors: [] }] }, CWD),
    ).toEqual([]);
  });

  it("is null for a shape it cannot read or with no entry for the cwd", () => {
    const unreadable: unknown[] = [
      null,
      {},
      { data: null },
      { data: "x" },
      { data: [] },
      { data: [{ cwd: "/elsewhere", skills: [], errors: [] }] },
      { data: [{ cwd: CWD, skills: null, errors: [] }] },
      { data: [{ cwd: CWD, skills: [{ name: "x" }], errors: [] }] },
      { data: [{ cwd: CWD, skills: [{ path: 7 }], errors: [] }] },
    ];
    for (const result of unreadable)
      expect({ result, paths: codexSkillPaths(result, CWD) }).toEqual({
        result,
        paths: null,
      });
  });
});

describe("the Codex version gate", () => {
  // A Codex bump turns this red: the stops below Standard need a new probe
  // (codex-access.live.test.ts) before the proven version moves with it.
  it("the proven version is the pinned one, so this server runs every stop below Standard", () => {
    expect(CODEX_BELOW_STANDARD_PROVEN_VERSION).toBe(getCodexPinnedVersion());
    for (const access of ["chat", "office", "folder", "web"] as const)
      expect({ access, runs: codexRunsBelowStandard(access) }).toEqual({
        access,
        runs: true,
      });
  });
});

// Folder and web (task 25015e41): the thread runs in the agent's folder,
// workspace-write. Each sandbox key is set, so a member config.toml that
// widens it loses: no network, no writable root but the folder, no temp
// folder. Web adds Codex's hosted web search, which the sandbox does not
// govern.
describe("codexStopThreadConfig", () => {
  const SANDBOX = {
    network_access: false,
    writable_roots: [],
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true,
  };
  const at = (access: "chat" | "office" | "folder" | "web") =>
    effectiveCodexConfig({
      ...CODEX_BELOW_STANDARD_CONFIG,
      ...codexStopThreadConfig(access),
    });

  it("folder: the base, the closed workspace-write keys, no web search", () => {
    expect(at("folder")).toEqual({
      ...BASE,
      sandbox_workspace_write: SANDBOX,
    });
  });

  it("web: the same with Codex's live web search", () => {
    expect(at("web")).toEqual({
      ...BASE,
      web_search: "live",
      sandbox_workspace_write: SANDBOX,
    });
  });

  it("chat and office: the base alone", () => {
    expect(at("chat")).toEqual(BASE);
    expect(at("office")).toEqual(BASE);
  });
});

// A project layer is a .codex folder between the agent's folder and its
// repository root that Codex loads (a trusted project): its settings and
// hooks would reach a thread that loads no settings from disk. Codex lists
// an untrusted one with the reason it is off.
describe("codexProjectLayerRefusal", () => {
  const USER = {
    name: { type: "user", file: "/home/m/.codex/config.toml", profile: null },
    version: "1",
    config: {},
    disabledReason: null,
  };
  const SESSION = {
    name: { type: "sessionFlags" },
    version: "1",
    config: {},
    disabledReason: null,
  };
  const project = (disabledReason: string | null) => ({
    name: { type: "project", dotCodexFolder: "/srv/repo/.codex" },
    version: "1",
    config: { mcp_servers: { x: { command: "/bin/true" } } },
    disabledReason,
  });
  const read = (layers: unknown) => ({ config: {}, origins: {}, layers });

  it("passes a folder with no project layer, or with one Codex does not load", () => {
    expect(codexProjectLayerRefusal(read([USER, SESSION]))).toBeNull();
    expect(codexProjectLayerRefusal(read([]))).toBeNull();
    expect(
      codexProjectLayerRefusal(read([USER, project("untrusted project")])),
    ).toBeNull();
  });

  // Codex 0.164 leaves the key out of a layer it loads.
  it("refuses a project layer Codex loads", () => {
    const { disabledReason: _, ...loaded } = project(null);
    for (const layer of [project(null), loaded]) {
      const refusal = codexProjectLayerRefusal(read([USER, layer]));
      expect({ layer, refused: typeof refusal === "string" }).toEqual({
        layer,
        refused: true,
      });
    }
  });

  it("refuses an answer it cannot read", () => {
    for (const result of [
      null,
      "x",
      { config: {} },
      read(null),
      read("x"),
      read([USER, 7]),
      read([USER, { name: "project", disabledReason: null }]),
      read([{ ...project(null), disabledReason: 3 }]),
    ])
      expect({
        result,
        refused: typeof codexProjectLayerRefusal(result) === "string",
      }).toEqual({ result, refused: true });
  });
});

describe("codexEmptyCwd", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = (label: string) => {
    const id = `agent-empty-cwd-${label}-${process.pid}`;
    made.push(join(CODEX_EMPTY_CWD_ROOT, id));
    return id;
  };

  it("makes the agent's folder under the office state, 0700, and gives it again while it is empty", async () => {
    // The test preload points the state at a temp home; never the real one.
    expect(CODEX_EMPTY_CWD_ROOT.startsWith(STATE_ROOT)).toBe(true);
    const id = fresh("new");
    const dir = await codexEmptyCwd(id);
    expect(dir).toBe(join(CODEX_EMPTY_CWD_ROOT, id));
    const stat = statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(await codexEmptyCwd(id)).toBe(dir);
  });

  it("refuses a folder that holds anything: a file, a hidden folder, a link", async () => {
    const plant: [string, (dir: string) => void][] = [
      ["file", (dir) => writeFileSync(join(dir, "AGENTS.md"), "planted")],
      ["hidden", (dir) => mkdirSync(join(dir, ".codex"))],
      ["link", (dir) => symlinkSync("/etc", join(dir, "etc"))],
    ];
    for (const [label, arrange] of plant) {
      const id = fresh(label);
      const dir = await codexEmptyCwd(id);
      arrange(dir);
      const err = await codexEmptyCwd(id).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ label, refused: err instanceof Error }).toEqual({
        label,
        refused: true,
      });
    }
  });

  it("refuses a path that is not a folder", async () => {
    const id = fresh("notdir");
    mkdirSync(CODEX_EMPTY_CWD_ROOT, { recursive: true });
    writeFileSync(join(CODEX_EMPTY_CWD_ROOT, id), "x");
    const err = await codexEmptyCwd(id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(join(CODEX_EMPTY_CWD_ROOT, id))).toBe(true);
  });
});
