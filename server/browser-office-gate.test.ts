import { expect, test } from "bun:test";
import { OfficeOrigins, officePageRefused } from "./browser-office-gate";

// The refusal rule (task 2a3b5645): an agent may not reach an office page that
// the member did not offer. The bridge tests drive it through CDP events; this
// file owns the rule's edges and the origin set's bounds.

test("a page is refused only on a known office other than the offer's", () => {
  const offices = new Set(["https://office.test", "http://office.lan:4000"]);
  const cases: [url: string, offer: string | undefined, refused: boolean][] = [
    ["https://office.test/settings?tab=tokens#x", "https://site.test", true],
    ["http://office.lan:4000/", "https://site.test", true],
    // No offer origin is no consent for any office.
    ["https://office.test/", undefined, true],
    // The member offered a tab on this office.
    ["https://office.test/tasks", "https://office.test", false],
    // Another office than the offered one.
    ["http://office.lan:4000/", "https://office.test", true],
    // Origin, not host: another port or scheme is another origin.
    ["https://office.test:8443/", "https://site.test", false],
    ["http://office.test/", "https://site.test", false],
    ["https://office.lan:4000/", "https://site.test", false],
    ["https://site.test/", "https://site.test", false],
    // A sub-domain of an office is not the office.
    ["https://apps.office.test/", "https://site.test", false],
    ["about:blank", "https://site.test", false],
    ["not a url", "https://site.test", false],
  ];
  for (const [url, offer, refused] of cases)
    expect({
      url,
      offer,
      refused: officePageRefused(url, offer, offices),
    }).toEqual({
      url,
      offer,
      refused,
    });
});

test("the origin set normalizes, reads its seed at each check, and drops the oldest learned origin past the cap", () => {
  const seed = ["HTTPS://Office.Test:443/some/path", "not a url"];
  const offices = new OfficeOrigins(() => seed, 3);
  // A seed value that is not a URL is skipped, never thrown.
  expect(offices.has("https://office.test")).toBe(true);
  expect([...offices.all()]).toEqual(["https://office.test"]);

  expect(offices.learn("https://A.test/x?y")).toBe(true);
  expect(offices.learn("https://a.test/other")).toBe(false);
  expect(offices.has("https://a.test")).toBe(true);
  expect(offices.learn("https://b.test/")).toBe(true);
  expect(offices.learn("https://c.test/")).toBe(true);
  expect(offices.learn("https://d.test/")).toBe(true);
  // The cap counts learned origins only; the oldest one went.
  expect(offices.has("https://a.test")).toBe(false);
  expect(["b", "c", "d"].map((h) => offices.has(`https://${h}.test`))).toEqual([
    true,
    true,
    true,
  ]);
  expect(offices.learn("garbage")).toBe(false);

  // The seed is read again: a changed public origin applies without a restart,
  // and a seed is never dropped by the cap.
  seed.push("https://moved.test");
  for (const h of ["e", "f", "g", "h"]) offices.learn(`https://${h}.test/`);
  expect(offices.has("https://moved.test")).toBe(true);
  expect(offices.has("https://office.test")).toBe(true);
});
