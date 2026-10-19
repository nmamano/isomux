// Copying from the chat: a selection goes on the clipboard as plain text
// only, and a copied agent reply loses the backslash agents write before a
// literal dollar.

type CopyEventLike = {
  target: EventTarget | null;
  clipboardData: DataTransfer | null;
  defaultPrevented: boolean;
  preventDefault(): void;
};

// Without this handler the browser also puts the rendered HTML on the
// clipboard, and a rich editor (Gmail) pastes it formatted. An editable
// field, or an inner handler that already took the copy, keeps its own copy;
// a selection with no text leaves the clipboard as it was.
export function copySelectionAsPlainText(e: CopyEventLike): void {
  if (e.defaultPrevented || !e.clipboardData) return;
  if (
    e.target instanceof Element &&
    e.target.closest(
      "input, textarea, [contenteditable]:not([contenteditable=false])",
    )
  )
    return;
  const text = window.getSelection()?.toString() ?? "";
  if (!text) return;
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

// The chat renders "\$" as "$" except inside code, so the copy does the
// same. Code is decided as marked decides it: fenced blocks (an unclosed
// fence runs to the end) and backtick spans of equal run length within a
// paragraph. Indented (4-space) code blocks are not detected.
export function unescapeDollars(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(unescapeInline(paragraph.join("\n")));
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    if (fence) {
      out.push(line);
      const close = CLOSE_FENCE.exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    const open = OPEN_FENCE.exec(line);
    // A backtick fence's info string cannot hold a backtick.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flush();
      out.push(line);
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join("\n");
}

function unescapeInline(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && ASCII_PUNCT.test(text[i + 1])) {
      out += text[i + 1] === "$" ? "$" : c + text[i + 1];
      i += 2;
    } else if (c === "`") {
      const run = backtickRun(text, i);
      const close = closingRun(text, i + run, run);
      const end = close === -1 ? i + run : close + run;
      out += text.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function backtickRun(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") end++;
  return end - at;
}

// The start of the next run of exactly `length` backticks, or -1.
function closingRun(text: string, from: number, length: number): number {
  for (let i = from; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const run = backtickRun(text, i);
    if (run === length) return i;
    i += run;
  }
  return -1;
}
