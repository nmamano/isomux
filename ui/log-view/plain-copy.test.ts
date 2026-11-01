// The copy buttons copy an agent reply's markdown source. Agents write \$ for a
// literal dollar (server/system-prompt.ts), and the chat shows it as "$", so the
// copy must too - but only where the chat shows "$": inside code the chat shows
// "\$", and the copy keeps it. Every expected value below was checked against
// marked's rendering on 2026-10-19.

import { describe, expect, it } from "bun:test";
import { markdownToPlainText, unescapeDollars } from "./plain-copy.ts";

const raw = String.raw;

describe("unescapeDollars", () => {
  it.each([
    ["prose", raw`It costs \$5 and \$6`, "It costs $5 and $6"],
    [
      "code span",
      raw`run ` + "`echo \\$HOME`" + raw` now \$5`,
      "run `echo \\$HOME` now $5",
    ],
    [
      "double-backtick span holding a backtick",
      "``a ` \\$ b`` \\$7",
      "``a ` \\$ b`` $7",
    ],
    ["unmatched backtick is plain text", "a ` b \\$5", "a ` b $5"],
    ["backtick runs of different length do not pair", "``a \\$` b", "``a $` b"],
    ["a longer run does not close a shorter one", "`a \\$`` b", "`a $`` b"],
    ["a backslash does not escape inside a code span", "`\\` \\$5", "`\\` $5"],
    [
      "backtick fence",
      "```\necho \\$HOME\n```\n\\$5",
      "```\necho \\$HOME\n```\n$5",
    ],
    ["tilde fence", "~~~sh\n\\$x\n~~~\n\\$y", "~~~sh\n\\$x\n~~~\n$y"],
    [
      "a shorter fence does not close a longer one",
      "````\n```\n\\$x\n````\n\\$y",
      "````\n```\n\\$x\n````\n$y",
    ],
    [
      "a fence of the other char does not close",
      "```\n\\$x\n~~~\n\\$y",
      "```\n\\$x\n~~~\n\\$y",
    ],
    ["an unclosed fence runs to the end (streaming)", "```\n\\$x", "```\n\\$x"],
    [
      "a closing fence takes no info string",
      "```\n\\$x\n``` not\n\\$y",
      "```\n\\$x\n``` not\n\\$y",
    ],
    [
      "a backtick in a backtick fence's info string makes it text",
      "```a` \\$5",
      "```a` $5",
    ],
    [
      "a backtick in a tilde fence's info string is allowed",
      "~~~ a`b\n\\$x\n~~~\n\\$y",
      "~~~ a`b\n\\$x\n~~~\n$y",
    ],
    [
      "a code span does not cross a blank line",
      "a `x\n\n\\$5 b`",
      "a `x\n\n$5 b`",
    ],
    [
      "indented fence",
      "   ```\n\\$x\n   ```\n\\$y",
      "   ```\n\\$x\n   ```\n$y",
    ],
    ["indented unclosed fence", "   ```\n\\$x", "   ```\n\\$x"],
    [
      "fence inside a list item",
      "- item\n\n  ```\n  \\$x\n  ```\n\\$y",
      "- item\n\n  ```\n  \\$x\n  ```\n$y",
    ],
    ["escaped backslash then a bare dollar", "\\\\$5", "\\\\$5"],
    ["escaped backslash then an escaped dollar", "\\\\\\$5", "\\\\$5"],
    ["other escapes stay", "\\*a\\* \\_b\\_ \\$", "\\*a\\* \\_b\\_ $"],
  ])("%s", (_name, input, expected) => {
    expect(unescapeDollars(input)).toBe(expected);
  });
});

// The chat bar's Copy in Plain text (task 28bd5993): an agent reply loses its
// Markdown and keeps every word the chat shows, code included.
describe("markdownToPlainText", () => {
  it.each([
    ["text with no Markdown", "Just words.", "Just words."],
    ["paragraphs", "One.\n\nTwo.", "One.\n\nTwo."],
    // The chat renders with breaks on, so a single newline is a line break.
    ["a line break", "line one\nline two", "line one\nline two"],
    [
      "emphasis, strong and strikethrough",
      "a *b* _c_ **d** __e__ ~~f~~ ***g***",
      "a b c d e f g",
    ],
    ["inline code", "run `ls *.ts` now", "run ls *.ts now"],
    [
      "a fenced code block keeps its text as written",
      "Run:\n\n```sh\necho **x** `y` \\$HOME\n  indented\n```",
      "Run:\n\necho **x** `y` \\$HOME\n  indented",
    ],
    ["a heading", "# Title\n\n## Sub *x*\n\nBody", "Title\n\nSub x\n\nBody"],
    ["a blockquote", "> quoted *x*\n> more", "quoted x\nmore"],
    [
      "a link",
      "see [the *docs*](https://x.y/a)",
      "see the docs (https://x.y/a)",
    ],
    [
      "a link whose text is its url",
      "[https://x.y](https://x.y)",
      "https://x.y",
    ],
    ["an autolink", "<https://x.y/a>", "https://x.y/a"],
    ["a bare url", "go to https://x.y/a now", "go to https://x.y/a now"],
    [
      "an image",
      "![a chart](https://x.y/c.png)",
      "a chart (https://x.y/c.png)",
    ],
    ["a horizontal rule is dropped", "a\n\n---\n\nb", "a\n\nb"],
    ["a bullet list keeps its markers", "- a\n- *b*", "- a\n- b"],
    ["an ordered list keeps its numbers", "3. a\n4. **b**", "3. a\n4. b"],
    [
      "task items keep their boxes",
      "- [ ] todo\n- [x] done",
      "- [ ] todo\n- [x] done",
    ],
    [
      "a table is rows of cells",
      "| a | *b* |\n|---|---|\n| 1 | `2` |",
      "a | b\n1 | 2",
    ],
    ["escapes are resolved", raw`\*not em\* costs \$5`, "*not em* costs $5"],
    [
      "a code span keeps its escaped dollar",
      "`echo \\$HOME`",
      raw`echo \$HOME`,
    ],
    // The XML entities and numeric ones; a named HTML entity beyond them
    // (&copy;) is rare in a reply and needs a table the bundle does not have.
    [
      "entities are decoded",
      "a &amp; b &lt;c&gt; &quot;q&quot; &#169; &#x2014;",
      'a & b <c> "q" © —',
    ],
    ["a bare ampersand stays", "salt & pepper", "salt & pepper"],
    [
      "inline HTML stays as written",
      "press <kbd>Ctrl</kbd> now",
      "press <kbd>Ctrl</kbd> now",
    ],
    [
      "block HTML stays as written",
      "<details>\n<summary>More</summary>\n</details>",
      "<details>\n<summary>More</summary>\n</details>",
    ],
    ["math stays as written", "area $x^2$ here", "area $x^2$ here"],
  ])("%s", (_name, input, expected) => {
    expect(markdownToPlainText(input)).toBe(expected);
  });

  it("indents a nested list item under its parent", () => {
    const lines = markdownToPlainText("- a\n  - *b*\n- c").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("- a");
    expect(lines[1]).toMatch(/^\s+- b$/);
    expect(lines[2]).toBe("- c");
  });
});
