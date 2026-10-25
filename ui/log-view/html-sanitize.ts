// Sanitizer for raw HTML in chat Markdown.
//
// Agent replies, project skill files and system prompts render through the
// Markdown component into innerHTML, and outside text can reach each of
// them: a reply can quote a fetched page, and a skill file can come from a
// cloned repository. Agents are also told to draw with raw HTML
// (server/agent-reference/visuals.md), so it cannot simply be escaped
// (task 85881065).
//
// Marked hands this file each raw HTML token: one tag inline, a whole chunk
// for a block. Like svg-sanitize.ts, it re-emits instead of filtering:
// an allowlisted element is rebuilt from its canonical name and its
// allowlisted attributes, with every value decoded once and then escaped,
// so the browser reads exactly the value that was checked. Every other tag
// shows as text, so a placeholder such as <agent-id> stays readable and
// <script> stays inert. Comments, doctypes, CDATA and processing
// instructions drop. An <svg> goes through sanitizeSvg. There is no element
// stack: a chunk can be unbalanced, and the browser's fragment parse cannot
// close anything outside the message.

import {
  ATTR_RE,
  MARKUP_RE,
  SVG_SPAN_RE,
  escapeAttrValue,
  sanitizeSvg,
} from "./svg-sanitize.ts";

// Text keeps its character references: in a text node they decode to
// characters and cannot open markup.
const escapeAngles = (s: string) =>
  s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ALLOWED_ELEMENTS = new Set([
  "div",
  "span",
  "p",
  "br",
  "hr",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "kbd",
  "code",
  "pre",
  "blockquote",
  "q",
  "abbr",
  "details",
  "summary",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
  "a",
  "figure",
  "figcaption",
]);

// No id or name (they clobber DOM globals), no class or data-* (they would
// forge the renderer's math, diagram and task-chip placeholders), and no
// target or rel (a link always gets ours).
const ALLOWED_ATTRS = new Set([
  "style",
  "title",
  "align",
  "valign",
  "width",
  "height",
  "colspan",
  "rowspan",
  "open",
  "href",
  "src",
  "alt",
  "start",
  "type",
  "scope",
  "dir",
  "lang",
  "role",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
  sol: "/",
  bsol: "\\",
  period: ".",
  comma: ",",
  lpar: "(",
  rpar: ")",
  excl: "!",
  num: "#",
  quest: "?",
  equals: "=",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return "\ufffd";
  if (n >= 0xd800 && n <= 0xdfff) return "\ufffd";
  return String.fromCodePoint(n);
}

// Decodes character references once. An unknown reference stays as written;
// the caller escapes every "&" afterwards, so the browser reads it as text.
export function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z]+);)/g,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (hex !== undefined) return codePoint(parseInt(hex, 16));
      if (dec !== undefined) return codePoint(parseInt(dec, 10));
      return NAMED_ENTITIES[name!] ?? whole;
    },
  );
}

const HREF_SCHEMES = new Set(["http", "https", "mailto"]);
const SRC_SCHEMES = new Set(["http", "https"]);

// The URL to emit, or null when its scheme is not allowed. `value` is
// already decoded. The browser drops tabs and newlines anywhere and trims
// controls and spaces at the edges, so the scheme is read with all of them
// removed: stricter than the browser, never looser.
export function safeUrl(value: string, kind: "href" | "src"): string | null {
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (scheme) {
    const allowed = kind === "href" ? HREF_SCHEMES : SRC_SCHEMES;
    if (!allowed.has(scheme[1].toLowerCase())) return null;
  }
  return value.trim();
}

function sanitizeAttrs(element: string, attrSource: string): string {
  let out = "";
  const seen = new Set<string>();
  for (const m of attrSource.matchAll(ATTR_RE)) {
    const name = m[1]?.toLowerCase();
    if (!name || name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    let value = m[2] ?? "";
    if (/^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
    value = decodeEntities(value);
    if (name === "href" || name === "src") {
      const url = safeUrl(value, name);
      if (url === null) continue;
      value = url;
    }
    out += ` ${name}="${escapeAttrValue(value)}"`;
  }
  if (element === "a") out += ` target="_blank" rel="noopener noreferrer"`;
  return out;
}

/**
 * Sanitize one raw HTML token (an inline tag or a block chunk) for
 * insertion through innerHTML.
 */
export function sanitizeHtml(raw: string): string {
  let out = "";
  let last = 0;
  const markup = new RegExp(MARKUP_RE.source, "g");
  for (let m = markup.exec(raw); m; m = markup.exec(raw)) {
    out += escapeAngles(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const closeName = m[1]?.toLowerCase();
    const openName = m[2]?.toLowerCase();
    if (openName === "svg") {
      const rest = raw.slice(m.index);
      const span = SVG_SPAN_RE.exec(rest)?.[0] ?? rest;
      out += sanitizeSvg(span);
      last = m.index + span.length;
      markup.lastIndex = last;
    } else if (openName !== undefined && ALLOWED_ELEMENTS.has(openName)) {
      const attrSource = (m[3] ?? "").replace(/\/\s*$/, "");
      out += `<${openName}${sanitizeAttrs(openName, attrSource)}>`;
    } else if (closeName !== undefined && ALLOWED_ELEMENTS.has(closeName)) {
      out += `</${closeName}>`;
    } else if (openName !== undefined || closeName !== undefined) {
      out += escapeAngles(m[0]);
    }
    // Comments, CDATA, <!doctype> and <? … ?> drop.
  }
  return out + escapeAngles(raw.slice(last));
}
