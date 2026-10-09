import { describe, expect, it } from "bun:test";
import { skillFileProblem } from "./skill-validation.ts";

const file = (fields: string) => `---\n${fields}\n---\n# Instructions\n`;

describe("skill page validation", () => {
  it("identifies missing delimiters, invalid YAML and required metadata", () => {
    for (const [content, problem] of [
      ["# Instructions", "frontmatter"],
      ["---\nname: test\ndescription: test", "unclosed"],
      [file("name: [broken\ndescription: test"), "yaml"],
      [file("name: a\nname: b\ndescription: test"), "yaml"],
      [file("- test"), "mapping"],
      [file("nme: test\ndescription: test"), "name"],
      [file("name: ' '\ndescription: test"), "name"],
      [file("name: [test]\ndescription: test"), "name"],
      [file("name: test"), "description"],
      [file("name: test\ndescription: null"), "description"],
      [file("name: test\ndescription: ''"), "description"],
    ] as const)
      expect(skillFileProblem(content)).toBe(`skills.invalid.${problem}`);
  });

  it("accepts quoted and multiline fields, CRLF, and extra YAML metadata", () => {
    expect(
      skillFileProblem(
        file(
          'name: different-name\ndescription: "Sort bugs: severity first # then age"',
        ),
      ),
    ).toBeNull();
    expect(
      skillFileProblem(
        file(
          "name: test\ndescription: >-\n  First line\n  second line\nmetadata:\n  tags: [a, b]",
        ).replaceAll("\n", "\r\n"),
      ),
    ).toBeNull();
  });

  it("reports broken alias references without throwing", () => {
    expect(skillFileProblem(file("name: test\ndescription: *missing"))).toBe(
      "skills.invalid.yaml",
    );
  });
});
