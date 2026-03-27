import type { ServerMessage, ClientCommand } from "../shared/types.ts";

type MessageHandler = (msg: ServerMessage) => void;

let socket: WebSocket | null = null;
let handler: MessageHandler | null = null;

export function connect(onMessage: MessageHandler) {
  handler = onMessage;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as ServerMessage;
      handler?.(msg);
    } catch {}
  };
  socket.onclose = () => {
    // Auto-reconnect after 2s
    setTimeout(() => connect(onMessage), 2000);
  };
}

export function send(cmd: ClientCommand) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(cmd));
  }
}
