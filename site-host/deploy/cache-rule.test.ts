// The Cloudflare cache rule for isomux.com (site-host/deploy/README.md) lets the
// edge serve a stored page only when the request's Accept header has one of four
// shapes. Cloudflare does not key its cache on Accept, so each of those shapes
// must get the HTML page from the origin, never Markdown: otherwise the edge
// answers with HTML where the origin answers with Markdown. negotiate() is the
// origin's choice, for the docs pages (middleware.ts) and for the not-found page
// on every other path (api/not-found.ts).
import { describe, expect, it } from "bun:test";
import { negotiate } from "../../api/_content-negotiation";

// The rule's Accept test, as written in README.md. `null` is a request with no
// Accept header.
function cacheEligible(accept: string | null): boolean {
  if (accept === null) return true;
  const value = accept.toLowerCase();
  return (
    value === "*/*" || value === "text/html" || value.startsWith("text/html,")
  );
}

// Entries that try to win the negotiation for Markdown after a leading text/html.
const ENTRIES = [
  "text/markdown",
  "text/markdown;q=1",
  "text/markdown;q=1.0",
  "TEXT/MARKDOWN",
  "text/*",
  "text/*;q=1",
  "*/*",
  "*/*;q=1",
  "text/html;q=0",
  "text/html;q=0.1",
  "text/plain",
  "application/json",
  "application/xhtml+xml",
  "image/avif",
  "text/markdown;charset=utf-8",
  "text/markdown; q=1",
  " text/markdown ",
  "",
];

// A fixed seed: the same cases on every run.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("cache rule: every cache-eligible Accept gets HTML from the origin", () => {
  it("covers the shapes browsers and common clients send", () => {
    const accepts = [
      null,
      "*/*",
      "text/html",
      "TEXT/HTML",
      // Chrome, Firefox and Safari page navigations.
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "text/html,text/markdown",
      "text/html,text/markdown;q=1,*/*",
    ];
    for (const accept of accepts) {
      expect(cacheEligible(accept)).toBe(true);
      expect({ accept, got: negotiate(accept) }).toEqual({
        accept,
        got: "text/html",
      });
    }
  });

  it("holds for any list after a leading text/html", () => {
    const next = generator(7);
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const length = 1 + Math.floor(next() * 5);
      const tail = Array.from(
        { length },
        () => ENTRIES[Math.floor(next() * ENTRIES.length)],
      );
      const accept =
        (next() < 0.5 ? "text/html," : "Text/HTML,") + tail.join(",");
      expect(cacheEligible(accept)).toBe(true);
      expect({ accept, got: negotiate(accept) }).toEqual({
        accept,
        got: "text/html",
      });
      checked++;
    }
    expect(checked).toBe(2000);
  });
});
