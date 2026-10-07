# Hosting reference

Choose a complete setup guide on the [hosting page](self-hosted.md). This page covers optional configuration and deployment boundaries.

## What the installer does

Everything below is one script, [`deploy/install.sh`](https://github.com/nmamano/isomux/blob/main/deploy/install.sh).

- Installs bun, Node.js, build-essential, python3, the Claude Code CLI, GitHub CLI, git, Caddy, and Chrome (headless, for page-preview cards); fetches isomux and builds it.
- Runs isomux as a systemd service under a dedicated `isomux` user, restarting on failure and on boot.
- Sets up the `isomux` account so apps agents build keep running without anyone logged in and start again after a reboot.
- Serves your domain through Caddy with an automatic Let's Encrypt certificate. Caddy keeps a size-bounded request log for 14 days and redacts invite and app sign-in credentials from URLs. Its admin API is turned off, since anything on the box could otherwise reconfigure the proxy without a credential - so apply Caddyfile edits with `systemctl restart caddy`, not `reload`.
- Hardens the box: firewall allowing only web traffic and, unless disabled, SSH; key-only SSH auth; unattended security updates (a standard Ubuntu feature - it patches system packages, never isomux itself).
- Checks that the `isomux` account cannot log in as root, and stops the install if the account can. See [root access](#root-access).
- Sets up out-of-memory protection and caps the office's memory below the box's RAM, leaving room for SSH. Boxes under 4 GB are not capped. See [running out of memory](#running-out-of-memory).
- Makes the sandbox that Codex agents run their tools in actually work. On Ubuntu 24.04 that takes one small AppArmor policy file which the sandbox's own package doesn't ship. The installer tries the sandbox first and only acts if it is broken, so a box where it already works is left alone. If the installer still can't get the sandbox working, the install carries on and says so in the output.
- Claims the office owner over loopback before the box is exposed, then mints your invite link.

## Root access

Agents run as the `isomux` account, so anything that account can do, an agent can do. If that account can log in as root, it can turn off every guardrail isomux puts in front of it.

The installer checks this itself. It tries to log in as that account at every address SSH answers on, and asks what the account may do with `sudo`. It checks when the account is created and again before it prints the invite link. If it gets in, or cannot tell, the install stops. The check cannot be skipped; fix the box instead.

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

## Native build recovery

On Linux, Bun compiles `node-pty` through a shim that fetches the latest `node-gyp`, whose Node 24 requirement is 24.15.0 or later ([node-gyp requirements](https://github.com/nodejs/node-gyp/blob/main/package.json)).

Check `bun --version`, `node --version`, and `command -v bun node python3 make g++` in the install shell. Install missing prerequisites, then run `bun install --force` from the Isomux directory to rebuild.

If `node-gyp: command not found` persists, [report the error](https://github.com/nmamano/isomux/issues) with those command outputs, the Linux distribution, and the install log. Bun supplies `node-gyp`; a missing compiler produces a different error.

## Running out of memory

A busy office can use up the box's memory. Left to the kernel that ends badly: the machine swaps until nothing responds, SSH included, and on a cloud box only a reboot from the provider's console brings it back.

Isomux handles its half automatically: the office marks every process it starts as a better out-of-memory kill candidate than the office server itself, so a spike usually costs one runaway agent or build instead of the whole office. Message a killed agent to bring it back. Linux only, no setup, no privileges.

The box-wide half is [earlyoom](https://github.com/rfjakob/earlyoom), which kills one process while there is still memory left to act with. The order is deliberate: agent processes go first, then the office server and Caddy, and last of all what keeps the box reachable and usable at all - SSH, Tailscale, DNS, networking. Anything it kills from that last group is set to keep retrying rather than give up, so a burst of kills can't leave DNS or the office switched off for good. The same setup also gives the box a swap file of up to 8 GB if the box has none, smaller only if the disk cannot hold that, and tells the kernel to prefer dropping caches over swapping. A small root timer re-applies the office's own kill-order stamp within a minute of any office restart - a user-level service cannot hold that setting itself.

The [VPS install](hosting-vps.md) sets all of this up and leaves the tool on the box:

```bash
sudo isomux-oom-protect --dry-run   # print what would change
sudo isomux-oom-protect
```

On your own hardware, the same script runs from your checkout as `sudo bash deploy/oom-protect.sh`, and installs itself at `/usr/local/sbin/isomux-oom-protect`. Either way the run is safe on a live office: nothing but earlyoom is restarted, and swap the box already has is left exactly as it is, even when it is smaller than a fresh install would get - replacing live swap means taking it offline first, which is not something to do to a running box on your behalf. The run prints the commands if you want to do it yourself.

macOS and Windows get neither half - both mechanisms are Linux-specific.

## Network bind

`~/.isomux/office-config.json` can set `networkBind` to `"loopback"`, `"all"`, or `"auto"`. `"auto"` binds loopback before the office has an owner or while external access is off, and all interfaces otherwise. Remove the field to use the same runtime default while allowing the installer or updater to select `"loopback"` when it verifies a local proxy. An explicit `"auto"` opts out of that automatic installer change. The loopback listener uses IPv4 `127.0.0.1`; callers that use `localhost` fall back to it on dual-stack hosts.

## What each deployment covers

Two facts set the boundary: whether a proxy sits in front of Isomux, and whether the office has a real domain. Only a real domain gives apps their own web addresses.

Every shape supports [Claude on Amazon Bedrock](llm-providers.md#claude-on-amazon-bedrock).
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

The same step sets `trustedProxy` to `"same-host"`, so Isomux rate-limits each client by the address Caddy sends in `X-Forwarded-For`. Behind your own proxy on the same machine, set `"trustedProxy": "same-host"` in `~/.isomux/office-config.json` and restart Isomux. The proxy must send `X-Forwarded-For`. The container images set `"load-balancer"` themselves. On Render it is unchecked whether more than one proxy is in front; if there is, the limits apply per Render proxy, not per client.

Agent, cron-run and app tokens work only from the machine itself. Isomux refuses them on a request that came through a proxy, which it recognizes by an `X-Forwarded-For`, `Forwarded` or `X-Real-IP` header. A proxy or tunnel that sends none of these looks like the machine itself.

## Containers

The container setups also have a proxy and a real domain.

| Shape | Reach the office | App addresses | Firewall | Request log | Isomux does not cover |
| --- | --- | --- | --- | --- | --- |
| AWS EC2 container | Its HTTPS domain | One hostname per app | The installer configures it. Container updates do not verify it. | Caddy keeps the same 14-day log as a VPS install. | AWS controls such as the security group, and traffic that bypasses Caddy. |
| Render | Its HTTPS domain | One hostname per app | Isomux does not configure one. | No Isomux access log. Render's service logs show office output. | Render's platform controls, its service logs, and copies of the disk. |
| Kubernetes (EKS) | Its HTTPS domain, through the load balancer | One hostname per app | The cluster operator owns it. The manifests add an egress policy that blocks the instance metadata address. | No Isomux access log. The manifests do not turn on load balancer access logs. | The cluster, node settings, the load balancer, and the log pipeline. |

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
