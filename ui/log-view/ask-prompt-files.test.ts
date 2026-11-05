// Read files placed in an ask prompt (task 1097dbf0): a line made only of
// markdown image references shows the read files it names there, and the
// files no such line names stay under the prompt. A reference anywhere else
// is the literal text it was.
import { describe, expect, it } from "bun:test";
import {
  matchAskFile,
  splitAskPrompt,
  unplacedAskFiles,
} from "./ask-prompt-diff.ts";

const file = (originalName: string, filename: string) => ({
  originalName,
  filename,
});
const ids = (files: { filename: string }[]) => files.map((f) => f.filename);

describe("splitAskPrompt reference lines", () => {
  it("places a reference line between its paragraphs, with the line breaks around it", () => {
    expect(splitAskPrompt("Before:\n![](1-alice.png)\nAfter.")).toStrictEqual([
      { kind: "text", text: "Before:" },
      { kind: "files", names: ["1-alice.png"] },
      { kind: "text", text: "After." },
    ]);
  });

  it("makes one row of consecutive reference lines and of several references on a line", () => {
    expect(
      splitAskPrompt("See:\n![](a.png)\n![b](b.png)  ![](c.png)\nEnd"),
    ).toStrictEqual([
      { kind: "text", text: "See:" },
      { kind: "files", names: ["a.png", "b.png", "c.png"] },
      { kind: "text", text: "End" },
    ]);
  });

  it("makes two rows of reference lines with a blank line between them", () => {
    expect(splitAskPrompt("![](a.png)\n\n![](b.png)")).toStrictEqual([
      { kind: "files", names: ["a.png"] },
      { kind: "files", names: ["b.png"] },
    ]);
  });

  it("names a file by the last part of a path, in the bare and the angle form", () => {
    expect(
      splitAskPrompt(
        "![](/tmp/t-x/2-carol.png)\n![some alt](<dir one/my file.png>)",
      ),
    ).toStrictEqual([{ kind: "files", names: ["2-carol.png", "my file.png"] }]);
  });

  it("reads a reference line with blanks around it and CRLF line breaks", () => {
    expect(splitAskPrompt("A\r\n  ![](a.png) \t\r\nB")).toStrictEqual([
      { kind: "text", text: "A" },
      { kind: "files", names: ["a.png"] },
      { kind: "text", text: "B" },
    ]);
  });

  it.each([
    ["a reference in a sentence", "See ![](a.png) here."],
    ["text after a reference", "![](a.png) and more"],
    ["a reference with a title", '![](a.png "Alice")'],
    ["a link, not an image", "[](a.png)"],
    ["a bare target with a space", "![](my file.png)"],
    ["an empty target", "![]()"],
    ["an empty angle target", "![](<>)"],
    ["a target with no file name", "![](dir/)"],
  ])("keeps %s as literal text", (_name, line) => {
    const prompt = `Intro\n${line}\nEnd`;
    expect(splitAskPrompt(prompt)).toStrictEqual([
      { kind: "text", text: prompt },
    ]);
  });

  it("keeps a reference line in a diff block as a line of the diff", () => {
    const segments = splitAskPrompt("```diff\n![](a.png)\n+ x\n```");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "diff",
      lines: [
        { kind: "context", text: "![](a.png)" },
        { kind: "added", text: "x" },
      ],
    });
  });

  it("gives no empty text segment for a reference line at the start or the end", () => {
    expect(splitAskPrompt("![](a.png)\nText")).toStrictEqual([
      { kind: "files", names: ["a.png"] },
      { kind: "text", text: "Text" },
    ]);
    expect(splitAskPrompt("Text\n![](a.png)\n")).toStrictEqual([
      { kind: "text", text: "Text" },
      { kind: "files", names: ["a.png"] },
    ]);
  });
});

describe("matchAskFile", () => {
  const files = [file("a.png", "a1"), file("b.png", "b1"), file("a.png", "a2")];

  it("gives the first file of the name", () => {
    expect(matchAskFile("a.png", files)?.filename).toBe("a1");
    expect(matchAskFile("b.png", files)?.filename).toBe("b1");
  });

  it("gives nothing for a name no file has", () => {
    expect(matchAskFile("c.png", files)).toBeUndefined();
  });

  // Task 7546bc99: the copy of a reused name gets a suffix, and an agent may
  // name the copy.
  it("gives the file whose copy has the name when no file has it", () => {
    const copies = [file("a.png", "a.png"), file("a.png", "a_2.png")];
    expect(matchAskFile("a_2.png", copies)?.filename).toBe("a_2.png");
  });

  it("gives the file of the name before a file whose copy has the name", () => {
    const copies = [file("a.png", "a_2.png"), file("a_2.png", "a_2_1.png")];
    expect(matchAskFile("a_2.png", copies)?.filename).toBe("a_2_1.png");
  });
});

describe("unplacedAskFiles", () => {
  it("keeps every file, in order, when no line places one", () => {
    const files = [file("b.png", "b1"), file("a.png", "a1")];
    expect(ids(unplacedAskFiles("Plain text.", files))).toStrictEqual([
      "b1",
      "a1",
    ]);
  });

  it("leaves out each placed file and keeps the rest in their order", () => {
    const files = [
      file("a.png", "a1"),
      file("b.png", "b1"),
      file("a.png", "a2"),
      file("c.png", "c1"),
      file("d.png", "d1"),
    ];
    const prompt = [
      "One:",
      "![](a.png)",
      "Two, with ![](c.png) in a sentence:",
      "![](b.png)",
      "Three, b again:",
      "![](/elsewhere/b.png)",
      "```diff",
      "![](d.png)",
      "```",
    ].join("\n");
    // a2 shares a1's name; c and d are named only outside a reference line.
    expect(ids(unplacedAskFiles(prompt, files))).toStrictEqual([
      "a2",
      "c1",
      "d1",
    ]);
  });

  it("places a file named by its copy's name", () => {
    const files = [file("shot.png", "shot_3.png"), file("c.png", "c1")];
    expect(
      ids(unplacedAskFiles("See:\n![](shot_3.png)\nEnd", files)),
    ).toStrictEqual(["c1"]);
  });
});
