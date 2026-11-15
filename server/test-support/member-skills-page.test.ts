// An isolated member's skills page (part 2d-iii-b of task b94dfd25). The
// properties:
// - the side is chosen per caller: a member's every route uses their side
//   (runner catalog, host files) and never the office's; another caller's
//   never uses a member's;
// - a runner that is not connected is 409 member_os_user on every route,
//   one that fails or does not answer is 502 runner_error;
// - the office takes the runner's catalog only in the agreed shape and
//   bounds (one bad entry refuses the whole reply), with a time bound, and
//   fills the use counts itself;
// - through their host, a member creates, saves and deletes only their own
//   files, with the editor's revisions; a built-in is read by the office;
//   a path outside their catalog is 404;
// - the runner lists their roots, their agents' folders and the built-ins
//   it was sent, never STATE_ROOT/skills, and refuses a request out of
//   shape.
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { localAgentFs, type AgentHost } from "../agent-host.ts";
import { openFile } from "../file-editor.ts";
import { MEMBER_HOST_NOT_READY } from "../member-hosts.ts";
import {
  createMemberSkill,
  deleteMemberSkillFile,
  fetchMemberSkillCatalog,
  parseMemberSkillCatalog,
  readMemberSkillFile,
  saveMemberSkillFile,
  SKILL_CATALOG_TIMEOUT_MS,
} from "../member-skill-catalog.ts";
import {
  buildMemberSkillCatalog,
  skillCatalogRequest,
} from "../skill-catalog-runner.ts";
import { BUNDLED_SKILLS_DIR, locateBundledSkills } from "../skills.ts";
import {
  skillsHandlers,
  type MemberSkillsDeps,
  type SkillsDeps,
} from "../routes/handlers/skills.ts";
import type { HandlerResult, RouteHandlerContext } from "../routes/executor.ts";
import { USER_CAPABILITIES, type Identity } from "../identity/index.ts";
import type {
  SkillCatalogEntry,
  SkillEngine,
} from "../../shared/contract-shapes.ts";
import { removeStateDir } from "./temp-state.ts";

const scratch: string[] = [];
function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function skillAt(dir: string, name: string, body = `Body of ${name}.`) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
  );
  return join(dir, name, "SKILL.md");
}

const BUNDLED = locateBundledSkills();
const BUNDLED_PATHS = new Set(BUNDLED.map((s) => s.path));

// The runner's skill-catalog entry, run here on the request as it crosses
// the socket (JSON).
async function localCatalogEntry(name: string, input: unknown) {
  if (name !== "skill-catalog") throw new Error(`no entry ${name}`);
  return buildMemberSkillCatalog(
    skillCatalogRequest(JSON.parse(JSON.stringify(input))),
  );
}

// A stand-in for a member's runner host: its files are this machine's (as
// the member's own runner would see theirs), every fs call and runner call
// is recorded.
function standIn(
  home: string,
  over: {
    runEntry?: (name: string, input: unknown) => Promise<unknown>;
  } = {},
) {
  const calls: { name: string; timeoutMs: unknown }[] = [];
  const fsCalls: string[] = [];
  const fs = Object.fromEntries(
    Object.entries(localAgentFs).map(([key, fn]) => [
      key,
      (...args: unknown[]) => {
        fsCalls.push(`${key} ${String(args[0])}`);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  );
  const host = {
    kind: "runner",
    member: "u-alice",
    home: () => home,
    fs,
    runEntry: (name: string, input: unknown, timeoutMs?: number) => {
      calls.push({ name, timeoutMs });
      return (over.runEntry ?? localCatalogEntry)(name, input);
    },
  } as unknown as AgentHost;
  return { host, calls, fsCalls };
}

const notReady = () =>
  Object.assign(new Error("not ready"), { code: MEMBER_HOST_NOT_READY });

// The member side as the office wires it (isomux-office.ts memberSkillsFor).
function memberSide(
  host: AgentHost,
  page: {
    home: string;
    newSkillDir: string;
    cwds?: string[];
    counts?: Record<string, number>;
  },
): MemberSkillsDeps {
  return {
    catalog: () =>
      fetchMemberSkillCatalog(
        host,
        {
          engines: [
            {
              engine: "claude",
              userRoots: [
                { root: join(page.home, ".claude"), includeCommands: true },
              ],
              pluginRoot: join(page.home, ".claude", "plugins"),
              cwds: page.cwds ?? [],
            },
          ],
        },
        { skills: BUNDLED, dir: BUNDLED_SKILLS_DIR },
        page.counts ?? {},
        { newSkillDir: page.newSkillDir, home: page.home },
      ),
    readFile: (entry) => readMemberSkillFile(host, entry),
    readPath: (path) => openFile(path, host),
    saveFile: (entry, content, rev) =>
      saveMemberSkillFile(host, entry, content, rev),
    deleteFile: (entry, rev) => deleteMemberSkillFile(host, entry, rev),
    createSkill: (dir, input) => createMemberSkill(host, dir, input),
  };
}

const ALICE: Identity = {
  scope: "user",
  userId: "u-alice",
  role: "member",
  capabilities: USER_CAPABILITIES,
};
const BOB: Identity = { ...ALICE, userId: "u-bob" };

// Office deps that count every call; the member side is chosen for Alice.
function handlersFor(member: MemberSkillsDeps) {
  const office: string[] = [];
  const memberCalls: string[] = [];
  const counted = <T extends object>(side: T, log: string[]): T =>
    Object.fromEntries(
      Object.entries(side).map(([key, fn]) => [
        key,
        (...args: unknown[]) => {
          log.push(key);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
    ) as T;
  const officeEntry: SkillCatalogEntry = {
    name: "office-only",
    source: "user",
    kind: "skill",
    path: "/office/.claude/skills/office-only/SKILL.md",
    dir: "/office/.claude/skills",
    editable: true,
    uses: 0,
  };
  const deps: SkillsDeps = {
    ...counted(
      {
        catalogFor: () => ({
          engines: [{ engine: "claude" as SkillEngine, skills: [officeEntry] }],
          newSkillDir: "/office/.claude/skills",
          home: "/office",
        }),
        readFile: (path: string) => ({ kind: "not_found" as const, path }),
        saveFile: (path: string) => ({
          kind: "ok" as const,
          path,
          mtime: 1,
          rev: 1,
        }),
        deleteFile: async () => ({ kind: "ok" as const }),
        createSkill: () => ({
          kind: "ok" as const,
          path: "/office/.claude/skills/x/SKILL.md",
        }),
      },
      office,
    ),
    refreshMenus: () => {},
    member: (identity) =>
      identity.userId === ALICE.userId ? counted(member, memberCalls) : null,
  } as SkillsDeps;
  return { handlers: skillsHandlers(deps), office, memberCalls };
}

function ctx(
  identity: Identity,
  query = "",
  body: unknown = undefined,
): RouteHandlerContext {
  return {
    identity,
    params: {},
    body,
    rawBody: "",
    query: new URLSearchParams(query),
    req: new Request("http://localhost/"),
  };
}

const statusOf = (r: HandlerResult) =>
  r.kind === "error"
    ? r.status
    : r.kind === "noContent"
      ? 204
      : ((r as { status?: number }).status ?? 200);
const codeOf = (r: HandlerResult) => (r.kind === "error" ? r.code : undefined);
const bodyOf = (r: HandlerResult) => (r as { body?: unknown }).body;

const SKILL_TEXT = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

// Every route once, as `who`, on a path `path`.
async function everyRoute(
  handlers: ReturnType<typeof skillsHandlers>,
  who: Identity,
  path: string,
) {
  const q = `path=${encodeURIComponent(path)}`;
  return {
    catalog: await handlers["skills.catalog"](ctx(who)),
    readFile: await handlers["skills.readFile"](ctx(who, q)),
    saveFile: await handlers["skills.saveFile"](
      ctx(who, "", {
        path,
        content: SKILL_TEXT("mine", "Saved."),
        expectedRev: 1,
      }),
    ),
    deleteFile: await handlers["skills.deleteFile"](
      ctx(who, "", { path, expectedRev: 1 }),
    ),
    create: await handlers["skills.create"](
      ctx(who, "", { name: "made", description: "Made." }),
    ),
  };
}

describe("the side of a skills route", () => {
  it("is the member's for every route of Alice and never the office's; Bob's never reaches hers", async () => {
    const home = tmp("member-home-");
    const mine = skillAt(join(home, ".claude", "skills"), "mine");
    const { host } = standIn(home);
    const h = handlersFor(
      memberSide(host, { home, newSkillDir: join(home, ".claude", "skills") }),
    );
    const alice = await everyRoute(h.handlers, ALICE, mine);
    // The enabling condition: her side answers.
    expect(statusOf(alice.catalog)).toBe(200);
    expect(h.office).toEqual([]);
    expect(new Set(h.memberCalls)).toEqual(
      new Set([
        "catalog",
        "readFile",
        "saveFile",
        "deleteFile",
        "createSkill",
        "readPath",
      ]),
    );
    h.memberCalls.splice(0);
    await everyRoute(h.handlers, BOB, mine);
    expect(h.memberCalls).toEqual([]);
    expect(h.office).toContain("catalogFor");
  });

  it("is 409 member_os_user on every route while her runner is not connected", async () => {
    const home = tmp("member-home-");
    const mine = skillAt(join(home, ".claude", "skills"), "mine");
    // The catalog call refused: every route stops there.
    const down = standIn(home, {
      runEntry: () => Promise.reject(notReady()),
    });
    const all = await everyRoute(
      handlersFor(
        memberSide(down.host, {
          home,
          newSkillDir: join(home, ".claude", "skills"),
        }),
      ).handlers,
      ALICE,
      mine,
    );
    for (const [op, r] of Object.entries(all))
      expect([op, statusOf(r), codeOf(r)]).toEqual([op, 409, "member_os_user"]);
  });

  it("is 502 runner_error on every route when her runner fails or answers out of shape", async () => {
    const home = tmp("member-home-");
    const mine = skillAt(join(home, ".claude", "skills"), "mine");
    for (const runEntry of [
      () => Promise.reject(new Error("timed out")),
      () => Promise.resolve({ engines: [], extra: 1 }),
    ]) {
      const { host } = standIn(home, { runEntry });
      const all = await everyRoute(
        handlersFor(
          memberSide(host, {
            home,
            newSkillDir: join(home, ".claude", "skills"),
          }),
        ).handlers,
        ALICE,
        mine,
      );
      for (const [op, r] of Object.entries(all))
        expect([op, statusOf(r), codeOf(r)]).toEqual([op, 502, "runner_error"]);
    }
  });
});

describe("a member's skill files through their host", () => {
  function page() {
    const home = tmp("member-home-");
    const skills = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const stand = standIn(home);
    const h = handlersFor(
      memberSide(stand.host, { home, newSkillDir: skills }),
    );
    return { home, skills, stand, h: h.handlers };
  }

  it("creates, saves and deletes her own skill, with the editor's revisions", async () => {
    const { skills, stand, h } = page();
    const made = await h["skills.create"](
      ctx(ALICE, "", {
        name: "made",
        description: "Made.",
        instructions: "Do.",
      }),
    );
    expect(statusOf(made)).toBe(201);
    const path = join(skills, "made", "SKILL.md");
    expect((bodyOf(made) as { path: string }).path).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    // Through her host, not the office's own files.
    expect(
      stand.fsCalls.some((c) => c.startsWith("writeText ") && c.endsWith(path)),
    ).toBe(true);
    const rev = (bodyOf(made) as { rev: number }).rev;

    // A second create of the name is refused, and writes nothing.
    const again = await h["skills.create"](
      ctx(ALICE, "", { name: "made", description: "Other." }),
    );
    expect([statusOf(again), codeOf(again)]).toEqual([409, "skill_exists"]);
    expect(readFileSync(path, "utf8")).toContain("Made.");

    const saved = await h["skills.saveFile"](
      ctx(ALICE, "", {
        path,
        content: SKILL_TEXT("made", "Saved."),
        expectedRev: rev,
      }),
    );
    expect(statusOf(saved)).toBe(200);
    expect(readFileSync(path, "utf8")).toContain("Saved.");
    const newRev = (bodyOf(saved) as { rev: number }).rev;
    expect(newRev).not.toBe(rev);

    // The old revision is stale: nothing is written.
    const stale = await h["skills.saveFile"](
      ctx(ALICE, "", {
        path,
        content: SKILL_TEXT("made", "Lost."),
        expectedRev: rev,
      }),
    );
    expect([statusOf(stale), codeOf(stale)]).toEqual([409, "stale"]);
    expect(readFileSync(path, "utf8")).toContain("Saved.");
    const staleDelete = await h["skills.deleteFile"](
      ctx(ALICE, "", { path, expectedRev: rev }),
    );
    expect([statusOf(staleDelete), codeOf(staleDelete)]).toEqual([
      409,
      "stale",
    ]);
    expect(existsSync(path)).toBe(true);

    const deleted = await h["skills.deleteFile"](
      ctx(ALICE, "", { path, expectedRev: newRev }),
    );
    expect(statusOf(deleted)).toBe(204);
    expect(existsSync(join(skills, "made"))).toBe(false);
  });

  it("deletes only the link of a linked skill, not what it points to", async () => {
    const { skills, h } = page();
    const elsewhere = tmp("member-elsewhere-");
    const real = skillAt(elsewhere, "linked");
    const { symlinkSync } = await import("fs");
    symlinkSync(join(elsewhere, "linked"), join(skills, "linked"));
    const path = join(skills, "linked", "SKILL.md");
    const opened = await h["skills.readFile"](
      ctx(ALICE, `path=${encodeURIComponent(path)}`),
    );
    expect(statusOf(opened)).toBe(200);
    const rev = (bodyOf(opened) as { rev: number }).rev;
    const deleted = await h["skills.deleteFile"](
      ctx(ALICE, "", { path, expectedRev: rev }),
    );
    expect(statusOf(deleted)).toBe(204);
    expect([existsSync(join(skills, "linked")), existsSync(real)]).toEqual([
      false,
      true,
    ]);
  });

  it("finds no path outside her catalog, and reads a built-in through the office", async () => {
    const { stand, h } = page();
    const outside = tmp("office-skills-");
    const officeSkill = skillAt(outside, "office-only");
    const read = await h["skills.readFile"](
      ctx(ALICE, `path=${encodeURIComponent(officeSkill)}`),
    );
    expect([statusOf(read), codeOf(read)]).toEqual([404, "skill_not_found"]);
    const save = await h["skills.saveFile"](
      ctx(ALICE, "", {
        path: officeSkill,
        content: SKILL_TEXT("office-only", "Hers."),
        expectedRev: 1,
      }),
    );
    expect([statusOf(save), codeOf(save)]).toEqual([404, "skill_not_found"]);
    expect(readFileSync(officeSkill, "utf8")).toContain("Body of office-only.");

    // Her own skill under another name (a link in an office folder): the
    // office does not follow it with its own files.
    skillAt(join(stand.host.home(), ".claude", "skills"), "mine");
    const { symlinkSync } = await import("fs");
    symlinkSync(
      join(stand.host.home(), ".claude", "skills", "mine"),
      join(outside, "alias"),
    );
    const viaLink = await h["skills.readFile"](
      ctx(
        ALICE,
        `path=${encodeURIComponent(join(outside, "alias", "SKILL.md"))}`,
      ),
    );
    expect([statusOf(viaLink), codeOf(viaLink)]).toEqual([
      404,
      "skill_not_found",
    ]);

    const builtIn = BUNDLED.find((s) => !s.aliasFor)!;
    stand.fsCalls.splice(0);
    const shown = await h["skills.readFile"](
      ctx(ALICE, `path=${encodeURIComponent(builtIn.path)}`),
    );
    expect(statusOf(shown)).toBe(200);
    expect((bodyOf(shown) as { editable: boolean }).editable).toBe(false);
    expect(stand.fsCalls.filter((c) => c.endsWith(builtIn.path))).toEqual([]);
    const saveBuiltIn = await h["skills.saveFile"](
      ctx(ALICE, "", {
        path: builtIn.path,
        content: SKILL_TEXT(builtIn.name, "x"),
        expectedRev: 1,
      }),
    );
    expect([statusOf(saveBuiltIn), codeOf(saveBuiltIn)]).toEqual([
      403,
      "read_only",
    ]);
  });
});

describe("the office's check of a runner catalog", () => {
  const good = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    name: "mine",
    source: "user",
    kind: "skill",
    path: "/home/alice/.claude/skills/mine/SKILL.md",
    dir: "/home/alice/.claude/skills",
    editable: true,
    uses: 0,
    ...over,
  });
  const reply = (skills: unknown[], engine = "claude") => ({
    engines: [{ engine, skills }],
  });
  const parse = (r: unknown, engine: SkillEngine = "claude") =>
    parseMemberSkillCatalog(r, [engine], BUNDLED_PATHS);
  const builtIn = BUNDLED[0];

  it("takes a reply in shape", () => {
    expect(
      parse(
        reply([
          good(),
          good({ name: "proj", source: "project", project: "/home/alice/w" }),
          good({ name: "p:s", source: "plugin", plugin: "p", editable: false }),
          good({
            name: builtIn.name,
            source: "isomux",
            path: builtIn.path,
            dir: builtIn.dir,
            editable: false,
          }),
        ]),
      )?.[0].skills.length,
    ).toBe(4);
  });

  const BAD: [string, unknown][] = [
    ["an unknown key", good({ extra: 1 })],
    ["a name with a slash", good({ name: "a/b" })],
    ["a name with a control character", good({ name: "a\u0007b" })],
    ["an empty name", good({ name: "" })],
    ["a long name", good({ name: "a".repeat(256) })],
    ["a colon name that is no plugin", good({ name: "a:b" })],
    ["a plugin without a colon", good({ source: "plugin", editable: false })],
    ["an unknown source", good({ source: "office" })],
    ["an unknown kind", good({ kind: "script" })],
    ["a relative path", good({ path: "skills/mine/SKILL.md" })],
    ["a path with NUL", good({ path: "/a\0b" })],
    ["a long path", good({ path: `/${"a".repeat(4096)}` })],
    ["a long description", good({ description: "d".repeat(1025) })],
    [
      "an editable plugin",
      good({ name: "p:s", source: "plugin", plugin: "p" }),
    ],
    [
      "an editable built-in",
      good({ name: builtIn.name, source: "isomux", path: builtIn.path }),
    ],
    [
      "a built-in at a path the office did not send",
      good({ source: "isomux", editable: false }),
    ],
    ["uses that is no number", good({ uses: "1" })],
    ["editable that is no boolean", good({ editable: 1 })],
  ];
  for (const [what, entry] of BAD)
    it(`refuses the whole reply for ${what}`, () => {
      expect(parse(reply([good(), entry]))).toBeNull();
    });

  it("refuses a plugin skill on Codex, an engine out of order, extra keys and too many entries", () => {
    expect(
      parse(
        reply(
          [
            good({
              name: "p:s",
              source: "plugin",
              plugin: "p",
              editable: false,
            }),
          ],
          "codex",
        ),
        "codex",
      ),
    ).toBeNull();
    expect(parse(reply([good()], "codex"))).toBeNull();
    expect(parse({ ...reply([good()]), more: 1 })).toBeNull();
    expect(parse({ engines: [] })).toBeNull();
    const many = Array.from({ length: 1001 }, (_, i) =>
      good({ name: `s${i}` }),
    );
    expect(parse(reply(many))).toBeNull();
    expect(parse(reply(many.slice(0, 1000)))).not.toBeNull();
  });

  it("refuses a reply over 4 MiB", () => {
    const big = Array.from({ length: 1000 }, (_, i) =>
      good({
        name: `s${i}`,
        path: `/${"p".repeat(4000)}${i}`,
        dir: `/${"d".repeat(1000)}`,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(reply(big)))).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    expect(parse(reply(big))).toBeNull();
  });

  it("asks with a time bound, and fills the uses from the caller's counts", async () => {
    const home = tmp("member-home-");
    skillAt(join(home, ".claude", "skills"), "mine");
    const { host, calls } = standIn(home, {
      runEntry: async (name, input) => {
        const r = (await localCatalogEntry(name, input)) as {
          engines: { skills: { uses: number }[] }[];
        };
        for (const s of r.engines[0].skills) s.uses = 999;
        return r;
      },
    });
    const catalog = await memberSide(host, {
      home,
      newSkillDir: join(home, ".claude", "skills"),
      counts: { mine: 3 },
    }).catalog();
    expect(calls.map((c) => c.name)).toEqual(["skill-catalog"]);
    const bound = calls[0].timeoutMs as number;
    expect(bound > 0 && bound <= SKILL_CATALOG_TIMEOUT_MS).toBe(true);
    const skills = catalog.engines[0].skills;
    expect(skills.find((s) => s.name === "mine")?.uses).toBe(3);
    expect(skills.filter((s) => s.uses === 999)).toEqual([]);
  });
});

describe("the runner's catalog", () => {
  const STATE_SKILL = `state-only-${process.pid}`;
  afterEach(() => removeStateDir(join(STATE_ROOT, "skills", STATE_SKILL)));

  it("lists her roots and her agents' folders as hers, the sent built-ins read-only, and never STATE_ROOT/skills", async () => {
    skillAt(join(STATE_ROOT, "skills"), STATE_SKILL);
    const home = tmp("member-home-");
    skillAt(join(home, ".claude", "skills"), "mine");
    const work = tmp("member-work-");
    skillAt(join(work, ".claude", "skills"), "proj");
    const reply = (await localCatalogEntry("skill-catalog", {
      engines: [
        {
          engine: "claude",
          userRoots: [{ root: join(home, ".claude"), includeCommands: true }],
          pluginRoot: join(home, ".claude", "plugins"),
          cwds: [work],
        },
      ],
      bundled: BUNDLED,
      bundledDir: BUNDLED_SKILLS_DIR,
    })) as { engines: { skills: SkillCatalogEntry[] }[] };
    const skills = reply.engines[0].skills;
    const by = (name: string) => skills.find((s) => s.name === name);
    expect([by("mine")?.source, by("mine")?.editable]).toEqual(["user", true]);
    expect([
      by("proj")?.source,
      by("proj")?.editable,
      by("proj")?.project,
    ]).toEqual(["project", true, work]);
    const builtIns = skills.filter((s) => s.source === "isomux");
    expect(builtIns.length).toBeGreaterThan(0);
    expect(
      builtIns.filter((s) => s.editable || !BUNDLED_PATHS.has(s.path)),
    ).toEqual([]);
    expect(by(STATE_SKILL)).toBeUndefined();
    // The office takes it as it is.
    expect(
      parseMemberSkillCatalog(reply, ["claude"], BUNDLED_PATHS),
    ).not.toBeNull();
  });

  const base = () => ({
    engines: [
      {
        engine: "claude",
        userRoots: [{ root: "/home/alice/.claude", includeCommands: true }],
        pluginRoot: "/home/alice/.claude/plugins",
        cwds: ["/home/alice/w"],
      },
    ],
    bundled: BUNDLED,
    bundledDir: BUNDLED_SKILLS_DIR,
  });
  const BAD_REQUESTS: [string, (r: ReturnType<typeof base>) => unknown][] = [
    ["no input", () => null],
    [
      "an unknown engine",
      (r) => ({ ...r, engines: [{ ...r.engines[0], engine: "gpt" }] }),
    ],
    [
      "a relative cwd",
      (r) => ({ ...r, engines: [{ ...r.engines[0], cwds: ["w"] }] }),
    ],
    [
      "too many cwds",
      (r) => ({
        ...r,
        engines: [
          {
            ...r.engines[0],
            cwds: Array.from({ length: 501 }, (_, i) => `/w/${i}`),
          },
        ],
      }),
    ],
    [
      "a root without includeCommands",
      (r) => ({
        ...r,
        engines: [{ ...r.engines[0], userRoots: [{ root: "/h/.claude" }] }],
      }),
    ],
    [
      "a relative plugin root",
      (r) => ({ ...r, engines: [{ ...r.engines[0], pluginRoot: "p" }] }),
    ],
    ["a relative bundled folder", (r) => ({ ...r, bundledDir: "skills" })],
    [
      "a bundled skill of another origin",
      (r) => ({ ...r, bundled: [{ ...BUNDLED[0], origin: "user" }] }),
    ],
    [
      "too many bundled skills",
      (r) => ({ ...r, bundled: Array.from({ length: 201 }, () => BUNDLED[0]) }),
    ],
  ];
  it("takes a request in shape", () => {
    expect(
      skillCatalogRequest(JSON.parse(JSON.stringify(base()))).engines[0].engine,
    ).toBe("claude");
  });
  for (const [what, make] of BAD_REQUESTS)
    it(`refuses a request with ${what}`, () => {
      expect(() =>
        skillCatalogRequest(JSON.parse(JSON.stringify(make(base())))),
      ).toThrow();
    });
});
