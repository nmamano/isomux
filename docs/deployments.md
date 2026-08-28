---
title: Deployment shapes
description: What Isomux protects and records in each supported deployment shape.
---

# Deployment shapes

Two facts set the boundary: whether a proxy sits in front of Isomux, and whether the office has a real domain. Only a real domain gives apps their own web addresses.

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
