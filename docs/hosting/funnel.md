# Run a public office with Tailscale Funnel

Use an existing Linux computer or Linux server with systemd, a normal user
account with sudo access, and an internet connection. You also need an AI
provider account. Keep the computer powered on. Funnel gives the office a public
HTTPS address without a domain or router forwarding. Visitors do not need
Tailscale, but they still need an Isomux sign-in link.

<!-- include: install -->

<!-- include: claim -->

<!-- include: service -->

<!-- include: tailscale-install -->

## Make the office public

Funnel depends on Tailscale's service and its bandwidth limits. Sign in as a
Tailscale owner, admin, or network admin for the authorization step below.

On the server, inspect the current mappings:

```sh
tailscale serve status
tailscale funnel status
```

A port is all-private Serve or all-public Funnel. If port 443 has mappings
besides Isomux at `localhost:4000`, stop. Decide whether to remove each mapping
or move it to another port before you continue. Do not expose another service
by accident.

Run this command yourself in the server terminal. Claude agents refuse
recognized tunnel commands:

```sh
tailscale funnel --bg http://localhost:4000
```

If the command prints an authorization link, open it in your browser and approve
enabling Funnel. Tailscale adds the required `funnel` attribute to the tailnet
policy. The default permits tailnet members to use Funnel. To enable it through
the admin console instead, open **Access controls**, expand **Funnel**, and
select **Add Funnel to policy**. Preserve any existing access policy.

Copy the public HTTPS address from the output. You can read it again with
`tailscale funnel status`. Tailscale relays the connection; TLS terminates on
your computer. The `*.ts.net` name is public and appears in certificate records.
See the [Funnel reference](https://tailscale.com/kb/1223/funnel) for custom policy
and service limits.

<!-- include: remote-signin -->

Test the address on a phone with Wi-Fi and Tailscale turned off. A request from
the server itself does not prove that public access works.

<!-- include: provider -->

<!-- include: invites -->

## App addresses

Funnel exposes the office port only. Tailscale names do not provide wildcard app
hostnames, so this setup does not give each app a public address. App port links
remain usable from devices with direct or private Tailscale access to the
server. Choose the domain setup if each app needs its own public HTTPS address.

<!-- include: manual-operations -->

<!-- include: backup -->
