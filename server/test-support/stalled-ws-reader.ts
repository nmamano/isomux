// A WebSocket client that stops reading, for the office outbox tests
// (server/test-support/office-ws-replay.test.ts). Test-support ONLY.
//
// Run as its own process: `bun stalled-ws-reader.ts <port> <cookie> <origin>
// <releaseFile>`. It opens /ws and, once the first frame arrives, blocks its
// own event loop until the test creates releaseFile (and prints "stalling" to
// stderr first), so the kernel buffers fill and the server's socket backs up
// exactly as it does for a slow link. Then it reads until the server closes
// the socket, or, when releaseFile names a log entry id, until that entry
// has arrived after the log_replay_complete fence (plus a short tail, to see
// a duplicate). It prints one JSON line: every text frame's type (and the log
// entry's id and agent, or the full_state agent ids), and whether the server
// closed the connection.
//
// A raw TCP client because Bun's WebSocket and node:net clients keep reading
// into memory while the script is paused, which never backs the server up.
//
// Chats that load when they open (task 9ebe887d slice 2) add three optional
// environment variables: READER_QUERY (the /ws query string), READER_SEND (a
// JSON array of client messages, sent as soon as the upgrade answers, before
// the stall) and READER_UNTIL (a request id: once its log_open_done has
// arrived, read a short tail and stop). Frames also carry requestId and
// refused when the message has them.
//
// Flow control of the background lane adds two more: READER_ACK=1 acks the
// lane frames as the office client does (log_ack per LOG_ACK_BYTES of raw
// frame length and at each lane log_open_done), but only after the stall;
// without it the reader never acks. READER_SEND_AFTER (a JSON array of client
// messages) goes out as the stall ends, before any ack.

import { existsSync, readFileSync, writeSync } from "node:fs";
import { LOG_ACK_BYTES } from "../../shared/log-stream.ts";

const [portArg, cookie, origin, releaseFile] = process.argv.slice(2);
const port = Number(portArg);
// The fail-closed bound on a stall the test never releases.
const STALL_LIMIT_MS = 10_000;
// After the awaited entry: long enough to see it arrive a second time.
const TAIL_MS = 100;
// With nothing awaited, or the awaited entry never arriving: this much
// silence ends the read.
const QUIET_MS = 1_000;

interface Frame {
  type: string;
  id?: string;
  agentId?: string;
  agentIds?: string[];
  requestId?: string;
  refused?: boolean;
}

const QUERY = process.env.READER_QUERY ?? "";
const SEND = JSON.parse(process.env.READER_SEND ?? "[]") as unknown[];
const UNTIL = process.env.READER_UNTIL ?? "";
const ACK = process.env.READER_ACK === "1";
const SEND_AFTER = JSON.parse(
  process.env.READER_SEND_AFTER ?? "[]",
) as unknown[];

// One masked client text frame (RFC 6455 5.3). The all-zero key leaves the
// payload as is, which every server must accept.
function clientFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x81, 0x80 | len])
      : len < 65536
        ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x81;
            b[1] = 0x80 | 127;
            b.writeBigUInt64BE(BigInt(len), 2);
            return b;
          })();
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}
let onUpgraded: () => void = () => {};

const frames: Frame[] = [];
let closed = false;
let buf = Buffer.alloc(0);
let upgraded = false;
let lastData = Date.now();
let stalled = false;
let awaitedId = "";
// Lane bytes received and not acked yet; acks start once the stall ends.
let unacked = 0;
let released = false;
function ack(): void {
  if (!ACK || !released || unacked === 0) return;
  socket.write(
    clientFrame(JSON.stringify({ type: "log_ack", bytes: unacked })),
  );
  unacked = 0;
}

function parse(): void {
  if (!upgraded) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    if (!buf.subarray(0, 12).toString().includes("101")) {
      frames.push({ type: `http:${buf.subarray(0, 12).toString()}` });
    }
    buf = buf.subarray(end + 4);
    upgraded = true;
    onUpgraded();
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
      agentId?: string;
      requestId?: string;
      refused?: boolean;
    };
    // A lane frame: a replay frame with its request id, or a log_open_done
    // that is not a refusal (a refusal is a live frame).
    const lane =
      msg.requestId !== undefined &&
      (msg.type === "log_entry" ||
        msg.type === "slash_commands" ||
        (msg.type === "log_open_done" && !msg.refused));
    if (lane) {
      unacked += payload.toString().length;
      if (unacked >= LOG_ACK_BYTES || msg.type === "log_open_done") ack();
    }
    const frame: Frame = { type: msg.type };
    if (msg.agentId) frame.agentId = msg.agentId;
    if (msg.requestId) frame.requestId = msg.requestId;
    if (msg.refused) frame.refused = true;
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
      // Stall at the first frame: the server sends the snapshot and queues
      // the whole replay in its open handler, so by then the replay is
      // under way. Blocking here stops all reads.
      if (frames.length > 0 && !stalled) {
        stalled = true;
        writeSync(2, "stalling\n");
        const deadline = Date.now() + STALL_LIMIT_MS;
        while (!existsSync(releaseFile) && Date.now() < deadline)
          Bun.sleepSync(5);
        if (existsSync(releaseFile))
          awaitedId = readFileSync(releaseFile, "utf8").trim();
        released = true;
        for (const message of SEND_AFTER)
          socket.write(clientFrame(JSON.stringify(message)));
        ack();
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
onUpgraded = () => {
  for (const message of SEND)
    socket.write(clientFrame(JSON.stringify(message)));
};
socket.write(
  [
    `GET /ws${QUERY ? `?${QUERY}` : ""} HTTP/1.1`,
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
// The awaited entry has arrived after the fence.
function awaitedSeen(): boolean {
  if (UNTIL)
    return frames.some(
      (f) => f.type === "log_open_done" && f.requestId === UNTIL,
    );
  if (!awaitedId) return false;
  const fence = frames.findIndex((f) => f.type === "log_replay_complete");
  return fence >= 0 && frames.slice(fence).some((f) => f.id === awaitedId);
}
let seenAt = 0;
while (!stalled || (!closed && Date.now() - lastData < QUIET_MS)) {
  if (!seenAt && awaitedSeen()) seenAt = Date.now();
  if (seenAt && Date.now() - seenAt >= TAIL_MS) break;
  await Bun.sleep(10);
}
console.log(JSON.stringify({ closed, frames }));
process.exit(0);
