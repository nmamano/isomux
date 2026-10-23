// /reload-plugins (tasks a93c05af, 66645144) and the plugin skills in the Sk
// menu. OpenCode reloads its plugins and config per server, with the
// environment key of the agent's member. A live Claude session reloads its
// plugins in place; the plugin list the Claude process reports (at init and at
// the reload) is the menu's plugin list while that process lives. Without a
// live process the menu reads the disk: installed_plugins.json, minus what the
// settings files do not enable. Driven through AgentManager.sendMessage, so
// the registry entry, the handler and the manager's wiring are all in the
// path. What the reload does to the OpenCode server is in
// supervisor.test.ts; the disk rules are in skills.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import type { AgentEvent } from "../internal-types.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { autocompleteCommands } from "../../shared/commands.ts";
import { createAgentManager } from "../agent-manager.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";
import { STATE_ROOT } from "../config.ts";
import { writeManagedUserEnv, removeManagedUserEnv } from "../user-env.ts";
import type {
  BackendSession,
  CommandRow,
  CreateSessionOptions,
  EnginePlugin,
  SessionPluginReload,
} from "../backends/types.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

type Outcome = "reloaded" | "pending" | Error;

// A session's plugin reload as the test scripts it.
type SessionReload = () => Promise<SessionPluginReload>;

class ReloadBackend extends FakeBackend {
  // Engine-wide reloads (OpenCode's server).
  readonly reloads: { environmentKey: string }[] = [];
  outcome: Outcome = "reloaded";
  // What each new session reports at init.
  initPlugins: EnginePlugin[] = [];
  initCommands: string[] = [];
  // In-place reloads of a live session.
  sessionReloads = 0;
  nextSessionReload: SessionReload = () =>
    Promise.reject(new Error("no reload scripted"));
  // The command rows a session lists after init.
  rows: CommandRow[] = [];
  listCalls = 0;
  nextListCommands: () => Promise<CommandRow[]> = async () => this.rows;

  constructor() {
    super({ session: { autoSystemInit: false } });
  }

  async reloadPlugins(opts: {
    environmentKey: string;
  }): Promise<"reloaded" | "pending"> {
    this.reloads.push({ ...opts });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  override createSession(opts: CreateSessionOptions): BackendSession {
    return this.withPlugins(super.createSession(opts) as FakeSession);
  }

  override resumeSession(
    sessionId: string,
    opts: CreateSessionOptions,
  ): BackendSession {
    return this.withPlugins(
      super.resumeSession(sessionId, opts) as FakeSession,
    );
  }

  private withPlugins(session: FakeSession): FakeSession {
    session.push({
      kind: "system_init",
      sessionId: session.sessionId,
      slashCommands: this.initCommands,
      plugins: this.initPlugins,
    });
    (session as FakeSession & { reloadPlugins: SessionReload }).reloadPlugins =
      () => {
        this.sessionReloads++;
        return this.nextSessionReload();
      };
    (
      session as FakeSession & { listCommands: () => Promise<CommandRow[]> }
    ).listCommands = () => {
      this.listCalls++;
      return this.nextListCommands();
    };
    return session;
  }
}

const dirs: string[] = [];
afterEach(() => {
  clearTestManagedOfficeEnv();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A plugin folder with one skill, `<name>:s-<name>` in the menu.
function pluginFolder(path: string, name: string): string {
  const dir = join(path, "skills", `s-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\ndescription: s-${name}\n---\n${name} prompt\n`,
  );
  return path;
}

// A Claude config folder with one installed and enabled plugin ("disk"), and
// two plugin folders outside it that only a Claude process reports ("live",
// "later"). `install` adds an installed plugin later.
function claudeHome() {
  const cfg = mkdtempSync(join(tmpdir(), "isomux-reload-plugins-"));
  dirs.push(cfg);
  const installed: Record<string, { installPath: string }[]> = {};
  const enabled: Record<string, boolean> = {};
  const install = (name: string) => {
    const path = pluginFolder(join(cfg, "cache", name), name);
    installed[`${name}@m`] = [{ installPath: path }];
    enabled[`${name}@m`] = true;
    mkdirSync(join(cfg, "plugins"), { recursive: true });
    writeFileSync(
      join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: installed }),
    );
    writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({ enabledPlugins: enabled }),
    );
  };
  install("disk");
  const live = pluginFolder(join(cfg, "src", "live"), "live");
  const later = pluginFolder(join(cfg, "src", "later"), "later");
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: cfg });
  return { cfg, install, live, later };
}

// Account-synced skills on disk, one bucket, each with a SKILL.md whose
// description is its name.
function syncSkills(cfg: string, names: string[]): void {
  for (const name of names) {
    const dir = join(cfg, "skills", "synced", "acct-bucket", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n${name} prompt\n`,
    );
  }
  writeFileSync(
    join(cfg, "skills", "synced", "acct-bucket", "manifest.json"),
    "{}",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Lets every continuation already queued run: the rows path has no timers.
const drain = () => new Promise((r) => setImmediate(r));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}

async function agentOn(engine: AgentBackendType, userId: string) {
  const backend = new ReloadBackend();
  const roomId = `room-reload-${engine}`;
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => backend,
    officeState: new OfficeState({
      rooms: [{ id: roomId, name: roomId, prompt: null }],
    }),
    initialRooms: [],
    eventSink: (event) => events.push(event),
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Reload ${engine}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    engine,
    undefined,
    userId,
  );
  if (!info) throw new Error("spawn failed");
  const id = info.id;
  // Every Sk menu sent for this agent, as its sorted plugin entries.
  const menus = () =>
    events.flatMap((event) =>
      event.type === "slash_commands" && event.agentId === id
        ? [
            event.skills
              .map((skill) => skill.name)
              .filter((name) => name.includes(":"))
              .sort(),
          ]
        : [],
    );
  const lastMenu = () => menus().at(-1);
  // Every entry of the last Sk menu.
  const lastSkills = () => {
    const event = events.findLast(
      (e) => e.type === "slash_commands" && e.agentId === id,
    );
    return event?.type === "slash_commands" ? event.skills : [];
  };
  const skillsNamed = (names: string[]) =>
    lastSkills()
      .filter((skill) => names.includes(skill.name))
      .map((skill) => skill.name)
      .sort();
  // The lines one command adds to the agent's chat.
  const run = async (text = "/reload-plugins") => {
    const before = mgr.getAgentLogs(id).length;
    await mgr.sendMessage(id, text, "tester");
    return mgr.getAgentLogs(id).slice(before);
  };
  // The lines a command the engine does not know adds. Such a command answers
  // at once; one the engine knows starts a turn that nothing here ends, so
  // the send is not awaited past a bound.
  const runUnknown = async (text: string) => {
    const before = mgr.getAgentLogs(id).length;
    const answered = await Promise.race([
      mgr.sendMessage(id, text, "tester").then(() => true),
      sleep(1_000).then(() => false),
    ]);
    expect(answered, `${text} answered without a turn`).toBe(true);
    return mgr.getAgentLogs(id).slice(before);
  };
  // Starts the session with a first message. With `finish`, the turn ends and
  // the session is live and idle; without it, the turn keeps running.
  const startSession = async (finish: boolean) => {
    const sent = mgr.sendMessage(id, "hello", "tester");
    await waitUntil(() => !!backend.sessionForAgent(id), "session");
    const session = backend.sessionForAgent(id)!;
    await waitUntil(() => session.sent.length > 0, "first send");
    if (finish) {
      session.completeTurn({ text: "hi" });
      await sent;
      expect(mgr.getAgent(id)?.state).not.toBe("thinking");
    } else {
      expect(mgr.getAgent(id)?.state).toBe("thinking");
    }
    return session;
  };
  return {
    backend,
    mgr,
    id,
    menus,
    lastMenu,
    lastSkills,
    skillsNamed,
    run,
    runUnknown,
    startSession,
  };
}

const { t } = translatorFor("en");

const reloadOf = (
  plugins: EnginePlugin[],
  extra: Partial<SessionPluginReload> = {},
): SessionPluginReload => ({
  plugins,
  commands: [],
  toolsChanged: false,
  errorCount: 0,
  ...extra,
});

describe("/reload-plugins on a live Claude session", () => {
  it("reloads in place and the menu then lists what the process reports", async () => {
    const home = claudeHome();
    const agent = await agentOn("claude", "user-reload-live");
    agent.backend.initPlugins = [
      { name: "live", path: home.live, source: "live@m" },
      // Built into the CLI: no folder to read.
      { name: "core", path: "builtin", source: "core@builtin" },
    ];
    // Before any session the menu reads the disk.
    expect(agent.lastMenu()).toEqual(["disk:s-disk"]);
    await agent.startSession(true);
    // The process's list replaces the disk's: "disk" is installed and enabled
    // on disk, but this process did not load it.
    expect(agent.lastMenu()).toEqual(["live:s-live"]);

    // A command the process does not know is not run in it.
    const unknown = await agent.runUnknown("/later-cmd");
    expect(unknown.at(-1)?.content).toBe(
      t("commands.unsupported.unknownCommand", { name: "later-cmd" }),
    );

    agent.backend.nextSessionReload = async () =>
      reloadOf([{ name: "later", path: home.later, source: "later@m" }], {
        commands: [{ name: "later-cmd" }, { name: "mcp__srv__tool" }],
      });
    const menusBefore = agent.menus().length;
    const lines = await agent.run();
    expect(agent.backend.sessionReloads).toBe(1);
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "system"]);
    const plainReply = lines[1].content;
    expect(agent.menus().length).toBeGreaterThan(menusBefore);
    expect(agent.lastMenu()).toEqual(["later:s-later"]);

    // The reload's command list replaces the init's: the new command now runs
    // in the process, and an MCP tool name is still not a command.
    const session = agent.backend.sessionForAgent(agent.id)!;
    const sentBefore = session.sent.length;
    void agent.mgr.sendMessage(agent.id, "/later-cmd", "tester");
    await waitUntil(() => session.sent.length > sentBefore, "native send");
    expect(session.sent.at(-1)?.text).toContain("later-cmd");
    session.completeTurn();
    await waitUntil(
      () => agent.mgr.getAgent(agent.id)?.state !== "thinking",
      "native turn end",
    );
    const mcp = await agent.runUnknown("/mcp__srv__tool");
    expect(mcp.at(-1)?.content).toBe(
      t("commands.unsupported.unknownCommand", { name: "mcp__srv__tool" }),
    );

    // A reload that changed the tool list, and one with errors, each say so.
    agent.backend.nextSessionReload = async () =>
      reloadOf([], { toolsChanged: true });
    const costly = await agent.run();
    agent.backend.nextSessionReload = async () =>
      reloadOf([], { errorCount: 7 });
    const withErrors = await agent.run();
    expect(costly.at(-1)?.content).not.toBe(plainReply);
    expect(withErrors.at(-1)?.content).not.toBe(plainReply);
    expect(withErrors.at(-1)?.content).toContain("7");
    // An empty list is a list: the process loaded no plugin.
    expect(agent.lastMenu()).toEqual([]);
  });

  it("reports a failed reload as an error and keeps the process's list", async () => {
    const home = claudeHome();
    const agent = await agentOn("claude", "user-reload-fail");
    agent.backend.initPlugins = [
      { name: "live", path: home.live, source: "live@m" },
    ];
    await agent.startSession(true);
    agent.backend.nextSessionReload = () =>
      Promise.reject(new Error("reload-failure-canary"));
    const lines = await agent.run();
    expect(agent.backend.sessionReloads).toBe(1);
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "error"]);
    expect(lines[1].content).toContain("reload-failure-canary");
    expect(agent.lastMenu()).toEqual(["live:s-live"]);
  });

  it("does not reload while a turn runs", async () => {
    const home = claudeHome();
    const agent = await agentOn("claude", "user-reload-busy");
    agent.backend.initPlugins = [
      { name: "live", path: home.live, source: "live@m" },
    ];
    const session = await agent.startSession(false);
    agent.backend.nextSessionReload = async () =>
      reloadOf([{ name: "later", path: home.later, source: "later@m" }]);
    const lines = await agent.run();
    expect(agent.backend.sessionReloads).toBe(0);
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "system"]);
    expect(lines[1].content).toBe(t("commands.reloadPlugins.busy"));
    expect(agent.lastMenu()).toEqual(["live:s-live"]);
    session.completeTurn();
  });

  it("drops a reload that returns after the session it asked is gone", async () => {
    const home = claudeHome();
    const agent = await agentOn("claude", "user-reload-race");
    agent.backend.initPlugins = [
      { name: "live", path: home.live, source: "live@m" },
    ];
    const session = await agent.startSession(true);
    let answer!: (reload: SessionPluginReload) => void;
    agent.backend.nextSessionReload = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const reloading = agent.run();
    await waitUntil(() => agent.backend.sessionReloads === 1, "reload asked");
    // /clear replaces the conversation while the reload is out.
    const clearing = agent.mgr.sendMessage(agent.id, "/clear", "tester");
    await waitUntil(() => session.closed, "old session closed");
    await clearing;
    const before = agent.mgr.getAgentLogs(agent.id).length;
    answer(
      reloadOf([{ name: "later", path: home.later, source: "later@m" }], {
        commands: [{ name: "later-cmd" }],
      }),
    );
    await reloading;
    // The member still gets one answer to the command they sent.
    expect(
      agent.mgr
        .getAgentLogs(agent.id)
        .slice(before)
        .map((line) => line.kind),
    ).toEqual(["system"]);
    expect(agent.lastMenu()).toEqual(["disk:s-disk"]);
    // Nothing of the late answer was kept: a rebuild still reads the disk,
    // and the late command list is not the agent's.
    await agent.run();
    expect(agent.lastMenu()).toEqual(["disk:s-disk"]);
    const unknown = await agent.runUnknown("/later-cmd");
    expect(unknown.at(-1)?.content).toBe(
      t("commands.unsupported.unknownCommand", { name: "later-cmd" }),
    );
  });
});

describe("the Sk menu when the Claude process goes", () => {
  it("a session that ended leaves the next rebuild to the disk and the synced folder", async () => {
    const home = claudeHome();
    syncSkills(home.cfg, ["docx", "pdf"]);
    const agent = await agentOn("claude", "user-reload-ended");
    agent.backend.initPlugins = [
      { name: "live", path: home.live, source: "live@m" },
    ];
    agent.backend.rows = [{ name: "docx", description: "Docs" }];
    const session = await agent.startSession(true);
    await waitUntil(
      () =>
        agent.lastSkills().find((s) => s.name === "docx")?.description ===
        "Docs",
      "rows in the menu",
    );
    expect(agent.lastMenu()).toEqual(["live:s-live"]);
    expect(agent.skillsNamed(["docx", "pdf"])).toEqual(["docx"]);
    session.endStream();
    await waitUntil(
      () => agent.mgr.getAgent(agent.id)?.dormant === true,
      "session released",
    );
    const lines = await agent.run();
    expect(agent.backend.sessionReloads).toBe(0);
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "system"]);
    expect(agent.lastMenu()).toEqual(["disk:s-disk"]);
    expect(agent.skillsNamed(["docx", "pdf"])).toEqual(["docx", "pdf"]);
  });
});

describe("/reload-plugins without a live Claude session", () => {
  for (const [engine, reply] of [
    ["claude", "commands.reloadPlugins.nextMessage"],
    ["codex", "commands.reloadPlugins.menuRefreshed"],
  ] as const) {
    it(`rebuilds the ${engine} agent's menu from the disk`, async () => {
      const home = claudeHome();
      const agent = await agentOn(engine, `user-reload-asleep-${engine}`);
      expect(agent.lastMenu()).toEqual(["disk:s-disk"]);
      home.install("added");
      const lines = await agent.run();
      expect(agent.backend.sessionReloads).toBe(0);
      expect(agent.backend.reloads).toEqual([]);
      expect(lines.map((line) => line.kind)).toEqual([
        "user_message",
        "system",
      ]);
      expect(lines[1].content).toBe(t(reply));
      expect(agent.lastMenu()).toEqual(["added:s-added", "disk:s-disk"]);
    });
  }
});

describe("/reload-plugins on OpenCode", () => {
  it("asks the engine to reload for the agent's member, shows a distinct line per outcome, and rebuilds the menu", async () => {
    const home = claudeHome();
    const userId = "user-reload-opencode";
    // A member with variables of their own has an environment key of their
    // own, so the key the engine gets names this member.
    writeManagedUserEnv(userId, { RELOAD_KEY_CANARY: "1" });
    const environmentKey = environmentSourceKeyForUserId(userId);
    expect(environmentKey).not.toBe(environmentSourceKeyForUserId(null));
    const agent = await agentOn("opencode", userId);
    const { backend } = agent;
    const replies: string[] = [];
    for (const outcome of [
      "reloaded",
      "pending",
      new Error("reload-failure-canary"),
    ] as Outcome[]) {
      backend.outcome = outcome;
      const lines = await agent.run();
      // The member sees what they typed, then the outcome.
      expect(lines[0]).toMatchObject({
        kind: "user_message",
        content: "/reload-plugins",
      });
      const outcomeLines = lines.slice(1);
      expect(outcomeLines.length, `one line for ${String(outcome)}`).toBe(1);
      replies.push(outcomeLines[0].content);
      if (outcome === "reloaded") {
        // The menu is rebuilt with the reload.
        home.install("added");
      }
    }
    removeManagedUserEnv(userId);
    expect(backend.reloads).toEqual([
      { environmentKey },
      { environmentKey },
      { environmentKey },
    ]);
    expect(new Set(replies).size).toBe(3);
    // The failure line carries the engine's error, so it is not a refusal.
    expect(replies[2]).toContain("reload-failure-canary");
    expect(agent.lastMenu()).toEqual(["added:s-added", "disk:s-disk"]);
  });
});

it("is offered in autocomplete on every engine", () => {
  const offered = (engine: AgentBackendType) =>
    autocompleteCommands(engine).some(
      (command) => command.name === "reload-plugins",
    );
  expect(offered("opencode")).toBe(true);
  expect(offered("claude")).toBe(true);
  expect(offered("codex")).toBe(true);
});

describe("account-synced skills in the Sk menu", () => {
  // The names the tests look for among the menu's other entries.
  const SYNCED = [
    "docx",
    "pdf",
    "fresh",
    "late-skill",
    "anthropic-skills:deep-research",
    "mcp__srv__prompt",
    "clear",
  ];

  it("lists the folder without a process, the process's rows with one, and runs a live pick in the process", async () => {
    const home = claudeHome();
    syncSkills(home.cfg, ["docx", "pdf"]);
    const agent = await agentOn("claude", "user-synced-live");
    expect(agent.skillsNamed(SYNCED)).toEqual(["docx", "pdf"]);
    agent.backend.initCommands = ["docx", "anthropic-skills:deep-research"];
    agent.backend.rows = [
      { name: "docx", description: "Docs", aliases: ["anthropic-skills:docx"] },
      // A synced skill whose name collides with a built-in one.
      { name: "anthropic-skills:deep-research", description: "Research" },
      { name: "clear", description: "Clear", builtin: true },
      { name: "mcp__srv__prompt", description: "An MCP prompt" },
    ];
    await agent.startSession(true);
    await waitUntil(
      () =>
        agent.skillsNamed(SYNCED).includes("anthropic-skills:deep-research"),
      "rows in the menu",
    );
    // The rows replace the folder: "pdf" is on disk, but this process does
    // not offer it.
    expect(agent.skillsNamed(SYNCED)).toEqual([
      "anthropic-skills:deep-research",
      "docx",
    ]);
    const docx = agent.lastSkills().find((skill) => skill.name === "docx");
    expect(docx?.description).toBe("Docs");
    expect(docx?.origin).toBe("user");

    // A pick goes to the process, which runs its own skill.
    const session = agent.backend.sessionForAgent(agent.id)!;
    const sentBefore = session.sent.length;
    void agent.mgr.sendMessage(agent.id, "/docx", "tester");
    await waitUntil(() => session.sent.length > sentBefore, "native send");
    expect(session.sent.at(-1)?.text).toContain("/docx");
    expect(session.sent.at(-1)?.text).not.toContain("docx prompt");
    session.completeTurn();
    await waitUntil(
      () => agent.mgr.getAgent(agent.id)?.state !== "thinking",
      "native turn end",
    );

    // A reload's rows replace the init's.
    agent.backend.nextSessionReload = async () =>
      reloadOf([], { commands: [{ name: "fresh", description: "Fresh" }] });
    await agent.run();
    expect(agent.skillsNamed(SYNCED)).toEqual(["fresh"]);

    // /clear: no process, so the folder again.
    await agent.run("/clear");
    expect(agent.skillsNamed(SYNCED)).toEqual(["docx", "pdf"]);
  });

  it("drops rows that arrive after the session that listed them is gone", async () => {
    const home = claudeHome();
    syncSkills(home.cfg, ["docx", "pdf"]);
    const agent = await agentOn("claude", "user-synced-race");
    let answer!: (rows: CommandRow[]) => void;
    agent.backend.nextListCommands = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const session = await agent.startSession(true);
    await waitUntil(() => agent.backend.listCalls === 1, "rows asked");
    await agent.run("/clear");
    expect(session.closed).toBe(true);
    answer([{ name: "late-skill", description: "Late" }]);
    await drain();
    expect(agent.skillsNamed(SYNCED)).toEqual(["docx", "pdf"]);
    // Nothing was kept for a later rebuild either.
    await agent.run();
    expect(agent.skillsNamed(SYNCED)).toEqual(["docx", "pdf"]);
  });

  it("the member's own skill of the same name wins, in the menu as in a pick", async () => {
    const home = claudeHome();
    syncSkills(home.cfg, ["pdf"]);
    const own = join(home.cfg, "skills", "pdf");
    mkdirSync(own, { recursive: true });
    writeFileSync(
      join(own, "SKILL.md"),
      `---\nname: pdf\ndescription: my pdf\n---\nmy pdf prompt\n`,
    );
    const agent = await agentOn("claude", "user-synced-own");
    const pdfs = () =>
      agent
        .lastSkills()
        .filter((skill) => skill.name === "pdf")
        .map((skill) => skill.description);
    // The menu at spawn, and the menu a rebuild makes.
    expect(pdfs()).toEqual(["my pdf"]);
    const menusBefore = agent.menus().length;
    await agent.run();
    expect(agent.menus().length).toBeGreaterThan(menusBefore);
    expect(pdfs()).toEqual(["my pdf"]);
    void agent.mgr.sendMessage(agent.id, "/pdf", "tester");
    await waitUntil(
      () => (agent.backend.sessionForAgent(agent.id)?.sent.length ?? 0) > 0,
      "pick sent",
    );
    const session = agent.backend.sessionForAgent(agent.id)!;
    expect(session.sent[0].text).toContain("my pdf prompt");
    session.completeTurn();
  });
});
