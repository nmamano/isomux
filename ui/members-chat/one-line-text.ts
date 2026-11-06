// One-line plain views of ask text, with no React, so the server can use
// them too: the one-line tokens InlineMarkdown draws, their plain text, and
// an ask's subject line.

import { Lexer, defaults, type MarkedToken, type Token } from "marked";
import { tagShowsAsText } from "../log-view/html-sanitize.ts";
import { colorMarkupOptions, type ColorToken } from "./color-markup.ts";

// A parsed link still has an untrusted destination. Accept web and email URLs
// only, including marked's normalized bare www. links.
export function isSafeHref(href: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    // Keep an invalid destination as literal text.
    return false;
  }
}

// The text as one flat list of inline tokens, for a one-line view of an ask:
// the inline tokens of each block, a space between blocks. A fence gives its
// code as text. An HTML block and any other block give nothing.
export function oneLineTokens(content: string, colors: boolean): Token[] {
  const blocks = Lexer.lex(content, {
    ...(colors ? colorMarkupOptions : defaults),
    gfm: true,
    breaks: false,
  });
  const lines = blockInlines(blocks).filter((line) => line.length > 0);
  return lines.flatMap((line, index) =>
    index === 0 ? line : [{ type: "text", raw: " ", text: " " }, ...line],
  );
}

// The inline tokens of each block, one list per block.
function blockInlines(tokens: Token[]): Token[][] {
  return (tokens as MarkedToken[]).flatMap((token): Token[][] => {
    switch (token.type) {
      case "paragraph":
      case "heading":
      case "text":
        return [flatInline(token.tokens ?? [token])];
      case "blockquote":
        return blockInlines(token.tokens);
      case "list":
        return token.items.flatMap((item) => blockInlines(item.tokens));
      case "table":
        return [token.header, ...token.rows]
          .flat()
          .map((cell) => flatInline(cell.tokens));
      case "code":
        return [[{ type: "text", raw: token.text, text: token.text }]];
      default:
        return [];
    }
  });
}

// Inline tokens a one-line view can draw: no image, task box or HTML the
// ask card draws or drops, a line break as a space, and a link or
// strikethrough replaced by its text.
function flatInline(tokens: Token[]): Token[] {
  return (tokens as (MarkedToken | ColorToken)[]).flatMap((token): Token[] => {
    if (token.type === "image" || token.type === "checkbox") return [];
    if (token.type === "html") return tagShowsAsText(token.raw) ? [token] : [];
    if (token.type === "br") return [{ type: "text", raw: " ", text: " " }];
    if (token.type === "link" || token.type === "del")
      return flatInline(token.tokens);
    if (
      (token.type === "strong" ||
        token.type === "em" ||
        token.type === "color") &&
      token.tokens
    )
      return [{ ...token, tokens: flatInline(token.tokens) }];
    return [token];
  });
}

/** The text of oneLineTokens without its markers, whitespace collapsed, for
 * a plain-text one-line view (an excerpt, a chip label). */
export function oneLinePlainText(content: string): string {
  return plainText(oneLineTokens(content, true));
}

function plainText(tokens: Token[]): string {
  return plainTokens(tokens).replace(/\s+/g, " ").trim();
}

// The same token cases as renderTokens, with text in place of elements.
function plainTokens(tokens: Token[]): string {
  return (tokens as (MarkedToken | ColorToken)[])
    .map((token) => {
      if (token.type === "color") return plainTokens(token.tokens);
      if ((token.type === "strong" || token.type === "em") && token.tokens)
        return plainTokens(token.tokens);
      if (token.type === "codespan" || token.type === "escape")
        return token.text;
      if (token.type === "link" && token.tokens && isSafeHref(token.href))
        return plainTokens(token.tokens);
      return token.raw;
    })
    .join("");
}

/** The plain text of the prompt's first line that says what the ask is
 * about: a colour span that starts a line is a label, not the subject. A
 * prompt of labels only gives the first label's text; one with no text,
 * "". */
export function askSubject(prompt: string): string {
  return askSubjectLine(prompt).subject;
}

/** askSubject, with the index in prompt.split("\n") of the line it comes
 * from: for a prompt of labels only, the first label's line; for a prompt
 * with no text, -1. */
export function askSubjectLine(prompt: string): {
  subject: string;
  line: number;
} {
  let labelOnly = { subject: "", line: -1 };
  const lines = prompt.split("\n");
  for (const [index, line] of lines.entries()) {
    const tokens = oneLineTokens(line, true);
    const start = tokens.findIndex(
      (token) => token.type !== "text" || token.raw.trim() !== "",
    );
    const label = (tokens[start] as Token | undefined)?.type === "color";
    const text = plainText(label ? tokens.slice(start + 1) : tokens);
    // The separator between a label and its subject goes with the label.
    const subject = label ? text.replace(LABEL_SEPARATOR_RE, "") : text;
    if (subject) return { subject, line: index };
    if (labelOnly.line < 0) {
      const whole = plainText(tokens);
      if (whole) labelOnly = { subject: whole, line: index };
    }
  }
  return labelOnly;
}

// What can stand between a leading label and the subject: "- ", ": ", "· ".
const LABEL_SEPARATOR_RE = /^[\s:;,.|·•\p{Pd}]+/u;
