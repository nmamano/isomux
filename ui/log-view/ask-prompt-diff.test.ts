// A ```diff block in an ask prompt (task 8c661856): the split into text and
// diff segments, the -/+ markers, and the word marks on a removed line paired
// with an added line. Anything that is not a well-formed block stays the
// literal text it was.
import { describe, expect, it } from "bun:test";
import {
  splitPromptDiffs,
  WORD_DIFF_MAX_CHARS,
  type DiffLine,
  type DiffWord,
  type PromptSegment,
} from "./ask-prompt-diff.ts";
import { ASK_PROMPT_MAX } from "../../server/asks.ts";

// Adjacent words with the same mark joined, so the test does not depend on
// how the word diff cuts a run into tokens.
function merged(words: DiffWord[]): DiffWord[] {
  const out: DiffWord[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && last.changed === w.changed) last.text += w.text;
    else if (w.text !== "") out.push({ ...w });
  }
  return out;
}

// The lines without their word marks.
const bare = (lines: DiffLine[]) =>
  lines.map(({ kind, text }) => ({ kind, text }));

function diffLines(segments: PromptSegment[]): DiffLine[] {
  const diffs = segments.filter((s) => s.kind === "diff");
  expect(diffs).toHaveLength(1);
  return diffs[0].lines;
}

describe("splitPromptDiffs", () => {
  it("keeps a prompt with no block as one text segment, byte for byte", () => {
    const prompt = "Ship `t-1`?\n\n- one\n+ two\n";
    expect(splitPromptDiffs(prompt)).toStrictEqual([
      { kind: "text", text: prompt },
    ]);
  });

  it("splits a block out of the text, and the newlines next to the fences belong to the block", () => {
    const segments = splitPromptDiffs(
      "Copy change in **Asks**:\n```diff\nAsk card > link:\n- Show original\n+ Show the first version\n```\nApprove?",
    );
    expect(segments.map((s) => s.kind)).toEqual(["text", "diff", "text"]);
    expect(segments[0]).toStrictEqual({
      kind: "text",
      text: "Copy change in **Asks**:",
    });
    expect(segments[2]).toStrictEqual({ kind: "text", text: "Approve?" });
    expect(bare(diffLines(segments))).toStrictEqual([
      { kind: "context", text: "Ask card > link:" },
      { kind: "removed", text: "Show original" },
      { kind: "added", text: "Show the first version" },
    ]);
  });

  it("draws a block at the very start or end with no empty text segment", () => {
    const segments = splitPromptDiffs("```diff\n- a\n+ b\n```");
    expect(segments.map((s) => s.kind)).toEqual(["diff"]);
  });

  it("keeps two blocks and the text between them in order", () => {
    const segments = splitPromptDiffs(
      "One:\n```diff\n- a\n```\nTwo:\n```diff\n+ b\n```\nEnd.",
    );
    expect(
      segments.map((s) =>
        s.kind === "text" ? s.text : bare(s.lines).map((l) => l.kind),
      ),
    ).toStrictEqual(["One:", ["removed"], "Two:", ["added"], "End."]);
  });

  it("drops one space after a marker, keeps the rest, and keeps a context line verbatim", () => {
    const lines = diffLines(
      splitPromptDiffs(
        [
          "```diff",
          "-tight",
          "-  two spaces",
          "-",
          "+",
          "+ `code` and **stars**",
          " indented heading",
          "",
          "@@ where @@",
          "```",
        ].join("\n"),
      ),
    );
    expect(bare(lines)).toStrictEqual([
      { kind: "removed", text: "tight" },
      { kind: "removed", text: " two spaces" },
      { kind: "removed", text: "" },
      { kind: "added", text: "" },
      // Literal: no markdown inside the block.
      { kind: "added", text: "`code` and **stars**" },
      { kind: "context", text: " indented heading" },
      { kind: "context", text: "" },
      { kind: "context", text: "@@ where @@" },
    ]);
  });

  it("reads CRLF lines and fences with trailing blanks", () => {
    const segments = splitPromptDiffs(
      "Before\r\n```diff \t\r\n- old\r\n+ new\r\n```\t\r\nAfter",
    );
    expect(segments.map((s) => s.kind)).toEqual(["text", "diff", "text"]);
    expect(segments[0]).toStrictEqual({ kind: "text", text: "Before" });
    expect(segments[2]).toStrictEqual({ kind: "text", text: "After" });
    expect(bare(diffLines(segments))).toStrictEqual([
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
    ]);
  });

  it.each([
    ["an unclosed block", "Look:\n```diff\n- a\n+ b\nno close"],
    ["another language", "Look:\n```ts\n- a\n+ b\n```\n"],
    ["no language", "Look:\n```\n- a\n+ b\n```\n"],
    ["an indented fence", "Look:\n  ```diff\n- a\n+ b\n  ```\n"],
    ["an indented close fence", "Look:\n```diff\n- a\n+ b\n  ```\n"],
    ["a word after diff", "Look:\n```diffs\n- a\n+ b\n```\n"],
    ["a fence inside a line", "Look: ```diff\n- a\n+ b\n```\n"],
    ["an empty block", "Look:\n```diff\n```\nEnd."],
  ])("keeps %s as literal text", (_name, prompt) => {
    expect(splitPromptDiffs(prompt)).toStrictEqual([
      { kind: "text", text: prompt },
    ]);
  });

  it("closes a block at its first close fence and reads two blocks back to back", () => {
    const segments = splitPromptDiffs("```diff\n- a\n```\n```diff\n+ b\n```");
    expect(
      segments.map((s) => (s.kind === "text" ? s.text : bare(s.lines))),
    ).toStrictEqual([
      [{ kind: "removed", text: "a" }],
      [{ kind: "added", text: "b" }],
    ]);
  });
});

describe("word marks", () => {
  it("marks the changed words of a removed line and the added line after it", () => {
    const [removed, added] = diffLines(
      splitPromptDiffs(
        "```diff\n- Keep the old copy here\n+ Keep the new copy here\n```",
      ),
    );
    expect(merged(removed.words!)).toStrictEqual([
      { text: "Keep the ", changed: false },
      { text: "old", changed: true },
      { text: " copy here", changed: false },
    ]);
    expect(merged(added.words!)).toStrictEqual([
      { text: "Keep the ", changed: false },
      { text: "new", changed: true },
      { text: " copy here", changed: false },
    ]);
  });

  it("marks a changed phrase as one run: the blank between two changed words is marked, a blank at its edge is not", () => {
    const [removed, added] = diffLines(
      splitPromptDiffs(
        "```diff\n- A simpler version is on its way.\n+ The agent is rewriting this ask in plain words.\n```",
      ),
    );
    const changed = (l: DiffLine) =>
      merged(l.words!)
        .filter((w) => w.changed)
        .map((w) => w.text);
    expect(changed(removed)).toStrictEqual(["A simpler version", "on its way"]);
    expect(changed(added)).toStrictEqual([
      "The agent",
      "rewriting this ask in plain words",
    ]);
  });

  it("pairs line i of a removed run with line i of the added run after it", () => {
    const lines = diffLines(
      splitPromptDiffs(
        "```diff\nWhere:\n- Save now\n- Close tab\n+ Save later\n+ Close panel\n```",
      ),
    );
    expect(lines[0].words).toBeUndefined();
    const changed = lines.slice(1).map((l) =>
      merged(l.words!)
        .filter((w) => w.changed)
        .map((w) => w.text),
    );
    expect(changed).toStrictEqual([["now"], ["tab"], ["later"], ["panel"]]);
    // Each line's words spell the line.
    for (const l of lines.slice(1))
      expect(l.words!.map((w) => w.text).join("")).toBe(l.text);
  });

  it.each([
    ["runs of unequal length", "- a b\n- c d\n+ a x"],
    ["a context line between the runs", "- a b\nWhere:\n+ a x"],
    ["an added run before the removed run", "+ a x\n- a b"],
    ["a removed line alone", "- a b"],
    ["an added line alone", "+ a x"],
  ])("gives no word marks to %s", (_name, body) => {
    const lines = diffLines(splitPromptDiffs("```diff\n" + body + "\n```"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.words).toBeUndefined();
  });

  it("gives no word marks to a pair longer than the limit, in a prompt the ask cap allows", () => {
    // Each side is a run of distinct words, so the pair costs the word diff
    // its worst case.
    const words = (prefix: string, chars: number) =>
      Array.from({ length: chars }, (_, i) => prefix + i)
        .join(" ")
        .slice(0, chars);
    const pair = (chars: number) =>
      "Copy:\n```diff\n- " +
      words("a", chars) +
      "\n+ " +
      words("b", chars) +
      "\n```";
    const under = Math.floor(WORD_DIFF_MAX_CHARS / 2) - 20;
    const over = Math.ceil(WORD_DIFF_MAX_CHARS / 2) + 20;
    // The limit must be reachable from a real ask, under the prompt cap.
    expect(pair(over).length).toBeLessThanOrEqual(ASK_PROMPT_MAX);
    const [r1, a1] = diffLines(splitPromptDiffs(pair(under)));
    expect(r1.words).toBeDefined();
    expect(a1.words).toBeDefined();
    const [r2, a2] = diffLines(splitPromptDiffs(pair(over)));
    expect(bare([r2, a2]).map((l) => l.kind)).toEqual(["removed", "added"]);
    expect(r2.words).toBeUndefined();
    expect(a2.words).toBeUndefined();
  });
});
