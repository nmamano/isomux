## Keep the office running

These steps use Linux with systemd. Keep the computer powered on and disable
sleep in its power settings.

After you have created the owner, press **Ctrl+C** in the terminal running
`bun run dev`. In that terminal, from the Isomux directory, run:

```sh
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/isomux.service" <<UNIT
[Unit]
Description=Isomux office
After=network.target
StartLimitIntervalSec=0

[Service]
WorkingDirectory="$PWD"
Environment="PATH=$HOME/.bun/bin:$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin"
ExecStart="$HOME/.bun/bin/bun" run dev
Restart=on-failure
RestartSec=5s
OOMPolicy=continue

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now isomux
sudo loginctl enable-linger "$USER"
systemctl --user status isomux --no-pager
```

The status should show `active (running)` after the UI builds. Lingering keeps
the service running after logout and starts it at boot. If startup fails, read
its log with `journalctl --user -u isomux -n 50 --no-pager`.
