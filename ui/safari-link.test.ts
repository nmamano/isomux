// Which links leave the iPhone Home Screen office for Safari (ui/safari-link.ts).
//
// Pins: only an iOS Home Screen web app on iOS 17 or later (or an unknown
// version) gets the x-safari- prefix, and only on an absolute http(s) URL.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, expect, it } from "bun:test";
import { safariHref, type SafariEnv } from "./safari-link.ts";

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
