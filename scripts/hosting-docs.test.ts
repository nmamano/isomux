import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";
import {
  LEGACY_LINKS,
  main as buildDocs,
  rewriteMarkdownLinks,
} from "./build-docs.ts";
import {
  HOSTING_GUIDES,
  composeHostingSource,
  hostingUrl,
} from "./hosting-docs.ts";

beforeAll(() => buildDocs());
const htmlAt = (path: string) => readFileSync(`site${path}/index.html`, "utf8");
// Each built page is parsed once for the whole file, then closed at the end.
const windows = new Map<string, Window>();
function docAt(path: string) {
  let window = windows.get(path);
  if (!window) {
    window = new Window({
      settings: {
        disableJavaScriptEvaluation: true,
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
      },
    });
    window.document.write(htmlAt(path));
    windows.set(path, window);
  }
  return window.document;
}
afterAll(() =>
  Promise.all(Array.from(windows.values(), (w) => w.happyDOM.close())),
);

describe("complete hosting guides", () => {
  it("shows the hosting hierarchy in the sidebar of the index and every guide", () => {
    const paths = [
      "/docs/hosting",
      ...HOSTING_GUIDES.map((guide) => hostingUrl(guide.id)),
    ];
    for (const path of paths) {
      const sidebar = docAt(path).querySelector(
        '.sidebar nav[aria-label="Documentation"]',
      )!;
      const hosting = Array.from(
        sidebar.querySelectorAll(":scope > ul > li"),
      ).find(
        (li) =>
          li.querySelector(":scope > a")?.getAttribute("href") ===
          "/docs/hosting",
      )!;
      expect(
        Array.from(hosting.querySelectorAll(".sidebar-subpages a"), (link) =>
          link.getAttribute("href"),
        ),
      ).toEqual(HOSTING_GUIDES.map((guide) => hostingUrl(guide.id)));
    }
  });

  it("gives each flow leaf its unique guide destination", () => {
    const doc = docAt("/docs/hosting");
    const links = Array.from(
      doc.querySelectorAll(".hosting-flow a[data-guide]"),
    );
    // The flow is written by hand: a guide it forgets is the regression.
    expect(links.map((a) => a.getAttribute("data-guide")).sort()).toEqual(
      HOSTING_GUIDES.map((guide) => guide.id).sort(),
    );
    for (const link of links)
      expect(link.getAttribute("href")).toBe(
        `/docs/hosting-${link.getAttribute("data-guide")}`,
      );
    // The index is no guide's page, so no leaf is marked current.
    expect(doc.querySelectorAll(".hosting-flow [aria-current]").length).toBe(0);
  });

  it("renders one complete guide and matching chatbot and negotiated Markdown per identity", async () => {
    for (const guide of HOSTING_GUIDES) {
      const path = hostingUrl(guide.id);
      const html = htmlAt(path);
      const doc = docAt(path);
      expect(doc.querySelectorAll(".hosting-flow").length, path).toBe(0);
      expect(
        doc.querySelector(".hosting-guide-notice a")?.getAttribute("href"),
        path,
      ).toBe("/docs/hosting");
      expect(doc.querySelectorAll("article h1").length, path).toBe(1);
      expect(
        doc.querySelectorAll("article pre").length +
          doc.querySelectorAll("article ol").length,
        path,
      ).toBeGreaterThan(0);
      const markdown = readFileSync(`site/_agent${path}/index.md`, "utf8");
      expect(markdown.includes("<!-- include:"), path).toBe(false);
      expect(markdown.match(/^# /gm)?.length, path).toBe(1);
      const context = html.match(/window\.__docContext = ("(?:[^"\\]|\\.)*");/);
      expect(context, path).not.toBeNull();
      const raw = JSON.parse(context![1]) as string;
      expect(raw.length, path).toBeLessThanOrEqual(20_000);
      // Compare the entire composed body, allowing only the public-link rewrite.
      expect(rewriteMarkdownLinks(raw), path).toBe(markdown);
      expect(
        doc.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      ).toBe(`https://isomux.com${path}`);
    }
  });

  it("keeps shared prerequisites inline and the AWS commands from the canonical README", () => {
    const install = readFileSync(
      "docs/hosting/blocks/install.md",
      "utf8",
    ).trim();
    const sharing = HOSTING_GUIDES.filter((guide) =>
      readFileSync(guide.source, "utf8").includes("<!-- include: install -->"),
    );
    expect(sharing.length).toBeGreaterThan(0);
    for (const { id } of sharing) {
      const markdown = readFileSync(
        `site/_agent/docs/hosting-${id}/index.md`,
        "utf8",
      );
      expect(markdown, id).toContain(
        install.replaceAll(
          "](hosting-reference.md",
          "](/docs/hosting-reference",
        ),
      );
    }
    const source = readFileSync("deploy/container/README.md", "utf8");
    const aws = readFileSync("site/_agent/docs/hosting-aws/index.md", "utf8");
    const fences = source.match(/```[\s\S]*?```/g)!;
    expect(fences.length).toBeGreaterThan(10);
    for (const block of fences) expect(aws).toContain(block);
    expect(existsSync("docs/hosting/aws.md")).toBe(false);
    expect(existsSync("site/docs/install")).toBe(false);
    expect(() => composeHostingSource("<!-- include: unknown -->")).toThrow();
  });

  // Public old fragments: bookmarks and released offices link to them, so
  // removing one strands a reader. Adding one needs no edit here.
  it("retains the old public fragment contract", () => {
    const fragments: Record<string, string[]> = {
      features: ["several-agents-on-one-project"],
      hosting: [
        "self-hosted-setup",
        "vps-install",
        "run-the-installer",
        "what-the-installer-does",
        "root-access",
        "parameters",
        "re-running",
        "updating",
        "app-hostnames",
        "opening-an-agents-dev-server",
        "notes",
        "desktop-chrome-extension",
        "your-own-hardware",
        "native-build-recovery",
        "keep-the-server-running",
        "make-the-office-reachable",
        "your-devices-and-anyone-willing-to-install-tailscale",
        "other-members-public-url",
        "install-on-mobile-pwa",
        "enable-https-for-voice-input-and-android-pwa-install",
        "authorize-members",
        "provider-api-keys",
        "deploy-a-container",
        "deploy-on-render",
        "backups",
        "running-out-of-memory",
        "what-each-deployment-covers",
        "proxy-and-real-domain",
        "proxy-and-no-real-domain",
        "no-proxy-and-no-real-domain",
      ],
      "access-and-invites": [
        "use-your-own-provider-account",
        "claude-on-amazon-bedrock",
        "connection-variables-and-directories",
        "personal-api-tokens",
        "state-files",
        "cookie-semantics",
        "bootstrap-window-exposure",
        "trust-model-boundaries",
        "operating-notes",
        "lobby-and-members-chat",
      ],
      "hosting-reference": ["desktop-chrome-extension", "provider-api-keys"],
    };
    for (const [slug, kept] of Object.entries(fragments))
      expect(Object.keys(LEGACY_LINKS[slug] ?? {}), slug).toEqual(
        expect.arrayContaining(kept),
      );
  });

  it("keeps availability notices ahead of setup navigation", () => {
    const noticed = HOSTING_GUIDES.filter((guide) => "notice" in guide);
    expect(noticed.length).toBeGreaterThan(0);
    for (const { id } of noticed) {
      const article = docAt(hostingUrl(id)).querySelector("article")!;
      expect(article.children[0].tagName, id).toBe("H1");
      expect(article.children[1].tagName, id).toBe("BLOCKQUOTE");
    }
  });
});

describe("legacy fragment maps", () => {
  it("send every old fragment to an existing section, and list them only in the agent Markdown", () => {
    for (const [slug, links] of Object.entries(LEGACY_LINKS)) {
      // The features page is the docs landing, built at /docs.
      const path = slug === "features" ? "/docs" : `/docs/${slug}`;
      const doc = docAt(path);
      const ids = Array.from(doc.querySelectorAll("[id]"), (e) => e.id);
      expect(new Set(ids).size, slug).toBe(ids.length);
      expect(
        JSON.parse(doc.getElementById("legacy-fragment-map")!.textContent!),
      ).toEqual(links);
      expect(
        doc.querySelector('script[src="/legacy-links.js"]'),
      ).not.toBeNull();
      const markdown = readFileSync(`site/_agent${path}/index.md`, "utf8");
      for (const [id, href] of Object.entries(links)) {
        // No visible list: the old fragment names no element on the page.
        expect(doc.getElementById(id), id).toBeNull();
        expect(markdown).toContain(`- [${id}](${href})`);
        const url = new URL(href, "https://isomux.com");
        expect(existsSync(`site${url.pathname}/index.html`), href).toBe(true);
        if (!url.hash) continue;
        const target = docAt(url.pathname.replace(/\/$/, ""));
        expect(
          target.getElementById(url.hash.slice(1)),
          `${slug}#${id} -> ${href}`,
        ).not.toBeNull();
      }
    }
  });
});

describe("docs meta descriptions", () => {
  const description = (path: string) =>
    docAt(path)
      .querySelector('meta[name="description"]')
      ?.getAttribute("content") ?? "";

  it("give each hosting guide its own summary, not its chooser text", () => {
    const seen = new Set<string>();
    for (const guide of HOSTING_GUIDES) {
      const text = description(hostingUrl(guide.id));
      expect(text, guide.id).not.toBe("");
      expect(text, guide.id).not.toBe(guide.detail);
      expect(text, guide.id).not.toBe(guide.label);
      seen.add(text);
    }
    expect(seen.size).toBe(HOSTING_GUIDES.length);
  });

  it("never cut a page's first paragraph to fill the description", async () => {
    const paths: string[] = [];
    for await (const file of new Bun.Glob("site/docs/**/index.html").scan(
      ".",
    )) {
      paths.push(file.replace(/^site/, "").replace(/\/index\.html$/, ""));
    }
    expect(paths).toContain("/docs");
    for (const path of paths) {
      // The first-paragraph fallback marks a cut with a trailing "...".
      expect(description(path), path).not.toEndWith("...");
    }
  });
});
