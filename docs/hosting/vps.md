# Set up Isomux on a fresh VPS

Use this guide for a fresh Ubuntu 24.04 server with root access and a public IP
address. The VPS provider charges for the server. You need a domain you control,
access to its DNS settings, and an AI provider account.

## Create the server and DNS records

1. In your VPS provider's console, create a fresh Ubuntu 24.04 server. Add your
   laptop's SSH public key. Keep the private key on your laptop.
2. Note the server's public IPv4 address. If the provider has a firewall, allow
   inbound TCP ports 80 and 443, and SSH port 22 from your administration device.
3. In your domain provider's DNS settings, add an A record for `office` pointing
   to the server IP. Add an A record for `*.office` pointing to the same IP.
   This guide uses `office.example.com`; replace it with your chosen address.
4. In your laptop terminal, connect with `ssh root@SERVER_IP`, replacing
   `SERVER_IP` with the address. If the provider supplies a sudo account instead,
   connect as that user and run `sudo -i` for the installer.

## Run the installer

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

Open the owner invite link to enter the office. If the installer reports that it
saved the link instead of printing it, read the file as root on the server:

```sh
cat /var/lib/isomux-install/invite-url
```

Do not share this owner link. If the office does not open, check DNS, ports 80
and 443, and `systemctl status isomux --no-pager` on the server.

<!-- include: provider -->

<!-- include: invites -->

## Apps and server access

The wildcard DNS record gives registered apps addresses such as
`notes.office.example.com`. Caddy obtains their certificates when they are first
opened. Keep your private SSH key on your laptop; do not store a key accepted
by root inside the office account.

## Re-run after an installation failure

Safe after a failure: completed steps are skipped or redone harmlessly, and a fresh invite link is minted each run. A re-run recovers its owner session automatically; when the office has several owners, the `OWNER_NAME` environment variable names which one to recover. Re-running restarts the isomux service, which interrupts running agents.

<!-- include: host-update -->

## Opening an agent's dev server

An app an agent is running on the box - say on port 5173 - isn't exposed to the internet. If SSH is open (the default), forward the port from your own machine:

```bash
ssh -L 5173:localhost:5173 root@office.example.com
```

Then open `http://localhost:5173`.

## Installer notes

- The invite link is a credential until it's used or expires. It appears in the install output only when that output goes to a terminal; otherwise the output names `/var/lib/isomux-install/invite-url` and you read the link from there as root. That keeps it out of logs that capture stdout, like cloud-init's `/var/log/cloud-init-output.log`.
- If you've hand-edited a package's config file - `/etc/caddy/Caddyfile` is the likely one - the installer and `isomux-update` keep your version when the package ships a new one, and name the files they kept. The package's version is parked beside each as `<file>.dpkg-dist`; reconciling the two is up to you.
- The service is system-level: restart with `systemctl restart isomux` as root. An office on [your own hardware](hosting-private.md) runs a user-level service instead, where the commands are `systemctl --user`.
- SSH hardening is skipped, loudly, if the box has no SSH key on it yet: turning off password logins there would lock you out. Add your key, then run `sudo isomux-harden-ssh`.
- Chrome on the server backs page-preview cards and app screenshot previews. If it can't be installed - no amd64 build for the box, a failed download, or a test capture that comes back empty - the installer warns and carries on without it.
- Authenticated members effectively have shell access to the server (agents run commands as the `isomux` user). Only invite people you trust; see [access and invites](access-and-invites.md).

## Logs

As root on the server, run `journalctl -u isomux -n 50 --no-pager` for office
logs. The installer configures the service, firewall, Caddy, and memory
protection. See the [hosting reference](hosting-reference.md) for its parameters,
root-access checks, and optional changes.

<!-- include: backup -->
