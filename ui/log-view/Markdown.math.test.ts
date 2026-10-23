import { describe, expect, it } from "bun:test";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { renderMarkdown } from "./Markdown.tsx";

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
