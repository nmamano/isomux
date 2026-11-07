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
//
// Only images from the office itself load (task 16f6b48c). An image that
// loads by itself is a way out with no click: an agent can put office data
// in its URL, and each member who opens the chat sends it. An image from an
// outside site shows as a link to it, and a style that could load one
// drops. The office CSP (img-src in server/auth-middleware.ts) is the
// browser rule behind this.

import {
  ATTR_RE,
  MARKUP_RE,
  SVG_SPAN_RE,
  escapeAttrValue,
  escapeText,
  isSvgElement,
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

/** Whether an image at `url` loads from the office itself: data:, blob:,
 * or a URL that resolves to the page's own origin. It resolves as the
 * browser does, so a backslash, a tab or a leading "//" cannot hide a host. */
export function isLocalImageSrc(url: string, base = location.href): boolean {
  try {
    const resolved = new URL(url, base);
    if (resolved.protocol === "data:" || resolved.protocol === "blob:")
      return true;
    return resolved.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The link an image from an outside site shows as: its alt text, or else
 * its host. `src` has passed safeUrl. */
export function outsideImageLink(src: string, alt: string): string {
  return `<a class="md-outside-image" href="${escapeAttrValue(src)}" target="_blank" rel="noopener noreferrer">${escapeText(imageName(src, alt))}</a>`;
}

function imageName(src: string, alt: string): string {
  if (alt.trim()) return alt;
  try {
    return new URL(src, location.href).host || src;
  } catch {
    return src;
  }
}

// How many links are open around the token being rendered, Markdown and raw
// HTML alike. Inside a link an outside image shows as its text: an <a> in an
// <a> makes the browser close the outer link, and a badge would then link to
// the image host instead of the project. renderMarkdown resets it per
// message; a link left open keeps later images as text, which loads nothing.
let openLinks = 0;
export const linkNesting = {
  reset() {
    openLinks = 0;
  },
  open() {
    openLinks++;
  },
  close() {
    if (openLinks > 0) openLinks--;
  },
};

/** An image whose `src` has passed the caller's scheme check. */
export function imageHtml(src: string, alt: string, title?: string): string {
  if (!isLocalImageSrc(src)) {
    return openLinks > 0
      ? escapeText(imageName(src, alt))
      : outsideImageLink(src, alt);
  }
  const titleAttr = title ? ` title="${escapeAttrValue(title)}"` : "";
  return `<img src="${escapeAttrValue(src)}" alt="${escapeAttrValue(alt)}"${titleAttr}>`;
}

// A style value that can fetch: CSS escapes can spell any of these.
const FETCHING_STYLE =
  /\\|url\s*\(|image-set\s*\(|image\s*\(|src\s*\(|@import/i;

function readAttrs(attrSource: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of attrSource.matchAll(ATTR_RE)) {
    const name = m[1]?.toLowerCase();
    if (!name || name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;
    if (attrs.has(name)) continue;
    let value = m[2] ?? "";
    if (/^(["']).*\1$/s.test(value)) value = value.slice(1, -1);
    value = decodeEntities(value);
    if (name === "href" || name === "src") {
      const url = safeUrl(value, name);
      if (url === null) continue;
      value = url;
    }
    if (name === "style" && FETCHING_STYLE.test(value)) continue;
    attrs.set(name, value);
  }
  return attrs;
}

function sanitizeElement(element: string, attrSource: string): string {
  const attrs = readAttrs(attrSource);
  const src = attrs.get("src");
  if (element === "img" && src !== undefined && !isLocalImageSrc(src))
    return imageHtml(src, attrs.get("alt") ?? "");
  let out = `<${element}`;
  for (const [name, value] of attrs)
    out += ` ${name}="${escapeAttrValue(value)}"`;
  if (element === "a") out += ` target="_blank" rel="noopener noreferrer"`;
  return out + ">";
}

/** Whether the ask card shows this one tag as text, as it does a
 * placeholder such as <agent-id>, rather than drawing or dropping it: a tag
 * on neither this allowlist nor the SVG one. */
export function tagShowsAsText(tag: string): boolean {
  const m = new RegExp(`^(?:${MARKUP_RE.source})$`).exec(tag.trim());
  if (!m) return true;
  const name = (m[1] ?? m[2])?.toLowerCase();
  return (
    name !== undefined && !ALLOWED_ELEMENTS.has(name) && !isSvgElement(name)
  );
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
      out += sanitizeElement(openName, attrSource);
      if (openName === "a") linkNesting.open();
    } else if (closeName !== undefined && ALLOWED_ELEMENTS.has(closeName)) {
      out += `</${closeName}>`;
      if (closeName === "a") linkNesting.close();
    } else if (openName !== undefined || closeName !== undefined) {
      out += escapeAngles(m[0]);
    }
    // Comments, CDATA, <!doctype> and <? … ?> drop.
  }
  return out + escapeAngles(raw.slice(last));
}
