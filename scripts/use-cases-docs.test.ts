import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Window } from "happy-dom";
import {
  STATIC_PATHS,
  main as buildDocs,
  rewriteMarkdownLinks,
} from "./build-docs.ts";
import middleware from "../middleware.ts";

beforeAll(() => buildDocs());

// The Use cases section of the docs (task 30666e83): an index and one page
// per use case, each built from docs/use-cases/<name>.md. The pages from Nil's
// blog posts lead the section (task f575978d).
const INDEX = "/docs/use-cases";
const POSTS: Record<string, string> = {
  "/docs/use-cases-agents-for-normies":
    "https://nilmamano.com/blog/isomux-enterprise",
  "/docs/use-cases-ai-native": "https://nilmamano.com/blog/isomux-crews",
  "/docs/use-cases-personal-app-store":
    "https://nilmamano.com/blog/personal-software-suites",
};
// In the order the index, the sidebar and llms.txt list them.
const PAGES = [
  ...Object.keys(POSTS),
  "/docs/use-cases-parallel-agents",
  "/docs/use-cases-phone",
  "/docs/use-cases-one-project",
];
// The old standalone pages, and where links to them land now.
const MOVED: Record<string, string> = {
  "/use-cases": INDEX,
  "/use-cases/parallel-agents": "/docs/use-cases-parallel-agents",
  "/use-cases/phone": "/docs/use-cases-phone",
};

const builtFile = (path: string) =>
  path === "/docs" ? "site/docs/index.html" : `site${path}/index.html`;
const htmlAt = (path: string) => readFileSync(builtFile(path), "utf8");
function parse(html: string) {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  window.document.write(html);
  return window;
}
// The file isomux.com serves at a path: a built docs page, or a site file
// under cleanUrls. build:demo writes /demo (gitignored), so a fresh checkout
// may not have it; its fragments are not checked.
const DEMO = "site/demo/index.html";
function servedFile(path: string): string | null {
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
  it("builds the index and one page per source file, each with negotiated Markdown", async () => {
    const sources = readdirSync("docs/use-cases")
      .filter((file) => file.endsWith(".md"))
      .map((file) => `/docs/use-cases-${file.slice(0, -3)}`);
    expect(sources.sort()).toEqual([...PAGES].sort());
    for (const path of [INDEX, ...PAGES]) {
      const window = parse(htmlAt(path));
      const doc = window.document;
      expect(doc.querySelectorAll("article h1").length, path).toBe(1);
      expect(
        doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      ).toBe(`https://isomux.com${path}`);
      expect(existsSync(`site/_agent${path}/index.md`), path).toBe(true);
      const response = middleware(
        new Request(`https://isomux.com${path}`, {
          headers: { Accept: "text/markdown" },
        }),
      );
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        `https://isomux.com/_agent${path}/index.md`,
      );
      await window.happyDOM.close();
    }
  });

  it("nests the use cases under their index in every docs sidebar, and marks the current page", async () => {
    for (const path of builtDocsPaths()) {
      const window = parse(htmlAt(path));
      const nav = window.document.querySelector(
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
      await window.happyDOM.close();
    }
  });

  it("keeps the use cases out of the previous and next cards", async () => {
    const paths = builtDocsPaths();
    for (const page of PAGES) expect(paths).toContain(page);
    for (const path of paths) {
      const window = parse(htmlAt(path));
      const cards = Array.from(
        window.document.querySelectorAll(".doc-nav-card"),
        (a) => a.getAttribute("href"),
      );
      if (PAGES.includes(path)) expect(cards, path).toEqual([]);
      for (const page of PAGES) expect(cards, path).not.toContain(page);
      await window.happyDOM.close();
    }
  });

  it("links every use case from the index, in order", async () => {
    const window = parse(htmlAt(INDEX));
    const links = Array.from(
      window.document.querySelectorAll("article a[href]"),
      (a) => a.getAttribute("href")!,
    );
    expect(links.filter((href) => PAGES.includes(href))).toEqual(PAGES);
    await window.happyDOM.close();
  });

  it("links each post page to its post and shows the post's diagram in a light and a dark variant", async () => {
    for (const [path, post] of Object.entries(POSTS)) {
      const window = parse(htmlAt(path));
      const article = window.document.querySelector("article")!;
      const links = Array.from(article.querySelectorAll("a[href]"), (a) =>
        a.getAttribute("href"),
      );
      expect(links, path).toContain(post);
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
      await window.happyDOM.close();
    }
  });

  it("resolves every link on the use-case pages, fragment included", async () => {
    for (const path of [INDEX, ...PAGES]) {
      const window = parse(htmlAt(path));
      for (const a of window.document.querySelectorAll("article a[href]")) {
        const href = a.getAttribute("href")!;
        if (/^(https?:|mailto:)/.test(href)) continue;
        // A relative href means a source link the build did not rewrite.
        expect(href.startsWith("/") || href.startsWith("#"), href).toBe(true);
        const url = new URL(href, `https://isomux.com${path}`);
        const file = servedFile(url.pathname);
        expect(file, href).not.toBeNull();
        const id = url.hash.slice(1);
        if (!id || file === DEMO) continue;
        const target = parse(readFileSync(file!, "utf8"));
        expect(target.document.getElementById(id)?.id, href).toBe(id);
        await target.happyDOM.close();
      }
      // The agent Markdown carries the same rewritten links.
      const markdown = readFileSync(`site/_agent${path}/index.md`, "utf8");
      expect(
        markdown.match(/\]\((?!https?:|mailto:|\/|#)[^)]*\)/g),
        path,
      ).toBeNull();
      await window.happyDOM.close();
    }
  });

  it("shows every use-case screenshot at its size, and none is missing", async () => {
    const shown = new Set<string>();
    for (const path of PAGES) {
      const window = parse(htmlAt(path));
      for (const img of window.document.querySelectorAll("article img")) {
        const src = img.getAttribute("src")!;
        if (!src.endsWith(".jpeg")) continue;
        expect(existsSync(`site${src}`), src).toBe(true);
        expect(Number(img.getAttribute("width")), src).toBeGreaterThan(0);
        expect(Number(img.getAttribute("height")), src).toBeGreaterThan(0);
        expect(img.getAttribute("alt")?.trim(), src).toBeTruthy();
        shown.add(src);
      }
      await window.happyDOM.close();
    }
    const screenshots = readdirSync("site/use-cases")
      .filter((file) => file.endsWith(".jpeg"))
      .map((file) => `/use-cases/${file}`);
    expect(screenshots.length).toBeGreaterThan(0);
    expect([...shown].sort()).toEqual(screenshots.sort());
  });

  it("drops Several agents on one project from the features page and keeps its old fragment", async () => {
    const page = "/docs/use-cases-one-project";
    const html = htmlAt("/docs");
    const window = parse(html);
    const doc = window.document;
    // A scalar, not the element: a failing DOM-node match serialises the page.
    expect(
      doc.getElementById("several-agents-on-one-project")?.tagName ?? null,
    ).toBeNull();
    // The page lives in Use cases only (sign-off, task dd8f1c78): the
    // features article does not link it, with or without a fragment.
    const links = Array.from(
      doc.querySelectorAll("article a[href]"),
      (a) =>
        new URL(a.getAttribute("href")!, "https://isomux.com/docs").pathname,
    );
    expect(links.length).toBeGreaterThan(0);
    expect(links).not.toContain(page);
    const map = doc.getElementById("legacy-fragment-map");
    expect(map).not.toBeNull();
    expect(JSON.parse(map!.textContent!)["several-agents-on-one-project"]).toBe(
      page,
    );
    expect(html).toContain('src="/legacy-links.js"');
    await window.happyDOM.close();
  });

  it("redirects the old URLs permanently to the new pages, and the old pages are gone", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    for (const [source, destination] of Object.entries(MOVED)) {
      const redirect = vercel.redirects.find(
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
      const text = readFileSync(file, "utf8");
      const window = parse(text);
      const doc = window.document;
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
      await window.happyDOM.close();
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
