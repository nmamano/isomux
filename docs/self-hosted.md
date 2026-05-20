# Self-hosted setup

Isomux is at its best when you run it on an always-on box — a Mac mini, a spare Linux machine, anything — and have it reachable from all your devices and from anyone you've invited. Same office for laptop, phone, friends, collaborators. Agents keep running even after you close the browser.

There are three pieces to set up: keep the server **running** when nobody is logged in, make it **reachable** from the devices and people who need it, and **authorize** who can use it.

## 1. Keep it running

Drop this prompt into one of your Isomux agents to get a systemd user service that auto-restarts and survives logout:

```
Set up Isomux as an always-on server. Create a systemd user service
that auto-rebuilds the UI on start and restarts on failure. Enable
lingering so it survives logout.

If you run into any issues with this setup, ask in the Isomux
Discord: https://discord.gg/FrjEYyNvYs
```

The agent will install the unit, enable lingering, and verify the service is up.

The prompt is Linux/systemd-centric. The macOS equivalent is launchd, the Windows equivalent is Task Scheduler — adjust accordingly or ask in [Discord](https://discord.gg/FrjEYyNvYs).

## 2. Make it reachable

The server runs on `localhost:4000`. To use it from another device or share it with another user, you need to expose it. Two paths, depending on who needs access.

### Your devices (and anyone willing to install Tailscale)

[Tailscale](https://tailscale.com/) (free) gives every device on your tailnet a private hostname and stitches them into an encrypted mesh. Install on the server, your laptop, and your phone:

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Rename your machine in the [Tailscale admin console](https://login.tailscale.com/admin/machines) to something friendly (e.g. `my-mac-mini`), then open from any tailnet device at `http://my-mac-mini:4000`.

This works fine for _your_ devices and for collaborators you trust enough to invite onto your tailnet. Most people, though, will not want to install Tailscale just to drop into your office — for them you need a public URL.

### Other users (public URL)

The recommended path is **Tailscale Funnel**: it exposes your existing tailnet hostname (`*.ts.net`) to the public internet without buying a domain or opening router ports. TLS terminates on your box, not at the Tailscale relay.

The [access-and-invites doc](access-and-invites.md#recommended-tailscale-funnel) has the full agent prompt that walks you through Funnel setup — including the safety checks for existing port-443 services and the hand-off to the Access pane to enable external access. Cloudflare Tunnel and Caddy alternatives are documented in the same file.

### Install on mobile (PWA)

Once the office is reachable from your phone (over the tailnet or a public URL), install it as a PWA for a native-app feel:

- **iPhone:** Safari → Share → "Add to Home Screen".
- **Android:** Chrome prompts you to install on first visit. Requires HTTPS — see the next subsection.

### Enable HTTPS (for voice input and Android PWA install)

Some features require a **secure context** (HTTPS or localhost):

- **Voice input** — browser microphone access requires HTTPS.
- **PWA install on Android** — Chrome's install prompt requires HTTPS.

These work on `localhost` without setup. A public URL via Tailscale Funnel already provides HTTPS. For HTTPS over a private tailnet (no Funnel), enable Tailscale's built-in cert:

Open the [DNS page](https://login.tailscale.com/admin/dns) of your Tailscale admin console. Turn on **MagicDNS** and **HTTPS Certificates**. Then on the server:

```
sudo tailscale set --operator=$USER
tailscale serve --bg http://localhost:4000
```

Visit the HTTPS URL it prints (e.g. `https://my-mac-mini.<tailnet>.ts.net`) — voice and Android PWA install will now work from any tailnet device.

## 3. Authorize users

Isomux gates every browser request (HTTP and WebSocket) by a session cookie. No accounts, no passwords.

To grant someone access, mint a single-use invite link in `User Settings → Access` and send it to them out-of-band (Signal, text, email). They click and they're in.

Two roles exist:

- **Owner** — can mint invites, revoke sessions, and set per-user room access.
- **Member** — can use the office in the rooms the owner permits, can't invite or revoke.

To claim the office as the first owner, open `http://localhost:4000` on the host machine and submit a display name. From a different machine, tunnel in first with `ssh -L 4000:localhost:4000 <user>@<host>` and then open `http://localhost:4000` in your local browser.

For the full flow — invite TTLs, multi-device users, sign-out, owner recovery, threat model — see [access and invites](access-and-invites.md).

> **Note:** Isomux gives shell-equivalent access to authenticated users. Only invite people you trust.
