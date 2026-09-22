import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { main as buildDocs } from "./build-docs.ts";
import { HOSTING_GUIDES, HOSTING_LEGACY_LINKS, composeHostingSource, hostingUrl } from "./hosting-docs.ts";
import middleware from "../middleware.ts";

beforeAll(() => buildDocs());
const htmlAt = (path: string) => readFileSync(`site${path}/index.html`, "utf8");
function parse(html: string) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  return window;
}

describe("complete hosting guides", () => {
  it("gives each flow leaf its unique guide destination", async () => {
    const expectedIds = ["hosted", "render", "aws", "vps", "local", "private", "funnel", "domain"];
    const window = parse(htmlAt("/docs/self-hosted"));
    const doc = window.document;
    for (const selector of [".hosting-flow"]) {
      const links = Array.from(doc.querySelectorAll(`${selector} a[data-guide]`));
      expect(links.map((a) => a.getAttribute("data-guide")).sort()).toEqual([...expectedIds].sort());
      for (const link of links) expect(link.getAttribute("href")).toBe(`/docs/hosting-${link.getAttribute("data-guide")}`);
    }
    expect(doc.querySelectorAll(".hosting-options [aria-current]").length).toBe(0);
    await window.happyDOM.close();
  });

  it("renders one complete guide and matching chatbot and negotiated Markdown per identity", async () => {
    for (const guide of HOSTING_GUIDES) {
      const path = hostingUrl(guide.id);
      const html = htmlAt(path);
      const window = parse(html);
      const doc = window.document;
      expect(doc.querySelectorAll(".hosting-selector, .hosting-flow").length, path).toBe(0);
      expect(doc.querySelector(".hosting-guide-notice a")?.getAttribute("href"), path).toBe("/docs/self-hosted");
      expect(doc.querySelectorAll("article h1").length, path).toBe(1);
      expect(doc.querySelectorAll("article pre").length + doc.querySelectorAll("article ol").length, path).toBeGreaterThan(0);
      const markdown = readFileSync(`site/_agent${path}/index.md`, "utf8");
      expect(markdown.includes("<!-- include:"), path).toBe(false);
      expect(markdown.match(/^# /gm)?.length, path).toBe(1);
      const context = html.match(/window\.__docContext = ("(?:[^"\\]|\\.)*");/);
      expect(context, path).not.toBeNull();
      const raw = JSON.parse(context![1]) as string;
      expect(raw.length, path).toBeLessThanOrEqual(20_000);
      expect(raw.split("\n")[0]).toBe(markdown.split("\n")[0]);
      // Compare the entire composed body, allowing only the public-link rewrite.
      const { rewriteMarkdownLinks } = await import("./build-docs.ts");
      expect(rewriteMarkdownLinks(raw), path).toBe(markdown);
      const response = middleware(new Request(`https://isomux.com${path}`, { headers: { Accept: "text/markdown" } }));
      expect(response.headers.get("x-middleware-rewrite")).toBe(`https://isomux.com/_agent${path}/index.md`);
      expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(`https://isomux.com${path}`);
      await window.happyDOM.close();
    }
  });

  it("keeps shared prerequisites inline and the AWS commands from the canonical README", () => {
    const install = readFileSync("docs/hosting/blocks/install.md", "utf8").trim();
    for (const id of ["local", "private", "funnel", "domain"]) {
      const markdown = readFileSync(`site/_agent/docs/hosting-${id}/index.md`, "utf8");
      expect(markdown).toContain(install.replaceAll("](hosting-reference.md", "](/docs/hosting-reference"));
      expect(markdown).toContain("git clone https://github.com/nmamano/isomux.git");
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

  it("retains the old public fragment contract", () => {
    const fragments = [
      "self-hosted-setup", "vps-install", "run-the-installer", "what-the-installer-does",
      "root-access", "parameters", "re-running", "updating", "app-hostnames",
      "opening-an-agents-dev-server", "notes", "desktop-chrome-extension",
      "your-own-hardware", "native-build-recovery", "keep-the-server-running",
      "make-the-office-reachable", "your-devices-and-anyone-willing-to-install-tailscale",
      "other-members-public-url", "install-on-mobile-pwa",
      "enable-https-for-voice-input-and-android-pwa-install", "authorize-members",
      "provider-api-keys", "deploy-a-container", "deploy-on-render", "backups",
      "running-out-of-memory", "what-each-deployment-covers", "proxy-and-real-domain",
      "proxy-and-no-real-domain", "no-proxy-and-no-real-domain",
    ];
    expect(Object.keys(HOSTING_LEGACY_LINKS).sort()).toEqual(fragments.sort());
  });

  it("keeps availability notices ahead of setup navigation", async () => {
    for (const id of ["render"]) {
      const window = parse(htmlAt(`/docs/hosting-${id}`));
      const article = window.document.querySelector("article")!;
      expect(article.children[0].tagName).toBe("H1");
      expect(article.children[1].tagName).toBe("BLOCKQUOTE");
      await window.happyDOM.close();
    }
  });

  it("resolves all generated hosting links and fragments without duplicate IDs", async () => {
    const paths = ["/docs/self-hosted", "/docs/hosting-reference", ...HOSTING_GUIDES.map((g) => hostingUrl(g.id))];
    const cache = new Map<string, ReturnType<typeof parse>>();
    for (const path of paths) cache.set(path, parse(htmlAt(path)));
    try {
      for (const [path, window] of cache) {
        const ids = Array.from(window.document.querySelectorAll("[id]"), (e) => e.id);
        expect(new Set(ids).size, path).toBe(ids.length);
        for (const anchor of window.document.querySelectorAll("a[href]")) {
          const href = anchor.getAttribute("href")!;
          if (!href.startsWith("#") && !href.startsWith("/docs")) continue;
          const url = new URL(href, `https://isomux.com${path}`);
          expect(existsSync(`site${url.pathname}/index.html`), `${path} -> ${href}`).toBe(true);
          if (!url.hash) continue;
          let target = cache.get(url.pathname);
          if (!target) { target = parse(htmlAt(url.pathname)); cache.set(url.pathname, target); }
          expect(target.document.getElementById(decodeURIComponent(url.hash.slice(1))), `${path} -> ${href}`).not.toBeNull();
        }
      }
      const index = cache.get("/docs/self-hosted")!.document;
      for (const [id, target] of Object.entries(HOSTING_LEGACY_LINKS)) {
        expect(index.getElementById(id)?.querySelector("a")?.getAttribute("href"), id).toBe(target);
      }
    } finally {
      await Promise.all(Array.from(cache.values(), (window) => window.happyDOM.close()));
    }
  });
});
