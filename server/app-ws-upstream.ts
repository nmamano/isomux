// The relay's WebSocket client to an app on loopback (phase 3, slice 6a).
//
// One connection to one app, over a raw TCP socket, using the codec in
// ws-frames.ts. Bun's own WebSocket client would be less code; it is not used
// for one measured reason, recorded here because it is the whole justification
// for this file: its write queue is unbounded and invisible. Sending 120MB to an
// app that had stopped reading left `bufferedAmount` at 0 while the process grew
// to 211MB RSS (Bun 1.3.11). A raw socket instead returns a short count or zero
// from `write()`, buffers nothing itself, and fires `drain` when the peer
// resumes - so the queue is OURS, with a number on it, and an app that stops
// reading gets its connection closed instead of quietly costing the office
// memory it shares with every agent.
//
// WHAT THIS OWNS
//   - the HTTP upgrade, bounded in both bytes and time, validated strictly
//     (status, tokenized Connection/Upgrade, exact Sec-WebSocket-Accept, no
//     unsolicited extension or subprotocol);
//   - the write queue, accounted in WIRE bytes with a reserve so a pong or a
//     close can still leave when the data queue is full;
//   - ping (answered here, payload echoed) and pong (consumed here);
//   - the close handshake, bounded by a timer, converging on ONE finalizer.
//
// WHAT ONE CONNECTION CAN HOLD, derived rather than asserted - the relay's
// capacity math is built on this, so the terms are listed by what SURVIVES across
// event turns and what is transient within one:
//
//   surviving:  the write queue                       <= queueMaxBytes
//               the decoder's fragments + the one     <= maxMessageBytes + 14
//                 incomplete frame behind them          (together: the aggregate
//                                                        cap is enforced from a
//                                                        continuation's HEADER,
//                                                        so the pair cannot both
//                                                        approach the cap)
//   transient, and it stacks ON TOP of the surviving state rather than replacing
//   it, because a browser-to-app write can happen while the decoder is
//   mid-message:
//               inbound:  one copied TCP read         - whatever Bun hands us.
//                                                        NOT a constant we
//                                                        enforce: observed max
//                                                        524288 bytes on Bun
//                                                        1.3.11, pushing 32MB
//                                                        through a loopback
//                                                        socket. A runtime change
//                                                        could change it.
//                         + one decoded message        <= maxMessageBytes
//               outbound: one masked copy of the frame <= maxMessageBytes
//                         (the concatenated frame itself is the queued one, so it
//                          is already counted above)
//
// With the defaults - 1MB message, 512KB queue - that is about 3.5MB per
// connection at peak, plus one Bun TCP read (observed max 512KB on 1.3.11). Every
// term above is either a named constant here or an observation with a number
// against it, and heldBytes() exposes the two that are ours to enforce so a test
// can read them.
//
// WHAT IT DELIBERATELY DOES NOT OWN: any policy. It does not know what an app
// is, cannot look one up, and holds no credential. The relay (slice 6b) decides
// who may connect and what to do when this connection ends.
//
// Nothing here is wired into a request path yet - slice 6b does that.

import { connect, type Socket } from "bun";
import { randomBytes, createHash } from "crypto";
import {
  FrameDecoder,
  MAX_CONTROL_PAYLOAD_BYTES,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  isTransmittableCloseCode,
  truncateCloseReason,
  type DecodedMessage,
} from "./ws-frames.ts";

// --- limits (plain named values, no env vars) --------------------------------

// The largest message relayed in either direction. Applies to a single frame and
// to a reassembled fragmented message alike. 1MB is far above what a WebSocket
// app protocol sends per message and far below anything that threatens the
// office; a message over it ends the connection with 1009, which is the code
// that means exactly this.
export const APP_WS_MAX_MESSAGE_BYTES = 1024 * 1024;

// The write queue's ceiling, in wire bytes. Reached when an app has stopped
// reading: the connection is then closed rather than held open at the office's
// expense. This is the number that makes the relay's memory statable.
export const APP_WS_QUEUE_MAX_BYTES = 512 * 1024;

// Held back inside the queue ceiling for control frames. Without it a full data
// queue would make a pong or a close frame unsendable, and the connection would
// die of silence with no way to say why. Sized for many control frames: each is
// at most 125 payload bytes plus a 14-byte header.
export const APP_WS_CONTROL_RESERVE_BYTES = 4 * 1024;

// How long the upgrade has to complete: the TCP connect, the request, and the
// whole response header block. Loopback, so this is a "the app is wedged"
// bound, not a latency allowance.
export const APP_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

// The response header block's byte ceiling. An app that streams headers forever
// is refused rather than buffered.
export const APP_WS_HANDSHAKE_MAX_HEADER_BYTES = 16 * 1024;

// The same ceiling applied to the request WE write. The headers in it come from a
// browser's own upgrade request, so its size is not ours to assume: a caller that
// forwards something enormous is refused here rather than discovering it as a
// stall halfway through a write.
export const APP_WS_HANDSHAKE_MAX_REQUEST_BYTES = 16 * 1024;

// After a close frame goes out, how long the peer has to answer with its own
// before the socket is torn down. Short: the connection is already over, this
// only decides whether it ends politely.
export const APP_WS_CLOSE_HANDSHAKE_MS = 2_000;

export interface AppUpstreamLimits {
  maxMessageBytes: number;
  queueMaxBytes: number;
  controlReserveBytes: number;
  handshakeTimeoutMs: number;
  handshakeMaxHeaderBytes: number;
  handshakeMaxRequestBytes: number;
  closeHandshakeMs: number;
}

const DEFAULT_LIMITS: AppUpstreamLimits = {
  maxMessageBytes: APP_WS_MAX_MESSAGE_BYTES,
  queueMaxBytes: APP_WS_QUEUE_MAX_BYTES,
  controlReserveBytes: APP_WS_CONTROL_RESERVE_BYTES,
  handshakeTimeoutMs: APP_WS_HANDSHAKE_TIMEOUT_MS,
  handshakeMaxHeaderBytes: APP_WS_HANDSHAKE_MAX_HEADER_BYTES,
  handshakeMaxRequestBytes: APP_WS_HANDSHAKE_MAX_REQUEST_BYTES,
  closeHandshakeMs: APP_WS_CLOSE_HANDSHAKE_MS,
};

const EMPTY = Buffer.alloc(0);

// Keep the reason a close already had, and add what happened to it. A detail that
// replaced the original would lose the only part a log actually needs.
function withCause(existing: string | null, cause: string): string {
  return existing === null ? cause : `${existing}; ${cause}`;
}

// The fixed GUID every WebSocket handshake hashes with (RFC 6455 section 1.3).
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// --- request building (pure) -------------------------------------------------

// A header name must be an RFC 7230 token, and a value must carry no control
// character. This is not pedantry: the request below is BYTES, assembled with
// CRLFs, and these names and values come from a browser's request. A value
// holding a CRLF would let a visitor write extra headers - or a whole extra
// request - into what the app receives.
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isSafeHeaderName(name: string): boolean {
  return TOKEN_PATTERN.test(name);
}

export function isSafeHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // No CR, LF, NUL or any other C0 control; no DEL. A leading or trailing
    // space is legal in a field value and harmless.
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// The request target, which is a path the office already validated and then
// re-serialized from a URL - so this is a last structural check rather than the
// first: one leading slash, no whitespace, printable ASCII only.
export function isSafeRequestTarget(target: string): boolean {
  if (!target.startsWith("/")) return false;
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) return false;
  }
  return true;
}

// A subprotocol token, as offered by the client. Anything else is not something
// to pass along, because the value ends up in a header line.
export function isSafeProtocolToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export interface HandshakeRequest {
  target: string;
  host: string;
  key: string;
  protocols: string[];
  headers: Record<string, string>;
}

// The upgrade request as bytes. Every header the client owns is written HERE, so
// a caller-supplied duplicate cannot appear twice with different values: the
// caller's headers are filtered by the relay before they arrive, and the four
// names below are re-checked as a backstop.
const CLIENT_OWNED_HEADERS = new Set([
  "host",
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "content-length",
  "transfer-encoding",
]);

export function buildHandshakeRequest(req: HandshakeRequest): Buffer | null {
  if (!isSafeRequestTarget(req.target)) return null;
  if (!isSafeHeaderValue(req.host) || req.host.length === 0) return null;
  if (!req.protocols.every(isSafeProtocolToken)) return null;
  const lines = [
    `GET ${req.target} HTTP/1.1`,
    `Host: ${req.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${req.key}`,
  ];
  if (req.protocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${req.protocols.join(", ")}`);
  }
  // No Sec-WebSocket-Extensions line at all: this client negotiates none, which
  // is why the decoder can refuse a frame with a reserved bit set, and why there
  // is no compression path over untrusted app bytes.
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (CLIENT_OWNED_HEADERS.has(lower)) continue;
    if (!isSafeHeaderName(name) || !isSafeHeaderValue(value)) return null;
    lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
}

// The one place a validation outcome becomes a dial failure, so the two
// vocabularies cannot drift apart as either grows.
const HANDSHAKE_FAILURES: Record<
  "rejected" | "invalid" | "protocol",
  DialFailure
> = {
  rejected: "handshake_rejected",
  invalid: "handshake_invalid",
  protocol: "handshake_protocol",
};

export function handshakeAccept(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

// --- handshake response validation (pure) ------------------------------------

export type HandshakeCheck =
  | { ok: true; protocol: string | null }
  // `rejected` is an app that answered something other than an upgrade - a
  // page, a 404, a redirect. `invalid` is an app that tried to upgrade and got
  // it wrong. `protocol` is the narrow subprotocol-negotiation case, split out
  // in slice 6b because the relay owes that one a different, debuggable answer:
  // the browser asked for an application protocol and the app did not agree to
  // it, which is the caller's problem to fix rather than a broken app. The
  // distinction is the caller's, not cosmetic, and it is carried as a field
  // rather than sniffed out of the message text.
  | { ok: false; kind: "rejected" | "invalid" | "protocol"; detail: string };

// Comma-separated field value as lowercase tokens, for the two headers whose
// meaning is "contains this token" rather than "equals this string".
function tokens(value: string | undefined): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  for (const part of value.split(",")) {
    const token = part.trim().toLowerCase();
    if (token.length > 0) out.add(token);
  }
  return out;
}

export function checkHandshakeResponse(
  head: string,
  expectedAccept: string,
  offeredProtocols: string[],
): HandshakeCheck {
  const lines = head.split("\r\n");
  const status = lines[0] ?? "";
  // Only 101 is an upgrade. Anything else - a 200 page, a 404, a redirect - is
  // an app that is not speaking WebSocket on this path.
  // HTTP/1.1 exactly: RFC 6455's handshake is defined on 1.1, and a 1.0 response
  // claiming 101 is a peer whose framing assumptions we cannot rely on.
  if (!/^HTTP\/1\.1 101(?:\s|$)/.test(status)) {
    return {
      ok: false,
      kind: "rejected",
      detail: `upgrade refused: ${status.slice(0, 80)}`,
    };
  }
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  const one = (name: string): string | undefined => {
    const all = headers.get(name);
    return all !== undefined && all.length === 1 ? all[0] : undefined;
  };
  if (!tokens(one("connection")).has("upgrade")) {
    return {
      ok: false,
      kind: "invalid",
      detail: "response Connection does not name upgrade",
    };
  }
  if (!tokens(one("upgrade")).has("websocket")) {
    return {
      ok: false,
      kind: "invalid",
      detail: "response Upgrade is not websocket",
    };
  }
  const accept = one("sec-websocket-accept");
  if (accept !== expectedAccept) {
    // The accept value proves the peer read our key and is answering THIS
    // handshake - the check that keeps a cached or cross-wired response from
    // being taken for an open connection.
    return {
      ok: false,
      kind: "invalid",
      detail: "Sec-WebSocket-Accept does not match",
    };
  }
  if (headers.has("sec-websocket-extensions")) {
    // We offered none, so any answer here is an extension the peer expects us to
    // apply to every frame - and we would not.
    return {
      ok: false,
      kind: "invalid",
      detail: "server answered with an unoffered extension",
    };
  }
  const protocolLines = headers.get("sec-websocket-protocol") ?? [];
  if (protocolLines.length > 1) {
    return {
      ok: false,
      kind: "invalid",
      detail: "multiple Sec-WebSocket-Protocol values",
    };
  }
  if (protocolLines.length === 0) {
    // No subprotocol chosen. Fine whether or not any were offered: the client
    // asked, the server declined, and the connection is plain WebSocket.
    return { ok: true, protocol: null };
  }
  const chosen = protocolLines[0];
  if (!offeredProtocols.includes(chosen)) {
    return {
      ok: false,
      kind: "protocol",
      detail: `server chose an unoffered subprotocol: ${chosen.slice(0, 40)}`,
    };
  }
  return { ok: true, protocol: chosen };
}

// --- the connection ----------------------------------------------------------

export type SendOutcome =
  // Handed to the socket or queued inside the cap.
  | "sent"
  // Over the queue ceiling: the caller's contract is to end the connection.
  | "queue_full"
  // Over the message cap. Refused here so an oversized message never reaches
  // the wire in the browser-to-app direction.
  | "too_large"
  // A close is already in flight; nothing more will be sent.
  | "closing";

export interface UpstreamCloseEvent {
  // The app's close code, or null when it closed without one. `abnormal` marks
  // the cases where no close frame was exchanged at all - the socket dropped, a
  // protocol error, a timeout - which a relay must not report to a browser as a
  // clean goodbye.
  code: number | null;
  reason: string;
  abnormal: boolean;
  // A one-line explanation for the log when this end caused the close.
  detail: string | null;
}

export interface AppUpstreamHandlers {
  // Data messages only: ping, pong and close are handled inside.
  onMessage(
    message: { kind: "text"; text: string } | { kind: "binary"; data: Buffer },
  ): void;
  // Exactly once, whatever ends the connection.
  onClose(event: UpstreamCloseEvent): void;
}

export interface AppUpstreamOptions extends AppUpstreamHandlers {
  port: number;
  // Request target and Host, both already derived from values the office
  // verified - never from a raw request header.
  target: string;
  host: string;
  // Headers the relay decided to forward, after its own hygiene pass.
  headers: Record<string, string>;
  // Subprotocols the browser offered, in order.
  protocols: string[];
  limits?: Partial<AppUpstreamLimits>;
  // TEST SEAM ONLY, and the only one here. Some of this module's contract is
  // about what happens when a socket misbehaves - a connect that never
  // completes, a write the socket only half accepts - and neither can be
  // provoked with a real loopback socket. Production never passes this.
  connector?: typeof connect;
}

export type DialFailure =
  | "connect_failed"
  | "handshake_timeout"
  | "handshake_rejected"
  | "handshake_invalid"
  // The app's 101 named a subprotocol the client never offered. Its own kind so
  // the relay can say what actually went wrong (slice 6b).
  | "handshake_protocol"
  | "bad_request";

export type DialResult =
  | { ok: true; connection: AppUpstream }
  | { ok: false; failure: DialFailure; detail: string };

// One live connection. Every method is safe to call at any point in the
// lifecycle - after a close, sends report "closing" rather than throwing,
// because a relay's two legs die in whichever order the network chooses.
export class AppUpstream {
  private readonly socket: Socket<undefined>;
  private readonly limits: AppUpstreamLimits;
  private readonly handlers: AppUpstreamHandlers;
  private readonly decoder: FrameDecoder;
  // Frames waiting for the socket. The head may be partially written.
  private queue: Buffer[] = [];
  private queuedBytesValue = 0;
  private state: "open" | "closing" | "closed" = "open";
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  // Set when this end initiated or answered a close, so the finalizer can tell
  // an app's goodbye from our own.
  private pendingClose: UpstreamCloseEvent | null = null;
  // Bytes that shared the handshake's last read, held until begin().
  private leftover: Buffer = EMPTY;
  // Set when a close frame is queued that MUST reach the peer before the socket
  // goes: the echo of the app's own close. The flush finishes the connection the
  // moment the queue empties.
  private finalizeWhenFlushed: UpstreamCloseEvent | null = null;

  readonly protocol: string | null;

  constructor(init: {
    socket: Socket<undefined>;
    limits: AppUpstreamLimits;
    handlers: AppUpstreamHandlers;
    protocol: string | null;
    leftover: Buffer;
  }) {
    this.socket = init.socket;
    this.limits = init.limits;
    this.handlers = init.handlers;
    this.protocol = init.protocol;
    this.decoder = new FrameDecoder({
      maxMessageBytes: init.limits.maxMessageBytes,
    });
    this.leftover = init.leftover;
  }

  // Feed the bytes that arrived in the same TCP read as the end of the handshake
  // headers.
  //
  // DELIBERATELY NOT DONE IN THE CONSTRUCTOR. Those bytes can be a close frame
  // or a protocol violation, either of which ends the connection - and ending it
  // runs the socket's close handler SYNCHRONOUSLY, before the constructor has
  // even returned. The dial would then still be holding a null connection
  // reference and would report its generic "closed during the upgrade" instead of
  // the outcome that actually happened. So the caller publishes the connection
  // and settles the dial FIRST, then calls this.
  begin(): void {
    const bytes = this.leftover;
    this.leftover = EMPTY;
    if (bytes.length > 0) this.receive(bytes);
  }

  queuedBytes(): number {
    return this.queuedBytesValue;
  }

  // Bytes this connection is holding: the write queue plus whatever the decoder
  // has not yet turned into a message. The relay's memory bound is written in
  // terms of this, and the test that asserts the bound reads it.
  heldBytes(): number {
    return this.queuedBytesValue + this.decoder.pendingBytes();
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  sendText(text: string): SendOutcome {
    if (this.state !== "open") return "closing";
    // Byte length, not string length: the cap is a wire cap.
    if (Buffer.byteLength(text, "utf8") > this.limits.maxMessageBytes) {
      return "too_large";
    }
    return this.enqueue(encodeTextFrame(text), false);
  }

  sendBinary(data: Buffer): SendOutcome {
    if (this.state !== "open") return "closing";
    if (data.length > this.limits.maxMessageBytes) return "too_large";
    return this.enqueue(encodeBinaryFrame(data), false);
  }

  // Begin the close handshake. `code === null` sends a close with no status,
  // which is the honest wire form when the browser gave us none.
  sendClose(
    code: number | null,
    reason = "",
    detail: string | null = null,
  ): void {
    if (!this.isOpen()) return;
    this.state = "closing";
    this.pendingClose = {
      code,
      reason: truncateCloseReason(reason),
      abnormal: false,
      detail,
    };
    const frame =
      code !== null && isTransmittableCloseCode(code)
        ? encodeCloseFrame(code, reason)
        : // A code that cannot go on the wire is sent as "no status" rather than
          // as something else: substituting a different number would put words
          // in the browser's mouth.
          encodeCloseFrame(null);
    this.enqueue(frame, true);
    if (this.finished) return;
    // The peer gets a moment to answer, then the socket goes regardless. A
    // half-closed connection waiting forever is the state this whole slice is
    // meant not to produce. The original reason is carried through the timeout
    // rather than replaced by it, because that is what a log needs.
    this.armCloseTimer(
      { code, reason: truncateCloseReason(reason), abnormal: false, detail },
      detail ?? "closing",
    );
  }

  // End the TCP connection with NO close frame.
  //
  // This is not rudeness, it is vocabulary: a WebSocket close code of 1006
  // means "the connection dropped without a close frame", and it is the only
  // truthful thing to send an app when the browser at the other end vanished
  // the same way. Measured on Bun 1.3.11: this is also what Bun's own client
  // does internally when handed an untransmittable code, which is what made the
  // behavior discoverable in the first place.
  terminate(detail = "terminated"): void {
    if (this.finished) return;
    this.finish({ code: null, reason: "", abnormal: true, detail });
  }

  // --- internals -------------------------------------------------------------

  private enqueue(frame: Buffer, isControl: boolean): SendOutcome {
    const ceiling = isControl
      ? this.limits.queueMaxBytes
      : this.limits.queueMaxBytes - this.limits.controlReserveBytes;
    if (this.queuedBytesValue + frame.length > ceiling) {
      if (!isControl) return "queue_full";
      // A control frame that will not fit even inside the reserve means the
      // ceiling is already breached; terminating is the only option that keeps
      // the bound true. The reserve is sized so this cannot happen in practice.
      this.terminate("control frame over the queue ceiling");
      return "queue_full";
    }
    this.queue.push(frame);
    this.queuedBytesValue += frame.length;
    this.flush();
    return "sent";
  }

  // Write as much as the socket will take. A short write leaves the remainder at
  // the head of the queue; `drain` calls this again. Re-entrant by construction:
  // it only ever reads and rewrites the queue, so a drain that arrives during a
  // write finds consistent state.
  private flush(): void {
    if (this.state === "closed") return;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      let written: number;
      try {
        written = this.socket.write(head);
      } catch (err) {
        this.terminate(`socket write failed: ${String(err).slice(0, 120)}`);
        return;
      }
      if (written >= head.length) {
        this.queue.shift();
        this.queuedBytesValue -= head.length;
        continue;
      }
      // Partial write: the socket's buffer is full. Keep the tail and wait.
      if (written > 0) {
        this.queue[0] = head.subarray(written);
        this.queuedBytesValue -= written;
      }
      return;
    }
    // The queue is empty. If a close was waiting for its own bytes to leave,
    // this is the moment it is safe to end the socket.
    const waiting = this.finalizeWhenFlushed;
    if (waiting !== null) {
      this.finalizeWhenFlushed = null;
      this.finish(waiting);
    }
  }

  // Called by the socket handlers set up in dialAppUpstream.
  onDrain(): void {
    this.flush();
  }

  receive(chunk: Buffer): void {
    // A CLOSING connection keeps reading, and that is not a detail: after this
    // end sends a close, the peer's own close frame is what completes the
    // handshake. Stopping at `closing` meant a well-behaved app that answers and
    // leaves the socket open was ignored until the timer, and then reported as an
    // abnormal close - a real app's polite goodbye recorded as a failure. (A Bun
    // app hides this by dropping TCP too.) What does NOT happen while closing is
    // delivery: `handle` gates data and ping on the open state, so only the close
    // is acted on.
    if (this.finished) return;
    // Each message is handled as it is decoded and then dropped, so one decoded
    // message is in hand at a time rather than a whole read's worth. `stop` ends
    // the parse once the connection is finished - there is nothing left to tell
    // anyone.
    const result = this.decoder.push(chunk, (message) => {
      this.handle(message);
      return this.finished ? "stop" : "continue";
    });
    if (!result.ok) {
      // Tell the peer which rule it broke - once - and let the finalizer run on
      // its answer or on the close timer. A no-op when a close is already in
      // flight (sendClose only acts on an open connection), which is right: the
      // connection is ending anyway and the first diagnosis is the useful one.
      // Nothing more of this stream is parsed either way - the decoder is spent
      // after a failure.
      this.sendClose(
        result.failure.code,
        "",
        `protocol error: ${result.failure.detail}`,
      );
    }
  }

  private handle(message: DecodedMessage): void {
    switch (message.kind) {
      case "text":
        if (this.state === "open") {
          this.handlers.onMessage({ kind: "text", text: message.text });
        }
        return;
      case "binary":
        if (this.state === "open") {
          this.handlers.onMessage({ kind: "binary", data: message.data });
        }
        return;
      case "ping":
        // Answered here, payload echoed, because a pong belongs to the leg the
        // ping came from. Bun's server answers the browser's pings on the other
        // leg the same way (measured), so keepalive stays per-leg and no ping
        // ever crosses the relay.
        if (
          this.state === "open" &&
          message.payload.length <= MAX_CONTROL_PAYLOAD_BYTES
        ) {
          this.enqueue(encodePongFrame(message.payload), true);
        }
        return;
      case "pong":
        // Consumed. Nothing on this side ever sends a ping, so a pong is either
        // unsolicited or an answer to something the app imagined.
        return;
      case "close":
        this.onPeerClose(message.code, message.reason);
        return;
    }
  }

  private onPeerClose(code: number | null, reason: string): void {
    const event: UpstreamCloseEvent = {
      code,
      reason,
      abnormal: false,
      detail: null,
    };
    if (this.state !== "open") {
      // The peer is answering OUR close, which completes the handshake. Report
      // what THIS end decided - pendingClose carries the reason, e.g. which
      // protocol rule the app broke - rather than the echo of it, and not
      // abnormal, because the handshake did finish.
      this.finish(this.pendingClose ?? event);
      return;
    }
    // The RFC's echo: answer with the same code so the peer knows its close was
    // understood. It must actually LEAVE first - finishing here would clear the
    // queue and end the socket, silently dropping the echo in exactly the case
    // the queue exists for (a peer that is not draining). So the finalizer waits
    // on the flush, bounded by the close timer.
    this.state = "closing";
    this.pendingClose = event;
    this.finalizeWhenFlushed = event;
    this.enqueue(
      code === null ? encodeCloseFrame(null) : encodeCloseFrame(code, reason),
      true,
    );
    // The write may have gone out whole, in which case the flush below already
    // finished the connection and this timer is never armed.
    if (this.finished) return;
    this.armCloseTimer(event, "echoing the app's close");
  }

  // The close handshake's bound, in one place: whatever started the close, the
  // socket goes after this whether the peer answers or not. `because` is kept so
  // a timeout does not erase the reason for closing.
  private armCloseTimer(event: UpstreamCloseEvent, because: string): void {
    if (this.closeTimer !== null) return;
    this.closeTimer = setTimeout(() => {
      this.finish({
        ...event,
        abnormal: true,
        detail: `${because}; close handshake timed out`,
      });
    }, this.limits.closeHandshakeMs);
  }

  onSocketClose(): void {
    this.transportDied("socket closed");
  }

  onSocketError(err: unknown): void {
    this.transportDied(`socket error: ${String(err).slice(0, 120)}`);
  }

  // The transport ended. ONE rule for both signals that can bring that news, so
  // the two cannot drift into disagreeing about what a half-finished close means.
  //
  // Reaching here at all means the connection was not already finished, and that
  // narrows things sharply:
  //
  //   - an echo still OWED (finalizeWhenFlushed) is the app-initiated case: its
  //     close arrived, ours was queued, and the socket died before those bytes
  //     could leave. The handshake did not complete. The peer's code and reason
  //     are still the truth about WHY, so they are kept - but calling this clean
  //     would make a peer that vanishes mid-goodbye look exactly like one that
  //     completed the exchange, which is the same false-clean error in the
  //     opposite direction from the one fixed last round.
  //   - a pending close of OUR OWN with nothing owed back is the other direction:
  //     we said goodbye and the peer never answered.
  //   - neither: nothing was exchanged at all, so there is no code to report.
  //
  // The completed-handshake cases never arrive here: both of them call finish()
  // at the moment they complete - when the peer answers our close, and when the
  // echo's last byte leaves - so a later transport signal is idempotently ignored.
  private transportDied(cause: string): void {
    const owedEcho = this.finalizeWhenFlushed;
    if (owedEcho !== null) {
      this.finish({
        ...owedEcho,
        abnormal: true,
        detail: withCause(
          owedEcho.detail,
          `${cause} before the close echo was sent`,
        ),
      });
      return;
    }
    const ours = this.pendingClose;
    if (ours !== null) {
      this.finish({
        ...ours,
        abnormal: true,
        detail: withCause(
          ours.detail,
          `${cause} before the close handshake completed`,
        ),
      });
      return;
    }
    this.finish({
      code: null,
      reason: "",
      abnormal: true,
      detail: `${cause} without a close frame`,
    });
  }

  // THE one exit. Every path - a close frame either way, a timeout, a socket
  // error, a protocol error, a terminate - ends here, exactly once: the timer is
  // cleared, the queue dropped, the socket ended, and the handler called a
  // single time. A relay whose accounting can be released twice is a relay whose
  // permits drift, so "exactly once" is enforced here rather than remembered at
  // each call site.
  private finish(event: UpstreamCloseEvent): void {
    if (this.finished) return;
    this.finished = true;
    this.state = "closed";
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.finalizeWhenFlushed = null;
    this.queue = [];
    this.queuedBytesValue = 0;
    try {
      this.socket.end();
    } catch {
      // Already gone; nothing to do.
    }
    this.handlers.onClose(event);
  }
}

// --- dialing ----------------------------------------------------------------

// Connect, upgrade, and hand back a live connection - or a failure that the
// relay can turn into an HTTP status, because none of this has happened behind a
// 101 yet. That ordering is deliberate and it is what makes an unreachable app a
// clean 502 instead of a WebSocket that opens and immediately dies.
export async function dialAppUpstream(
  opts: AppUpstreamOptions,
): Promise<DialResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const key = randomBytes(16).toString("base64");
  const request = buildHandshakeRequest({
    target: opts.target,
    host: opts.host,
    key,
    protocols: opts.protocols,
    headers: opts.headers,
  });
  if (request === null) {
    return {
      ok: false,
      failure: "bad_request",
      detail: "refusing to build an upgrade request from these values",
    };
  }
  if (request.length > limits.handshakeMaxRequestBytes) {
    return {
      ok: false,
      failure: "bad_request",
      detail: `upgrade request of ${request.length} bytes is over the ceiling`,
    };
  }
  const expectedAccept = handshakeAccept(key);

  // Handshake state, owned by the closure: the socket's handlers are fixed at
  // connect time, so "which phase are we in" lives here rather than in swapped
  // callbacks.
  let head = EMPTY;
  let connection: AppUpstream | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The socket, as soon as anything has one. Held so the timeout can hang up on
  // a connect that never completes - the case the timer exists for and the one
  // where no handler has fired yet.
  let socketRef: Socket<undefined> | null = null;
  // The part of the request the socket would not take yet. Raw TCP writes are
  // partial (that is why this module exists), and a truncated upgrade request
  // would leave the app waiting for headers that never arrive.
  let requestTail: Buffer | null = null;

  return await new Promise<DialResult>((resolve) => {
    const settle = (result: DialResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve(result);
    };

    // A dial that has already failed may still get callbacks: the timeout can
    // fire before connect completes, and then `open` arrives anyway. Writing the
    // request at that point would start an upgrade nobody is waiting for, and a
    // 101 after it would construct a live connection and call the caller's
    // handlers AFTER the caller was told the dial failed. So every late callback
    // hangs up and does nothing.
    const abandoned = (socket?: Socket<undefined>): boolean => {
      if (!settled || connection !== null) return false;
      try {
        socket?.end();
      } catch {
        // already gone
      }
      return true;
    };

    const failHandshake = (
      failure: DialFailure,
      detail: string,
      socket?: Socket<undefined>,
    ): void => {
      // SETTLE FIRST, then hang up. `socket.end()` runs the close handler
      // SYNCHRONOUSLY (measured), and that handler reports its own generic
      // failure - so ending the socket first let "the app closed during the
      // upgrade" overwrite every specific diagnosis this function exists to
      // produce, for every rejection path at once.
      settle({ ok: false, failure, detail });
      try {
        socket?.end();
      } catch {
        // already gone
      }
    };

    // ONE budget for the whole upgrade - the TCP connect, the request, and the
    // response headers - which means it has to start before connect() rather
    // than in `open`. A connect that never completes is otherwise unbounded, and
    // that is the case with no handler to notice it.
    timer = setTimeout(() => {
      failHandshake(
        "handshake_timeout",
        "no upgrade response within the handshake budget",
        socketRef ?? undefined,
      );
    }, limits.handshakeTimeoutMs);

    // Write as much of the request as the socket takes, keeping the rest for
    // `drain`. A short write here is unlikely on loopback with a small request,
    // which is precisely why it would be a rare and baffling failure if ignored.
    const writeRequest = (socket: Socket<undefined>, bytes: Buffer): void => {
      let written: number;
      try {
        written = socket.write(bytes);
      } catch (err) {
        failHandshake(
          "connect_failed",
          `writing the upgrade request failed: ${String(err).slice(0, 120)}`,
          socket,
        );
        return;
      }
      requestTail = written >= bytes.length ? null : bytes.subarray(written);
    };

    void (opts.connector ?? connect)({
      hostname: "127.0.0.1",
      port: opts.port,
      socket: {
        open(socket) {
          socketRef = socket;
          if (abandoned(socket)) return;
          writeRequest(socket, request);
        },
        data(socket, chunk) {
          if (connection !== null) {
            connection.receive(Buffer.from(chunk));
            return;
          }
          if (abandoned(socket)) return;
          // --- 4. PHASE BOUNDARY. The response is not even looked at until our
          // request has left in full. A peer that answers early - it has seen the
          // key by then, so it can produce a valid-looking 101 - would otherwise
          // get a connection published while HTTP bytes were still queued behind
          // it, and the next drain would write the tail of an HTTP request into
          // what is now a WebSocket stream. A real server cannot answer before it
          // has the terminator, so this only ever refuses something broken.
          if (requestTail !== null) {
            failHandshake(
              "handshake_invalid",
              "app answered before the upgrade request had been fully sent",
              socket,
            );
            return;
          }
          head =
            head.length === 0
              ? Buffer.from(chunk)
              : Buffer.concat([head, Buffer.from(chunk)]);
          const end = head.indexOf("\r\n\r\n");
          if (end === -1) {
            // Still reading headers - but not forever.
            if (head.length > limits.handshakeMaxHeaderBytes) {
              failHandshake(
                "handshake_invalid",
                "upgrade response headers over the byte ceiling",
                socket,
              );
            }
            return;
          }
          // The ceiling applies to the HEADER BLOCK, not to "how long we waited
          // for a terminator". A single read carrying a complete 20KB block plus
          // its terminator is over the limit just as much as 20KB with no
          // terminator yet, and checking only the second case would let the whole
          // thing through - and would then parse it.
          if (end + 4 > limits.handshakeMaxHeaderBytes) {
            failHandshake(
              "handshake_invalid",
              "upgrade response headers over the byte ceiling",
              socket,
            );
            return;
          }
          const check = checkHandshakeResponse(
            head.subarray(0, end).toString("latin1"),
            expectedAccept,
            opts.protocols,
          );
          if (!check.ok) {
            failHandshake(HANDSHAKE_FAILURES[check.kind], check.detail, socket);
            return;
          }
          // Frame bytes can share the read that ended the headers, and dropping
          // them would lose an app's first message - which for a server that
          // greets on connect is the only one that matters.
          const leftover = Buffer.from(head.subarray(end + 4));
          head = EMPTY;
          const opened = new AppUpstream({
            socket,
            limits,
            // Wrapped rather than passed by reference: a bare method reference
            // would carry whatever `this` the caller's object had, and this
            // connection calls them for the life of the socket.
            handlers: {
              onMessage: (message) => opts.onMessage(message),
              onClose: (event) => opts.onClose(event),
            },
            protocol: check.protocol,
            leftover,
          });
          // PUBLISH, SETTLE, THEN parse the leftover bytes - in that order. Those
          // bytes can be a close frame or a violation, and handling one ends the
          // connection synchronously; if that happened before `connection` were
          // visible to the socket handlers, the close handler would report
          // "closed during the upgrade" and overwrite the successful handshake we
          // are settling here.
          connection = opened;
          settle({ ok: true, connection: opened });
          opened.begin();
        },
        drain(socket) {
          if (abandoned(socket)) return;
          // The request may still be going out; the connection does not exist
          // until it has.
          if (requestTail !== null) {
            const tail = requestTail;
            requestTail = null;
            writeRequest(socket, tail);
            return;
          }
          connection?.onDrain();
        },
        close() {
          if (connection !== null) {
            connection.onSocketClose();
            return;
          }
          failHandshake(
            "handshake_invalid",
            "app closed the connection during the upgrade",
          );
        },
        error(_socket, err) {
          if (connection !== null) {
            connection.onSocketError(err);
            return;
          }
          failHandshake(
            "connect_failed",
            `socket error: ${String(err).slice(0, 120)}`,
          );
        },
      },
    }).catch((err: unknown) => {
      // A refused port rejects here rather than reaching the error handler
      // (measured: ECONNREFUSED). This is the ordinary "the app is not
      // listening" case, and the relay turns it into a refusal the browser can
      // read.
      settle({
        ok: false,
        failure: "connect_failed",
        detail: `connect failed: ${String(err).slice(0, 120)}`,
      });
    });
  });
}
