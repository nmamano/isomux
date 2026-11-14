import { describe, expect, it } from "bun:test";
import { Text } from "@codemirror/state";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { citationBlock, citedLines, insertCite } from "./cite.ts";
import { dollarMath, renderMarkdown } from "./Markdown.tsx";

const render = (source: string) => renderMarkdown(translatorFor("en"), source);

describe("citationBlock", () => {
  it("fences the cited text and ends with a newline", () => {
    const block = citationBlock("one\ntwo");
    expect(block.startsWith('Cited text:\n"""\n')).toBe(true);
    expect(block.endsWith('\n"""\n')).toBe(true);
    expect(block).toContain("one\ntwo");
  });

  it("keeps dollars as typed", () => {
    const block = citationBlock("GET localhost:$PORT/x with $TOKEN");
    expect(block).toContain("GET localhost:$PORT/x with $TOKEN");
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

// A cite goes into the draft as typed, unless its dollars would render as
// math in that draft (Nil, 2026-09-16: a cite turned into KaTeX). Nil's price
// row (2026-10-24) came out with a backslash before each dollar.
describe("insertCite", () => {
  const PRICE_ROW = "antifeed.dev\t$9.99 / $13";

  it("inserts a price row byte for byte", () => {
    const block = citationBlock(PRICE_ROW);
    const { draft, caret } = insertCite("", block);
    expect(draft).toBe(block);
    expect(draft).not.toContain("\\");
    expect(caret).toBe(draft.length);
  });

  it("escapes a cite that would render as math, and it shows as typed", () => {
    const { draft } = insertCite("", citationBlock("echo $HOME/$USER"));
    expect(dollarMath(draft)).toEqual([]);
    expect(render(draft)).toContain("echo $HOME/$USER");
  });

  // Each cite alone renders no math; one line break joins them into one
  // paragraph, where the dollar of the first pairs with the dollar of the
  // second.
  it("escapes a cite whose dollar pairs with one already in the draft", () => {
    const prior = citationBlock("it costs $5 now");
    const block = citationBlock("set A=$B");
    expect(dollarMath(prior)).toEqual([]);
    expect(dollarMath(block)).toEqual([]);
    const { draft } = insertCite(prior, block, {
      start: prior.length,
      end: prior.length,
    });
    expect(dollarMath(draft)).toEqual([]);
    const shown = render(draft);
    expect(shown).toContain("it costs $5 now");
    expect(shown).toContain("set A=$B");
  });

  // Escaping this cite would hand the open dollar in the draft a closing one
  // (\$H after $B), so the cite must go in as typed.
  it("keeps a cite as typed when escaping it would add math", () => {
    const prior = citationBlock("set A=$B");
    const block = citationBlock("run $HOME now");
    const { draft } = insertCite(prior, block, {
      start: prior.length,
      end: prior.length,
    });
    expect(draft).toContain(block);
    expect(dollarMath(draft)).toEqual([]);
  });

  it("keeps a cite as typed when a blank line keeps its dollars apart", () => {
    const prior = citationBlock("it costs $5 now");
    const block = citationBlock("set A=$B");
    const { draft } = insertCite(prior, block);
    expect(draft.endsWith(block)).toBe(true);
    expect(dollarMath(draft)).toEqual([]);
  });

  it("keeps a cite as typed next to math the member wrote", () => {
    const prior = "see $x$ here";
    const block = citationBlock("it costs $5 now");
    const { draft } = insertCite(prior, block, {
      start: prior.length,
      end: prior.length,
    });
    expect(draft).toContain(block);
    expect(dollarMath(draft)).toEqual(["$x$"]);
  });

  it("inserts a fenced block with dollars byte for byte", () => {
    const prior = "x=$y";
    const block = "```\n$a$ and $b$\n```\n";
    const { draft } = insertCite(prior, block, {
      start: prior.length,
      end: prior.length,
    });
    expect(draft).toContain(block);
  });

  it("replaces the selection and puts one line break on each side", () => {
    const block = citationBlock("a");
    const { draft, caret } = insertCite("keep DROP tail", block, {
      start: 5,
      end: 9,
    });
    expect(draft).toBe(`keep \n${block}\n tail`);
    expect(draft.slice(caret)).toBe(" tail");
  });

  it("puts the caret after the block it escaped", () => {
    const { draft, caret } = insertCite(
      "x\ny",
      citationBlock("echo $HOME/$USER"),
      { start: 2, end: 2 },
    );
    expect(dollarMath(draft)).toEqual([]);
    expect(draft.slice(caret)).toBe("y");
  });
});
