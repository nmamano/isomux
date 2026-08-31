import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPluginSkills,
  discoverProjectSkills,
  discoverUserSkills,
  resolveSkillPrompt,
} from "./skills.ts";

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
