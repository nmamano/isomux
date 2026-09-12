import { describe, expect, it } from "bun:test";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { renderMarkdown } from "./Markdown.tsx";

const EN = translatorFor("en");

describe("renderMarkdown math", () => {
  it("renders dollar-delimited display math", () => {
    const html = renderMarkdown(EN, "$$x^2$$");
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain('data-katex-display="true"');
  });

  it("renders bracket-delimited display math", () => {
    const html = renderMarkdown(EN, String.raw`\[x^2\]`);
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain('data-katex-display="true"');
  });

  it("renders dollar-delimited inline math", () => {
    const html = renderMarkdown(EN, "Value: $x^2$.");
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain('data-katex-display="false"');
  });

  it("renders parenthesis-delimited inline math", () => {
    const html = renderMarkdown(EN, String.raw`Value: \(x^2\).`);
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain('data-katex-display="false"');
  });

  it("keeps dollar amounts and unmatched dollars literal", () => {
    const html = renderMarkdown(EN, "It costs $20.00 and this $ stays.");
    expect(html).not.toContain('class="katex-math"');
    expect(html).toContain("$20.00");
    expect(html).toContain("this $ stays");
  });

  it("rejects a closing dollar followed by a digit", () => {
    const html = renderMarkdown(EN, "Keep $x$2 literal.");
    expect(html).not.toContain('class="katex-math"');
    expect(html).toContain("$x$2");
  });

  it("rejects an opening dollar followed by whitespace", () => {
    const html = renderMarkdown(EN, "Pay $ 5$ now.");
    expect(html).not.toContain('class="katex-math"');
    expect(html).toContain("Pay $ 5$ now.");
  });

  it("does not render math delimiters inside code", () => {
    const html = renderMarkdown(
      EN,
      "`$x$`\n\n```text\n$$x^2$$\n```",
    );
    expect(html).not.toContain('class="katex-math"');
    expect(html).toContain("$x$");
    expect(html).toContain("$$x^2$$");
  });

  it("does not split prose around unmatched display delimiters", () => {
    const cases = [
      ["Use $$ to open display math.", "Use $$ to open display math."],
      ["Run echo $$ to print the pid.", "Run echo $$ to print the pid."],
      [String.raw`An index like a\[0\] is fine.`, "An index like a[0] is fine."],
      [String.raw`Write \[ to open display math.`, "Write [ to open display math."],
    ];
    for (const [source, rendered] of cases) {
      const html = renderMarkdown(EN, source);
      expect(html).not.toContain("<br>");
      expect(html).toContain(rendered);
    }
  });

  it("does not split bracket display delimiters in prose", () => {
    const html = renderMarkdown(EN, String.raw`So \[x^2\] holds.`);
    expect(html).not.toContain("<br>");
    expect(html).toContain("So [x^2] holds.");
  });

  it("keeps paired literal double dollars in prose", () => {
    for (const source of [
      "compare echo $$ in the parent with echo $$ in the child",
      "In a Makefile write $$HOME, not $HOME, to reach $$PATH.",
    ]) {
      const html = renderMarkdown(EN, source);
      expect(html).not.toContain('class="katex-math"');
      expect(html).toContain(source);
    }
  });

  it("keeps an adjacent display delimiter in one paragraph", () => {
    const html = renderMarkdown(EN, "a$$x$$");
    expect(html).toContain("<p>a");
    expect(html).toContain('data-katex-source="x"');
    expect(html).toContain("</span></p>");
  });

  it("renders paired dollar display delimiters in prose without splitting it", () => {
    const html = renderMarkdown(EN, "So $$x^2$$ holds.");
    expect(html).not.toContain("<br>");
    expect(html).toContain('data-katex-source="x^2"');
    expect(html).toContain(" holds.");
  });

  it("keeps display delimiters byte-for-byte inside a code span", () => {
    expect(renderMarkdown(EN, "`$$y$$`")).toContain("<code>$$y$$</code>");
  });
});
