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

## What it does

- Installs bun, Node.js, git, and Caddy; fetches isomux and builds it.
- Runs isomux as a systemd service under a dedicated `isomux` user, restarting on failure and on boot.
- Serves your domain through Caddy with an automatic Let's Encrypt certificate.
- Hardens the box: firewall allowing only web traffic and, unless disabled, SSH; key-only SSH auth; unattended security updates (a standard Ubuntu feature — it patches system packages, never isomux itself).
- Claims the office owner over loopback before the box is exposed, then mints your invite link.

## Parameters

Environment variables, set before running:

| Variable               | Default        | Meaning                                                                        |
| ---------------------- | -------------- | ------------------------------------------------------------------------------ |
| `DOMAIN`               | (required)     | Public domain for the office.                                                  |
| `OWNER_NAME`           | `Owner`        | Owner display name; changeable later in User Settings.                         |
| `ISOMUX_REF`           | latest release | Git branch, tag, or commit to install; `main` if no release exists yet.        |
| `ISOMUX_REPO`          | GitHub         | Git repo to install from (for forks).                                          |
| `SSH_PORT`             | `22`           | SSH port to allow through the firewall; `none` keeps SSH closed.               |
| `INSTALL_CALLBACK_URL` | (unset)        | HTTPS URL that receives a POST: `{inviteUrl, status}`, plus `step` on failure. |
| `DRY_RUN`              | (unset)        | Set to `1` to print what would run instead of running it.                      |

## Re-running

Safe after a failure: completed steps are skipped or redone harmlessly, and a fresh invite link is minted each run. A re-run recovers its owner session automatically; if the office has several owners, set `OWNER_NAME` to one of them. Re-running restarts the isomux service, which interrupts running agents.

## Updating

When a new release is out, the office header shows a "new release" notice. The owner can apply it from there; the confirm step shows how many busy agents the restart would interrupt. Or over SSH as root, with a tag from the [releases page](https://github.com/nmamano/isomux/releases):

```bash
isomux-update v2026.7.19
```

Either way, it rebuilds at the new version, snapshots the office state, and restarts the service - interrupting running agents. If the new version fails to come up, it rolls code and state back to what you had. Downgrading to an older release needs `--allow-downgrade`.

## Notes

- The invite link is a credential until it's used or expires. It appears in the install output, so it also lands in logs that capture it (cloud-init writes stdout to `/var/log/cloud-init-output.log`).
- The service is system-level: restart with `systemctl restart isomux` as root (the [self-hosted page](self-hosted.md) describes a user-level service instead, so its `systemctl --user` commands don't apply here).
- SSH hardening is skipped, with a warning, if the box has no `authorized_keys` yet; add a key and re-run to apply it.
- Authenticated users effectively have shell access to the server (agents run commands as the `isomux` user). Only invite people you trust; see [access and invites](access-and-invites.md).
