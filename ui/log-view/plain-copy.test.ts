// The copy buttons copy an agent reply's markdown source. Agents write \$ for a
// literal dollar (server/system-prompt.ts), and the chat shows it as "$", so the
// copy must too - but only where the chat shows "$": inside code the chat shows
// "\$", and the copy keeps it. Every expected value below was checked against
// marked's rendering on 2026-10-19.

import { describe, expect, it } from "bun:test";
import { unescapeDollars } from "./plain-copy.ts";

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
