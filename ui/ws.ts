import type { ServerMessage, ClientCommand } from "../shared/types.ts";

type MessageHandler = (msg: ServerMessage) => void;
type RawHandler = (data: string) => void;
type ConnHandler = (connected: boolean) => void;

let socket: WebSocket | null = null;
let handler: MessageHandler | null = null;
let connHandler: ConnHandler | null = null;
const rawListeners = new Set<RawHandler>();
let socketGen = 0;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

// Bad-wifi case: TCP thinks the socket is alive but no data is flowing.
// onclose can take 30s+ to fire. A periodic ping with a short pong grace
// detects that faster and triggers a reconnect.
const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_GRACE_MS = 5_000;

// Shim: when set, bypasses real WebSocket entirely
let shimHandler: ((cmd: ClientCommand) => void) | null = null;
let shimOnConnect: (() => void) | null = null;

export function setShim(
  onCommand: (cmd: ClientCommand) => void,
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
  connHandler?.(false);
  // Don't wait for onclose: the failure mode we're handling is precisely that
  // onclose may be delayed or never fire (TCP zombie, browser-blocked close
  // handshake). connect() bumps socketGen and tears the old socket down
  // itself, so any later onclose for the dead socket becomes a no-op.
  connect(handler, connHandler ?? undefined);
}

function onVisible() {
  if (document.visibilityState !== "visible") return;
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

  if (typeof document !== "undefined" && !visibilityBound) {
    document.addEventListener("visibilitychange", onVisible);
    visibilityBound = true;
  }

  clearReconnectTimer();
  clearHeartbeat();
  const myGen = ++socketGen;
  if (socket) {
    try {
      socket.close();
    } catch {}
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    if (myGen !== socketGen) return;
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
    const data = e.data as string;
    let msg: ServerMessage | null = null;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {}
    if (msg?.type === "pong") {
      clearPongTimer();
      return;
    }
    for (const listener of rawListeners) {
      listener(data);
    }
    if (msg) handler?.(msg);
  };
  ws.onclose = () => {
    if (myGen !== socketGen) return;
    clearPongTimer();
    clearReconnectTimer();
    clearHeartbeat();
    connHandler?.(false);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(onMessage, connHandler ?? undefined);
    }, 2000);
  };
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
