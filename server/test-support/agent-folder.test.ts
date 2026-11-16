// The agent's folder for an isolated member (internal-docs/member-os-user-design.md,
// section 3.3; task b94dfd25 part 2b-ii). The folder of a member's agent is
// the member's: `~` and a relative path resolve against the member's home,
// and the folder is checked through the member's host, never with a stat
// of the office's file system. An office agent's folder is resolved and
// checked as before (C6). A member host that is not ready never gives a
// home to resolve against (D1). The reply validators of the runner's
// project-skill entries take only the agreed shape and bounds (C5, D5).
//
// The member host's fs here is a recorder over the local fs, with a set of
// paths it answers itself: a path that only the member host has is a
// folder the office cannot stat, so an office stat shows red.
//
// What each test pins, and the mutant it was seen red on, is named above it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { AgentFileStat, AgentFs, AgentHost } from "../agent-host.ts";
import {
  localAgentFs,
  officeAgentHost,
  setOfficeAgentHost,
} from "../agent-host.ts";
import { resolveCwd } from "../cwd-utils.ts";
import { hostFor } from "../member-hosts.ts";
import { forgetMemberOsUser, recordMemberOsUser } from "../member-os-users.ts";
import { createMember, deleteUserById } from "../users.ts";
import {
  agentCwdProblem,
  memberFolderHost,
  readShareCommands,
  resolveAgentCwd,
  validateAgentCwd,
} from "../agent-folder.ts";
import { memberFolderHint } from "../member-folder-hint.ts";
import { readProjectSkillBody } from "../project-skill-scan.ts";
import {
  fetchProjectSkillPrompt,
  parseProjectSkillBody,
  parseProjectSkillList,
  PROJECT_SKILL_BODY_MAX,
  PROJECT_SKILL_LIST_MAX,
  PROJECT_SKILL_TEXT_MAX,
} from "../member-project-skills.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

let iso: IsolatedMember;
let alice: string;
let bob: string;
let carol: string;
const created: string[] = [];
let fsCalls: { op: string; path: string }[];
// Paths only the member host answers for, with what its stat gives.
let memberOnly: Map<string, AgentFileStat | NodeJS.ErrnoException>;
// What the member host's enter gives for a path, when it is not a plain
// yes: a folder the member stats but cannot enter (another user's 700).
let noEnter: Map<string, NodeJS.ErrnoException>;

function member(name: string): string {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: rig stat`), { code });

function recordingFs(): AgentFs {
  const passthrough = <K extends keyof AgentFs>(op: K): AgentFs[K] =>
    ((path: string, ...rest: unknown[]) => {
      fsCalls.push({ op, path });
      return (localAgentFs[op] as (...a: unknown[]) => unknown)(path, ...rest);
    }) as AgentFs[K];
  return {
    readText: passthrough("readText"),
    writeText: passthrough("writeText"),
    mkdir: passthrough("mkdir"),
    rm: passthrough("rm"),
    exists: passthrough("exists"),
    chmod: passthrough("chmod"),
    readBytes: passthrough("readBytes"),
    realpath: passthrough("realpath"),
    stat: async (path) => {
      fsCalls.push({ op: "stat", path });
      const own = memberOnly.get(path);
      if (own instanceof Error) throw own;
      if (own) return own;
      return localAgentFs.stat(path);
    },
    enter: async (path) => {
      fsCalls.push({ op: "enter", path });
      const refused = noEnter.get(path);
      if (refused) throw refused;
      if (memberOnly.has(path)) return;
      return localAgentFs.enter(path);
    },
  };
}

const dirStat: AgentFileStat = { type: "dir", size: 0, mtimeMs: 0, ino: 1 };
const fileStat: AgentFileStat = { type: "file", size: 1, mtimeMs: 0, ino: 2 };

let scratch: string;

beforeEach(async () => {
  fsCalls = [];
  memberOnly = new Map();
  noEnter = new Map();
  alice = member(`FolderAlice${created.length}`);
  bob = member(`FolderBob${created.length}`);
  carol = member(`FolderCarol${created.length}`);
  iso = await isolateMember(alice);
  (iso.member.host as { fs: AgentFs }).fs = recordingFs();
  // Carol has an OS user, but her runner never connected: not ready.
  recordMemberOsUser(carol, { name: "isomux-test-carol", uid: 4343 });
  scratch = join(tmpdir(), `agent-folder-${crypto.randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  forgetMemberOsUser(carol);
  iso.dispose();
  for (const id of created.splice(0)) deleteUserById(id);
});

describe("which owner's folder rules apply", () => {
  // MUTANT: the test on the host's kind (an office in split mode runs a
  // runner host too, with no member).
  it("is the member's host only for an isolated member, ready or not", () => {
    expect(memberFolderHost(alice)).toBe(hostFor(alice));
    expect(memberFolderHost(bob)).toBeNull();
    expect(memberFolderHost(null)).toBeNull();
    expect(memberFolderHost(carol)?.member).toBe(carol);
    // An office in split mode: its host is a runner with no member.
    const before = officeAgentHost();
    setOfficeAgentHost({ ...before, kind: "runner" } as AgentHost);
    try {
      expect(hostFor(bob).kind).toBe("runner");
      expect(memberFolderHost(bob)).toBeNull();
    } finally {
      setOfficeAgentHost(before);
    }
  });
});

describe("resolveAgentCwd", () => {
  // C6. MUTANT: the member branch taken for every owner.
  it("resolves an office agent's folder as before", () => {
    for (const cwd of ["~", "~/sub", "/abs/x", "/abs/../y", "rel/x"])
      expect([cwd, resolveAgentCwd(cwd, bob)]).toEqual([cwd, resolveCwd(cwd)]);
    expect(resolveAgentCwd("~", null)).toBe(homedir());
  });

  // C3, D2. MUTANTS: `~` against the office's home; a relative path
  // against the server's process folder.
  it("resolves a member's `~`, `~/x` and relative path against the member's home", () => {
    expect(resolveAgentCwd("~", alice)).toBe(iso.home);
    expect(resolveAgentCwd("~/sub", alice)).toBe(join(iso.home, "sub"));
    expect(resolveAgentCwd("rel/x", alice)).toBe(join(iso.home, "rel/x"));
    expect(resolveAgentCwd("/abs/../y", alice)).toBe("/y");
    // The enabling condition: the member's home is not the office's.
    expect(iso.home).not.toBe(homedir());
  });

  // D1. MUTANT: the not-ready host's placeholder home used as the folder.
  it("refuses a path that needs the home of a member whose host is not ready", () => {
    for (const cwd of ["~", "~/sub", "rel/x"])
      expect(() => resolveAgentCwd(cwd, carol)).toThrow();
    expect(resolveAgentCwd("/abs/x", carol)).toBe("/abs/x");
  });
});

describe("agentCwdProblem", () => {
  // C6. MUTANT: an office agent's folder checked through a member host.
  it("checks an office agent's folder with the office's stat, as before", async () => {
    expect(await agentCwdProblem(scratch, bob)).toBeNull();
    expect(await agentCwdProblem(join(scratch, "gone"), bob)).toMatchObject({
      kind: "missing",
    });
    expect(fsCalls).toEqual([]);
  });

  // C1 base, C3. MUTANT: the office's statSync for a member (the path
  // exists only for the member host, so the office finds it missing).
  it("checks a member's folder through the member's host", async () => {
    const only = join(scratch, "member-only");
    memberOnly.set(only, dirStat);
    expect(await agentCwdProblem(only, alice)).toBeNull();
    expect(fsCalls).toContainEqual({ op: "stat", path: only });
    // `~` is the member's home, statted through the member's host.
    fsCalls = [];
    await agentCwdProblem("~", alice);
    expect(fsCalls).toContainEqual({ op: "stat", path: iso.home });
  });

  // MUTANTS: every rejection read as missing; a file read as a folder.
  it("maps the member host's answer per kind", async () => {
    const at = (name: string) => join(scratch, name);
    memberOnly.set(at("gone"), errno("ENOENT"));
    memberOnly.set(at("file"), fileStat);
    memberOnly.set(at("locked"), errno("EACCES"));
    expect(await agentCwdProblem(at("gone"), alice)).toMatchObject({
      kind: "missing",
      path: at("gone"),
    });
    expect(await agentCwdProblem(at("file"), alice)).toMatchObject({
      kind: "not_directory",
      path: at("file"),
    });
    expect(await agentCwdProblem(at("locked"), alice)).toMatchObject({
      kind: "inaccessible",
      path: at("locked"),
    });
  });

  // A stat needs search on the parent only: another user's folder with mode
  // 700 stats as a folder. MUTANTS: statMemberFolder without the enter; the
  // enter's errno mapped as the stat's is not (ENOTDIR read as no access).
  it("checks that the member can enter a folder that stats fine", async () => {
    const at = (name: string) => join(scratch, name);
    memberOnly.set(at("locked"), dirStat);
    noEnter.set(at("locked"), errno("EACCES"));
    memberOnly.set(at("raced"), dirStat);
    noEnter.set(at("raced"), errno("ENOTDIR"));
    expect(await agentCwdProblem(at("locked"), alice)).toMatchObject({
      kind: "inaccessible",
      path: at("locked"),
    });
    expect(fsCalls).toContainEqual({ op: "enter", path: at("locked") });
    expect(await agentCwdProblem(at("raced"), alice)).toMatchObject({
      kind: "not_directory",
    });
    // A file is not entered.
    memberOnly.set(at("file"), fileStat);
    fsCalls = [];
    await agentCwdProblem(at("file"), alice);
    expect(fsCalls.filter((c) => c.op === "enter")).toEqual([]);
  });

  // D1, fail closed. MUTANT: a not-ready host's rejection read as fine.
  it("gives a problem for any folder of a member whose host is not ready", async () => {
    expect(await agentCwdProblem(scratch, carol)).toMatchObject({
      kind: "inaccessible",
    });
  });
});

describe("validateAgentCwd", () => {
  // MUTANT: the office's validateCwd for a member.
  it("returns the member's resolved folder, and refuses what the member host refuses", async () => {
    const only = join(iso.home, "proj");
    memberOnly.set(only, dirStat);
    expect(await validateAgentCwd("~/proj", alice)).toBe(only);
    memberOnly.set(join(iso.home, "locked"), errno("EACCES"));
    await expect(validateAgentCwd("~/locked", alice)).rejects.toThrow();
  });

  it("validates an office agent's folder as before", async () => {
    writeFileSync(join(scratch, "file"), "x");
    expect(await validateAgentCwd(scratch, bob)).toBe(scratch);
    await expect(
      validateAgentCwd(join(scratch, "file"), bob),
    ).rejects.toThrow();
    expect(fsCalls).toEqual([]);
  });
});

describe("the folder line after a member's failed turn", () => {
  const keyOf = (line: { key?: string } | null) => line?.key ?? null;
  // C1, D3. MUTANTS: the ACL line for ENOENT; the line for any rejection;
  // a line for a folder that is fine; no enter (a 700 folder reads fine).
  it("gives the ACL line only for no access, and the existing lines otherwise", async () => {
    const at = (name: string) => join(scratch, name);
    memberOnly.set(at("ok"), dirStat);
    memberOnly.set(at("gone"), errno("ENOENT"));
    memberOnly.set(at("file"), fileStat);
    memberOnly.set(at("locked"), dirStat);
    noEnter.set(at("locked"), errno("EACCES"));
    memberOnly.set(at("odd"), errno("EIO"));
    expect({
      ok: keyOf(await memberFolderHint(at("ok"), alice)),
      gone: keyOf(await memberFolderHint(at("gone"), alice)),
      file: keyOf(await memberFolderHint(at("file"), alice)),
      locked: keyOf(await memberFolderHint(at("locked"), alice)),
      odd: keyOf(await memberFolderHint(at("odd"), alice)),
      office: keyOf(await memberFolderHint(at("gone"), bob)),
      notReady: keyOf(await memberFolderHint(at("ok"), carol)),
    }).toEqual({
      ok: null,
      gone: "systemEntries.cwdInvalid.missing",
      file: "systemEntries.cwdInvalid.notDirectory",
      locked: "systemEntries.memberFolderUnreachable",
      odd: null,
      office: null,
      notReady: null,
    });
  });

  // D3. MUTANTS: an ancestor missing or / included; the folder unquoted; the
  // OS user from anywhere but the record.
  it("names the recorded OS user and every ancestor, quoted for the shell", async () => {
    const dir = join(scratch, "a b", "it's");
    memberOnly.set(dir, dirStat);
    noEnter.set(dir, errno("EACCES"));
    const line = (await memberFolderHint(dir, alice)) as {
      params?: Record<string, unknown>;
    } | null;
    const commands = readShareCommands("isomux-test-member", dir);
    expect(String(line?.params?.commands)).toContain(commands[0]);
    expect(String(line?.params?.commands)).toContain(commands[1]);
    expect(line?.params?.user).toBe("isomux-test-member");
    const ancestors: string[] = [];
    for (let p = join(dir, ".."); p !== "/"; p = join(p, ".."))
      ancestors.unshift(p);
    // Each command, run by a shell, gets exactly these words.
    const words = (command: string) =>
      Bun.spawnSync([
        "bash",
        "-c",
        `printf '%s\\n' ${command.replace(/^setfacl /, "")}`,
      ])
        .stdout.toString()
        .split("\n")
        .filter(Boolean);
    expect(words(commands[0])).toEqual([
      "-R",
      "-m",
      "u:isomux-test-member:rX,d:u:isomux-test-member:rX",
      dir,
    ]);
    expect(words(commands[1])).toEqual([
      "-m",
      "u:isomux-test-member:x",
      ...ancestors,
    ]);
  });
});

describe("the runner's project-skill replies", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    name: "rig-skill",
    description: "A rig skill",
    kind: "skill" as const,
    ...over,
  });

  it("takes a list of skill metadata", () => {
    const list = [
      entry(),
      entry({
        name: "rig-command",
        kind: "command" as const,
        aliasFor: "rig-skill",
      }),
      { name: "bare", kind: "skill" as const },
    ];
    expect(parseProjectSkillList(list)).toEqual(list);
    expect(parseProjectSkillList([])).toEqual([]);
  });

  // C5, D5: one bad field rejects the whole reply. MUTANT per row: that
  // field's check removed.
  const big = "x".repeat(PROJECT_SKILL_TEXT_MAX + 1);
  for (const [why, reply] of [
    ["not an array", { skills: [entry()] }],
    ["a name outside the skill-name rule", [entry({ name: "../x" })]],
    ["an empty name", [entry({ name: "" })]],
    ["a name that is not a string", [entry({ name: 7 })]],
    ["a description over the bound", [entry({ description: big })]],
    ["an aliasFor over the bound", [entry({ aliasFor: big })]],
    ["a description that is not a string", [entry({ description: {} })]],
    ["another kind", [entry({ kind: "plugin" })]],
    ["a path", [entry({ path: "/home/x/.claude/skills/rig-skill/SKILL.md" })]],
    ["a body in the list", [entry({ body: "text" })]],
    ["an entry that is not an object", ["rig-skill"]],
    [
      "more entries than the bound",
      Array.from({ length: PROJECT_SKILL_LIST_MAX + 1 }, (_, i) =>
        entry({ name: `s${i}` }),
      ),
    ],
  ] as const)
    it(`rejects a list with ${why}`, () => {
      expect(parseProjectSkillList(reply)).toBeNull();
    });

  // The bound itself is a valid list.
  it("takes a list at its bounds", () => {
    const list = Array.from({ length: PROJECT_SKILL_LIST_MAX }, (_, i) =>
      entry({
        name: `s${i}`,
        description: "x".repeat(PROJECT_SKILL_TEXT_MAX),
      }),
    );
    expect(parseProjectSkillList(list)).toEqual(list);
  });

  it("takes the body of the skill it asked for", () => {
    expect(
      parseProjectSkillBody({ name: "rig-skill", body: "Do it." }, "rig-skill"),
    ).toBe("Do it.");
    const atBound = "x".repeat(PROJECT_SKILL_BODY_MAX);
    expect(
      parseProjectSkillBody({ name: "rig-skill", body: atBound }, "rig-skill"),
    ).toBe(atBound);
  });

  // D5. MUTANT per row: that check removed.
  for (const [why, reply] of [
    ["another skill's name", { name: "other", body: "x" }],
    [
      "a body over the bound",
      { name: "rig-skill", body: "x".repeat(PROJECT_SKILL_BODY_MAX + 1) },
    ],
    // The bound is in bytes: 2-byte characters reach it at half the length.
    [
      "a body over the bound in bytes",
      { name: "rig-skill", body: "é".repeat(PROJECT_SKILL_BODY_MAX / 2 + 1) },
    ],
    ["a body that is not a string", { name: "rig-skill", body: ["x"] }],
    ["a path", { name: "rig-skill", body: "x", path: "/home/x/SKILL.md" }],
    ["no object", "x"],
  ] as const)
    it(`rejects a body reply with ${why}`, () => {
      expect(parseProjectSkillBody(reply, "rig-skill")).toBeNull();
    });

  // Review finding 2: "missing" is a reply value, never the runner's error
  // text. MUTANTS: the round-1 regex on a thrown message (dies on the thrown
  // row); projectSkillMissing without its name or key check (dies on that
  // row); readProjectSkillBody throwing for an absent skill (dies below).
  function hostAnswering(answer: () => unknown): AgentHost {
    return {
      runEntry: async () => answer(),
    } as unknown as AgentHost;
  }
  const fetch = (answer: () => unknown) =>
    fetchProjectSkillPrompt(
      hostAnswering(answer),
      "/srv/x",
      "claude",
      "rig-skill",
    );

  it("reads the runner's missing reply as missing, and a body as the prompt", async () => {
    expect(await fetch(() => ({ name: "rig-skill", missing: true }))).toEqual({
      kind: "missing",
    });
    expect(
      await fetch(() => ({
        name: "rig-skill",
        body: "---\ndescription: d\n---\nDo it.",
      })),
    ).toEqual({ kind: "ok", prompt: "Do it." });
  });

  for (const [why, answer] of [
    [
      "a thrown error that names the skill",
      () => {
        throw new Error("no project skill rig-skill");
      },
    ],
    [
      "a missing reply for another skill",
      () => ({ name: "other", missing: true }),
    ],
    [
      "a missing reply with another key",
      () => ({ name: "rig-skill", missing: true, body: "x" }),
    ],
    ["missing not true", () => ({ name: "rig-skill", missing: "true" })],
  ] as const)
    it(`reads ${why} as failed`, async () => {
      expect(await fetch(answer)).toEqual({ kind: "failed" });
    });

  it("the runner's read answers missing for an absent skill and a bad name", () => {
    const cwd = join(tmpdir(), `t-b94dfd25-skill-${process.pid}`);
    mkdirSync(join(cwd, ".claude", "skills", "rig-skill"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "skills", "rig-skill", "SKILL.md"),
      "Do it.",
    );
    try {
      expect(readProjectSkillBody(cwd, "claude", "rig-skill")).toEqual({
        name: "rig-skill",
        body: "Do it.",
      });
      expect(readProjectSkillBody(cwd, "claude", "absent")).toEqual({
        name: "absent",
        missing: true,
      });
      expect(readProjectSkillBody(cwd, "claude", "../rig-skill")).toEqual({
        name: "../rig-skill",
        missing: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
