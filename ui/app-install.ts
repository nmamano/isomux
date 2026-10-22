// "Install as app" for the office and for an app's short-link page.
//
// Chromium browsers fire beforeinstallprompt when the page links a manifest it
// can install, and the held event's prompt() shows the browser's own install
// dialog. iOS has no such event: no page can install itself there, so the
// page shows the Share > Add to Home Screen steps instead.

import { isIos, readPushEnv } from "./push-subscription.ts";
import { safariHref, type SafariEnv } from "./safari-link.ts";

// The hash the Apps page adds to the short link: the page opens its install
// popover on load.
export const INSTALL_HASH = "#install";

export interface InstallEnv {
  ios: boolean;
  // The page runs in a Home Screen or installed-app window.
  standalone: boolean;
  // The browser has the beforeinstallprompt event (Chromium).
  promptSupported: boolean;
}

export type InstallMode = "prompt" | "ios-steps" | null;

// The Chromium event; not in the DOM typings.
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function readInstallEnv(): InstallEnv {
  // A pure test file has no window: it reads as a browser that cannot install.
  if (typeof window === "undefined")
    return { ios: false, standalone: false, promptSupported: false };
  const env = readPushEnv();
  return {
    ios: isIos(env),
    standalone: env.standalone,
    promptSupported: "onbeforeinstallprompt" in window,
  };
}

// What the page's Install button does here, given whether an event is held.
export function installMode(env: InstallEnv, held: boolean): InstallMode {
  if (env.standalone) return null;
  if (env.ios) return "ios-steps";
  return env.promptSupported && held ? "prompt" : null;
}

// Whether the Apps page offers "Install as app" in this browser. The iPhone
// Home Screen office counts: the item opens the page in Safari.
export function canOfferInstall(env: InstallEnv): boolean {
  return env.ios || env.promptSupported;
}

// Where the Apps page's item goes: the short link with INSTALL_HASH, through
// Safari on the iPhone Home Screen office.
export function appInstallHref(shortUrl: string, env: SafariEnv): string {
  return safariHref(shortUrl + INSTALL_HASH, env);
}

let held: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function setHeld(event: BeforeInstallPromptEvent | null): void {
  held = event;
  for (const listener of listeners) listener();
}

// Starts holding beforeinstallprompt and listening for appinstalled. Called
// once from ui/index.tsx, before render: the event can fire before React
// mounts. On the office page the held event serves the office's own Install
// as app (OfficeInstallNotice, the phone menu, Settings > Device label).
export function captureInstallPrompt(target: Window = window): void {
  target.addEventListener("beforeinstallprompt", (event) => {
    // Without this, Chrome shows its own install bar.
    event.preventDefault();
    setHeld(event as BeforeInstallPromptEvent);
  });
  target.addEventListener("appinstalled", () => setHeld(null));
}

export function heldInstallPrompt(): BeforeInstallPromptEvent | null {
  return held;
}

// Calls the listener when the held event changes (arrives, is used, or the
// app is installed). Returns the unsubscribe.
export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Shows the browser's install dialog with the held event and drops it: an
// event prompts only once.
export async function promptInstall(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  const event = held;
  if (!event) return "unavailable";
  setHeld(null);
  try {
    await event.prompt();
    return (await event.userChoice).outcome;
  } catch {
    // Chrome refuses prompt() without a user gesture or for a spent event.
    return "unavailable";
  }
}

// Whether the office shows its one-time "Install as app" notice: in a phone
// browser that can install the office, on a device that has not seen it.
export function showOfficeInstallNotice(
  env: InstallEnv,
  held: boolean,
  isMobile: boolean,
  seen: boolean,
): boolean {
  return isMobile && !seen && installMode(env, held) !== null;
}

let stepsOpen = false;
const stepsListeners = new Set<() => void>();

function setStepsOpen(open: boolean): void {
  stepsOpen = open;
  for (const listener of stepsListeners) listener();
}

// The phone menu's "Install as app" on iPhone opens the notice with the
// steps, whether or not the device has seen it.
export function openOfficeInstallSteps(): void {
  setStepsOpen(true);
}

export function closeOfficeInstallSteps(): void {
  setStepsOpen(false);
}

export function officeInstallStepsOpen(): boolean {
  return stepsOpen;
}

// Calls the listener when the steps open or close. Returns the unsubscribe.
export function subscribeOfficeInstallSteps(listener: () => void): () => void {
  stepsListeners.add(listener);
  return () => {
    stepsListeners.delete(listener);
  };
}
