import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_SKILLS_DIR,
  discoverPluginSkills,
  discoverSyncedSkills,
  discoverProjectSkills,
  discoverUserSkills,
  discoverBundledSkills,
  deduplicateSkills,
  resolveSkillPrompt,
} from "./skills.ts";
import type { CommandRow, EnginePlugin } from "./backends/types.ts";
import {
  agentUserSkillRoots,
  providerUserSkillRoots,
} from "./provider-skill-links.ts";

const roots: string[] = [];
function root(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `isomux-${label}-`));
  roots.push(dir);
  return dir;
}
function skill(base: string, name: string, prompt: string): void {
  const dir = join(base, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\ndescription: ${name}\n---\n${prompt}\n`,
  );
}
function command(base: string, name: string, prompt: string): void {
  const dir = join(base, "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), prompt);
}

afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("bundled skills", () => {
  it("discovers and resolves a bundled skill from its file", () => {
    const emptyUserRoot = root("empty-user");
    const skill = discoverBundledSkills().find(
      (entry) => entry.name === "wrap-session",
    );
    // The description and the prompt are the bundled file's, not a pinned
    // sentence.
    const text = readFileSync(
      join(import.meta.dir, "..", "skills", "wrap-session", "SKILL.md"),
      "utf8",
    );
    const frontmatter = Bun.YAML.parse(
      text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "",
    ) as { description?: string };
    expect(skill?.origin).toBe("isomux");
    expect(skill?.description).toBe(frontmatter.description);
    const body = text.split("---").slice(2).join("---").trim();
    expect(body.length).toBeGreaterThan(0);
    expect(
      resolveSkillPrompt("wrap-session", root("cwd"), "claude", [
        { root: emptyUserRoot, includeCommands: true },
      ]),
    ).toContain(body);
  });

  it("keeps one picker entry when a user overrides wrap-session", () => {
    const userRoot = root("wrap-user");
    skill(userRoot, "wrap-session", "personal wrap prompt");
    const entries = deduplicateSkills([
      ...discoverUserSkills([{ root: userRoot, includeCommands: true }]),
      ...discoverBundledSkills(),
    ]).filter((entry) => entry.name === "wrap-session");
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
  });

  // The engines read frontmatter as strict YAML and drop a skill they cannot
  // parse; discoverBundledSkills reads it with a regex and would still list it.
  it("has frontmatter that parses as YAML, named after its folder", () => {
    const skillsDir = join(import.meta.dir, "..", "skills");
    const folders = readdirSync(skillsDir).filter((name) =>
      existsSync(join(skillsDir, name, "SKILL.md")),
    );
    expect(folders).toContain("isomux-report-bug");
    for (const folder of folders) {
      const text = readFileSync(join(skillsDir, folder, "SKILL.md"), "utf8");
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      let parsed: { name?: unknown; description?: unknown } = {};
      try {
        parsed = Bun.YAML.parse(frontmatter) as typeof parsed;
      } catch (err) {
        throw new Error(`skills/${folder}/SKILL.md: ${String(err)}`, {
          cause: err,
        });
      }
      const description =
        typeof parsed.description === "string" ? parsed.description.trim() : "";
      expect({
        folder,
        name: parsed.name,
        hasDescription: description !== "",
      }).toEqual({ folder, name: folder, hasDescription: true });
    }
  });

  // Task 30dd196e: OpenCode's own skill tool loads a bundled skill as it is,
  // with no office rewrite, and an OpenCode agent has no agent token. A
  // bundled skill names its office calls the engine-neutral way the reference
  // pages do, and no fixed office port.
  it("names no agent token variable and no fixed office address", () => {
    const skillsDir = join(import.meta.dir, "..", "skills");
    const folders = readdirSync(skillsDir).filter((name) =>
      existsSync(join(skillsDir, name, "SKILL.md")),
    );
    expect(folders).toContain("isomux-peer-review");
    const engineBound = folders.filter((folder) =>
      /ISOMUX_AGENT_TOKEN|\b(?:localhost|127\.0\.0\.1):\d/.test(
        readFileSync(join(skillsDir, folder, "SKILL.md"), "utf8"),
      ),
    );
    expect(engineBound).toEqual([]);
  });
});

describe("effective Claude home skill agreement", () => {
  it("lists the box Claude skills and commands after a personal home's own, which win a clash", () => {
    const external = root("external-claude-home");
    const personal = root("personal-claude-home");
    skill(external, "external-only", "external prompt");
    command(external, "external-command", "external command prompt");
    skill(external, "clash", "external clash prompt");
    skill(personal, "clash", "personal clash prompt");

    const orderedRoots = providerUserSkillRoots(
      "claude",
      "fixture-user",
      personal,
      external,
      personal,
    );
    const listed = discoverUserSkills(orderedRoots).map((item) => item.name);
    expect(listed).toContain("external-only");
    expect(listed).toContain("external-command");
    expect(
      resolveSkillPrompt("external-only", root("cwd"), "claude", orderedRoots),
    ).toBe("external prompt");
    expect(
      resolveSkillPrompt(
        "external-command",
        root("cwd"),
        "claude",
        orderedRoots,
      ),
    ).toBe("external command prompt");
    expect(
      resolveSkillPrompt("clash", root("cwd"), "claude", orderedRoots),
    ).toBe("personal clash prompt");
  });

  it("lists the box Codex skills after a personal Codex home's, without Claude commands", () => {
    const external = root("external-codex-home");
    const personal = root("personal-codex-home");
    skill(external, "codex-only", "codex prompt");
    command(external, "claude-command", "must stay hidden");

    const orderedRoots = providerUserSkillRoots(
      "codex",
      "fixture-codex-user",
      personal,
      external,
      personal,
    );
    const listed = discoverUserSkills(orderedRoots).map((item) => item.name);
    expect(listed).toContain("codex-only");
    expect(listed).not.toContain("claude-command");
    expect(
      resolveSkillPrompt("codex-only", root("cwd"), "claude", orderedRoots),
    ).toBe("codex prompt");
  });

  it("does not add the box root to an office or explicit root", () => {
    const external = root("external-home");
    const selected = root("explicit-home");
    const expectedPersonal = root("expected-personal");
    for (const provider of ["claude", "codex"] as const)
      expect(
        providerUserSkillRoots(
          provider,
          "fixture-user",
          selected,
          external,
          expectedPersonal,
        ),
      ).toEqual([{ root: selected, includeCommands: provider === "claude" }]);
  });

  it("keeps Codex roots, then ~/.agents, ahead of its existing Claude roots", () => {
    const personalCodex = root("personal-codex");
    const boxCodex = root("box-codex");
    const personalClaude = root("personal-claude");
    const boxClaude = root("box-claude");
    const userId = "ordered-user";
    const home = root("ordered-home");

    const listed = agentUserSkillRoots(
      "codex",
      userId,
      {
        CODEX_HOME: personalCodex,
        CLAUDE_CONFIG_DIR: personalClaude,
        HOME: home,
      },
      boxClaude,
      boxCodex,
      personalClaude,
      personalCodex,
    );

    expect(listed).toEqual([
      { root: personalCodex, includeCommands: false },
      { root: boxCodex, includeCommands: false },
      { root: join(home, ".agents"), includeCommands: false },
      { root: personalClaude, includeCommands: true },
      { root: boxClaude, includeCommands: true },
    ]);
  });

  it("gives OpenCode the ordered Claude roots, then ~/.agents, then the Codex sources", () => {
    const personalClaude = root("opencode-personal-claude");
    const boxClaude = root("opencode-box-claude");
    const personalCodex = root("opencode-personal-codex");
    const boxCodex = root("opencode-box-codex");
    const home = root("opencode-home");

    expect(
      agentUserSkillRoots(
        "opencode",
        "opencode-user",
        { CLAUDE_CONFIG_DIR: personalClaude, HOME: home },
        boxClaude,
        boxCodex,
        personalClaude,
        personalCodex,
      ),
    ).toEqual([
      { root: personalClaude, includeCommands: true },
      { root: boxClaude, includeCommands: true },
      { root: join(home, ".agents"), includeCommands: false },
      { root: personalCodex, includeCommands: false },
      { root: boxCodex, includeCommands: false },
    ]);
  });

  it("discovers skills and commands that exist only as links", () => {
    const scanned = root("linked-root");
    const targets = root("linked-targets");
    skill(targets, "linked-skill", "linked skill prompt");
    command(targets, "linked-command", "linked command prompt");
    mkdirSync(join(scanned, "skills"), { recursive: true });
    mkdirSync(join(scanned, "commands"), { recursive: true });
    symlinkSync(
      join(targets, "skills", "linked-skill"),
      join(scanned, "skills", "linked-skill"),
      "dir",
    );
    symlinkSync(
      join(targets, "commands", "linked-command.md"),
      join(scanned, "commands", "linked-command.md"),
      "file",
    );

    const listed = discoverUserSkills(scanned).map((item) => item.name);
    expect(listed).toEqual(["linked-skill", "linked-command"]);
    expect(
      resolveSkillPrompt("linked-skill", root("cwd"), "claude", scanned),
    ).toBe("linked skill prompt");
    expect(
      resolveSkillPrompt("linked-command", root("cwd"), "claude", scanned),
    ).toBe("linked command prompt");
  });

  it("lists and executes user skills and commands from the same home", () => {
    const home = root("user-home");
    skill(home, "personal-skill", "personal skill prompt");
    command(home, "personal-command", "personal command prompt");
    const listed = discoverUserSkills(home).map((item) => item.name);
    expect(listed).toContain("personal-skill");
    expect(listed).toContain("personal-command");
    expect(
      resolveSkillPrompt("personal-skill", root("cwd"), "claude", home),
    ).toBe("personal skill prompt");
    expect(
      resolveSkillPrompt("personal-command", root("cwd"), "claude", home),
    ).toBe("personal command prompt");
  });

  it("does not list skill-root infrastructure without a SKILL.md", () => {
    const home = root("user-home-infrastructure");
    mkdirSync(join(home, "skills", ".system", "internal"), {
      recursive: true,
    });

    expect(discoverUserSkills(home)).toEqual([]);
    expect(
      resolveSkillPrompt(".system", root("cwd"), "claude", home),
    ).toBeNull();
  });

  it("lists and executes plugin skills and commands from the same home", () => {
    const home = root("plugin-home");
    const install = root("plugin-install");
    skill(install, "do-work", "plugin skill prompt");
    command(install, "legacy", "plugin command prompt");
    const manifestDir = join(home, "plugins");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "installed_plugins.json"),
      JSON.stringify({
        plugins: { "helper@test": [{ installPath: install }] },
      }),
    );
    // An install enables the plugin in the user settings.
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ enabledPlugins: { "helper@test": true } }),
    );
    const listed = discoverPluginSkills(home).map((item) => item.name);
    expect(listed).toContain("helper:do-work");
    expect(listed).toContain("helper:legacy");
    expect(
      resolveSkillPrompt("helper:do-work", root("cwd"), "claude", home),
    ).toBe("plugin skill prompt");
    expect(
      resolveSkillPrompt("helper:legacy", root("cwd"), "claude", home),
    ).toBe("plugin command prompt");
  });

  it("keeps project skills and commands rooted at cwd", () => {
    const home = root("personal-home");
    const cwd = root("project-cwd");
    const projectClaude = join(cwd, ".claude");
    skill(projectClaude, "project-skill", "project skill prompt");
    command(projectClaude, "project-command", "project command prompt");
    const listed = discoverProjectSkills(cwd, "claude").map(
      (item) => item.name,
    );
    expect(listed).toContain("project-skill");
    expect(listed).toContain("project-command");
    expect(resolveSkillPrompt("project-skill", cwd, "claude", home)).toBe(
      "project skill prompt",
    );
    expect(resolveSkillPrompt("project-command", cwd, "claude", home)).toBe(
      "project command prompt",
    );
  });
});

// The plugins whose skills the Sk menu lists and skill lookup runs (task
// 66645144). Without a live Claude process the disk decides:
// installed_plugins.json, minus what the settings files do not enable. A live
// process's own list replaces the disk read. Menu and lookup always agree.
describe("plugin list", () => {
  // Installs each plugin under `home` with one skill `<name>:s-<name>`.
  function installAll(home: string, names: string[]): void {
    const plugins: Record<string, { installPath: string }[]> = {};
    for (const name of names) {
      const install = join(home, "cache", name);
      skill(install, `s-${name}`, `${name} prompt`);
      plugins[`${name}@m`] = [{ installPath: install }];
    }
    mkdirSync(join(home, "plugins"), { recursive: true });
    writeFileSync(
      join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins }),
    );
  }
  function settings(path: string, enabledPlugins: Record<string, boolean>) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabledPlugins }));
  }
  const listed = (home: string, cwd: string, reported?: EnginePlugin[]) =>
    discoverPluginSkills(home, cwd, reported)
      .map((item) => item.name)
      .sort();
  const lookup = (
    name: string,
    home: string,
    cwd: string,
    reported?: EnginePlugin[],
  ) => resolveSkillPrompt(name, cwd, "claude", home, true, undefined, reported);

  it("without a live list, shows and runs a plugin only when the winning settings layer enables it", () => {
    const home = root("plugin-settings-home");
    const cwd = root("plugin-settings-cwd");
    const all = ["on", "off", "unset", "projectOff", "projectOn", "localOff"];
    installAll(home, all);
    // User, then project, then local: the later file wins per key.
    settings(join(home, "settings.json"), {
      "on@m": true,
      "off@m": false,
      "projectOff@m": true,
      "projectOn@m": false,
    });
    settings(join(cwd, ".claude", "settings.json"), {
      "projectOff@m": false,
      "projectOn@m": true,
      "localOff@m": true,
    });
    settings(join(cwd, ".claude", "settings.local.json"), {
      "localOff@m": false,
    });
    // A key with no value in any file does not load in the CLI (measured,
    // 2026-10-20), so "unset" does not show either.
    const shown = ["on", "projectOn"];
    expect(listed(home, cwd)).toEqual(
      shown.map((name) => `${name}:s-${name}`).sort(),
    );
    for (const name of all)
      expect(lookup(`${name}:s-${name}`, home, cwd), name).toBe(
        shown.includes(name) ? `${name} prompt` : null,
      );
  });

  it("with a live list, the process's plugins and folders are the answer", () => {
    const home = root("plugin-live-home");
    const cwd = root("plugin-live-cwd");
    // Installed and enabled on disk: "copy" (the process loads it from
    // another folder) and "notLoaded" (the process did not load it).
    installAll(home, ["copy", "notLoaded"]);
    settings(join(home, "settings.json"), {
      "copy@m": true,
      "notLoaded@m": true,
      // The process loaded it anyway; its list wins over this prediction.
      "offDisk@m": false,
    });
    const src = root("plugin-live-src");
    skill(join(src, "copy"), "s-copy", "copy live prompt");
    skill(join(src, "offDisk"), "s-offDisk", "offDisk prompt");
    const reported: EnginePlugin[] = [
      { name: "copy", path: join(src, "copy"), source: "copy@m" },
      { name: "offDisk", path: join(src, "offDisk"), source: "offDisk@m" },
      // Built into the CLI: no folder.
      { name: "core", path: "builtin", source: "core@builtin" },
      // A folder that is gone.
      { name: "gone", path: join(src, "gone"), source: "gone@m" },
    ];
    expect(listed(home, cwd, reported)).toEqual([
      "copy:s-copy",
      "offDisk:s-offDisk",
    ]);
    expect(lookup("copy:s-copy", home, cwd, reported)).toBe("copy live prompt");
    expect(lookup("offDisk:s-offDisk", home, cwd, reported)).toBe(
      "offDisk prompt",
    );
    expect(lookup("notLoaded:s-notLoaded", home, cwd, reported)).toBeNull();
    // Enabled on disk, so the disk read alone shows it.
    expect(lookup("notLoaded:s-notLoaded", home, cwd)).toBe("notLoaded prompt");
  });

  it("an empty live list means the process loaded no plugin", () => {
    const home = root("plugin-empty-home");
    const cwd = root("plugin-empty-cwd");
    installAll(home, ["on"]);
    settings(join(home, "settings.json"), { "on@m": true });
    expect(listed(home, cwd)).toEqual(["on:s-on"]);
    expect(listed(home, cwd, [])).toEqual([]);
    expect(lookup("on:s-on", home, cwd, [])).toBeNull();
  });
});

// Account-synced Claude Code skills (task 66645144, from 211da772). Without a
// live Claude process the menu reads <cfg>/skills/synced/<bucket>/<name>/;
// with one, the process's command rows replace that read.
describe("synced skills", () => {
  function synced(home: string, bucket: string, name: string, body: string) {
    const dir = join(home, "skills", "synced", bucket, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${body} description\n---\n${body}\n`,
    );
  }

  it("without rows, lists and runs each synced folder once, after the user's own skills", () => {
    const home = root("synced-home");
    const cwd = root("synced-cwd");
    synced(home, "bucket-a", "docx", "docx from a");
    synced(home, "bucket-b", "docx", "docx from b");
    synced(home, "bucket-b", "pdf", "pdf body");
    // Not skills: a bucket's manifest file and a folder without SKILL.md.
    writeFileSync(
      join(home, "skills", "synced", "bucket-a", "manifest.json"),
      "{}",
    );
    mkdirSync(join(home, "skills", "synced", "bucket-a", "empty"));
    const listed = discoverSyncedSkills(home, null, new Set());
    expect(listed.map((s) => s.name).sort()).toEqual(["docx", "pdf"]);
    expect(listed.every((s) => s.origin === "user")).toBe(true);
    // The menu and the lookup take the same copy of a name in two buckets.
    const docx = listed.find((s) => s.name === "docx")!;
    const ran = resolveSkillPrompt(
      "docx",
      cwd,
      "claude",
      home,
      true,
      undefined,
      null,
      null,
    );
    expect(ran === null ? null : `${ran} description`).toBe(docx.description!);
    expect(
      resolveSkillPrompt(
        "pdf",
        cwd,
        "claude",
        home,
        true,
        undefined,
        null,
        null,
      ),
    ).toBe("pdf body");
    // The user's own skill of the same name wins the lookup.
    const user = root("synced-user");
    skill(user, "pdf", "user pdf");
    expect(
      resolveSkillPrompt(
        "pdf",
        cwd,
        "claude",
        [{ root: user, includeCommands: true }],
        true,
        home,
        null,
        null,
      ),
    ).toBe("user pdf");
  });

  it("with rows, lists the process's own skills the rest of the menu lacks, and leaves their run to the process", () => {
    const home = root("synced-rows-home");
    const cwd = root("synced-rows-cwd");
    synced(home, "bucket", "docx", "docx body");
    synced(home, "bucket", "pdf", "pdf body");
    const rows: CommandRow[] = [
      { name: "docx", description: "Docs", aliases: ["anthropic-skills:docx"] },
      { name: "anthropic-skills:deep-research", description: "Research" },
      { name: "clear", description: "Clear", builtin: true },
      { name: "mcp__srv__prompt", description: "An MCP prompt" },
      // Listed elsewhere in the menu, by name or by alias.
      { name: "mine", description: "Mine" },
      { name: "theirs", description: "Theirs", aliases: ["mine-too"] },
    ];
    const listed = discoverSyncedSkills(
      home,
      rows,
      new Set(["mine", "mine-too"]),
    );
    expect(
      listed.map((s) => ({
        name: s.name,
        origin: s.origin,
        description: s.description,
      })),
    ).toEqual([
      { name: "docx", origin: "user", description: "Docs" },
      {
        name: "anthropic-skills:deep-research",
        origin: "user",
        description: "Research",
      },
    ]);
    // The folder is not read: "pdf" is on disk but not in the rows, and a
    // synced name does not resolve to its folder's text.
    expect(
      resolveSkillPrompt(
        "pdf",
        cwd,
        "claude",
        home,
        true,
        undefined,
        null,
        rows,
      ),
    ).toBeNull();
    expect(
      resolveSkillPrompt(
        "docx",
        cwd,
        "claude",
        home,
        true,
        undefined,
        null,
        rows,
      ),
    ).toBeNull();
    // An empty row list is a list.
    expect(discoverSyncedSkills(home, [], new Set())).toEqual([]);
  });
});

// Task e832fc7c: a Claude or Codex agent's own skill tool reads only its
// provider home's skills folder, so the bundled skills are linked there. A
// link is isomux's when its target (read one level) is in the bundled folder.
describe("an old bundled-skill link in a user folder", () => {
  it("lists a bundled skill linked into a user folder once, as built in, and a member's link under another name as theirs", () => {
    const user = root("user-home");
    mkdirSync(join(user, "skills"));
    symlinkSync(
      join(BUNDLED_SKILLS_DIR, "wrap-session"),
      join(user, "skills", "wrap-session"),
    );
    symlinkSync(
      join(BUNDLED_SKILLS_DIR, "wrap-session"),
      join(user, "skills", "my-wrap"),
    );
    skill(user, "member-own", "member prompt");
    const roots = [{ root: user, includeCommands: true }];

    const userNames = discoverUserSkills(roots).map((entry) => entry.name);
    expect(userNames).toContain("member-own");
    expect(userNames).toContain("my-wrap");
    expect(userNames).not.toContain("wrap-session");
    const listed = deduplicateSkills([
      ...discoverUserSkills(roots),
      ...discoverBundledSkills(),
    ]).filter((entry) => entry.name === "wrap-session");
    expect(listed.map((entry) => entry.origin)).toEqual(["isomux"]);
  });
});
