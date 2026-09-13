import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPluginSkills,
  discoverProjectSkills,
  discoverUserSkills,
  resolveSkillPrompt,
} from "./skills.ts";
import {
  agentUserSkillRoots,
  exposePersonalProviderSkills,
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

describe("effective Claude home skill agreement", () => {
  it("exposes external Claude skills in a personal home and keeps personal clashes", () => {
    const external = root("external-claude-home");
    const personal = root("personal-claude-home");
    skill(external, "external-only", "external prompt");
    command(external, "external-command", "external command prompt");
    skill(external, "clash", "external clash prompt");
    const userId = "fixture-user";
    skill(personal, "clash", "personal clash prompt");
    exposePersonalProviderSkills(
      "claude",
      userId,
      personal,
      external,
      personal,
    );

    const orderedRoots = providerUserSkillRoots(
      "claude",
      userId,
      personal,
      external,
      personal,
    );
    const listed = discoverUserSkills(orderedRoots).map((item) => item.name);
    expect(lstatSync(join(personal, "skills", "external-only")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      lstatSync(join(personal, "commands", "external-command.md")).isSymbolicLink(),
    ).toBe(true);
    expect(listed).toContain("external-only");
    expect(listed).toContain("external-command");
    expect(resolveSkillPrompt("external-only", root("cwd"), orderedRoots)).toBe(
      "external prompt",
    );
    expect(
      resolveSkillPrompt("external-command", root("cwd"), orderedRoots),
    ).toBe("external command prompt");
    expect(resolveSkillPrompt("clash", root("cwd"), orderedRoots)).toBe(
      "personal clash prompt",
    );

    rmSync(join(external, "skills", "external-only"), {
      recursive: true,
      force: true,
    });
    const outside = root("outside-skill");
    skill(outside, "kept-link-target", "outside prompt");
    symlinkSync(
      join(outside, "skills", "kept-link-target"),
      join(personal, "skills", "outside-link"),
      "dir",
    );
    exposePersonalProviderSkills("claude", userId, personal, external, personal);
    expect(existsSync(join(personal, "skills", "external-only"))).toBe(
      false,
    );
    expect(existsSync(join(personal, "skills", "outside-link"))).toBe(true);
    expect(resolveSkillPrompt("clash", root("cwd"), orderedRoots)).toBe(
      "personal clash prompt",
    );

    skill(external, "cross-box", "current box prompt");
    symlinkSync(
      "/home/oldbox/.claude/skills/cross-box",
      join(personal, "skills", "cross-box"),
      "dir",
    );
    exposePersonalProviderSkills("claude", userId, personal, external, personal);
    expect(
      readlinkSync(join(personal, "skills", "cross-box")),
    ).toBe(join(external, "skills", "cross-box"));
  });

  it("exposes external Codex skills without Claude commands", () => {
    const external = root("external-codex-home");
    const personal = root("personal-codex-home");
    skill(external, "codex-only", "codex prompt");
    command(external, "claude-command", "must stay hidden");

    const userId = "fixture-codex-user";
    exposePersonalProviderSkills("codex", userId, personal, external, personal);

    const orderedRoots = providerUserSkillRoots(
      "codex",
      userId,
      personal,
      external,
      personal,
    );
    const listed = discoverUserSkills(orderedRoots).map(
      (item) => item.name,
    );
    expect(listed).toContain("codex-only");
    expect(listed).not.toContain("claude-command");
    expect(resolveSkillPrompt("codex-only", root("cwd"), orderedRoots)).toBe(
      "codex prompt",
    );
  });

  it("does not expose box skills to an office or explicit root", () => {
    const external = root("external-home");
    const selected = root("explicit-home");
    skill(external, "must-not-leak", "private prompt");

    const expectedPersonal = root("expected-personal");
    exposePersonalProviderSkills(
      "claude",
      "fixture-user",
      selected,
      external,
      expectedPersonal,
    );

    expect(
      providerUserSkillRoots(
        "claude",
        "fixture-user",
        selected,
        external,
        expectedPersonal,
      ),
    ).toEqual([{ root: selected, includeCommands: true }]);
    expect(existsSync(join(selected, "skills", "must-not-leak"))).toBe(false);
    expect(
      existsSync(join(expectedPersonal, "skills", "must-not-leak")),
    ).toBe(false);

    const selectedCodex = root("explicit-codex-home");
    const expectedPersonalCodex = root("expected-personal-codex");
    exposePersonalProviderSkills(
      "codex",
      "fixture-user",
      selectedCodex,
      external,
      expectedPersonalCodex,
    );
    expect(
      providerUserSkillRoots(
        "codex",
        "fixture-user",
        selectedCodex,
        external,
        expectedPersonalCodex,
      ),
    ).toEqual([{ root: selectedCodex, includeCommands: false }]);
    expect(existsSync(join(selectedCodex, "skills", "must-not-leak"))).toBe(
      false,
    );
    expect(
      existsSync(join(expectedPersonalCodex, "skills", "must-not-leak")),
    ).toBe(false);
  });

  it("keeps Codex roots ahead of its existing Claude roots", () => {
    const personalCodex = root("personal-codex");
    const boxCodex = root("box-codex");
    const personalClaude = root("personal-claude");
    const boxClaude = root("box-claude");
    const userId = "ordered-user";

    const listed = agentUserSkillRoots(
      "codex",
      userId,
      {
        CODEX_HOME: personalCodex,
        CLAUDE_CONFIG_DIR: personalClaude,
      },
      boxClaude,
      boxCodex,
      personalClaude,
      personalCodex,
    );

    expect(listed).toEqual([
      { root: personalCodex, includeCommands: false },
      { root: boxCodex, includeCommands: false },
      { root: personalClaude, includeCommands: true },
      { root: boxClaude, includeCommands: true },
    ]);
  });

  it("gives OpenCode the exact ordered Claude roots", () => {
    const personalClaude = root("opencode-personal-claude");
    const boxClaude = root("opencode-box-claude");

    expect(
      agentUserSkillRoots(
        "opencode",
        "opencode-user",
        { CLAUDE_CONFIG_DIR: personalClaude },
        boxClaude,
        root("unused-box-codex"),
        personalClaude,
        root("unused-personal-codex"),
      ),
    ).toEqual([
      { root: personalClaude, includeCommands: true },
      { root: boxClaude, includeCommands: true },
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
    expect(resolveSkillPrompt("linked-skill", root("cwd"), scanned)).toBe(
      "linked skill prompt",
    );
    expect(resolveSkillPrompt("linked-command", root("cwd"), scanned)).toBe(
      "linked command prompt",
    );
  });

  it("lists and executes user skills and commands from the same home", () => {
    const home = root("user-home");
    skill(home, "personal-skill", "personal skill prompt");
    command(home, "personal-command", "personal command prompt");
    const listed = discoverUserSkills(home).map((item) => item.name);
    expect(listed).toContain("personal-skill");
    expect(listed).toContain("personal-command");
    expect(resolveSkillPrompt("personal-skill", root("cwd"), home)).toBe(
      "personal skill prompt",
    );
    expect(resolveSkillPrompt("personal-command", root("cwd"), home)).toBe(
      "personal command prompt",
    );
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
    const listed = discoverPluginSkills(home).map((item) => item.name);
    expect(listed).toContain("helper:do-work");
    expect(listed).toContain("helper:legacy");
    expect(resolveSkillPrompt("helper:do-work", root("cwd"), home)).toBe(
      "plugin skill prompt",
    );
    expect(resolveSkillPrompt("helper:legacy", root("cwd"), home)).toBe(
      "plugin command prompt",
    );
  });

  it("keeps project skills and commands rooted at cwd", () => {
    const home = root("personal-home");
    const cwd = root("project-cwd");
    const projectClaude = join(cwd, ".claude");
    skill(projectClaude, "project-skill", "project skill prompt");
    command(projectClaude, "project-command", "project command prompt");
    const listed = discoverProjectSkills(cwd).map((item) => item.name);
    expect(listed).toContain("project-skill");
    expect(listed).toContain("project-command");
    expect(resolveSkillPrompt("project-skill", cwd, home)).toBe(
      "project skill prompt",
    );
    expect(resolveSkillPrompt("project-command", cwd, home)).toBe(
      "project command prompt",
    );
  });
});
