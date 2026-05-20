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
2. From your laptop, run `ssh -L 4000:localhost:4000 <user>@<box>`. The server's startup banner prints this command as a template plus a parenthetical hint with the detected `<user>@<hostname>` of the box (the operator substitutes whichever SSH target they actually use).
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
