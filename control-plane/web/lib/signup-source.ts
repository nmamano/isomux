// The signup source: which campaign, site and first isomux.com page brought a
// visitor to the Hosted signup. isomux.com (site/analytics.js) passes it on in
// the query of its links to this app; any page here keeps the first one it sees
// in localStorage, and the signup form posts it with the reservation.
//
// localStorage, not sessionStorage: the emailed sign-in link opens in a new tab.

import type { SignupSource } from "../../signup";

/** The query parameters a link to this app may carry. */
export const SIGNUP_SOURCE_PARAMS = [
  "utm_source",
  "utm_campaign",
  "ref_host",
  "landing_path",
] as const;

export const SIGNUP_SOURCE_STORAGE_KEY = "isomux-signup-source";

/** How long the browser keeps a source before a signup uses it. */
export const SIGNUP_SOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UTM_MAX = 100;
const HOST_MAX = 253;
const PATH_MAX = 200;
// C0, DEL and C1 control characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** A campaign tag, or null. "@" is refused because a mailing tool can merge
 * the recipient's address into a tag, and no email may reach the database. */
function utmValue(raw: string | null): string | null {
  if (!raw || raw.length > UTM_MAX || CONTROL.test(raw) || raw.includes("@"))
    return null;
  return raw;
}

/** A bare host name, lowercased, or null. Never a URL. */
function hostValue(raw: string | null): string | null {
  if (!raw) return null;
  const host = raw.toLowerCase();
  return host.length <= HOST_MAX && HOST.test(host) ? host : null;
}

/** A path without its query and fragment, which can carry personal data. */
function pathValue(raw: string | null): string | null {
  if (!raw) return null;
  const path = raw.split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.length > PATH_MAX || CONTROL.test(path))
    return null;
  return path;
}

/** Validate each value by its parameter name; a refused value becomes null.
 * The server calls it again on the posted fields. */
export function parseSignupSource(
  get: (key: string) => string | null,
): SignupSource {
  return {
    utmSource: utmValue(get("utm_source")),
    utmCampaign: utmValue(get("utm_campaign")),
    referrerHost: hostValue(get("ref_host")),
    landingPath: pathValue(get("landing_path")),
  };
}

/** The referrer's host when it is a site other than isomux.com and its
 * subdomains, else null. */
function outsideHost(referrer: string): string | null {
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "isomux.com" || host.endsWith(".isomux.com")) return null;
  return hostValue(host);
}

function isEmpty(source: SignupSource): boolean {
  return Object.values(source).every((value) => value === null);
}

/** Keep the source a page's URL (or, without ref_host, its referrer) names,
 * unless an unexpired one is already stored: first touch wins. */
export function captureSignupSource(
  url: string,
  referrer: string,
  storage: Storage,
  now: number,
): void {
  if (storedSignupSource(storage, now)) return;
  let query: URLSearchParams;
  try {
    query = new URL(url).searchParams;
  } catch {
    return;
  }
  const source = parseSignupSource((key) => query.get(key));
  if (!source.referrerHost) source.referrerHost = outsideHost(referrer);
  if (isEmpty(source)) return;
  storage.setItem(
    SIGNUP_SOURCE_STORAGE_KEY,
    JSON.stringify({ at: now, source }),
  );
}

/** The stored source, or null when there is none or it expired. */
export function storedSignupSource(
  storage: Storage,
  now: number,
): SignupSource | null {
  const raw = storage.getItem(SIGNUP_SOURCE_STORAGE_KEY);
  if (!raw) return null;
  let stored: {
    at?: unknown;
    source?: Partial<Record<keyof SignupSource, unknown>>;
  };
  try {
    stored = JSON.parse(raw) as typeof stored;
  } catch {
    return null;
  }
  if (
    typeof stored?.at !== "number" ||
    now - stored.at > SIGNUP_SOURCE_TTL_MS ||
    typeof stored.source !== "object" ||
    stored.source === null
  )
    return null;
  const saved = stored.source;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  // Validated again: the browser's storage is the visitor's to edit.
  const source = parseSignupSource(
    (key) =>
      ({
        utm_source: text(saved.utmSource),
        utm_campaign: text(saved.utmCampaign),
        ref_host: text(saved.referrerHost),
        landing_path: text(saved.landingPath),
      })[key] ?? null,
  );
  return isEmpty(source) ? null : source;
}

/** The stored source as the fields the signup POST carries: none when nothing
 * unexpired is stored or the browser refuses storage. */
export function signupSourceFields(): [string, string][] {
  let source: SignupSource | null;
  try {
    source = storedSignupSource(window.localStorage, Date.now());
  } catch {
    return [];
  }
  if (!source) return [];
  const fields: [string, string | null][] = [
    ["utm_source", source.utmSource],
    ["utm_campaign", source.utmCampaign],
    ["ref_host", source.referrerHost],
    ["landing_path", source.landingPath],
  ];
  return fields.filter((field): field is [string, string] => field[1] !== null);
}
