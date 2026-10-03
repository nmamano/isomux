# Proxy trust: on-box requests and real client addresses (F7, F8)

Status: approved by Nil on 2026-10-03 and implemented in batch 1006. Nil
ruled: no allowed-proxy address setting, and no ingress NetworkPolicy
hardening. Tasks a4f13754 (F7) and 7c9d674e (F8). Source:
`~/nil/isomux-security-audit/findings.md`.

## Problem

The server sees only the TCP peer. Behind a same-host proxy (Caddy), every
request has a loopback peer. Behind a load balancer, every request has the
load balancer as peer. Thus:

- F7: the server cannot refuse an agent, cron-run or app token that arrives
  from the internet. A leaked token works through the public URL.
- F8: each rate limit sees one address for all clients. The container setup
  form, the app sign-in redeem limit and `/readyz` share one budget for all
  callers. Behind Caddy, `/readyz` has no limit, because each request looks
  like loopback and loopback is exempt.

## The contract

By default the server trusts no forwarding header. A deployment declares its
proxy with one setting, `trustedProxy`:

- `none` (default): no proxy. The client is the peer.
- `same-host`: a proxy on the same machine connects over loopback and sends
  `X-Forwarded-For`. For a loopback request with `X-Forwarded-For`, the client
  is the rightmost entry.
- `load-balancer`: every non-loopback peer is the load balancer, and it sends
  `X-Forwarded-For`. For a non-loopback request with `X-Forwarded-For`, the
  client is the rightmost entry.

In all other cases the client is the peer. The server never reads `X-Real-IP`
or `Forwarded` as an address.

## F7: how the server tells an agent call from a proxied one

A request is **on-box** when its peer is loopback and it has none of
`X-Forwarded-For`, `Forwarded` or `X-Real-IP`. This rule is the same in every
mode. It does not trust a header: the presence of a header can only make a
request off-box.

Why it holds behind Caddy (measured on Caddy 2.11.4, 2026-10-03, a throwaway
Caddy in front of a Bun echo server): `reverse_proxy` always sends
`X-Forwarded-For`. When the client sends its own `X-Forwarded-For`, Caddy
replaces it with the client's real address. A client cannot remove the
header and cannot change the rightmost entry. Caddy passes a client's
`X-Real-IP` through without change. That is why `X-Real-IP` only marks a
request as off-box. An agent's `curl localhost:PORT` sends none of these
headers. Behind a load balancer, the proxied request has a non-loopback peer,
so it is off-box with or without headers.

A declared same-host proxy must send `X-Forwarded-For`. A proxy that sends no
forwarding header (for example socat or an `ssh -R` tunnel) looks like the box,
and F7 cannot protect that setup.

The change: `resolveBearerIdentity` (`server/auth-middleware.ts`) gets
`onBox`. When it is false, the server ignores agent, cron-run and app tokens,
as it ignores an invalid token today: the caller gets the plain 401, or the
cookie path. It logs one line per refusal, without the token. Personal API
tokens do not change: they are for remote use. `authenticate()` takes `onBox`
as a required argument, and `server/isomux-office.ts` classifies each request
once. `/ws` accepts only API tokens, so it does not change. The tokenless
first-owner claim (`handleClaim`) uses `onBox` in place of
`requestIsLoopback`. This closes the "claim over a same-host proxy" gap that
the comment at `handleClaim` calls inherent.

## F8: rate limits on the real client

- `/readyz` (`server/isomux-office.ts`, `server/ready-limiter.ts`): exempt only
  on-box requests, and key the limit on the client.
- App sign-in redeem (`server/app-auth.ts`, `server/app-hosts.ts`): key the
  limit on label and client, not on the label only. The code is 256 bits, so a
  per-client budget does not make guessing possible.
- Container setup form (`deploy/container/bootstrap.ts`, `office.ts`): replace
  the one global counter with a counter per client, with a bound on the number
  of tracked addresses, as in `ready-limiter.ts`. The setup key has at least 32
  characters.
- Not in scope: the `X-Forwarded-For` that the app relay
  (`server/app-proxy.ts`, `server/app-ws-relay.ts`) sends to apps.

## Who sets it

| Setup | Setting | How it is set |
| --- | --- | --- |
| Installer + Caddy (self-hosted and hosted) | `same-host` | `deploy/install.sh` adds `"trustedProxy": "same-host"` to `office-config.json` in the step that writes `networkBind` (`write_loopback_bind_if_proxied`). That step runs on install and on each update, when Caddy is active and proxies to `127.0.0.1:4000`. Existing boxes get it on their next update, and it applies when the server next starts. |
| Nil's office (Caddy, hand-mirrored) | `same-host` | By hand: add `"trustedProxy": "same-host"` to `~/.isomux/office-config.json`, then restart. Also check that `/etc/caddy/Caddyfile` does not remove `X-Forwarded-For` (`header_up -X-Forwarded-For`) and does not set `trusted_proxies`. Unchecked: the file is outside `~/nil`. |
| Container: AWS Compose, EKS ALB, Render | `load-balancer` | The container entry `deploy/container/office.ts`, which all three images run, declares it. The manifests do not change. In Compose, the peer is the Docker gateway that carries the host Caddy's traffic. |
| Plain self-hosted, no proxy | `none` | Nothing to do. |
| Self-hosted with an operator's own proxy | `same-host` | The operator sets the key. `docs/hosting-reference.md` says so, and says that the proxy must send `X-Forwarded-For`. |

The server reads `trustedProxy` once at boot from `office-config.json`
(`server/persistence.ts`, next to `networkBind`). An unknown value counts as
`none` and the server logs it.

## What breaks, and for whom

- A tool or app that uses an agent, cron-run or app token through the public
  URL, or from another machine, gets 401. This is the purpose of F7. The system
  prompt already tells agents and apps to call `localhost:PORT`.
- Egress proxies. Measured 2026-10-03: curl 8.5.0 and Bun `fetch` send
  `localhost` requests through `http_proxy` when `NO_PROXY` does not list it.
  With a remote egress proxy, agent calls to `localhost:PORT` fail today, so
  F7 changes nothing there. A proxy in the same pod that adds
  `X-Forwarded-For` would reach the office from loopback and now get 401. In
  both cases the fix is `NO_PROXY=localhost,127.0.0.1`. Unchecked for the Akido
  EKS pilot.
- An on-box process that sends a forwarding header with an agent token gets
  401. None is known in the repo; check with grep during the implementation.
- `kubectl port-forward` and `docker exec` reach the server from loopback, so
  they count as on-box. They need cluster or host credentials.
- `load-balancer` mode: a caller inside the cluster can reach the pod without
  the ALB (there is no ingress NetworkPolicy) and forge `X-Forwarded-For` to
  choose its rate-limit key. It cannot use an agent token, because its peer is
  not loopback. Optional hardening, not chosen (Nil, 2026-10-03): a setting
  that lists the allowed proxy addresses, and/or an ingress NetworkPolicy in
  `deploy/kubernetes` that admits only the load balancer.
- Render: unchecked whether Render puts more than one proxy in front. If it
  does, the rightmost entry is Render's edge and the limit is per edge node,
  not per client. Verify on a Render office before release.
- Behind Caddy, public `/readyz` gets its first limit: 30 per minute per
  client. The updater polls from the box and stays exempt.

Docs to update: `docs/security-audit.md` (threat model, F7 and F8),
`docs/hosting-reference.md` (the setting and the proxy requirement), and the code
comments at `requestIsLoopback`, `handleClaim` and `APP_REDEEM_MAX_PER_WINDOW`.

## Alternative not chosen

A separate listener for agent traffic (a Unix socket or a second port that no
proxy points at) gives F7 without headers. It needs a change to every agent and
app call (the system prompt, app environments, docs), to the container ports
on EKS and Render, and to every operator's proxy config.
