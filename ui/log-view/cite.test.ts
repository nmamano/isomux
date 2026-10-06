import { describe, expect, it } from "bun:test";
import { Text } from "@codemirror/state";
import { citationBlock, citedLines } from "./cite.ts";

describe("citationBlock", () => {
  it("fences the cited text and ends with a newline", () => {
    const block = citationBlock("one\ntwo");
    expect(block.startsWith('Cited text:\n"""\n')).toBe(true);
    expect(block.endsWith('\n"""\n')).toBe(true);
    expect(block).toContain("one\ntwo");
  });

  it("escapes every dollar so two of them never open inline math", () => {
    const block = citationBlock("GET localhost:$PORT/x with $TOKEN");
    expect(block).toContain("localhost:\\$PORT/x with \\$TOKEN");
    expect(block.match(/(?<!\\)\$/g)).toBeNull();
  });
});

describe("citationBlock with an editor source", () => {
  it("names the file and the line range", () => {
    const block = citationBlock("a\nb", {
      path: "/repo/src/x.ts",
      fromLine: 12,
      toLine: 13,
    });
    const header = block.split("\n")[0];
    expect(header).toContain("/repo/src/x.ts");
    expect(header).toMatch(/\b12\b.*\b13\b/);
    expect(block).toContain('"""\na\nb\n"""');
  });

  it("shortens a home directory to ~", () => {
    const header = citationBlock("a", {
      path: "/home/nil/blog/post.mdx",
      fromLine: 1,
      toLine: 1,
    }).split("\n")[0];
    expect(header).toContain("~/blog/post.mdx");
    expect(header).not.toContain("/home/");
  });

  it("names one line when the range is one line", () => {
    const header = citationBlock("a", {
      path: "x.ts",
      fromLine: 7,
      toLine: 7,
    }).split("\n")[0];
    expect(header).toMatch(/\b7\b/);
    expect(header).not.toMatch(/7\s*-\s*7/);
  });
});

describe("citedLines", () => {
  const doc = Text.of(["zero", "one", "two", "three"]);
  const at = (line: number, col = 0) => doc.line(line).from + col;

  it("spans the lines the selection touches", () => {
    expect(citedLines(doc, at(2, 1), at(3, 2))).toEqual({
      fromLine: 2,
      toLine: 3,
    });
  });

  it("drops the line a whole-line selection ends at the start of", () => {
    expect(citedLines(doc, at(2), at(4))).toEqual({ fromLine: 2, toLine: 3 });
  });

  it("keeps a selection inside one line on that line", () => {
    expect(citedLines(doc, at(3, 1), at(3, 3))).toEqual({
      fromLine: 3,
      toLine: 3,
    });
  });
});
