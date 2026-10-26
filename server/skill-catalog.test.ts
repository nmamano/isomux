import { afterEach, describe, expect, it } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
    // An install enables the plugin in the user settings.
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ enabledPlugins: { "p@market": true } }),
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

  // A Codex agent reads the member's personal Claude home before the box one,
  // and a Claude agent only the box one. Both must show the same path, or the
  // page lists the skill once per engine instead of once for all agents.
  it("shows a personal-home link under the box path it points to", () => {
    for (const relativeLinks of [false, true]) {
      const box = tmp("box");
      const personal = tmp("personal");
      const boxSkill = skill(box, "shared");
      const boxCommand = join(box, "commands", "cmd.md");
      mkdirSync(dirname(boxCommand), { recursive: true });
      writeFileSync(boxCommand, "command body\n");
      // exposePersonalProviderSkills writes absolute targets; a relative one
      // resolves against the link's own folder.
      const link = (target: string, at: string) => {
        mkdirSync(dirname(at), { recursive: true });
        symlinkSync(relativeLinks ? relative(dirname(at), target) : target, at);
      };
      link(dirname(boxSkill), join(personal, "skills", "shared"));
      link(boxCommand, join(personal, "commands", "cmd.md"));
      // As in the field: Codex reads the personal Claude home before the box
      // one, Claude reads only the box one.
      const catalog = buildSkillCatalog(
        [
          context({ userRoots: [box] }),
          { ...context({ userRoots: [personal, box] }), engine: "codex" },
        ],
        {},
        "/new",
        "/home",
      );
      // Once per engine, under the box path.
      for (const { skills } of catalog.engines) {
        expect(
          skills.filter((s) => s.name === "shared").map((s) => s.path),
        ).toEqual([boxSkill]);
        expect(
          skills.filter((s) => s.name === "cmd").map((s) => s.path),
        ).toEqual([boxCommand]);
      }
    }
  });

  it("shows a built-in alias once, under the alias, with both names' uses", () => {
    const list = entries(context({ userRoots: [tmp("user")] }), {
      "peer-review": 2,
      "isomux-peer-review": 3,
    });
    expect(list.some((s) => s.name === "isomux-peer-review")).toBe(false);
    const alias = list.find((s) => s.name === "peer-review");
    expect(alias?.aliasFor).toBe("isomux-peer-review");
    expect(alias?.uses).toBe(5);
  });

  // /handoff is a built-in command (task 970930a3): no skill of either name.
  it("lists no handoff skill", () => {
    const list = entries(context({ userRoots: [tmp("user")] }), {});
    expect(list.some((s) => s.name === "peer-review")).toBe(true);
    expect(
      list.filter((s) => s.name === "handoff" || s.name === "isomux-handoff"),
    ).toEqual([]);
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

// The skills handlers refuse a save or delete of a read-only entry
// (routes/handlers/skills.test.ts); what makes a linked entry read-only is
// where its file really is.
describe("protection through a link", () => {
  // Task e832fc7c: a link of the built-in's own name is the link isomux
  // makes, listed as the built-in (skills.test.ts); another name is the
  // member's.
  it("keeps a user-folder link to a built-in read-only", () => {
    const user = tmp("user");
    mkdirSync(join(user, "skills"), { recursive: true });
    symlinkSync(
      join(BUNDLED_SKILLS_DIR, "grill-me"),
      join(user, "skills", "my-grill"),
    );
    const catalog = buildSkillCatalog(
      [context({ userRoots: [user] })],
      {},
      "/new",
      "/home",
    );
    expect(
      findCatalogEntry(catalog, join(user, "skills", "my-grill", "SKILL.md")),
    ).toMatchObject({ source: "user", editable: false });
  });

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

  // Task e832fc7c: isomux links its bundled skills into the box Claude home,
  // where the page creates skills. A member's own skill of a bundled name
  // still overrides the bundled one; a link that is not isomux's still counts.
  it("creates a skill in place of the link to a bundled skill, and keeps any other link", () => {
    const dir = join(tmp("home"), "skills");
    mkdirSync(dir);
    const bundledFile = join(BUNDLED_SKILLS_DIR, "wrap-session", "SKILL.md");
    const bundledText = readFileSync(bundledFile, "utf8");
    symlinkSync(
      join(BUNDLED_SKILLS_DIR, "wrap-session"),
      join(dir, "wrap-session"),
    );
    const elsewhere = tmp("elsewhere");
    skill(elsewhere, "grill-me", "member grill prompt");
    symlinkSync(join(elsewhere, "skills", "grill-me"), join(dir, "grill-me"));

    const created = createSkill(dir, {
      name: "wrap-session",
      description: "member wrap",
      instructions: "My own wrap-up.",
    });
    expect(created).toEqual({
      kind: "ok",
      path: join(dir, "wrap-session", "SKILL.md"),
    });
    expect(lstatSync(join(dir, "wrap-session")).isDirectory()).toBe(true);
    expect(
      readFileSync(join(dir, "wrap-session", "SKILL.md"), "utf8"),
    ).toContain("My own wrap-up.");
    expect(readFileSync(bundledFile, "utf8")).toBe(bundledText);

    expect(createSkill(dir, { name: "grill-me", description: "d" })).toEqual({
      kind: "exists",
      path: join(dir, "grill-me", "SKILL.md"),
    });
    expect(lstatSync(join(dir, "grill-me")).isSymbolicLink()).toBe(true);

    // The member's own link to a built-in under another name.
    symlinkSync(join(BUNDLED_SKILLS_DIR, "grill-me"), join(dir, "my-grill"));
    expect(createSkill(dir, { name: "my-grill", description: "d" })).toEqual({
      kind: "exists",
      path: join(dir, "my-grill", "SKILL.md"),
    });
    expect(lstatSync(join(dir, "my-grill")).isSymbolicLink()).toBe(true);
  });
});

describe("skills page validation on disk", () => {
  it("refuses malformed saves without changing bytes or revision, and permits repair with a different name", async () => {
    const user = tmp("validation");
    const path = skill(user, "mine"); // Existing description-only file remains discoverable.
    const original = readFileSync(path, "utf8");
    const opened = readSkillFile(path);
    if (opened.kind !== "ok") throw new Error("open failed");
    let refreshes = 0;
    const handlers = skillsHandlers({
      catalogFor: () =>
        buildSkillCatalog(
          [context({ userRoots: [user] })],
          {},
          "/new",
          "/home",
        ),
      readFile: readSkillFile,
      saveFile: saveSkillFile,
      deleteFile: async () => {
        throw new Error("unexpected delete");
      },
      createSkill,
      refreshMenus: () => {
        refreshes++;
      },
    });
    const save = (content: string) =>
      handlers["skills.saveFile"]({
        identity: {
          scope: "user",
          userId: "u",
          role: "member",
          capabilities: USER_CAPABILITIES,
        },
        params: {},
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
        rawBody: "",
        body: { path, content, expectedRev: opened.rev },
      });
    for (const content of [
      "body without frontmatter",
      "---\nname: mine\ndescription: test",
      "---\nnme: mine\ndescription: test\n---\nBody",
      "---\nname: mine\n---\nBody",
      "---\nname: [broken\ndescription: test\n---\nBody",
    ]) {
      expect(await save(content)).toMatchObject({
        kind: "error",
        status: 422,
        code: "invalid_skill",
      });
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readSkillFile(path)).toMatchObject({
        kind: "ok",
        rev: opened.rev,
      });
    }
    expect(refreshes).toBe(0);
    const repaired =
      "---\nname: different-name\ndescription: test\n---\nRepaired body\n";
    expect(await save(repaired)).toMatchObject({ kind: "json" });
    expect(readFileSync(path, "utf8")).toBe(repaired);
    expect(refreshes).toBe(1);
  });
});
