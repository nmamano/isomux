import {
  TASKS_SUMMARY_WS_PARAM,
  TASKS_SUMMARY_WS_VALUE,
} from "../shared/task-board.ts";
import {
  LOGS_ON_OPEN_WS_PARAM,
  LOGS_ON_OPEN_WS_VALUE,
  LOG_ACK_BYTES,
} from "../shared/log-stream.ts";
import type { ServerMessage, ClientCommand } from "../shared/types.ts";
import { ACCESS_CHANGED_CLOSE_CODE } from "../shared/pack-fit.ts";

type MessageHandler = (msg: ServerMessage) => void;
type RawHandler = (data: string) => void;
type ConnHandler = (connected: boolean) => void;

let socket: WebSocket | null = null;
let handler: MessageHandler | null = null;
let connHandler: ConnHandler | null = null;
const rawListeners = new Set<RawHandler>();
const binaryListeners = new Set<(data: ArrayBuffer) => void>();
let socketGen = 0;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
// The document the visibilitychange and online listeners were added for. Each
// DOM test file registers a new document and a new listener store on window
// while this module stays loaded, so a once-only flag left the listeners on the
// previous file's window.
let listenersDocument: Document | null = null;

// Bad-wifi case: TCP thinks the socket is alive but no data is flowing.
// onclose can take 30s+ to fire. A periodic ping with a short pong grace
// detects that faster and triggers a reconnect.
const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_GRACE_MS = 5_000;

// A socket opened while the network is down can stay in CONNECTING long after
// the network returns (iOS retries the TCP handshake for over a minute). Past
// this, replace it with a fresh socket.
const CONNECT_TIMEOUT_MS = 8_000;

// Shim: when set, bypasses real WebSocket entirely
let shimHandler: ((cmd: ClientCommand) => void) | null = null;
let shimOnConnect: (() => void) | null = null;

export function setShim(
  onCommand: ((cmd: ClientCommand) => void) | null,
  onConnect?: () => void,
) {
  shimHandler = onCommand;
  shimOnConnect = onConnect ?? null;
}

export function shimEmit(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const listener of rawListeners) {
    listener(data);
  }
  handler?.(msg);
}

// The generation of the current socket (task 9ebe887d): the store tells a
// full_state on a new socket (a reconnect) from one on the same socket.
export function socketGeneration(): number {
  return socketGen;
}

function clearPongTimer() {
  if (pongTimer !== null) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearConnectTimer() {
  if (connectTimer !== null) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

function clearHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      forceReconnect();
      return;
    }
    if (pongTimer !== null) return;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      forceReconnect();
    }, PONG_GRACE_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function forceReconnect() {
  if (!handler) return;
  // Don't wait for onclose: the failure mode we're handling is precisely that
  // onclose may be delayed or never fire (TCP zombie, browser-blocked close
  // handshake). connect() bumps socketGen and tears the old socket down
  // itself, so any later onclose for the dead socket becomes a no-op.
  connect(handler, connHandler ?? undefined);
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
  checkLink();
}

// The 'online' event only triggers a check; the banner stays driven by the
// socket alone. An open socket gets a ping instead of a teardown, because a new
// socket replays the whole office state.
function onOnline() {
  checkLink();
}

function checkLink() {
  if (!handler) return;
  // Socket already gone → reconnect without waiting for the 2s backoff.
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connect(handler, connHandler ?? undefined);
    return;
  }
  // iOS/Android can freeze a backgrounded socket without closing it; verify with a ping.
  try {
    socket.send(JSON.stringify({ type: "ping" }));
  } catch {
    connect(handler, connHandler ?? undefined);
    return;
  }
  clearPongTimer();
  pongTimer = setTimeout(() => {
    pongTimer = null;
    if (handler) connect(handler, connHandler ?? undefined);
  }, 3000);
}

export function connect(onMessage: MessageHandler, onConn?: ConnHandler) {
  handler = onMessage;
  if (onConn) connHandler = onConn;

  // In shim mode, don't open a real WebSocket - fire onConnect callback instead
  if (shimHandler) {
    if (shimOnConnect) setTimeout(shimOnConnect, 0);
    connHandler?.(true);
    return;
  }

  if (typeof document !== "undefined" && listenersDocument !== document) {
    listenersDocument?.removeEventListener("visibilitychange", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    listenersDocument = document;
  }

  clearReconnectTimer();
  clearHeartbeat();
  clearConnectTimer();
  // A pong grace left from the old socket would replace the new one.
  clearPongTimer();
  const myGen = ++socketGen;
  if (socket) {
    // Every replacement reports the link down, whatever started it (onclose
    // backoff, heartbeat, checkLink, CONNECTING timeout). The store stays
    // offline until the new socket's full_state, so the banner shows.
    connHandler?.(false);
    try {
      socket.close();
    } catch {}
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // The summary task board (task 9ebe887d): the tasks frame holds the open
  // and in-progress tasks without descriptions; ui/task-lookup.ts reads the
  // rest. Chats load when they open (ui/agent-log.ts): no connect replay.
  const ws = new WebSocket(
    `${protocol}//${location.host}/ws?${TASKS_SUMMARY_WS_PARAM}=${TASKS_SUMMARY_WS_VALUE}&${LOGS_ON_OPEN_WS_PARAM}=${LOGS_ON_OPEN_WS_VALUE}`,
  );
  ws.binaryType = "arraybuffer";
  socket = ws;
  // Lane frames of this socket not acked yet (see laneFrame).
  let unacked = 0;
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (myGen !== socketGen || ws.readyState !== WebSocket.CONNECTING) return;
    connect(onMessage, connHandler ?? undefined);
  }, CONNECT_TIMEOUT_MS);
  ws.onopen = () => {
    if (myGen !== socketGen) return;
    clearConnectTimer();
    startHeartbeat();
    // We don't flip connected=true here - the store gates that on full_state
    // arrival, so we don't briefly claim "online" before any data hydrates.
  };
  ws.onmessage = (e) => {
    // Same generation guard as onopen/onclose. A reconnect opens a new socket
    // and hydrates from scratch; a message still buffered on the OLD socket can
    // land after that and would be applied on top of fresh state. This used to
    // self-heal for the task board (the next mutation re-sent the whole list),
    // but the board takes per-task deltas now - a stale delta would simply stay
    // wrong. Cheap and correct for every message type, so it guards them all.
    if (myGen !== socketGen) return;
    // Any frame proves the link carries data, which is all the heartbeat
    // asks. On a slow link the pong can wait behind megabytes of replay in
    // the socket buffers, longer than PONG_GRACE_MS.
    clearPongTimer();
    if (e.data instanceof ArrayBuffer) {
      for (const listener of binaryListeners) listener(e.data);
      return;
    }
    if (typeof e.data !== "string") return;
    const data = e.data;
    let msg: ServerMessage | null = null;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {}
    if (msg?.type === "pong") return;
    // Flow control of the server's background lane: ack every lane frame,
    // before the store sees it, so a frame the store drops as stale is
    // acked too.
    if (msg && laneFrame(msg)) {
      unacked += data.length;
      if (unacked >= LOG_ACK_BYTES || msg.type === "log_open_done") {
        try {
          ws.send(JSON.stringify({ type: "log_ack", bytes: unacked }));
        } catch {}
        unacked = 0;
      }
    }
    for (const listener of rawListeners) {
      listener(data);
    }
    if (msg) handler?.(msg);
  };
  // The event is optional: tests close a fake socket without one.
  ws.onclose = (event?: CloseEvent) => {
    if (myGen !== socketGen) return;
    // The member's permission pack changed: reload, so nothing the pack now
    // hides stays on the page.
    if (event?.code === ACCESS_CHANGED_CLOSE_CODE) {
      location.reload();
      return;
    }
    clearPongTimer();
    clearReconnectTimer();
    clearHeartbeat();
    clearConnectTimer();
    connHandler?.(false);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(onMessage, connHandler ?? undefined);
    }, 2000);
  };
}

// Drops the handlers that connect() set for onMessage, and its socket and
// timers: the store calls it when it unmounts. A call for a handler that a
// later connect() replaced does nothing.
export function disconnect(onMessage: MessageHandler): void {
  if (handler !== onMessage) return;
  handler = null;
  connHandler = null;
  clearPongTimer();
  clearReconnectTimer();
  clearHeartbeat();
  clearConnectTimer();
  // The old socket's callbacks check the generation, so its onclose schedules
  // no reconnect.
  socketGen++;
  if (socket) {
    try {
      socket.close();
    } catch {}
    socket = null;
  }
}

// A frame of an open_log replay, sent in the server's background lane (task
// 9ebe887d): a log_entry or slash_commands with its request id, or a
// log_open_done that is not a refusal (a refusal is a live frame).
function laneFrame(msg: ServerMessage): boolean {
  switch (msg.type) {
    case "log_entry":
    case "slash_commands":
      return msg.requestId !== undefined;
    case "log_open_done":
      return !msg.refused;
    default:
      return false;
  }
}

export function send(cmd: ClientCommand): boolean {
  if (shimHandler) {
    shimHandler(cmd);
    return true;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(cmd));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// Subscribe to raw WebSocket messages (survives reconnects)
export function addRawListener(fn: RawHandler) {
  rawListeners.add(fn);
}

export function removeRawListener(fn: RawHandler) {
  rawListeners.delete(fn);
}

export function addBinaryListener(fn: (data: ArrayBuffer) => void) {
  binaryListeners.add(fn);
}

export function removeBinaryListener(fn: (data: ArrayBuffer) => void) {
  binaryListeners.delete(fn);
}

export function shimEmitBinary(data: ArrayBuffer) {
  for (const listener of binaryListeners) listener(data);
}
