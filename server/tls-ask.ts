// The local app-host gate.
//
// App hostnames sit under a wildcard DNS record, so the terminator cannot know
// in advance which names it will be asked to serve, and its site block for them
// terminates TLS ON DEMAND. That turns every name anyone points at this box
// into a potential certificate request, which is exactly the shape a CA rate
// limits you for. Caddy's answer is the `ask` endpoint: a GET with
// `?domain=<name>`, and it proceeds only on a 2xx. This module is that
// endpoint's policy.
//
// MEASURED, and it decides the whole design (Caddy 2.11.4, on the test box):
// the endpoint is consulted before a certificate is obtained AND before one
// already in storage is loaded - so after a terminator restart every live name
// is asked about again, in one burst. A refusal at that moment refuses the TLS
// handshake even though a valid certificate exists. It is therefore a live
// access gate, not an issuance hook, and any policy that can run out of budget
// for an established app is an outage waiting for the next restart. Two
// consequence runs through everything below: the answer is only whether the
// label belongs to a live app. It has no issuance budget.
//
// The other measured caveat, stated because it is invisible otherwise: a
// refusal cannot reach a certificate the terminator already holds in memory.
// Cutting a label off - deleting its app - takes effect at the next cold load,
// not immediately.
//
// Fail-closed, like the rest of the app-host surface. What passes: the office's
// own host, and a live app's label. The persisted admission stamp remains for
// rollback compatibility with releases where this gate controlled on-demand
// certificate loading. Hosted wildcard TLS makes it a request gate instead, so
// it has no issuance budget or arbitrary per-hour cap. Everything else is
// refused.

import { matchAppHost, normalizeRequestHost } from "./app-hosts.ts";

// Where the office answers. Under the same prefix the app-host arm reserves, so
// the one namespace an app can never claim is also where the office keeps its
// machine-facing routes. The terminator reaches this over loopback and never
// through a site block, which is why the managed Caddyfile can refuse this
// exact path at the edge - see deploy/install.sh.
export const TLS_ASK_PATH = "/__isomux/tls-ask";

export type TlsAskDecision = "allow" | "deny";

export interface TlsAskDeps {
  // The office's app-host domain, boot-frozen. Null on an office that has none,
  // which refuses everything.
  domain: string | null;
  isLive: (label: string) => boolean;
}

// The policy is read-only. A stranger pointing names at this box cannot cause
// a write and cannot tell from the answer
// whether a label was never issued or was somebody's app last week.
export function decideTlsAsk(
  rawName: string | null,
  deps: TlsAskDeps,
): TlsAskDecision {
  if (deps.domain === null || rawName === null) return "deny";
  // The same normalization the dispatcher applies to a request's Host, so one
  // piece of code decides both which names can get a certificate and which
  // names route to an app. A name that could not be routed must not be able to
  // be certified.
  const name = normalizeRequestHost(rawName);
  if (name === null) return "deny";

  // The office's own host. Its certificate comes from the terminator's ordinary
  // managed site block - measured: the gate is never asked about it - so this
  // arm only matters on a deployment that serves the office through the
  // wildcard. Approved without touching the registry: it is one name, it is
  // ours, and it is not an app admission.
  if (name === deps.domain) return "allow";

  const match = matchAppHost(name, deps.domain);
  // Outside the domain, or more than one label below it. Neither can ever be an
  // app.
  if (match === null || match.kind === "under") return "deny";

  return deps.isLive(match.label) ? "allow" : "deny";
}

// Bodies are machine-facing - the terminator reads the status code and nothing
// else. no-store because the answer is a function of the registry, and
// a cached "ok" would outlive the app it vouched for.
export function tlsAskResponse(decision: TlsAskDecision): Response {
  const [status, body] =
    decision === "allow" ? [200, "ok\n"] : [403, "denied\n"];
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function handleTlsAsk(url: URL, deps: TlsAskDeps): Response {
  // EXACTLY ONE non-empty `domain`. Zero, empty, or repeated is a request whose
  // subject is ambiguous, and answering the first of two names is how a gate
  // ends up vouching for the other one. Other parameters are ignored: the
  // terminator is free to add its own and none of them are the subject.
  const names = url.searchParams.getAll("domain");
  if (names.length !== 1 || names[0].length === 0) {
    return tlsAskResponse("deny");
  }
  try {
    return tlsAskResponse(decideTlsAsk(names[0], deps));
  } catch (err) {
    // A registry that cannot be read cannot vouch for a label. A wholly
    // unreadable apps.json therefore refuses established labels too, and an
    // office that cannot read its own state should not be certifying names.
    // Logged internally; the caller learns only that the answer is no, because
    // the health of our storage is not the internet's business.
    console.error(
      "[tls-ask] refusing: the app registry could not answer:",
      err,
    );
    return tlsAskResponse("deny");
  }
}
