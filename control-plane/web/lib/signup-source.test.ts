// The signup source on cloud.isomux.com (task 8a12ba81): which campaign, site
// and first isomux.com page brought a visitor, kept in the browser until the
// signup form posts it.
//
// parseSignupSource is the only gate between a URL anyone can type and a
// database row Growth reads, and the server runs it again on the posted form.
// So each refusal is a case of its own, and each case checks that one bad
// value costs only itself.

import { describe, expect, test } from "bun:test";
import {
  captureSignupSource,
  parseSignupSource,
  SIGNUP_SOURCE_TTL_MS,
  storedSignupSource,
} from "./signup-source";

const T0 = 1_700_000_000_000;

/** A Storage held in a Map: the module takes its storage as an argument, so no
 * DOM is needed. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

function parse(values: Record<string, string>) {
  return parseSignupSource((key) => values[key] ?? null);
}

const GOOD = {
  utm_source: "newsletter",
  utm_campaign: "launch-week",
  ref_host: "t.co",
  landing_path: "/blog/hosted",
};

describe("parseSignupSource", () => {
  test("keeps four valid values", () => {
    expect(parse(GOOD)).toEqual({
      utmSource: "newsletter",
      utmCampaign: "launch-week",
      referrerHost: "t.co",
      landingPath: "/blog/hosted",
    });
  });

  test("an absent or empty value is null", () => {
    expect(parse({})).toEqual({
      utmSource: null,
      utmCampaign: null,
      referrerHost: null,
      landingPath: null,
    });
    expect(parse({ ...GOOD, utm_campaign: "" }).utmCampaign).toBeNull();
  });

  // Each row: the field, a value it must refuse, and why. Every refusal is
  // checked to leave the other three values as they were.
  const refused: [keyof typeof GOOD, string, string][] = [
    ["utm_source", "news\nletter", "a control character"],
    ["utm_source", "x".repeat(101), "longer than 100"],
    ["utm_source", "someone@example.com", "an email from a mail merge tag"],
    ["utm_campaign", "launch\u0000", "a NUL"],
    ["utm_campaign", "subscriber-someone@example.com", "an @ anywhere"],
    ["ref_host", "https://t.co", "a URL, not a host"],
    ["ref_host", "t.co/abc", "a host with a path"],
    ["ref_host", "t.co?q=1", "a host with a query"],
    ["ref_host", "two words", "a space"],
    ["ref_host", "user@t.co", "a userinfo part"],
    ["ref_host", `${"a".repeat(250)}.com`, "longer than 253"],
    ["landing_path", "blog/hosted", "no leading slash"],
    ["landing_path", `/${"a".repeat(200)}`, "longer than 200"],
    ["landing_path", "/blog\nhosted", "a control character"],
  ];
  const field = {
    utm_source: "utmSource",
    utm_campaign: "utmCampaign",
    ref_host: "referrerHost",
    landing_path: "landingPath",
  } as const;

  for (const [key, value, why] of refused) {
    test(`refuses ${key} with ${why}, and only that value`, () => {
      const out = parse({ ...GOOD, [key]: value });
      const expected = { ...parse(GOOD), [field[key]]: null };
      expect(out).toEqual(expected);
    });
  }

  test("keeps the longest allowed values", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(61)}.${"c".repeat(61)}.${"d".repeat(61)}.com`;
    expect(host.length).toBe(253);
    const out = parse({
      utm_source: "x".repeat(100),
      utm_campaign: "y".repeat(100),
      ref_host: host,
      landing_path: `/${"p".repeat(199)}`,
    });
    expect([
      out.utmSource?.length,
      out.utmCampaign?.length,
      out.referrerHost,
      out.landingPath?.length,
    ]).toEqual([100, 100, host, 200]);
  });

  test("a landing path loses its query and fragment, which can carry personal data", () => {
    expect(
      parse({ landing_path: "/docs/setup?email=a%40b.c&x=1#top" }).landingPath,
    ).toBe("/docs/setup");
    expect(parse({ landing_path: "/docs/setup#top" }).landingPath).toBe(
      "/docs/setup",
    );
  });
});

describe("captureSignupSource and storedSignupSource", () => {
  const TAGGED =
    "https://cloud.isomux.com/?lang=es&utm_source=newsletter&utm_campaign=launch-week" +
    "&ref_host=t.co&landing_path=%2Fblog%2Fhosted";

  test("a tagged URL is stored and read back as the parsed source", () => {
    const storage = memoryStorage();
    expect(storedSignupSource(storage, T0)).toBeNull();
    captureSignupSource(TAGGED, "https://isomux.com/es/hosted", storage, T0);
    expect(storedSignupSource(storage, T0)).toEqual(parse(GOOD));
  });

  test("first touch wins while it lasts, and the next touch is taken once it expires", () => {
    const storage = memoryStorage();
    captureSignupSource(TAGGED, "", storage, T0);
    const later =
      "https://cloud.isomux.com/?utm_source=linkedin&ref_host=www.linkedin.com";
    captureSignupSource(later, "", storage, T0 + SIGNUP_SOURCE_TTL_MS - 1);
    expect(
      storedSignupSource(storage, T0 + SIGNUP_SOURCE_TTL_MS - 1)?.utmSource,
    ).toBe("newsletter");

    // Expired: nothing to read, and the next touch is the first again.
    expect(
      storedSignupSource(storage, T0 + SIGNUP_SOURCE_TTL_MS + 1),
    ).toBeNull();
    captureSignupSource(later, "", storage, T0 + SIGNUP_SOURCE_TTL_MS + 1);
    expect(
      storedSignupSource(storage, T0 + SIGNUP_SOURCE_TTL_MS + 1),
    ).toMatchObject({
      utmSource: "linkedin",
      referrerHost: "www.linkedin.com",
    });
  });

  test("a visit that names no source stores nothing, so a later tagged visit is still the first touch", () => {
    const storage = memoryStorage();
    captureSignupSource("https://cloud.isomux.com/signin", "", storage, T0);
    captureSignupSource(
      "https://cloud.isomux.com/?lang=es",
      "https://isomux.com/es/hosted",
      storage,
      T0,
    );
    captureSignupSource(
      "https://cloud.isomux.com/",
      "https://cloud.isomux.com/signin",
      storage,
      T0,
    );
    captureSignupSource(
      "https://cloud.isomux.com/",
      "https://docs.isomux.com/x",
      storage,
      T0,
    );
    expect(storedSignupSource(storage, T0)).toBeNull();
    captureSignupSource(TAGGED, "", storage, T0 + 1);
    expect(storedSignupSource(storage, T0 + 1)?.utmSource).toBe("newsletter");
  });

  test("an untagged link from another site keeps that site's host and nothing of its URL", () => {
    const storage = memoryStorage();
    captureSignupSource(
      "https://cloud.isomux.com/",
      "https://news.example.org/item?id=42&user=someone",
      storage,
      T0,
    );
    expect(storedSignupSource(storage, T0)).toEqual({
      utmSource: null,
      utmCampaign: null,
      referrerHost: "news.example.org",
      landingPath: null,
    });
  });

  test("a host that only ends in isomux.com is another site", () => {
    const storage = memoryStorage();
    captureSignupSource(
      "https://cloud.isomux.com/",
      "https://notisomux.com/",
      storage,
      T0,
    );
    expect(storedSignupSource(storage, T0)?.referrerHost).toBe("notisomux.com");
  });

  test("the ref_host the site passed on wins over the page's own referrer", () => {
    const storage = memoryStorage();
    captureSignupSource(
      "https://cloud.isomux.com/?ref_host=chatgpt.com&landing_path=%2F",
      "https://news.example.org/",
      storage,
      T0,
    );
    expect(storedSignupSource(storage, T0)).toMatchObject({
      referrerHost: "chatgpt.com",
      landingPath: "/",
    });
  });

  test("a refused value is not stored", () => {
    const storage = memoryStorage();
    captureSignupSource(
      "https://cloud.isomux.com/?utm_source=someone%40example.com&utm_campaign=spring",
      "",
      storage,
      T0,
    );
    expect(storedSignupSource(storage, T0)).toMatchObject({
      utmSource: null,
      utmCampaign: "spring",
    });
  });

  test("a stored value this code cannot read is treated as none, and replaced", () => {
    const storage = memoryStorage();
    captureSignupSource(TAGGED, "", storage, T0);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key) storage.setItem(key, "{not json");
    }
    expect(storedSignupSource(storage, T0)).toBeNull();
    captureSignupSource(TAGGED, "", storage, T0);
    expect(storedSignupSource(storage, T0)?.utmSource).toBe("newsletter");
  });
});
