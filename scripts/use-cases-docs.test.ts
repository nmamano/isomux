import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Window } from "happy-dom";
import {
  STATIC_PATHS,
  main as buildDocs,
  rewriteMarkdownLinks,
} from "./build-docs.ts";

// The Use cases section of the docs (task 30666e83): an index and one page
// per use case, each built from docs/use-cases/<name>.md.
const INDEX = "/docs/use-cases";
// The old standalone pages, and where links to them land now.
const MOVED: Record<string, string> = {
  "/use-cases": INDEX,
  "/use-cases/parallel-agents": "/docs/use-cases-parallel-agents",
  "/use-cases/phone": "/docs/use-cases-phone",
};

const builtFile = (path: string) =>
  path === "/docs" ? "site/docs/index.html" : `site${path}/index.html`;
// Each served file is parsed once for the whole file, then closed at the end.
const windows = new Map<string, Window>();
function parseFile(file: string): Window {
  let window = windows.get(file);
  if (!window) {
    window = new Window({
      settings: {
        disableJavaScriptEvaluation: true,
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
      },
    });
    window.document.write(readFileSync(file, "utf8"));
    windows.set(file, window);
  }
  return window;
}
const docAt = (path: string) => parseFile(builtFile(path)).document;

// The use-case pages in the order the index lists them: the index is the
// oracle, and the sources, the sidebar and llms.txt must agree with it.
let PAGES: string[] = [];
beforeAll(() => {
  buildDocs();
  PAGES = Array.from(
    docAt(INDEX).querySelectorAll("article a[href]"),
    (a) => new URL(a.getAttribute("href")!, "https://isomux.com").pathname,
  ).filter((path) => path.startsWith(`${INDEX}-`));
});
afterAll(() =>
  Promise.all(Array.from(windows.values(), (w) => w.happyDOM.close())),
);

// The file isomux.com serves at a path: a built docs page, a site file under
// cleanUrls, or the file an exact vercel.json rewrite names. build:demo writes
// /demo (gitignored), so a fresh checkout may not have it; its fragments are
// not checked.
const DEMO = "site/demo/index.html";
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8"));
const REWRITES = new Map<string, string>(
  (VERCEL.rewrites as { source: string; destination: string }[])
    .filter(({ source }) => !source.includes(":"))
    .map(({ source, destination }) => [source, destination]),
);
function servedFile(requested: string): string | null {
  const path = REWRITES.get(requested) ?? requested;
  if (path === "/demo") return DEMO;
  const candidates = /^\/docs(\/|$)/.test(path)
    ? [builtFile(path)]
    : [`site${path}.html`, `site${path}/index.html`, `site${path}`];
  return (
    candidates.find((file) => existsSync(file) && statSync(file).isFile()) ??
    null
  );
}
function builtDocsPaths(): string[] {
  return [
    "/docs",
    ...readdirSync("site/docs", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/docs/${entry.name}`),
  ];
}

describe("use cases in the docs", () => {
  it("builds the index and one page per source file, each listed once on the index and with agent Markdown", () => {
    const sources = readdirSync("docs/use-cases")
      .filter((file) => file.endsWith(".md"))
      .map((file) => `/docs/use-cases-${file.slice(0, -3)}`);
    expect(sources.length).toBeGreaterThan(0);
    expect([...PAGES].sort()).toEqual(sources.sort());
    for (const path of [INDEX, ...PAGES]) {
      const doc = docAt(path);
      expect(doc.querySelectorAll("article h1").length, path).toBe(1);
      expect(
        doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      ).toBe(`https://isomux.com${path}`);
      expect(existsSync(`site/_agent${path}/index.md`), path).toBe(true);
    }
  });

  it("nests the use cases under their index in every docs sidebar, and marks the current page", () => {
    for (const path of builtDocsPaths()) {
      const nav = docAt(path).querySelector(
        '.sidebar nav[aria-label="Documentation"]',
      )!;
      const topLevel = Array.from(
        nav.querySelectorAll(":scope > ul > li > a"),
        (a) => a.getAttribute("href"),
      );
      expect(topLevel, path).toContain(INDEX);
      for (const page of PAGES) expect(topLevel, path).not.toContain(page);
      const item = Array.from(nav.querySelectorAll(":scope > ul > li")).find(
        (li) => li.querySelector(":scope > a")?.getAttribute("href") === INDEX,
      )!;
      expect(
        Array.from(item.querySelectorAll(".sidebar-subpages a"), (a) =>
          a.getAttribute("href"),
        ),
        path,
      ).toEqual(PAGES);
      const current = nav.querySelectorAll('a[aria-current="page"]');
      expect(current.length, path).toBe(1);
      expect(current[0].getAttribute("href"), path).toBe(path);
    }
  });

  it("keeps the use cases out of the previous and next cards", () => {
    const paths = builtDocsPaths();
    for (const page of PAGES) expect(paths).toContain(page);
    for (const path of paths) {
      const cards = Array.from(
        docAt(path).querySelectorAll(".doc-nav-card"),
        (a) => a.getAttribute("href"),
      );
      if (PAGES.includes(path)) expect(cards, path).toEqual([]);
      for (const page of PAGES) expect(cards, path).not.toContain(page);
    }
  });

  it("links each post page to its post and shows the post's diagram in a light and a dark variant", () => {
    // A post page is one that shows a post's diagram.
    const posts = PAGES.filter(
      (path) =>
        docAt(path).querySelector(
          "article .diagram-light, article .diagram-dark",
        ) !== null,
    );
    expect(posts.length).toBeGreaterThan(0);
    for (const path of posts) {
      const article = docAt(path).querySelector("article")!;
      const links = Array.from(
        article.querySelectorAll("a[href]"),
        (a) => a.getAttribute("href")!,
      );
      expect(
        links.some((href) => /^https:\/\/(?!isomux\.com\/)/.test(href)),
        path,
      ).toBe(true);
      const variants = [".diagram-light", ".diagram-dark"].map((selector) => {
        const imgs = article.querySelectorAll(`img${selector}`);
        expect(imgs.length, `${path} ${selector}`).toBe(1);
        const img = imgs[0];
        const src = img.getAttribute("src")!;
        expect(src.endsWith(".svg"), src).toBe(true);
        expect(existsSync(`site${src}`), src).toBe(true);
        expect(img.getAttribute("alt")?.trim(), src).toBeTruthy();
        // The shown size keeps the drawing's aspect ratio.
        const viewBox = readFileSync(`site${src}`, "utf8")
          .match(/<svg[^>]*\sviewBox="([^"]+)"/)![1]
          .trim()
          .split(/\s+/)
          .map(Number);
        const size = [
          Number(img.getAttribute("width")),
          Number(img.getAttribute("height")),
        ];
        expect(size, src).toEqual([viewBox[2], viewBox[3]]);
        return { src, size };
      });
      expect(variants[0].src, path).not.toBe(variants[1].src);
      expect(variants[0].size, path).toEqual(variants[1].size);
    }
  });

  it("shows every use-case screenshot at its size, and none is missing", () => {
    const shown = new Set<string>();
    for (const path of PAGES) {
      for (const img of docAt(path).querySelectorAll("article img")) {
        const src = img.getAttribute("src")!;
        if (!src.endsWith(".jpeg")) continue;
        expect(existsSync(`site${src}`), src).toBe(true);
        expect(Number(img.getAttribute("width")), src).toBeGreaterThan(0);
        expect(Number(img.getAttribute("height")), src).toBeGreaterThan(0);
        expect(img.getAttribute("alt")?.trim(), src).toBeTruthy();
        shown.add(src);
      }
    }
    const screenshots = readdirSync("site/use-cases")
      .filter((file) => file.endsWith(".jpeg"))
      .map((file) => `/use-cases/${file}`);
    expect(screenshots.length).toBeGreaterThan(0);
    expect([...shown].sort()).toEqual(screenshots.sort());
  });

  it("redirects the old URLs permanently to the new pages, and the old pages are gone", () => {
    for (const [source, destination] of Object.entries(MOVED)) {
      const redirect = VERCEL.redirects.find(
        (r: { source: string }) => r.source === source,
      );
      expect(redirect, source).toBeDefined();
      expect(redirect.destination, source).toBe(destination);
      expect(redirect.permanent, source).toBe(true);
      expect(existsSync(builtFile(destination)), destination).toBe(true);
      expect(existsSync(`site${source}.html`), source).toBe(false);
      expect(existsSync(`site${source}/index.html`), source).toBe(false);
    }
    expect(
      readdirSync("site/use-cases").filter((file) => file.endsWith(".html")),
    ).toEqual([]);
  });

  it("lists the use-case pages in the sitemap and llms.txt instead of the old URLs", () => {
    const sitemap = readFileSync("site/sitemap.xml", "utf8");
    const llms = readFileSync("site/llms.txt", "utf8");
    for (const path of [INDEX, ...PAGES])
      expect(sitemap, path).toContain(`<loc>https://isomux.com${path}</loc>`);
    const listed = [...llms.matchAll(/\(https:\/\/isomux\.com([^)#]+)\)/g)]
      .map((match) => match[1])
      .filter((path) => path.startsWith(`${INDEX}`));
    expect(listed).toEqual([INDEX, ...PAGES]);
    for (const old of Object.keys(MOVED)) {
      expect(sitemap).not.toContain(`<loc>https://isomux.com${old}</loc>`);
      expect(STATIC_PATHS).not.toContain(old);
    }
    expect(llms).not.toMatch(/isomux\.com\/use-cases\b/);
  });

  it("links Docs and Use cases from every site footer, and no page links an old URL", async () => {
    const footerPages: string[] = [];
    for await (const file of new Bun.Glob("site/**/*.html").scan(".")) {
      const doc = parseFile(file).document;
      for (const a of doc.querySelectorAll("a[href]")) {
        const path = new URL(a.getAttribute("href")!, "https://isomux.com")
          .pathname;
        expect(Object.keys(MOVED), `${file}: ${path}`).not.toContain(
          path.replace(/\/$/, ""),
        );
      }
      const columns = doc.querySelector("footer.site-footer .footer-columns");
      if (columns) {
        footerPages.push(file);
        const hrefs = Array.from(columns.querySelectorAll("a[href]"), (a) =>
          a.getAttribute("href"),
        );
        expect(hrefs, file).toContain("/docs");
        expect(hrefs, file).toContain(INDEX);
      }
    }
    for (const file of [
      "site/index.html",
      "site/es/index.html",
      "site/ca/index.html",
      "site/zh/index.html",
      "site/hosted.html",
      "site/compare.html",
    ])
      expect(footerPages).toContain(file);
  });

  it("rewrites links into and out of the use-case sources to docs URLs", () => {
    expect(
      rewriteMarkdownLinks(
        "[a](use-cases.md) [b](use-cases/phone.md) [c](docs/use-cases/one-project.md#start) [d](https://github.com/nmamano/isomux/blob/main/docs/use-cases/parallel-agents.md) [e](../features.md#agent-coordination) [f](../access-and-invites.md)",
      ),
    ).toBe(
      "[a](/docs/use-cases) [b](/docs/use-cases-phone) [c](/docs/use-cases-one-project#start) [d](/docs/use-cases-parallel-agents) [e](/docs#agent-coordination) [f](/docs/access-and-invites)",
    );
  });
});

describe("every built docs page", () => {
  // The one link check for the docs: build-docs.ts only refuses a link to an
  // unbuilt docs page, and checks no fragment and no other site file.
  it("resolves every local link, fragment included, and repeats no id", () => {
    let checked = 0;
    for (const path of builtDocsPaths()) {
      const doc = docAt(path);
      const ids = Array.from(doc.querySelectorAll("[id]"), (e) => e.id);
      expect(new Set(ids).size, path).toBe(ids.length);
      for (const a of doc.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href")!;
        if (/^(https?:|mailto:)/.test(href)) continue;
        const link = `${path} -> ${href}`;
        // A relative href means a source link the build did not rewrite.
        expect(href.startsWith("/") || href.startsWith("#"), link).toBe(true);
        const url = new URL(href, `https://isomux.com${path}`);
        const file = servedFile(url.pathname);
        expect(file, link).not.toBeNull();
        checked++;
        const id = decodeURIComponent(url.hash.slice(1));
        if (!id || file === DEMO) continue;
        expect(parseFile(file!).document.getElementById(id)?.id, link).toBe(id);
      }
      // The agent Markdown carries the same rewritten links.
      const markdown = readFileSync(`site/_agent${path}/index.md`, "utf8");
      expect(
        markdown.match(/\]\((?!https?:|mailto:|\/|#)[^)]*\)/g),
        path,
      ).toBeNull();
    }
    // Proves the reader found links at all: every page has a sidebar.
    expect(checked).toBeGreaterThan(builtDocsPaths().length);
  });
});
