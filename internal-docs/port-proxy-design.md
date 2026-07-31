# Reaching agent-built web apps on a hosted box

> Status: design, not implemented (2026-07-29). Author: Isomuxer3, reviewed by
> Reviewer3. Task: 99023cdd.
> Companion reading: `hosted-isomux-design.md` (the hosted product this must fit),
> `deploy/install.sh` (Caddy + ufw setup), `server/preview-capture.ts` (the
> existing non-interactive answer).

## Problem

An agent runs `bun dev` on :5173 and tells the boss to open it. On auntie that
works: tailscale makes every port on the box reachable from the boss's devices.
On a VPS install it does not - `configure_firewall` allows 80, 443 and SSH only,
and Caddy proxies exactly one thing (`$DOMAIN -> 127.0.0.1:4000`). The boss can
get a screenshot via `preview-url`, but cannot click anything.

## Options

**A. SSH tunnel, documented.** `ssh -L 5173:localhost:5173 root@box`, then open
`http://localhost:5173`. Zero code, zero exposure, full interactivity. Costs: a
terminal on the boss's machine, SSH enabled on the box (opt-in per the hosted
design), and no phone story.

**B. Subpath on the office origin** (`https://office.example.com/app/5173/...`).
Rejected on two independent grounds:

- _Auth blast radius._ Same origin means the boss's `isomux_session` cookie
  (`Path=/`, host-only) is sent to the agent's app on every request, and any
  script the app loads can call the office API as the boss with a matching
  `Origin` header. A dependency in a scratch dev app becomes office takeover.
  Stripping the cookie on the way out fixes half of it; the same-origin fetch
  path is unfixable.
- _It does not work._ Dev servers assume they own the root. Vite serves
  `/src/main.tsx`, the HMR socket connects to a fixed path, SPA routers push
  absolute paths.

The same objection applies to a shared `apps.<office>` host with per-port
prefixes: separate origin fixes the cookie problem, path rewriting still breaks.

**C. Per-share subdomain proxied by isomux.** Apps see themselves at the root,
so nothing breaks, and a separate origin keeps the office cookie out of reach.
Needs a wildcard DNS record, a cert story, an auth handshake, and the
prerequisite below. This is the real feature.

**D. Third-party tunnel per app** (cloudflared, ngrok, Funnel). Another account
and daemon, publishing to the whole internet with the vendor's auth. Fine as
something a boss chooses; not something isomux should build on.

**E. Open the port in ufw.** No TLS, no auth, and the firewall becomes mutable
state agents poke at. No.

## Recommendation

Ship **A now, C when hosted goes live** - and not before the prerequisite lands.

A is a docs change (`docs/vps-install.md`) plus a line in the agent system
prompt, so agents suggest the tunnel instead of handing out a `localhost:5173`
URL that will not resolve from the boss's browser. That is the whole answer for
a laptop.

C is what works from a phone and for an invited office member who will never
open a terminal. Build it when the hosted control plane can provision the
wildcard DNS record and certificate; self-hosted keeps it opt-in.

## Prerequisite: retire the loopback-trusted legacy routes

**DONE 2026-07-30** (task c31aa079): the three prefixes and the Caddy admin API
listener are gone. What follows is the reasoning as written when it still blocked
C.

**This blocks C.** isomux treats any loopback caller as authenticated on three
path prefixes - `/tasks`, `/cronjobs` (read-only) and `/backup/status`
(`isomux-office.ts`, `isAgentApiPath`). Refusing to point a share at port 4000
does not contain that: the shared app itself sits on loopback, so an open-proxy
or SSRF bug anywhere in it lets a remote browser reach those routes in two hops,
and the final socket cannot tell who the original caller was. Port denial only
blocks the direct version.

The fix is already scoped in-tree ("a separate later milestone" per the comment
at the dispatch site) and is cheap: bearer-gated `/api/tasks`, `/api/cronjobs`
and `/api/backup/status` equivalents already exist and are what agents are told
to call. Retiring the unprefixed aliases - or requiring bearer identity on them
- removes the bypass rather than fencing it. Note the legacy `/tasks` surface
also answers CORS preflight with `Access-Control-Allow-Origin: *`, which is its
own reason to retire it.

The alternative containment - running shared apps in a network namespace that
cannot reach loopback listeners - is more work and constrains what agents can
build. Prefer removing the bypass.

Caddy's admin API (2019) is the same shape of hazard; bind it to a unix socket
or disable it in the installer's Caddyfile.

## How C works

### Hostnames are per share and never recycled

Each share gets a fresh unguessable hostname, `<agent>-<random>.apps.<office>`,
retired for good when the share ends.

The tempting optimization - one stable hostname per agent, with the share record
holding the current port - is wrong. Browsers key security state to the origin,
not to isomux's notion of a share. An app that once ran at `alice.apps...` can
leave behind cookies, localStorage, caches, and above all a `/`-scoped service
worker that keeps controlling navigations and fetches for that origin. Point the
hostname at an unrelated app later and the old worker can observe or rewrite it,
and can issue requests carrying the new app cookie even though it cannot read
it. Revoking the share server-side does not reach a browser that is offline or
simply absent, and `Clear-Site-Data` cannot be relied on to land before reuse.
Recycling would only be defensible if every app an agent ever shares were
mutually trusted, which is the opposite of the scratch-dev-app case this exists
for.

The random label is defense in depth, not the auth boundary - capability URLs
leak through history, chat logs and `Referer`. The handshake below is the
boundary.

### TLS, which the hostname lifecycle decides

Unique hostnames mean certificate cardinality scales with shares created, and
that splits the two deployments:

**Hosted: one wildcard certificate per customer, issued centrally.** Let's
Encrypt caps new certificates per registered domain, and every customer office
lives under the single registered domain `isomux.app` - so on-demand
per-hostname issuance would spend the whole fleet's budget on app shares. A
wildcard per customer does not buy each customer an independent budget; it
bounds issuance to customer onboarding instead of app sharing, which is the
difference between a limit nobody notices and one a single dev loop can exhaust.
Check the CA's current limits at implementation time rather than coding to a
number - they move. The control plane already holds DNS credentials for
`isomux.app`, so it should issue `*.apps.<name>.isomux.app` by DNS-01 centrally
and push the cert and key to the box, where Caddy just loads them:

```
*.apps.<name>.isomux.app {
	tls /etc/caddy/apps-cert.pem /etc/caddy/apps-key.pem
	reverse_proxy 127.0.0.1:4000
}
```

Issuing centrally rather than on the box matters twice: it keeps DNS API
credentials for `isomux.app` off customer machines, where they would be a
fleet-wide blast radius, and it avoids needing a custom Caddy build with a DNS
provider module on every box. Submitting `isomux.app` to the Public Suffix List
gives each customer their own rate-limit budget and their own cookie boundary,
which is the standard answer for this shape of multi-tenant naming - and it is a
scaling prerequisite, not a cleanup: without it, fleet onboarding is capped at
the shared per-registered-domain issuance rate.

**Self-hosted: on-demand TLS**, since a self-hoster's own domain has its own
budget and no DNS credentials are in play:

```
{
	on_demand_tls {
		ask http://127.0.0.1:4000/internal/tls-ask
	}
}

*.apps.office.example.com {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:4000
}
```

Both halves are required: the global policy names the ask endpoint, and
`tls { on_demand }` in the site block makes Caddy issue a per-hostname cert at
handshake instead of trying to get a wildcard cert for the site's wildcard
address. The ask endpoint is a purpose-built domain predicate - an indexed
lookup against the active share table, not a generic loopback-authenticated
route - because Caddy calls it on every unknown SNI. Set `strict_sni_host` so
SNI and Host cannot disagree. Cap concurrent and newly created shares, and
document the CA limit; a boss who burns the weekly budget on a dev loop gets a
confusing TLS failure otherwise.

Both need a wildcard A record (`*.apps.<office>`), provisioned by the control
plane or added by hand.

### Auth handshake

The office session cookie is host-only, so it never reaches the app subdomain.
Each share gets its own cookie, minted through the office origin:

1. Boss opens `https://alice-7f3c9d.apps.office.example.com/some/path`. No app
   cookie.
2. isomux redirects to the office origin, carrying the requested path:
   `https://office.example.com/auth/app?h=<host>&r=<path>`. This is the only
   place the path travels in a URL - it has to cross origins somehow.
3. The office endpoint requires a live session plus access to the sharing
   agent's room. It validates `r`, stores it server-side with a freshly minted
   single-use code, and redirects to
   `https://alice-7f3c9d.apps.office.example.com/__isomux/auth?c=<code>` - code
   only, no path.
4. isomux redeems the code, sets a host-only cookie on that subdomain, and
   redirects to the stored path.
5. Later requests carry the app cookie, are stripped of it, and are relayed.

Invariants, all of them load-bearing:

- Code: >=128 bits of randomness, hashed if persisted, 30-60s expiry, atomically
  single-use, bound to the exact normalized hostname, the share's id and
  generation, and the redeeming session. Invalidated when the share is revoked
  or recreated.
- `r` is validated as a same-host absolute path - reject `//`, backslashes and
  control characters - before it is stored, and never appears in the callback.
- App cookie: `__Host-isomux_app`, `Secure`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`, host-only, TTL capped by the share's remaining life. The cookie
  itself is bound to share id, generation and user session, and is rejected
  after revoke or recreate - so the relay's validation model does not depend on
  hostnames being unique.
- Handshake responses carry `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`. Codes never reach logs. Mint and redeem are
  rate-limited.
- `/__isomux/*` is reserved and intercepted before proxying, so the app can
  never serve or shadow it.
- Host matching happens ahead of the ordinary office dispatch, against an exact
  allowlist, after normalizing port, trailing dot and IDNA.

### Relay requirements

Not a `fetch` passthrough. Stream request and response bodies with cancellation
and backpressure; cap size, time and concurrency per share; strip hop-by-hop
headers; set `Host` and `X-Forwarded-*` from the relay rather than trusting the
client; strip only the isomux app cookie while preserving the app's own cookies;
never follow redirects automatically. WebSocket relay (Vite HMR needs it) is
`server.upgrade` on one side and a client `WebSocket` on the other, with origin
checking and close-code propagation - the only genuinely fiddly part, and one
that should degrade gracefully: no HMR is survivable, a broken page is not.

Bind each share to the listener's identity or generation where the platform
allows. Otherwise a dev server that dies and frees its port can be replaced by
an unrelated process that inherits the share until expiry.

### Who may create and enable a share

An agent creates the share, matching the `preview-url` affordance it sits next
to, but it lands **pending**: the chat card carries an [Enable sharing] button
and the proxy does not serve the share until it is clicked. Publishing an origin
to the internet is a different act from screenshotting a page, and agents will
reach for it casually.

Only the agent's manager or an office owner may enable a pending share. Room
visibility alone is not enough - a member who can watch an agent should not be
able to publish its output. Once enabled, the share is reachable by the office
users who can see the agent's room. There is no anonymous access.

Wildcard DNS resolves every hostname under `apps.<office>`, approved or not, so
enablement must be enforced by isomux and never inferred from a working
connection. **The relay rejects a pending or unknown Host before office dispatch
- 404, or a neutral pending page - in both deployments.** On self-hosted this is
belt and braces: `tls-ask` also answers non-2xx for a pending hostname, so the
connection usually fails at the TLS handshake first. On hosted there is no ask
call at all, because Caddy already holds the customer's wildcard certificate and
TLS succeeds for any name under it. A valid TLS connection is not enablement.

Because the pre-approval failure is an unfriendly error either way, the chat
card should not show the URL until the share is enabled.

### Other invariants

- Shares expire (hours, not days), are listed in the Access pane with a revoke
  button, and die with the agent.
- The office cookie should eventually get the `__Host-` prefix to foreclose
  cookie tossing from a sibling subdomain, but `__Host-` requires `Secure`, so
  it cannot be an unconditional rename - loopback HTTP installs would lose their
  session. Gate the new name on HTTPS and carry both for a release.

### Self-hosted vs hosted

On a tailnet there is nothing to build - ports are already reachable, which the
docs should say. Hosted gets C on by default, with the control plane
provisioning the wildcard record and certificate. A self-hoster on their own
domain opts in, adds the record, and runs on-demand TLS. Tailscale Funnel has no
wildcard hostnames, so those offices get A.

## Implementation shape

- `server/port-shares.ts` - share table, hostname allocation and retirement,
  expiry sweep, port validation, the `tls-ask` predicate.
- `server/app-proxy.ts` - host matching, handshake, relay. Deliberately its own
  module: `auth-middleware.ts` stays a single auditable file about the office
  origin.
- `server/routes/table.ts` + `handlers/agent-affordances.ts` - a
  `POST /api/agents/:id/share-port` affordance next to `preview-url`, plus the
  manager-facing enable and revoke ops.
- `server/isomux-office.ts` - a `Host` check ahead of the pathname dispatch.
- `deploy/install.sh` - the wildcard site block, the TLS configuration for the
  deployment kind, and Caddy admin off the TCP port, behind the flag that
  decides whether a box offers sharing.
- UI: shares list in the Access pane, enable/revoke on the chat card.

## Open questions

1. Is C worth building before the hosted product has users, or is A plus a
   prompt line enough for now? (My read: A now, C with hosted.)
2. Does `isomux.app` go on the Public Suffix List? Until it does, new-customer
   onboarding shares one certificate-issuance budget across the fleet, so this
   is a hosted scaling prerequisite rather than cleanliness. The submission has
   a long lead time; decide early.
