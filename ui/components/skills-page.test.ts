import { describe, expect, it } from "bun:test";
import type { SkillCatalogEntry } from "../../shared/contract-shapes.ts";
import {
  groupSkills,
  partitionSkills,
  skillBody,
  tildePath,
  validSkillName,
} from "./skills-page.ts";

function entry(over: Partial<SkillCatalogEntry>): SkillCatalogEntry {
  return {
    name: "x",
    source: "user",
    kind: "skill",
    path: "/h/x/SKILL.md",
    dir: "/h",
    editable: true,
    uses: 0,
    ...over,
  };
}

describe("groupSkills", () => {
  it("puts the member's own skills first and built-ins last", () => {
    const groups = groupSkills(
      [
        entry({ name: "b", source: "isomux" }),
        entry({ name: "p", source: "plugin" }),
        entry({ name: "u", source: "user" }),
        entry({ name: "r", source: "project" }),
      ],
      "",
    );
    expect(groups.map((g) => g.source)).toEqual([
      "user",
      "project",
      "plugin",
      "isomux",
    ]);
  });

  it("orders skills that run before shadowed ones, then by name", () => {
    const [group] = groupSkills(
      [
        entry({ name: "a", shadowedBy: "/other" }),
        entry({ name: "c" }),
        entry({ name: "b" }),
      ],
      "",
    );
    expect(group.skills.map((s) => s.name)).toEqual(["b", "c", "a"]);
  });

  it("filters on name, description and path, and drops empty groups", () => {
    const skills = [
      entry({ name: "deploy", description: "ship it" }),
      entry({ name: "notes", source: "isomux", path: "/opt/notes/SKILL.md" }),
    ];
    expect(groupSkills(skills, "SHIP")[0].skills[0].name).toBe("deploy");
    expect(groupSkills(skills, "/opt/").map((g) => g.source)).toEqual([
      "isomux",
    ]);
    expect(groupSkills(skills, "nothing")).toEqual([]);
  });
});

describe("tildePath", () => {
  it("shortens only paths under the home folder", () => {
    expect(tildePath("/home/a/.claude/skills", "/home/a")).toBe(
      "~/.claude/skills",
    );
    expect(tildePath("/home/ab/x", "/home/a")).toBe("/home/ab/x");
    expect(tildePath("/home/a", "/home/a/")).toBe("~");
    expect(tildePath("/x", "")).toBe("/x");
  });
});

describe("skillBody", () => {
  it("drops the frontmatter and keeps the rest", () => {
    expect(skillBody("---\nname: a\n---\n# Title\nText\n")).toBe(
      "# Title\nText\n",
    );
    expect(skillBody("# No frontmatter\n")).toBe("# No frontmatter\n");
  });
});

describe("validSkillName", () => {
  it("matches the server's name rule", () => {
    for (const ok of ["a", "triage-bugs", "x1-2"])
      expect(validSkillName(ok)).toBe(true);
    for (const bad of ["", "A", "a--b", "-a", "a-", "a b", "x".repeat(65)])
      expect(validSkillName(bad)).toBe(false);
  });
});

describe("partitionSkills", () => {
  it("shows an exact runnable file once and leaves shadowed or engine-only files in their engines", () => {
    const shared = entry({ name: "shared" });
    const shadowed = entry({ name: "shadowed", path: "/shadowed/SKILL.md" });
    const only = entry({ name: "only", path: "/only/SKILL.md" });
    const engines = (["claude", "codex", "opencode"] as const).map(
      (engine) => ({
        engine,
        skills: [
          shared,
          engine === "codex"
            ? { ...shadowed, shadowedBy: "/winner" }
            : shadowed,
          ...(engine === "claude" ? [only] : []),
        ],
      }),
    );
    const result = partitionSkills(engines);
    expect(result.shared).toEqual([shared]);
    expect(result.engines.map((e) => e.skills.map((s) => s.name))).toEqual([
      ["shadowed", "only"],
      ["shadowed"],
      ["shadowed"],
    ]);
    expect(result.engines[1].skills[0].shadowedBy).toBe("/winner");
  });

  it("keeps equal names at different paths, aliases, and incomplete engine catalogs separate", () => {
    const engines = (["claude", "codex", "opencode"] as const).map(
      (engine) => ({
        engine,
        skills: [
          entry({ name: "same-name", path: `/${engine}/SKILL.md` }),
          entry({ name: engine, path: "/same-file/SKILL.md" }),
        ],
      }),
    );
    expect(partitionSkills(engines).shared).toEqual([]);
    expect(partitionSkills(engines).engines).toEqual(engines);
    expect(
      partitionSkills([{ engine: "claude", skills: [entry({})] }]).shared,
    ).toEqual([]);
  });
});
