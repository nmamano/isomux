// A WebSocket client that stops reading, for the office outbox tests
// (server/test-support/office-ws-replay.test.ts). Test-support ONLY.
//
// Run as its own process: `bun stalled-ws-reader.ts <port> <cookie> <origin>
// <stallMs>`. It opens /ws and, once the upgrade is answered, blocks its own
// event loop for stallMs (and prints "stalling" to stderr first), so
// the kernel buffers fill and the server's socket backs up exactly as it
// does for a slow link. Then it reads everything until the server closes
// the socket or sends nothing for a second, and prints one JSON line: every
// text frame's type (and the log entry's id and agent, or the full_state
// agent ids), and
// whether the server closed the connection.
//
// A raw TCP client because Bun's WebSocket and node:net clients keep reading
// into memory while the script is paused, which never backs the server up.

import { writeSync } from "node:fs";

const [portArg, cookie, origin, stallArg] = process.argv.slice(2);
const port = Number(portArg);
const stallMs = Number(stallArg);

interface Frame {
  type: string;
  id?: string;
  agentId?: string;
  agentIds?: string[];
}

const frames: Frame[] = [];
let closed = false;
let buf = Buffer.alloc(0);
let upgraded = false;
let lastData = Date.now();
let stalled = false;

function parse(): void {
  if (!upgraded) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    if (!buf.subarray(0, 12).toString().includes("101")) {
      frames.push({ type: `http:${buf.subarray(0, 12).toString()}` });
    }
    buf = buf.subarray(end + 4);
    upgraded = true;
  }
  for (;;) {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      at = 10;
    }
    if (buf.length < at + len) return;
    const payload = buf.subarray(at, at + len);
    buf = buf.subarray(at + len);
    if (opcode === 0x8) {
      closed = true;
      continue;
    }
    if (opcode !== 0x1) continue;
    const msg = JSON.parse(payload.toString()) as {
      type: string;
      entry?: { id: string; agentId: string };
      agents?: { id: string }[];
    };
    const frame: Frame = { type: msg.type };
    if (msg.entry) {
      frame.id = msg.entry.id;
      frame.agentId = msg.entry.agentId;
    }
    if (msg.agents) frame.agentIds = msg.agents.map((a) => a.id);
    frames.push(frame);
  }
}

const socket = await Bun.connect({
  hostname: "127.0.0.1",
  port,
  socket: {
    data(_s, chunk) {
      lastData = Date.now();
      buf = Buffer.concat([buf, chunk]);
      parse();
      // Stall once the upgrade is answered: by then the server has opened
      // the socket and started the replay. Blocking here stops all reads.
      if (upgraded && !stalled) {
        stalled = true;
        writeSync(2, "stalling\n");
        Bun.sleepSync(stallMs);
        lastData = Date.now();
      }
    },
    close() {
      closed = true;
    },
    error() {
      closed = true;
    },
  },
});
socket.write(
  [
    "GET /ws HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    `Origin: ${origin}`,
    `Cookie: ${cookie}`,
    "",
    "",
  ].join("\r\n"),
);
while (!stalled || (!closed && Date.now() - lastData < 1000)) {
  await Bun.sleep(50);
}
console.log(JSON.stringify({ closed, frames }));
process.exit(0);
