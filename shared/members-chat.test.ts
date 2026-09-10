import { expect, it } from "bun:test";
import { membersChatExcerpt, membersChatPreview } from "./members-chat.ts";

it("uses one plain-text, code-point-limited excerpt rule for text and files", () => {
  expect(membersChatExcerpt("**raw**\ntext", [])).toBe("**raw**\ntext");
  expect(membersChatExcerpt("😀".repeat(201), [])).toBe("😀".repeat(200));
  expect(
    membersChatExcerpt(" \n", [
      { originalName: "one.pdf" },
      { originalName: "two.png" },
    ]),
  ).toBe("one.pdf, two.png");
  expect(membersChatExcerpt("text", [{ originalName: "ignored" }])).toBe(
    "text",
  );
});

for (const [source, expected] of [
  ["**Thanks!**", "Thanks!"],
  [
    "**bold _and italic_** [label](https://example.com)",
    "bold and italic label",
  ],
  ["https://example.com", "https://example.com"],
  ["[label](javascript:alert(1))", "label"],
  ["# heading `code` <b>literal</b>", "# heading `code` <b>literal</b>"],
  ["one\n\ntwo", "one\n\ntwo"],
]) {
  it(`shows preview text for ${JSON.stringify(source)} without changing its raw snapshot`, () => {
    const snapshot = membersChatExcerpt(source, []);
    expect(membersChatPreview(snapshot)).toBe(expected);
    expect(snapshot).toBe(source);
  });
}
