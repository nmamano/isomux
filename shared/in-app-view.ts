// Another app's browser (a mail or social app's in-app view), from the user
// agent. Shared by the office (ui/app-install.ts: no Add to Home Screen
// steps there) and the server (the invite page stops before Accept there,
// task 5765f58e). Pure: no window.

// The iOS browser a page runs in, from its user agent. "other": a browser
// whose menus we do not know. "in-app": another app's browser (a mail or
// social app), which has no Add to Home Screen.
export type IosBrowser =
  "safari" | "chrome" | "firefox" | "edge" | "other" | "in-app";

// A browser's own token comes first: Edge also sends Version/ and Safari/.
const IOS_BROWSER_TOKENS: readonly [RegExp, IosBrowser][] = [
  [/\bCriOS\//, "chrome"],
  [/\bFxiOS\//, "firefox"],
  [/\bEdgiOS\//, "edge"],
  [/\b(?:OPiOS|OPT|DuckDuckGo|Ddg)\//, "other"],
];

// Mail and social apps that name themselves, on iOS and Android. The Google
// app sends a Safari token, so only its own token tells it apart.
const IN_APP_TOKENS =
  /FBAN|FBAV|FBIOS|FB_IAB|\bInstagram\b|\bBarcelona\b|LinkedInApp|BytedanceWebview|musical_ly|Snapchat|\bLine\/|MicroMessenger|Pinterest|\bGSA\//;

// Every iOS browser sends a Safari/ token; a plain WKWebView sends none, so
// a user agent without one reads as an in-app view. A real browser without
// it would get "open this page in a browser" and no steps. An in-app view
// that sends Safari's user agent (SFSafariViewController, used by Gmail,
// Slack and X) reads as Safari: the page cannot tell them apart.
export function iosBrowser(userAgent: string): IosBrowser {
  for (const [token, browser] of IOS_BROWSER_TOKENS)
    if (token.test(userAgent)) return browser;
  if (IN_APP_TOKENS.test(userAgent)) return "in-app";
  return /\bSafari\//.test(userAgent) ? "safari" : "in-app";
}

// The platform of the in-app view a user agent names, or null for a browser.
// The invite page draws that platform's menu icon (••• on iOS, ⋮ on Android).
// An app's own token counts on any user agent: an iPad in-app view sends the
// Mac desktop one, which names no iPad. The no-Safari/ rule (iosBrowser)
// applies only to a user agent that names an iPhone, iPad or iPod: curl and
// desktop bots send no Safari/ token either. On Android, "; wv)" marks a
// plain WebView.
export function inAppView(userAgent: string | null): "ios" | "android" | null {
  if (!userAgent) return null;
  const android = /\bAndroid\b/.test(userAgent);
  if (android)
    return IN_APP_TOKENS.test(userAgent) || /; wv\)/.test(userAgent)
      ? "android"
      : null;
  if (/iPhone|iPad|iPod/.test(userAgent))
    return iosBrowser(userAgent) === "in-app" ? "ios" : null;
  return IN_APP_TOKENS.test(userAgent) ? "ios" : null;
}
