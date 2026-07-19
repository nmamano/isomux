// Unit tests for the Sk popover's pure grouping/ranking transform
// (skills-grouping.ts, task f1769b1a). Pins the policy Reviewer2 asked to
// freeze: cross-kind top-N ordering, the MOST_USED_CAP with overflow staying
// home, no duplicate entries, alias count absorption, and the zero-count
// layout being identical to the pre-counts grouping.

import { describe, it, expect } from "bun:test";
import {
  buildSkillsMenuGroups,
  MOST_USED_CAP,
  type CommandEntry,
} from "./skills-grouping.ts";
import type { SkillInfo } from "../../shared/types.ts";

const skill = (
  name: string,
  origin: SkillInfo["origin"] = "user",
  aliasFor?: string,
): SkillInfo => ({ name, origin, aliasFor });

const cmd = (name: string, aliasFor?: string): CommandEntry => ({
  name,
  aliasFor,
  autoRun: true,
});

const build = (input: {
  skills?: SkillInfo[];
  commands?: CommandEntry[];
  counts?: Record<string, number>;
  filter?: string;
}) =>
  buildSkillsMenuGroups({
    skills: input.skills ?? [],
    commands: input.commands ?? [],
    counts: input.counts ?? {},
    filter: input.filter ?? "",
  });

const names = (
  groups: ReturnType<typeof buildSkillsMenuGroups>,
  key: string,
): string[] =>
  groups.find((g) => g.key === key)?.skills.map((s) => s.name) ?? [];

describe("buildSkillsMenuGroups", () => {
  it("zero counts: no Most used region, original grouped alphabetical layout", () => {
    const groups = build({
      commands: [cmd("help"), cmd("clear")],
      skills: [skill("b-skill", "isomux"), skill("a-skill", "user")],
    });
    expect(groups.map((g) => g.key)).toEqual(["commands", "bundled", "user"]);
    expect(names(groups, "commands")).toEqual(["clear", "help"]);
    expect(names(groups, "bundled")).toEqual(["b-skill"]);
    expect(names(groups, "user")).toEqual(["a-skill"]);
  });

  it("ranks the top region across kinds: commands and skills interleaved by count desc, name tie-break", () => {
    const groups = build({
      commands: [cmd("clear"), cmd("help")],
      skills: [skill("tdd"), skill("verify")],
      counts: { tdd: 5, clear: 9, verify: 5, help: 0 },
    });
    expect(names(groups, "most-used")).toEqual(["clear", "tdd", "verify"]);
    // Promoted entries left their home groups; unused ones stayed.
    expect(names(groups, "commands")).toEqual(["help"]);
    expect(groups.find((g) => g.key === "user")).toBeUndefined();
  });

  it("caps the region at MOST_USED_CAP; the N+1 used entry stays home with its count", () => {
    const commands = Array.from({ length: MOST_USED_CAP }, (_, i) =>
      cmd(`c${i}`),
    );
    const counts: Record<string, number> = {};
    commands.forEach((c, i) => (counts[c.name] = 100 - i)); // c0..c7: 100..93
    counts["overflow"] = 1; // used, but 9th by count
    const groups = build({
      commands,
      skills: [skill("overflow", "user")],
      counts,
    });
    const top = names(groups, "most-used");
    expect(top).toHaveLength(MOST_USED_CAP);
    expect(top).not.toContain("overflow");
    // Overflow entry remains in its origin group, badge count intact.
    const userGroup = groups.find((g) => g.key === "user")!;
    expect(userGroup.skills).toEqual([
      expect.objectContaining({ name: "overflow", count: 1 }),
    ]);
    // No duplicates anywhere.
    const all = groups.flatMap((g) => g.skills.map((s) => s.name));
    expect(new Set(all).size).toBe(all.length);
  });

  it("alias entries absorb the hidden canonical's counts (both kinds)", () => {
    const groups = build({
      commands: [cmd("diff", "isomux-diff"), cmd("isomux-diff")],
      skills: [
        skill("nice-name", "isomux", "ugly-canonical"),
        skill("ugly-canonical", "isomux"),
      ],
      counts: { diff: 1, "isomux-diff": 2, "ugly-canonical": 4 },
    });
    const top = groups.find((g) => g.key === "most-used")!.skills;
    // Canonicals are hidden; aliases carry the summed counts.
    expect(top).toEqual([
      expect.objectContaining({ name: "nice-name", count: 4 }),
      expect.objectContaining({ name: "diff", count: 3 }),
    ]);
    expect(groups.flatMap((g) => names(groups, g.key))).not.toContain(
      "isomux-diff",
    );
  });

  it("guards against Object.prototype-named entries in the counts map", () => {
    const groups = build({
      skills: [skill("constructor"), skill("plain")],
      counts: { plain: 1 } /* "constructor" absent: must read 0, not a fn */,
    });
    expect(names(groups, "most-used")).toEqual(["plain"]);
    expect(names(groups, "user")).toEqual(["constructor"]);
  });

  it("applies the filter before ranking", () => {
    const groups = build({
      commands: [cmd("help")],
      skills: [skill("tdd")],
      counts: { help: 9, tdd: 1 },
      filter: "tdd",
    });
    expect(names(groups, "most-used")).toEqual(["tdd"]);
    expect(groups.find((g) => g.key === "commands")).toBeUndefined();
  });
});
