// An isolated member's skills in their agents (part 2d-iii-a of task
// b94dfd25). The properties:
// - their roots are their own homes: no box root and no STATE_ROOT/skills;
// - the office takes the runner's lists and bodies only in the agreed shape
//   and bounds (one bad entry refuses the whole reply), and every call has a
//   time bound;
// - for a member, resolveSkillPrompt reads no file but the bundled skills,
//   and keeps the order user, project, bundled, synced;
// - the runner reads the member's roots in order, the synced skills only for
//   Claude without live rows, and a plugin only through its reported path.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";
import { STATE_ROOT } from "../config.ts";
import { buildEnvForUserId } from "../env-loader.ts";
import { memberUserSkillRoots } from "../provider-skill-links.ts";
import {
  fetchUserSkillLists,
  fetchUserSkillPrompt,
  parseUserSkillBody,
  parseUserSkillLists,
  USER_SKILL_TIMEOUT_MS,
} from "../member-user-skills.ts";
import {
  readUserSkillBody,
  scanUserSkillLists,
  type UserSkillScanInput,
} from "../user-skill-scan.ts";
import { resolveSkillPrompt } from "../skills.ts";
import type { AgentHost } from "../agent-host.ts";
import { createMember, deleteUserById } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import { createAgentSkills, type AgentSkillsDeps } from "../agent-skills.ts";
import type { ManagedAgent } from "../internal-types.ts";
import {
  engineSkillPath,
  type MemberSkillFolderInput,
} from "../member-skill-folder-host.ts";
import { removeStateDir } from "./temp-state.ts";

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
function skill(root: string, name: string, body: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), body);
}
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const under = (path: string, dir: string) =>
  resolve(path) === resolve(dir) ||
  resolve(path).startsWith(resolve(dir) + sep);

describe("memberUserSkillRoots", () => {
  let iso: IsolatedMember;
  let alice: string;
  beforeEach(async () => {
    const made = createMember(`SkillRootsAlice${Date.now()}`, {
      role: "member",
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.user.id;
    iso = await isolateMember(alice);
  });
  afterEach(() => {
    iso.dispose();
    deleteUserById(alice);
  });

  for (const engine of ["claude", "codex", "opencode"] as const)
    it(`${engine}: only the member's own folders, never the box roots or STATE_ROOT`, () => {
      const env = buildEnvForUserId(alice);
      const roots = memberUserSkillRoots(engine, alice, env);
      expect(roots.length).toBeGreaterThan(0);
      const space = iso.member.host.agentRoot();
      for (const { root } of roots)
        expect([root, under(root, iso.home) || under(root, space)]).toEqual([
          root,
          true,
        ]);
      const all = roots.map((r) => resolve(r.root));
      expect(all).not.toContain(resolve(homedir(), ".claude"));
      expect(all).not.toContain(resolve(homedir(), ".codex"));
      expect(all.some((r) => under(r, STATE_ROOT))).toBe(false);
    });

  it("is empty without a member env", () => {
    expect(memberUserSkillRoots("claude", alice, undefined)).toEqual([]);
    expect(memberUserSkillRoots("claude", alice, process.env)).toEqual([]);
  });
});

describe("the runner's user-skills reply", () => {
  const meta = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    kind: "skill",
    ...extra,
  });
  const reply = (over: Record<string, unknown> = {}) => ({
    user: [meta("own", { description: "mine" })],
    plugin: [meta("plug:tool")],
    synced: [{ name: "synced-one", kind: "command" }],
    ...over,
  });

  it("takes a reply in shape", () => {
    expect(parseUserSkillLists(reply(), "claude")).toEqual({
      user: [{ name: "own", kind: "skill", description: "mine" }],
      plugin: [{ name: "plug:tool", kind: "skill" }],
      synced: [{ name: "synced-one", kind: "command" }],
    });
    expect(
      parseUserSkillLists(reply({ plugin: [], synced: [] }), "codex"),
    ).not.toBeNull();
  });

  const bad: [string, unknown, "claude" | "codex"][] = [
    ["a user name with /", reply({ user: [meta("a/b")] }), "claude"],
    ["a user name of ..", reply({ user: [meta("..")] }), "claude"],
    ["a user name with :", reply({ user: [meta("a:b")] }), "claude"],
    [
      "a user name with a control character",
      reply({ user: [meta("a\nb")] }),
      "claude",
    ],
    ["a synced name with /", reply({ synced: [meta("../x")] }), "claude"],
    ["a plugin name without :", reply({ plugin: [meta("plain")] }), "claude"],
    ["a plugin name with two :", reply({ plugin: [meta("a:b:c")] }), "claude"],
    ["a plugin name with /", reply({ plugin: [meta("a:b/c")] }), "claude"],
    ["plugin skills for Codex", reply({ synced: [] }), "codex"],
    ["synced skills for Codex", reply({ plugin: [] }), "codex"],
    [
      "an unknown kind",
      reply({ user: [meta("own", { kind: "file" })] }),
      "claude",
    ],
    [
      "a path in an entry",
      reply({ user: [meta("own", { path: "/etc/x" })] }),
      "claude",
    ],
    ["an extra list", { ...reply(), other: [] }, "claude"],
    ["a missing list", { user: [], plugin: [] }, "claude"],
    [
      "a description over the text bound",
      reply({ user: [meta("own", { description: "x".repeat(1025) })] }),
      "claude",
    ],
    [
      "a list over the entry bound",
      reply({ user: Array.from({ length: 201 }, (_, i) => meta(`s${i}`)) }),
      "claude",
    ],
    ["not a record", [], "claude"],
  ];
  for (const [what, value, engine] of bad)
    it(`refuses the whole reply for ${what}`, () => {
      expect(parseUserSkillLists(value, engine)).toBeNull();
    });
});

describe("the runner's user-skill reply", () => {
  it("takes the body of the skill it asked for, without its frontmatter", () => {
    expect(
      parseUserSkillBody(
        { name: "own", from: "user", body: "---\nname: own\n---\n\nDo it.\n" },
        "own",
      ),
    ).toEqual({ kind: "ok", from: "user", prompt: "Do it." });
    expect(parseUserSkillBody({ name: "own", missing: true }, "own")).toEqual({
      kind: "missing",
    });
  });

  const failed: [string, unknown, string][] = [
    ["another skill's body", { name: "other", from: "user", body: "x" }, "own"],
    [
      "a plugin body for a plain name",
      { name: "own", from: "plugin", body: "x" },
      "own",
    ],
    [
      "a user body for a plugin name",
      { name: "p:s", from: "user", body: "x" },
      "p:s",
    ],
    ["an unknown origin", { name: "own", from: "office", body: "x" }, "own"],
    [
      "a body over the bound",
      { name: "own", from: "user", body: "x".repeat(256 * 1024 + 1) },
      "own",
    ],
    [
      "an extra key",
      { name: "own", from: "user", body: "x", path: "/x" },
      "own",
    ],
    ["missing that is not true", { name: "own", missing: false }, "own"],
  ];
  for (const [what, value, name] of failed)
    it(`fails for ${what}`, () => {
      expect(parseUserSkillBody(value, name).kind).toBe("failed");
    });
});

describe("the runner calls", () => {
  const input: UserSkillScanInput = {
    engine: "claude",
    cwd: "/work",
    roots: [{ root: "/home/alice/.claude", includeCommands: true }],
    claudeConfigDir: "/home/alice/.claude",
    plugins: null,
    synced: true,
  };
  function host(answer: () => Promise<unknown>) {
    const calls: { name: string; timeoutMs: unknown }[] = [];
    return {
      calls,
      host: {
        member: "u-alice",
        runEntry: (name: string, _input: unknown, timeoutMs?: number) => {
          calls.push({ name, timeoutMs });
          return answer();
        },
      } as unknown as AgentHost,
    };
  }

  it("give each call a time bound, and read a call that fails or times out as no answer", async () => {
    const timedOut = () =>
      Promise.reject(
        Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      );
    const lists = host(timedOut);
    expect(await fetchUserSkillLists(lists.host, input)).toBeNull();
    const body = host(timedOut);
    expect((await fetchUserSkillPrompt(body.host, input, "own")).kind).toBe(
      "failed",
    );
    for (const call of [...lists.calls, ...body.calls]) {
      expect(typeof call.timeoutMs).toBe("number");
      expect(call.timeoutMs as number).toBeGreaterThan(0);
      expect(call.timeoutMs as number).toBeLessThanOrEqual(
        USER_SKILL_TIMEOUT_MS,
      );
    }
    expect(lists.calls.map((c) => c.name)).toEqual(["user-skills"]);
    expect(body.calls.map((c) => c.name)).toEqual(["user-skill"]);
  });

  it("asks for no body of a name outside the rule", async () => {
    const h = host(async () => ({ name: "a/b", from: "user", body: "x" }));
    expect((await fetchUserSkillPrompt(h.host, input, "a/b")).kind).toBe(
      "missing",
    );
    expect(h.calls).toEqual([]);
  });
});

describe("resolveSkillPrompt for a member's agent", () => {
  const STATE_SKILL = `state-only-${process.pid}`;
  let root: string;
  beforeEach(() => {
    skill(join(STATE_ROOT), STATE_SKILL, "STATE BODY");
    root = tmp("member-skill-root-");
    skill(root, "root-only", "ROOT BODY");
  });
  afterEach(() => removeStateDir(join(STATE_ROOT, "skills", STATE_SKILL)));

  const none = { user: null, project: null, synced: null };
  const resolveAs = (
    name: string,
    member: {
      user: string | null;
      project: string | null;
      synced: string | null;
    },
    engine: "claude" | "codex" = "claude",
  ) =>
    resolveSkillPrompt(
      name,
      root,
      engine,
      [{ root, includeCommands: true }],
      true,
      root,
      null,
      null,
      member,
    );

  it("reads no STATE_ROOT skill and no root with the office's files", () => {
    // The enabling condition: without `member` the office reads both.
    expect(
      resolveSkillPrompt(STATE_SKILL, root, "claude", [
        { root, includeCommands: true },
      ]),
    ).toBe("STATE BODY");
    expect(
      resolveSkillPrompt("root-only", root, "claude", [
        { root, includeCommands: true },
      ]),
    ).toBe("ROOT BODY");
    expect(resolveAs(STATE_SKILL, none)).toBeNull();
    expect(resolveAs("root-only", none)).toBeNull();
  });

  it("keeps the order user, project, bundled, synced", () => {
    const bundledName = "wrap-session";
    const bundled = resolveAs(bundledName, none);
    expect(bundled).not.toBeNull();
    expect(
      resolveAs(bundledName, {
        user: "USER",
        project: "PROJECT",
        synced: "SYNCED",
      }),
    ).toBe("USER");
    expect(
      resolveAs(bundledName, {
        user: null,
        project: "PROJECT",
        synced: "SYNCED",
      }),
    ).toBe("PROJECT");
    expect(
      resolveAs(bundledName, { user: null, project: null, synced: "SYNCED" }),
    ).toBe(bundled);
    expect(
      resolveAs("not-bundled", { user: null, project: null, synced: "SYNCED" }),
    ).toBe("SYNCED");
  });

  it("gives a plugin name only the runner's plugin body, and only on Claude", () => {
    expect(resolveAs("p:s", { ...none, user: "PLUGIN" })).toBe("PLUGIN");
    expect(resolveAs("p:s", { ...none, user: "PLUGIN" }, "codex")).toBeNull();
    expect(resolveAs("p:s", none)).toBeNull();
  });
});

describe("the runner's scan and read, as the member", () => {
  function input(over: Partial<UserSkillScanInput> = {}): UserSkillScanInput {
    const first = tmp("member-root-a-");
    const second = tmp("member-root-b-");
    return {
      engine: "claude",
      cwd: tmp("member-cwd-"),
      roots: [
        { root: first, includeCommands: true },
        { root: second, includeCommands: false },
      ],
      claudeConfigDir: first,
      plugins: null,
      synced: true,
      ...over,
    };
  }

  it("reads the roots in order: the first root's skill wins", () => {
    const req = input();
    skill(req.roots[0].root, "both", "FIRST");
    skill(req.roots[1].root, "both", "SECOND");
    expect(readUserSkillBody(req, "both")).toEqual({
      name: "both",
      from: "user",
      body: "FIRST",
    });
    expect(scanUserSkillLists(req).user.map((s) => s.name)).toEqual(["both"]);
  });

  it("reads a command file only from a root with commands", () => {
    const req = input();
    for (const r of req.roots) {
      mkdirSync(join(r.root, "commands"), { recursive: true });
    }
    writeFileSync(join(req.roots[1].root, "commands", "cmd.md"), "NO");
    expect(readUserSkillBody(req, "cmd")).toEqual({
      name: "cmd",
      missing: true,
    });
    writeFileSync(join(req.roots[0].root, "commands", "cmd.md"), "YES");
    expect(readUserSkillBody(req, "cmd")).toMatchObject({ body: "YES" });
  });

  it("reads a plugin's skill through its reported path, and only on Claude", () => {
    const plugin = tmp("member-plugin-");
    skill(plugin, "tool", "PLUGIN BODY");
    const req = input({ plugins: [{ name: "plug", path: plugin }] });
    expect(readUserSkillBody(req, "plug:tool")).toEqual({
      name: "plug:tool",
      from: "plugin",
      body: "PLUGIN BODY",
    });
    expect(scanUserSkillLists(req).plugin.map((s) => s.name)).toEqual([
      "plug:tool",
    ]);
    const codex = { ...req, engine: "codex" as const };
    expect(readUserSkillBody(codex, "plug:tool")).toEqual({
      name: "plug:tool",
      missing: true,
    });
    expect(scanUserSkillLists(codex).plugin).toEqual([]);
  });

  it("reads the synced skills only for Claude, and only without live rows", () => {
    const req = input();
    const dir = join(
      req.claudeConfigDir,
      "skills",
      "synced",
      "bucket",
      "synced-one",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "SYNCED");
    expect(scanUserSkillLists(req).synced.map((s) => s.name)).toEqual([
      "synced-one",
    ]);
    expect(readUserSkillBody(req, "synced-one")).toEqual({
      name: "synced-one",
      from: "synced",
      body: "SYNCED",
    });
    for (const other of [
      { ...req, synced: false },
      { ...req, engine: "codex" as const },
    ]) {
      expect(scanUserSkillLists(other).synced).toEqual([]);
      expect(readUserSkillBody(other, "synced-one")).toEqual({
        name: "synced-one",
        missing: true,
      });
    }
  });

  it("refuses a body over the bound", () => {
    const req = input();
    skill(req.roots[0].root, "big", "x".repeat(256 * 1024 + 1));
    expect(() => readUserSkillBody(req, "big")).toThrow();
  });

  it("leaves out a name outside the rule from the list", () => {
    const req = input();
    skill(req.roots[0].root, "ok-name", "x");
    skill(req.roots[0].root, "has:colon", "x");
    expect(scanUserSkillLists(req).user.map((s) => s.name)).toEqual([
      "ok-name",
    ]);
  });
});

// F1 of round 1: after a skill save, a member's Codex reads its skill folder
// again only once the runner's rebuild answered with the folder, and not
// after a failed build.
describe("a skill refresh of a member's Codex agent", () => {
  let iso: IsolatedMember;
  let alice: string;
  beforeEach(async () => {
    const made = createMember(`SkillRefreshAlice${Date.now()}`, {
      role: "member",
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.user.id;
    iso = await isolateMember(alice);
  });
  afterEach(() => {
    iso.dispose();
    deleteUserById(alice);
  });

  async function refreshWith(answer: "path" | "fail") {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const host = iso.member.host as unknown as {
      runEntry: (name: string, input: unknown) => Promise<unknown>;
    };
    host.runEntry = async (name: string, input: unknown) => {
      if (name !== "skill-folder") throw new Error("not in this test");
      events.push("build asked");
      await gate;
      events.push("build answered");
      if (answer === "fail") throw new Error("runner failed");
      return { path: engineSkillPath(input as MemberSkillFolderInput) };
    };
    const env = buildEnvForUserId(alice);
    const agents = new Map<string, ManagedAgent>();
    agents.set("a1", {
      info: { id: "a1", agentType: "codex", userId: alice },
      sessionManager: {
        session: {
          reloadSkills: async () => {
            events.push("reload");
          },
        },
      },
      launchedSkillFolder: "/launched",
      launchedSkillEnv: env,
      slashCommands: [],
    } as unknown as ManagedAgent);
    const skills = createAgentSkills({
      agents,
      emit: () => {},
      getBackend: () => ({}) as never,
      agentMcpServers: () => ({}) as never,
      claudeConfigDirFor: () => join(iso.home, ".claude"),
      userSkillRootsForInfo: () => [],
      buildSessionEnv: () => env,
      officeWanted: () => false,
      providerSkillSourceRoots: undefined,
      bundledSkillsDir: undefined,
    } as unknown as AgentSkillsDeps);
    skills.refreshSkillMenu("a1");
    await Bun.sleep(50);
    const beforeAnswer = [...events];
    release();
    await Bun.sleep(50);
    return { beforeAnswer, events };
  }

  it("reads the folder again only after the build answered with the path", async () => {
    const { beforeAnswer, events } = await refreshWith("path");
    // The enabling condition: the refresh asked the runner for a build.
    expect(beforeAnswer).toContain("build asked");
    expect(beforeAnswer).not.toContain("reload");
    expect(events.filter((e) => e === "reload")).toEqual(["reload"]);
    expect(events.indexOf("reload")).toBeGreaterThan(
      events.lastIndexOf("build answered"),
    );
  });

  it("does not read it again after a failed build", async () => {
    const { beforeAnswer, events } = await refreshWith("fail");
    expect(beforeAnswer).toContain("build asked");
    expect(events).toContain("build answered");
    expect(events).not.toContain("reload");
  });
});
