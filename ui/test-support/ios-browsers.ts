// Real iOS user agents, one per browser or in-app view that the install steps
// tell apart (ui/app-install.ts iosBrowser, task 5765f58e). A plain module:
// pure tests import it statically.

import type { DeviceNavigator } from "./ios-home-screen.ts";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)";
const WEBKIT = "AppleWebKit/605.1.15 (KHTML, like Gecko)";

export const IOS_UA = {
  safari: `${IOS} ${WEBKIT} Version/17.4 Mobile/15E148 Safari/604.1`,
  chrome: `${IOS} ${WEBKIT} CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1`,
  firefox: `${IOS} ${WEBKIT} FxiOS/124.0 Mobile/15E148 Safari/605.1.15`,
  // Edge also sends Version/: it must not read as Safari.
  edge: `${IOS} ${WEBKIT} Version/17.0 EdgiOS/123.0.2420.56 Mobile/15E148 Safari/605.1.15`,
  opera: `${IOS} ${WEBKIT} Version/17.0 Mobile/15E148 Safari/604.1 OPT/4.5.0`,
  duckduckgo: `${IOS} ${WEBKIT} Version/17.4 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15`,
  instagram: `${IOS} ${WEBKIT} Mobile/15E148 Instagram 323.0.3.23.54 (iPhone15,2; iOS 17_4; en_US; en; scale=3.00; 1179x2556; 577210397)`,
  threads: `${IOS} ${WEBKIT} Mobile/15E148 Barcelona 289.0.0.77.109 (iPhone15,2; iOS 17_4; en_US; en; scale=3.00; 1179x2556; 497315468)`,
  facebook: `${IOS} ${WEBKIT} Mobile/15E148 [FBAN/FBIOS;FBAV/456.0.0.38.109;FBBV/612300422;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/0]`,
  linkedin: `${IOS} ${WEBKIT} Mobile/15E148 [LinkedInApp]/9.29.1234`,
  tiktok: `${IOS} ${WEBKIT} Mobile/15E148 musical_ly_33.4.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US BytedanceWebview/d8a21c6`,
  // The Google app sends a Safari token: only its own token tells it apart.
  google: `${IOS} ${WEBKIT} GSA/312.0.623353870 Mobile/15E148 Safari/604.1`,
  // A plain WKWebView, and the Home Screen app: no browser token at all.
  webview: `${IOS} ${WEBKIT} Mobile/15E148`,
  // iPadOS Safari asks for desktop sites.
  ipadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
} as const;

// An iPhone browser tab with the given user agent.
export function iphoneWith(userAgent: string): DeviceNavigator {
  return {
    userAgent,
    platform: "iPhone",
    maxTouchPoints: 5,
    standalone: false,
  };
}
