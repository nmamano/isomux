import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_ROOT } from "../../config.ts";
import { evaluateOpenCodePermission } from "./safety-adapter.ts";
import { OPENCODE_V2_DATABASE } from "./config-layers.ts";
import { buildOpenCodeSafetyPlugin } from "./safety-plugin-build.ts";
import safetyPlugin, { openCodeToolAction } from "./safety-plugin.ts";
import { OPENCODE_SAFETY_PLUGIN_ID } from "./safety-plugin-tool.ts";
import { openCodeStopRules } from "./access.ts";

// The context of the @opencode/plugin 2.1.4 promise API that the plugin
// uses: each hook() resolves to a registration (promise/adapter.ts:248).
type Callback = (event: Record<string, unknown>) => unknown;
type Registration = { dispose: () => Promise<void> };
type Plugin = { id: string; setup: (ctx: never) => unknown };

function fakeContext(
  directory: string,
  registration: (domain: string) => Promise<Registration> = () =>
    Promise.resolve({ dispose: async () => {} }),
) {
  const hooks = new Map<string, Callback>();
  const hook = (domain: string) => (name: string, callback: Callback) => {
    hooks.set(`${domain}.${name}`, callback);
    return registration(domain);
  };
  return {
    hooks,
    ctx: {
      location: { directory },
      tool: { hook: hook("tool") },
      shell: { hook: hook("shell") },
    },
  };
}

async function loaded(directory: string, plugin: Plugin = safetyPlugin) {
  const { ctx, hooks } = fakeContext(directory);
  await plugin.setup(ctx as never);
  return hooks;
}

// A sync throw fails the call as a rejection does: the adapter runs the
// callback inside Effect.tryPromise (promise/adapter.ts:643).
async function verdict(
  hooks: Map<string, Callback>,
  tool: string,
  input: unknown,
): Promise<string> {
  const callback = hooks.get("tool.execute.before");
  if (!callback) throw new Error("no execute.before hook");
  const event = {
    tool,
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input,
  };
  return Promise.resolve()
    .then(() => callback(event))
    .then(
      () => "allow",
      (error: unknown) =>
        error instanceof Error ? error.message : `non-Error: ${String(error)}`,
    );
}

const repo = "/srv/b1045-repo";
// A profile outside the test's state root: only the profile rule can deny.
const profile = "/home/someone/.isomux/opencode/profiles/0123456789abcdef";

describe("openCodeToolAction", () => {
  it("runs shell in its workdir, resolved against the folder", () => {
    expect(openCodeToolAction("shell", { command: "ls" }, repo)).toEqual({
      action: { kind: "shell", command: "ls" },
      cwd: repo,
    });
    expect(
      openCodeToolAction("shell", { command: "ls", workdir: "sub" }, repo)?.cwd,
    ).toBe(join(repo, "sub"));
    expect(
      openCodeToolAction("shell", { command: "ls", workdir: "/tmp" }, repo)
        ?.cwd,
    ).toBe("/tmp");
  });

  it("maps the 2.1.4 file tools to the policy's file actions", () => {
    for (const [tool, input, kind] of [
      ["read", { path: join(repo, "a") }, "read-files"],
      ["grep", { pattern: "x", path: "src", include: "*.ts" }, "read-files"],
      ["edit", { path: "a", oldString: "x", newString: "y" }, "write-files"],
      ["write", { path: "a", content: "" }, "write-files"],
      ["patch", { patchText: "p" }, "patch-files"],
    ] as const)
      expect(openCodeToolAction(tool, input, repo)?.action.kind, tool).toBe(
        kind,
      );
  });

  // MCP tools keep their own names (codemode false). "execute" is the Code
  // Mode wrapper: each tool it calls goes through execute.before by name
  // (core/src/tool.ts:72-74), so the wrapper itself has nothing to check.
  it("has no check for an MCP tool or the Code Mode wrapper", () => {
    for (const tool of ["isomux-docs_search", "execute"])
      expect(
        openCodeToolAction(tool, { command: "rm -rf ~", path: ".env" }, repo),
        tool,
      ).toBeNull();
  });
});

describe("the safety plugin", () => {
  it("has the id the transport checks for", () => {
    expect(safetyPlugin.id).toBe(OPENCODE_SAFETY_PLUGIN_ID);
  });

  it("denies by throwing the policy's reason, and lets an allowed call run", async () => {
    const hooks = await loaded(repo);
    const denied = await verdict(hooks, "shell", { command: "rm -rf ~" });
    expect(denied).not.toBe("allow");
    expect(denied).toStartWith("BLOCKED by isomux safety hooks");
    expect(await verdict(hooks, "shell", { command: "ls -la" })).toBe("allow");
    expect(
      await verdict(hooks, "isomux-docs_search", { command: "rm -rf ~" }),
    ).toBe("allow");
  });

  // R2: a hook that catches and allows fails open.
  it("denies a call whose check throws", async () => {
    const hooks = await loaded(repo);
    let reads = 0;
    const input = {
      get path(): string {
        reads++;
        throw new Error("check failed");
      },
    };
    expect(await verdict(hooks, "read", input)).not.toBe("allow");
    expect(reads, "the policy reached the input").toBeGreaterThan(0);
  });

  it("checks grep's path and file pattern, and allows a grep of the folder", async () => {
    const hooks = await loaded(repo);
    expect(await verdict(hooks, "grep", { pattern: "x" })).toBe("allow");
    expect(
      await verdict(hooks, "grep", { pattern: "x", include: "*.pem" }),
    ).not.toBe("allow");
    expect(
      await verdict(hooks, "grep", { pattern: "x", path: "keys/id_rsa" }),
    ).not.toBe("allow");
  });

  it("checks edit, write and patch targets", async () => {
    const hooks = await loaded(repo);
    const target = join(STATE_ROOT, "agents.json");
    for (const [tool, input] of [
      ["edit", { path: target, oldString: "a", newString: "b" }],
      ["write", { path: target, content: "" }],
      [
        "patch",
        {
          patchText: `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch`,
        },
      ],
    ] as const) {
      expect(await verdict(hooks, tool, input), tool).not.toBe("allow");
      expect(
        await verdict(
          hooks,
          tool,
          tool === "patch"
            ? {
                patchText:
                  "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch",
              }
            : { ...input, path: "src/a.ts" },
        ),
        `${tool} in the folder`,
      ).toBe("allow");
    }
  });

  // S3: 2.1.4 asks for an outside path only through workdir and cd, so the
  // policy's own rules stand for paths in a command's arguments.
  it("denies shell reads of outside secrets and writes under the state root", async () => {
    const hooks = await loaded(repo);
    for (const command of [
      "cat /srv/elsewhere/id_rsa",
      "head -c 100 /srv/elsewhere/.env",
      `cp /srv/elsewhere/notes.txt ${join(STATE_ROOT, "agents.json")}`,
      `rm -f ${join(STATE_ROOT, "agents.json")}`,
    ])
      expect(
        await verdict(hooks, "shell", { command }),
        command.replaceAll(STATE_ROOT, "<state root>"),
      ).not.toBe("allow");
    expect(
      await verdict(hooks, "shell", {
        command: "cat /srv/elsewhere/notes.txt",
      }),
    ).toBe("allow");
  });

  // E2: the server's start environment keeps its password.
  it("denies reads of another process's environment by shell and by read", async () => {
    const hooks = await loaded(repo);
    for (const command of [
      "cat /proc/4242/environ",
      "cat /proc/$PPID/environ",
      "tr '\\0' '\\n' < /proc/4242/environ",
    ])
      expect(await verdict(hooks, "shell", { command }), command).not.toBe(
        "allow",
      );
    expect(
      await verdict(hooks, "read", { path: "/proc/4242/environ" }),
    ).not.toBe("allow");
    expect(
      await verdict(hooks, "shell", { command: "cat /proc/self/environ" }),
    ).toBe("allow");
  });

  // E2: the server record holds the server password.
  it("denies reads of an OpenCode profile's server record, not of any server.lock", async () => {
    const hooks = await loaded(repo);
    const record = join(profile, "server.lock");
    expect(
      await verdict(hooks, "shell", { command: `cat ${record}` }),
    ).not.toBe("allow");
    expect(await verdict(hooks, "read", { path: record })).not.toBe("allow");
    expect(
      await verdict(hooks, "read", { path: join(repo, "server.lock") }),
    ).toBe("allow");
  });

  // Task 75904a56 (gate M6): the database holds the credential table.
  it("denies reads of an OpenCode database by sqlite3 and by read", async () => {
    const hooks = await loaded(repo);
    const database = join(profile, "data", "opencode", "opencode-v2.db");
    expect(
      await verdict(hooks, "shell", { command: `sqlite3 ${database} .dump` }),
    ).not.toBe("allow");
    expect(await verdict(hooks, "read", { path: database })).not.toBe("allow");
    expect(
      await verdict(hooks, "shell", {
        command: `sqlite3 ${join(repo, "app.db")} .tables`,
      }),
    ).toBe("allow");
  });

  it("removes the server's secrets from a shell's environment and keeps the rest", async () => {
    const hooks = await loaded(repo);
    const callback = hooks.get("shell.create.before");
    if (!callback) throw new Error("no create.before hook");
    const event = {
      command: "ls",
      cwd: repo,
      timeout: 0,
      shell: "/bin/sh",
      env: {
        OPENCODE_SERVER_PASSWORD: "fake-server-password",
        OPENCODE_PASSWORD: "fake-password",
        OPENCODE_CONFIG: "/profile/opencode.json",
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        MEMBER_VARIABLE: "member-value",
      } as Record<string, string | undefined>,
    };
    await callback(event);
    // Names only: a failed matcher would print values.
    expect(Object.keys(event.env).sort()).toEqual([
      "MEMBER_VARIABLE",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "PATH",
      "TERM",
    ]);
    expect(event.env.MEMBER_VARIABLE === "member-value").toBe(true);
    expect(event.command).toBe("ls");
  });

  // R1: OpenCode reports the plugin active once setup resolves, and the
  // transport runs prompts from then on.
  for (const first of ["tool", "shell"])
    it(`does not finish setup until both hooks are registered (${first} first)`, async () => {
      const pending = new Map<string, PromiseWithResolvers<Registration>>();
      const { ctx } = fakeContext(repo, (domain) => {
        const deferred = Promise.withResolvers<Registration>();
        pending.set(domain, deferred);
        return deferred.promise;
      });
      let done = false;
      const setup = Promise.resolve(safetyPlugin.setup(ctx as never)).then(
        () => {
          done = true;
        },
      );
      const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
      // Resolve `first` as soon as it is asked for: setup may register the
      // two hooks at once or one after the other.
      const resolved: string[] = [];
      while (resolved.length < 2) {
        await settle();
        expect(done, `registered: ${resolved.join(", ") || "none"}`).toBe(
          false,
        );
        const next = [first, ...pending.keys()].find(
          (domain) => pending.has(domain) && !resolved.includes(domain),
        );
        if (!next)
          throw new Error(
            `setup waits for no hook after ${resolved.join(", ")}`,
          );
        pending.get(next)!.resolve({ dispose: async () => {} });
        resolved.push(next);
      }
      await setup;
      expect(done).toBe(true);
      expect(resolved.sort()).toEqual(["shell", "tool"]);
    });

  // A plugin whose setup fails is reported failed, and the transport
  // refuses the turn.
  it("fails setup when a hook cannot be registered", async () => {
    for (const failing of ["tool", "shell"]) {
      const { ctx } = fakeContext(repo, (domain) =>
        domain === failing
          ? Promise.reject(new Error("registration failed"))
          : Promise.resolve({ dispose: async () => {} }),
      );
      const outcome = await Promise.resolve(
        safetyPlugin.setup(ctx as never),
      ).then(
        () => "resolved",
        () => "rejected",
      );
      expect(outcome, failing).toBe("rejected");
    }
  });
});

// The plugin and the permission-ask path (safety-adapter.ts) decide each call
// alike: one policy, two ways in.
describe("the safety plugin and the ask path", () => {
  const commands = ["git reset --hard", "ls -la", "rm -rf ~", "cat .env"];
  const files = [
    join(repo, "src", "a.ts"),
    join(STATE_ROOT, "agents.json"),
    join(repo, ".env"),
  ];
  const cases = [
    ...commands.map((command) => ({
      tool: "shell",
      input: { command },
      ask: { action: "shell", resources: [command], metadata: {} },
    })),
    ...files.flatMap((path) => [
      {
        tool: "write",
        input: { path, content: "" },
        ask: { action: "edit", resources: [path], metadata: {} },
      },
      {
        tool: "edit",
        input: { path, oldString: "a", newString: "b" },
        ask: { action: "edit", resources: [path], metadata: {} },
      },
    ]),
  ];
  for (const { tool, input, ask } of cases) {
    // The state root is a temp folder per run: keep it out of the name.
    const label = JSON.stringify(input).replaceAll(STATE_ROOT, "<state root>");
    it(`agree on ${tool} ${label}`, async () => {
      const hooks = await loaded(repo);
      const asked = evaluateOpenCodePermission(
        { id: "per_1", sessionId: "ses_1", ...ask },
        repo,
      );
      expect(asked.kind).toBe("policy");
      const expected =
        asked.kind === "policy" && asked.decision.decision === "deny"
          ? asked.decision.reason
          : "allow";
      expect(await verdict(hooks, tool, input)).toBe(expected);
    });
  }
});

describe("the bundled safety plugin", () => {
  it("bundles into one module with the given roots, not the process's", async () => {
    const home = "/srv/isomux-safety-plugin-home";
    const stateRoot = "/srv/isomux-safety-plugin-state";
    const profile = join(stateRoot, "opencode", "profiles", "k");
    // The shell variables as production bakes them: the profile's folders
    // under the state root, the server's temp folder (task 3811ffe2), and the
    // OS user's values beside them.
    const profileValues = {
      HOME: join(profile, "home"),
      XDG_CONFIG_HOME: join(profile, "config"),
      XDG_DATA_HOME: join(profile, "data"),
      XDG_STATE_HOME: join(profile, "state"),
      XDG_CACHE_HOME: join(profile, "cache"),
      TMPDIR: "/srv/os-tmp/isomux-opencode-k",
      OPENCODE_DB: OPENCODE_V2_DATABASE,
    };
    const userValues = {
      HOME: "/users-home",
      XDG_CONFIG_HOME: null,
      XDG_DATA_HOME: "/users-xdg-data",
      XDG_STATE_HOME: null,
      XDG_CACHE_HOME: null,
      TMPDIR: null,
      OPENCODE_DB: null,
    };
    const text = await buildOpenCodeSafetyPlugin(
      {
        home,
        env: {
          ISOMUX_HOME: stateRoot,
          ISOMUX_ADMIN_SOCKET: join(stateRoot, "admin.sock"),
        },
      },
      { user: userValues, profile: profileValues },
    );
    expect(text, "no import of node:os is left").not.toMatch(
      /from "(node:)?os"/,
    );
    expect(text, "no environment read is left").not.toContain("process.env");
    const dir = await mkdtemp(join(tmpdir(), "isomux-safety-plugin-"));
    try {
      const file = join(dir, "index.js");
      await writeFile(file, text);
      const bundled = (await import(pathToFileURL(file).href)) as {
        default: Plugin;
      };
      expect(bundled.default.id).toBe(OPENCODE_SAFETY_PLUGIN_ID);
      const hooks = await loaded(home, bundled.default);
      const local = await loaded(home);
      const write = (path: string) => ({ path, content: "" });
      // The state root, and <home>/.isomux reached by a relative path.
      for (const input of [
        write(join(stateRoot, "agents.json")),
        write(".isomux/agents.json"),
      ]) {
        expect(await verdict(hooks, "write", input)).not.toBe("allow");
        expect(
          await verdict(local, "write", input),
          "the process roots differ",
        ).toBe("allow");
      }
      // ~ in a file tool resolves from the server's home, outside the state
      // root: a write through ~ is allowed, and the office state an agent
      // types through ~ refuses.
      expect(await verdict(hooks, "write", write("~/x"))).toBe("allow");
      expect(await verdict(hooks, "write", write("~/../data/x"))).toBe("allow");
      // An agent that types the office state refuses it from any home.
      expect(await verdict(hooks, "write", write("~/.isomux/x"))).not.toBe(
        "allow",
      );
      // The shell hook survives the bundle too, and gives a shell that
      // started from the server's environment the OS user's values back.
      const fromServer: Record<string, string | undefined> = {
        OPENCODE_SERVER_PASSWORD: "fake-server-password",
        PATH: "/usr/bin",
        HOME: profileValues.HOME,
        XDG_DATA_HOME: profileValues.XDG_DATA_HOME,
        TMPDIR: profileValues.TMPDIR,
        OPENCODE_DB: OPENCODE_V2_DATABASE,
        OPENCODE_CONFIG_DIR: "/member/opencode",
      };
      await hooks.get("shell.create.before")!({ env: fromServer });
      expect(fromServer).toEqual({
        PATH: "/usr/bin",
        HOME: "/users-home",
        XDG_DATA_HOME: "/users-xdg-data",
        OPENCODE_CONFIG_DIR: "/member/opencode",
      });
      // A session's own values, or a member's, stay as they came.
      const fromSession: Record<string, string | undefined> = {
        HOME: "/member-home",
        TMPDIR: "/member-tmp",
      };
      await hooks.get("shell.create.before")!({ env: fromSession });
      expect(fromSession).toEqual({
        HOME: "/member-home",
        TMPDIR: "/member-tmp",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Task e77304b1 (merge C2): a session of a stop agent below Standard. The
// plugin reads the session's own rules (ctx.session.get) and refuses any
// tool they do not allow by exact name (P5: a member plugin's tool can pick
// any permission name), and at folder and web keeps file paths inside the
// folder with the rules Claude's hook uses.
describe("the safety plugin below Standard", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  // folder/: the agent's folder, with a file, a sub folder, a link to a
  // folder outside and a link to a file outside. outside/: a secret.
  function layout() {
    const root = mkdtempSync(join(tmpdir(), "opencode-belt-"));
    dirs.push(root);
    const folder = join(root, "folder");
    const outside = join(root, "outside");
    mkdirSync(join(folder, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(folder, "notes.md"), "notes\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(folder, "linked-dir"));
    symlinkSync(join(outside, "secret.txt"), join(folder, "linked-file"));
    return { folder, outside };
  }

  type Get = (input: { sessionID: string }) => Promise<unknown>;
  async function stopHooks(directory: string, get: Get) {
    const { ctx, hooks } = fakeContext(directory);
    await safetyPlugin.setup({ ...ctx, session: { get } } as never);
    return hooks;
  }
  const rulesOf =
    (rules: unknown): Get =>
    async ({ sessionID }) => ({ id: sessionID, permissions: rules });

  async function decide(
    hooks: Map<string, Callback>,
    agent: string,
    tool: string,
    input: unknown,
  ): Promise<"allow" | "deny"> {
    const callback = hooks.get("tool.execute.before");
    if (!callback) throw new Error("no execute.before hook");
    return Promise.resolve()
      .then(() =>
        callback({
          tool,
          sessionID: "ses_below",
          agent,
          messageID: "msg_1",
          id: "call_1",
          input,
        }),
      )
      .then(
        () => "allow" as const,
        () => "deny" as const,
      );
  }

  const OFFICE_TOOLS = ["open_ask"];
  const patch = (...lines: string[]) => ({
    patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
  });

  it("refuses every tool the session's rules do not allow by exact name, at each stop", async () => {
    const { folder } = layout();
    const listed: Record<string, [string, unknown][]> = {
      chat: [],
      office: [["isomux_open_ask", { question: "x" }]],
      folder: [
        ["isomux_open_ask", { question: "x" }],
        ["read", { path: join(folder, "notes.md") }],
      ],
      web: [
        ["isomux_open_ask", { question: "x" }],
        ["read", { path: join(folder, "notes.md") }],
        ["webfetch", { url: "https://example.com" }],
      ],
    };
    const unlisted: [string, unknown][] = [
      ["shell", { command: "ls" }],
      ["execute", { code: "1" }],
      ["subagent", { prompt: "x" }],
      ["skill", { name: "x" }],
      ["question", { questions: [] }],
      ["todowrite", { todos: [] }],
      ["isomux_fake", {}],
      ["isomux_send_message", { text: "x" }],
      ["isomux_evil_open_ask", {}],
      ["plug_free", {}],
      ["planted_tool", {}],
    ];
    for (const stop of ["chat", "office", "folder", "web"] as const) {
      const hooks = await stopHooks(
        folder,
        rulesOf(openCodeStopRules(stop, OFFICE_TOOLS)),
      );
      const agent = `isomux-${stop}`;
      for (const [tool, input] of listed[stop])
        expect({
          stop,
          tool,
          decision: await decide(hooks, agent, tool, input),
        }).toEqual({
          stop,
          tool,
          decision: "allow",
        });
      const off: [string, unknown][] = [
        ...unlisted,
        ...(stop === "web"
          ? []
          : ([["webfetch", { url: "https://example.com" }]] as [
              string,
              unknown,
            ][])),
        ...(stop === "chat" || stop === "office"
          ? ([
              ["read", { path: join(folder, "notes.md") }],
              ["isomux_open_ask", {}],
            ].filter(
              ([tool]) => stop === "chat" || tool !== "isomux_open_ask",
            ) as [string, unknown][])
          : []),
      ];
      for (const [tool, input] of off)
        expect({
          stop,
          tool,
          decision: await decide(hooks, agent, tool, input),
        }).toEqual({
          stop,
          tool,
          decision: "deny",
        });
    }
  });

  // A Standard session keeps its tools: the belt is for the stop agents.
  it("leaves a session of another agent to the ordinary checks", async () => {
    const { folder } = layout();
    const hooks = await stopHooks(
      folder,
      rulesOf([{ action: "*", resource: "*", effect: "deny" }]),
    );
    for (const agent of ["build", "isomux-cron", "isomux-interactive-bypass"])
      expect({
        agent,
        decision: await decide(hooks, agent, "plug_free", {}),
      }).toEqual({
        agent,
        decision: "allow",
      });
  });

  // R2: a belt that cannot read the rules and lets the call run fails open.
  it("refuses every call of a stop agent whose rules it cannot read", async () => {
    const { folder } = layout();
    const gets: [string, Get][] = [
      [
        "a failed read",
        async () => {
          throw new Error("session.get 500");
        },
      ],
      ["no session", async () => undefined],
      ["rules not a list", rulesOf({ read: "allow" })],
    ];
    for (const [label, get] of gets) {
      const hooks = await stopHooks(folder, get);
      expect({
        label,
        decision: await decide(hooks, "isomux-folder", "read", {
          path: join(folder, "notes.md"),
        }),
      }).toEqual({ label, decision: "deny" });
    }
  });

  it("keeps every file tool inside the folder at folder and web", async () => {
    const { folder, outside } = layout();
    const cases: [string, string, unknown, "allow" | "deny"][] = [
      [
        "read a file inside",
        "read",
        { path: join(folder, "notes.md") },
        "allow",
      ],
      ["read by a relative path", "read", { path: "notes.md" }, "allow"],
      ["read a folder inside", "read", { path: join(folder, "sub") }, "allow"],
      [
        "read a file outside",
        "read",
        { path: join(outside, "secret.txt") },
        "deny",
      ],
      ["read a folder outside", "read", { path: outside }, "deny"],
      ["read up and out", "read", { path: "../outside/secret.txt" }, "deny"],
      [
        "read through a linked file",
        "read",
        { path: join(folder, "linked-file") },
        "deny",
      ],
      [
        "read through a linked folder",
        "read",
        { path: join(folder, "linked-dir", "secret.txt") },
        "deny",
      ],
      ["read under home", "read", { path: "~/secret.txt" }, "deny"],
      ["grep the folder", "grep", { pattern: "x" }, "allow"],
      [
        "grep with a file pattern",
        "grep",
        { pattern: "x", include: "*.md" },
        "allow",
      ],
      ["grep outside", "grep", { pattern: "x", path: outside }, "deny"],
      [
        "grep a linked folder",
        "grep",
        { pattern: "x", path: join(folder, "linked-dir") },
        "deny",
      ],
      // Grep's file pattern takes Glob's rule: no "..", no root or home.
      [
        "grep up and out by its file pattern",
        "grep",
        { pattern: "x", include: "../outside/*" },
        "deny",
      ],
      [
        "grep a root through a brace",
        "grep",
        { pattern: "x", include: "{/etc,sub}/*" },
        "deny",
      ],
      [
        "grep an absolute file pattern outside",
        "grep",
        { pattern: "x", include: `${outside}/*` },
        "deny",
      ],
      ["glob the folder", "glob", { pattern: "**/*.md" }, "allow"],
      ["glob outside by path", "glob", { pattern: "*", path: outside }, "deny"],
      ["glob up and out", "glob", { pattern: "../outside/*" }, "deny"],
      [
        "glob an absolute pattern outside",
        "glob",
        { pattern: `${outside}/*` },
        "deny",
      ],
      [
        "glob up and out through a brace",
        "glob",
        { pattern: "{..,sub}/outside/*" },
        "deny",
      ],
      ["glob home", "glob", { pattern: "~/*" }, "deny"],
      [
        "write a new file inside",
        "write",
        { path: join(folder, "sub", "new.md"), content: "x" },
        "allow",
      ],
      [
        "edit a file inside",
        "edit",
        { path: join(folder, "notes.md"), oldString: "notes", newString: "n" },
        "allow",
      ],
      [
        "write outside",
        "write",
        { path: join(outside, "x.md"), content: "x" },
        "deny",
      ],
      [
        "write up and out",
        "write",
        { path: "../outside/x.md", content: "x" },
        "deny",
      ],
      [
        "write through a linked folder",
        "write",
        { path: join(folder, "linked-dir", "x.md"), content: "x" },
        "deny",
      ],
      [
        "edit through a linked file",
        "edit",
        { path: join(folder, "linked-file"), oldString: "s", newString: "t" },
        "deny",
      ],
      ["write under home", "write", { path: "~/x.md", content: "x" }, "deny"],
      [
        "patch: add inside",
        "patch",
        patch("*** Add File: sub/new.md", "+x"),
        "allow",
      ],
      [
        "patch: update inside",
        "patch",
        patch("*** Update File: notes.md", "@@", "-notes", "+n"),
        "allow",
      ],
      [
        "patch: add outside",
        "patch",
        patch(`*** Add File: ${join(outside, "x.md")}`, "+x"),
        "deny",
      ],
      [
        "patch: add up and out",
        "patch",
        patch("*** Add File: ../outside/x.md", "+x"),
        "deny",
      ],
      [
        "patch: delete outside",
        "patch",
        patch(`*** Delete File: ${join(outside, "secret.txt")}`),
        "deny",
      ],
      [
        "patch: update through a link",
        "patch",
        patch("*** Update File: linked-file", "@@", "-secret", "+x"),
        "deny",
      ],
      [
        "patch: move out of the folder",
        "patch",
        patch(
          "*** Update File: notes.md",
          `*** Move to: ${join(outside, "moved.md")}`,
          "@@",
          "-notes",
          "+n",
        ),
        "deny",
      ],
      [
        "patch: a second file outside",
        "patch",
        patch(
          "*** Add File: sub/ok.md",
          "+x",
          `*** Add File: ${join(outside, "x.md")}`,
          "+x",
        ),
        "deny",
      ],
    ];
    for (const name of [
      ".opencode/plugin/p.ts",
      "sub/.opencode/x.json",
      "opencode.json",
      "sub/opencode.json",
      "AGENTS.md",
      ".git/config",
      ".claude/settings.json",
      ".codex/config.toml",
      ".mcp.json",
      ".envrc",
    ]) {
      cases.push([
        `write ${name}`,
        "write",
        { path: join(folder, name), content: "x" },
        "deny",
      ]);
      cases.push([
        `patch ${name}`,
        "patch",
        patch(`*** Add File: ${name}`, "+x"),
        "deny",
      ]);
      cases.push([
        `patch: move onto ${name}`,
        "patch",
        patch(
          "*** Update File: notes.md",
          `*** Move to: ${name}`,
          "@@",
          "-notes",
          "+n",
        ),
        "deny",
      ]);
    }
    for (const stop of ["folder", "web"] as const) {
      const hooks = await stopHooks(
        folder,
        rulesOf(openCodeStopRules(stop, OFFICE_TOOLS)),
      );
      for (const [label, tool, input, want] of cases)
        expect({
          stop,
          label,
          decision: await decide(hooks, `isomux-${stop}`, tool, input),
        }).toEqual({ stop, label, decision: want });
    }
  });
});
