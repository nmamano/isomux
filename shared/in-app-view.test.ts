// Another app's browser, from the user agent (task 5765f58e, part 3): the
// invite page stops before Accept there, because a sign-in there signs in
// only that view and uses up the one-time link. iOS and Android. Views that
// send the browser's own user agent (SFSafariViewController in Gmail, Slack
// and X; Android Custom Tabs) read as the browser: no page can tell them
// apart.

import { expect, it } from "bun:test";
import { isInAppView } from "./in-app-view.ts";
import { IOS_UA } from "../ui/test-support/ios-browsers.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8";
// An iPad app's view: a Mac user agent with the app's token.
const IPAD_LINKEDIN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) [LinkedInApp]/9.29.1234";
const WV = `${ANDROID} Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36`;

for (const [label, ua, inApp] of [
  // iOS browsers.
  ["iPhone Safari", IOS_UA.safari, false],
  ["iPhone Chrome", IOS_UA.chrome, false],
  ["iPhone Firefox", IOS_UA.firefox, false],
  ["iPhone Edge", IOS_UA.edge, false],
  ["iPhone Opera", IOS_UA.opera, false],
  ["iPhone DuckDuckGo", IOS_UA.duckduckgo, false],
  ["iPad Safari (a desktop user agent)", IOS_UA.ipadSafari, false],
  // iOS in-app views.
  ["iPhone Instagram", IOS_UA.instagram, true],
  ["iPhone Threads", IOS_UA.threads, true],
  ["iPhone Facebook", IOS_UA.facebook, true],
  ["iPhone LinkedIn", IOS_UA.linkedin, true],
  ["iPhone TikTok", IOS_UA.tiktok, true],
  // Its own token alone catches it: it sends Safari's token.
  ["the iPhone Google app", IOS_UA.google, true],
  // The missing Safari token alone catches it.
  ["a plain iPhone WKWebView", IOS_UA.webview, true],
  ["an iPad LinkedIn view with a desktop user agent", IPAD_LINKEDIN, true],
  // Android browsers.
  [
    "Android Chrome",
    `${ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36`,
    false,
  ],
  [
    "Samsung Internet",
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    false,
  ],
  [
    "Android Firefox",
    "Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0",
    false,
  ],
  // Android in-app views.
  [
    "Android Instagram",
    `${WV} Instagram 321.0.0.39.106 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 577210397)`,
    true,
  ],
  ["Android Facebook", `${WV} [FB_IAB/FB4A;FBAV/456.0.0.38.109;]`, true],
  ["a plain Android WebView", WV, true],
  // Computers and clients with no browser token: never an in-app view.
  [
    "desktop Chrome",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    false,
  ],
  [
    "Mac Safari",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    false,
  ],
  ["curl", "curl/8.5.0", false],
  ["an empty user agent", "", false],
  ["no user agent", null, false],
] as const) {
  it(`reads ${label} as ${inApp ? "an in-app view" : "a browser"}`, () => {
    expect(isInAppView(ua)).toBe(inApp);
  });
}

// The conditions of the rows that each prove one rule.
it("has an in-app view with Safari's token, one with no browser token, an iPad one with no iPad token, and a bare Android WebView", () => {
  expect(IOS_UA.google).toContain("Safari/");
  expect(IOS_UA.webview).not.toMatch(/Safari\/|CriOS|FxiOS|EdgiOS/);
  expect(IPAD_LINKEDIN).not.toMatch(/iPhone|iPad|iPod|Safari\//);
  expect(WV).toContain("; wv)");
  expect(WV).not.toMatch(/FB_IAB|Instagram|GSA\//);
});
