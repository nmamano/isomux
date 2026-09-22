# Hosting reference

Choose a complete setup guide on the [hosting page](self-hosted.md). This page covers optional configuration and deployment boundaries.

## What the installer does

Everything below is one script, [`deploy/install.sh`](https://github.com/nmamano/isomux/blob/main/deploy/install.sh).

- Installs bun, Node.js, build-essential, python3, the Claude Code CLI, GitHub CLI, git, Caddy, and Chrome (headless, for page-preview cards and app screenshots); fetches isomux and builds it.
- Runs isomux as a systemd service under a dedicated `isomux` user, restarting on failure and on boot.
- Sets up the `isomux` account so apps agents build keep running without anyone logged in and start again after a reboot.
- Serves your domain through Caddy with an automatic Let's Encrypt certificate. Caddy keeps a size-bounded request log for 14 days and redacts invite and app sign-in credentials from URLs. Its admin API is turned off, since anything on the box could otherwise reconfigure the proxy without a credential - so apply Caddyfile edits with `systemctl restart caddy`, not `reload`.
- Hardens the box: firewall allowing only web traffic and, unless disabled, SSH; key-only SSH auth; unattended security updates (a standard Ubuntu feature - it patches system packages, never isomux itself).
- Checks that the `isomux` account cannot log in as root, and stops the install if the account can. See [root access](#root-access).
- Sets up out-of-memory protection so a busy office can't lock the box up. See [running out of memory](#running-out-of-memory).
- Makes the sandbox that Codex agents run their tools in actually work. On Ubuntu 24.04 that takes one small AppArmor policy file which the sandbox's own package doesn't ship. The installer tries the sandbox first and only acts if it is broken, so a box where it already works is left alone. If the installer still can't get the sandbox working, the install carries on and says so in the output.
- Keeps the office inside a memory limit derived from the box's RAM, with room left for SSH and the operating system. Boxes with less than 4 GB RAM are left uncapped.
- Claims the office owner over loopback before the box is exposed, then mints your invite link.

## Root access

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

## Parameters

Environment variables for the default direct-host installation, set before running:

| Variable              | Default        | Meaning                                                                  |
| --------------------- | -------------- | ------------------------------------------------------------------------ |
| `ISOMUX_INSTALL_MODE` | `host`         | Set to `container` for the [AWS container installation](hosting-aws.md). |
| `DOMAIN`              | (required)     | Public domain for the office.                                            |
| `ISOMUX_REF`          | latest release | Git branch, tag, or commit to install.                                   |
| `ISOMUX_REPO`         | GitHub         | Git repo to install from (for forks).                                    |
| `SSH_PORT`            | `22`           | SSH port to allow through the firewall; `none` keeps SSH closed.         |
| `DRY_RUN`             | (unset)        | Set to `1` to print what would run instead of running it.                |

## App hostnames

Each app an agent registers can get its own address, like `hello.office.example.com`, open from any device and behind the same sign-in as the office. A fresh install sets up the proxy side, and the wildcard A record ([VPS guide](hosting-vps.md)) points the names at the server. An office installed before this existed gets the proxy side from one re-run of the installer, or from adding the site block to `/etc/caddy/Caddyfile` by hand; an update replaces only a byte-exact older installer rendering, and only to add its access log.

Certificates are obtained per app the first time it is opened. Two things follow:

- The office answers 404 for every name under its domain that is not a live app, so a subdomain you pointed at this server for something else stops working after updating.
- Deleting an app stops new certificates immediately, but TLS may keep terminating from Caddy's warm cache until its next cold load.

A tailnet office (`*.ts.net`) keeps port links: Tailscale has no wildcard names, so app hostnames can't resolve there.

## Desktop Chrome extension

Server browser mode and its remote panel are retired. Existing Chrome pairings remain valid. Old Server browser selections now require Chrome pairing and a tab offer. Saved server browser profiles stay on disk and are not used or imported. Legacy panel settings are ignored. Server screenshot previews still support public HTTP(S) sites and office-hosted pages.

In **Settings → You → Browser Use**, download the extension ZIP and extract it. In desktop Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted folder. Pin **Isomux Browser** to the toolbar.

Create a pairing code in Browser settings. Open the extension and enter the office HTTPS address and code. Codes expire after five minutes. Each member pairs their own browser; agents use their manager's connection. Another chat speaker does not change the browser owner.

Chrome warns **Read your browsing history**. The extension uses this permission to bind site-opened popups to the agent's tab. It does not collect browsing history. Chrome also shows its own debugger warning during control.

Open an HTTP(S) tab, choose **All** (the default) or an agent in the extension popup, and turn on **Agent control**. The agent can read the page immediately and navigate that same tab. An individual agent can have one exclusive offered tab. Any number of tabs can be offered to All eligible agents managed by the paired member. An individual offer takes precedence; with several All tabs, agents use `tabs` and an explicit `target` to choose. Actions on each grant run one at a time, including timeout recovery. Before offering it, choose when control expires: **Never** (the default), **15 minutes**, **1 hour** or **4 hours**. Timed control starts when the offer succeeds; the popup shows its local expiry time. Agent actions do not extend the deadline. Turn control off before changing its expiry or assigning the tab to another agent.

Agents can attach one office-server file to an exact file input with the browser `upload` action. The file must be a regular file up to 4 MiB; sensitive files are refused. The office sends the bytes to Chrome, so the path refers to the server, not the desktop. Upload replaces the input’s selection. Sites may upload as soon as a file is selected; the action does not press Submit or Publish.

The **ON** badge marks offered tabs and their site-opened popups. Other tabs have no badge. The popup separates the Office connection from Agent control and names All or the assigned agent. Stopping control leaves pages open. The popup can also disconnect or unpair. Disconnect stays off until Reconnect. Offline revocation is available in office Browser Use settings. If an unpair acknowledgement is lost, the popup reports an unknown result; check the office settings. Replace pairing ends the previous browser's access when the new code is used.

Chrome mode uses the desktop viewport. Desktop `localhost` refers to the member's computer; preview cards still run on the server. A lost connection releases tab offers. Offer the tab again after reconnecting or reloading the extension. Chrome mode never creates a replacement tab or repeats a command. Check the page before repeating an action with an unknown outcome. An action timeout keeps control ON. If Chrome is still completing a command, the agent must wait for it to settle before another action can run.

Office installs and updates build the ZIP automatically. To update an unpacked extension, download the new ZIP, extract it over its existing folder, and select **Reload** in `chrome://extensions`. Keep that folder in place. Extension 0.4.1 and the matching server use protocol 4; older protocols are refused. Version 0.4.1 adds frame-click support, so update both the server and extension. Reloading releases offers, so offer tabs again. Saved pairing remains, but a terminal version refusal can require pairing again. No Web Store installation is available.

## Native build recovery

On Linux, Bun compiles `node-pty` through a shim that fetches the latest `node-gyp`, whose Node 24 requirement is 24.15.0 or later ([node-gyp requirements](https://github.com/nodejs/node-gyp/blob/main/package.json)).

Check `bun --version`, `node --version`, and `command -v bun node python3 make g++` in the install shell. Install missing prerequisites, then run `bun install --force` from the Isomux directory to rebuild.

If `node-gyp: command not found` persists, [report the error](https://github.com/nmamano/isomux/issues) with those command outputs, the Linux distribution, and the install log. Bun supplies `node-gyp`; a missing compiler produces a different error.

## Provider API keys

Each member can add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`OPENCODE_API_KEY` under Settings → You → Individual connections. Other per-user variables
work the same way, for example, each member can set `GH_TOKEN` so their agents
use their own GitHub credentials.

Office variables load for every agent. Personal variables override office
values.

## Running out of memory

A busy office can use up the box's memory. Left to the kernel that ends badly: the machine swaps until nothing responds, SSH included, and on a cloud box only a reboot from the provider's console brings it back.

Isomux handles its half automatically: the office marks every process it starts as a better out-of-memory kill candidate than the office server itself, so a spike usually costs one runaway agent or build instead of the whole office. A killed agent is a papercut - message it again and it comes back. Linux only, no setup, no privileges.

The box-wide half is [earlyoom](https://github.com/rfjakob/earlyoom), which kills one process while there is still memory left to act with. The order is deliberate: agent processes go first, then the office server and Caddy, and last of all what keeps the box reachable and usable at all - SSH, Tailscale, DNS, networking. Anything it kills from that last group is set to keep retrying rather than give up, so a burst of kills can't leave DNS or the office switched off for good. The same setup also gives the box a swap file of up to 8 GB if the box has none, smaller only if the disk cannot hold that, and tells the kernel to prefer dropping caches over swapping. The size is deliberate: swap that runs out mid-spike is worse for the office than swap that is simply large. A small root timer re-applies the office's own kill-order stamp within a minute of any office restart - a user-level service cannot hold that setting itself.

The [VPS install](hosting-vps.md) sets all of this up and leaves the tool on the box:

```bash
sudo isomux-oom-protect --dry-run   # print what would change
sudo isomux-oom-protect
```

On your own hardware, the same script runs from your checkout as `sudo bash deploy/oom-protect.sh`, and installs itself at `/usr/local/sbin/isomux-oom-protect`. Either way the run is safe on a live office: nothing but earlyoom is restarted, and swap the box already has is left exactly as it is, even when it is smaller than a fresh install would get - replacing live swap means taking it offline first, which is not something to do to a running box on your behalf. The run prints the commands if you want to do it yourself.

macOS and Windows get neither half - both mechanisms are Linux-specific.

## What each deployment covers

Two facts set the boundary: whether a proxy sits in front of Isomux, and whether the office has a real domain. Only a real domain gives apps their own web addresses.

Every shape supports [Claude on Amazon Bedrock](access-and-invites.md#claude-on-amazon-bedrock).
The operator supplies AWS credentials, region, and model access; the installer does not configure AWS.

**Hosted Isomux** in the first two rows is [the paid managed service](https://isomux.com/hosted), where we run the server for you.

## Proxy and real domain

| Shape                               | Reach the office | App addresses                                                        | Firewall                                                                                      | Request log                                                                                                                                 | Isomux does not cover                                                                      |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| New Hosted Isomux office            | Its HTTPS domain | One hostname per app                                                 | The installer configures it. Updates verify it and report a warning without changing it.      | Caddy records client address, host, redacted path, status, and time for 14 days.                                                            | Provider controls and traffic that bypasses Caddy.                                         |
| Existing Hosted Isomux office       | Its HTTPS domain | One hostname per app                                                 | The installer owns it. Updates verify it and report a warning without changing it.            | The first update adds the same 14-day Caddy log when the front-door config still matches the installer exactly.                             | Provider controls, traffic that bypasses Caddy, and request history before logging starts. |
| Self-hosted VPS installed by Isomux | Its HTTPS domain | One hostname per app                                                 | The operator owns it. The installer configures it, and updates verify it without changing it. | A current install records the same 14-day Caddy log. An update adds it to an exact older installer rendering; an edited file is left alone. | Provider controls, operator changes, and traffic that bypasses Caddy.                      |
| Hand-provisioned VPS                | Its HTTPS domain | One hostname per app when the operator configured the wildcard proxy | The operator owns and verifies it. Isomux updates do not assume the installer configured it.  | Only what the operator configured. An update changes only a byte-exact installer Caddyfile.                                                 | Firewall setup, proxy maintenance, retention, and traffic that bypasses the proxy.         |

When an active Caddy config forwards to `127.0.0.1:4000`, an install or update records that fact in the office config. After the update restarts Isomux, the direct `:4000` address stops answering; the Caddy address keeps working. This also applies to a hand-provisioned VPS. Set `networkBind` to `"all"` in `~/.isomux/office-config.json` before the update to keep the direct port.

## Proxy and no real domain

| Shape                                   | Reach the office             | App addresses                              | Firewall                                                             | Request log                                                   | Isomux does not cover                                                |
| --------------------------------------- | ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Home box with Tailscale Serve or Funnel | Its `*.ts.net` HTTPS address | No separate hostnames; use each app's port | The operator owns it. The installer does not configure or verify it. | No Isomux Caddy access log. Tailscale controls any proxy log. | Tailscale policy, firewall policy, proxy logs, and direct app ports. |

The Isomux installer and updater do not manage this shape, so updates do not change its network bind.

## No proxy and no real domain

| Shape                 | Reach the office        | App addresses                              | Firewall                                                             | Request log               | Isomux does not cover                                         |
| --------------------- | ----------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Home box on a tailnet | `http://name:4000`      | No separate hostnames; use each app's port | The operator owns it. The installer does not configure or verify it. | No front-door access log. | Tailnet access, firewall policy, request logs, and app ports. |
| One local machine     | `http://localhost:4000` | No separate hostnames; use each app's port | The machine owner controls it.                                       | No front-door access log. | Other local processes and any exposure the operator adds.     |

These shapes do not run the system installer or its service-account updater. They get neither its firewall verification nor its Caddy access log, and updates do not change their network bind.
