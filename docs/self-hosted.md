# Self-hosted setup

> You don't need to read this. Point your agent of choice to this page and ask it to walk you through configuring the best setup for your use case. **Reminder: running it locally (like you would Claude Code) requires no setup at all.** This page is for people who want features like always-on agents and personal apps, multi-device support, and human collaboration.

Isomux is at its best when you run it on an always-on box - a Mac mini, a spare Linux machine, a rented cloud server - and have it reachable from all your devices and from anyone you've invited.

There are three pieces to a working setup: keep the server **running** when nobody is logged in, make it **reachable** from the devices and people who need it, and **authorize** who can use it.

- On a rented cloud server, the [VPS install](#vps-install) covers all three unattended: one command installs everything, hardens the box, serves the office over HTTPS at your domain, and hands you a sign-in link.
- On [your own hardware](#your-own-hardware), you set up the three pieces yourself.

The last section states [what Isomux protects and records](#what-each-deployment-covers) in each setup.

## VPS install

You need:

- A fresh Ubuntu 24.04 server with root access (a cheap cloud VPS works).
- A domain with an A record pointing at the server's IP. A wildcard record beside it (`*.office.example.com`, pointing at the same server) gives each app [its own address](#app-hostnames).

For more details on this setup, see [this blog post](https://nilmamano.com/blog/hosted-isomux).

### Run the installer

As root on the server:

```bash
(
  installer=$(mktemp) || exit
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh -o "$installer" &&
    DOMAIN=office.example.com bash "$installer"
)
```

Or as cloud-init user data when creating the server:

```bash
#!/bin/bash
set -e
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh -o "$installer"
DOMAIN=office.example.com bash "$installer"
```

After a few minutes the installer prints a single-use owner invite link, also saved on the server at `/var/lib/isomux-install/invite-url`. Open it on any device within 24 hours to sign in as the owner at `https://office.example.com`.

When the output isn't going to a terminal - cloud-init, a piped log, an agent running the command for you - the installer names that file instead of printing the link, so a live credential doesn't end up sitting in a log.

### What the installer does

Everything below is one script, [`deploy/install.sh`](https://github.com/nmamano/isomux/blob/main/deploy/install.sh).

- Installs bun, Node.js, the Claude Code CLI, GitHub CLI, git, Caddy, and Chrome (headless, for the agents' page-preview cards, and as the browser Playwright drives when an agent wants to look at a page it just changed); fetches isomux and builds it.
- Runs isomux as a systemd service under a dedicated `isomux` user, restarting on failure and on boot.
- Sets up the `isomux` account so apps agents build keep running without anyone logged in and start again after a reboot.
- Serves your domain through Caddy with an automatic Let's Encrypt certificate. Caddy keeps a size-bounded request log for 14 days and redacts invite and app sign-in credentials from URLs. Its admin API is turned off, since anything on the box could otherwise reconfigure the proxy without a credential - so apply Caddyfile edits with `systemctl restart caddy`, not `reload`.
- Hardens the box: firewall allowing only web traffic and, unless disabled, SSH; key-only SSH auth; unattended security updates (a standard Ubuntu feature - it patches system packages, never isomux itself).
- Checks that the `isomux` account cannot log in as root, and stops the install if the account can. See [root access](#root-access).
- Sets up out-of-memory protection so a busy office can't lock the box up. See [running out of memory](#running-out-of-memory).
- Makes the sandbox that Codex agents run their tools in actually work. On Ubuntu 24.04 that takes one small AppArmor policy file which the sandbox's own package doesn't ship. The installer tries the sandbox first and only acts if it is broken, so a box where it already works is left alone. If the installer still can't get the sandbox working, the install carries on and says so in the output.
- Keeps the office inside a memory limit derived from the box's RAM, with room left for SSH and the operating system. Boxes with less than 4 GB RAM are left uncapped.
- Claims the office owner over loopback before the box is exposed, then mints your invite link.

### Root access

Agents run as the `isomux` account, so anything that account can do, an agent can do. If that account can log in as root, it can turn off every guardrail isomux puts in front of it.

The installer does not take that on trust - it tries to log in as that account, at every address SSH answers on, and it also asks what the account may do with `sudo`. Twice: as soon as the account exists, and again on the finished box, before you get an invite link. If it gets in, the install stops. If it can't tell, the install stops too. There is no way to skip the check; the box has to be fixed instead.

What the check promises when it passes: the isomux service account cannot log in as root over SSH on this box, and cannot sudo. There is one deliberate exception - that account can ask root to apply an isomux release, which is what the update button in the office header runs. It can start nothing else.

The usual cause of a failure is a key file kept on the server that root accepts. The key from your own computer is fine - that file stays on your computer. A key made _on_ the box, for GitHub or a deploy script, is not: anything running there can read it and log in as root with it. When the check fails it names the file and tells you which line to remove.

After fixing it:

```bash
sudo isomux-harden-ssh
```

That command applies the SSH hardening and re-runs the check. A pass is a snapshot of the moment it runs - giving root a new key later reopens the hole - so run the command again whenever root's key list changes.

Each Isomux update re-runs a read-only check of the firewall and the SSH boundary on an installer-managed VPS, and prints a warning when either no longer holds. The same check, on demand, is `sudo isomux-verify-hardening --check`; it changes nothing.

### Parameters

Environment variables, set before running:

| Variable      | Default        | Meaning                                                          |
| ------------- | -------------- | ---------------------------------------------------------------- |
| `DOMAIN`      | (required)     | Public domain for the office.                                    |
| `ISOMUX_REF`  | latest release | Git branch, tag, or commit to install.                           |
| `ISOMUX_REPO` | GitHub         | Git repo to install from (for forks).                            |
| `SSH_PORT`    | `22`           | SSH port to allow through the firewall; `none` keeps SSH closed. |
| `DRY_RUN`     | (unset)        | Set to `1` to print what would run instead of running it.        |

### Re-running

Safe after a failure: completed steps are skipped or redone harmlessly, and a fresh invite link is minted each run. A re-run recovers its owner session automatically; when the office has several owners, the `OWNER_NAME` environment variable names which one to recover. Re-running restarts the isomux service, which interrupts running agents.

### Updating

When a new release is out, the office header shows a "new release" notice. The owner can apply it from there; the confirm step shows how many busy agents the restart would interrupt. Or over SSH as root, with a tag from the [releases page](https://github.com/nmamano/isomux/releases):

```bash
isomux-update v2026.7.19
```

Either way, the update installs any system dependencies the new release needs, rebuilds at the new version, snapshots the office state, and restarts the service - interrupting running agents. If the new version fails to come up, the updater rolls code and state back to what you had. Downgrading to an older release needs `--allow-downgrade`.

### App hostnames

Each app an agent registers can get its own address, like `hello.office.example.com`, open from any device and behind the same sign-in as the office. A fresh install sets up the proxy side, and the wildcard A record ([above](#vps-install)) points the names at the server. An office installed before this existed gets the proxy side from one re-run of the installer, or from adding the site block to `/etc/caddy/Caddyfile` by hand; an update replaces only a byte-exact older installer rendering, and only to add its access log.

Certificates are obtained per app the first time it is opened. Two things follow:

- The office answers 404 for every name under its domain that is not a live app, so a subdomain you pointed at this server for something else stops working after updating.
- Deleting an app stops new certificates immediately, but TLS may keep terminating from Caddy's warm cache until its next cold load.

A tailnet office (`*.ts.net`) keeps port links: Tailscale has no wildcard names, so app hostnames can't resolve there.

### Opening an agent's dev server

An app an agent is running on the box - say on port 5173 - isn't exposed to the internet. If SSH is open (the default), forward the port from your own machine:

```bash
ssh -L 5173:localhost:5173 root@office.example.com
```

Then open `http://localhost:5173`.

### Notes

- The invite link is a credential until it's used or expires. It appears in the install output only when that output goes to a terminal; otherwise the output names `/var/lib/isomux-install/invite-url` and you read the link from there as root. That keeps it out of logs that capture stdout, like cloud-init's `/var/log/cloud-init-output.log`.
- If you've hand-edited a package's config file - `/etc/caddy/Caddyfile` is the likely one - the installer and `isomux-update` keep your version when the package ships a new one, and name the files they kept. The package's version is parked beside each as `<file>.dpkg-dist`; reconciling the two is up to you.
- The service is system-level: restart with `systemctl restart isomux` as root. An office on [your own hardware](#your-own-hardware) runs a user-level service instead, where the commands are `systemctl --user`.
- SSH hardening is skipped, loudly, if the box has no SSH key on it yet: turning off password logins there would lock you out. Add your key, then run `sudo isomux-harden-ssh`.
- Chrome backs page-preview cards and app screenshot previews. If it can't be installed - no amd64 build for the box, a failed download, or a test capture that comes back empty - the installer warns and carries on without it.
- Authenticated users effectively have shell access to the server (agents run commands as the `isomux` user). Only invite people you trust; see [access and invites](access-and-invites.md).

## Your own hardware

A Mac mini, a spare Linux machine, anything always-on. The host needs the same prerequisites as a local install: Bun (v1.2+) and Node.js 20+, which the embedded terminal runs on. Optional: a Chrome-family browser on the host enables browser preview cards and app screenshot previews.

### Keep the server running

Drop this prompt into one of your Isomux agents to get a systemd user service that auto-restarts and survives logout:

```
Set up Isomux as an always-on server. Create a systemd user service
that auto-rebuilds the UI on start and restarts on failure. Enable
lingering so it survives logout. Put OOMPolicy=continue,
StartLimitIntervalSec=0 and RestartSec=5s on the unit: one agent
killed for memory should not restart the office, and a burst of
kills should not leave it switched off for good.

If you run into any issues with this setup, ask in the Isomux
Discord: https://discord.gg/FrjEYyNvYs
```

The agent will install the unit, enable lingering, and verify the service is up.

The prompt is Linux/systemd-centric. The macOS equivalent is launchd, the Windows equivalent is Task Scheduler - adjust accordingly or ask in [Discord](https://discord.gg/FrjEYyNvYs).

### Make the office reachable

The server runs on `localhost:4000`. To use it from another device or share it with another user, you need to expose it. Two paths, depending on who needs access.

> **Before any of this works from another device, claim the office locally first.** Pre-claim, the server binds 127.0.0.1 only - so `http://my-mac-mini:4000` will return connection refused until you (a) claim ownership from the host (or via `ssh -L`, see [Authorize users](#authorize-users)), and (b) enable _External access_ in User Settings → Access and restart the service. The [access-and-invites doc](access-and-invites.md) has the full sequence.

#### Your devices (and anyone willing to install Tailscale)

[Tailscale](https://tailscale.com/) (free) gives every device on your tailnet a private hostname and stitches them into an encrypted mesh. Install on the server, your laptop, and your phone:

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Rename your machine in the [Tailscale admin console](https://login.tailscale.com/admin/machines) to something friendly (e.g. `my-mac-mini`). Once the office is claimed and External access is on, open from any tailnet device at `http://my-mac-mini:4000`.

This works fine for _your_ devices and for collaborators you trust enough to invite onto your tailnet. Invite links work over the tailnet, but invitees have to install Tailscale and join your tailnet first. Most people, though, will not want to install Tailscale just to drop into your office - for them you need a public URL.

#### Other users (public URL)

The recommended path is **Tailscale Funnel**. Funnel exposes a single port on the box to the public internet over its existing `*.ts.net` hostname. Free, no domain to buy, no router port-forwarding, no inbound IP exposure. Tailscale's relay forwards an encrypted TCP tunnel between the visitor and your node; TLS terminates on your box, not at the relay, so the relay cannot read traffic in flight.

Trade-offs:

- **Dependency on Tailscale's relay and control plane.** Your reachability is contingent on Tailscale's infrastructure being up and on Tailscale not changing the free tier in adverse ways.
- **Public DNS visibility.** Your `*.ts.net` hostname (and therefore your tailnet name) becomes resolvable from the public internet and appears in Certificate Transparency logs once Tailscale provisions a Let's Encrypt cert.

To set this up, claim ownership of your office first ([Authorize users](#authorize-users)), then paste the following prompt into one of your isomux agents. The agent will install Tailscale if needed, walk you through enabling Funnel in the admin console, detect any existing services sharing port 443, and finish by reporting the public URL back to you. The final step (turning external access on inside the office) is a manual paste into the Access pane so the office's auth-state mutation goes through the documented configuration surface.

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
   to expose publicly, (b) move it to a different port and update
   the Serve config yourself, since Claude agents refuse recognized
   tunnel commands, or (c) remove it. If moving to a
   different port, prefer a port outside Tailscale's
   Funnel-eligible list (avoid 443, 8443, 10000) so a future
   Funnel command can't accidentally expose it.

5. Once port 443 carries only the isomux mapping, ask me to run this command
   myself, because Claude agents refuse recognized tunnel commands:
   `tailscale funnel --bg http://localhost:4000`

6. Capture the public URL from `tailscale funnel status --json`
   and report it back to me with these exact instructions:

     "Funnel is up at <URL>. To finish, in your isomux office
      open User Settings → Access → External access, enable the
      toggle, paste this URL into the Public URL field, click
      Save, then restart isomux for the bind to take effect (on a
      system service, run sudo systemctl restart isomux instead):
        systemctl --user restart isomux
      Sign in on the public URL using the link the Access pane
      shows you after Save."

7. Verify the public URL responds. Ask me to test from a device
   not on the tailnet (phone on cellular, or any non-tailnet
   machine). A curl from the box itself goes over the tailnet
   path and isn't a true public-reachability check.

If you run into any issues with this setup, ask in the Isomux
Discord: https://discord.gg/FrjEYyNvYs
```

**Alternative: Caddy + your own DNS.** No third-party hop in the data path. Open port 443 on your router, point a DNS A record at your home IP (or use DDNS), run Caddy in front of isomux with `reverse_proxy localhost:4000` (Caddy auto-provisions a Let's Encrypt cert), then enable _External access_ in the Access pane with your `https://` URL and restart. Trade-offs: your home IP is publicly visible, you carry any DDoS surface, and the path fails if your ISP puts you behind CG-NAT.

Cloudflare Tunnel is another outbound-tunnel option (same shape as Funnel using Cloudflare's edge; requires a domain on a Cloudflare-managed zone).

#### Install on mobile (PWA)

Once the office is reachable from your phone (over your VPN or a public URL), install it as a PWA for a native-app feel:

- **iPhone:** Safari → Share → "Add to Home Screen".
- **Android:** Chrome prompts you to install on first visit. Requires HTTPS - see the next subsection.

#### Enable HTTPS (for voice input and Android PWA install)

Some features require a **secure context** (HTTPS or localhost):

- **Voice input** - browser microphone access requires HTTPS.
- **PWA install on Android** - Chrome's install prompt requires HTTPS.

These work on `localhost` without setup. A public URL via Tailscale Funnel already provides HTTPS. For HTTPS over a private tailnet (no Funnel), enable Tailscale's built-in cert:

Open the [DNS page](https://login.tailscale.com/admin/dns) of your Tailscale admin console. Turn on **MagicDNS** and **HTTPS Certificates**. Then run these commands yourself on the server. Claude agents refuse recognized tunnel commands.

```
sudo tailscale set --operator=$USER
tailscale serve --bg http://localhost:4000
```

Visit the HTTPS URL the command prints (e.g. `https://my-mac-mini.<tailnet>.ts.net`) - voice and Android PWA install will now work from any tailnet device. To make that URL the office's own address, open the Access pane, enable _External access_, paste it into the Public URL field, save, and restart isomux.

### Authorize users

Isomux gates every browser request (HTTP and WebSocket) by a session cookie. No accounts, no passwords.

To grant someone access, mint a single-use invite link in `User Settings → Invites` and send it to them out-of-band (Signal, text, email). They click and they're in.

Two roles exist:

- **Owner** - can mint invites, revoke sessions, and set per-user room access.
- **Member** - can use the office in the rooms the owner permits, can't invite or revoke.

To claim the office as the first owner, open `http://localhost:4000` on the host machine and submit a display name. From a different machine, tunnel in first with `ssh -L 4000:localhost:4000 <user>@<host>` and then open `http://localhost:4000` in your local browser.

For the full flow - invite TTLs, multi-device users, sign-out, owner recovery, threat model - see [access and invites](access-and-invites.md).

> **Note:** Isomux agents can run shell commands, so authenticated users effectively have shell access to the host. Only invite people you trust.

> **Don't store an SSH key on the host that root accepts** - agents can read the host's files and would become root with it. See [root access](#root-access) for the check and the fix.

### Provider API keys

Each user can add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`OPENCODE_API_KEY` under User Settings → Environment Variables. Isomux creates
and updates a private per-user file under `~/.isomux/`; users do not need to
create or edit that file on the server.

An office env file can still provide variables to every user. Per-user managed
variables override office values.

## Backups

Isomux stores seven daily backups of `~/.isomux/` in the server's backup directory on the same disk as the office, so copy them elsewhere if you need protection from server loss. Current backup health and the exact directory are at `GET /api/backup/status`.

## Running out of memory

A busy office can use up the box's memory. Left to the kernel that ends badly: the machine swaps until nothing responds, SSH included, and on a cloud box only a reboot from the provider's console brings it back.

Isomux handles its half automatically: the office marks every process it starts as a better out-of-memory kill candidate than the office server itself, so a spike usually costs one runaway agent or build instead of the whole office. A killed agent is a papercut - message it again and it comes back. Linux only, no setup, no privileges.

The box-wide half is [earlyoom](https://github.com/rfjakob/earlyoom), which kills one process while there is still memory left to act with. The order is deliberate: agent processes go first, then the office server and Caddy, and last of all what keeps the box reachable and usable at all - SSH, Tailscale, DNS, networking. Anything it kills from that last group is set to keep retrying rather than give up, so a burst of kills can't leave DNS or the office switched off for good. The same setup also gives the box a swap file of up to 8 GB if the box has none, smaller only if the disk cannot hold that, and tells the kernel to prefer dropping caches over swapping. The size is deliberate: swap that runs out mid-spike is worse for the office than swap that is simply large. A small root timer re-applies the office's own kill-order stamp within a minute of any office restart - a user-level service cannot hold that setting itself.

The [VPS install](#vps-install) sets all of this up and leaves the tool on the box:

```bash
sudo isomux-oom-protect --dry-run   # print what would change
sudo isomux-oom-protect
```

On your own hardware, the same script runs from your checkout as `sudo bash deploy/oom-protect.sh`, and installs itself at `/usr/local/sbin/isomux-oom-protect`. Either way the run is safe on a live office: nothing but earlyoom is restarted, and swap the box already has is left exactly as it is, even when it is smaller than a fresh install would get - replacing live swap means taking it offline first, which is not something to do to a running box on your behalf. The run prints the commands if you want to do it yourself.

macOS and Windows get neither half - both mechanisms are Linux-specific.

## What each deployment covers

Two facts set the boundary: whether a proxy sits in front of Isomux, and whether the office has a real domain. Only a real domain gives apps their own web addresses.

**Hosted Isomux** in the first two rows is [the paid managed service](https://isomux.com/hosted), where we run the server for you.

### Proxy and real domain

| Shape                               | Reach the office | App addresses                                                        | Firewall                                                                                      | Request log                                                                                                                                 | Isomux does not cover                                                                      |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| New Hosted Isomux office            | Its HTTPS domain | One hostname per app                                                 | The installer configures it. Updates verify it and report a warning without changing it.      | Caddy records client address, host, redacted path, status, and time for 14 days.                                                            | Provider controls and traffic that bypasses Caddy.                                         |
| Existing Hosted Isomux office       | Its HTTPS domain | One hostname per app                                                 | The installer owns it. Updates verify it and report a warning without changing it.            | The first update adds the same 14-day Caddy log when the front-door config still matches the installer exactly.                             | Provider controls, traffic that bypasses Caddy, and request history before logging starts. |
| Self-hosted VPS installed by Isomux | Its HTTPS domain | One hostname per app                                                 | The operator owns it. The installer configures it, and updates verify it without changing it. | A current install records the same 14-day Caddy log. An update adds it to an exact older installer rendering; an edited file is left alone. | Provider controls, operator changes, and traffic that bypasses Caddy.                      |
| Hand-provisioned VPS                | Its HTTPS domain | One hostname per app when the operator configured the wildcard proxy | The operator owns and verifies it. Isomux updates do not assume the installer configured it.  | Only what the operator configured. An update changes only a byte-exact installer Caddyfile.                                                 | Firewall setup, proxy maintenance, retention, and traffic that bypasses the proxy.         |

When an active Caddy config forwards to `127.0.0.1:4000`, an install or update records that fact in the office config. After the update restarts Isomux, the direct `:4000` address stops answering; the Caddy address keeps working. This also applies to a hand-provisioned VPS. Set `networkBind` to `"all"` in `~/.isomux/office-config.json` before the update to keep the direct port.

### Proxy and no real domain

| Shape                                   | Reach the office             | App addresses                              | Firewall                                                             | Request log                                                   | Isomux does not cover                                                |
| --------------------------------------- | ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Home box with Tailscale Serve or Funnel | Its `*.ts.net` HTTPS address | No separate hostnames; use each app's port | The operator owns it. The installer does not configure or verify it. | No Isomux Caddy access log. Tailscale controls any proxy log. | Tailscale policy, firewall policy, proxy logs, and direct app ports. |

The Isomux installer and updater do not manage this shape, so updates do not change its network bind.

### No proxy and no real domain

| Shape                 | Reach the office        | App addresses                              | Firewall                                                             | Request log               | Isomux does not cover                                         |
| --------------------- | ----------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Home box on a tailnet | `http://name:4000`      | No separate hostnames; use each app's port | The operator owns it. The installer does not configure or verify it. | No front-door access log. | Tailnet access, firewall policy, request logs, and app ports. |
| One local machine     | `http://localhost:4000` | No separate hostnames; use each app's port | The machine owner controls it.                                       | No front-door access log. | Other local processes and any exposure the operator adds.     |

These shapes do not run the system installer or its service-account updater. They get neither its firewall verification nor its Caddy access log, and updates do not change their network bind.
