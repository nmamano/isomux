// OpenCode at chat, office, folder and web (task e77304b1, merge C2): the
// rules of each stop, the tools a rule list allows, the limited server's
// profile and env, the version gate, the /api/config and MCP checks at each
// start, and the empty folders. The adapter tests drive these through a
// session; the live proof of the tools the model sees is
// server/backends/opencode-access.live.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { CODEX_EMPTY_CWD_ROOT } from "../codex/access.ts";
import { emptyFolderRoots, ensureEmptyFolder } from "../empty-folder.ts";
import {
  OPENCODE_BELOW_STANDARD_PROVEN_VERSION,
  OPENCODE_EMPTY_CWD_ROOT,
  OPENCODE_STOP_AGENTS,
  openCodeAgentStop,
  openCodeAllowedTools,
  openCodeBelowStandardRefusal,
  openCodeConfigLayersRefusal,
  openCodeEmptyCwd,
  openCodeLaunchEnvFor,
  openCodeMcpCollisionRefusal,
  openCodeProfileKey,
  openCodeRunsBelowStandard,
  openCodeStopAgent,
  openCodeStopAgentRules,
  openCodeStopRules,
} from "./access.ts";
import { openCodeProfilePaths } from "./profile-paths.ts";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";

const BELOW = ["chat", "office", "folder", "web"] as const;

// OpenCode's reading of a rule list (probes p0-p6, 2.1.4): the last rule
// whose action matches the permission name decides; "*" in an action matches
// any run of characters.
function decides(rules: unknown, permission: string): string | undefined {
  let effect: string | undefined;
  for (const rule of rules as { action: string; effect: string }[]) {
    const pattern = new RegExp(
      `^${rule.action.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    if (pattern.test(permission)) effect = rule.effect;
  }
  return effect;
}

// Permission names a session can meet: the 2.1.4 built-ins, the guard names,
// the office tools, and tools a member's MCP server or plugin can add (P5).
const PERMISSIONS = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "patch",
  "shell",
  "bash",
  "execute",
  "subagent",
  "task",
  "skill",
  "question",
  "todowrite",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "external_directory",
  "doom_loop",
  "isomux_list_my_asks",
  "isomux_open_ask",
  "isomux_send_message",
  "isomux_fake",
  "isomux_evil_open_ask",
  "isomux",
  "plug_free",
  "planted_tool",
];

const OFFICE_TOOLS = ["list_my_asks", "open_ask"];

function allowedPermissions(rules: unknown): string[] {
  return PERMISSIONS.filter((name) => decides(rules, name) === "allow").sort();
}

const FOLDER_PERMISSIONS = ["edit", "glob", "grep", "read"];
const WEB_PERMISSIONS = ["webfetch", "websearch"];
const OFFICE_PERMISSIONS = ["isomux_list_my_asks", "isomux_open_ask"];

describe("the stop agents", () => {
  it("each stop below Standard has its Isomux agent, and back", () => {
    for (const stop of BELOW) {
      const agent = openCodeStopAgent(stop);
      expect({ stop, agent }).toEqual({
        stop,
        agent: OPENCODE_STOP_AGENTS[stop],
      });
      expect(openCodeAgentStop(agent!)).toBe(stop);
    }
    expect(openCodeStopAgent("standard")).toBeNull();
    expect(openCodeStopAgent("privileged")).toBeNull();
    for (const agent of [
      "build",
      "plan",
      "isomux-cron",
      "isomux-interactive-bypass",
      "",
    ])
      expect({ agent, stop: openCodeAgentStop(agent) }).toEqual({
        agent,
        stop: null,
      });
  });
});

describe("openCodeStopRules", () => {
  it("allows exactly the stop's tools, the office tools by exact name, and denies everything else", () => {
    const want: Record<(typeof BELOW)[number], string[]> = {
      chat: [],
      office: OFFICE_PERMISSIONS,
      folder: [...OFFICE_PERMISSIONS, ...FOLDER_PERMISSIONS],
      web: [...OFFICE_PERMISSIONS, ...FOLDER_PERMISSIONS, ...WEB_PERMISSIONS],
    };
    for (const stop of BELOW) {
      const rules = openCodeStopRules(stop, OFFICE_TOOLS);
      expect({ stop, allowed: allowedPermissions(rules) }).toEqual({
        stop,
        allowed: [...want[stop]].sort(),
      });
      // A file outside the folder is refused, not asked about.
      expect({ stop, outside: decides(rules, "external_directory") }).toEqual({
        stop,
        outside: "deny",
      });
    }
  });

  // P5: a member plugin's tool picks any permission name, so an allow with a
  // wildcard ("isomux_*") lets it in. Every allow names one permission.
  it("has no allow with a wildcard, and chat gets no office tool even when there are some", () => {
    for (const stop of BELOW)
      for (const rule of openCodeStopRules(stop, OFFICE_TOOLS))
        if (rule.effect === "allow")
          expect({ stop, action: rule.action }).toEqual({
            stop,
            action: rule.action.replace(/[*?[\]{}]/g, ""),
          });
    expect(allowedPermissions(openCodeStopRules("chat", OFFICE_TOOLS))).toEqual(
      [],
    );
    // An office pack with no tool: nothing at office.
    expect(allowedPermissions(openCodeStopRules("office", []))).toEqual([]);
  });

  it("throws at Standard and Privileged", () => {
    for (const stop of ["standard", "privileged"] as const)
      expect(() => openCodeStopRules(stop, OFFICE_TOOLS)).toThrow();
  });
});

describe("openCodeStopAgentRules", () => {
  // The agent block is the second copy: the session's list decides (P1).
  it("allows the stop's built-in tools only, never an office tool", () => {
    const want: Record<(typeof BELOW)[number], string[]> = {
      chat: [],
      office: [],
      folder: FOLDER_PERMISSIONS,
      web: [...FOLDER_PERMISSIONS, ...WEB_PERMISSIONS],
    };
    for (const stop of BELOW) {
      const rules = openCodeStopAgentRules(stop);
      expect({ stop, allowed: allowedPermissions(rules) }).toEqual({
        stop,
        allowed: [...want[stop]].sort(),
      });
      for (const rule of rules)
        if (rule.effect === "allow")
          expect(rule.action).not.toMatch(/[*?[\]{}]/);
    }
  });
});

describe("openCodeAllowedTools", () => {
  it("names the tools a stop's rules allow: edit covers write and patch", () => {
    const want: Record<(typeof BELOW)[number], string[]> = {
      chat: [],
      office: ["isomux_list_my_asks", "isomux_open_ask"],
      folder: [
        "edit",
        "glob",
        "grep",
        "isomux_list_my_asks",
        "isomux_open_ask",
        "patch",
        "read",
        "write",
      ],
      web: [
        "edit",
        "glob",
        "grep",
        "isomux_list_my_asks",
        "isomux_open_ask",
        "patch",
        "read",
        "webfetch",
        "websearch",
        "write",
      ],
    };
    for (const stop of BELOW)
      expect({
        stop,
        tools: [
          ...openCodeAllowedTools(openCodeStopRules(stop, OFFICE_TOOLS)),
        ].sort(),
      }).toEqual({ stop, tools: want[stop] });
  });

  // The belt reads the session's own list: it must never allow more than
  // OpenCode would, and an unreadable list allows nothing.
  it("reads the last match, adds nothing for a wildcard allow, and allows nothing for a list it cannot read", () => {
    const rule = (action: string, effect: string) => ({
      action,
      resource: "*",
      effect,
    });
    const cases: [string, unknown, string[]][] = [
      ["a wildcard allow", [rule("*", "deny"), rule("isomux_*", "allow")], []],
      ["allow everything", [rule("*", "allow")], []],
      [
        "a later deny of the same tool",
        [rule("*", "deny"), rule("read", "allow"), rule("read", "deny")],
        [],
      ],
      [
        "a later deny of everything",
        [rule("read", "allow"), rule("*", "deny")],
        [],
      ],
      ["an ask", [rule("*", "deny"), rule("grep", "ask")], []],
      ["one exact allow", [rule("*", "deny"), rule("grep", "allow")], ["grep"]],
      ["not a list", { action: "read", effect: "allow" }, []],
      ["null", null, []],
      ["a rule without an action", [{ effect: "allow" }], []],
      [
        "an action that is not text",
        [{ action: 7, resource: "*", effect: "allow" }],
        [],
      ],
    ];
    for (const [label, rules, tools] of cases)
      expect({ label, tools: [...openCodeAllowedTools(rules)].sort() }).toEqual(
        {
          label,
          tools,
        },
      );
  });
});

describe("the OpenCode version gate", () => {
  // An OpenCode bump turns this red: the stops below Standard need a new
  // probe (opencode-access.live.test.ts) before the proven version moves.
  it("the proven version is the pinned one, and another version runs no stop below Standard", () => {
    expect(OPENCODE_BELOW_STANDARD_PROVEN_VERSION).toBe(OPENCODE_CLI_VERSION);
    for (const stop of BELOW) {
      expect({ stop, runs: openCodeRunsBelowStandard(stop) }).toEqual({
        stop,
        runs: true,
      });
      expect({ stop, refusal: openCodeBelowStandardRefusal(stop) }).toEqual({
        stop,
        refusal: null,
      });
      expect({ stop, runs: openCodeRunsBelowStandard(stop, "2.1.5") }).toEqual({
        stop,
        runs: false,
      });
    }
    expect(openCodeRunsBelowStandard("standard", "2.1.5")).toBe(true);
    expect(openCodeRunsBelowStandard("privileged", "2.1.5")).toBe(true);
  });
});

describe("the limited server", () => {
  it("runs every stop below Standard on one profile of its own per member, apart from the member's", () => {
    const member = "member-key-a";
    const other = "member-key-b";
    for (const access of [undefined, "standard", "privileged"] as const)
      expect({ access, key: openCodeProfileKey(member, access) }).toEqual({
        access,
        key: member,
      });
    const limited = openCodeProfileKey(member, "chat");
    expect(limited).not.toBe(member);
    for (const stop of BELOW)
      expect({ stop, key: openCodeProfileKey(member, stop) }).toEqual({
        stop,
        key: limited,
      });
    const otherLimited = openCodeProfileKey(other, "office");
    expect(otherLimited).not.toBe(limited);
    expect(otherLimited).not.toBe(other);
    expect(openCodeProfilePaths(limited).profileDir).not.toBe(
      openCodeProfilePaths(member).profileDir,
    );
  });

  // P4: the flag is read once from the server's env; a member variable must
  // not turn project config back on.
  it("starts with project config off below Standard, whatever the member's variables say, and leaves Standard's env as it is", () => {
    const launch = {
      PATH: "/usr/bin",
      MEMBER_VARIABLE: "member",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
    };
    const before = { ...launch };
    for (const stop of BELOW) {
      const env = openCodeLaunchEnvFor(launch, stop);
      expect({ stop, flag: env.OPENCODE_DISABLE_PROJECT_CONFIG }).toEqual({
        stop,
        flag: "1",
      });
      expect(env.MEMBER_VARIABLE).toBe("member");
      expect(env.PATH).toBe("/usr/bin");
    }
    for (const access of [undefined, "standard", "privileged"] as const)
      expect(openCodeLaunchEnvFor(launch, access)).toEqual(before);
    expect(launch).toEqual(before);
  });
});

describe("openCodeConfigLayersRefusal", () => {
  const MEMBER = "/home/m/.config/isomux-opencode";
  // Isomux's config goes in twice: the file the supervisor writes in the
  // profile (OPENCODE_CONFIG, a layer with a path) and the content variable
  // (no path). Live, 2026-11-01: every limited server lists both.
  const PROFILE = "/state/opencode/profiles/k";
  const ISOMUX_FILE = `${PROFILE}/opencode.json`;
  const isomuxDoc = {
    type: "document",
    info: { agents: { "isomux-cron": { mode: "primary" } } },
  };
  const isomuxFile = { type: "document", path: ISOMUX_FILE, info: {} };
  const memberLayers = [
    { type: "document", path: `${MEMBER}/opencode.json`, info: {} },
    { type: "directory", path: MEMBER },
  ];

  it("passes Isomux's document and the member's config dir", () => {
    expect(
      openCodeConfigLayersRefusal(
        [...memberLayers, isomuxFile, isomuxDoc],
        MEMBER,
        ISOMUX_FILE,
      ),
    ).toBeNull();
    expect(
      openCodeConfigLayersRefusal(
        [
          { type: "document", path: `${MEMBER}/opencode.jsonc`, info: {} },
          { type: "directory", path: MEMBER },
          isomuxFile,
          isomuxDoc,
        ],
        MEMBER,
        ISOMUX_FILE,
      ),
    ).toBeNull();
    expect(
      openCodeConfigLayersRefusal([isomuxFile, isomuxDoc], null, ISOMUX_FILE),
    ).toBeNull();
  });

  // Each of these loaded in a probe without the flag (p2, p3-0): the check
  // is what fails closed if a later OpenCode ignores it.
  it("refuses any other layer, a second document without a path, and a shape it cannot read", () => {
    const cases: [string, unknown, string | null][] = [
      [
        "a project document",
        [
          ...memberLayers,
          { type: "document", path: "/srv/repo/opencode.json", info: {} },
          isomuxDoc,
        ],
        MEMBER,
      ],
      [
        "a project .opencode folder",
        [
          ...memberLayers,
          { type: "directory", path: "/srv/repo/.opencode" },
          isomuxDoc,
        ],
        MEMBER,
      ],
      [
        "an ancestor's document",
        [{ type: "document", path: "/srv/opencode.json", info: {} }, isomuxDoc],
        MEMBER,
      ],
      [
        "a sibling of the member's dir with the same prefix",
        [{ type: "directory", path: `${MEMBER}-x` }, isomuxDoc],
        MEMBER,
      ],
      [
        "a member dir when the server has none",
        [...memberLayers, isomuxDoc],
        null,
      ],
      [
        "a second document without a path",
        [
          ...memberLayers,
          { type: "document", info: { agents: {} } },
          isomuxDoc,
        ],
        MEMBER,
      ],
      ["no Isomux document", memberLayers, MEMBER],
      ["not a list", { data: [isomuxDoc] }, MEMBER],
      ["null", null, MEMBER],
      [
        "an unknown layer type",
        [{ type: "remote", url: "x" }, isomuxDoc],
        MEMBER,
      ],
      [
        "a path that is not text",
        [{ type: "document", path: 7 }, isomuxDoc],
        MEMBER,
      ],
      [
        "another document in the profile",
        [
          { type: "document", path: `${PROFILE}/opencode.jsonc`, info: {} },
          isomuxDoc,
        ],
        MEMBER,
      ],
      [
        "the profile as a folder",
        [{ type: "directory", path: PROFILE }, isomuxDoc],
        MEMBER,
      ],
      [
        "Isomux's file name in another folder",
        [
          { type: "document", path: `${PROFILE}-x/opencode.json`, info: {} },
          isomuxDoc,
        ],
        MEMBER,
      ],
    ];
    for (const [label, body, dir] of cases)
      expect({
        label,
        refused:
          typeof openCodeConfigLayersRefusal(
            Array.isArray(body) ? [isomuxFile, ...body] : body,
            dir,
            ISOMUX_FILE,
          ) === "string",
      }).toEqual({ label, refused: true });
  });
});

describe("openCodeMcpCollisionRefusal", () => {
  const layer = (servers: Record<string, unknown>) => [
    { type: "directory", path: "/m" },
    { type: "document", path: "/m/opencode.json", info: { mcp: { servers } } },
    { type: "document", info: { agents: {} } },
  ];
  const listed = (...names: string[]) => ({
    location: { directory: "/f" },
    data: names.map((name) => ({ name, status: { status: "connected" } })),
  });
  const planted = { planted: { type: "remote", url: "http://x" } };

  it("passes the member's other servers and ours", () => {
    expect(
      openCodeMcpCollisionRefusal(layer(planted), listed("planted", "isomux"), [
        "isomux",
      ]),
    ).toBeNull();
    // At chat nothing is ours, and nothing is named like it.
    expect(
      openCodeMcpCollisionRefusal(layer(planted), listed("planted"), []),
    ).toBeNull();
    // Neither name gives a tool "isomux_<t>".
    expect(
      openCodeMcpCollisionRefusal(
        layer({ "isomux-docs": {}, isomux2: {} }),
        listed("isomux-docs", "isomux2"),
        [],
      ),
    ).toBeNull();
  });

  // A server "isomux_send" with a tool "message" gives "isomux_send_message",
  // an exact office tool name.
  it("refuses a server named like the office one, in a config layer or added at run time, and a shape it cannot read", () => {
    const cases: [string, unknown, unknown, string[]][] = [
      [
        "a config server isomux_send",
        layer({ isomux_send: {} }),
        listed("isomux_send"),
        ["isomux"],
      ],
      [
        "a config server named isomux",
        layer({ isomux: {} }),
        listed("isomux"),
        ["isomux"],
      ],
      [
        "a run-time isomux_evil",
        layer(planted),
        listed("planted", "isomux_evil"),
        ["isomux"],
      ],
      ["isomux listed at chat", layer(planted), listed("isomux"), []],
      // /api/mcp is racy (P1 b): the config layers name it before it lists.
      [
        "a config server not listed yet",
        layer({ isomux_late: {} }),
        listed(),
        ["isomux"],
      ],
      ["config not a list", { servers: {} }, listed(), ["isomux"]],
      ["config null", null, listed(), ["isomux"]],
      ["mcp null", layer(planted), null, ["isomux"]],
      ["mcp data not a list", layer(planted), { data: "isomux" }, ["isomux"]],
      [
        "an mcp row without a name",
        layer(planted),
        { data: [{ status: {} }] },
        ["isomux"],
      ],
      [
        "servers not a table",
        [{ type: "document", info: { mcp: { servers: ["isomux_x"] } } }],
        listed(),
        ["isomux"],
      ],
    ];
    for (const [label, config, mcp, ours] of cases)
      expect({
        label,
        refused:
          typeof openCodeMcpCollisionRefusal(config, mcp, ours) === "string",
      }).toEqual({ label, refused: true });
  });
});

describe("the empty folders", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = (label: string) => {
    const id = `opencode-empty-${label}-${process.pid}`;
    made.push(join(OPENCODE_EMPTY_CWD_ROOT, id));
    return id;
  };

  it("makes an OpenCode agent's folder under the state, 0700, apart from Codex's, and refuses one that holds anything", async () => {
    expect(OPENCODE_EMPTY_CWD_ROOT.startsWith(STATE_ROOT)).toBe(true);
    expect(OPENCODE_EMPTY_CWD_ROOT).not.toBe(CODEX_EMPTY_CWD_ROOT);
    const id = fresh("new");
    const dir = await openCodeEmptyCwd(id);
    expect(dir).toBe(join(OPENCODE_EMPTY_CWD_ROOT, id));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(await openCodeEmptyCwd(id)).toBe(dir);
    for (const [label, plant] of [
      ["file", (d: string) => writeFileSync(join(d, "AGENTS.md"), "x")],
      ["config", (d: string) => mkdirSync(join(d, ".opencode"))],
      ["link", (d: string) => symlinkSync("/etc", join(d, "etc"))],
    ] as const) {
      const other = fresh(label);
      plant(await openCodeEmptyCwd(other));
      const err = await openCodeEmptyCwd(other).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ label, refused: err instanceof Error }).toEqual({
        label,
        refused: true,
      });
    }
  });

  // The runner entry runs as the agent user with a dir from the server: it
  // makes nothing outside the empty-folder roots.
  it("ensureEmptyFolder makes a folder only directly under one of its roots", () => {
    const roots = emptyFolderRoots();
    expect(roots).toContain(CODEX_EMPTY_CWD_ROOT);
    expect(roots).toContain(OPENCODE_EMPTY_CWD_ROOT);
    const outside = join(STATE_ROOT, `not-a-root-${process.pid}`);
    made.push(
      outside,
      join(OPENCODE_EMPTY_CWD_ROOT, "..", `escape-${process.pid}`),
    );
    const cases: [string, string][] = [
      ["outside every root", join(outside, "x")],
      ["a root itself", OPENCODE_EMPTY_CWD_ROOT],
      ["two levels down", join(OPENCODE_EMPTY_CWD_ROOT, "a", "b")],
      [
        "up and out of a root",
        `${OPENCODE_EMPTY_CWD_ROOT}/../escape-${process.pid}`,
      ],
      ["a relative path", "relative/x"],
    ];
    for (const [label, dir] of cases) {
      let refused = false;
      try {
        ensureEmptyFolder(dir);
      } catch {
        refused = true;
      }
      expect({ label, refused }).toEqual({ label, refused: true });
    }
    expect(statSync(STATE_ROOT).isDirectory()).toBe(true);
    let madeOutside = true;
    try {
      statSync(outside);
    } catch {
      madeOutside = false;
    }
    expect(madeOutside).toBe(false);
  });
});
