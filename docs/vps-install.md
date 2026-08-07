---
navTitle: VPS install
---

# VPS install (one command)

Set up isomux on a fresh Ubuntu 24.04 server with one unattended command. It installs everything, hardens the box, serves the office over HTTPS at your domain, and hands you a sign-in link.

You need:

- A fresh Ubuntu 24.04 server with root access (a cheap cloud VPS works).
- A domain with an A record pointing at the server's IP.

## Run it

As root on the server:

```bash
DOMAIN=office.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh)"
```

Or as cloud-init user data when creating the server:

```bash
#!/bin/bash
export DOMAIN=office.example.com
curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh | bash
```

After a few minutes it prints a single-use owner invite link, also saved on the server at `/var/lib/isomux-install/invite-url`. Open it on any device within 24 hours to sign in as the owner at `https://office.example.com`.

When the output isn't going to a terminal - cloud-init, a piped log, an agent running the command for you - it names that file instead of printing the link, so a live credential doesn't end up sitting in a log.

## What it does

- Installs bun, Node.js, git, Caddy, and Chrome (headless, for the agents' page-preview cards, and as the browser Playwright drives when an agent wants to look at a page it just changed); fetches isomux and builds it.
- Runs isomux as a systemd service under a dedicated `isomux` user, restarting on failure and on boot.
- Sets up the `isomux` account so apps agents build keep running without anyone logged in and start again after a reboot.
- Serves your domain through Caddy with an automatic Let's Encrypt certificate. Caddy's admin API is turned off, since anything on the box could otherwise reconfigure the proxy without a credential - so apply Caddyfile edits with `systemctl restart caddy`, not `reload`.
- Hardens the box: firewall allowing only web traffic and, unless disabled, SSH; key-only SSH auth; unattended security updates (a standard Ubuntu feature - it patches system packages, never isomux itself).
- Checks that the `isomux` account cannot log in as root, and stops the install if it can. See [root access](#root-access).
- Sets up out-of-memory protection so a busy office can't lock the box up. See [running out of memory](#running-out-of-memory).
- Makes the sandbox that Codex agents run their tools in actually work. On Ubuntu 24.04 that takes one small AppArmor policy file which the sandbox's own package doesn't ship. The installer tries the sandbox first and only acts if it is broken, so a box where it already works is left alone. If it still can't get it working, the install carries on and says so in the output.
- Claims the office owner over loopback before the box is exposed, then mints your invite link.

## Root access

Agents run as the `isomux` account, so anything that account can do, an agent can do. If it can log in as root, it can turn off every guardrail isomux puts in front of it.

The installer does not assume it can't - it tries, as that account, at every address SSH answers on, and it also asks what the account may do with `sudo`. Twice: as soon as the account exists, and again on the finished box, before you get an invite link. If it gets in, the install stops. If it can't tell, the install stops too. There is no way to skip it; the box has to be fixed instead.

What it promises when it passes: the isomux service account cannot log in as root over SSH on this box, and cannot sudo. There is one deliberate exception - that account can ask root to apply an isomux release, which is what the update button in the office header runs. It can start nothing else.

The usual cause of a failure is a key file kept on the server that root accepts. The key from your own computer is fine - that file stays on your computer. A key made _on_ the box, for GitHub or a deploy script, is not: anything running there can read it and log in as root with it. When the check fails it names the file and tells you which line to remove.

After fixing it:

```bash
sudo isomux-harden-ssh
```

That command applies the SSH hardening and re-runs the check. It is a snapshot of the moment it runs - giving root a new key later reopens the hole - so run it again whenever root's key list changes.

## Running out of memory

A busy office can use up the box's memory. Left to the kernel that ends badly: the machine swaps until nothing responds, SSH included, and only a reboot from the provider's console brings it back.

The installer sets up [earlyoom](https://github.com/rfjakob/earlyoom), which kills one process while there is still memory left to act with. The order is deliberate: agent processes go first, then the office server and Caddy, and last of all what keeps the box reachable and usable at all - SSH, Tailscale, DNS, networking. The office backs that up from its own side, marking every process it starts as a better candidate than itself, so a runaway build is much more likely to be the one picked than the office server is, and it stays up when one of its agents is the one killed. A killed agent is a papercut - message it again and it comes back. Anything it does kill from that last group is set to keep retrying rather than give up, so a burst of kills can't leave DNS or the office switched off for good. It also gives the box a swap file of up to 8 GB if it has none, smaller only if the disk cannot hold that, and tells the kernel to prefer dropping caches over swapping. The size is deliberate too: swap that runs out mid-spike is worse for the office than swap that is simply large.

To apply the same settings to a box installed before this existed, or to see what they'd change:

```bash
sudo isomux-oom-protect --dry-run
sudo isomux-oom-protect
```

Nothing but earlyoom is restarted, so it's safe to run on a live office. Swap the box already has is left exactly as it is, even when it is smaller than a fresh install would get: replacing live swap means taking it offline first, which is not something to do to a running box on your behalf. The run prints the commands if you want to do it yourself.

## Parameters

Environment variables, set before running:

| Variable               | Default        | Meaning                                                                                                                                                                                      |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`               | (required)     | Public domain for the office.                                                                                                                                                                |
| `OWNER_NAME`           | `Owner`        | Owner display name; changeable later in User Settings.                                                                                                                                       |
| `ISOMUX_REF`           | latest release | Git branch, tag, or commit to install; `main` if no release exists yet.                                                                                                                      |
| `ISOMUX_REPO`          | GitHub         | Git repo to install from (for forks).                                                                                                                                                        |
| `SSH_PORT`             | `22`           | SSH port to allow through the firewall; `none` keeps SSH closed.                                                                                                                             |
| `INSTALL_CALLBACK_URL` | (unset)        | HTTPS URL that receives a POST: `{inviteUrl, status}`, plus `step` on failure.                                                                                                               |
| `DRY_RUN`              | (unset)        | Set to `1` to print what would run instead of running it.                                                                                                                                    |
| `ISOMUX_DEPS_ONLY`     | (unset)        | Leave unset for a normal full install. Set to `1` to only install the system packages and exit (`DOMAIN` not needed); `isomux-update` uses this to deliver dependencies a new release needs. |

## Re-running

Safe after a failure: completed steps are skipped or redone harmlessly, and a fresh invite link is minted each run. A re-run recovers its owner session automatically; if the office has several owners, set `OWNER_NAME` to one of them. Re-running restarts the isomux service, which interrupts running agents.

## Updating

When a new release is out, the office header shows a "new release" notice. The owner can apply it from there; the confirm step shows how many busy agents the restart would interrupt. Or over SSH as root, with a tag from the [releases page](https://github.com/nmamano/isomux/releases):

```bash
isomux-update v2026.7.19
```

Either way, it installs any system dependencies the new release needs, rebuilds at the new version, snapshots the office state, and restarts the service - interrupting running agents. If the new version fails to come up, it rolls code and state back to what you had. Downgrading to an older release needs `--allow-downgrade`.

## App hostnames

An app an agent registers can answer at its own address - `hello.office.example.com` - from any device, behind the same sign-in as the office. A fresh install sets up the proxy side; you add one DNS record:

1. A wildcard A record, `*.office.example.com`, pointing at this server.
2. On an office installed before this release, re-run the installer once to add the site block (or add it to `/etc/caddy/Caddyfile` yourself). `isomux-update` never rewrites that file.

Certificates are obtained per app the first time it is opened. Three things follow:

- The office answers 404 for every name under its domain that is not a live app, so a subdomain you pointed at this server for something else stops working after updating.
- Isomux admits at most ten new app hostnames per hour, so an office with more than ten apps enables them as the hour rolls.
- Deleting an app stops new certificates immediately, but TLS may keep terminating from Caddy's warm cache until its next cold load.

## Opening an agent's dev server

An app an agent is running on the box - say on port 5173 - isn't exposed to the internet. If SSH is open (the default), forward the port from your own machine:

```bash
ssh -L 5173:localhost:5173 root@office.example.com
```

Then open `http://localhost:5173`.

## Notes

- The invite link is a credential until it's used or expires. It appears in the install output only when that output goes to a terminal; otherwise the output names `/var/lib/isomux-install/invite-url` and you read the link from there as root. That keeps it out of logs that capture stdout, like cloud-init's `/var/log/cloud-init-output.log`.
- If you've hand-edited a package's config file - `/etc/caddy/Caddyfile` is the likely one - the installer and `isomux-update` keep your version when the package ships a new one, and name the files they kept. The package's version is parked beside each as `<file>.dpkg-dist`; reconciling the two is up to you.
- The service is system-level: restart with `systemctl restart isomux` as root (the [self-hosted page](self-hosted.md) describes a user-level service instead, so its `systemctl --user` commands don't apply here).
- SSH hardening is skipped, loudly, if the box has no SSH key on it yet: turning off password logins there would lock you out. Add your key, then run `sudo isomux-harden-ssh`.
- Chrome backs only the page-preview cards. If it can't be installed - no amd64 build for the box, a failed download, or a test capture that comes back empty - the installer warns and carries on without it.
- Authenticated users effectively have shell access to the server (agents run commands as the `isomux` user). Only invite people you trust; see [access and invites](access-and-invites.md).
