#!/usr/bin/env bash
# Two-user test rig for split mode (internal-docs/os-user-split-design.md,
# section 7). It builds the container image from a committed revision, adds a
# rig layer with the server user, and starts throwaway containers in which the
# office runs as isomux-server and the agent runner as node. It never touches
# the live office. server/test-support/split-rig.integration.test.ts drives it.
#
#   scripts/split-rig.sh build [REVISION]       build isomux-split-rig:latest
#   scripts/split-rig.sh start NAME [BREAK] [RUNNER]
#                                               start one container
#   scripts/split-rig.sh stop NAME              remove it and its volume
#
# BREAK breaks one thing before the office starts: state-readable,
# code-owner, code-deep-acl, code-symlink, code-dir-link, code-hop-link,
# code-relative-link, share-setgid, data-owner.
# RUNNER is real (default) or stub, a runner that answers EACCES to every
# diagnostic try.
#
# Fence a build: systemd-run --user --scope -p MemoryMax=6G scripts/split-rig.sh build
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=isomux-split-rig:latest
SERVER_ID=10001

build() {
  local revision commit context
  revision=${1:-HEAD}
  commit=$(git rev-parse --verify "$revision^{commit}")
  bash deploy/container/build.sh "$commit" "isomux-split-rig-base:$commit"
  # The server user's fixed id must be free for both user and group in the
  # built image; system packages take ids downward from 999.
  if docker run --rm --entrypoint sh "isomux-split-rig-base:$commit" -c \
    "getent passwd $SERVER_ID || getent group $SERVER_ID"; then
    echo "id $SERVER_ID is taken in the image" >&2
    exit 1
  fi
  context=$(mktemp -d)
  trap 'rm -rf "$context"' RETURN
  cat > "$context/Dockerfile" <<EOF
FROM isomux-split-rig-base:$commit
RUN apt-get update && apt-get install -y --no-install-recommends acl && rm -rf /var/lib/apt/lists/*
# bun install leaves dependency files at mode 0666; no user but root may
# write the code tree (slice 6 moves this into the image itself).
RUN chmod -R go-w /opt/isomux
RUN groupadd -g $SERVER_ID isomux-server \
 && useradd -u $SERVER_ID -g $SERVER_ID -G node -d /var/data/server -M -s /usr/sbin/nologin isomux-server
COPY rig-entrypoint.sh stub-runner.ts /opt/split-rig/
LABEL isomux.split-rig.commit=$commit
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bash", "/opt/split-rig/rig-entrypoint.sh"]
EOF
  cat > "$context/rig-entrypoint.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SERVER_HOME=/var/data/server
STATE=$SERVER_HOME/.isomux
SHARE=$SERVER_HOME/share
RUN_DIR=/run/isomux-agent-runner
SOCKET=$RUN_DIR/runner.sock
CLEAN_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The layout of design section 3.1.1 for the container.
chown root:root /var/data
chmod 755 /var/data
install -d -m 700 -o node -g node /var/data/home /var/data/workspaces
install -d -m 711 -o isomux-server -g isomux-server "$SERVER_HOME"
install -d -m 700 -o isomux-server -g isomux-server "$STATE"
install -d -m 2750 -o isomux-server -g node "$SHARE" "$SHARE/files" "$SHARE/bin"
install -d -m 750 -o node -g node "$RUN_DIR"
printf '{"agentUser":"node","agentUid":%s,"agentRoot":"/var/data/home/.isomux","agentRootWasDefault":true,"shareRoot":"%s"}\n' \
  "$(id -u node)" "$SHARE" > "$STATE/split.json"
chown isomux-server:isomux-server "$STATE/split.json"
chmod 600 "$STATE/split.json"

case "${SPLIT_RIG_BREAK:-}" in
  "") ;;
  state-readable) chmod 755 "$STATE" ;;
  code-owner) chown node /opt/isomux/package.json ;;
  code-deep-acl) setfacl -m u:node:rw /opt/isomux/server/backends/claude.ts ;;
  code-symlink)
    install -m 666 -o node -g node /dev/null /tmp/agent-owned
    ln -sf /tmp/agent-owned /opt/isomux/LICENSE ;;
  code-dir-link)
    install -d -m 755 /opt/split-rig-target
    install -m 666 /dev/null /opt/split-rig-target/writable.js
    ln -s /opt/split-rig-target /opt/isomux/split-rig-linked ;;
  code-hop-link)
    install -d -m 755 -o node -g node /opt/split-rig-hop
    ln -s /opt/isomux/package.json /opt/split-rig-hop/next
    chown -h node:node /opt/split-rig-hop/next
    ln -s /opt/split-rig-hop/next /opt/isomux/split-rig-via-hop ;;
  code-relative-link)
    # The kernel applies the .. after hop is followed: the link ends in the
    # agent's directory, not in split-rig-outside.
    install -d -m 755 /opt/split-rig-outside
    printf safe > /opt/split-rig-outside/safe.js
    install -d -m 755 -o node -g node /opt/split-rig-agent /opt/split-rig-agent/deeper
    printf agent-controlled > /opt/split-rig-agent/safe.js
    chown node:node /opt/split-rig-agent/safe.js
    ln -s /opt/split-rig-agent/deeper /opt/split-rig-outside/hop
    ln -s ../split-rig-outside/hop/../safe.js /opt/isomux/split-rig-relative ;;
  share-setgid) chmod g-s "$SHARE/files" ;;
  data-owner) chown node /var/data ;;
  *) echo "unknown SPLIT_RIG_BREAK=$SPLIT_RIG_BREAK" >&2; exit 2 ;;
esac

runner=/opt/isomux/server/agent-runner/runner.ts
[[ "${SPLIT_RIG_RUNNER:-real}" == stub ]] && runner=/opt/split-rig/stub-runner.ts
runuser -u node -- env -i HOME=/var/data/home USER=node SHELL=/bin/bash \
  LANG=C.UTF-8 PATH="$CLEAN_PATH" \
  bun "$runner" --socket "$SOCKET" --server-uid "$(id -u isomux-server)" &
for _ in $(seq 100); do [[ -S "$SOCKET" ]] && break; sleep 0.1; done

cd /opt/isomux
set +e
runuser -u isomux-server -- env -i HOME="$SERVER_HOME" USER=isomux-server \
  LANG=C.UTF-8 PATH="$CLEAN_PATH" ISOMUX_HOME="$STATE" PORT=10000 \
  ISOMUX_AGENT_RUNNER="$SOCKET" ISOMUX_SPLIT_RIG=1 \
  bun server/isomux-office.ts
# Keep the container for inspection after the office stops.
echo $? > /run/office-exit
exec sleep infinity
EOF
  cat > "$context/stub-runner.ts" <<'EOF'
// A false runner: it claims every diagnostic try was refused.
import { chmodSync } from "fs";
import { userInfo, homedir } from "os";
import {
  createFrameDecoder,
  encodeJson,
  FRAME_STDOUT,
  encodeFrame,
} from "/opt/isomux/server/agent-runner/frames.ts";

const socketPath = process.argv[process.argv.indexOf("--socket") + 1];
const denied = {
  readState: "EACCES",
  writeCode: "EACCES",
  renameCode: "EACCES",
  createInShare: "EACCES",
};
Bun.listen<{ decode: ReturnType<typeof createFrameDecoder> }>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { decode: createFrameDecoder() };
    },
    data(socket, chunk) {
      for (const frame of socket.data.decode(chunk)) {
        const request = JSON.parse(frame.payload.toString("utf8"));
        if (request.op === "info") {
          const user = userInfo();
          socket.write(encodeJson({ type: "info", uid: user.uid, gid: user.gid,
            user: user.username, home: homedir(), env: process.env }));
        } else if (request.op === "entry") {
          const value = request.name === "diagnose" ? denied
            : request.name === "real-node" ? { path: "/usr/local/bin/node" } : null;
          socket.write(encodeFrame(FRAME_STDOUT, Buffer.from(JSON.stringify(value))));
          socket.write(encodeJson({ type: "exit", code: 0, signal: null }));
        }
        socket.end();
      }
    },
  },
});
chmodSync(socketPath, 0o660);
EOF
  docker build -t "$IMAGE" "$context"
}

start() {
  local name=$1 brk=${2:-} runner=${3:-real}
  docker run -d --name "$name" --label isomux.split-rig=1 \
    -e SPLIT_RIG_BREAK="$brk" -e SPLIT_RIG_RUNNER="$runner" \
    -v "$name-data:/var/data" "$IMAGE" > /dev/null
}

stop() {
  docker rm -f "$1" > /dev/null 2>&1 || true
  docker volume rm "$1-data" > /dev/null 2>&1 || true
}

case "${1:-}" in
  build) shift; build "$@" ;;
  start) shift; start "$@" ;;
  stop) shift; stop "$@" ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
