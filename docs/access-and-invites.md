# Access and invites

How Isomux gates who can use an office, and how the invite-link flow works end-to-end.

## TL;DR

- Isomux agents can run shell commands, so authenticated users effectively have shell access to the host. Only invite people you trust.
- The server gates every browser request (HTTP + WebSocket) by a session cookie.
- Two roles: `owner` (can toggle external access and mint invites for new users) and `member`. Both have full operational access, and every user can mint device links for their own extra devices.
- Sessions are created when someone opens an invite URL (issued by an owner, or by a member for one of their own devices).
- The first owner claims the office at `http://localhost:4000` on the host machine. Until that claim happens the server is only reachable from the host (or via an SSH tunnel).

## End-to-end flow

### 1. First boot - owner claim

On startup, the server checks `~/.isomux/users.json`. When no user has `role: "owner"`, the server listens on the loopback interface only (so the office isn't reachable from your LAN or VPN yet), serves a name-picker form at `/`, and prints a banner with the two ways to reach it:

```
================================================================
  Isomux: no owner has been set up for this office yet.

  TO CLAIM OWNERSHIP from THIS machine:
    Open http://localhost:4000 in your browser.

  TO CLAIM OWNERSHIP from another machine:
    1. On that machine, open a tunnel to this box:
         ssh -L 4000:localhost:4000 <user>@<host>
    2. Open http://localhost:4000 in that browser.

  After you claim, the Access pane lets you enable external
  access so everyday use doesn't need the SSH tunnel.
================================================================
```

Pick a display name on the form (the only flow where claimants name themselves, because there's no prior owner to have named them). Submit → cookie set → redirect to `/` → you're in.

If you don't get to it on the first boot, the same form is served on every subsequent boot until someone claims the office. The submit handler accepts only loopback peers and same-origin requests as defense-in-depth; the listener interface is the primary boundary.

### 2. Inviting members

Once you're the owner, open `User Settings` → `Invites` section:

- **Issue invite**: enter the new user's name, pick a role. For a member invite, check the rooms they should have access to, so they land in those rooms the moment they accept instead of an empty office (leave all unchecked to grant rooms later from their user settings). Click `Issue invite`. The URL appears once - copy it. It is one-time and expires 24 hours after issuing if unused.
- **Outstanding invites**: every unclaimed invite is listed with its token prefix; revoke any from this table.
- **Active sessions**: every currently-signed-in device, listed in the separate `Sessions` section with the local date and time when inactivity or the session's lifetime will expire it; revoke any to immediately disconnect them.

Send each URL to the invitee through whatever channel you trust (Signal, text, email). The invitee opens it on their device → cookie set → they're in. No installs, no accounts, no passwords.

A browser that is already signed in as a user cannot accept an invite for a different user (the invite is not consumed).

Owner-issued invite links expire 24h after issuing if unused; self-device links (generated from the My devices pane) expire after 1h. Neither TTL is configurable: invite URLs are bearer tokens, and the shorter their acceptance window, the smaller the exposure if the URL ends up in the recipient's browser history, sync, or messaging archive. The self-invite path uses the tighter 1h window because the legitimate flow is "both my devices are right here, click it now"; the 24h window on owner-issued invites covers a realistic send-and-wait delivery. If the first link expires before the recipient can act, mint a fresh one. The session that's created on acceptance is governed by a separate, much longer lifetime (see Cookie semantics below).

### 3. Multi-device users

Invites create new users only. Typing a name that already exists shows a pointer instead of a form mode: existing users add devices themselves, with a device link from `My devices` in their own settings (the server rejects owner-minted invites for existing names too). The exception is recovery: someone signed out of every device can't self-serve, so the owner picks them from the Recovery dropdown in the Invites section and mints a device link for them (24h window, one outstanding link per user). One user can have many simultaneous sessions (laptop + phone + tablet).

### 4. Device links

Every user adds more of their own devices without involving anyone else. In `User Settings`, the `My devices` pane (the only account section for members; owners have it alongside `Access` / `Invites` / `Sessions`) has a `Generate device link` button with no other knobs. Click it; the URL appears once. Copy it, open it on the other device, you're in as the same identity.

Self-device links are tighter than owner-issued invites by design: **1h TTL** and **at most one outstanding at a time** (generating a new one replaces the previous). The 1h window matches the legitimate flow ("both my devices are right here, click it now"). The role, target user, and TTL are all fixed server-side from the caller's session, so a tampered client can't extend the window, change the role, or mint for a different identity. The wire-level check rejects any such attempt.

The `My devices` pane also lists your own outstanding device links and active sessions - same tables as the owner's `Invites` and `Sessions` sections, filtered to one identity.

### 5. Sign out

`User Settings` → `Sign out` revokes the current device's session and reloads. Other devices for the same user stay signed in.

## Reachability

Auth gates who can use the office once they reach it. Getting the box itself reachable from outside your home network is a separate problem, covered in [self-hosted setup](self-hosted.md#make-the-office-reachable): Tailscale for your own devices, Tailscale Funnel or Caddy for a public URL.

## External access and public origin

Post-claim, the **Access pane** in User Settings has an _External access_ section with:

- **Enable external access** toggle. Off by default; the server keeps binding `127.0.0.1` only and the office is reachable from the host machine (or via an SSH tunnel) but not from your LAN/VPN.
- **Public URL** text field. Where browsers on other machines will reach this office (e.g. `https://my-mac-mini.<your-tailnet>.ts.net`).

Saving persists both fields to `~/.isomux/office-config.json` and mints an owner self-invite bound to the new URL so you can sign in on the new origin immediately. The toggle takes effect on the next isomux restart (the pane spells out the restart command: `systemctl --user restart isomux` for a user service, `sudo systemctl restart isomux` for a system one). Restart is intentional: changing the reachability and cookie/origin policy mid-process is brittle, and the toggle is rare enough that "save then restart" is the right trade.

The same file can set `networkBind` to `"loopback"`, `"all"`, or `"auto"`. `"auto"` keeps today's rule: loopback before claim or while external access is off, and all interfaces otherwise. Remove the field to use the same runtime default while allowing the installer or updater to select `"loopback"` when it verifies a local proxy. An explicit `"auto"` opts out of that automatic installer change. The loopback listener uses IPv4 `127.0.0.1`; callers that use `localhost` fall back to it on dual-stack hosts.

The tunnel-setup agent prompt ([self-hosted setup](self-hosted.md#other-users-public-url)) ends at "report the public URL." The final step - telling the running office about that URL - is a paste into the Access pane, so the office's auth-state mutation goes through the same in-process mutex as every other settings change.

The resolved value drives:

- The Origin allowlist for WebSocket upgrades.
- The Origin allowlist for state-changing HTTP requests.
- Whether the session cookie's `Secure` attribute is set (set on `https://`, omitted on `http://localhost`).
- The base URL for invite URLs.

The Public URL is **operator-authored configuration**. The server never infers the origin from `Host` or `X-Forwarded-Host` headers, since that's how WebSocket-hijacking bugs happen. An invalid value in `office-config.json` is logged and ignored at boot; the server degrades to the localhost fallback.

## State files

Stored in `~/.isomux/`:

- `users.json` - user profiles. Each record carries `role: "owner" | "member"`.
- `invites.json` - outstanding invites, keyed by sha256(token). Raw tokens never persist; only the hash and an 8-char display prefix.
- `sessions.json` - active sessions, keyed by sha256(session-id). Raw IDs never persist.

All three files are written atomically (temp + rename) and serialized under a single in-process mutex so invite acceptance (which touches all three) can't race.

## Cookie semantics

- Name: `__Host-isomux_session`, or `isomux_session` on `http://localhost*`, which cannot carry the `Secure` the prefix requires. The prefix is browser-enforced to be host-only, so a page on a subdomain of the office cannot write the cookie the office reads. Both names are accepted; an existing session moves onto the prefixed name on its next page load, WebSocket connection, or read-only API request.
- Attributes: `HttpOnly; Path=/; SameSite=Lax`
- `Secure` set when the configured Public URL is `https://`, omitted when the server is on `http://localhost*` (pre-claim, or post-claim with external access off).
- Rolling expiry: 30 days, refreshed on activity.
- Absolute cap: 1 year from creation.

The 1-year cap is a deliberate usability/security trade-off. The
cookie carries `HttpOnly`, `SameSite=Lax`, `Secure`-on-HTTPS,
host-only scope, and a per-message server-side recheck so a revoke
from the Sessions pane disconnects an active session within ~1s - the
residual risk is the shared-device case where the user forgot to
sign out (the security audit calls this out under external-access
"session lifetime on shared devices"). Devices used in untrusted
environments should be revoked from the Sessions pane (or signed out
explicitly) rather than relying on session expiry.

## Trust model boundaries

- **Inside the office, authenticated users have shell-equivalent access.** Members can use the terminal panel to read any file the isomux process can read, including other users' env files. The owner/member split controls who **expands the trust boundary** (mints invites for new identities, revokes sessions), not what they can do once inside. OS-level isolation between members is a separate concern (tracked as a follow-up task).
- **Agents run with the host Linux user's permissions.** The cookie auth doesn't constrain what an agent does once it's spawned in the office.
- **Session revocation stops future use of a session but doesn't undo past actions.** Anything the leaked session already wrote stays written.

## Use your own provider account

In User Settings → Connections, choose whether the account is for every agent
in the office or only agents you spawn. Claude and Codex support browser sign-in
in either scope. Isomux creates a separate personal provider home when needed.

If both exist, the personal account wins: an agent whose user has set their own
provider directory uses that account, even when the office is signed in.

Set your Env File Path in User Settings to a file with one of these API keys:

```text
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

An explicit absolute provider directory in the env file still overrides the
Isomux-managed personal directory. Isomux does not expand `~` or `$VAR` there.

```text
CLAUDE_CONFIG_DIR=/home/<linux-user>/.isomux-users/<user>/.claude
CODEX_HOME=/home/<linux-user>/.isomux-users/<user>/.codex
```

## Bootstrap-window exposure

Before an owner exists, the first-owner form is served only on `127.0.0.1`, so the OS bind rules out off-box clients regardless of LAN/VPN topology - Isomux is not reachable to an outside attacker.

The residual gap: a same-host reverse proxy or tunnel (Tailscale Funnel, Caddy → localhost, etc.) configured **before** an owner claims can forward external traffic to `localhost:4000`, and from Isomux's point of view that connection looks loopback. Anyone who can reach the proxy from outside could claim ownership through it. This is an inherent limit of the proxy-on-same-host topology; isomux can't tell the proxy is there.

The mitigation is operator discipline: **claim first, expose later**. The Access pane's _External access_ toggle is the supported sequence - boot the server, open it locally (or via `ssh -L`), claim, then flip the toggle to enable external listening and configure the proxy.

## Locked out as owner

If you somehow lose your only owner session (cleared cookies, hit the 1-year absolute cap, etc.), recover with the owner-login CLI from a shell on the box:

```
bun run server/isomux-office.ts owner-login --name "<your-display-name>"
```

That prints a one-time login URL valid for 15 minutes. The CLI talks to the running server over a Unix-domain socket at `~/.isomux/admin.sock` (mode 0600 - only the Isomux service user can connect), so on a multi-user box only the UID running isomux can mint recovery URLs. The server has to be running for the CLI to work.

## Operating notes

- **Members lose access at server restart? No.** Sessions persist to disk; restarts pick up the in-memory map from `sessions.json`.
- **Revoking a live session?** The Sessions pane revoke button: the corresponding WebSocket force-closes within ~1s (per-message session recheck catches it). HTTP requests with the revoked cookie return 401 immediately.
- **Member tries to mint an invite for a new user?** Rejected at the wire level. Members can mint device links for their own additional devices (1h TTL, max 1 active) but can't invite new identities. The account panes are scoped per role; the server-side check is the actual gate.
- **Owner tries to mint an invite for an existing user?** Rejected too (409): invites create new users only, and device links are self-service. To get a locked-out user back in, use the Recovery card in the Invites section.
- **CSRF / CSWSH?** Origin is checked on WS upgrade and on state-changing HTTP methods. Browsers always send Origin; non-browser callers (agents on the same host) don't. Everything an agent calls is bearer-authenticated (each agent's injected `ISOMUX_AGENT_TOKEN`); there is no loopback bypass left.

## Personal API tokens

A signed-in user can create a named personal API token in **User Settings → API tokens**. Tokens expire after 30 days (the default), 365 days, or never. The raw token is shown once. Isomux stores only its SHA-256 hash and a short display prefix.

Personal tokens have a separate API identity scope. They carry the issuing user's curated operational reach across agents, rooms, tasks, apps, logs, cron jobs, editor and file actions, memory, and office reads. They can list live and killed agents, drive agents, and drain replies that agents send to the token's durable inbox. They cannot manage API tokens or other durable identity access, browser sessions, user access, office settings, or the privileged-agent flag. The server reads the issuing user and role again for each request, so deletion, demotion, room-access changes, expiry, and revocation take effect on the next request.

The token list shows the approximate time of the last authenticated request. Isomux writes this metadata at most once per minute, and it does not mean that the later route succeeded. Revoke a token from the same pane when a device is lost or a credential may have leaked.
