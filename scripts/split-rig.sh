#!/usr/bin/env bash
# Two-user test rig for split mode (internal-docs/os-user-split-design.md,
# section 7). It builds the container image from a committed revision, adds a
# rig layer with the server user, and starts throwaway containers in which the
# office runs as isomux-server and the agent runner as node. Stubs replace the
# claude, codex and opencode binaries (write_stubs), so the backends run with
# no provider credentials. It never touches the live office.
# server/test-support/split-rig.integration.test.ts drives it.
# With SPLIT_RIG_REAL_PROVIDERS=1, build and start use isomux-split-rig:real,
# an image with the real provider binaries, for a run with real credentials.
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
# Member mode (internal-docs/member-os-user-design.md, slice 1b): the real
# image with its real entrypoint and stub engines. The office runs as node;
# a test claims it (POST /setup, key member-rig-setup-key-0123456789abcdef, origin
# https://office.example.com), makes members with POST /api/users and gives
# each its own OS user with docker exec -u 0 NAME isomux-member-user enable
# <member>.
#
#   scripts/split-rig.sh build-member TAG [REVISION]
#                                               build TAG (and TAG-base)
#   scripts/split-rig.sh image-check IMAGE      the member files of IMAGE and
#                                               each parent: root, no link, no
#                                               group or other write
#   scripts/split-rig.sh start-member NAME TAG  start one container of TAG
#
# Fence a build: systemd-run --user --scope -p MemoryMax=6G scripts/split-rig.sh build
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=isomux-split-rig:latest
REAL_PROVIDERS=${SPLIT_RIG_REAL_PROVIDERS:-}
[[ -n "$REAL_PROVIDERS" ]] && IMAGE=isomux-split-rig:real
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
$(provider_layer)
# The image already drops group and other write on the code tree; this
# catches what the provider layer adds. Change only those files: a recursive
# chmod copies every file into this layer.
RUN find /opt/isomux ! -type l -perm /022 -exec chmod go-w {} +
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
  SPLIT_RIG_SERVER_SENTINEL=server-only \
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
            : request.name === "bun-path" ? { path: "/usr/local/bin/bun" } : null;
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
  mkdir "$context/stubs"
  [[ -n "$REAL_PROVIDERS" ]] || write_stubs "$context/stubs"
  docker build -t "$IMAGE" "$context"
}

provider_layer() {
  [[ -n "$REAL_PROVIDERS" ]] && return
  echo "# Stub provider binaries in place of the real ones: no credentials needed."
  echo "COPY stubs/ /opt/split-rig/stubs/"
  echo "RUN bun /opt/split-rig/stubs/install.ts"
}

# The stubs report as RIG_REPORT {json} what an office test needs to see:
# their uid, which server-only variables reached their environment, and what
# they did for the agent user.
write_stubs() {
  local dir=$1
  cat > "$dir/install.ts" <<'EOF'
// Copy each stub over the binary the office would start.
import { chmodSync, copyFileSync } from "fs";
import { CLAUDE_NATIVE_BIN } from "/opt/isomux/server/cwd-utils.ts";
import { resolveCodexLauncherPath } from "/opt/isomux/server/backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "/opt/isomux/server/backends/opencode/runtime.ts";

for (const [stub, target] of [
  ["claude", CLAUDE_NATIVE_BIN],
  ["codex.js", resolveCodexLauncherPath()],
  ["opencode", resolveOpenCodeBinary()],
]) {
  copyFileSync(`/opt/split-rig/stubs/${stub}`, target);
  chmodSync(target, 0o755);
  console.log(`stub ${stub} -> ${target}`);
}
EOF
  cat > "$dir/claude" <<'EOF'
#!/usr/bin/env bun
// Rig stub for the Claude Code CLI (stream-json over stdio). It answers every
// control request, reports who runs it on each user message, and keeps a
// transcript where the real CLI would, so the session store can fork it.
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  // The SDK passes some flags as one argument, "--resume=<id>".
  const joined = args.find((a) => a.startsWith(`${name}=`));
  return joined === undefined ? undefined : joined.slice(name.length + 1);
};
const sessionId = flag("--resume") ?? flag("--session-id") ?? crypto.randomUUID();
const cwd = process.cwd();
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const projectDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
const transcript = join(projectDir, `${sessionId}.jsonl`);
// A resume of a transcript that is gone or has no conversation entry fails
// as the CLI does (checked on CLI 2.x, 2026-11-15): a line on stderr, one
// error result on stdout, and exit 1.
const resumed = flag("--resume") ?? null;
if (resumed) {
  let lines = [];
  try {
    lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {}
  if (!lines.some((l) => l.type === "user" || l.type === "assistant")) {
    const error = `No conversation found with session ID: ${resumed}`;
    process.stderr.write(`${error}\n`);
    process.stdout.write(
      `${JSON.stringify({ type: "result", subtype: "error_during_execution", duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null, session_id: resumed, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, permission_denials: [], uuid: crypto.randomUUID(), errors: [error] })}\n`,
    );
    process.exit(1);
  }
}
const SERVER_ONLY = ["SPLIT_RIG_SERVER_SENTINEL", "ISOMUX_HOME", "ISOMUX_AGENT_RUNNER"];
let parentUuid = null;
let initSent = false;

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (entry) => {
  mkdirSync(projectDir, { recursive: true });
  const uuid = crypto.randomUUID();
  appendFileSync(
    transcript,
    `${JSON.stringify({ ...entry, uuid, parentUuid, sessionId, isSidechain: false, timestamp: new Date().toISOString(), cwd })}\n`,
  );
  parentUuid = uuid;
  return uuid;
};

// A message with "RIG_CALL {method, path, body}" makes one office API call
// with the agent's own token; its status and body go in the report.
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : "";

function rigCall(content) {
  const text = textOf(content);
  const at = text.indexOf("RIG_CALL ");
  if (at < 0) return undefined;
  const req = JSON.parse(text.slice(at + "RIG_CALL ".length).split("\n")[0]);
  const r = Bun.spawnSync([
    "curl", "-s", "-X", req.method, `http://127.0.0.1:10000${req.path}`,
    "-H", "Host: office.example.com",
    "-H", `Authorization: Bearer ${process.env.ISOMUX_AGENT_TOKEN ?? ""}`,
    "-H", "Content-Type: application/json",
    "--data-binary", JSON.stringify(req.body ?? {}),
    "-w", "\n%{http_code}",
  ]);
  const out = r.stdout.toString();
  const nl = out.lastIndexOf("\n");
  return { status: Number(out.slice(nl + 1)), body: out.slice(0, nl) };
}

// `said`: the start of the user message, so a test sees what the office
// sent (a skill's body).
function report(call, said) {
  const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
  return `RIG_REPORT ${JSON.stringify({
    backend: "claude",
    uid,
    home: process.env.HOME,
    cwd,
    said: said.slice(0, 4000),
    serverEnv: SERVER_ONLY.filter((name) => name in process.env),
    transcript,
    resumed,
    ...(call ? { call } : {}),
  })}`;
}

function init() {
  if (initSent) return;
  initSent = true;
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    tools: [],
    mcp_servers: [],
    model: "claude-rig-stub",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "0.0.0-rig",
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
    uuid: crypto.randomUUID(),
  });
}

function answer(content) {
  init();
  record({ type: "user", message: { role: "user", content } });
  const text = report(rigCall(content), textOf(content));
  const message = {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-rig-stub",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  const uuid = record({ type: "assistant", message });
  out({ type: "assistant", message, parent_tool_use_id: null, session_id: sessionId, uuid });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
  });
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += Buffer.from(chunk).toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === "control_request") {
      const response =
        msg.request?.subtype === "initialize"
          ? { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {}, pid: process.pid }
          : {};
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    } else if (msg.type === "user") answer(msg.message?.content);
  }
}
EOF
  cat > "$dir/codex.js" <<'EOF'
// Rig stub for the Codex app-server (JSON-RPC lite over stdio), installed in
// place of the @openai/codex launcher. On a turn it runs the PreToolUse hook
// that hooks.json in CODEX_HOME names, and reports who ran what.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const SERVER_ONLY = ["SPLIT_RIG_SERVER_SENTINEL", "ISOMUX_HOME", "ISOMUX_AGENT_RUNNER"];
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => out({ method, params });
const uid = () => Bun.spawnSync(["id", "-u"]).stdout.toString().trim();

function hookCommand() {
  try {
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    return hooks.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? null;
  } catch {
    return null;
  }
}

function runHook(command) {
  if (!command) return null;
  const result = Bun.spawnSync([command], {
    stdin: Buffer.from(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        cwd: process.cwd(),
      }),
    ),
  });
  return {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
  };
}

// A thread's rollout, where Codex keeps it (one fixed date). thread/resume
// needs it, as Codex does; with rig-signed-out in CODEX_HOME a turn fails
// with the provider's 401.
const rolloutOf = (threadId) =>
  join(codexHome, "sessions", "2026", "11", "15", `rollout-2026-11-15T10-00-00-${threadId}.jsonl`);
const hasRollout = (threadId) => {
  try {
    return readdirSync(join(codexHome, "sessions"), { recursive: true }).some((p) =>
      String(p).endsWith(`-${threadId}.jsonl`),
    );
  } catch {
    return false;
  }
};
const signedOut = () => existsSync(join(codexHome, "rig-signed-out"));

const MODEL = {
  id: "gpt-rig",
  model: "gpt-rig",
  displayName: "GPT rig",
  description: "rig stub",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  supportsPersonality: false,
  upgrade: null,
};

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { userAgent: "codex-rig-stub/0.0.0", codexHome, platformFamily: "unix", platformOs: "linux" };
    case "hooks/list":
      return {
        data: (params?.cwds ?? [process.cwd()]).map((cwd) => ({
          cwd,
          hooks: [{ command: hookCommand(), currentHash: "sha256:rigstub", displayOrder: 0, eventName: "preToolUse" }],
          warnings: [],
          errors: [],
        })),
      };
    case "model/list":
      return { data: [MODEL], nextCursor: null };
    case "thread/start": {
      const thread = { id: crypto.randomUUID(), parentThreadId: null };
      mkdirSync(dirname(rolloutOf(thread.id)), { recursive: true });
      writeFileSync(rolloutOf(thread.id), `${JSON.stringify({ type: "session_meta", payload: { id: thread.id } })}\n`);
      setTimeout(() => notify("thread/started", { thread }), 0);
      return { thread };
    }
    case "thread/resume":
      if (!hasRollout(params.threadId))
        throw { rpc: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } };
      return { thread: { id: params.threadId } };
    case "turn/start": {
      const turn = { id: crypto.randomUUID() };
      const threadId = params.threadId;
      setTimeout(() => {
        notify("turn/started", { threadId, turn });
        if (signedOut()) {
          const error = { message: "401 Unauthorized" };
          notify("error", { error, willRetry: false, threadId, turnId: turn.id });
          notify("turn/completed", { threadId, turn: { ...turn, status: "failed", error } });
          return;
        }
        const text = `RIG_REPORT ${JSON.stringify({
          backend: "codex",
          threadId,
          uid: uid(),
          home: process.env.HOME,
          serverEnv: SERVER_ONLY.filter((name) => name in process.env),
          codexHome,
          hook: runHook(hookCommand()),
        })}`;
        notify("item/completed", {
          threadId,
          turnId: turn.id,
          item: { type: "agentMessage", id: crypto.randomUUID(), text },
        });
        notify("turn/completed", { threadId, turn: { ...turn, status: "completed", error: null } });
      }, 0);
      return { turn };
    }
    default:
      return {};
  }
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += Buffer.from(chunk).toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined || !msg.method) continue;
    try {
      out({ id: msg.id, result: handle(msg) });
    } catch (error) {
      if (!error?.rpc) throw error;
      out({ id: msg.id, error: error.rpc });
    }
  }
}
EOF
  cat > "$dir/opencode" <<'EOF'
#!/usr/bin/env bun
// Rig stub for `opencode serve`. On a prompt it starts a child process that
// sends one office request through the authority socket named in the system
// prompt, and reports the answer as the assistant's text.
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const SERVER_ONLY = ["SPLIT_RIG_SERVER_SENTINEL", "ISOMUX_HOME", "ISOMUX_AGENT_RUNNER"];
const streams = new Set();
const encoder = new TextEncoder();
const emit = (type, properties) => {
  const frame = encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`);
  for (const controller of streams) controller.enqueue(frame);
};

async function authorityCall(system) {
  const socket = /--unix-socket (\S+)/.exec(system)?.[1];
  const handle = /X-Isomux-Turn: ([^"\s]+)/.exec(system)?.[1];
  if (!socket || !handle) return { error: "no authority binding in the prompt" };
  // A child of this process, as an OpenCode tool call would be.
  const child = Bun.spawn(
    ["curl", "-s", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", socket,
     "-H", `X-Isomux-Turn: ${handle}`, "http://isomux/api/memory"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const status = (await new Response(child.stdout).text()).trim();
  return { socket, status, pid: child.pid };
}

async function prompt(sessionID, body) {
  const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
  const authority = await authorityCall(body.system ?? "");
  const text = `RIG_REPORT ${JSON.stringify({
    backend: "opencode",
    uid,
    servePid: process.pid,
    serverEnv: SERVER_ONLY.filter((name) => name in process.env),
    authority,
  })}`;
  const messageID = `msg_${crypto.randomUUID()}`;
  emit("message.updated", { sessionID, info: { id: messageID, role: "assistant", sessionID } });
  emit("message.part.updated", {
    sessionID,
    part: { type: "text", id: `prt_${crypto.randomUUID()}`, messageID, sessionID, text },
  });
  emit("message.part.updated", {
    sessionID,
    part: {
      type: "step-finish",
      id: `prt_${crypto.randomUUID()}`,
      messageID,
      sessionID,
      tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } },
      cost: 0,
    },
  });
  emit("session.idle", { sessionID });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/global/health") return Response.json({ healthy: true, version: "1.18.35" });
    if (path === "/provider")
      return Response.json({
        all: [{ id: "rig", name: "Rig", models: { stub: { name: "Stub", limit: { context: 1000 }, variants: {} } } }],
        connected: ["rig"],
        default: { rig: "stub" },
      });
    if (path === "/event") {
      let own;
      return new Response(
        new ReadableStream({
          start(controller) {
            own = controller;
            streams.add(controller);
            // As OpenCode does: the first event sends the headers.
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`),
            );
          },
          cancel() {
            streams.delete(own);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path === "/session" && request.method === "POST")
      return Response.json({ id: `ses_${crypto.randomUUID().replaceAll("-", "")}`, title: "rig" });
    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (promptMatch) {
      const body = await request.json();
      setTimeout(() => void prompt(decodeURIComponent(promptMatch[1]), body), 50);
      return new Response(null, { status: 204 });
    }
    if (/^\/session\/[^/]+\/message$/.test(path)) return Response.json([]);
    return Response.json({});
  },
});
EOF
}

# The files root runs for member users, and each of their parent folders up
# to /, checked in the image as built: before any rig layer changes a mode.
image_check() {
  docker run --rm --entrypoint python3 "$1" -I -c '
import os, stat, sys
files = [
    "/opt/isomux/deploy/container/member-users.py",
    "/opt/isomux/deploy/container/member-runner-loop.sh",
    "/usr/local/sbin/isomux-member-user",
    "/etc/isomux/member-user-container.conf",
    "/usr/bin/setpriv",
]
bad = []
seen = set()
for path in files:
    while path not in seen:
        seen.add(path)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            bad.append(f"{path} uid={info.st_uid} mode={oct(info.st_mode)}")
        if path == "/":
            break
        path = os.path.dirname(path)
print("\n".join(bad) or "ok")
sys.exit(1 if bad else 0)
'
}

build_member() {
  local tag=$1 revision commit context
  revision=${2:-HEAD}
  commit=$(git rev-parse --verify "$revision^{commit}")
  bash deploy/container/build.sh "$commit" "$tag-base"
  image_check "$tag-base"
  context=$(mktemp -d)
  trap 'rm -rf "$context"' RETURN
  cat > "$context/Dockerfile" <<EOF
FROM $tag-base
RUN apt-get update && apt-get install -y --no-install-recommends acl && rm -rf /var/lib/apt/lists/*
$(provider_layer)
LABEL isomux.split-rig.commit=$commit
EOF
  mkdir "$context/stubs"
  [[ -n "$REAL_PROVIDERS" ]] || write_stubs "$context/stubs"
  docker build -t "$tag" "$context"
}

start_member() {
  local name=$1 tag=$2
  # The seccomp profile of compose.yaml: Chromium's namespace sandbox needs it.
  docker run -d --name "$name" --label isomux.split-rig=1 \
    --security-opt seccomp=deploy/container/seccomp/chromium.json \
    -e ISOMUX_RIG_CANARY=member-rig-canary \
    -e ISOMUX_PUBLIC_URL=https://office.example.com \
    -e ISOMUX_SETUP_KEY=member-rig-setup-key-0123456789abcdef \
    -v "$name-data:/var/data" "$tag" > /dev/null
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
  build-member) shift; build_member "$@" ;;
  image-check) shift; image_check "$@" ;;
  start-member) shift; start_member "$@" ;;
  *) sed -n '2,33p' "$0" >&2; exit 2 ;;
esac
