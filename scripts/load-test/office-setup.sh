#!/usr/bin/env bash
# Runs as root on the office VM, from the directory holding mock.ts and
# sampler.py. Installs the office from <ref> as a customer does, points the
# Claude engines at the mock Messages API, and starts the mock and the sampler.
# usage: office-setup.sh <domain> <ref>
set -euo pipefail
DOMAIN=${1:?usage: office-setup.sh <domain> <ref>}
REF=${2:?usage: office-setup.sh <domain> <ref>}
mkdir -p /root/lt/eng
cp mock.ts sampler.py /root/lt/
chronyc tracking | sed -n '1,6p' || true
curl -fsSL "https://raw.githubusercontent.com/nmamano/isomux/$REF/deploy/install.sh" -o /root/install.sh
DOMAIN=$DOMAIN ISOMUX_REF=$REF OWNER_NAME="Load Owner" bash /root/install.sh > /root/install.log 2>&1 ||
  { tail -40 /root/install.log; exit 1; }
tail -5 /root/install.log
# The engines inherit the service environment. The key is a dummy: the mock
# accepts any.
mkdir -p /etc/systemd/system/isomux.service.d
cat > /etc/systemd/system/isomux.service.d/loadtest.conf <<CONF
[Service]
Environment=ANTHROPIC_BASE_URL=http://127.0.0.1:18080
Environment=ANTHROPIC_API_KEY=sk-ant-mock
Environment=DISABLE_AUTOUPDATER=1
Environment=DISABLE_TELEMETRY=1
Environment=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CONF
systemctl daemon-reload
systemctl restart isomux
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4000/readyz >/dev/null && break; sleep 1; done
systemd-run -q --unit=lt-mock -p MemoryMax=1G --setenv=LT_DIR=/root/lt/eng --setenv=MOCK_PORT=18080 \
  /usr/local/bin/bun run /root/lt/mock.ts
systemd-run -q --unit=lt-sampler python3 -I /root/lt/sampler.py \
  "/sys/fs/cgroup$(systemctl show -p ControlGroup --value isomux)" /root/lt/sample.jsonl \
  "$(systemctl show -p MainPID --value isomux)"
systemctl is-active lt-mock lt-sampler
