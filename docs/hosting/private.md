# Run a private office with Tailscale

Use a Linux computer with systemd, a normal user account with sudo, and an AI
provider account. Keep it powered on. This guide gives the office a
private HTTPS address; every person who connects must have Tailscale access.

<!-- include: install -->

<!-- include: claim -->

<!-- include: service -->

<!-- include: tailscale-install -->

## Give the office a private HTTPS address

On the server, inspect any existing Tailscale mappings:

```sh
tailscale serve status
tailscale funnel status
```

If port 443 already serves another application, stop and resolve that mapping
before replacing it. A port cannot be both private Serve and public Funnel.
Run this yourself in the server terminal. Agents refuse tunnel commands.

```sh
tailscale serve --bg http://localhost:4000
```

Copy the HTTPS address that Tailscale prints, such as
`https://office.your-tailnet.ts.net`. Serve keeps this address private to devices
allowed by your Tailscale policy. You do not need a domain or router forwarding.

<!-- include: remote-signin -->

Test the office address from your phone with Tailscale connected. Invite other
people to your tailnet before they open an office invite. Tailscale's access
policy must let their devices reach this server.

<!-- include: provider -->

<!-- include: invites -->

## App addresses

Tailscale names do not support wildcard app hostnames. Apps use separate ports
on the server; open the port link that the agent supplies while connected to
Tailscale. Your firewall and tailnet policy must allow that app port. The office
HTTPS address does not proxy those ports.

<!-- include: manual-operations -->

<!-- include: backup -->
