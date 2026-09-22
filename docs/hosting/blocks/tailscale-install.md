## Install Tailscale on your devices

Create a [Tailscale account](https://login.tailscale.com/start). On the Linux server, run:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the sign-in link printed in the terminal and add the server to your account.
Install [Tailscale](https://tailscale.com/download) on your laptop and phone, and
sign in to the same account on each device. Keep Tailscale connected.

Open the [Tailscale DNS settings](https://login.tailscale.com/admin/dns). Enable
**MagicDNS** and **HTTPS Certificates**. HTTPS certificates put the server's
`*.ts.net` name in public certificate records, even when access stays private.

On the server, allow your Linux user to manage Tailscale:

```sh
sudo tailscale set --operator="$USER"
```
