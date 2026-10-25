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
