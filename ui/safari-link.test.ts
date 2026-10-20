// Which links leave the iPhone Home Screen office for Safari (ui/safari-link.ts).
//
// Pins: only an iOS Home Screen web app on iOS 17 or later (or an unknown
// version) gets the x-safari- prefix, and only on an absolute http(s) URL; the
// chat variant rewrites only an app's short link (one path label on the
// office's own origin that is not an office page), so an office page stays in
// the Home Screen office and a link to another site keeps opening in the
// Safari sheet it opens in today.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, expect, it } from "bun:test";
import {
  safariHref,
  safariHrefSameOrigin,
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

describe("safariHrefSameOrigin", () => {
  const origin = "https://office.example";

  it("sends an app's short link to Safari", () => {
    for (const href of [
      "https://office.example/loop",
      "https://office.example/loop/",
      "https://office.example/standup-board?task=1#top",
    ])
      expect(safariHrefSameOrigin(href, HOME_SCREEN, origin)).toBe(
        "x-safari-" + href,
      );
  });

  // The office routes these itself, so the Home Screen window is the right
  // place for them; Safari may not even be signed in.
  it("leaves office pages and other office paths alone", () => {
    for (const path of [
      "/",
      "/?pager=abc",
      "/tasks",
      "/tasks/?task=1",
      "/settings",
      "/inbox",
      "/inbox/asks",
      "/integrations/secrets",
      "/agents/agent-1",
      "/loop/board",
    ]) {
      const href = origin + path;
      expect(safariHrefSameOrigin(href, HOME_SCREEN, origin)).toBe(href);
    }
  });

  it("leaves every other origin alone", () => {
    for (const href of [
      "https://loop.office.example/",
      "https://office.example.other.example/loop",
      "http://office.example/loop",
      "https://office.example:8443/loop",
      "https://example.com/",
    ])
      expect(safariHrefSameOrigin(href, HOME_SCREEN, origin)).toBe(href);
  });

  it("leaves a destination that is not a URL alone instead of throwing", () => {
    for (const href of [
      "https://",
      "javascript:alert(1)",
      "mailto:a@b.example",
    ])
      expect(safariHrefSameOrigin(href, HOME_SCREEN, origin)).toBe(href);
  });

  it("follows safariHref's device rules", () => {
    const href = "https://office.example/loop";
    expect(
      safariHrefSameOrigin(href, { ...HOME_SCREEN, standalone: false }, origin),
    ).toBe(href);
    expect(
      safariHrefSameOrigin(href, { ...HOME_SCREEN, iosMajor: 16 }, origin),
    ).toBe(href);
  });
});
