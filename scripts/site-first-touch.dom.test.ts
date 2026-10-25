// The first-touch signup source on isomux.com (task 8a12ba81), in
// site/analytics.js. On the first page of a tab's visit the site keeps the
// referring site's host, the page path and the utm tags in sessionStorage, and
// adds them to its links to the Hosted app. The Hosted signup stores them with
// the subscription, and Growth counts customers by them.
//
// The script is a browser IIFE: the test runs the real file (off the production
// host, so its analytics half does nothing) and then calls the function it
// defines with a location and a referrer of its own.

import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setUpDomTestFile } from "../ui/test-support/dom.ts";

setUpDomTestFile();

const ANALYTICS = readFileSync(
  join(import.meta.dir, "..", "site", "analytics.js"),
  "utf8",
);

type FirstTouch = (
  loc: { pathname: string; search: string },
  referrer: string,
  storage: Storage,
  doc: Document,
) => void;

const PAGE =
  '<a id="cta" href="https://cloud.isomux.com?lang=es">Sign in</a>' +
  '<a id="bare" href="https://cloud.isomux.com">cloud.isomux.com</a>' +
  '<a id="github" href="https://github.com/nmamano/isomux">GitHub</a>' +
  '<a id="local" href="/es/hosted">Hosted</a>';

function firstTouch(): FirstTouch {
  new Function(ANALYTICS)();
  return (window as unknown as { isomuxFirstTouch: FirstTouch })
    .isomuxFirstTouch;
}

/** A fresh page in the same tab: new links, same sessionStorage. */
function visit(pathname: string, search: string, referrer: string): void {
  document.body.innerHTML = PAGE;
  firstTouch()({ pathname, search }, referrer, sessionStorage, document);
}

function href(id: string): string {
  return document.getElementById(id)?.getAttribute("href") ?? "";
}

/** The query of a link, as sorted [key, value] pairs. */
function params(id: string): [string, string][] {
  return [
    ...new URL(href(id), "https://isomux.com").searchParams.entries(),
  ].sort(([a], [b]) => a.localeCompare(b));
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("the first-touch signup source on isomux.com", () => {
  it("passes the first page's referrer host, path and utm tags to the Hosted links, and nothing else of either URL", () => {
    visit(
      "/blog/hosted",
      "?utm_source=newsletter&utm_campaign=launch-week&fbclid=abc&email=a%40b.c",
      "https://t.co/xyz?amp=1",
    );
    expect(params("cta")).toEqual([
      ["landing_path", "/blog/hosted"],
      ["lang", "es"],
      ["ref_host", "t.co"],
      ["utm_campaign", "launch-week"],
      ["utm_source", "newsletter"],
    ]);
    expect(params("bare").map(([key]) => key)).toEqual([
      "landing_path",
      "ref_host",
      "utm_campaign",
      "utm_source",
    ]);
    // Other links keep their exact href.
    expect([href("github"), href("local")]).toEqual([
      "https://github.com/nmamano/isomux",
      "/es/hosted",
    ]);
  });

  it("keeps the first touch for the rest of the tab's visit", () => {
    visit("/blog/hosted", "?utm_source=newsletter", "https://t.co/xyz");
    // The next page in the same tab: its referrer is our own site, and it has
    // tags of its own.
    visit("/es/hosted", "?utm_source=other", "https://isomux.com/blog/hosted");
    expect(params("cta")).toEqual([
      ["landing_path", "/blog/hosted"],
      ["lang", "es"],
      ["ref_host", "t.co"],
      ["utm_source", "newsletter"],
    ]);
  });

  it("a first page opened from isomux.com or a subdomain is not a first touch", () => {
    for (const referrer of [
      "https://isomux.com/",
      "https://www.isomux.com/docs",
      "https://cloud.isomux.com/signin",
    ]) {
      sessionStorage.clear();
      visit("/hosted", "?utm_source=newsletter", referrer);
      expect([referrer, href("cta"), sessionStorage.length]).toEqual([
        referrer,
        "https://cloud.isomux.com?lang=es",
        0,
      ]);
    }
  });

  it("a site whose name only ends in isomux.com is another site", () => {
    visit("/", "", "https://notisomux.com/page");
    expect(params("bare")).toEqual([
      ["landing_path", "/"],
      ["ref_host", "notisomux.com"],
    ]);
  });

  it("a direct visit passes its landing path and no referrer", () => {
    visit("/docs/setup", "", "");
    expect(params("bare")).toEqual([["landing_path", "/docs/setup"]]);
  });

  it("running twice on one page adds each value once", () => {
    document.body.innerHTML = PAGE;
    const run = firstTouch();
    run(
      { pathname: "/blog/hosted", search: "?utm_source=newsletter" },
      "https://t.co/",
      sessionStorage,
      document,
    );
    run(
      { pathname: "/blog/hosted", search: "?utm_source=newsletter" },
      "https://t.co/",
      sessionStorage,
      document,
    );
    expect(params("cta")).toEqual([
      ["landing_path", "/blog/hosted"],
      ["lang", "es"],
      ["ref_host", "t.co"],
      ["utm_source", "newsletter"],
    ]);
  });
});
