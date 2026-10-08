import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillCatalog,
  createSkill,
  findCatalogEntry,
  readSkillFile,
  saveSkillFile,
  type SkillEngineContext,
} from "./skill-catalog.ts";
import {
  BUNDLED_SKILLS_DIR,
  discoverUserSkills,
  resolveSkillPrompt,
} from "./skills.ts";
import { skillsHandlers } from "./routes/handlers/skills.ts";
import { USER_CAPABILITIES } from "./identity/index.ts";

const dirs: string[] = [];
function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `isomux-catalog-${label}-`));
  dirs.push(dir);
  return dir;
}
function skill(base: string, name: string, body = name): string {
  const dir = join(base, "skills", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\ndescription: about ${name}\n---\n${body}\n`);
  return path;
}

const roots = (...paths: string[]) =>
  paths.map((root) => ({ root, includeCommands: false }));

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function context(
  over: Omit<Partial<SkillEngineContext>, "userRoots"> & {
    userRoots: string[];
  },
): SkillEngineContext {
  return {
    engine: "claude",
    pluginRoot: tmp("no-plugins"),
    cwds: [],
    ...over,
    userRoots: over.userRoots.map((root) => ({ root, includeCommands: true })),
  };
}

function entries(ctx: SkillEngineContext, counts = {}) {
  return buildSkillCatalog([ctx], counts, "/new", "/home").engines[0].skills;
}

describe("skill catalog", () => {
  it("lists user, project and built-in skills with their files and sources", () => {
    const user = tmp("user");
    const project = tmp("project");
    const userPath = skill(user, "mine");
    const projectPath = skill(join(project, ".claude"), "local");
    const list = entries(context({ userRoots: [user], cwds: [project] }));
    const mine = list.find((s) => s.name === "mine");
    const local = list.find((s) => s.name === "local");
    const builtIn = list.find((s) => s.name === "wrap-session");
    expect(mine).toMatchObject({
      source: "user",
      path: userPath,
      editable: true,
      kind: "skill",
    });
    expect(mine?.description).toBe("about mine");
    expect(local).toMatchObject({
      source: "project",
      path: projectPath,
      project,
      editable: true,
    });
    expect(builtIn?.source).toBe("isomux");
    expect(builtIn?.editable).toBe(false);
  });

  it("marks a skill shadowed when an earlier one with its name always wins", () => {
    const first = tmp("first");
    const second = tmp("second");
    const winner = skill(first, "same", "first body");
    skill(second, "same", "second body");
    const list = entries(context({ userRoots: [first, second] }));
    const same = list.filter((s) => s.name === "same");
    expect(same).toHaveLength(2);
    expect(same[0].shadowedBy).toBeUndefined();
    expect(same[1].shadowedBy).toBe(winner);
    // The resolver agrees: the first root's file runs.
    expect(resolveSkillPrompt("same", tmp("cwd"), roots(first, second))).toBe(
      "first body",
    );
  });

  it("does not shadow a built-in for every agent when one project overrides it", () => {
    const withOverride = tmp("override");
    const plain = tmp("plain");
    skill(join(withOverride, ".claude"), "wrap-session", "custom");
    const list = entries(
      context({ userRoots: [tmp("user")], cwds: [withOverride, plain] }),
    );
    const builtIn = list.find(
      (s) => s.name === "wrap-session" && s.source === "isomux",
    );
    const override = list.find(
      (s) => s.name === "wrap-session" && s.source === "project",
    );
    expect(builtIn?.shadowedBy).toBeUndefined();
    expect(override?.shadowedBy).toBeUndefined();
  });

  it("shadows a built-in that every context overrides", () => {
    const user = tmp("user");
    const userPath = skill(user, "wrap-session");
    const list = entries(context({ userRoots: [user], cwds: [tmp("cwd")] }));
    const builtIn = list.find(
      (s) => s.name === "wrap-session" && s.source === "isomux",
    );
    expect(builtIn?.shadowedBy).toBe(userPath);
  });

  it("keeps a linked file running when another project runs it", () => {
    // Project A overrides its .claude skill with an .isomux one; project B
    // links A's .claude skill and has no override, so B runs it.
    const a = tmp("a");
    const b = tmp("b");
    skill(join(a, ".isomux"), "shared", "a override");
    const linked = skill(join(a, ".claude"), "shared", "linked body");
    mkdirSync(join(b, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join(a, ".claude", "skills", "shared"),
      join(b, ".claude", "skills", "shared"),
    );
    const list = entries(context({ userRoots: [tmp("user")], cwds: [a, b] }));
    const entry = list.find((s) => s.name === "shared" && s.path === linked);
    expect(entry).toBeDefined();
    expect(entry?.shadowedBy).toBeUndefined();
    expect(resolveSkillPrompt("shared", b, roots(tmp("user")))).toBe(
      "linked body",
    );
    expect(resolveSkillPrompt("shared", a, roots(tmp("user")))).toBe(
      "a override",
    );
  });

  it("lists a colon name only as the plugin skill the resolver runs", () => {
    const user = tmp("user");
    const claudeHome = tmp("claude");
    const install = tmp("plugin-install");
    skill(user, "p:probe", "user body");
    skill(install, "probe", "plugin body");
    mkdirSync(join(claudeHome, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@market": [{ installPath: install }] } }),
    );
    const list = entries(
      context({ userRoots: [user], pluginRoot: claudeHome }),
    );
    const probes = list.filter((s) => s.name === "p:probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ source: "plugin", editable: false });
    expect(probes[0].shadowedBy).toBeUndefined();
    expect(
      resolveSkillPrompt("p:probe", tmp("cwd"), roots(user), true, claudeHome),
    ).toBe("plugin body");
  });

  it("lists a file reached through a personal-home link once", () => {
    const box = tmp("box");
    const personal = tmp("personal");
    skill(box, "shared");
    mkdirSync(join(personal, "skills"), { recursive: true });
    symlinkSync(
      join(box, "skills", "shared"),
      join(personal, "skills", "shared"),
    );
    const list = entries(context({ userRoots: [personal, box] }));
    expect(list.filter((s) => s.name === "shared")).toHaveLength(1);
  });

  it("shows a built-in alias once, under the alias, with both names' uses", () => {
    const list = entries(context({ userRoots: [tmp("user")] }), {
      handoff: 2,
      "isomux-handoff": 3,
    });
    expect(list.some((s) => s.name === "isomux-handoff")).toBe(false);
    const alias = list.find((s) => s.name === "handoff");
    expect(alias?.aliasFor).toBe("isomux-handoff");
    expect(alias?.uses).toBe(5);
  });

  it("finds entries by exact path only", () => {
    const user = tmp("user");
    const path = skill(user, "mine");
    const catalog = buildSkillCatalog(
      [context({ userRoots: [user] })],
      {},
      "/new",
      "/home",
    );
    expect(findCatalogEntry(catalog, path)?.name).toBe("mine");
    expect(findCatalogEntry(catalog, join(user, "skills", "mine"))).toBeNull();
    expect(findCatalogEntry(catalog, "/etc/passwd")).toBeNull();
  });
});

describe("built-in protection through a link", () => {
  it("keeps a user-folder link to a built-in read-only, and its save writes nothing", async () => {
    const user = tmp("user");
    mkdirSync(join(user, "skills"), { recursive: true });
    const target = join(BUNDLED_SKILLS_DIR, "grill-me", "SKILL.md");
    symlinkSync(
      join(BUNDLED_SKILLS_DIR, "grill-me"),
      join(user, "skills", "grill-me"),
    );
    const linkPath = join(user, "skills", "grill-me", "SKILL.md");
    const catalog = () =>
      buildSkillCatalog([context({ userRoots: [user] })], {}, "/new", "/home");
    const entry = findCatalogEntry(catalog(), linkPath);
    expect(entry).toMatchObject({ source: "user", editable: false });

    const before = readFileSync(target, "utf8");
    const opened = readSkillFile(linkPath);
    if (opened.kind !== "ok") throw new Error("open failed");
    const handlers = skillsHandlers({
      catalogFor: catalog,
      readFile: readSkillFile,
      saveFile: (path, content, rev) => {
        throw new Error(`save reached the file: ${path} ${content} ${rev}`);
      },
      createSkill,
      refreshMenus: () => {},
    });
    const result = await handlers["skills.saveFile"]({
      identity: {
        scope: "user",
        userId: "u1",
        role: "member",
        capabilities: USER_CAPABILITIES,
      },
      params: {},
      body: { path: linkPath, content: "overwritten", expectedRev: opened.rev },
      rawBody: "",
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    });
    expect(result).toMatchObject({ kind: "error", status: 403 });
    expect(readFileSync(target, "utf8")).toBe(before);
  });
});

describe("plugin protection through a link", () => {
  it("keeps a user-folder link into an installed plugin read-only when the plugin lists no skill", () => {
    const user = tmp("user");
    const claudeHome = tmp("claude");
    const install = tmp("plugin-install");
    const hidden = join(install, "skills", "hidden");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(
      join(hidden, "SKILL.md"),
      "---\ndescription: fixture\nuser-invocable: false\n---\nplugin body\n",
    );
    mkdirSync(join(claudeHome, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "p@market": [{ installPath: install }] } }),
    );
    mkdirSync(join(user, "skills"), { recursive: true });
    symlinkSync(hidden, join(user, "skills", "plugin-link"));
    const list = entries(
      context({ userRoots: [user], pluginRoot: claudeHome }),
    );
    expect(list.filter((s) => s.source === "plugin")).toHaveLength(0);
    expect(list.find((s) => s.name === "plugin-link")).toMatchObject({
      source: "user",
      editable: false,
    });
  });
});

describe("skill save", () => {
  it("refuses a save based on an older revision and keeps the newer file", () => {
    const user = tmp("user");
    const path = skill(user, "mine", "v1");
    const opened = readSkillFile(path);
    if (opened.kind !== "ok") throw new Error("open failed");
    // Another writer changes the file after it was read.
    writeFileSync(path, "---\ndescription: other\n---\nother edit, longer\n");
    const result = saveSkillFile(path, "my edit", opened.rev);
    expect(result.kind).toBe("stale");
    expect(readFileSync(path, "utf8")).toContain("other edit");
  });

  it("saves on the current revision", () => {
    const user = tmp("user");
    const path = skill(user, "mine", "v1");
    const opened = readSkillFile(path);
    if (opened.kind !== "ok") throw new Error("open failed");
    const result = saveSkillFile(path, "new text", opened.rev);
    expect(result.kind).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe("new text");
  });
});

describe("skill create", () => {
  it("writes a SKILL.md that discovery and the resolver read back", () => {
    const home = tmp("home");
    const dir = join(home, "skills");
    const description = "Sort bugs: severity first # then age";
    const r = createSkill(dir, {
      name: "triage-bugs",
      description,
      instructions: "File one task per bug.",
    });
    expect(r.kind).toBe("ok");
    const found = discoverUserSkills([
      { root: home, includeCommands: false },
    ]).find((s) => s.name === "triage-bugs");
    // A colon-space description is quoted on disk and read back unquoted,
    // and the frontmatter is valid YAML for engines that parse it.
    expect(found?.description).toBe(description);
    if (r.kind !== "ok") throw new Error("create failed");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(
      readFileSync(r.path, "utf8"),
    )?.[1];
    expect(Bun.YAML.parse(frontmatter ?? "")).toEqual({
      name: "triage-bugs",
      description,
    });
    expect(resolveSkillPrompt("triage-bugs", tmp("cwd"), roots(home))).toBe(
      "File one task per bug.",
    );
  });

  it("rejects bad names and descriptions, and an existing folder", () => {
    const dir = join(tmp("home"), "skills");
    for (const name of ["", "Caps", "a--b", "-a", "a b", "x".repeat(65), 7])
      expect(createSkill(dir, { name, description: "d" })).toEqual({
        kind: "invalid",
        field: "name",
      });
    for (const description of ["", "  ", "two\nlines", "x".repeat(1025)])
      expect(createSkill(dir, { name: "ok", description })).toEqual({
        kind: "invalid",
        field: "description",
      });
    expect(createSkill(dir, { name: "ok", description: "d" }).kind).toBe("ok");
    expect(createSkill(dir, { name: "ok", description: "d" }).kind).toBe(
      "exists",
    );
  });
});
