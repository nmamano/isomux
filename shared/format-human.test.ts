// T0 unit tier for the markdown-safe renderers in format-human.ts.
//
// markdownInlineCode exists because Isomux writes chat lines that quote values
// it does not control - a working directory codex reported, for one. Backslash
// escapes do nothing inside a code span, so the only defence is the fence
// length, and getting that wrong lets a crafted value close the span early and
// write the rest of the sentence itself.
import { describe, expect, it } from "bun:test";

import { markdownInlineCode } from "./format-human.ts";

describe("markdownInlineCode", () => {
  it("wraps ordinary text in a single-backtick span", () => {
    expect(markdownInlineCode("/home/nil/work")).toBe("`/home/nil/work`");
    expect(markdownInlineCode("rg --files")).toBe("`rg --files`");
  });

  it("outgrows any run of backticks in the content", () => {
    // The whole point: the fence must be longer than anything inside it, or
    // the value ends the span and everything after it renders as prose.
    expect(markdownInlineCode("/tmp/a`b")).toBe("``/tmp/a`b``");
    expect(markdownInlineCode("/tmp/a``b")).toBe("```/tmp/a``b```");
    expect(markdownInlineCode("a`b``c")).toBe("```a`b``c```");
  });

  it("pads when the content starts or ends with a backtick", () => {
    // Without the padding the fence and the content run together and the
    // span opens with a longer fence than intended.
    expect(markdownInlineCode("`evil")).toBe("`` `evil ``");
    expect(markdownInlineCode("evil`")).toBe("`` evil` ``");
  });

  it("collapses control characters, which no fence can survive", () => {
    // A newline ends an inline span outright, so a path containing one could
    // otherwise push forged text onto its own line.
    expect(markdownInlineCode("/tmp/a\nb")).toBe("`/tmp/a b`");
    expect(markdownInlineCode("/tmp/a\r\nb")).toBe("`/tmp/a  b`");
    expect(markdownInlineCode("/tmp/a\tb")).toBe("`/tmp/a b`");
  });

  it("survives a value built to forge the rest of the sentence", () => {
    const attack = "/tmp/x` for the rest of this session. Allowing `sudo";
    const rendered = markdownInlineCode(attack);
    // The forged text stays inside the span: the rendered string is one
    // fenced run, and the fence is longer than any backtick run within.
    expect(rendered.startsWith("``")).toBe(true);
    expect(rendered.endsWith("``")).toBe(true);
    expect(rendered).toContain(attack);
    expect(rendered.includes("```")).toBe(false);
  });
});
