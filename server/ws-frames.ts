// WebSocket frame codec for the app relay (phase 3, slice 6a).
//
// The relay behind app hostnames needs to speak WebSocket to an app on
// loopback. Bun has a WebSocket client, and slice 6's plan started with it -
// but it buffers writes with no observable bound: `bufferedAmount` reads 0 no
// matter what, and 120MB of sends to an app that had stopped reading grew the
// process to 211MB RSS with nothing to notice it by (measured, Bun 1.3.11). The
// office is a single process holding every agent's state, so an app that stops
// reading must not be able to grow it. A raw TCP socket, by contrast, reports
// exactly what we need: `write()` returns a short count or zero when the peer
// is not draining, keeps nothing of its own, and calls `drain` when the peer
// resumes. That is why this file exists - not because hand-rolling a protocol
// is fun, but because it is the only version of this relay whose memory can be
// stated.
//
// So: this is deliberately NOT a WebSocket library. It is the exact slice of
// RFC 6455 a relay needs, in the one direction a relay needs it -
// client-to-server writes (masked, as a client must) and server-to-client
// reads. No extensions, no compression, no autobahn ambitions.
//
// THE APP IS UNTRUSTED INPUT HERE. An app is code the office runs, which is a
// long way from code the office should let write its parser's arithmetic: an
// agent wrote it in a scratch directory, and it may be malicious or simply
// broken in the way a half-finished server is. So every length is checked
// against the cap BEFORE anything is allocated for it, a 64-bit length is
// compared as a BigInt so no value can round its way past a limit, and a
// protocol violation ends the connection with a code instead of being guessed
// at. Nothing here allocates in proportion to a number the app chose.
//
// The decoder is a state machine over a byte stream because that is what TCP
// hands you: a frame arrives split across three reads, or three frames arrive
// in one read, or the handshake's last byte and a frame's first byte arrive
// together. Its tests split a fixed corpus at every byte boundary for exactly
// that reason.

import { randomBytes } from "crypto";

// --- the wire ---------------------------------------------------------------

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

// A control frame's payload cannot be fragmented and cannot exceed 125 bytes
// (RFC 6455 section 5.5), which is also what bounds a close reason.
export const MAX_CONTROL_PAYLOAD_BYTES = 125;

// A close frame's reason, in BYTES rather than characters. The frame carries a
// 2-byte code first, so 125 - 2 is what is left for the reason.
export const MAX_CLOSE_REASON_BYTES = MAX_CONTROL_PAYLOAD_BYTES - 2;

// The largest header a frame can have: 2 bytes of framing, 8 for a 64-bit
// length, 4 for a mask. Used to bound the parser's own scratch buffer.
export const MAX_FRAME_HEADER_BYTES = 14;

// --- close codes ------------------------------------------------------------

// Close codes that may legitimately appear on the wire. Everything outside this
// set is either reserved for a local condition that cannot be transmitted
// (1005 no-status, 1006 abnormal, 1015 TLS failure), unassigned, or outside the
// grammar - and a peer sending one is making a protocol error rather than
// telling us something.
//
// The same set governs both directions, which is the point: it is what the
// decoder accepts from an app and what the relay is allowed to pass to a
// browser, so the two cannot drift into disagreeing about what a valid close is.
const TRANSMITTABLE_CLOSE_CODES = new Set([
  1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
]);

export function isTransmittableCloseCode(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (TRANSMITTABLE_CLOSE_CODES.has(code)) return true;
  // 3000-3999 registered by libraries, 4000-4999 private use. Both are
  // application territory and pass through untouched.
  return code >= 3000 && code <= 4999;
}

// A close reason, cut to fit a control frame WITHOUT splitting a character.
// Bun truncates a too-long reason silently at 123 bytes (measured), which can
// land mid-sequence and put invalid UTF-8 on the wire; a peer validating the
// reason is then entitled to answer 1007. Cutting on a code-point boundary
// means the worst case is a shorter message, not a malformed one.
export function truncateCloseReason(reason: string): string {
  const bytes = Buffer.from(reason, "utf8");
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  // Walk back off any continuation byte (10xxxxxx) so the cut lands where a
  // character starts.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

// --- encoding ---------------------------------------------------------------

// A client's frames MUST be masked (RFC 6455 section 5.3), and the mask has to
// be unpredictable: it exists so a hostile page cannot steer the plaintext of
// bytes an intermediary might interpret. `randomBytes` rather than Math.random
// for that reason, per frame.
function maskingKey(): Buffer {
  return randomBytes(4);
}

// One complete frame, masked, ready to write. The payload is COPIED before it
// is masked: the caller's buffer may be Bun's own inbound frame from the
// browser, and masking in place would corrupt the very bytes we are relaying.
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = maskingKey();
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 0x10000) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  // FIN always set: the relay never fragments what it sends. A message it
  // received whole goes out whole, which keeps the sender's framing intact for
  // anything that cares and keeps this encoder free of fragmentation state.
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
}

export function encodeBinaryFrame(data: Buffer): Buffer {
  return encodeFrame(OPCODE_BINARY, data);
}

export function encodePingFrame(payload: Buffer): Buffer {
  return encodeFrame(OPCODE_PING, payload);
}

// A ping's payload must come back verbatim in the pong (RFC 6455 section
// 5.5.3), because that is what makes a pong attributable to the ping that
// asked for it.
export function encodePongFrame(payload: Buffer): Buffer {
  return encodeFrame(OPCODE_PONG, payload);
}

// A close frame. `code === null` sends an EMPTY payload, which is how "closing,
// no status" is expressed on the wire - the 1005 that cannot be sent as a
// number. The reason is dropped with it, since a reason cannot be sent without
// a code.
export function encodeCloseFrame(code: number | null, reason = ""): Buffer {
  if (code === null) return encodeFrame(OPCODE_CLOSE, Buffer.alloc(0));
  const reasonBytes = Buffer.from(truncateCloseReason(reason), "utf8");
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(OPCODE_CLOSE, payload);
}

// --- decoding ---------------------------------------------------------------

export type DecodedMessage =
  // Text arrives validated: a decoder that handed back replacement characters
  // would be silently rewriting an app's bytes.
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "ping"; payload: Buffer }
  | { kind: "pong"; payload: Buffer }
  // `code === null` is a close with no status - the wire form of 1005.
  | { kind: "close"; code: number | null; reason: string };

// A protocol failure, carrying the close code the connection should end with.
// 1002 protocol error, 1007 invalid payload data, 1009 message too big: the
// three RFC codes a relay's parser can honestly produce.
export interface DecodeFailure {
  code: 1002 | 1007 | 1009;
  detail: string;
}

// What the decoder does with each message it completes. Returning "stop" leaves
// the rest of the buffered bytes unparsed - the caller is closing and nothing
// further concerns it.
export type DeliverMessage = (message: DecodedMessage) => "continue" | "stop";

export type DecodeResult =
  | { ok: true; stopped: boolean }
  | { ok: false; failure: DecodeFailure };

// Strict UTF-8. `Buffer.toString("utf8")` substitutes U+FFFD for anything
// malformed, which would turn an app's broken frame into text that looks fine;
// `fatal` makes it an error, which is what the RFC asks for (1007).
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

export interface FrameDecoderOptions {
  // The largest complete message this decoder will assemble, in payload bytes,
  // applied to a single frame AND to the running total of a fragmented
  // sequence. Exceeding it fails with 1009 the moment the length is known -
  // before any buffer is sized for it.
  maxMessageBytes: number;
}

// A streaming decoder for the server-to-client direction.
//
// Two pieces of state, and they are the whole design: `buffer` is the bytes that
// have arrived but not yet formed a frame, and `fragments` is the message being
// assembled across frames. Both are bounded - the first by one frame's header
// plus one message, the second by the message cap - so a peer that sends a
// header and then stops, or fragments forever, cannot grow the process.
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;
  private failed = false;
  private readonly maxMessageBytes: number;

  constructor(opts: FrameDecoderOptions) {
    this.maxMessageBytes = opts.maxMessageBytes;
  }

  // Bytes buffered but not yet decoded, plus whatever a partial message is
  // holding. The relay writes its memory bound in terms of this.
  pendingBytes(): number {
    return this.buffer.length + this.fragmentBytes;
  }

  // Feed one TCP read, delivering each complete message AS IT IS DECODED.
  //
  // Delivery is a callback rather than a returned array for a memory reason, not
  // a stylistic one: one read can contain hundreds of frames, and returning them
  // together would mean every message in that read is retained at once - a
  // multiple of the chunk that no accounting here would show. Handing each one
  // over and forgetting it keeps exactly one decoded message in hand, which is
  // the number the relay's stated bound is written around.
  //
  // After a failure the decoder is spent: it refuses further input rather than
  // continuing to parse a stream it has already declared broken.
  push(chunk: Buffer, deliver: DeliverMessage): DecodeResult {
    if (this.failed) {
      return { ok: false, failure: { code: 1002, detail: "decoder is spent" } };
    }
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const step = this.readFrame();
      if (step === null) break; // need more bytes
      if (!step.ok) {
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentBytes = 0;
        return step;
      }
      if (step.message === null) continue; // a fragment, not yet a message
      if (deliver(step.message) === "stop") return { ok: true, stopped: true };
    }
    return { ok: true, stopped: false };
  }

  // One frame, or null when the buffer does not hold a whole one yet. A frame
  // that completes no message (a fragment that is not the last) returns a null
  // message.
  private readFrame():
    | { ok: true; message: DecodedMessage | null }
    | { ok: false; failure: DecodeFailure }
    | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    // RSV1-3 are extension territory, and this client negotiates no
    // extensions, so any of them set means the peer is speaking something we
    // never agreed to.
    if ((first & 0x70) !== 0) {
      return fail(1002, "reserved bits set with no extension negotiated");
    }
    const opcode = first & 0x0f;
    // A server never masks (RFC 6455 section 5.1). Accepting a masked frame
    // would mean guessing at which of us is confused.
    if ((second & 0x80) !== 0) {
      return fail(1002, "server frame is masked");
    }

    let payloadLength = second & 0x7f;
    let offset = 2;
    if (payloadLength === 126) {
      if (buf.length < 4) return null;
      payloadLength = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buf.length < 10) return null;
      // As a BigInt, compared as a BigInt: a 64-bit length converted to a
      // Number first can lose precision above 2^53 and compare as something it
      // is not.
      const big = buf.readBigUInt64BE(2);
      // STRUCTURE BEFORE SIZE. The RFC requires the most significant bit of a
      // 64-bit length to be zero, so a frame with it set is malformed - 1002 -
      // and not merely too big. Comparing against the cap first would classify
      // every such frame as 1009, which tells a peer its message was large when
      // the real answer is that its framing is wrong.
      if ((big & (1n << 63n)) !== 0n) {
        return fail(1002, "64-bit length with the high bit set");
      }
      if (big > BigInt(this.maxMessageBytes)) {
        return fail(1009, `frame length ${big} over the message cap`);
      }
      payloadLength = Number(big);
      offset = 10;
    }
    // Non-minimal length encodings (a 16-bit form holding 40) are accepted:
    // the value is bounded either way, and refusing them would break an app
    // over a detail no browser enforces.

    const isControl = (opcode & 0x8) !== 0;
    if (isControl) {
      // Control frames cannot be fragmented and cannot be large - they are
      // allowed to arrive BETWEEN the fragments of a data message, which is
      // exactly why they must be small and self-contained.
      if (!fin) return fail(1002, "fragmented control frame");
      if (payloadLength > MAX_CONTROL_PAYLOAD_BYTES) {
        return fail(1002, "control frame payload over 125 bytes");
      }
    } else if (payloadLength > this.maxMessageBytes) {
      return fail(1009, `frame length ${payloadLength} over the message cap`);
    } else if (
      opcode === OPCODE_CONTINUATION &&
      this.fragmentOpcode !== null &&
      this.fragmentBytes + payloadLength > this.maxMessageBytes
    ) {
      // THE AGGREGATE CAP, CHECKED FROM THE HEADER. Waiting for the payload
      // first would mean buffering it to find out we do not want it: with a
      // near-cap message already retained, a continuation whose own length is
      // individually legal could still take the total to nearly twice the cap
      // before anything objected. The claim is refused as soon as it is
      // readable, so nothing is ever buffered on account of it.
      return fail(
        1009,
        `fragmented message would reach ${this.fragmentBytes + payloadLength} bytes, over the cap`,
      );
    }

    if (buf.length < offset + payloadLength) return null;
    const payload = buf.subarray(offset, offset + payloadLength);
    this.buffer = buf.subarray(offset + payloadLength);

    switch (opcode) {
      case OPCODE_PING:
        return { ok: true, message: { kind: "ping", payload: copy(payload) } };
      case OPCODE_PONG:
        return { ok: true, message: { kind: "pong", payload: copy(payload) } };
      case OPCODE_CLOSE:
        return this.readClose(payload);
      case OPCODE_CONTINUATION:
        return this.readContinuation(payload, fin);
      case OPCODE_TEXT:
      case OPCODE_BINARY:
        return this.readDataStart(opcode, payload, fin);
      default:
        return fail(1002, `unknown opcode ${opcode}`);
    }
  }

  private readClose(
    payload: Buffer,
  ):
    | { ok: true; message: DecodedMessage }
    | { ok: false; failure: DecodeFailure } {
    if (payload.length === 0) {
      return { ok: true, message: { kind: "close", code: null, reason: "" } };
    }
    // One byte cannot be a code, and there is no other thing it could be.
    if (payload.length === 1) return fail(1002, "close payload of one byte");
    const code = payload.readUInt16BE(0);
    if (!isTransmittableCloseCode(code)) {
      return fail(1002, `close code ${code} is not transmittable`);
    }
    const reason = decodeUtf8(payload.subarray(2));
    if (reason === null) return fail(1007, "close reason is not valid UTF-8");
    return { ok: true, message: { kind: "close", code, reason } };
  }

  private readDataStart(
    opcode: number,
    payload: Buffer,
    fin: boolean,
  ):
    | { ok: true; message: DecodedMessage | null }
    | { ok: false; failure: DecodeFailure } {
    if (this.fragmentOpcode !== null) {
      return fail(1002, "new data frame while a message is unfinished");
    }
    if (fin) return this.completeMessage(opcode, copy(payload));
    this.fragmentOpcode = opcode;
    this.fragments = [copy(payload)];
    this.fragmentBytes = payload.length;
    return { ok: true, message: null };
  }

  private readContinuation(
    payload: Buffer,
    fin: boolean,
  ):
    | { ok: true; message: DecodedMessage | null }
    | { ok: false; failure: DecodeFailure } {
    if (this.fragmentOpcode === null) {
      return fail(1002, "continuation with no message in progress");
    }
    // No aggregate check here: readFrame refuses an over-cap total from the
    // continuation's HEADER, before this payload was ever buffered. Repeating it
    // here would be a branch that cannot be reached and cannot be tested.
    this.fragments.push(copy(payload));
    this.fragmentBytes += payload.length;
    if (!fin) return { ok: true, message: null };
    const opcode = this.fragmentOpcode;
    const whole = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    return this.completeMessage(opcode, whole);
  }

  private completeMessage(
    opcode: number,
    payload: Buffer,
  ):
    | { ok: true; message: DecodedMessage }
    | { ok: false; failure: DecodeFailure } {
    if (opcode === OPCODE_TEXT) {
      const text = decodeUtf8(payload);
      if (text === null) return fail(1007, "text frame is not valid UTF-8");
      return { ok: true, message: { kind: "text", text } };
    }
    return { ok: true, message: { kind: "binary", data: payload } };
  }
}

// A frame's payload is a VIEW into the read buffer, and the read buffer is
// reused and re-sliced as more bytes arrive. Anything kept past this turn is
// copied, so a message handed to the relay can never change under it.
function copy(view: Buffer): Buffer {
  return Buffer.from(view);
}

function fail(
  code: DecodeFailure["code"],
  detail: string,
): { ok: false; failure: DecodeFailure } {
  return { ok: false, failure: { code, detail } };
}
