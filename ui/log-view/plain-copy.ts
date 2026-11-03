// Copying from the chat: a selection goes on the clipboard as plain text
// only, with each formula as its TeX source (selection-text.ts), a copied
// agent reply loses the backslash agents write before a literal dollar, and
// the chat bar's Copy in Plain text loses the Markdown.

import { Lexer, type Token, type Tokens } from "marked";
import { selectionText } from "./selection-text.ts";

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
  const sel = window.getSelection();
  const text = sel ? selectionText(sel) : "";
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

// How the chat bar's Copy writes an agent's reply: as written, or with the
// Markdown taken out. "html" saves the chat as a file (chat-export.ts).
export type ChatCopyFormat = "markdown" | "plain" | "html";

// An agent reply as the reader sees it, without the Markdown: marks, fences
// and link brackets go; every word, the code, list markers and raw HTML stay.
// Parsed as the chat parses it (gfm, breaks), so "\$" reads "$" outside code.
export function markdownToPlainText(markdown: string): string {
  return blocksText(new Lexer({ gfm: true, breaks: true }).lex(markdown));
}

function blocksText(tokens: Token[], sep = "\n\n"): string {
  return tokens
    .map(blockText)
    .filter((text) => text !== "")
    .join(sep);
}

function blockText(token: Token): string {
  const t = token as Tokens.Generic;
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
      return "";
    case "code":
      return t.text as string;
    case "html":
      return (t.text as string).replace(/\n+$/, "");
    case "heading":
    case "paragraph":
      return inlineText(t.tokens ?? []);
    case "text":
      return t.tokens
        ? inlineText(t.tokens)
        : decodeXmlEntities(t.text as string);
    case "blockquote":
      return blocksText(t.tokens ?? []);
    case "list":
      return listText(token as Tokens.List);
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]) =>
        cells.map((c) => inlineText(c.tokens)).join(" | ");
      return [row(table.header), ...table.rows.map(row)].join("\n");
    }
    default:
      return t.tokens ? inlineText(t.tokens) : ((t.text as string) ?? "");
  }
}

// Each item keeps its marker ("- ", "3. ", a task box); the lines after the
// first, nested lists among them, are indented under the item's text.
function listText(list: Tokens.List): string {
  const start = typeof list.start === "number" ? list.start : 1;
  return list.items
    .map((item, i) => {
      let marker = list.ordered ? `${start + i}. ` : "- ";
      if (item.task) marker += item.checked ? "[x] " : "[ ] ";
      const body = blocksText(
        item.tokens.filter((tok) => tok.type !== "checkbox"),
        item.loose ? "\n\n" : "\n",
      );
      const indent = " ".repeat(list.ordered ? marker.length : 2);
      return (
        marker +
        body
          .split("\n")
          .map((line, j) => (j === 0 || line === "" ? line : indent + line))
          .join("\n")
      );
    })
    .join(list.loose ? "\n\n" : "\n");
}

function inlineText(tokens: Token[]): string {
  return tokens.map(inlineTokenText).join("");
}

function inlineTokenText(token: Token): string {
  const t = token as Tokens.Generic;
  switch (token.type) {
    case "br":
      return "\n";
    case "codespan":
    case "escape":
    case "html":
      return t.text as string;
    case "checkbox":
      return "";
    case "link": {
      const text = inlineText(t.tokens ?? []);
      const href = t.href as string;
      return text === href || `mailto:${text}` === href
        ? text
        : `${text} (${href})`;
    }
    case "image": {
      const alt = decodeXmlEntities(t.text as string);
      return alt ? `${alt} (${t.href})` : (t.href as string);
    }
    case "text":
      if (t.tokens) return inlineText(t.tokens);
      return t.escaped
        ? (t.text as string)
        : decodeXmlEntities(t.text as string);
    default:
      return t.tokens ? inlineText(t.tokens) : ((t.text as string) ?? "");
  }
}

// The XML entities and numeric ones. A named HTML entity beyond those stays
// as written: the full table costs more bundle than a rare &copy; is worth.
const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z]+));/g,
    (whole, hex?: string, dec?: string, name?: string) => {
      const code =
        hex !== undefined
          ? parseInt(hex, 16)
          : dec !== undefined
            ? parseInt(dec, 10)
            : undefined;
      if (code === undefined) return XML_ENTITIES[name!] ?? whole;
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}
