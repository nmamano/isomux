# Run an office at your own domain

Use an existing Ubuntu or Debian Linux computer with systemd, a normal user
account with sudo access, an AI provider account, and a domain you control.
Keep the computer powered on. This setup uses Caddy to serve the office and app
addresses over HTTPS.

You need a public IP address that accepts inbound TCP ports 80 and 443. If your
internet provider uses carrier-grade NAT, use the Funnel guide or a VPS instead.
The public address exposes your home or server IP.

<!-- include: install -->

<!-- include: claim -->

<!-- include: service -->

## Point the domain at your computer

1. Give the computer a stable address on your home network, using your router's
   DHCP reservation settings.
2. Forward TCP ports 80 and 443 on the router to that computer. On a rented
   server, allow those ports in the provider firewall instead.
3. In the domain's DNS settings, point an A record for `office` at your public
   IPv4 address. Add `*.office` with the same address for apps.
4. Allow ports 80 and 443 in the computer's firewall. Keep office port 4000 and
   app ports closed to the public internet. If the public IP changes, update
   both DNS records, or configure your DNS provider's dynamic DNS client.

Replace `office.example.com` in the next steps with your chosen domain.
Do not add an AAAA record unless you have also configured IPv6 routing and the
IPv6 firewall.

## Install and configure Caddy

On the server, install Caddy using its official Debian/Ubuntu package repository:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

[Official Caddy installation instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

If Caddy already serves another site, preserve its configuration and combine
these entries with it. For a new Caddy installation, open
`sudo nano /etc/caddy/Caddyfile` and replace the example configuration with:

```caddyfile
{
    admin off
    on_demand_tls {
        ask http://127.0.0.1:4000/__isomux/tls-ask
    }
}

office.example.com {
    respond /__isomux/tls-ask 404
    reverse_proxy 127.0.0.1:4000
}

*.office.example.com {
    tls {
        on_demand
    }
    reverse_proxy 127.0.0.1:4000
}
```

Save the file. In nano, press **Ctrl+O**, **Enter**, and then **Ctrl+X**.
Validate it and restart Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy obtains certificates automatically. Isomux admits certificates only for
registered app names. The Caddy admin API is disabled; apply later configuration
changes with a restart.

Use `https://office.example.com` as the HTTPS office address.

<!-- include: remote-signin -->

Check the address from a
phone on cellular data. If it fails, check DNS, router forwarding, both
firewalls, and `sudo journalctl -u caddy -n 50 --no-pager`.

<!-- include: provider -->

<!-- include: invites -->

## Apps and maintenance

Registered apps get separate HTTPS addresses, such as
`notes.office.example.com`. Caddy obtains each app certificate when it is first
opened. The wildcard DNS record must continue to point at this computer.

You manage the firewall, Caddy updates, DNS, and any request-log retention.
This manual setup does not install the VPS updater or its hardening checks.

<!-- include: manual-operations -->

<!-- include: backup -->
