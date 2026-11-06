#!/usr/bin/env bash
# Runs as root on the generator VM. Installs bun, clones the isomux checkout
# at <ref> for the ubuntu user (the generator scripts run from it), and makes
# <domain> resolve to the office's private address, so the security group
# rule applies.
# usage: gen-setup.sh <domain> <office private ip> <bun version> <ref>
set -euo pipefail
USAGE="usage: gen-setup.sh <domain> <office private ip> <bun version> <ref>"
DOMAIN=${1:?$USAGE} PRIV=${2:?$USAGE} BUNV=${3:?$USAGE} REF=${4:?$USAGE}
apt-get -qq update >/dev/null && apt-get -qq install -y unzip git >/dev/null
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$BUNV" >/dev/null
bun --version
sudo -u ubuntu git clone -q --depth 1 --branch "$REF" https://github.com/nmamano/isomux /home/ubuntu/isomux
sudo -u ubuntu mkdir -p /home/ubuntu/lt/B
grep -q " $DOMAIN\$" /etc/hosts || echo "$PRIV $DOMAIN" >> /etc/hosts
cat > /etc/security/limits.d/lt.conf <<LIMITS
* soft nofile 65536
* hard nofile 65536
LIMITS
chronyc tracking | sed -n '1,6p' || true
