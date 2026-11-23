// Install as app (ui/app-install.ts, task 8a07aa4e): what the short-link page
// and the Apps page offer in each browser, and the life of the held
// beforeinstallprompt event. Chrome fires that event at most once per page
// until it is used, and prompt() works only once per event.

import { expect, it, mock } from "bun:test";
import {
  INSTALL_HASH,
  appInstallHref,
  canOfferInstall,
  captureInstallPrompt,
  heldInstallPrompt,
  installMode,
  isHandheld,
  promptInstall,
  showOfficeInstallNotice,
  stepsBrowser,
  subscribeInstallPrompt,
  type InstallEnv,
} from "./app-install.ts";
import { iosBrowser, type IosBrowser } from "../shared/in-app-view.ts";
import type { PushEnv } from "./push-subscription.ts";
import { IOS_UA } from "./test-support/ios-browsers.ts";

// Android Chrome.
const CHROME: InstallEnv = {
  ios: false,
  standalone: false,
  promptSupported: true,
  handheld: true,
  iosBrowser: null,
};
const CHROME_APP: InstallEnv = { ...CHROME, standalone: true };
const DESKTOP_CHROME: InstallEnv = { ...CHROME, handheld: false };
const IOS_SAFARI: InstallEnv = {
  ios: true,
  standalone: false,
  promptSupported: false,
  handheld: true,
  iosBrowser: "safari",
};
const IOS_HOME: InstallEnv = {
  ...IOS_SAFARI,
  standalone: true,
  iosBrowser: null,
};
// A mail or social app's browser: it has no Add to Home Screen (task
// 5765f58e).
const IOS_IN_APP: InstallEnv = { ...IOS_SAFARI, iosBrowser: "in-app" };
// Firefox on Android.
const FIREFOX: InstallEnv = {
  ios: false,
  standalone: false,
  promptSupported: false,
  handheld: true,
  iosBrowser: null,
};

for (const [label, env, held, mode, officeWindow] of [
  ["Chrome with an event", CHROME, true, "prompt", false],
  // No event yet, already installed, or the engagement rule: nothing to click.
  ["Chrome with no event", CHROME, false, null, false],
  ["an installed Chrome window", CHROME_APP, false, null, false],
  ["iPhone Safari", IOS_SAFARI, false, "ios-steps", false],
  [
    "iPhone Chrome",
    { ...IOS_SAFARI, iosBrowser: "chrome" },
    false,
    "ios-steps",
    false,
  ],
  [
    "iPhone Firefox",
    { ...IOS_SAFARI, iosBrowser: "firefox" },
    false,
    "ios-steps",
    false,
  ],
  [
    "iPhone Edge",
    { ...IOS_SAFARI, iosBrowser: "edge" },
    false,
    "ios-steps",
    false,
  ],
  [
    "an unknown iPhone browser",
    { ...IOS_SAFARI, iosBrowser: "other" },
    false,
    "ios-steps",
    false,
  ],
  // No Add to Home Screen there: the member opens the page in a browser.
  ["an iPhone in-app view", IOS_IN_APP, false, "browser", false],
  // The app's own Home Screen app: there is nothing left to install.
  ["an iPhone Home Screen window", IOS_HOME, false, null, false],
  // The window is read first, whatever the browser field holds.
  [
    "an iPhone Home Screen window read as in-app",
    { ...IOS_HOME, iosBrowser: "in-app" },
    false,
    null,
    false,
  ],
  // The Home Screen office's window: a browser installs the app.
  ["the iPhone Home Screen office", IOS_HOME, false, "browser", true],
  ["an installed Chrome office", CHROME_APP, true, "browser", true],
  ["Firefox", FIREFOX, false, null, false],
] as const) {
  it(`the short-link page offers ${String(mode)} in ${label}`, () => {
    expect(installMode(env, held, officeWindow)).toBe(mode);
  });
}

for (const [label, env, offered] of [
  ["Chrome", CHROME, true],
  ["iPhone Safari", IOS_SAFARI, true],
  // The app page there sends the member to a browser.
  ["the iPhone Home Screen office", IOS_HOME, true],
  ["Firefox", FIREFOX, false],
] as const) {
  it(`the Apps page offers install in ${label}: ${offered}`, () => {
    expect(canOfferInstall(env)).toBe(offered);
  });
}

// The office's notice (tasks 5d536d33, 55310a37): a phone or tablet browser
// that can install the office, until the member closes it or installs from
// it. Each row flips one input of the Android or iPhone row that shows it.
for (const [label, env, held, seen, shows] of [
  ["Android Chrome with an event", CHROME, true, false, true],
  // No event: not installable here, or already installed.
  ["Android Chrome with no event", CHROME, false, false, false],
  ["Android Chrome, closed before", CHROME, true, true, false],
  // Nil, 2026-10-23: an app is no better than a tab on a computer.
  ["desktop Chrome with an event", DESKTOP_CHROME, true, false, false],
  ["an installed Chrome window", CHROME_APP, true, false, false],
  ["iPhone Safari", IOS_SAFARI, false, false, true],
  ["iPhone Safari, closed before", IOS_SAFARI, false, true, false],
  // Its notice sends the member to a browser.
  ["an iPhone in-app view", IOS_IN_APP, false, false, true],
  ["an iPhone in-app view, closed before", IOS_IN_APP, false, true, false],
  ["an iPhone Home Screen window", IOS_HOME, false, false, false],
  ["Firefox on a phone", FIREFOX, false, false, false],
] as const) {
  it(`the office notice shows in ${label}: ${shows}`, () => {
    expect(showOfficeInstallNotice(env, held, seen)).toBe(shows);
  });
}

// Each iPhone browser that names itself gets its own steps; a browser whose
// menus we do not know gets the generic ones. Another app's view is told
// apart by its own token or by the missing Safari token. SFSafariViewController
// and Brave send Safari's user agent: no page can tell them from Safari.
for (const [label, ua, browser] of [
  ["Safari", IOS_UA.safari, "safari"],
  ["iPad Safari (a desktop user agent)", IOS_UA.ipadSafari, "safari"],
  ["Chrome", IOS_UA.chrome, "chrome"],
  ["Firefox", IOS_UA.firefox, "firefox"],
  ["Edge", IOS_UA.edge, "edge"],
  ["Opera", IOS_UA.opera, "other"],
  ["DuckDuckGo", IOS_UA.duckduckgo, "other"],
  ["Instagram", IOS_UA.instagram, "in-app"],
  ["Threads", IOS_UA.threads, "in-app"],
  ["Facebook", IOS_UA.facebook, "in-app"],
  ["LinkedIn", IOS_UA.linkedin, "in-app"],
  ["TikTok", IOS_UA.tiktok, "in-app"],
  // The token list alone catches it: it sends Safari's token.
  ["the Google app", IOS_UA.google, "in-app"],
  // The missing Safari token alone catches it.
  ["a plain WKWebView", IOS_UA.webview, "in-app"],
] as const) {
  it(`reads ${label} as ${browser}`, () => {
    expect(iosBrowser(ua)).toBe(browser satisfies IosBrowser);
  });
}

// The condition of the two in-app rows above: each is caught by one rule.
it("has an in-app view with Safari's token and one with no browser token", () => {
  expect(IOS_UA.google).toContain("Safari/");
  expect(IOS_UA.webview).not.toMatch(/Safari\/|CriOS|FxiOS|EdgiOS/);
});

for (const [browser, steps] of [
  ["safari", "safari"],
  ["chrome", "chrome"],
  ["firefox", "firefox"],
  ["edge", "edge"],
  ["other", "other"],
  // The steps never show there; if they do, the generic ones, never Safari's.
  ["in-app", "other"],
  [null, "other"],
] as const) {
  it(`gives ${String(browser)} the ${steps} steps`, () => {
    expect(stepsBrowser({ ...IOS_SAFARI, iosBrowser: browser })).toBe(steps);
  });
}

// A phone or tablet, whatever the window width: a narrow desktop window is
// not one. Each true row has a false twin that differs in one property.
const DESKTOP_LINUX: PushEnv = {
  hasPush: true,
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  standalone: false,
};
const MAC: PushEnv = {
  ...DESKTOP_LINUX,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  platform: "MacIntel",
};
const WINDOWS: PushEnv = {
  ...DESKTOP_LINUX,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  platform: "Win32",
};
for (const [label, env, coarse, handheld] of [
  [
    "an iPhone",
    {
      ...DESKTOP_LINUX,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    false,
    true,
  ],
  // iPadOS Safari asks for desktop sites and reads as a Mac with touch.
  ["an iPad", { ...MAC, maxTouchPoints: 5 }, false, true],
  ["a Mac", MAC, false, false],
  [
    "an Android phone",
    {
      ...DESKTOP_LINUX,
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    },
    false,
    true,
  ],
  ["a Linux desktop", DESKTOP_LINUX, false, false],
  // Chrome on a large Android tablet sends a desktop user agent.
  [
    "an Android tablet with a desktop user agent",
    { ...DESKTOP_LINUX, maxTouchPoints: 5 },
    true,
    true,
  ],
  ["a Windows desktop", WINDOWS, false, false],
  // Touch points, but a mouse or trackpad is the primary pointer.
  ["a touchscreen laptop", { ...WINDOWS, maxTouchPoints: 10 }, false, false],
  ["a Windows tablet", { ...WINDOWS, maxTouchPoints: 10 }, true, true],
] as const) {
  it(`${label} is handheld: ${handheld}`, () => {
    expect(isHandheld(env, coarse)).toBe(handheld);
  });
}

// The Apps page's install link stays in the window, the Home Screen office's
// too: Safari may hold no session.
it("the Apps page's install link opens the short link with the install hash", () => {
  const SHORT = "https://office.example/loop";
  expect(appInstallHref(SHORT)).toBe(SHORT + INSTALL_HASH);
});

function installEvent(outcome: "accepted" | "dismissed") {
  const prompt = mock(async () => {});
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    { prompt, userChoice: Promise.resolve({ outcome }) },
  );
  return { event, prompt };
}

it("holds the event, prompts with it once, and drops it after the member's choice", async () => {
  const target = new EventTarget();
  captureInstallPrompt(target as unknown as Window);
  let changes = 0;
  const unsubscribe = subscribeInstallPrompt(() => changes++);
  try {
    for (const outcome of ["accepted", "dismissed"] as const) {
      const { event, prompt } = installEvent(outcome);
      const before = changes;
      target.dispatchEvent(event);
      // Without preventDefault, Chrome shows its own mini-infobar.
      expect(event.defaultPrevented).toBe(true);
      expect(heldInstallPrompt() === event).toBe(true);
      expect(changes).toBeGreaterThan(before);
      const held = changes;
      expect(await promptInstall()).toBe(outcome);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(heldInstallPrompt()).toBeNull();
      expect(changes).toBeGreaterThan(held);
      expect(await promptInstall()).toBe("unavailable");
      expect(prompt).toHaveBeenCalledTimes(1);
    }
  } finally {
    unsubscribe();
  }
});

it("drops the held event when the app is installed another way", () => {
  const target = new EventTarget();
  captureInstallPrompt(target as unknown as Window);
  let changes = 0;
  const unsubscribe = subscribeInstallPrompt(() => changes++);
  const { event, prompt } = installEvent("accepted");
  target.dispatchEvent(event);
  expect(heldInstallPrompt() === event).toBe(true);
  const before = changes;
  target.dispatchEvent(new Event("appinstalled"));
  expect(heldInstallPrompt()).toBeNull();
  expect(changes).toBeGreaterThan(before);
  expect(prompt).not.toHaveBeenCalled();
  unsubscribe();
  const after = changes;
  target.dispatchEvent(installEvent("accepted").event);
  expect(changes).toBe(after);
  target.dispatchEvent(new Event("appinstalled"));
  expect(heldInstallPrompt()).toBeNull();
});

// Chrome rejects prompt() without a user gesture or for a spent event. The
// page calls promptInstall() with void, so a rejection would go unhandled.
it("answers unavailable when the browser refuses the prompt", async () => {
  const target = new EventTarget();
  captureInstallPrompt(target as unknown as Window);
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt: mock(async () => {
        throw new DOMException("no gesture", "NotAllowedError");
      }),
      userChoice: new Promise<never>(() => {}),
    },
  );
  target.dispatchEvent(event);
  expect(await promptInstall()).toBe("unavailable");
  expect(heldInstallPrompt()).toBeNull();
});
