// The eight public pages: site/index.html and site/hosted.html in English, and
// their Spanish, Catalan and Simplified Chinese copies under site/es, site/ca and site/zh.
//
// The copies are full static files, not a template render, so nothing but a
// check like this stops them drifting from the English: a link that stayed
// English, an asset a nested copy lost, a canonical that still names the
// English URL, a page that was copied and only half translated.
//
// Two things the checker is deliberately not: it does not read the files as
// text laid out a particular way, and it does not resolve links against the
// disk. Attributes are parsed, so a reformatted tag is the same tag; and a
// reference is resolved the way a browser resolves it, against the URL the
// page is SERVED at, before the resulting path is looked for under site/. A
// disk-relative check would call `../../README.md` on a page two directories
// down a valid link, which a browser would not.
//
// The expected rows below are written out literally on purpose. They are the
// oracle; SITE_LANGUAGE_PATH is the implementation the office links through,
// and one test compares the two. Deriving the rows from the helper would let a
// wrong helper approve itself.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SITE_LANGUAGE_PATH } from "../shared/i18n/site-url.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "site");
const ORIGIN = "https://isomux.com";

type Row = {
  lang: string;
  family: "index" | "hosted";
  file: string;
  url: string;
  self: string;
};

const PAGES: Row[] = [
  {
    lang: "zh",
    family: "index",
    file: "zh/index.html",
    url: "https://isomux.com/zh",
    self: "/zh",
  },
  {
    lang: "zh",
    family: "hosted",
    file: "zh/hosted.html",
    url: "https://isomux.com/zh/hosted",
    self: "/zh/hosted",
  },
  {
    lang: "en",
    family: "index",
    file: "index.html",
    url: "https://isomux.com/",
    self: "/",
  },
  {
    lang: "es",
    family: "index",
    file: "es/index.html",
    url: "https://isomux.com/es",
    self: "/es",
  },
  {
    lang: "ca",
    family: "index",
    file: "ca/index.html",
    url: "https://isomux.com/ca",
    self: "/ca",
  },
  {
    lang: "en",
    family: "hosted",
    file: "hosted.html",
    url: "https://isomux.com/hosted",
    self: "/hosted",
  },
  {
    lang: "es",
    family: "hosted",
    file: "es/hosted.html",
    url: "https://isomux.com/es/hosted",
    self: "/es/hosted",
  },
  {
    lang: "ca",
    family: "hosted",
    file: "ca/hosted.html",
    url: "https://isomux.com/ca/hosted",
    self: "/ca/hosted",
  },
];

// What each family's five alternate links must say, on all four of its pages.
const ALTERNATES: Record<Row["family"], Record<string, string>> = {
  index: {
    en: "https://isomux.com/",
    es: "https://isomux.com/es",
    ca: "https://isomux.com/ca",
    zh: "https://isomux.com/zh",
    "x-default": "https://isomux.com/",
  },
  hosted: {
    en: "https://isomux.com/hosted",
    es: "https://isomux.com/es/hosted",
    ca: "https://isomux.com/ca/hosted",
    zh: "https://isomux.com/zh/hosted",
    "x-default": "https://isomux.com/hosted",
  },
};

// Paths that exist only after a build (see .gitignore) or are served by the
// host, so they cannot be looked for under site/.
const DOC_SLUGS = readdirSync(join(ROOT, "docs"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3));
const BUILT_PATHS = new Set<string>([
  "/demo",
  "/docs",
  // Injected by the host, never a file in this tree.
  "/_vercel/insights/script.js",
  ...DOC_SLUGS.filter((slug) => slug !== "features").map((s) => `/docs/${s}`),
]);

const EXTERNAL = /^(?:https?:)?\/\/|^(?:data|mailto|tel|javascript):/i;

// ---- small, layout-insensitive HTML reading ----

// One open tag: the name, then attributes whose values may be double-quoted,
// single-quoted or bare. Quoted values may contain ">", which the favicon's
// inline SVG data URL does, so a naive `[^>]*` would cut that tag in half.
const OPEN_TAG =
  /<([a-zA-Z][\w-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attributesOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of raw.matchAll(ATTRIBUTE))
    attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
  return attrs;
}

/** Every `<name ...>` in `html` as an attribute map, in document order. */
function tags(html: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of html.matchAll(OPEN_TAG)) {
    if (m[1].toLowerCase() !== name) continue;
    out.push(attributesOf(m[2] ?? ""));
  }
  return out;
}

/** Every href and src the page carries, in document order. */
function references(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(OPEN_TAG)) {
    const attrs = attributesOf(m[2] ?? "");
    for (const key of ["href", "src"]) if (attrs[key]) out.push(attrs[key]);
  }
  return out;
}

/** The insides of every `<name class="className">`, whatever its attribute order. */
function blocksOf(html: string, name: string, className: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(OPEN_TAG)) {
    if (m[1].toLowerCase() !== name) continue;
    if (attributesOf(m[2] ?? "").class !== className) continue;
    const start = m.index + m[0].length;
    const end = html.indexOf(`</${name}>`, start);
    if (end >= 0) out.push(html.slice(start, end));
  }
  return out;
}

type SwitchItem = {
  href: string;
  hreflang: string;
  lang: string;
  current: boolean;
  text: string;
};

function switchItems(block: string): SwitchItem[] {
  // The formatter may break the line before a closing bracket (`</a\n>`).
  return [...block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g)].map((m) => {
    const a = attributesOf(m[1]);
    return {
      href: a.href ?? "",
      hreflang: a.hreflang ?? "",
      lang: a.lang ?? "",
      current: a["aria-current"] === "page",
      text: m[2].trim(),
    };
  });
}

/** What the switch must say on `row`: four links, this page's own marked. */
function expectedSwitch(row: Row): SwitchItem[] {
  const suffix = row.family === "hosted" ? "/hosted" : "";
  return SUPPORTED_LANGUAGES.map(({ code, label }) => ({
    href: SITE_LANGUAGE_PATH[code] + suffix || "/",
    hreflang: code,
    lang: code,
    current: code === row.lang,
    text: label,
  }));
}

/** The page with its HTML comments removed. */
function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
}

function renderedText(html: string): string {
  return withoutComments(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type SemanticText = { tag: string; text: string };

function sectionText(html: string): SemanticText[][] {
  return [
    ...withoutComments(html).matchAll(
      /<section\b[^>]*>([\s\S]*?)<\/section>/gi,
    ),
  ].map((section) =>
    [...section[1].matchAll(/<(h[1-6]|p|li|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((match) => ({
        tag: match[1].toLowerCase(),
        text: renderedText(match[2]),
      }))
      .filter(({ text }) => text.length > 0),
  );
}

function read(row: Row): string {
  return readFileSync(join(SITE, row.file), "utf8");
}

// ---- reference resolution, the way a browser does it ----

/**
 * The path a browser would request for `ref` written on a page served at
 * `pageUrl`, or null when the reference leaves this origin. `new URL` does the
 * normalization, so "../../x" cannot climb above the site root and a query or
 * fragment is dropped here rather than trimmed by hand.
 */
function requestedPath(ref: string, pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(ref, pageUrl);
  } catch {
    return null;
  }
  return url.origin === ORIGIN ? url.pathname : null;
}

/** Whether the deployed site answers `pathname` with a FILE. */
function servesAFile(pathname: string): boolean {
  if (BUILT_PATHS.has(pathname)) return true;
  const rel = pathname.replace(/^\/+/, "");
  const candidates =
    rel === "" ? ["index.html"] : [rel, `${rel}.html`, join(rel, "index.html")];
  return candidates.some((candidate) => {
    const abs = resolve(SITE, candidate);
    // A path that resolved outside site/ is not something the site can serve,
    // whatever exists at it on this disk.
    if (abs !== SITE && !abs.startsWith(SITE + sep)) return false;
    return existsSync(abs) && statSync(abs).isFile();
  });
}

describe("public site in four languages", () => {
  it("SITE_LANGUAGE_PATH matches the paths the pages are actually served at", () => {
    expect(SITE_LANGUAGE_PATH).toEqual({
      en: "",
      es: "/es",
      ca: "/ca",
      zh: "/zh",
    });
    for (const row of PAGES) {
      const prefix = SITE_LANGUAGE_PATH[row.lang as "en" | "es" | "ca" | "zh"];
      const suffix = row.family === "hosted" ? "/hosted" : "";
      expect(`https://isomux.com${prefix}${suffix}`).toBe(
        row.family === "hosted" || row.lang !== "en"
          ? row.url
          : "https://isomux.com",
      );
    }
  });

  for (const row of PAGES) {
    const name = `${row.lang}/${row.family}`;

    it(`${name} exists and declares its language`, () => {
      expect(existsSync(join(SITE, row.file))).toBe(true);
      const html = tags(read(row), "html");
      expect(html.length).toBe(1);
      expect(html[0].lang).toBe(row.lang);
    });

    it(`${name} names itself in canonical, og:url and twitter:url`, () => {
      const html = read(row);
      const canonical = tags(html, "link").filter((l) => l.rel === "canonical");
      expect(canonical.length).toBe(1);
      expect(canonical[0].href).toBe(row.url);
      const metas = tags(html, "meta");
      const og = metas.filter((m) => m.property === "og:url");
      const tw = metas.filter((m) => m.name === "twitter:url");
      expect(og.length).toBe(1);
      expect(tw.length).toBe(1);
      expect(og[0].content).toBe(row.url);
      expect(tw[0].content).toBe(row.url);
    });

    it(`${name} carries the five alternate links of its family, once each`, () => {
      const alternates = tags(read(row), "link").filter(
        (l) => l.rel === "alternate",
      );
      // Counted before the map is built: a duplicate hreflang with a wrong URL
      // followed by the right one collapses into a correct-looking map.
      expect(alternates.length).toBe(5);
      const found = Object.fromEntries(
        alternates.map((l) => [l.hreflang, l.href]),
      );
      expect(found).toEqual(ALTERNATES[row.family]);
      expect(found["x-default"]).toBe(found.en);
    });

    it(`${name} carries the language switch once, with itself marked`, () => {
      const blocks = blocksOf(read(row), "div", "lang-switch");
      expect(blocks.length).toBe(1);
      expect(switchItems(blocks[0])).toEqual(expectedSwitch(row));
    });

    it(`${name} has no broken local link or asset`, () => {
      const html = read(row);
      const broken: string[] = [];
      for (const ref of references(html)) {
        if (!ref || EXTERNAL.test(ref)) continue;
        if (ref.startsWith("#")) {
          const id = ref.slice(1);
          if (!html.includes(`id="${id}"`) && !html.includes(`name="${id}"`))
            broken.push(ref);
          continue;
        }
        // Resolved against the URL this page is SERVED at, not its place on
        // disk, so a nested copy is a real test of one.
        const path = requestedPath(ref, row.url);
        if (path === null || !servesAFile(path)) broken.push(ref);
      }
      expect(broken).toEqual([]);
    });

    if (row.family === "hosted") {
      it(`${name} carries its language to the storefront`, () => {
        const cloudLinks = tags(read(row), "a")
          .map((a) => a.href)
          .filter((href) => href?.startsWith("https://cloud.isomux.com"));
        expect(cloudLinks.length).toBe(2);
        for (const href of cloudLinks) {
          const linked = new URL(href);
          expect(linked.searchParams.get("lang")).toBe(
            row.lang === "en" ? null : row.lang,
          );
        }
      });
    }

    it(`${name} ${row.family === "hosted" ? "says" : "does not say"} which language the legal pages are in`, () => {
      const notes = blocksOf(read(row), "p", "legal-note");
      if (row.family !== "hosted") {
        // It is a note on the hosted page's own legal links. A copy stranded on
        // the landing would be a line nothing on that page refers to.
        expect(notes.length).toBe(0);
        return;
      }
      expect(notes.length).toBe(1);
      expect(renderedText(notes[0]).length).toBeGreaterThan(0);
      if (row.lang !== "en") {
        const english = PAGES.find(
          (candidate) =>
            candidate.lang === "en" && candidate.family === "hosted",
        );
        if (!english) throw new Error("missing English hosted page");
        const englishNote = blocksOf(read(english), "p", "legal-note");
        expect(englishNote.length).toBe(1);
        expect(renderedText(notes[0])).not.toBe(renderedText(englishNote[0]));
      }
    });

    if (row.lang !== "en") {
      it(`${name} is translated, not a copy of the English file`, () => {
        const english = PAGES.find(
          (candidate) =>
            candidate.lang === "en" && candidate.family === row.family,
        );
        if (!english) throw new Error(`missing English ${row.family} page`);
        const translatedSections = sectionText(read(row));
        const englishSections = sectionText(read(english));
        expect(translatedSections.length).toBeGreaterThan(0);
        expect(translatedSections.length).toBe(englishSections.length);
        for (const [sectionIndex, translated] of translatedSections.entries()) {
          const source = englishSections[sectionIndex];
          expect(translated.length, `section ${sectionIndex + 1}`).toBe(
            source.length,
          );
          for (const [textIndex, block] of translated.entries()) {
            const englishBlock = source[textIndex];
            expect(block.tag).toBe(englishBlock.tag);
            // Product names do not translate. Catalan also uses the English
            // loanword "Plans" for this heading.
            const invariant =
              block.tag === "h1" ||
              (row.lang === "ca" &&
                row.family === "hosted" &&
                block.tag === "h2" &&
                block.text === "Plans");
            if (invariant) continue;
            expect(
              block.text,
              `section ${sectionIndex + 1}, ${block.tag} ${textIndex + 1}`,
            ).not.toBe(englishBlock.text);
          }
        }
      });
    }
  }
});

describe("how the checker resolves a reference", () => {
  it("reads a tag the same however it is laid out", () => {
    const spread = '<link\n  rel="alternate"\n  hreflang="ca"\n  href="/x"\n/>';
    const tight = '<link href="/x" hreflang="ca" rel="alternate">';
    expect(tags(spread, "link")).toEqual(tags(tight, "link"));
  });

  it("keeps a tag whose quoted value contains a closing bracket", () => {
    const favicon = `<link rel="icon" href="data:image/svg+xml,<svg><g/></svg>" />`;
    expect(tags(favicon, "link")[0].rel).toBe("icon");
  });

  it("resolves a relative reference against the served URL, not the disk", () => {
    // The regression this exists for: site/ca/index.html is two directories
    // down on disk but is served at /ca, so "../../README.md" is a request for
    // /README.md, which the site does not serve. A disk-relative check would
    // have found the repository's README and called the link good.
    const ca = "https://isomux.com/ca";
    expect(requestedPath("../../README.md", ca)).toBe("/README.md");
    expect(servesAFile("/README.md")).toBe(false);
    expect(requestedPath("../../../etc/passwd", ca)).toBe("/etc/passwd");
    expect(servesAFile("/etc/passwd")).toBe(false);
  });

  it("resolves a document-relative reference against the page's directory", () => {
    expect(requestedPath("chatbot.css", "https://isomux.com/ca")).toBe(
      "/chatbot.css",
    );
    expect(requestedPath("chatbot.css", "https://isomux.com/ca/hosted")).toBe(
      "/ca/chatbot.css",
    );
    expect(servesAFile("/ca/chatbot.css")).toBe(false);
  });

  it("accepts what the site really serves", () => {
    expect(servesAFile("/")).toBe(true);
    expect(servesAFile("/chatbot.css")).toBe(true);
    expect(servesAFile("/hosted")).toBe(true);
    expect(servesAFile("/es")).toBe(true);
    expect(servesAFile("/ca/hosted")).toBe(true);
    expect(servesAFile("/docs/self-hosted")).toBe(true);
    expect(requestedPath("/demo?embed", "https://isomux.com/es")).toBe("/demo");
    expect(servesAFile("/demo")).toBe(true);
  });

  it("refuses a directory with no index and a path that is not there", () => {
    // site/_agent holds index.md, not index.html: a browser gets nothing.
    expect(existsSync(join(SITE, "_agent"))).toBe(true);
    expect(servesAFile("/_agent")).toBe(false);
    expect(servesAFile("/nope")).toBe(false);
  });

  it("treats an off-origin reference as not ours to resolve", () => {
    expect(requestedPath("https://github.com/x", "https://isomux.com/")).toBe(
      null,
    );
  });
});
