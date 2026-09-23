#!/usr/bin/env bash
# Run only with release assets in root-owned storage.
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || exit 1
assets=$1
install -d -m 755 /usr/local/lib/isomux /etc/isomux
install -d -m 700 /var/lib/isomux-update
install -m 755 "$assets/update.sh" /usr/local/sbin/isomux-update.new
mv -f /usr/local/sbin/isomux-update.new /usr/local/sbin/isomux-update
install -m 644 "$assets/update-helper.py" /usr/local/lib/isomux/container-update-helper.py
install -m 644 "$assets/isomux-container-update.socket" /etc/systemd/system/isomux-container-update.socket
install -m 644 "$assets/isomux-container-update@.service" /etc/systemd/system/isomux-container-update@.service
cat > /etc/systemd/system/isomux-update@.service <<'UNIT'
[Unit]
Description=Isomux update to release %i

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/isomux-update %i
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root
UNIT
chmod 644 /etc/systemd/system/isomux-update@.service
systemctl daemon-reload
systemctl enable --now isomux-container-update.socket
