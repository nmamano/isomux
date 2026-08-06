// Host-based dispatch for registered apps (phase 3, slice 3).
//
// An office serves one hostname today. Once registered apps get stable
// origins, a second class of hostname arrives: the URL shape is FLAT, so an
// app called `hello` on an office at `office.example` answers at
// `hello.office.example`. The office and its apps are one namespace, parent
// and children, and the first thing the request handler must do is decide
// which it is looking at - because the two get entirely different treatment:
//
//   - the office's own host, or anything outside it
//                      -> return null, and the office dispatches exactly as it
//                         always has. Every existing route is downstream of
//                         this, so the fall-through is the load-bearing half.
//   - a strict child   -> this module answers, and NO office handler ever sees
//                         the request. That containment is the security
//                         property: app hostnames sit under a wildcard record,
//                         so anyone can point any name under it at this
//                         server, and none of those names may reach the
//                         office's own surface.
//
// Since slice 4 the arm also runs the sign-in handshake (server/app-auth.ts):
// a caller with a live app session reaches the app, everyone else is either
// sent through the office to get one or refused. Since slice 5 the
// authenticated branch ends in the relay (server/app-proxy.ts), so this is the
// point at which an app's own bytes finally reach a browser.
//
// WHERE THE DOMAIN COMES FROM: publicOrigin, and nothing else. No config key,
// no override, no installer-written state - if the office has an HTTPS public
// origin at a real DNS name, its children are app hostnames. The consequence,
// accepted deliberately: an operator who has some other record pointed at this
// office under that name (`www.`, `staging.`) stops getting the office there
// and gets a neutral 404, because an unknown label cannot be allowed to fall
// through to the office. Loopback and plain-HTTP offices - every dev box - get
// no app-host domain at all and are byte-identical to before this existed.

import { appRegistry as productionRegistry } from "./app-registry.ts";
import type { AppRegistry } from "./app-registry.ts";
import { appSupervisor as productionSupervisor } from "./app-supervisor.ts";
import type { AppSupervisor } from "./app-supervisor.ts";
import { relayToApp } from "./app-proxy.ts";
import { buildPublicOrigin } from "./auth.ts";
import {
  APP_AUTH_PATH,
  appHostAuthGate,
  handleAppAuthRedeem,
} from "./app-auth.ts";
import {
  NOT_READY_BODY,
  neutral,
  neutralNotFound,
} from "./app-host-responses.ts";
import type { AppRecord } from "../shared/types.ts";

// --- hostname grammar (pure) ------------------------------------------------

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

// Every code point a hostname may carry before any structural check. Anything
// outside printable ASCII - C0 controls, DEL (0x7f), and all non-ASCII
// including IDN - is refused here rather than sneaking into a label test.
// Deliberately NOT doing IDNA conversion: a non-ASCII Host can never equal an
// ASCII office host, and A-labels (`xn--...`) are already ASCII and match
// literally.
function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

// The `Host` request header, reduced to something comparable with the office
// host. Returns null when the header is absent or cannot be a hostname we
// route on - which for the dispatcher means "not ours", i.e. today's office
// behavior, never a refusal.
export function normalizeRequestHost(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!isPrintableAscii(raw)) return null;
  // Host is case-insensitive and the office host is stored lowercase, so the
  // fold happens here, once, before anything compares strings.
  let host = raw.toLowerCase();
  // An IPv6 literal arrives bracketed (`[::1]:4000`). It can never be an app
  // host, and its colons would confuse the port split below.
  if (host.startsWith("[")) return null;
  const colon = host.indexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    host = host.slice(0, colon);
    // Syntax only - the port's VALUE is irrelevant, we route on the name. An
    // empty port, a non-numeric one, or a second colon is a malformed Host.
    if (!/^[0-9]+$/.test(port)) return null;
  }
  // Exactly one trailing dot (the FQDN form). `name..` keeps an empty label
  // and is rejected by isHostname.
  if (host.endsWith(".")) host = host.slice(0, -1);
  return isHostname(host) ? host : null;
}

// --- the app-host domain (pure) -------------------------------------------------

// Hostnames app hostnames cannot hang off: loopback names (a `.localhost`
// suffix is loopback by RFC 6761, not just the bare name) and address
// literals. `URL.hostname` exposes an IPv6 literal bracketed.
function isLoopbackOrLiteral(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.startsWith("[")) return true;
  if (/^[0-9]+(?:\.[0-9]+){3}$/.test(hostname)) return true;
  return false;
}

// The office's own hostname, and therefore the domain its apps hang off.
// Null means this office has no app hostnames at all.
//
// Gated on HTTPS because that is what an office reachable at a real name looks
// like: app hostnames need a wildcard DNS record and a certificate, and
// neither exists for `localhost`, a bare address, or a plain-HTTP dev bind.
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
  // Dotted name required: a single-label office host is an intranet name that
  // cannot carry a public wildcard record.
  return isHostname(host, 2) ? host : null;
}

// --- the boot-frozen value --------------------------------------------------

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

// --- host matching (pure) ---------------------------------------------------

export type AppHostMatch =
  // Exactly one label below the office host: a candidate app.
  | { kind: "label"; label: string }
  // More than one label below it. Diverted like any other app host - it is
  // inside the wildcard - but it can never name an app.
  | { kind: "under" };

// `host` must already be through normalizeRequestHost: everything compared
// here is a canonical lowercase name with no port and no trailing dot.
export function matchAppHost(
  host: string,
  domain: string,
): AppHostMatch | null {
  // ONLY strict children divert. That single test is also what keeps the
  // office reachable: the office host IS the domain, and a string never ends
  // with a longer string, so the office can never match here. There is no
  // separate exemption for it because there is nothing to exempt - which is
  // worth knowing before anyone adds one back and assumes it is load-bearing.
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, host.length - domain.length - 1);
  if (label.length === 0 || label.includes(".")) return { kind: "under" };
  // No exception list here, deliberately. A name that cannot be REGISTERED as
  // an app (the registry's reserved list) does not therefore route to the
  // office: registry refusal and HTTP routing are separate invariants, and an
  // unknown label reaching the office is the hole this arm exists to close.
  return { kind: "label", label };
}

// --- the arm ----------------------------------------------------------------

// Reserved on every app host from day one: the auth handshake mounts here
// (slice 4), and the relay must never be able to serve or shadow it.
// Structural, so the check cannot be forgotten later - the relay, when it
// exists, plugs in BELOW this branch.
export const APP_RESERVED_PATH = "/__isomux";

// Every body this arm can produce lives in app-host-responses.ts, shared with
// the handshake, so "externally indistinguishable" is one set of bytes rather
// than two literals that could drift.

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

// What the arm needs from the process around it. The SUPERVISOR is the reason
// this is an object rather than a bare registry argument: systemd is
// machine-global, so the arm has to use the instance the server was started
// with (a fake, under `bun test`) and never the production singleton.
export interface AppHostDeps {
  registry?: AppRegistry;
  supervisor?: AppSupervisor;
  // The TCP peer of the office's listener, for X-Forwarded-For, read only if a
  // request is actually relayed. See the relay for why that is the only address
  // it can honestly claim.
  peer?: () => string | null | undefined;
}

// The office's request entry point calls this FIRST, before the URL is parsed
// and before any route runs.
//
//   null      -> not an app host. Fall through to the office, unchanged.
//   Response  -> diverted. The office handler must not run.
//
// The order of the checks below is load-bearing:
//
//   1. multi-label host               -> 404
//   2. no live app with that label    -> the SAME 404, whether the label was
//      never issued or was retired. Those two must be indistinguishable: a
//      retired label is a name somebody used to have, and the difference is
//      not the internet's business.
//   3. WebSocket upgrade              -> refused HERE, deliberately (slice 6
//      relays it). Refusing by falling through would hand a diverted host to
//      the office's own /ws handler, which is the one thing that must be
//      impossible. Refused BEFORE the auth gate, and identically with or
//      without a session: an upgrade cannot follow a redirect, so bouncing one
//      into the handshake would only turn a clear refusal into a broken one.
//   4. the handshake's own path       -> redeem a sign-in code. Everything
//      else under the reserved prefix, including any other method on this
//      path, is the 404: an app never sees a reserved path, and the relay
//      (slice 5) plugs in below this branch.
//   5. no live app session            -> a request that could complete the
//      handshake is sent through the office to get one; anything else is
//      refused (mayInitiateHandshake). Runs AFTER the label
//      and reserved checks so an anonymous caller cannot learn anything about
//      a label from the shape of the auth response.
//   6. authenticated                  -> the relay (slice 5): the app's own
//      bytes, or one of its three refusals.
//
// DELIBERATELY NOT `async`. Only the diverted path returns a promise; the
// office's own path - every request of every install without app hostnames -
// stays synchronous, and the caller awaits what it gets back.
export function handleAppHostRequest(
  req: Request,
  deps: AppHostDeps = {},
): Response | Promise<Response> | null {
  const domain = appHostDomain();
  if (domain === null) return null;

  const host = normalizeRequestHost(req.headers.get("host"));
  if (host === null) return null;

  const match = matchAppHost(host, domain);
  if (match === null) return null;

  // Everything below here is DIVERTED. No office handler sees this request.
  if (match.kind === "under") return neutralNotFound();

  // ONE snapshot, used for both questions asked of the registry: which app owns
  // this label, and (in the relay) which names to ask the supervisor about. A
  // second read would be a second answer.
  const registry = deps.registry ?? productionRegistry;
  let apps: readonly AppRecord[];
  try {
    apps = registry.list();
  } catch (err) {
    // A registry that cannot be read cannot vouch for a label. Fail closed:
    // the same 404 an unknown label gets, never an app.
    console.error("[app-hosts] app registry unreadable; refusing host:", err);
    return neutralNotFound();
  }
  // The app record, not just a boolean: the handshake binds a session to the
  // app's issuance TUPLE (label + generation), which is what the registry
  // treats as an app's identity.
  const app = apps.find((a) => a.hostLabel === match.label) ?? null;
  if (app === null) return neutralNotFound();

  if (isWebSocketUpgrade(req)) return neutral(503, NOT_READY_BODY);

  const { pathname } = new URL(req.url);
  if (
    pathname === APP_RESERVED_PATH ||
    pathname.startsWith(`${APP_RESERVED_PATH}/`)
  ) {
    if (pathname === APP_AUTH_PATH && req.method === "GET") {
      return handleAppAuthRedeem(req, { host, app });
    }
    return neutralNotFound();
  }

  const gate = appHostAuthGate(req, { host, app });
  if (gate !== null) return gate;

  return relayToApp(req, {
    app,
    host,
    apps,
    supervisor: deps.supervisor ?? productionSupervisor,
    peer: deps.peer,
  });
}
