// The links that leave the iPhone Home Screen office for the member's
// browser. "Open in Safari" under the app page's "Install as app" goes to
// Safari, because Add to Home Screen is in a browser's Share menu. The
// elevator's rides go to Safari or Chrome, by the member's choice, because the
// window the app opens for another office does not hold that office's sign-in
// (task 67fa3634). Other links stay in the window, which holds the session
// (task 79beacd9). The x-safari-https scheme (iOS 17 and later) makes the
// system open the URL in Safari; googlechromes opens it in Chrome.

import { isIos, readPushEnv } from "./push-subscription.ts";

export interface SafariEnv {
  ios: boolean;
  standalone: boolean;
  // The iOS major version from the user agent; null when the user agent does
  // not state one (iPadOS reports itself as a Mac).
  iosMajor: number | null;
}

export function readSafariEnv(): SafariEnv {
  // A pure test file has no window: it reads as a browser that is not iOS.
  if (typeof window === "undefined")
    return { ios: false, standalone: false, iosMajor: null };
  const env = readPushEnv();
  // "iPhone OS 17_4" or "CPU OS 18_1". A Mac's "Mac OS X 10_15_7" has no
  // digit after "OS ", so it never reads as iOS 10.
  const version = /\bOS (\d+)_/.exec(env.userAgent);
  return {
    ios: isIos(env),
    standalone: env.standalone,
    iosMajor: version ? Number(version[1]) : null,
  };
}

// True where a link can leave for a browser: the Home Screen app on iOS 17
// or later.
export function floorBrowserApplies(env: SafariEnv): boolean {
  if (!env.ios || !env.standalone) return false;
  // Older iOS has no x-safari scheme: the link would do nothing.
  return env.iosMajor === null || env.iosMajor >= 17;
}

export function safariHref(href: string, env: SafariEnv): string {
  if (!floorBrowserApplies(env)) return href;
  if (!href.startsWith("https://") && !href.startsWith("http://")) return href;
  return "x-safari-" + href;
}

export type FloorBrowser = "safari" | "chrome";

// A ride to another office: in Safari or Chrome from the Home Screen app,
// else the address as it is. The path, query and fragment go through as they
// are.
export function floorHref(
  url: string,
  env: SafariEnv,
  browser: FloorBrowser,
): string {
  if (browser === "safari") return safariHref(url, env);
  if (!floorBrowserApplies(env)) return url;
  if (url.startsWith("https://"))
    return "googlechromes://" + url.slice("https://".length);
  if (url.startsWith("http://"))
    return "googlechrome://" + url.slice("http://".length);
  return url;
}
