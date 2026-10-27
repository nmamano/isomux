// Task b1d7ef93: an agent's own skill tool loads the skills its Sk menu
// lists, on Claude, Codex and OpenCode alike. A session start builds the
// member's skill folder for the engine and the provider root the agent runs
// on, and hands it to the engine: Claude as an additional directory, Codex as
// a skills extra root, OpenCode as its skill paths. No member's skill reaches
// another member's agent, and isomux writes into no provider home.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { personalProviderHome } from "../provider-homes.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";
import { ISOMUX_CODEX_HOME } from "../backends/codex/native-bin.ts";
import { getAgentHost, setAgentHost } from "../agent-host.ts";

type Engine = "claude" | "codex" | "opencode";
const BUNDLED = ["figure-it-out", "grill-me", "loose-ends", "wrap-session"];

// The process that runs the tests may name its own provider homes, and its
// HOME is the real one: the session env would read both.
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  HOME: process.env.HOME,
};
const restore: (() => void)[] = [];
afterEach(() => {
  restore.splice(0).forEach((undo) => undo());
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

function skillFolder(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}
function commandFile(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text);
}
const names = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
};

// A manager with box roots, a HOME and bundled skills under the test state
// root. Members in `personal` have their personal provider homes active; a
// test may add one later.
function setup(
  tag: string,
  personal: string[] = [],
  // The box Claude root at $HOME/.claude, as in production.
  { boxClaudeInHome = false } = {},
) {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  const home = join(STATE_ROOT, `msf-${tag}-home`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  const box = {
    claude: boxClaudeInHome
      ? join(home, ".claude")
      : join(STATE_ROOT, `msf-${tag}-box-claude`),
    codex: join(STATE_ROOT, `msf-${tag}-box-codex`),
  };
  const bundled = join(STATE_ROOT, `msf-${tag}-bundled`);
  for (const name of BUNDLED)
    skillFolder(join(bundled, name), `bundled ${name}`);
  // The office's own Codex home is one per test process.
  expect(resolve(ISOMUX_CODEX_HOME).startsWith(resolve(STATE_ROOT))).toBe(true);
  rmSync(join(ISOMUX_CODEX_HOME, "skills"), { recursive: true, force: true });
  const active = new Set(personal);
  const previous = setPersonalProviderActiveProvider((userId) =>
    active.has(userId),
  );
  restore.push(() => setPersonalProviderActiveProvider(previous));
  // What the folder held at each reloadSkills call: [agentId, names].
  const reloads: [string, string[]][] = [];
  const fake = new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      onReloadSkills: (s) =>
        reloads.push([s.opts.agentId, names(s.opts.skillFolder ?? "")]),
    },
  });
  const room = `room-msf-${tag}`;
  const rooms: RoomWire[] = [
    { id: room, name: room, prompt: null, canCloseWhenEmpty: false },
  ];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms: [],
    providerSkillSourceRoots: box,
    bundledSkillsDir: bundled,
  });
  mgr.configureAgentTurnDeps();

  let spawned = 0;
  // A spawn is lazy: the first message starts the session.
  const start = async (
    agentType: Engine,
    memberId: string,
    cwd = STATE_ROOT,
  ): Promise<{ id: string; session: FakeSession }> => {
    const info = (await mgr.spawn(
      `${agentType} ${tag} ${++spawned}`,
      cwd,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      agentType === "opencode" ? "gate/gate-model" : undefined,
      "high",
      "Owner",
      agentType,
      undefined,
      memberId,
    ))!;
    void mgr.sendMessage(info.id, "hello", "Owner");
    const deadline = Date.now() + 2_000;
    while (!fake.sessionForAgent(info.id) && Date.now() < deadline)
      await Bun.sleep(5);
    const session = fake.sessionForAgent(info.id);
    expect([agentType, session !== undefined]).toEqual([agentType, true]);
    return { id: info.id, session: session! };
  };

  // The folder the engine was given: Claude's additional directory, Codex's
  // extra root, OpenCode's one skill path.
  const given = (agentType: Engine, session: FakeSession): string => {
    const path =
      agentType === "opencode"
        ? session.opts.skillPaths?.[0]
        : session.opts.skillFolder;
    expect([agentType, typeof path]).toEqual([agentType, "string"]);
    if (agentType === "opencode")
      expect(session.opts.skillPaths).toHaveLength(1);
    return path!;
  };
  // The names the engine loads from that folder.
  const loadable = (agentType: Engine, session: FakeSession): string[] => {
    const path = given(agentType, session);
    if (agentType !== "claude") return names(path);
    return [
      ...names(join(path, ".claude", "skills")),
      ...names(join(path, ".claude", "commands")).map((name) =>
        name.replace(/\.md$/, ""),
      ),
    ].sort();
  };
  // The text the engine reads for one name.
  const text = (agentType: Engine, session: FakeSession, name: string) => {
    const path = given(agentType, session);
    if (agentType !== "claude")
      return readFileSync(join(path, name, "SKILL.md"), "utf8");
    const command = join(path, ".claude", "commands", `${name}.md`);
    return existsSync(command)
      ? readFileSync(command, "utf8")
      : readFileSync(join(path, ".claude", "skills", name, "SKILL.md"), "utf8");
  };
  // The Sk menu once the session's init has been read.
  const menu = async (agentId: string) => {
    const deadline = Date.now() + 2_000;
    const read = () => mgr.getAgentCommands(agentId).skills;
    while (
      !read().some((s) => s.name === "wrap-session") &&
      Date.now() < deadline
    )
      await Bun.sleep(5);
    return read();
  };
  return {
    mgr,
    fake,
    box,
    home,
    bundled,
    active,
    reloads,
    start,
    given,
    loadable,
    text,
    menu,
  };
}

describe("member skill folder at a session start", () => {
  it("never gives member A's personal skills to member B's Claude or Codex agent, and writes into no provider home", async () => {
    const A = "0d1e0001";
    const B = "0d1e0002";
    const h = setup("leak", [A]);
    const personalClaude = join(personalProviderHome(A, "claude"), "skills");
    const personalCodex = join(personalProviderHome(A, "codex"), "skills");
    skillFolder(join(personalClaude, "a-claude-private"), "A claude");
    skillFolder(join(personalCodex, "a-codex-private"), "A codex");
    mkdirSync(join(h.box.claude, "skills"), { recursive: true });

    const aClaude = await h.start("claude", A);
    const aCodex = await h.start("codex", A);
    const bClaude = await h.start("claude", B);
    const bCodex = await h.start("codex", B);

    // A runs on the personal homes, B on the shared ones.
    expect(aCodex.session.opts.env?.CODEX_HOME).toBe(
      personalProviderHome(A, "codex"),
    );
    expect(bCodex.session.opts.env?.CODEX_HOME).toBeUndefined();
    expect(bClaude.session.opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Member A's agents get A's skills from the other engine's home.
    expect(h.loadable("claude", aClaude.session)).toContain("a-codex-private");
    expect(h.loadable("codex", aCodex.session)).toContain("a-claude-private");
    for (const [agentType, agent] of [
      ["claude", bClaude],
      ["codex", bCodex],
    ] as const) {
      const loadable = h.loadable(agentType, agent.session);
      // The folder was built: it holds the bundled skills.
      expect([agentType, loadable]).toEqual([
        agentType,
        expect.arrayContaining(BUNDLED),
      ]);
      for (const name of ["a-claude-private", "a-codex-private"])
        expect([agentType, name, loadable.includes(name)]).toEqual([
          agentType,
          name,
          false,
        ]);
      expect(
        resolve(h.given(agentType, agent.session)).startsWith(
          resolve(STATE_ROOT, "member-skills", B),
        ),
      ).toBe(true);
      const menu = (await h.menu(agent.id)).map((s) => s.name);
      expect(menu).not.toContain("a-claude-private");
      expect(menu).not.toContain("a-codex-private");
    }
    // The shared homes and the personal homes got no links.
    expect(names(join(ISOMUX_CODEX_HOME, "skills"))).toEqual([]);
    expect(names(join(h.box.claude, "skills"))).toEqual([]);
    expect(names(personalClaude)).toEqual(["a-claude-private"]);
    expect(names(personalCodex)).toEqual(["a-codex-private"]);
  });

  it("gives each engine the box skills it does not read by itself, and leaves out the ones it does", async () => {
    const C = "0d1e0003";
    // OpenCode runs in the member's profile, whose HOME is not the server's:
    // the box ~/.claude/skills is no native folder for it.
    const h = setup("box", [], { boxClaudeInHome: true });
    skillFolder(join(h.box.claude, "skills", "box-claude"), "box claude");
    skillFolder(join(h.box.codex, "skills", "box-codex"), "box codex");
    // A Codex agent with no personal account runs on the office Codex home.
    skillFolder(
      join(ISOMUX_CODEX_HOME, "skills", "box-claude"),
      "office codex",
    );

    const claude = await h.start("claude", C);
    const codex = await h.start("codex", C);
    const opencode = await h.start("opencode", C);

    const sansBundled = (list: string[]) =>
      list.filter((name) => !BUNDLED.includes(name));
    expect(sansBundled(h.loadable("claude", claude.session))).toEqual([
      "box-codex",
    ]);
    expect(sansBundled(h.loadable("codex", codex.session))).toEqual([
      "box-codex",
    ]);
    expect(sansBundled(h.loadable("opencode", opencode.session))).toEqual([
      "box-claude",
      "box-codex",
    ]);
    for (const [agentType, agent] of [
      ["claude", claude],
      ["codex", codex],
      ["opencode", opencode],
    ] as const)
      expect([agentType, h.loadable(agentType, agent.session)]).toEqual([
        agentType,
        expect.arrayContaining(BUNDLED),
      ]);
  });

  it("gives a member's Claude command the name of the bundled skill on every engine", async () => {
    // On a personal home the box command is no native one on any engine, so
    // it reaches each of them through the folder.
    const M = "0d1e0005";
    const h = setup("command", [M]);
    commandFile(
      join(h.box.claude, "commands"),
      "wrap-session",
      "---\ndescription: member wrap\n---\nmember wrap body $ARGUMENTS\n",
    );
    for (const agentType of ["claude", "codex", "opencode"] as const) {
      const agent = await h.start(agentType, M);
      if (agentType === "claude")
        expect(agent.session.opts.env?.CLAUDE_CONFIG_DIR).toBe(
          personalProviderHome(M, "claude"),
        );
      const body = h.text(agentType, agent.session, "wrap-session");
      expect([agentType, body.includes("member wrap body")]).toEqual([
        agentType,
        true,
      ]);
      expect([agentType, body.includes("bundled wrap-session")]).toEqual([
        agentType,
        false,
      ]);
      if (agentType === "claude")
        expect(
          existsSync(
            join(
              h.given("claude", agent.session),
              ".claude",
              "skills",
              "wrap-session",
            ),
          ),
        ).toBe(false);
      const row = (await h.menu(agent.id)).find(
        (s) => s.name === "wrap-session",
      );
      expect([agentType, row?.origin]).toEqual([agentType, "user"]);
    }
  });

  it("gives two Claude agents of one member on different provider roots a folder each, matching each one's own menu", async () => {
    const M = "0d1e0004";
    const h = setup("variant");
    skillFolder(join(h.box.claude, "skills", "box-skill"), "box");
    skillFolder(
      join(personalProviderHome(M, "claude"), "skills", "personal-skill"),
      "personal",
    );

    // The first agent starts on the box Claude root, which it reads itself.
    const first = await h.start("claude", M);
    // The member signs in; the next agent runs on the personal home, where
    // the box skill is no native one.
    h.active.add(M);
    const second = await h.start("claude", M);

    // The two run on different provider roots.
    expect(first.session.opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(second.session.opts.env?.CLAUDE_CONFIG_DIR).toBe(
      personalProviderHome(M, "claude"),
    );
    expect(h.given("claude", first.session)).not.toBe(
      h.given("claude", second.session),
    );
    expect(h.loadable("claude", second.session)).toContain("box-skill");
    expect(h.loadable("claude", second.session)).not.toContain(
      "personal-skill",
    );
    // The second build did not change the first agent's folder.
    expect(h.loadable("claude", first.session)).not.toContain("box-skill");
  });

  it("brings a skill added later into a running agent's folder at a menu refresh, and has Codex reload its skills after that", async () => {
    const h = setup("refresh");
    const claude = await h.start("claude", "0d1e0006");
    const codex = await h.start("codex", "0d1e0006");
    expect(h.loadable("codex", codex.session)).not.toContain("late");

    skillFolder(join(h.box.codex, "skills", "late"), "late");
    h.mgr.refreshSkillMenus();

    const deadline = Date.now() + 2_000;
    while (
      !(
        h.reloads.some(([id]) => id === codex.id) &&
        h.loadable("claude", claude.session).includes("late")
      ) &&
      Date.now() < deadline
    )
      await Bun.sleep(5);
    expect(h.loadable("claude", claude.session)).toContain("late");
    expect(h.loadable("codex", codex.session)).toContain("late");
    const codexReloads = h.reloads.filter(([id]) => id === codex.id);
    expect(codexReloads.length).toBeGreaterThan(0);
    expect(codexReloads.at(-1)![1]).toContain("late");
    expect((await h.menu(codex.id)).map((s) => s.name)).toContain("late");
  });

  it("builds no folder in split mode", async () => {
    const h = setup("split");
    const previous = getAgentHost();
    setAgentHost({ ...previous, kind: "runner" });
    restore.push(() => setAgentHost(previous));
    for (const agentType of ["claude", "codex", "opencode"] as const) {
      const agent = await h.start(agentType, "0d1e0007");
      expect([
        agentType,
        agent.session.opts.skillFolder,
        agent.session.opts.skillPaths,
      ]).toEqual([agentType, undefined, undefined]);
    }
    expect(existsSync(join(STATE_ROOT, "member-skills", "0d1e0007"))).toBe(
      false,
    );
  });
});

describe("Sk menu and /name per engine", () => {
  it("list each engine's own project folders, ~/.agents/skills on every engine and plugin and account-synced skills on Claude only, and /name runs only what the menu lists", async () => {
    const E = "0d1e0008";
    const h = setup("menu", [E]);
    const cwd = join(STATE_ROOT, "msf-menu-project");
    const body = (name: string) => `body of ${name}`;
    const project: [string, string][] = [
      [".claude/skills", "p-claude"],
      [".agents/skills", "p-agents"],
      [".opencode/skills", "p-opencode"],
      [".opencode/skill", "p-opencode-singular"],
      [".isomux/skills", "p-isomux"],
    ];
    for (const [dir, name] of project)
      skillFolder(
        join(cwd, dir, name),
        `---\ndescription: ${name}\n---\n${body(name)}\n`,
      );
    commandFile(
      join(cwd, ".claude", "commands"),
      "p-claude-cmd",
      body("p-claude-cmd"),
    );
    skillFolder(
      join(h.home, ".agents", "skills", "home-agents"),
      `---\ndescription: home agents\n---\n${body("home-agents")}\n`,
    );
    // ~/.agents/skills ranks after the engine's own user roots and before
    // the other engine's.
    skillFolder(
      join(h.home, ".agents", "skills", "ranked"),
      "---\ndescription: agents ranked\n---\nx\n",
    );
    skillFolder(
      join(h.box.claude, "skills", "ranked"),
      "---\ndescription: claude ranked\n---\nx\n",
    );
    // A plugin enabled in the member's Claude home.
    const claudeHome = personalProviderHome(E, "claude");
    const install = join(STATE_ROOT, "msf-menu-plugin");
    skillFolder(
      join(install, "skills", "do-work"),
      `---\ndescription: do work\n---\n${body("plugin do-work")}\n`,
    );
    mkdirSync(join(claudeHome, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "helper@test": [{ installPath: install }] },
      }),
    );
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ enabledPlugins: { "helper@test": true } }),
    );
    // An account-synced skill on disk in the member's Claude home: only
    // Claude loads it (the fake session reports no command rows, so the
    // menu reads the disk).
    skillFolder(
      join(claudeHome, "skills", "synced", "bucket", "acct-sync"),
      `---\ndescription: account sync\n---\n${body("acct-sync")}\n`,
    );

    const expected: Record<
      Engine,
      { project: string[]; claudeOnly: boolean; ranked: string }
    > = {
      claude: {
        project: ["p-claude", "p-claude-cmd"],
        claudeOnly: true,
        ranked: "claude ranked",
      },
      codex: {
        project: ["p-agents"],
        claudeOnly: false,
        ranked: "agents ranked",
      },
      opencode: {
        project: ["p-agents", "p-claude", "p-opencode", "p-opencode-singular"],
        claudeOnly: false,
        ranked: "claude ranked",
      },
    };
    const typed = [
      "p-claude",
      "p-claude-cmd",
      "p-agents",
      "p-opencode",
      "p-isomux",
      "home-agents",
      "helper:do-work",
      "acct-sync",
    ];
    for (const agentType of ["claude", "codex", "opencode"] as const) {
      const agent = await h.start(agentType, E, cwd);
      const menu = await h.menu(agent.id);
      const want = expected[agentType];
      expect([
        agentType,
        menu
          .filter((s) => s.origin === "project")
          .map((s) => s.name)
          .sort(),
      ]).toEqual([agentType, want.project]);
      expect([
        agentType,
        menu.some((s) => s.name === "home-agents" && s.origin === "user"),
      ]).toEqual([agentType, true]);
      // The spawn's menu, and the menu a refresh discovers again.
      h.mgr.refreshSkillMenus();
      const refreshed = h.mgr.getAgentCommands(agent.id).skills;
      expect([
        agentType,
        refreshed.some((s) => s.name === "wrap-session"),
      ]).toEqual([agentType, true]);
      for (const [when, list] of [
        ["spawn", menu],
        ["refresh", refreshed],
      ] as const)
        for (const name of ["helper:do-work", "acct-sync"])
          expect([
            agentType,
            when,
            name,
            list.some((s) => s.name === name),
          ]).toEqual([agentType, when, name, want.claudeOnly]);
      expect([
        agentType,
        menu.find((s) => s.name === "ranked")?.description,
      ]).toEqual([agentType, want.ranked]);

      for (const name of typed)
        await h.mgr.sendMessage(agent.id, `/${name}`, "Owner");
      await h.mgr.sendMessage(agent.id, "last message", "Owner");
      const deadline = Date.now() + 3_000;
      const sent = () => agent.session.sent.map((m) => m.text).join("\n");
      while (!sent().includes("last message") && Date.now() < deadline)
        await Bun.sleep(5);
      expect([agentType, sent().includes("last message")]).toEqual([
        agentType,
        true,
      ]);
      const listed = new Set(menu.map((s) => s.name));
      for (const name of typed) {
        const bodyName = name === "helper:do-work" ? "plugin do-work" : name;
        expect([agentType, name, sent().includes(body(bodyName))]).toEqual([
          agentType,
          name,
          listed.has(name),
        ]);
      }
    }
  });
});
