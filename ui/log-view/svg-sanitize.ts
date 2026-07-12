// Sanitizer for raw inline <svg> blocks in chat messages.
//
// Chat markdown passes raw HTML through to innerHTML unsanitized (local,
// trusted-ish content), but SVG needs special handling for a rendering
// reason: marked's `breaks: true` inserts <br> between the lines of any
// SVG that ends up inside a paragraph, and <br> is one of the HTML
// parser's "foreign content breakout" tags — the browser force-closes the
// <svg> when it hits one, so every shape after it parses as an unknown
// HTML element and renders nothing. The Markdown component therefore
// captures whole <svg>…</svg> spans with a marked extension and emits
// them through this sanitizer instead.
//
// Since that makes agent-authored SVG a deliberately supported surface,
// we hold it to a stricter bar than the rest of the passthrough HTML:
// only known shape/structure/text/paint elements and presentation
// attributes survive. <script>, <foreignObject>, SMIL animation, on*
// handlers, the style attribute (it would admit the whole SVG CSS
// surface, including url() fetches), and non-fragment hrefs are dropped.
// Paint/reference attributes that accept CSS url() syntax (fill, stroke,
// clip-path, mask, marker-*) are restricted to same-document url(#id)
// references so a diagram can't trigger external fetches.
//
// Implementation note: this is a parse-to-AST-then-re-emit design, not a
// filter over the input string. Every emitted tag is reconstructed from
// parsed parts (allowlisted canonical name + allowlisted attributes with
// escaped values) and every text node is entity-escaped, so imperfect
// tokenization of adversarial input degrades rendering, never safety.
// It's DOM-free on purpose: it behaves identically in the browser and in
// bun tests (which have no DOMParser).

// Allowed elements, keyed by lowercase name, valued by canonical casing.
// The HTML parser case-adjusts SVG names itself, but emitting canonical
// casing keeps the output valid standalone SVG too.
const ALLOWED_ELEMENTS = new Map<string, string>(
  [
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "title",
    "desc",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "linearGradient",
    "radialGradient",
    "stop",
    "pattern",
    "marker",
    "clipPath",
    "mask",
    "switch",
  ].map((name) => [name.toLowerCase(), name]),
);

// Allowed attributes, keyed by lowercase name, valued by canonical casing.
// aria-* and data-* are additionally allowed by pattern below.
const ALLOWED_ATTRS = new Map<string, string>(
  [
    // core (no `style`: it admits arbitrary CSS incl. url() fetches;
    // presentation attributes cover diagram styling needs)
    "id",
    "class",
    "role",
    "xmlns",
    "xmlns:xlink",
    "version",
    // geometry & layout
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "fx",
    "fy",
    "fr",
    "width",
    "height",
    "d",
    "points",
    "pathLength",
    "dx",
    "dy",
    "rotate",
    "transform",
    "viewBox",
    "preserveAspectRatio",
    // paint servers, markers, clip/mask units
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "offset",
    "patternUnits",
    "patternContentUnits",
    "patternTransform",
    "markerUnits",
    "markerWidth",
    "markerHeight",
    "refX",
    "refY",
    "orient",
    "clipPathUnits",
    "maskUnits",
    "maskContentUnits",
    // presentation
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "color",
    "display",
    "visibility",
    "overflow",
    "clip-path",
    "clip-rule",
    "mask",
    "marker-start",
    "marker-mid",
    "marker-end",
    "stop-color",
    "stop-opacity",
    "vector-effect",
    "shape-rendering",
    "text-rendering",
    "paint-order",
    "pointer-events",
    // text
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "letter-spacing",
    "word-spacing",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-variant",
    "text-decoration",
    "writing-mode",
    "direction",
    "textLength",
    "lengthAdjust",
    // links (fragment-only, enforced below)
    "href",
    "xlink:href",
  ].map((name) => [name.toLowerCase(), name]),
);

const ATTR_PATTERN_ALLOWED = /^(?:aria|data)-[\w-]+$/;
const URL_ATTRS = new Set(["href", "xlink:href"]);

// Presentation attributes whose values are parsed with CSS syntax and can
// contain url(...) references (paint servers, clip paths, masks, markers).
// Their values must pass isSafeCssValue so url() can only point into the
// current document.
const CSS_URL_ATTRS = new Set([
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

// Functional notations that are harmless in a paint value.
const SAFE_CSS_FUNCS = new Set(["rgb", "rgba", "hsl", "hsla"]);

// Accepts plain values ("#333", "red", "none"), safe color functions, and
// same-document url(#id) references (quoted or not). Rejects everything
// else that looks functional, and any value containing a backslash — CSS
// escape sequences could otherwise disguise "url(" from this check.
function isSafeCssValue(value: string): boolean {
  if (value.includes("\\")) return false;
  for (const m of value.matchAll(/([a-zA-Z-]*)\(/g)) {
    const func = m[1].toLowerCase();
    if (SAFE_CSS_FUNCS.has(func)) continue;
    if (func === "url") {
      const rest = value.slice(m.index + m[0].length);
      if (/^\s*["']?\s*#/.test(rest)) continue;
      return false;
    }
    return false;
  }
  return true;
}

// Matches one markup construct. Attribute chunks may contain '>' only
// inside quotes, hence the alternation instead of a bare [^>]*.
const MARKUP_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrValue(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeAttrs(attrSource: string): string {
  let out = "";
  for (const m of attrSource.matchAll(ATTR_RE)) {
    const rawName = m[1];
    if (!rawName || rawName === "/") continue;
    const lower = rawName.toLowerCase();
    // Explicitly refuse event handlers even if a future edit ever adds
    // one to the allowlist by mistake.
    if (lower.startsWith("on")) continue;
    let canonical: string;
    if (ALLOWED_ATTRS.has(lower)) {
      canonical = ALLOWED_ATTRS.get(lower)!;
    } else if (ATTR_PATTERN_ALLOWED.test(lower)) {
      canonical = lower;
    } else {
      continue;
    }
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (URL_ATTRS.has(lower)) {
      // Fragment references only (gradients, <use>, <textPath>). This is
      // an allowlist, not a scheme denylist: anything that does not start
      // with "#" is dropped, so scheme obfuscation cannot dodge it.
      // Whitespace is stripped first so tab/newline-riddled values are
      // judged on their real content, and legit refs like " #id" (which
      // browsers trim anyway) still pass. Values with embedded control
      // characters simply fail the "#" check.
      const compact = value.replace(/\s+/g, "");
      if (!compact.startsWith("#")) continue;
      value = compact;
    }
    if (CSS_URL_ATTRS.has(lower) && !isSafeCssValue(value)) continue;
    out += ` ${canonical}="${escapeAttrValue(value)}"`;
  }
  return out;
}

/**
 * Sanitize a raw `<svg>…</svg>` span for insertion via innerHTML.
 *
 * Keeps allowlisted SVG shape/structure/text/paint elements and
 * presentation attributes. Drops disallowed elements together with their
 * entire subtree (so <script> / <foreignObject> payloads vanish, not just
 * their tags), strips on* attributes, and restricts href/xlink:href to
 * same-document fragment references. All text nodes are entity-escaped.
 * Unclosed allowed elements are closed at the end so the output is always
 * balanced markup.
 */
export function sanitizeSvg(raw: string): string {
  let out = "";
  // Open elements we are inside of. `emitted` distinguishes elements whose
  // open tag was written to the output from elements being skipped (either
  // disallowed themselves or nested inside a disallowed subtree).
  const stack: { lower: string; canonical: string; emitted: boolean }[] = [];
  let skipDepth = 0;
  let last = 0;

  const emitText = (text: string) => {
    if (skipDepth === 0 && text) out += escapeText(text);
  };

  for (const m of raw.matchAll(MARKUP_RE)) {
    emitText(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const closeName = m[1];
    const openName = m[2];
    if (closeName !== undefined) {
      const lower = closeName.toLowerCase();
      // Ignore close tags that match nothing; otherwise pop (and close)
      // everything above the matching entry so output stays balanced.
      if (stack.some((e) => e.lower === lower)) {
        for (;;) {
          const entry = stack.pop()!;
          if (entry.emitted) out += `</${entry.canonical}>`;
          else if (!ALLOWED_ELEMENTS.has(entry.lower)) skipDepth--;
          if (entry.lower === lower) break;
        }
      }
    } else if (openName !== undefined) {
      const lower = openName.toLowerCase();
      const attrSource = m[3] ?? "";
      const selfClosing = /\/\s*$/.test(attrSource);
      const allowed = ALLOWED_ELEMENTS.has(lower);
      if (allowed && skipDepth === 0) {
        const canonical = ALLOWED_ELEMENTS.get(lower)!;
        const attrs = sanitizeAttrs(
          selfClosing ? attrSource.replace(/\/\s*$/, "") : attrSource,
        );
        if (selfClosing) {
          out += `<${canonical}${attrs}/>`;
        } else {
          out += `<${canonical}${attrs}>`;
          stack.push({ lower, canonical, emitted: true });
        }
      } else if (!selfClosing) {
        // Disallowed element, or anything inside a skipped subtree: track
        // it so its close tag pairs up, but emit nothing.
        stack.push({ lower, canonical: lower, emitted: false });
        if (!allowed) skipDepth++;
      }
    }
    // Comments, CDATA, <!doctype>, and <? … ?> are dropped silently.
  }
  emitText(raw.slice(last));

  // Close anything left open (e.g. a truncated or sloppy diagram).
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].emitted) out += `</${stack[i].canonical}>`;
  }
  return out;
}
