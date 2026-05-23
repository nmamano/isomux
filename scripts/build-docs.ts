#!/usr/bin/env bun
// Builds docs site from docs/*.md to site/docs/*.html.
// Renders trusted repo-owned markdown only. If outside contributions to docs/
// are ever accepted, add HTML sanitization (e.g. DOMPurify) at the parse step.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { marked } from "marked";

const SRC_DIR = "docs";
const OUT_DIR = "site/docs";
// The page whose content becomes the docs landing (`/docs`). Its sidebar link
// points to `/docs` instead of `/docs/<slug>`.
const LANDING_SLUG = "features";

type TocItem = { depth: number; id: string; text: string };
type Frontmatter = {
  title?: string;
  description?: string;
  order?: number;
  navTitle?: string;
};
type DocPage = {
  slug: string;
  title: string;
  navTitle: string;
  description: string;
  order: number;
  html: string;
  toc: TocItem[];
  // Raw markdown body, embedded into the page as `window.__docContext` so the
  // shared chatbot widget can pass it to /api/chat as page-specific context.
  raw: string;
};

// Sub-pages are ordered explicitly; anything not listed sorts after by title.
// The landing page (`features`) is always first.
const NAV_ORDER = [
  "features",
  "self-hosted",
  "how-it-works",
  "access-and-invites",
  "security-audit",
];

function slugify(filename: string): string {
  return basename(filename, ".md");
}

function pageUrl(page: DocPage | { slug: string }): string {
  return page.slug === LANDING_SLUG ? "/docs" : `/docs/${page.slug}`;
}

function headingSlug(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseFrontmatter(src: string): { fm: Frontmatter; body: string } {
  if (!src.startsWith("---\n")) return { fm: {}, body: src };
  const end = src.indexOf("\n---\n", 4);
  if (end === -1) return { fm: {}, body: src };
  const meta = src.slice(4, end);
  const body = src.slice(end + 5);
  const fm: Frontmatter = {};
  for (const line of meta.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "title") fm.title = m[2].trim();
    else if (m[1] === "description") fm.description = m[2].trim();
    else if (m[1] === "order") fm.order = Number(m[2].trim());
    else if (m[1] === "navTitle") fm.navTitle = m[2].trim();
  }
  return { fm, body };
}

// Rewrites md links so generated pages reference clean /docs/<slug> URLs
// instead of leaking local paths or GitHub blob URLs from inside our own repo.
// The GitHub matcher is pinned to `nmamano/isomux` so links to forks or other
// repos that happen to share the name stay external. Update if the canonical
// repo location changes.
function rewriteMdLink(href: string): string {
  const gh = href.match(
    /^https?:\/\/github\.com\/nmamano\/isomux\/blob\/[^/]+\/docs\/([\w-]+)\.md(#.*)?$/,
  );
  if (gh) {
    const slug = gh[1];
    const anchor = gh[2] || "";
    return slug === LANDING_SLUG ? `/docs${anchor}` : `/docs/${slug}${anchor}`;
  }
  const local = href.match(/^(?:\.\/)?(?:docs\/)?([\w-]+)\.md(#.*)?$/);
  if (local) {
    const slug = local[1];
    const anchor = local[2] || "";
    return slug === LANDING_SLUG ? `/docs${anchor}` : `/docs/${slug}${anchor}`;
  }
  return href;
}

function deriveTitle(body: string, slug: string): string {
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].trim() : slug;
}

function deriveDescription(body: string): string {
  const withoutH1 = body.replace(/^#[^\n]*\n+/, "");
  for (const line of withoutH1.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("---")) continue;
    const plain = t
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*`_]/g, "");
    return plain.length > 200 ? plain.slice(0, 197) + "..." : plain;
  }
  return "";
}

function tokensToPlain(tokens: unknown[]): string {
  return tokens
    .map((t) => {
      const tok = t as { tokens?: unknown[]; text?: string };
      if (tok.tokens) return tokensToPlain(tok.tokens);
      return tok.text || "";
    })
    .join("");
}

function renderMarkdown(body: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const renderer = new marked.Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const inner = this.parser.parseInline(tokens);
    const plain = tokensToPlain(tokens);
    const id = headingSlug(plain);
    if (depth === 2 || depth === 3) toc.push({ depth, id, text: plain });
    return `<h${depth} id="${id}">${inner}<a class="anchor-link" href="#${id}" aria-label="link to section">#</a></h${depth}>\n`;
  };

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const newHref = rewriteMdLink(href);
    const isExternal = /^https?:\/\//.test(newHref);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const targetAttr = isExternal ? ` target="_blank" rel="noopener"` : "";
    return `<a href="${escapeHtml(newHref)}"${titleAttr}${targetAttr}>${text}</a>`;
  };

  const html = marked.parse(body, { renderer, async: false }) as string;
  return { html, toc };
}

function loadPage(filename: string): DocPage {
  const slug = slugify(filename);
  const raw = readFileSync(join(SRC_DIR, filename), "utf8");
  const { fm, body } = parseFrontmatter(raw);
  const title = fm.title || deriveTitle(body, slug);
  const navTitle = fm.navTitle || title;
  const description = fm.description || deriveDescription(body);
  // Render the body as-is; the markdown H1 becomes the visible page title.
  // The derived `title` is still used for the <title> tag and meta tags.
  const { html, toc } = renderMarkdown(body);
  const navIdx = NAV_ORDER.indexOf(slug);
  const order = fm.order ?? (navIdx >= 0 ? navIdx : NAV_ORDER.length + 100);
  return { slug, title, navTitle, description, order, html, toc, raw: body };
}

// Safely embed an arbitrary string as a JS literal inside a <script> block.
// JSON.stringify handles the basic escaping; the </ → <\/ replacement
// prevents a stray "</script>" sequence in the content from terminating the
// <script> element early.
function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/<\//g, "<\\/");
}

// ---- Templates ----

const STYLES = `
:root {
  --bg: #0a0e16;
  --bg-surface: #161b22;
  --bg-card: #1c2128;
  --text: #f0f3f6;
  --text-dim: #bcc5d0;
  --accent: #50b86c;
  --accent-hover: #3da85a;
  --border: #30363d;
  --topbar-bg: rgba(10, 14, 22, 0.92);
  --layout-max: 1180px;
  --sidebar-width: 220px;
  color-scheme: dark;
}

/* Light mode — honored when the OS / browser asks for it. Same variable
   shape as the dark default; accent green is darkened so links and headings
   hit AA contrast on white. Mirrors the landing palette in site/index.html. */
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f6f9;
    --bg-surface: #ffffff;
    --bg-card: #eef1f5;
    --text: #1a2030;
    --text-dim: #5a6a80;
    --accent: #1f9550;
    --accent-hover: #16803f;
    --border: #d8dde6;
    --topbar-bg: rgba(244, 246, 249, 0.92);
    color-scheme: light;
  }
}

/* Explicit user override via the theme toggle (site/theme-toggle.js) or
   the wall moon/sun inside the app — both write the same localStorage key
   and the early script in <head> sets data-theme-mode before paint. The
   data-theme-mode blocks beat :root inside @media on specificity, so the
   user pick wins regardless of OS preference. */
:root[data-theme-mode="dark"] {
  --bg: #0a0e16;
  --bg-surface: #161b22;
  --bg-card: #1c2128;
  --text: #f0f3f6;
  --text-dim: #bcc5d0;
  --accent: #50b86c;
  --accent-hover: #3da85a;
  --border: #30363d;
  --topbar-bg: rgba(10, 14, 22, 0.92);
  color-scheme: dark;
}
:root[data-theme-mode="light"] {
  --bg: #f4f6f9;
  --bg-surface: #ffffff;
  --bg-card: #eef1f5;
  --text: #1a2030;
  --text-dim: #5a6a80;
  --accent: #1f9550;
  --accent-hover: #16803f;
  --border: #d8dde6;
  --topbar-bg: rgba(244, 246, 249, 0.92);
  color-scheme: light;
}

/* Theme toggle button. Mounted by site/theme-toggle.js inside .topbar-inner
   on docs pages (gets .theme-toggle--inline). The base style is also used
   on the landing where the script mounts the button fixed top-right. */
.theme-toggle {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 90;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-dim);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
}
.theme-toggle:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: scale(1.06);
}
.theme-toggle svg {
  width: 18px;
  height: 18px;
}
.theme-toggle--inline {
  position: static;
  width: 32px;
  height: 32px;
}
.theme-toggle--inline svg {
  width: 16px;
  height: 16px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.65;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3, h4 { font-family: "Space Grotesk", -apple-system, sans-serif; }

/* ---- Top bar ---- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--topbar-bg);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  max-width: var(--layout-max);
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 18px;
}
.topbar-brand {
  font-family: "Space Grotesk", sans-serif;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--text);
  transition: color 0.15s;
}
.topbar-brand:hover { color: var(--accent); text-decoration: none; }
.topbar-crumb {
  color: var(--text-dim);
  font-size: 0.95rem;
  text-decoration: none;
  transition: color 0.15s;
}
a.topbar-crumb:hover { color: var(--accent); text-decoration: none; }
.topbar-crumb::before { content: "/ "; margin-right: 4px; color: var(--border); }
.topbar-spacer { flex: 1; }
.topbar-links { display: flex; gap: 16px; font-size: 0.9rem; }
.topbar-links a { color: var(--text-dim); transition: color 0.15s; }
.topbar-links a:hover { color: var(--accent); text-decoration: none; }

/* ---- Docs layout (sidebar + main) ---- */
.docs-layout {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  gap: 40px;
  max-width: var(--layout-max);
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.docs-layout > main {
  min-width: 0;
}

.sidebar {
  position: sticky;
  top: 64px;
  align-self: start;
  font-size: 0.93rem;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  padding: 4px 0 8px;
}
.sidebar-label {
  font-family: "Space Grotesk", sans-serif;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 8px;
  padding: 4px 10px;
}
.sidebar ul { list-style: none; }
.sidebar li { margin-bottom: 1px; }
.sidebar a {
  display: block;
  padding: 6px 10px 6px 12px;
  color: var(--text-dim);
  border-left: 2px solid transparent;
  border-radius: 0 6px 6px 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.sidebar a:hover {
  color: var(--text);
  background: var(--bg-surface);
  text-decoration: none;
}
.sidebar a.active {
  color: var(--accent);
  background: var(--bg-card);
  border-left-color: var(--accent);
}

/* ---- TOC ---- */
.toc {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 20px;
  margin-bottom: 32px;
}
.toc-label {
  font-family: "Space Grotesk", sans-serif;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.toc ul { list-style: none; }
.toc li { font-size: 0.92rem; padding: 2px 0; }
.toc li.depth-3 { padding-left: 20px; font-size: 0.88rem; }
.toc a { color: var(--text-dim); }
.toc a:hover { color: var(--accent); text-decoration: none; }

/* ---- Content ---- */
.content h1 {
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.content h2 {
  font-size: 1.4rem;
  font-weight: 700;
  margin: 36px 0 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.content h2:first-child { border-top: none; padding-top: 0; margin-top: 0; }
.content h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--accent);
  margin: 24px 0 8px;
}
.content h4 {
  font-size: 1rem;
  font-weight: 600;
  margin: 20px 0 6px;
}
.content p { margin-bottom: 14px; color: var(--text-dim); }
.content ul, .content ol { margin: 0 0 14px 22px; color: var(--text-dim); }
.content li { margin-bottom: 4px; }
.content li > ul, .content li > ol { margin-top: 4px; margin-bottom: 4px; }
.content strong { color: var(--text); }
.content em { color: var(--text); }
.content blockquote {
  border-left: 3px solid var(--accent);
  background: rgba(80, 184, 108, 0.06);
  padding: 8px 14px;
  margin: 12px 0;
  color: var(--text-dim);
  border-radius: 0 6px 6px 0;
}
.content blockquote p { margin: 0; }
.content code {
  font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 0.86em;
  color: var(--text);
}
.content pre {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 18px;
  overflow-x: auto;
  margin: 12px 0 18px;
  line-height: 1.55;
}
.content pre code {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 0.86em;
  color: var(--accent);
}
.content table {
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 0.92rem;
}
.content th, .content td {
  border: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
}
.content th { background: var(--bg-surface); }
.content img { max-width: 100%; border-radius: 6px; margin: 12px 0; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }

.anchor-link {
  margin-left: 8px;
  color: var(--border);
  font-weight: 400;
  font-size: 0.8em;
  opacity: 0;
  transition: opacity 0.15s;
}
.content h2:hover .anchor-link,
.content h3:hover .anchor-link,
.content h4:hover .anchor-link { opacity: 1; }
.anchor-link:hover { color: var(--accent); text-decoration: none; }

/* ---- Prev/next footer ---- */
.doc-nav {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
.doc-nav-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 18px;
  color: var(--text);
  transition: border-color 0.15s;
}
.doc-nav-card:hover {
  border-color: var(--accent);
  text-decoration: none;
}
.doc-nav-card.next { text-align: right; }
.doc-nav-card .doc-nav-dir {
  font-size: 0.78rem;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
}
.doc-nav-card .doc-nav-title {
  font-family: "Space Grotesk", sans-serif;
  font-weight: 600;
  font-size: 1rem;
  color: var(--accent);
}

footer.site-footer {
  max-width: var(--layout-max);
  margin: 32px auto 0;
  padding: 24px;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 0.85rem;
}
.footer-feedback {
  text-align: center;
  margin-bottom: 14px;
}
.footer-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
footer.site-footer .footer-links { display: flex; gap: 18px; }

@media (max-width: 900px) {
  .docs-layout {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 24px 16px 48px;
  }
  .sidebar {
    position: static;
    max-height: none;
    overflow-y: visible;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }
  .topbar-inner { padding: 10px 16px; gap: 12px; }
  .topbar-links { gap: 12px; }
  .content h1 { font-size: 1.6rem; }
  .content h2 { font-size: 1.2rem; }
  .doc-nav { grid-template-columns: 1fr; }
  .doc-nav-card.next { text-align: left; }
  .footer-bottom { flex-direction: column; gap: 10px; text-align: center; }
}
`;

const FAVICON_HREF =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><polygon points='2,10 16,18 16,30 2,22' fill='%23209050'/><polygon points='30,10 16,18 16,30 30,22' fill='%23186840'/><polygon points='16,8 24,12.5 16,17 8,12.5' fill='%230d1117'/><text x='16' y='14.5' text-anchor='middle' font-size='6' font-family='monospace' font-weight='bold' fill='%23E6F5EC'>%3E_</text><polygon points='16,2 2,10 8,12.5 16,8' fill='%233AC874'/><polygon points='16,2 30,10 24,12.5 16,8' fill='%234BE88A'/><polygon points='2,10 16,18 16,17 8,12.5' fill='%2330B76A'/><polygon points='30,10 16,18 16,17 24,12.5' fill='%2341D57E'/></svg>";

function renderSidebar(pages: DocPage[], currentSlug: string): string {
  const items = pages
    .map((p) => {
      const url = pageUrl(p);
      const cls = p.slug === currentSlug ? "active" : "";
      return `<li><a class="${cls}" href="${url}">${escapeHtml(p.navTitle)}</a></li>`;
    })
    .join("");
  return `<aside class="sidebar">
  <div class="sidebar-label">Docs</div>
  <ul>${items}</ul>
</aside>`;
}

function htmlShell(opts: {
  title: string;
  description: string;
  crumb?: string;
  body: string;
  docContext: string;
}): string {
  const desc = escapeHtml(opts.description);
  const title = escapeHtml(opts.title);
  const crumb = opts.crumb
    ? `<span class="topbar-crumb">${escapeHtml(opts.crumb)}</span>`
    : "";
  const contextScript = `<script>window.__docContext = ${jsStringLiteral(opts.docContext)};</script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} · Isomux docs</title>
<meta name="description" content="${desc}" />
<link rel="icon" href="${FAVICON_HREF}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${title} · Isomux docs" />
<meta property="og:description" content="${desc}" />
<meta property="og:site_name" content="Isomux" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${title} · Isomux docs" />
<meta name="twitter:description" content="${desc}" />
<meta name="theme-color" content="#0a0e16" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#f4f6f9" media="(prefers-color-scheme: light)" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/docs/_styles.css" />
<link rel="stylesheet" href="/chatbot.css" />
<!-- Pre-paint theme resolution. If the user picked a theme (here, on the
     landing, or inside the app), apply it before paint so the page doesn't
     flash the wrong palette. With no saved pick, the @media block in the
     stylesheet takes over. Mirrors site/theme-toggle.js. -->
<script>
(function () {
  try {
    var saved = localStorage.getItem("isomux-theme");
    if (saved) {
      document.documentElement.setAttribute("data-theme", saved);
      var lightIds = ["light", "solarized-light"];
      document.documentElement.setAttribute(
        "data-theme-mode",
        lightIds.indexOf(saved) >= 0 ? "light" : "dark",
      );
    }
  } catch (e) {}
})();
</script>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <a class="topbar-brand" href="/">Isomux</a>
    <a class="topbar-crumb" href="/docs">docs</a>
    ${crumb}
    <div class="topbar-spacer"></div>
    <div class="topbar-links">
      <a href="https://github.com/nmamano/isomux" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</div>
${opts.body}
<footer class="site-footer">
  <p class="footer-feedback">
    Questions or feedback? Ask in the
    <a href="https://discord.gg/FrjEYyNvYs" target="_blank" rel="noopener">Discord</a>
    or message Nil on
    <a href="https://www.linkedin.com/in/nilmamano/" target="_blank" rel="noopener">LinkedIn</a>
    or
    <a href="https://x.com/Nil053" target="_blank" rel="noopener">X</a>.
  </p>
  <div class="footer-bottom">
    <span>Isomux</span>
    <div class="footer-links">
      <a href="/">isomux.com</a>
      <a href="https://github.com/nmamano/isomux" target="_blank" rel="noopener">GitHub</a>
      <a href="https://nilmamano.com/blog/isomux" target="_blank" rel="noopener">Blog post</a>
    </div>
  </div>
</footer>
<div id="chat-widget"></div>
${contextScript}
<script defer src="/theme-toggle.js"></script>
<script defer src="/chatbot.js"></script>
</body>
</html>
`;
}

function renderTocHtml(toc: TocItem[]): string {
  if (toc.length < 2) return "";
  const items = toc
    .map(
      (t) =>
        `<li class="depth-${t.depth}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`,
    )
    .join("");
  return `<nav class="toc"><div class="toc-label">On this page</div><ul>${items}</ul></nav>`;
}

function renderDocPage(
  page: DocPage,
  pages: DocPage[],
  prev: DocPage | null,
  next: DocPage | null,
): string {
  const tocHtml = renderTocHtml(page.toc);
  // Insert TOC just after the page's H1 so it reads "title → on this page → body".
  // Fall back to TOC-first if there's no H1 in the body.
  const articleHtml = (() => {
    if (!tocHtml) return page.html;
    const h1Close = page.html.indexOf("</h1>");
    if (h1Close === -1) return `${tocHtml}\n${page.html}`;
    const insertAt = h1Close + "</h1>".length;
    return `${page.html.slice(0, insertAt)}\n${tocHtml}\n${page.html.slice(insertAt)}`;
  })();
  const prevCard = prev
    ? `<a class="doc-nav-card prev" href="${pageUrl(prev)}"><div class="doc-nav-dir">&larr; Previous</div><div class="doc-nav-title">${escapeHtml(prev.title)}</div></a>`
    : `<div></div>`;
  const nextCard = next
    ? `<a class="doc-nav-card next" href="${pageUrl(next)}"><div class="doc-nav-dir">Next &rarr;</div><div class="doc-nav-title">${escapeHtml(next.title)}</div></a>`
    : `<div></div>`;
  const sidebar = renderSidebar(pages, page.slug);
  const body = `<div class="docs-layout">
${sidebar}
<main>
<article class="content">
${articleHtml}
</article>
<nav class="doc-nav">
  ${prevCard}
  ${nextCard}
</nav>
</main>
</div>`;
  return htmlShell({
    title: page.title,
    description: page.description,
    crumb: page.slug === LANDING_SLUG ? undefined : page.title,
    body,
    docContext: page.raw,
  });
}

// ---- Main ----

function main() {
  if (!existsSync(SRC_DIR)) {
    throw new Error(`Source directory "${SRC_DIR}" not found.`);
  }
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".md"));
  const pages = files.map(loadPage).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });
  if (!pages.some((p) => p.slug === LANDING_SLUG)) {
    throw new Error(
      `Landing slug "${LANDING_SLUG}" not found in docs/ — every build needs ${LANDING_SLUG}.md.`,
    );
  }

  writeFileSync(join(OUT_DIR, "_styles.css"), STYLES.trim() + "\n");

  for (let i = 0; i < pages.length; i++) {
    const prev = i > 0 ? pages[i - 1] : null;
    const next = i < pages.length - 1 ? pages[i + 1] : null;
    const html = renderDocPage(pages[i], pages, prev, next);
    if (pages[i].slug === LANDING_SLUG) {
      // The landing page lives at `/docs/` (not `/docs/<slug>/`).
      writeFileSync(join(OUT_DIR, "index.html"), html);
    } else {
      // Directory-style output (`<slug>/index.html`) so any static server
      // resolves the clean `/docs/<slug>` URL without relying on Vercel's
      // `cleanUrls` for local previews.
      const pageDir = join(OUT_DIR, pages[i].slug);
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, "index.html"), html);
    }
  }

  console.log(
    `built ${pages.length} doc pages → ${OUT_DIR}/ (${pages.map((p) => p.slug).join(", ")})`,
  );
}

main();
