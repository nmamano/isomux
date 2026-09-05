import {
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { Marked } from "marked";
import { useI18n } from "../i18n.tsx";
import type { Translator } from "../../shared/i18n/translate.ts";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import { sanitizeSvg } from "./svg-sanitize.ts";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("txt", plaintext);

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

marked.setOptions({
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.use({ renderer });

// Capture ```mermaid fenced blocks before the default fenced-code tokenizer.
// Emits a <div class="mermaid-wrapper"> containing an empty <div class="mermaid">
// whose data-mermaid-source attribute holds the diagram source. The React
// effect below lazy-loads mermaid and replaces the inner div with the
// rendered SVG. Carrying the source on a data attribute (rather than as the
// div's textContent) means the effect can safely overwrite the div's
// contents without losing the source, e.g. if the effect ever re-fires.
const escapeHtmlAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
marked.use({
  extensions: [
    {
      name: "mermaidBlock",
      level: "block",
      start(src: string) {
        const idx = src.indexOf("```mermaid");
        return idx >= 0 ? idx : undefined;
      },
      tokenizer(src: string) {
        const match =
          /^```mermaid[ \t]*\n([\s\S]*?)\n```(?:[ \t]*(?:\n|$))/.exec(src);
        if (!match) return undefined;
        return {
          type: "mermaidBlock",
          raw: match[0],
          source: match[1],
        };
      },
      renderer(token) {
        const source = (token as { source?: string }).source ?? "";
        return (
          `<div class="mermaid-wrapper">` +
          `<div class="mermaid" data-mermaid-source="${escapeHtmlAttr(source)}"></div>` +
          `</div>\n`
        );
      },
    },
  ],
});

// Capture whole <svg>…</svg> spans before marked's paragraph handling
// can mangle them: `breaks: true` would insert <br> between the lines of
// any SVG that isn't a clean HTML block, and a <br> inside an <svg>
// makes the browser force-close it, dropping every shape after it (see
// svg-sanitize.ts for the full story). Captured spans are emitted
// through sanitizeSvg. The block-level extension handles SVGs that start
// on their own line (including ones with blank lines inside, which
// inline tokenization can't cross); the inline one handles SVGs embedded
// mid-text. The `start` hooks are deliberately narrower than
// indexOf("<svg") - line-start only for block, not-backtick-preceded for
// inline - so prose that mentions `<svg>` in inline code keeps being
// handled by the built-in codespan tokenizer.
const SVG_SPAN_RE = /^<svg\b[\s\S]*?<\/svg\s*>/i;
const svgExtension = (
  name: string,
  level: "block" | "inline",
  startRe: RegExp,
) => ({
  name,
  level,
  start(src: string) {
    const match = startRe.exec(src);
    // Point at the "<" itself, not the line break / preceding char the
    // guard consumed.
    return match ? match.index + match[0].indexOf("<") : undefined;
  },
  tokenizer(src: string) {
    const match = SVG_SPAN_RE.exec(src);
    if (!match) return undefined;
    return { type: name, raw: match[0] };
  },
  renderer(token: { raw: string }) {
    return sanitizeSvg(token.raw);
  },
});
marked.use({
  extensions: [
    svgExtension("svgBlock", "block", /(?:^|\n)[ \t]*<svg\b/i),
    svgExtension("svgInline", "inline", /(?:^|[^`])<svg\b/i),
  ],
});

// Lazy singleton: mermaid is ~1MB minified, so we only fetch it the first
// time a message containing a mermaid block reaches the renderer.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
// Monotonically-unique per-render id. Mermaid uses the id we pass to render()
// as a prefix for internal SVG defs/markers/clipPath etc., and same-document
// id collisions cause url(#...) refs to resolve to the wrong element. A
// counter (rather than Date.now() + index) keeps every render unique even if
// many Markdown components mount on the same tick.
let mermaidIdCounter = 0;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const m = mod.default;
      const mode =
        document.documentElement.getAttribute("data-theme-mode") === "dark"
          ? "dark"
          : "default";
      m.initialize({
        startOnLoad: false,
        theme: mode,
        securityLevel: "strict",
        fontFamily: "DM Sans, sans-serif",
      });
      return m;
    });
  }
  return mermaidPromise;
}

const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;
const copyButtonHtml = (title: string) =>
  `<button class="copy-btn code-copy-btn" title="${title}">${COPY_SVG}</button>`;

// Exported for tests. Full markdown-to-html pipeline as used by the
// component: marked parse plus the copy-button and table wrappers. The
// translator is the first argument because this builds strings during render
// and is not a component (internal-docs/i18n-loop.md, ruling 18).
export function renderMarkdown(i18n: Translator, content: string): string {
  try {
    const raw = marked.parse(content) as string;
    // Wrap <pre> blocks in a container so the copy button stays fixed outside the scroll area
    const withCode = raw
      .replace(
        /<pre>/g,
        `<div class="code-block-wrapper">${copyButtonHtml(i18n.t("common.copy"))}<pre>`,
      )
      .replace(/<\/pre>/g, `</pre></div>`);
    // Wrap <table> blocks so they scroll horizontally on narrow viewports instead of overflowing
    return withCode
      .replace(/<table>/g, `<div class="table-wrapper"><table>`)
      .replace(/<\/table>/g, `</table></div>`);
  } catch {
    return content;
  }
}

export function Markdown({ content }: { content: string }) {
  const i18n = useI18n();
  // i18n in the deps, not just content: the translator keeps one identity per
  // language, so this re-renders the html when the reader switches language
  // and never serves a copy button labelled in the old one.
  const html = useMemo(() => renderMarkdown(i18n, content), [i18n, content]);

  const onClick = useCallback(async (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest(".code-copy-btn");
    if (!btn) return;
    e.stopPropagation();
    const wrapper = btn.closest(".code-block-wrapper");
    const pre = wrapper?.querySelector("pre");
    if (!pre) return;
    const code = pre.querySelector("code");
    const text = code ? (code.textContent ?? "") : (pre.textContent ?? "");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    btn.innerHTML = CHECK_SVG;
    (btn as HTMLElement).style.color = "var(--green)";
    (btn as HTMLElement).style.background = "var(--green-bg)";
    setTimeout(() => {
      btn.innerHTML = COPY_SVG;
      (btn as HTMLElement).style.color = "";
      (btn as HTMLElement).style.background = "";
    }, 1500);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  // We manage innerHTML manually (in a layout effect keyed on html) rather
  // than via React's dangerouslySetInnerHTML. Observed bug with the latter:
  // when a chat re-render happened that didn't change this message's
  // markdown source (e.g. a new message landed and isLastInTurn/turnEntries
  // shifted on prior LogEntryCards), the SVG that mermaid had rendered into
  // a .mermaid div was wiped back to the wrapper's original empty state.
  // The mermaid effect below also keys on [html] so it never re-fired to
  // repair the wipe. Driving innerHTML from a layout effect keyed on the
  // memoized html string makes the DOM write a no-op for re-renders that
  // don't change the markdown source - and a clean reset for ones that do
  // (e.g. streaming chunks).
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root.innerHTML = html;
    // The diagram placeholder is a CSS ::before, which cannot read the
    // catalog. The words live in the catalog anyway and ride in on the node,
    // where `content: attr(data-loading)` picks them up (ui/styles.ts). Set
    // here rather than in the emitted html because the tokenizer is
    // module-scope and has no translator.
    for (const node of root.querySelectorAll<HTMLElement>(".mermaid"))
      node.dataset.loading = i18n.t("cards.markdown.rendering");
  }, [html, i18n]);

  // After every html change, find any unprocessed mermaid blocks and hand
  // them to the lazy-loaded mermaid library one at a time. We use
  // mermaid.render() (not run()) so we pass the source explicitly from each
  // node's data-mermaid-source attribute - no reliance on textContent, so
  // we never accidentally feed a "Rendering…" placeholder back to mermaid
  // if this effect ever re-fires while sources are mid-mutation.
  //
  // Three observable end states per node:
  //   - SVG inside .mermaid → success
  //   - .mermaid-wrapper[data-mermaid-error="true"] with "Mermaid error: …"
  //     → mermaid loaded but the diagram source didn't parse
  //   - same wrapper with "Failed to load mermaid: …" → the dynamic import
  //     rejected (network, CSP, syntax-on-old-Safari etc.)
  // Until any of those terminal states is reached, .mermaid is empty and CSS
  // shows the cards.markdown.rendering placeholder via ::before, from the
  // data-loading attribute the layout effect above puts on the node.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(".mermaid:not([data-processed])"),
    );
    if (nodes.length === 0) return;
    const sources = nodes.map(
      (n) => n.getAttribute("data-mermaid-source") ?? "",
    );
    let cancelled = false;
    const markError = (
      node: HTMLElement,
      prefix: string,
      msg: string,
      src: string,
    ) => {
      const wrapper = node.closest<HTMLElement>(".mermaid-wrapper");
      if (wrapper) wrapper.setAttribute("data-mermaid-error", "true");
      node.textContent = `${prefix}: ${msg}\n\n${src}`;
      node.setAttribute("data-processed", "true");
    };
    getMermaid()
      .then(async (m) => {
        if (cancelled) return;
        for (let i = 0; i < nodes.length; i++) {
          if (cancelled) return;
          const node = nodes[i];
          try {
            const id = `mmd-${++mermaidIdCounter}`;
            const { svg } = await m.render(id, sources[i]);
            node.innerHTML = svg;
            node.setAttribute("data-processed", "true");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            markError(node, i18n.t("cards.markdown.mermaidError"), msg, sources[i]);
          }
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        nodes.forEach((node, i) => {
          markError(node, i18n.t("cards.markdown.mermaidLoadFailed"), msg, sources[i]);
        });
      });
    return () => {
      cancelled = true;
    };
  }, [html, i18n]);

  return (
    <div
      ref={containerRef}
      className="md-content"
      onClick={(e) => void onClick(e)}
    />
  );
}
