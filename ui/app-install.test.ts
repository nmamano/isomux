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
  promptInstall,
  subscribeInstallPrompt,
  type InstallEnv,
} from "./app-install.ts";

const CHROME: InstallEnv = {
  ios: false,
  standalone: false,
  promptSupported: true,
};
const CHROME_APP: InstallEnv = { ...CHROME, standalone: true };
const IOS_SAFARI: InstallEnv = {
  ios: true,
  standalone: false,
  promptSupported: false,
};
const IOS_HOME: InstallEnv = { ...IOS_SAFARI, standalone: true };
const FIREFOX: InstallEnv = {
  ios: false,
  standalone: false,
  promptSupported: false,
};

for (const [label, env, held, mode] of [
  ["Chrome with an event", CHROME, true, "prompt"],
  // No event yet, already installed, or the engagement rule: nothing to click.
  ["Chrome with no event", CHROME, false, null],
  ["an installed Chrome window", CHROME_APP, false, null],
  ["iPhone Safari", IOS_SAFARI, false, "ios-steps"],
  // Already on the Home Screen: there is nothing left to install.
  ["an iPhone Home Screen window", IOS_HOME, false, null],
  ["Firefox", FIREFOX, false, null],
] as const) {
  it(`the short-link page offers ${String(mode)} in ${label}`, () => {
    expect(installMode(env, held)).toBe(mode);
  });
}

for (const [label, env, offered] of [
  ["Chrome", CHROME, true],
  ["iPhone Safari", IOS_SAFARI, true],
  // The iPhone Home Screen office sends the member to Safari, where Add to
  // Home Screen runs.
  ["the iPhone Home Screen office", IOS_HOME, true],
  ["Firefox", FIREFOX, false],
] as const) {
  it(`the Apps page offers install in ${label}: ${offered}`, () => {
    expect(canOfferInstall(env)).toBe(offered);
  });
}

const SHORT = "https://office.example/loop";
for (const [label, env, href] of [
  [
    "a browser",
    { ios: false, standalone: false, iosMajor: null },
    SHORT + INSTALL_HASH,
  ],
  [
    "iPhone Safari",
    { ios: true, standalone: false, iosMajor: 17 },
    SHORT + INSTALL_HASH,
  ],
  [
    "the iPhone Home Screen office",
    { ios: true, standalone: true, iosMajor: 17 },
    "x-safari-" + SHORT + INSTALL_HASH,
  ],
  // No x-safari scheme before iOS 17: the plain link at least does something.
  [
    "the iPhone Home Screen office on iOS 16",
    { ios: true, standalone: true, iosMajor: 16 },
    SHORT + INSTALL_HASH,
  ],
] as const) {
  it(`the Apps page's install link from ${label}`, () => {
    expect(appInstallHref(SHORT, env)).toBe(href);
  });
}

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
