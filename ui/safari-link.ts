// The one link that leaves the iPhone Home Screen office for Safari: "Open in
// Safari" under the app page's "Install as app", because Add to Home Screen is
// in a browser's Share menu. Other links stay in the window, which holds the
// session (task 79beacd9). The x-safari-https scheme (iOS 17 and later) makes
// the system open the URL in Safari.

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

export function safariHref(href: string, env: SafariEnv): string {
  if (!env.ios || !env.standalone) return href;
  // Older iOS has no x-safari scheme: the link would do nothing.
  if (env.iosMajor !== null && env.iosMajor < 17) return href;
  if (!href.startsWith("https://") && !href.startsWith("http://")) return href;
  return "x-safari-" + href;
}
