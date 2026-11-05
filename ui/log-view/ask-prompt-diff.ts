import { diffWordsWithSpace } from "diff";

// An ask prompt can hold ```diff blocks, for copy changes: a line that starts
// with "-" is removed, "+" is added, any other line is a heading. Text
// outside the blocks stays inline markdown.
//
// A reference line places the ask's read files in the text (task 1097dbf0).
// It holds only markdown image references, `![alt](target)` with a bare
// target (no blanks; parentheses balanced, one level) or `![alt](<target>)`,
// with blanks before, between and after them. A reference names the read
// file whose originalName is the part of the target after the last "/", with
// no percent-decoding (the <...> form takes blanks). A title
// (`![](a.png "t")`), any other text on the line, an empty name, or a line in
// a ```diff block keeps the line as text. Consecutive reference lines make one
// files segment; a blank line between them makes two.

export type DiffWord = { text: string; changed: boolean };

export type DiffLine = {
  kind: "context" | "removed" | "added";
  text: string;
  // The changed words, for a removed line paired with an added line.
  words?: DiffWord[];
};

export type PromptSegment =
  | { kind: "text"; text: string }
  | { kind: "diff"; lines: DiffLine[] }
  // A run of reference lines: the file names, in order.
  | { kind: "files"; names: string[] };

// Above this many characters in a pair, the lines show without word marks:
// the word diff is quadratic, and two different 500-character lines already
// take about 20 ms.
export const WORD_DIFF_MAX_CHARS = 1000;

const OPEN = /^```diff[ \t]*$/;
const CLOSE = /^```[ \t]*$/;

export function splitAskPrompt(prompt: string): PromptSegment[] {
  // Each line keeps its line break, so text outside a block is the source
  // bytes.
  const lines = prompt.split(/(?<=\n)/);
  const bare = (line: string) => line.replace(/\r?\n$/, "");
  const segments: PromptSegment[] = [];
  let text = "";
  const flushText = () => {
    // The line break before an open fence belongs to the block.
    const t = text.replace(/\r?\n$/, "");
    if (t !== "") segments.push({ kind: "text", text: t });
    text = "";
  };
  let i = 0;
  while (i < lines.length) {
    if (OPEN.test(bare(lines[i]))) {
      let close = i + 1;
      while (close < lines.length && !CLOSE.test(bare(lines[close]))) close++;
      // An unclosed or empty block stays literal.
      if (close < lines.length && close > i + 1) {
        flushText();
        segments.push({
          kind: "diff",
          lines: diffLines(lines.slice(i + 1, close).map(bare)),
        });
        i = close + 1;
        continue;
      }
    }
    const names = referenceNames(bare(lines[i]));
    if (names) {
      // The line break before a reference line belongs to it. With no text
      // since the last segment, a files segment last is the line before.
      const last = segments[segments.length - 1];
      if (text === "" && last?.kind === "files") last.names.push(...names);
      else {
        flushText();
        segments.push({ kind: "files", names });
      }
      i++;
      continue;
    }
    text += lines[i];
    i++;
  }
  if (text !== "") segments.push({ kind: "text", text });
  return segments;
}

// A bare target can hold balanced parentheses, one level deep.
const REFERENCE =
  /!\[[^\]]*\]\((?:<([^<>\n]+)>|([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)*))\)/y;

// The file names of a reference line, or null for any other line.
function referenceNames(line: string): string[] | null {
  const source = line.trim();
  const names: string[] = [];
  let at = 0;
  while (at < source.length) {
    REFERENCE.lastIndex = at;
    const match = REFERENCE.exec(source);
    if (!match) return null;
    const target = match[1] ?? match[2];
    const name = target.slice(target.lastIndexOf("/") + 1);
    if (name === "") return null;
    names.push(name);
    at = REFERENCE.lastIndex;
    at += /^[ \t]*/.exec(source.slice(at))![0].length;
  }
  return names.length > 0 ? names : null;
}

// The first read file the name references: by the name the agent gave it, or
// else by its copy's name, which gets a suffix when the agent's files already
// hold that name.
export function matchAskFile<
  T extends { originalName: string; filename: string },
>(name: string, files: readonly T[]): T | undefined {
  return (
    files.find((file) => file.originalName === name) ??
    files.find((file) => file.filename === name)
  );
}

// The read files no reference line of the prompt places, in their order: the
// card shows them under the prompt.
export function unplacedAskFiles<
  T extends { originalName: string; filename: string },
>(prompt: string, files: readonly T[]): T[] {
  const placed = new Set<T>();
  for (const segment of splitAskPrompt(prompt))
    if (segment.kind === "files")
      for (const name of segment.names) {
        const file = matchAskFile(name, files);
        if (file) placed.add(file);
      }
  return files.filter((file) => !placed.has(file));
}

function diffLines(source: string[]): DiffLine[] {
  const lines: DiffLine[] = source.map((line) =>
    line.startsWith("-")
      ? { kind: "removed", text: line.slice(line.startsWith("- ") ? 2 : 1) }
      : line.startsWith("+")
        ? { kind: "added", text: line.slice(line.startsWith("+ ") ? 2 : 1) }
        : { kind: "context", text: line },
  );
  // A run of removed lines right before an added run of the same length pairs
  // line by line.
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "removed") {
      i++;
      continue;
    }
    let mid = i;
    while (mid < lines.length && lines[mid].kind === "removed") mid++;
    let end = mid;
    while (end < lines.length && lines[end].kind === "added") end++;
    if (end - mid === mid - i)
      for (let k = 0; k < mid - i; k++) markWords(lines[i + k], lines[mid + k]);
    i = end;
  }
  return lines;
}

function markWords(removed: DiffLine, added: DiffLine) {
  if (removed.text.length + added.text.length > WORD_DIFF_MAX_CHARS) return;
  const changes = diffWordsWithSpace(removed.text, added.text);
  removed.words = words(
    changes
      .filter((c) => !c.added)
      .map((c) => ({ text: c.value, changed: c.removed })),
  );
  added.words = words(
    changes
      .filter((c) => !c.removed)
      .map((c) => ({ text: c.value, changed: c.added })),
  );
}

// Blanks at the edges of a changed run are not marked, a blank between two
// changed runs is, and neighbours with the same mark join.
function words(parts: DiffWord[]): DiffWord[] {
  const trimmed = trimBlanks(parts);
  const out: DiffWord[] = [];
  trimmed.forEach((w, i) => {
    const gap =
      !w.changed &&
      /^\s+$/.test(w.text) &&
      trimmed[i - 1]?.changed &&
      trimmed[i + 1]?.changed;
    const last = out[out.length - 1];
    const changed = w.changed || !!gap;
    if (last && last.changed === changed) last.text += w.text;
    else out.push({ text: w.text, changed });
  });
  return out;
}

function trimBlanks(parts: DiffWord[]): DiffWord[] {
  const out: DiffWord[] = [];
  const push = (text: string, changed: boolean) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  };
  for (const { text, changed } of parts) {
    if (!changed) {
      push(text, false);
      continue;
    }
    const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(text)!;
    push(lead, false);
    push(core, true);
    push(trail, false);
  }
  return out;
}
