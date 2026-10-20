// Links that leave the iPhone Home Screen office for Safari.
//
// iOS keeps a link to the office's own origin inside the Home Screen window,
// even with target="_blank", and that window has no Back button. An app's own
// hostname is no better: its sign-in bounce passes through the office origin
// and lands back in the window. The x-safari-https scheme (iOS 17 and later)
// makes the system open the URL in Safari instead.

import { isIos, readPushEnv } from "./push-subscription.ts";
import { pageForPath } from "./routes.ts";

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

// The office's short link for an app: one label, as the server matches it
// (server/isomux-office.ts).
const APP_SHORT_PATH = /^\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/?$/;

// For links in chat: only an app's short link on the office's own origin is
// rewritten. An office page opens in the Home Screen window, which is where
// the member is signed in, and iOS opens any other site in its Safari sheet,
// which has a Done button.
export function safariHrefSameOrigin(
  href: string,
  env: SafariEnv,
  origin: string,
): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return href;
  if (url.origin !== origin) return href;
  if (!APP_SHORT_PATH.test(url.pathname) || pageForPath(url.pathname) !== null)
    return href;
  return safariHref(href, env);
}
