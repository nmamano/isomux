# Auth system redesign — implemented design

## Status

Implemented in the `auth-redesign` branch. The pre-implementation analysis (originally a hand-off doc for a re-do of the abandoned `loopback-bootstrap` branch) is preserved below for historical context. The "Current state" and "Open design questions" sections below are now obsolete; the "Gaps to close" list is the change motivation and the implementation closes all of them.

## What was built

**Pre-claim**: the server binds `127.0.0.1` only and serves a tokenless name-picker form at GET /. Off-box clients cannot reach the form because the OS bind rules them out (no IP, no port). The POST /auth/claim handler layers a loopback peer-IP check and a strict same-origin check (no null-Origin fallback) as defense-in-depth. There is no URL to print, no token to leak via the systemd journal or terminal scrollback.

**Post-claim, external access off** (default for fresh installs): the server keeps binding `127.0.0.1`. Owners reach the office from the host machine or via `ssh -L 4000:localhost:4000 <user>@<host>` from another machine.

**Post-claim, external access on**: an owner uses the *External access* section in the Access pane to flip a toggle and fill in a Public URL field. Saving persists both to `office-config.json` and mints an owner self-invite bound to the new URL (TTL 1h). The toggle takes effect on the next isomux restart; the pane spells out `systemctl --user restart isomux`. The auto-minted URL gives the owner a sign-in path at the new origin without having to mint one separately.

**Lost-session recovery**: `bun run server/index.ts owner-login --name "<owner>"` from a shell on the box prints a 15-minute one-time login URL. The CLI talks to the running server over a Unix-domain socket at `~/.isomux/admin.sock` (mode 0600). Filesystem permissions on the socket are the auth boundary: any UID that can already read the auth files in `~/.isomux/` can connect, so the socket adds no new authority. On a multi-user box where `~/.isomux/` is 0700, only the Isomux service user can mint recovery URLs.

**Boot freeze**: cookie attributes and the public-origin policy are tied to the bind decision, which is captured at boot via `freezeBootState({externalAccess})`. Two predicates derive from the captured state:

- `isProcessPreClaim()` — drives the SSH -L banner.
- `isProcessBoundLoopback()` — drives `buildPublicOrigin()`'s localhost fallback.

A successful claim mid-process doesn't change the cookie attributes for the rest of the process; the bind can't widen without a restart, so neither does the policy. This eliminates a class of bug where the very response that issues a new cookie would inherit Secure attributes from a configured (but unreachable) HTTPS public origin and be rejected by the browser on the HTTP loopback connection.

**Env var deprecation**: `ISOMUX_PUBLIC_ORIGIN` is honored at boot, then migrated into `office-config.json#publicOrigin` on first observation (with `externalAccess: true` written alongside, preserving the bind for pre-redesign networked installs). A deprecation message asks the operator to remove the env var. The migration is one-shot per upgrade — subsequent boots read the JSON value.

## Threat model anchor

"Shell access AS the Isomux service user can mint owner-grant URLs." On single-user hosts this is just "shell access." On multi-user hosts, the Unix socket's mode-0600 enforces the distinction. Same property as direct file edits to `~/.isomux/users.json` — the redesign just gives that authority a cleaner, audit-logged interface.

## Operator flows

**Local-laptop first-time setup**: install, `bun run server/index.ts` (or systemd start), open http://localhost:4000, pick a name. Done. Two browser actions, zero terminal commands beyond starting the server.

**Remote-server first-time setup** (e.g. auntie):
1. SSH in. Install. Run the server.
2. From your laptop, run `ssh -L 4000:localhost:4000 <user>@<box>`. The server's startup banner prints the exact command.
3. Open http://localhost:4000 in your laptop browser. Pick a name. Done.

**Enable external access** (e.g. expose via Tailscale Funnel post-claim):
1. From the Access pane: flip *Enable external access*, fill in the Public URL, click Save.
2. The pane shows a "Restart isomux to apply" panel with the exact `systemctl --user restart isomux` command and a freshly-minted sign-in URL for the new origin.
3. Run the restart command. Open the sign-in URL on your laptop browser at the new public address. Bookmark the public URL going forward.

**Recover a lost-session owner**: SSH in, `bun run server/index.ts owner-login --name "<your-name>"`. Open the printed URL on whichever device you want signed in.

## Open design questions, resolved

1. **Pre-claim listening interface.** Bind `127.0.0.1` only. The OS bind is the primary locality boundary; loopback peer-IP and strict same-origin checks on POST /auth/claim layer defense-in-depth.
2. **Env/JSON override semantics.** Env honored at boot, migrated into JSON, deprecated. JSON becomes the canonical store.
3. **`/i/<token>` post-redesign.** Member invites still use it. Bootstrap doesn't — the tokenless form replaces it.
4. **Recovery scope.** Owner-login CLI handles the lost-session case only. Bootstrap doesn't go through the CLI; the form is enough.
5. **Restart semantics on first claim.** No restart needed for the claim itself (the bind stays `127.0.0.1` post-claim until the toggle flips). Restart is required when the *External access* toggle flips.
6. **Tokenless bootstrap CSRF/origin policy.** POST /auth/claim uses a strict same-origin check (matching `http://localhost:PORT` or `http://127.0.0.1:PORT`). No null-Origin fallback — the claim form doesn't carry `Referrer-Policy: no-referrer`, so browsers always send Origin on its POSTs.
7. **Exposure toggle storage and migration.** `office-config.json` carries both `publicOrigin` (string or null) and `externalAccess` (boolean). When `externalAccess` is absent in JSON, the boot-time inference defaults to true if any prior `publicOrigin` source existed, false otherwise; the inferred value is backfilled to disk so subsequent boots see the explicit value. Env-var migration writes both fields atomically.

## Residual gap (inherent topology limit)

If the operator runs an external proxy that forwards to `localhost:4000` *before* claiming, anyone who can reach the proxy can reach the form. Isomux can't see that the proxy is on the same host. Documented as operator responsibility in `docs/access-and-invites.md` "Bootstrap-window exposure."

---

# Historical: pre-implementation analysis

The text below was the design rationale captured before implementation began. Everything past this point describes the pre-implementation state and decisions; the implementation summary above supersedes it.

## Why this doc existed

A pair-programming session on the `loopback-bootstrap` branch surfaced enough cross-cutting concerns in the auth / bootstrap / external-exposure surface that the changes were **designed coherently before implementation**. If the implementation were later split into multiple PRs, the boundaries should preserve the security invariants captured below — security-sensitive surfaces are easier to audit when the threat model is reviewed as a whole.

The original branch was thrown away. This doc captured the problem space, the approaches considered, and the trade-offs identified so the next agent could design the solution from scratch with the design rationale already mapped out.

## Current state (pre-redesign, kept as a reference for the gap list)

- First-owner bootstrap via a one-time URL printed to stdout on first boot. The URL contained a 256-bit token; opening it showed a name-picker form; submitting created the owner.
- Public origin (for external access) was configured via either `ISOMUX_PUBLIC_ORIGIN` env var (precedence 1) or `publicOrigin` in `~/.isomux/office-config.json` (precedence 2), with fallback to `http://localhost:${PORT}`.
- Members were invited by the owner from the Access pane.
- Sessions were cookie-based: `HttpOnly`, `SameSite=Lax`, `Secure` when public origin was HTTPS, 30d rolling / 1y absolute.
- `--regenerate-bootstrap` CLI flag re-minted the bootstrap URL if the operator lost it (no-op once an owner existed).

Most of this was well-designed and recently audited (see `docs/security-audit.md`). The gaps below were scoped to the bootstrap + external-exposure surface.

## Gaps to close

### Security

1. **Bootstrap URL leaks via the systemd journal.** The URL is logged to stdout on first boot, lands in `journalctl --user -u isomux`. Anyone with journal-read access during the 24h bootstrap window can claim ownership. Documented as Finding 1 (Medium) in `docs/security-audit.md`. On a single-user laptop this is the operator only; on multi-user hosts or anything with log-shipping, the audience is wider.

2. **Bootstrap invite still redeemable after owner exists (latent bug).** `acceptInvite` doesn't recheck `hasOwner()` under the auth mutex for bootstrap invites. If a bootstrap invite is unconsumed and not expired AND an owner already exists, the URL can still be redeemed — creating a second owner, or promoting an existing member to owner if the chosen name matches. Discovered during this design session. Hard to exploit (requires the raw token), but a real gap.

3. **Stale bootstrap invites accumulate** in `invites.json` after an owner exists. Combined with (2), it's a footgun.

### Friction

4. **Local laptop bootstrap is not discoverable.** A user who installs isomux on their laptop has no in-app pointer for "open this URL to claim ownership." The URL is buried in the systemd journal. First-time-user experience is "where do I start?"

5. **Remote install has no friction-free path.** Today's options are (a) SSH port-forward `-L 4000:localhost:4000` and open `localhost:4000` from laptop — requires knowing about `-L`; (b) configure an external proxy before claim, trading away the security model; or (c) set `ISOMUX_PUBLIC_ORIGIN` first to something laptop-reachable so the URL points somewhere usable. None is intuitive for non-power-users.

6. **Two config paths for public origin** (env var and JSON config). Operators have to learn both. The duality exists for systemd-vs-non-systemd reasons but reads as accidental complexity to users. (Was filed as task `dbb59b25`; absorb into the redesign.)

7. **No self-recovery from lost session.** A single-device operator who clears cookies, signs out, or whose cookie hits the 1y absolute cap is stranded — there's no way to mint a new invite without an active owner session. Current workaround is hand-editing `~/.isomux/users.json`. (Was filed as task `596cf9fa`; absorb into the redesign.)

## Design constraints learned during the session

These came out of pair-programming with the security reviewer. Designs that violate them need a stronger argument than "it's simpler."

### Origin headers are not locality proof

`Origin` is a browser CSRF signal — browsers honor same-origin policies and attach the header automatically. But a non-browser client (`curl -H "Origin: http://localhost:4000"`) can set it to anything. Any bootstrap design that gates on Origin alone is exploitable by forged-Origin attacks from anyone who can reach the server's TCP port.

### Peer-IP loopback is locality proof — unless a same-host proxy forwards traffic

Peer IP comes from the TCP socket — the OS records where the connection physically came from. It can't be forged by setting a header. A connection from `127.0.0.1` came from the same machine.

The exception: if a reverse proxy is running on the same box and forwards external traffic to `localhost:4000`, the proxy's outgoing connection to isomux IS from loopback. Tailscale Funnel, Tailscale Serve, Caddy → localhost, all behave this way. From isomux's perspective, proxy-forwarded external traffic is indistinguishable from a real local browser at the peer-IP level. This is an inherent limit, not a bug.

### `claim-before-expose` cannot be enforced in code if proxies live outside isomux

A natural mitigation for the journal-leak risk is "make the operator claim before configuring external access." But that's a doc-only invariant — isomux has no way to see whether `tailscale funnel` is already running, or whether Caddy is forwarding to localhost. The invariant has to either (a) be enforced by isomux's own config surface (so isomux KNOWS exposure is on or off because the operator told it via something isomux controls), or (b) be documented operator responsibility with the residual risk made explicit.

### Cookie-only auth means lost-session recovery requires an out-of-band path

If owner has no active session and is the only owner, there's no in-app path to mint an invite. Recovery has to come from outside the cookie surface — typically a CLI run on the box, which proves shell access.

## Approaches considered

### Approach A: Keep bootstrap URL, narrow it with a three-conjunct loopback gate

Original PR shape on the thrown-away branch. In localhost-fallback mode (no public origin configured), serve a tokenless name-picker form to loopback browsers. In networked mode, keep printing the bootstrap URL.

The three conjuncts (loopback + no owner + localhost-source origin) prevent the form from activating in networked deployments, so the source check is the load-bearing protection.

Trade-offs:
- Addresses (4) for local laptop dev.
- Doesn't address (5) — remote install still needs SSH PF or the URL.
- Keeps the URL-in-journal exposure for networked deployments (gap 1 unchanged).
- Doesn't address (6) or (7).
- Two operating modes carry through to docs and code, making the system harder to explain.

### Approach B: Drop the source-localhost check, replace with boot-time env-var ignore

At boot, if `ISOMUX_PUBLIC_ORIGIN` is set AND no owner exists, ignore it and fall back to localhost mode with a loud banner. Loopback gate stays. Bootstrap form universal at `/`.

Trade-offs:
- One operating mode pre-claim, two post-claim — cleaner.
- Still doesn't address (5).
- Still doesn't address (6) — env var still primary config path.
- Still doesn't address (7).
- Smaller code change than A, but doesn't take any of the other tasks off the table.

### Approach C: Universal `!hasOwner()` form, no loopback gate

The "first device wins" idea in its purest form. The form appears for anyone, all gates removed except "no owner exists."

Rejected because of the forged-Origin attack: any non-browser client that can reach the server's TCP port can claim ownership with a single curl command, including a Tailscale Funnel rando over the internet. Works for personal-tailnet setups where everyone reachable is trusted; doesn't degrade gracefully for public exposure.

### Approach D: UI-toggle for external exposure (the converged direction)

Move the "expose externally" decision out of env vars / JSON and into an owner-only UI setting in the Access pane. Pre-claim, isomux treats itself as localhost-only for origin / cookie / auth decisions — the toggle hasn't been flipped because no owner exists. (Note: this is the effective auth mode, not bind-level isolation; see open design question 1 for whether the listening interface should also be restricted pre-claim.) Post-claim, the owner toggles exposure on, provides the URL, isomux honors it from that point.

This structurally eliminates the entire "operator misconfigured `ISOMUX_PUBLIC_ORIGIN` pre-claim" attack class. There is no networked auth mode pre-claim, period. Subsumes (6) — env var and JSON config either deprecate or become headless-only overrides.

But the underlying TCP socket may still listen on all interfaces (depending on the bind decision). So **a peer-IP loopback gate on bootstrap POST is still required** to block LAN/tailnet curl-with-forged-Origin attacks. The UI toggle decides what mode isomux operates in; the loopback gate decides which TCP connections it serves bootstrap requests to. The two are at different layers and complementary, not redundant.

Trade-offs:
- Addresses (1) structurally — no automatic startup URL is printed to stdout/journal. Any token URL minted later (e.g. for remote claim or recovery) is explicit, on-demand, short-lived, and shell-access-gated.
- Addresses (4) — first-device-on-loopback claims is the universal flow.
- Doesn't fully address (5) — remote install still needs the laptop to reach the server's `localhost:4000` somehow.
- Closes (2) and (3) in the same pass (the `hasOwner()` recheck + outstanding-invite sweep apply regardless of approach).
- Addresses (6) by making the UI toggle the canonical path.
- Doesn't directly address (7), but the redesign should fold in a self-recovery CLI in the same pass.

### Residual gap shared by all approaches

If the operator has configured an external proxy (Tailscale Funnel, Caddy → localhost, etc.) BEFORE installing isomux, isomux cannot detect or close this gap. The proxy is forwarding to localhost; isomux sees loopback peer IP. The precise attacker path: a non-browser client (e.g. `curl`) can reach the proxy from anywhere the proxy serves, then forge `Origin: http://localhost:4000` to satisfy the pre-claim same-origin check. (Normal browsers visiting the proxy URL will fail a strict localhost-Origin check on their own, but a forged Origin from a scripted client passes.) An attacker who can reach the proxy can therefore claim the office unless the proxy itself enforces access control.

This is an inherent topology limit. No amount of code in isomux can close it; the redesign should document it bluntly.

## Remote-install bootstrap UX (the hardest sub-problem)

For local laptop install, "open localhost:4000 on the laptop" is the obvious path under Approach D. For remote install (isomux on a server), the operator needs SOME way to reach the server's isomux from their laptop browser to claim. Three sub-options:

1. **SSH port-forward.** `ssh -L 4000:localhost:4000 server`. Loopback gate passes via the SSH daemon's localhost connection. Works, but requires knowing about `-L`.

2. **Set up Tailscale Serve (or equivalent) before claim.** The operator's laptop visits `https://<box>.<tailnet>.ts.net` directly. **This requires the redesign to explicitly relax the pre-claim origin rule for this case** — by default the same-host proxy makes peer-IP appear loopback but the browser's `Origin` header will be the tailnet URL, not `http://localhost:4000`, so a strict pre-claim Origin check would reject the claim POST. Without an intentional relaxation, this path doesn't work; with one, anyone on the tailnet can also claim during the bootstrap window. Acceptable for personal tailnets where every member is trusted enough to be owner; unacceptable for Funnel-exposed setups. The fresh-session agent should decide explicitly: either design a deliberate "trusted-network pre-claim" mode with operator opt-in, or document this path as discouraged/unsupported to avoid the next agent accidentally implementing the relaxation as a bypass.

3. **CLI claim command.** `isomux owner claim --name "Nil"` run on the box (over SSH terminal) mints a one-time login URL with a session token. The operator opens it from any browser that can reach isomux. Resurrects a token-bearing flow but only on-demand and only after shell-access proof; the URL is single-use and short-lived. This same mechanism could double as the recovery path for gap (7).

The redesign should pick one or layer them, document the trade-off bluntly for each, and make clear which is recommended for which deployment shape.

## Open design questions for the next agent

1. **Pre-claim listening interface.** Should isomux bind to `0.0.0.0:4000` pre-claim (current behavior, loopback gate enforces locality), or to `127.0.0.1:4000` (no LAN reachability at all, but breaks tailscale-serve-before-claim)? Tighter default vs. allow-tailnet-bootstrap. Note: binding to `127.0.0.1` pre-claim is the only way isomux itself can hide unauthenticated surfaces from LAN scans — the loopback POST gate protects bootstrap but doesn't prevent LAN-scan visibility of GET endpoints or the form HTML.

2. **Env/JSON override semantics in the UI-toggle world.** If headless setups need to set the public origin from outside the UI, the UI toggle alone isn't enough. Should env/JSON overrides be honored pre-claim (returns the original attack class), ignored pre-claim (headless needs a separate bootstrap mechanism), or refuse-to-start (forces operator to claim first)?

3. **What to do with `/i/<token>` post-redesign.** Member invites still use it. Should bootstrap also use it (CLI mints token, operator opens URL), or should bootstrap stay tokenless via loopback form? Both have merit.

4. **Recovery scope.** Should the same CLI command handle both initial-bootstrap-from-CLI and lost-session-recovery? They're structurally similar (mint a one-time URL with a session token), but the wording / UX differs.

5. **Restart semantics on first claim.** If the UI toggle changes cookie attributes (Secure, etc.) and origin allowlist, does flipping it require a server restart, or can it be hot-applied? Cookie attribute changes mid-session are tricky.

6. **Tokenless bootstrap CSRF/origin policy.** The existing `originValidForAuthPost` has an absent/`null` Origin → `Sec-Fetch-Site: same-origin` fallback that exists because token accept pages carry `Referrer-Policy: no-referrer` (which makes Chrome send `Origin: null` on top-level form POSTs). For tokenless bootstrap there is no URL token to protect, so the redesign should explicitly decide: omit `Referrer-Policy` on the tokenless form, use a stricter exact-Origin check (no null fallback) for tokenless bootstrap POSTs, or both. Don't let the design accidentally rely on the generic fallback — the proxy/tailnet attack analysis above hinges on this.

7. **Exposure toggle storage and migration.** Where does the canonical persisted "external exposure" setting live (office-config.json? a new auth-config.json? in users.json on the owner record?)? How do existing installs migrate when env var or `publicOrigin` JSON is already set? What happens if both env/JSON override and UI setting exist post-migration — who wins, and is the conflict surfaced to the operator? Does toggling exposure change cookie attributes (Secure flag) and if so, are existing sessions invalidated/reissued, or do they continue with stale attributes? This is the "config consolidation" piece (task `dbb59b25`) and deserves its own coherent answer.

## Out of scope for this redesign

- The invite flow for additional members. Works well, audited, leave alone.
- Cookie semantics (HttpOnly / SameSite / Secure-on-HTTPS / per-message recheck). Audited.
- CSRF / WebSocket hijacking defenses. Audited.

## Tasks superseded by this redesign

- `dbb59b25` — Consolidate public-origin config. Folded into the redesign via the UI-toggle decision.
- `596cf9fa` — CLI recovery path for owner who lost their only session. Folded into the redesign via the CLI bootstrap/recovery mechanism decision (open question 4).
