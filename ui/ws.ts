import type { ServerMessage, ClientCommand } from "../shared/types.ts";

type MessageHandler = (msg: ServerMessage) => void;
type RawHandler = (data: string) => void;

let socket: WebSocket | null = null;
let handler: MessageHandler | null = null;
const rawListeners = new Set<RawHandler>();
let socketGen = 0;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

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

function onVisible() {
  if (document.visibilityState !== "visible") return;
  if (!handler) return;
  // Socket already gone → reconnect without waiting for the 2s backoff.
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connect(handler);
    return;
  }
  // iOS/Android can freeze a backgrounded socket without closing it; verify with a ping.
  try {
    socket.send(JSON.stringify({ type: "ping" } as ClientCommand));
  } catch {
    connect(handler);
    return;
  }
  clearPongTimer();
  pongTimer = setTimeout(() => {
    pongTimer = null;
    if (handler) connect(handler);
  }, 3000);
}

export function connect(onMessage: MessageHandler) {
  handler = onMessage;

  // In shim mode, don't open a real WebSocket — fire onConnect callback instead
  if (shimHandler) {
    if (shimOnConnect) setTimeout(shimOnConnect, 0);
    return;
  }

  if (typeof document !== "undefined" && !visibilityBound) {
    document.addEventListener("visibilitychange", onVisible);
    visibilityBound = true;
  }

  clearReconnectTimer();
  const myGen = ++socketGen;
  if (socket) {
    try {
      socket.close();
    } catch {}
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = ws;
  ws.onmessage = (e) => {
    const data = e.data as string;
    let msg: ServerMessage | null = null;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {}
    if (msg?.type === "pong") {
      clearPongTimer();
      return;
    }
    // Dispatch to raw listeners (terminal, etc.) with the original string
    for (const listener of rawListeners) {
      listener(data);
    }
    if (msg) handler?.(msg);
  };
  ws.onclose = () => {
    if (myGen !== socketGen) return;
    clearPongTimer();
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(onMessage);
    }, 2000);
  };
}

export function send(cmd: ClientCommand) {
  if (shimHandler) {
    shimHandler(cmd);
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(cmd));
  }
}

// Subscribe to raw WebSocket messages (survives reconnects)
export function addRawListener(fn: RawHandler) {
  rawListeners.add(fn);
}

export function removeRawListener(fn: RawHandler) {
  rawListeners.delete(fn);
}
