# Access and invites

How Isomux gates who can use an office, and how the invite-link flow works end-to-end.

## TL;DR

- Isomux gives shell-equivalent access to authenticated users. Only invite people you trust.
- The server gates every browser request (HTTP + WebSocket) by a session cookie.
- Sessions are created when an invitee opens an invite URL the office owner generated.
- The very first owner is bootstrapped via a one-time URL printed to stdout on the first server boot when no owner exists yet.
- Two roles exist: `owner` (can mint invites, revoke sessions) and `member` (can use the office). Both have full operational access — the role split exists to control who expands the trust boundary.

## End-to-end flow

### 1. First boot — owner bootstrap

On startup, the server checks `~/.isomux/users.json`. If no user has `role: "owner"`, it generates a one-time owner-tagged invite token and prints the URL to stdout and the systemd journal:

```
================================================================
  Isomux: no owner exists yet. Bootstrap invite (one-time):
  http://localhost:4000/i/9X2K7m...
  Valid for ~24h. Open this URL in your browser to claim
  ownership. This URL is printed once; if you lose it, restart
  the server with --regenerate-bootstrap.
================================================================
```

Open the URL in a browser. The accept page asks you to pick a display name (the only flow where invitees name themselves, because there's no prior owner to have named them). Submit → cookie set → redirect to `/` → you're in.

If you lose the URL before claiming it, restart the server with `--regenerate-bootstrap`:

```
bun run server/index.ts --regenerate-bootstrap
```

The flag invalidates the prior unconsumed bootstrap and mints a fresh one. It only mints when no owner exists; once an owner exists, the flag is a no-op.

### 2. Inviting members

Once you're the owner, open `User Settings` → `Access` pane:

- **Issue invite**: enter a display name, pick a role, pick a TTL. Click `Issue invite`. The URL appears once — copy it. The URL is one-time per device.
- **Outstanding invites**: every unclaimed invite is listed with its token prefix; revoke any from this table.
- **Active sessions**: every currently-signed-in device; revoke any to immediately disconnect them.

Send each URL to the invitee through whatever channel you trust (Signal, text, email). The invitee opens it on their device → cookie set → they're in. No installs, no accounts, no passwords.

### 3. Multi-device users

Inviting a user who already exists requires the `Issue an additional invite` confirmation in the modal (or `--allow-existing` in the CLI). The framing is "additional invite for that identity" — it does not revoke their existing sessions, does not mutate their role. One user can have many simultaneous sessions (laptop + phone + tablet).

### 4. Sign out

`User Settings` → `Sign out` revokes the current device's session and reloads. Other devices for the same user stay signed in.

## Reachability

Auth gates who can use the office once they reach it. Getting the box itself reachable from outside your home network is a separate problem with several solutions. Pick one:

### Option A: Tailscale (recommended if you already use it)

Run the box on your tailnet. Anyone who needs access has to be on the same tailnet. Invites still apply on top — this is double-gating, which is fine. Set:

```
ISOMUX_PUBLIC_ORIGIN=https://auntie.<your-tailnet>.ts.net
```

or for plain HTTP over the tailnet:

```
ISOMUX_PUBLIC_ORIGIN=http://auntie:4000
```

### Option B: Cloudflare Tunnel (recommended for new setups)

Tunnel dials out from the box to Cloudflare's edge — no inbound port-forward, no public IP exposure, free TLS. Trade-off: Cloudflare terminates TLS at their edge and can technically see plaintext between their edge and your origin.

Install `cloudflared`, run `cloudflared tunnel login`, create a tunnel, route a hostname to `localhost:4000`. Set:

```
ISOMUX_PUBLIC_ORIGIN=https://your-tunnel-hostname.example.com
```

A bundled setup wizard for this is tracked as a separate task; for now follow the upstream Cloudflare docs.

### Option C: Caddy + your own DNS

Open port 443 on your router, point a DNS A record at your home IP (or use a DDNS provider), put Caddy in front of isomux:

```
office.example.com {
  reverse_proxy localhost:4000
}
```

Caddy auto-provisions a Let's Encrypt cert. Set:

```
ISOMUX_PUBLIC_ORIGIN=https://office.example.com
```

You own everything. Trade-off: your home IP is publicly visible and you carry the DDoS surface.

## ISOMUX_PUBLIC_ORIGIN

The server reads this env var at startup to compute:

- The Origin allowlist for WebSocket upgrades.
- The Origin allowlist for state-changing HTTP requests.
- Whether the session cookie's `Secure` attribute should be set (`Secure` on `https://`, omitted on `http://localhost`).
- The base URL for invite URLs.

If unset, the server falls back to `http://localhost:${PORT}` (default `http://localhost:4000`). The fallback only makes sense for localhost-only deployments — for any networked use, set this explicitly.

**Do not** infer the origin from `Host` or `X-Forwarded-Host` headers — that's how WebSocket-hijacking bugs happen. The operator sets `ISOMUX_PUBLIC_ORIGIN` once at deploy.

## State files

Stored in `~/.isomux/`:

- `users.json` — boss profiles. Each record carries `role: "owner" | "member"`.
- `invites.json` — outstanding invites, keyed by sha256(token). Raw tokens never persist; only the hash and an 8-char display prefix.
- `sessions.json` — active sessions, keyed by sha256(session-id). Raw IDs never persist.

All three files are written atomically (temp + rename) and serialized under a single in-process mutex so invite acceptance (which touches all three) can't race.

## Cookie semantics

- Name: `isomux_session`
- Attributes: `HttpOnly; Path=/; SameSite=Lax`
- `Secure` set when `ISOMUX_PUBLIC_ORIGIN` is `https://`, omitted when `http://localhost*`.
- Rolling expiry: 30 days, refreshed on activity.
- Absolute cap: 90 days from creation.

## What this is not

- Not a security boundary inside the office. Members can use the terminal panel to read any file the isomux process can read — including other users' env files. The owner/member split controls who **expands the trust boundary**, not what they can access once inside. OS-level isolation between members is a separate concern (tracked as a follow-up task).
- Not protection against rogue agents. An agent spawned in the office runs with the host Linux user's permissions; the cookie auth doesn't constrain what agents do.
- Not a substitute for backups. Revoking a leaked session ends future use of that session but doesn't undo any state the leaked session already modified.

## Operating notes

- **Members lose access at server restart? No.** Sessions persist to disk; restarts pick up the in-memory map from `sessions.json`.
- **Lost the bootstrap URL?** Restart with `--regenerate-bootstrap`. Only works while no owner exists.
- **Revoking a live session?** The Access pane revoke button: the corresponding WebSocket force-closes within ~1s (per-message session recheck catches it). HTTP requests with the revoked cookie return 401 immediately.
- **Member tries to mint an invite?** Rejected at the wire level. The Access pane is hidden in the UI for non-owners; the server-side check is the actual gate.
- **CSRF / CSWSH?** Origin is checked on WS upgrade and on state-changing HTTP methods. Browsers always send Origin; non-browser callers (agents on the same host) don't, and are allowed via the loopback bypass for the agent-API paths only.
