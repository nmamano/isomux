import { describe, expect, it } from "bun:test";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { dollarMath, renderMarkdown } from "./Markdown.tsx";

const EN = translatorFor("en");
const render = (source: string) => renderMarkdown(EN, source);

describe("renderMarkdown math", () => {
  it.each([
    ["$$x^2$$", "true"],
    [String.raw`\[x^2\]`, "true"],
    ["Value: $x^2$.", "false"],
    [String.raw`Value: \(x^2\).`, "false"],
  ])("renders %s as math, display=%s", (source, display) => {
    const html = render(source);
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain(`data-katex-display="${display}"`);
  });

  // Each row: the source, and the text it must show as is. None renders math,
  // and none splits the paragraph with a <br>.
  it.each([
    [
      "dollar amounts and an unmatched dollar",
      "It costs $20.00 and this $ stays.",
      "It costs $20.00 and this $ stays.",
    ],
    [
      "backslash-escaped dollars",
      String.raw`Set \$A,\$B now.`,
      "Set $A,$B now.",
    ],
    ["a closing dollar followed by a digit", "Keep $x$2 literal.", "$x$2"],
    [
      "an escaped dollar after an open one",
      String.raw`Use $B and \$H.`,
      "Use $B and $H.",
    ],
    [
      "an escaped dollar before $$ after an open $$",
      String.raw`Pay $$x and \$$ y.`,
      "Pay $$x and $$ y.",
    ],
    [
      "an opening dollar followed by whitespace",
      "Pay $ 5$ now.",
      "Pay $ 5$ now.",
    ],
    [
      "an unmatched $$",
      "Use $$ to open display math.",
      "Use $$ to open display math.",
    ],
    [
      "the shell's $$",
      "Run echo $$ to print the pid.",
      "Run echo $$ to print the pid.",
    ],
    [
      "paired shell $$",
      "compare echo $$ in the parent with echo $$ in the child",
      "compare echo $$ in the parent with echo $$ in the child",
    ],
    [
      "Makefile $$",
      "In a Makefile write $$HOME, not $HOME, to reach $$PATH.",
      "In a Makefile write $$HOME, not $HOME, to reach $$PATH.",
    ],
    [
      "an escaped index",
      String.raw`An index like a\[0\] is fine.`,
      "An index like a[0] is fine.",
    ],
    [
      "an unmatched \\[",
      String.raw`Write \[ to open display math.`,
      "Write [ to open display math.",
    ],
    [
      "paired \\[ \\] in prose",
      String.raw`So \[x^2\] holds.`,
      "So [x^2] holds.",
    ],
  ])("keeps %s literal", (_name, source, shown) => {
    const html = render(source);
    expect(html).not.toContain('class="katex-math"');
    expect(html).not.toContain("<br>");
    expect(html).toContain(shown);
  });

  it("renders the same dollars as math without the escape", () => {
    // The control for the escaped row above.
    expect(render("Set $A,$B now.")).toContain('class="katex-math"');
  });

  it("does not render math delimiters inside code", () => {
    const html = render("`$x$`\n\n```text\n$$x^2$$\n```");
    expect(html).not.toContain('class="katex-math"');
    expect(html).toContain("$x$");
    expect(html).toContain("$$x^2$$");
    expect(render("`$$y$$`")).toContain("<code>$$y$$</code>");
  });

  it("keeps display math in its paragraph", () => {
    const adjacent = render("a$$x$$");
    expect(adjacent).toContain("<p>a");
    expect(adjacent).toContain('data-katex-source="x"');
    expect(adjacent).toContain("</span></p>");
    const prose = render("So $$x^2$$ holds.");
    expect(prose).not.toContain("<br>");
    expect(prose).toContain('data-katex-source="x^2"');
    expect(prose).toContain(" holds.");
  });
});

// dollarMath decides whether a cite must be escaped (cite.ts), so it must
// agree with what the renderer actually turns into math.
describe("dollarMath", () => {
  const mathSpans = (source: string) =>
    render(source).match(/class="katex-math"/g)?.length ?? 0;

  it("lists inline and display dollar math in order", () => {
    const spans = dollarMath("$$x^2$$\n\nthen $y$ and $$z$$ end");
    expect(spans.map((s) => s.trim())).toEqual(["$$x^2$$", "$y$", "$$z$$"]);
  });

  it("finds math inside a table cell and a list item", () => {
    expect(dollarMath("| a | b |\n|---|---|\n| x | $c$ |")).toEqual(["$c$"]);
    expect(dollarMath("- one\n- has $d$")).toEqual(["$d$"]);
  });

  // Each row is text the renderer shows without math. Row 2 is Nil's cited
  // price row (2026-10-24).
  it.each([
    ["currency", "It costs $20.00, or $13 a month."],
    ["a price row", "antifeed.dev\t$9.99 / $13"],
    ["escaped dollars", String.raw`Set \$A,\$B now.`],
    ["an escaped dollar after an open one", String.raw`Use $B and \$H.`],
    ["a code span", "run `x=$a$` now"],
    ["a code block", "```\n$a$ and $$b$$\n```"],
  ])("finds no math in %s", (_label, source) => {
    expect(mathSpans(source)).toBe(0);
    expect(dollarMath(source)).toEqual([]);
  });

  it.each([
    "echo $HOME/$USER",
    "a $x$ b",
    "it costs $5 now\nand x=$Y?",
    "| $a$ | $$b$$ |\n|---|---|\n| c | d |",
  ])("counts as many spans as the renderer makes: %s", (source) => {
    expect(mathSpans(source)).toBeGreaterThan(0);
    expect(dollarMath(source)).toHaveLength(mathSpans(source));
  });
});
