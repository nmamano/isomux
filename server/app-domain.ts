// Where an app's public address comes from: the office's own
// hostname, the grammar that decides whether it can carry app hostnames at
// all, and the URL an app is reachable at.
//
// Split out of app-hosts.ts in slice 8 for one concrete reason: the supervisor
// has to know an app's URL to write it into the app's unit, and app-hosts.ts
// imports the supervisor (its arm proves an app is active before relaying to
// it). Importing back would make a cycle. Everything here is a leaf - pure
// functions plus one boot-frozen value - so both the request side and the
// supervisor side can depend on it and neither depends on the other.

import { buildPublicOrigin } from "./auth.ts";

// RFC 1035 label and name ceilings. The label pattern is the one the app
// registry holds app names to (server/app-registry.ts), because an app's name
// becomes its hostname label.
const MAX_HOST_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isHostLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= MAX_HOST_LABEL_LENGTH &&
    HOST_LABEL_PATTERN.test(label)
  );
}

// A lowercase LDH hostname: one or more valid labels, no trailing dot, within
// the name ceiling. `minLabels` lets a caller demand a dotted name.
export function isHostname(host: string, minLabels = 1): boolean {
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = host.split(".");
  if (labels.length < minLabels) return false;
  return labels.every(isHostLabel);
}

// Hostnames app hostnames cannot hang off: loopback names (a `.localhost`
// suffix is loopback by RFC 6761, not just the bare name) and address
// literals. `URL.hostname` exposes an IPv6 literal bracketed.
function isLoopbackOrLiteral(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.startsWith("[")) return true;
  if (/^[0-9]+(?:\.[0-9]+){3}$/.test(hostname)) return true;
  return false;
}

// Tailscale's MagicDNS namespace, which is a separate refusal from the one
// above: a name like `auntie.parrot-fish.ts.net` is real and resolvable, and
// an office served there is genuinely on HTTPS. What it cannot do is carry
// CHILDREN - MagicDNS has no wildcard records and a Tailscale certificate
// covers the node's own name only - so deriving a domain here would hand every
// app an address that resolves nowhere and put that address in its
// environment. A tailnet office keeps port links instead.
//
// Matched on the LABEL boundary, so `myts.net` and `ts.net.example.com` are
// ordinary domains. Matched AFTER the URL parse, which is what makes it hold
// against the spellings a string check on the origin would miss: `URL`
// lowercases, and its IDNA mapping folds the fullwidth form (`ｔｓ.ｎｅｔ`) to
// `ts.net` before this ever sees it.
const TAILNET_SUFFIX = "ts.net";

function isTailnetName(hostname: string): boolean {
  return hostname === TAILNET_SUFFIX || hostname.endsWith(`.${TAILNET_SUFFIX}`);
}

// The office's own hostname, and therefore the domain its apps hang off.
// Null means this office has no app hostnames at all.
//
// Gated on HTTPS because that is what an office reachable at a real name looks
// like: app hostnames need a wildcard DNS record and a certificate, and
// neither exists for `localhost`, a bare address, or a plain-HTTP dev bind.
// HTTPS is necessary and not sufficient - a tailnet name is the one office
// host that passes it and still cannot have children (see isTailnetName).
// `URL` lowercases the host but KEEPS a trailing dot, so it is stripped here -
// this value is compared against normalized request Hosts on every request.
export function deriveAppHostDomain(
  officeOrigin: string,
  isHttps: boolean,
): string | null {
  if (!isHttps) return null;
  let parsed: URL;
  try {
    parsed = new URL(officeOrigin);
  } catch {
    return null;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || isLoopbackOrLiteral(host)) return null;
  if (isTailnetName(host)) return null;
  // Dotted name required: a single-label office host is an intranet name that
  // cannot carry a public wildcard record.
  return isHostname(host, 2) ? host : null;
}

// The address an app answers at, or null when this office has no app
// hostnames. DERIVED, never stored: it is a function of the office's public
// origin and the app's issued label, and both of those already have a home.
//
// The LABEL, not the name. A name is reusable and a label is not, so an app
// registered under a name somebody used before is `hello-g2.office.example`
// while its name is still `hello` - which is the entire point of the ledger,
// and the one place where using the friendlier-looking field would hand a new
// app the previous one's origin.
export function appPublicUrl(
  hostLabel: string,
  domain: string | null,
): string | null {
  if (domain === null) return null;
  return `https://${hostLabel}.${domain}`;
}

let frozenDomain: string | null = null;
let frozen = false;

// Called from bootPrelude, after freezeBootState (which is what makes
// buildPublicOrigin answer for this boot). Frozen for the process lifetime
// like the origin it reads: editing office-config.json under a running office
// changes nothing until the next restart, so routing cannot shift mid-flight.
export function freezeAppHostDomain(): void {
  const { origin, isHttps } = buildPublicOrigin();
  frozenDomain = deriveAppHostDomain(origin, isHttps);
  frozen = true;
}

export function appHostDomain(): string | null {
  // Deliberately NOT a lazy freeze. Resolving on demand would look like a
  // harmless fallback and is the opposite: before freezeBootState runs,
  // buildPublicOrigin answers with its strict pre-boot default (loopback, not
  // HTTPS), so an accidental early call would cache `null` for the life of the
  // process and silently turn app hostnames off on a deployment that has them
  // - healthy-looking, and wrong. There is one legal lifecycle and the only
  // production caller is downstream of bootPrelude, so a violation is a bug in
  // the boot order and should say so.
  if (!frozen) {
    throw new Error(
      "appHostDomain() called before freezeAppHostDomain(); the app-host " +
        "domain is resolved in bootPrelude, after the boot state is frozen",
    );
  }
  return frozenDomain;
}

export function _testResetAppHostDomain(): void {
  frozenDomain = null;
  frozen = false;
}
