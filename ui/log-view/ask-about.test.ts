// The excerpt of an ask's question that the "about this ask" prefix quotes
// (task 715ab3dd): one line, about 40 code points, cut at a word where the
// language has spaces, and never inside a surrogate pair.
import { expect, it } from "bun:test";
import { askExcerpt } from "./ask-about.ts";

const ELLIPSIS = "…";
const points = (s: string) => Array.from(s).length;

it("keeps a short question as it is, and collapses its whitespace to one line", () => {
  expect(askExcerpt("Ship it?")).toBe("Ship it?");
  expect(askExcerpt("  Merge\n\nthe   branch\tnow? \n")).toBe(
    "Merge the branch now?",
  );
  // Exactly 40 code points is not cut.
  const forty = "a".repeat(18) + " " + "b".repeat(21);
  expect(points(forty)).toBe(40);
  expect(askExcerpt(forty)).toBe(forty);
});

it("cuts a long question at the last word that fits, with an ellipsis", () => {
  // The 40th code point is inside "the": the cut backs off to "to".
  expect(
    askExcerpt(
      "Should we move the nightly backups to the desktop box tonight?",
    ),
  ).toBe(`Should we move the nightly backups to${ELLIPSIS}`);
  // The whitespace collapse comes before the count.
  expect(
    askExcerpt("Should   we\nmove the nightly backups to the desktop box?"),
  ).toBe(`Should we move the nightly backups to${ELLIPSIS}`);
});

it("cuts hard when the only space is early, and in a language without spaces", () => {
  const url = "Deploy https://example.com/a/very/long/path/that/goes/on?";
  expect(askExcerpt(url)).toBe(
    Array.from(url).slice(0, 40).join("") + ELLIPSIS,
  );
  const zh =
    "我们今晚要不要把夜间备份任务迁移到桌面电脑上，然后再检查一遍所有的日志文件和配置是否正确？";
  expect(points(zh)).toBeGreaterThan(40);
  expect(askExcerpt(zh)).toBe(Array.from(zh).slice(0, 40).join("") + ELLIPSIS);
});

it("counts code points, so a cut never splits a surrogate pair", () => {
  // 39 letters, then an emoji (two UTF-16 units) as the 40th code point.
  const q = "x".repeat(39) + "😀" + "tail";
  expect(askExcerpt(q)).toBe("x".repeat(39) + "😀" + ELLIPSIS);
  // An emoji past the cut does not shorten it either.
  const e = "😀".repeat(45);
  expect(askExcerpt(e)).toBe("😀".repeat(40) + ELLIPSIS);
});

// The excerpt quotes the prompt's text, not its markup (task 198af893): an
// ask's prompt is markdown with colour markup, and the chat draft is plain
// text. Each case is short enough that no cut applies.
for (const [prompt, text] of [
  [":red[**Decide**] Ship it?", "Decide Ship it?"],
  ["**bold** *em* _em_ `code`", "bold em em code"],
  // Every link gives its text: a relative one too, which the chat does not
  // draw as a link.
  ["See [the doc](docs/x.md) or [site](https://x.com)", "See the doc or site"],
  ["Look:\n\n![](before-after.png)\n\nOK?", "Look: OK?"],
  ["a ![shot](x.png) b", "a b"],
  ["- one\n- two\n\n1. three", "one two three"],
  ["- [ ] todo\n- [x] done", "todo done"],
  // In a loose list the box sits in the item's paragraph.
  ["- [ ] todo\n\n- [x] done", "todo done"],
  // A hard line break, with a backslash or two spaces, is a space.
  ["a\\\nb  \nc", "a b c"],
  ["# Title\n\n> quoted\n> - **item**", "Title quoted item"],
  ["~~old~~ new", "old new"],
  ["one <b>html</b> <img src=x> two", "one html two"],
  ["Press <kbd>Ctrl</kbd><!-- note --> now", "Press Ctrl now"],
  // A tag the ask card shows as text, such as a placeholder, stays.
  ["POST /api/agents/<id>/messages", "POST /api/agents/<id>/messages"],
  // The card draws an inline SVG; its elements are not text either.
  ["Look:\n<svg><rect/><text>hi</text></svg>\nOK?", "Look: hi OK?"],
  ["```ts\nconst x = 1;\n```", "const x = 1;"],
  ["| a | b |\n|---|---|\n| c | d |", "a b c d"],
  ["one\n\n---\n\ntwo", "one two"],
  ["[ref]: https://x.com\n\n<div>block</div>\n\nafter", "after"],
] as const) {
  it(`drops the markup of ${JSON.stringify(prompt)} and keeps its text`, () => {
    expect(askExcerpt(prompt)).toBe(text);
  });
}

it("cuts the prompt's text, not its markup", () => {
  // Raw, the 40 points end at "*ba"; as text, inside "code".
  expect(
    askExcerpt(
      ":red[**Decide**] Since yesterday the *bar* shows `code` and [the doc](docs/x.md).",
    ),
  ).toBe(`Decide Since yesterday the bar shows${ELLIPSIS}`);
});
