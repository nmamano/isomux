# Access and invites

How Isomux gates who can use an office, and how the invite-link flow works end-to-end.

For an audit-level treatment of the same system — threat model, findings, verified controls, CSRF/CSWSH analysis — see [docs/security-audit.md](./security-audit.md).

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

- **Issue invite**: enter a display name, pick a role. Click `Issue invite`. The URL appears once — copy it. The URL is one-time per device and expires 24 hours after issuing if unused.
- **Outstanding invites**: every unclaimed invite is listed with its token prefix; revoke any from this table.
- **Active sessions**: every currently-signed-in device; revoke any to immediately disconnect them.

Send each URL to the invitee through whatever channel you trust (Signal, text, email). The invitee opens it on their device → cookie set → they're in. No installs, no accounts, no passwords.

Owner-issued invite links expire 24h after issuing if unused; self-device links (generated from the My devices pane) expire after 1h. Neither TTL is configurable: invite URLs are bearer tokens, and the shorter their acceptance window, the smaller the exposure if the URL ends up in the recipient's browser history, sync, or messaging archive. The self-invite path uses the tighter 1h window because the legitimate flow is "both my devices are right here, click it now"; the 24h window on owner-issued invites covers a realistic send-and-wait delivery. If the first link expires before the recipient can act, mint a fresh one. The session that's created on acceptance is governed by a separate, much longer lifetime (see Cookie semantics below).

### 3. Multi-device users

Inviting a user who already exists requires the `Issue an additional invite` confirmation in the modal (or `--allow-existing` in the CLI). The framing is "additional invite for that identity" — it does not revoke their existing sessions, does not mutate their role. One user can have many simultaneous sessions (laptop + phone + tablet).

### 4. Sign out

`User Settings` → `Sign out` revokes the current device's session and reloads. Other devices for the same user stay signed in.

## Reachability

Auth gates who can use the office once they reach it. Getting the box itself reachable from outside your home network is a separate problem.

### Recommended: Tailscale Funnel

Funnel exposes a single port on a Tailscale machine to the public internet over the box's existing `*.ts.net` hostname. Free, no domain to buy, no router port-forwarding, no inbound IP exposure. Tailscale's relay forwards an encrypted TCP tunnel between the visitor and your node; TLS terminates on your box, not at the relay, so the relay cannot read traffic in flight.

Trade-offs:

- **Dependency on Tailscale's relay and control plane.** Your reachability is contingent on Tailscale's infrastructure being up and on Tailscale not changing the free tier in adverse ways.
- **Beta status.** Funnel is in beta and requires Tailscale v1.38.3 or later. No SLA, behavior can change.
- **Non-configurable bandwidth limits.** Tailscale doesn't publish the cap, but it's generous enough that the WebSocket traffic isomux generates doesn't realistically hit it at personal or small-team scale.
- **Public DNS visibility.** Your `*.ts.net` hostname (and therefore your tailnet name) becomes resolvable from the public internet and appears in Certificate Transparency logs once Tailscale provisions a Let's Encrypt cert.

To set this up, paste the following prompt into one of your isomux agents. The agent will install Tailscale if needed, walk you through enabling Funnel in the admin console, detect any existing services sharing port 443, and finish by capturing the public URL into your server config.

```
Set up Tailscale Funnel so my isomux office is publicly reachable
from the internet.

Steps:

1. If tailscale isn't installed, install it and pause to ask me to
   authenticate.

2. Confirm my tailnet has MagicDNS + HTTPS certs enabled in the
   admin console. Walk me through if needed.

3. Confirm the tailnet policy has a `funnel` nodeAttr covering
   this device. Ask me to add it if not.

4. Run `tailscale serve status` and `tailscale funnel status` to
   see what's currently configured. Enabling Funnel on port 443
   will either make every other path/mapping on port 443
   publicly reachable, or replace them entirely (Tailscale's
   docs: a port is either all-private Serve or all-public
   Funnel, never mixed). If port 443 has any mappings beyond the
   one pointing at isomux (default localhost:4000), list each by
   name and target. Stop and ask before continuing. For each
   extra mapping I need to choose one of: (a) confirm it's safe
   to expose publicly, (b) move it to a different port and
   update the Serve config, or (c) remove it. If moving to a
   different port, prefer a port outside Tailscale's
   Funnel-eligible list (avoid 443, 8443, 10000) so a future
   Funnel command can't accidentally expose it.

5. Once port 443 carries only the isomux mapping, run:
   `tailscale funnel --bg http://localhost:4000`

6. Capture the public URL from `tailscale funnel status --json`.

7. Update ~/.config/systemd/user/isomux.service.d/override.conf
   so it sets `Environment="ISOMUX_PUBLIC_ORIGIN=<url>"`. Create
   the directory if needed; preserve any other lines in the
   file. If the value already matches, skip the write.

8. Run `systemctl --user daemon-reload`.

9. Ask me before restarting isomux (interrupts active agents).
   Skip the restart if the running service already has the right
   `ISOMUX_PUBLIC_ORIGIN` (check with
   `systemctl --user show isomux -p Environment`).

10. Verify the public URL responds. Ask me to test from a device
    not on the tailnet (phone on cellular, or any non-tailnet
    machine). A curl from the box itself goes over the tailnet
    path and isn't a true public-reachability check.

If you run into any issues with this setup, ask in the Isomux
Discord: https://discord.gg/FrjEYyNvYs
```

### Alternative: Tailscale, tailnet-only (no public URL)

If you don't want a public URL at all, run isomux on your tailnet and only invite people who are willing to join. Tailscale Serve gives you HTTPS at `https://auntie.<your-tailnet>.ts.net`. Tell isomux about it:

```
ISOMUX_PUBLIC_ORIGIN=https://auntie.<your-tailnet>.ts.net
```

or for plain HTTP over the tailnet:

```
ISOMUX_PUBLIC_ORIGIN=http://auntie:4000
```

Invite links still work over the tailnet, but invitees have to install Tailscale and join your tailnet first.

### Alternative: Cloudflare Tunnel

Same outbound-tunnel shape as Funnel, but with Cloudflare's edge instead of Tailscale's. Requires a domain on a Cloudflare-managed zone (the auto-generated `<uuid>.cfargotunnel.com` URL is only a CNAME target, not directly browsable, and `trycloudflare.com` quick tunnels do not support the WebSocket traffic isomux relies on). The trade-off is a domain you have to buy and manage, plus Cloudflare's edge can technically see plaintext between its proxy and your origin.

To set up by hand: install `cloudflared`, run `cloudflared tunnel login`, create a named tunnel, route your hostname to `localhost:4000`, then set:

```
ISOMUX_PUBLIC_ORIGIN=https://your-tunnel-hostname.example.com
```

### Alternative: Caddy + your own DNS

No third-party hop in the data path. You open port 443 on your router, point a DNS A record at your home IP (or use DDNS for a dynamic IP), and run Caddy in front of isomux:

```
office.example.com {
  reverse_proxy localhost:4000
}
```

Caddy auto-provisions a Let's Encrypt cert. Set:

```
ISOMUX_PUBLIC_ORIGIN=https://office.example.com
```

You own the stack end-to-end. Trade-offs: your home IP is publicly visible, you carry any DDoS surface, and this path fails entirely if your ISP puts you behind CG-NAT (so you can't port-forward in the first place).

## ISOMUX_PUBLIC_ORIGIN

The server resolves the public origin at startup with this precedence:

1. `ISOMUX_PUBLIC_ORIGIN` env var. This is what the Tailscale Funnel agent prompt above writes (into `~/.config/systemd/user/isomux.service.d/override.conf`), and also what you'd set in your shell rc or another systemd `Environment=` directive.
2. `publicOrigin` in `~/.isomux/office-config.json`. A manual fallback you'd reach for if you're running isomux outside systemd (or otherwise can't set the env var). Edit the file directly — the agent safety hook blocks isomux agents from writing into `~/.isomux/`.
3. Fallback to `http://localhost:${PORT}` (default `http://localhost:4000`).

The resolved value drives:

- The Origin allowlist for WebSocket upgrades.
- The Origin allowlist for state-changing HTTP requests.
- Whether the session cookie's `Secure` attribute is set (set on `https://`, omitted on `http://localhost`).
- The base URL for invite URLs.

Both the env var and the config key are **operator-authored configuration**. The server never infers the origin from `Host` or `X-Forwarded-Host` headers, since that's how WebSocket-hijacking bugs happen. An invalid `publicOrigin` in `office-config.json` is logged and ignored at boot; the server degrades to the localhost fallback unless the env var supplies a valid value.

The localhost fallback only makes sense for single-user laptop setups. For any networked use, set one of the two paths explicitly. The Tailscale Funnel agent prompt above is the easiest way to get a valid HTTPS origin without touching DNS or routers by hand.

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
- Absolute cap: 1 year from creation.

The 1-year cap is a deliberate usability/security trade-off. The
cookie carries `HttpOnly`, `SameSite=Lax`, `Secure`-on-HTTPS,
host-only scope, and a per-message server-side recheck so a revoke
from the Access pane disconnects an active session within ~1s — the
residual risk is the shared-device case where the user forgot to
sign out (the security audit calls this out under external-access
"session lifetime on shared devices"). Devices used in untrusted
environments should be revoked from the Access pane (or signed out
explicitly) rather than relying on session expiry.

## What this is not

- Not a security boundary inside the office. Members can use the terminal panel to read any file the isomux process can read — including other users' env files. The owner/member split controls who **expands the trust boundary**, not what they can access once inside. OS-level isolation between members is a separate concern (tracked as a follow-up task).
- Not protection against rogue agents. An agent spawned in the office runs with the host Linux user's permissions; the cookie auth doesn't constrain what agents do.
- Not a substitute for backups. Revoking a leaked session ends future use of that session but doesn't undo any state the leaked session already modified.

## Bootstrap-window exposure

The one-time bootstrap invite URL is printed to stdout on first boot and lands in the user's systemd journal. **Anyone with read access to that journal during the bootstrap window (24h) can claim ownership** by opening the URL before the operator does. On a single-user box this is just the operator. On a multi-user box, a shared dev server, a container with a logging sidecar, or any host that ships journal entries to a centralized collector, the audience may be larger than the deploying operator.

If your deployment matches one of those broader-audience patterns, treat the bootstrap window as the highest-stakes window in the office's lifecycle. Best practice: boot the server, open the URL immediately to claim ownership, and confirm `journalctl --user -u isomux` no longer shows an unclaimed invite. Once an owner exists, the bootstrap path self-disables — `--regenerate-bootstrap` is the only way to reopen it, and it requires shell access plus no-owner state.

## Operating notes

- **Members lose access at server restart? No.** Sessions persist to disk; restarts pick up the in-memory map from `sessions.json`.
- **Lost the bootstrap URL?** Restart with `--regenerate-bootstrap`. Only works while no owner exists.
- **Revoking a live session?** The Access pane revoke button: the corresponding WebSocket force-closes within ~1s (per-message session recheck catches it). HTTP requests with the revoked cookie return 401 immediately.
- **Member tries to mint an invite?** Rejected at the wire level. The Access pane is hidden in the UI for non-owners; the server-side check is the actual gate.
- **CSRF / CSWSH?** Origin is checked on WS upgrade and on state-changing HTTP methods. Browsers always send Origin; non-browser callers (agents on the same host) don't, and are allowed via the loopback bypass for the agent-API paths only.
