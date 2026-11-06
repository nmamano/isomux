// Which links leave the iPhone Home Screen office for Safari (ui/safari-link.ts).
//
// Pins: only an iOS Home Screen web app on iOS 17 or later (or an unknown
// version) gets the x-safari- prefix, and only on an absolute http(s) URL.
//
// floorHref and floorBrowserApplies: where a lobby elevator floor opens.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, expect, it } from "bun:test";
import {
  floorBrowserApplies,
  floorHref,
  safariHref,
  type SafariEnv,
} from "./safari-link.ts";

const HOME_SCREEN: SafariEnv = { ios: true, standalone: true, iosMajor: 17 };

describe("safariHref", () => {
  it("sends an absolute http(s) link from the iOS Home Screen app to Safari", () => {
    for (const href of [
      "https://office.example/loop",
      "http://auntie:21000/",
      "https://loop.office.example/?x=1",
    ])
      expect(safariHref(href, HOME_SCREEN)).toBe("x-safari-" + href);
  });

  it("rewrites on iOS 17 and later, and when the user agent names no version", () => {
    const href = "https://office.example/loop";
    for (const iosMajor of [17, 18, 26, null])
      expect(safariHref(href, { ...HOME_SCREEN, iosMajor })).toBe(
        "x-safari-" + href,
      );
    // Older iOS has no x-safari scheme: the link would do nothing.
    for (const iosMajor of [15, 16])
      expect(safariHref(href, { ...HOME_SCREEN, iosMajor })).toBe(href);
  });

  it("leaves a browser tab, a non-iOS Home Screen app and a non-web link alone", () => {
    const href = "https://office.example/loop";
    expect(safariHref(href, { ...HOME_SCREEN, standalone: false })).toBe(href);
    expect(safariHref(href, { ...HOME_SCREEN, ios: false })).toBe(href);
    for (const other of [
      "/demo/app?name=board",
      "mailto:someone@example.com",
      "x-safari-https://office.example/loop",
    ])
      expect(safariHref(other, HOME_SCREEN)).toBe(other);
  });
});

// Where a floor of the lobby elevator opens (task 67fa3634): the member's
// choice of Safari or Chrome, under the same gate as safariHref.
const ENVS: SafariEnv[] = [];
for (const ios of [true, false])
  for (const standalone of [true, false])
    for (const iosMajor of [null, 15, 16, 17, 18, 26])
      ENVS.push({ ios, standalone, iosMajor });
const HREFS = [
  "https://harbor.example.com/#isomux-panel=a%2Bb&from=x",
  "http://lab.example.org:4000/path/?q=1&r=%20#frag",
  "https://office.example/loop",
  "/demo/app?name=board",
  "mailto:someone@example.com",
];
const applies = (env: SafariEnv) =>
  env.ios && env.standalone && (env.iosMajor === null || env.iosMajor >= 17);

describe("floorBrowserApplies", () => {
  it("holds only in the iOS Home Screen app on iOS 17 or later, or an unknown version", () => {
    for (const env of ENVS)
      expect([env, floorBrowserApplies(env)]).toEqual([env, applies(env)]);
  });
});

describe("floorHref", () => {
  it("sends a floor to Safari exactly as safariHref does", () => {
    for (const env of ENVS)
      for (const href of HREFS)
        expect([env, href, floorHref(href, env, "safari")]).toEqual([
          env,
          href,
          safariHref(href, env),
        ]);
  });

  it("sends https to googlechromes and http to googlechrome, with host, port, path, query and fragment intact", () => {
    expect(floorHref(HREFS[0], HOME_SCREEN, "chrome")).toBe(
      "googlechromes://harbor.example.com/#isomux-panel=a%2Bb&from=x",
    );
    expect(floorHref(HREFS[1], HOME_SCREEN, "chrome")).toBe(
      "googlechrome://lab.example.org:4000/path/?q=1&r=%20#frag",
    );
    expect(
      floorHref(HREFS[0], { ...HOME_SCREEN, iosMajor: null }, "chrome"),
    ).toBe("googlechromes://harbor.example.com/#isomux-panel=a%2Bb&from=x");
  });

  it("leaves every link alone where the gate does not hold, and a non-web link everywhere", () => {
    for (const env of ENVS.filter((e) => !applies(e)))
      for (const href of HREFS)
        expect([env, floorHref(href, env, "chrome")]).toEqual([env, href]);
    for (const href of HREFS.slice(3))
      expect(floorHref(href, HOME_SCREEN, "chrome")).toBe(href);
  });
});
