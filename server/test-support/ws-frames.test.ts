// The frame codec (phase 3, slice 6a).
//
// The relay decodes bytes an APP wrote, and an app is code an agent produced in
// a scratch directory - so every test here is really one question: can a peer
// make the parser allocate, mis-frame, or accept something it should refuse?
// The byte-split cases exist because TCP has no idea what a frame is: the same
// stream arrives as one read on loopback and as fifty reads through anything
// real, and a parser that only works on the first shape is a parser that fails
// in production.

import { describe, it, expect } from "bun:test";
import {
  FrameDecoder,
  MAX_CLOSE_REASON_BYTES,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
  isTransmittableCloseCode,
  truncateCloseReason,
  type DecodedMessage,
  type DecodeResult,
} from "../ws-frames.ts";

// A SERVER-to-client frame: unmasked, which is the direction the decoder reads.
// Hand-built rather than taken from the encoder, so the test does not prove the
// codec self-consistent - it proves it right about the wire.
function serverFrame(
  opcode: number,
  payload: Buffer | string,
  opts: {
    fin?: boolean;
    rsv?: number;
    mask?: boolean;
    lengthForm?: 7 | 16 | 64;
  } = {},
): Buffer {
  const body =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const fin = opts.fin ?? true;
  const len = body.length;
  const form = opts.lengthForm ?? (len < 126 ? 7 : len < 0x10000 ? 16 : 64);
  const maskBit = opts.mask ? 0x80 : 0;
  let header: Buffer;
  if (form === 7) {
    header = Buffer.alloc(2);
    header[1] = maskBit | len;
  } else if (form === 16) {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode;
  if (!opts.mask) return Buffer.concat([header, body]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// A 64-bit length header whose length field is a raw value - so a length no
// buffer could hold can be put on the wire without allocating it.
function hugeLengthFrame(opcode: number, claimed: bigint): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(claimed, 2);
  return header;
}

function decoder(maxMessageBytes = 1024): FrameDecoder {
  return new FrameDecoder({ maxMessageBytes });
}

// Feed bytes and collect whatever they produced. The decoder delivers each
// message through a callback rather than returning a batch (so only one decoded
// message is ever in hand), and the tests keep asserting on lists - so the
// collection happens here, once.
function pushAll(dec: FrameDecoder, bytes: Buffer): DecodeResult {
  return dec.push(bytes, () => "continue");
}

function collect(dec: FrameDecoder, bytes: Buffer): DecodedMessage[] {
  const out: DecodedMessage[] = [];
  const result = dec.push(bytes, (message) => {
    out.push(message);
    return "continue";
  });
  if (!result.ok) throw new Error(`decode failed: ${result.failure.detail}`);
  return out;
}

describe("ws-frames: encoding", () => {
  it("masks every frame with a fresh key and round-trips the payload", () => {
    const a = encodeTextFrame("hello");
    const b = encodeTextFrame("hello");
    // Same payload, different bytes on the wire: the mask is per frame. (A
    // fixed mask would still decode, which is why this is asserted rather than
    // assumed.)
    expect(a.equals(b)).toBe(false);
    // FIN + text opcode, mask bit set, 5-byte payload.
    expect(a[0]).toBe(0x81);
    expect(a[1]).toBe(0x85);
    const mask = a.subarray(2, 6);
    const unmasked = Buffer.from(a.subarray(6));
    for (let i = 0; i < unmasked.length; i++) unmasked[i] ^= mask[i & 3];
    expect(unmasked.toString()).toBe("hello");
  });

  it("does not mutate the caller's buffer while masking", () => {
    // The relay hands this the browser's own inbound frame. Masking in place
    // would corrupt the bytes being relayed.
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const before = Buffer.from(payload);
    encodeBinaryFrame(payload);
    expect(payload.equals(before)).toBe(true);
  });

  it("uses the length form the size calls for", () => {
    expect(encodeTextFrame("x")[1] & 0x7f).toBe(1);
    expect(encodeBinaryFrame(Buffer.alloc(200))[1] & 0x7f).toBe(126);
    expect(encodeBinaryFrame(Buffer.alloc(70_000))[1] & 0x7f).toBe(127);
    // 16-bit form: the length sits in the two bytes after the framing.
    expect(encodeBinaryFrame(Buffer.alloc(200)).readUInt16BE(2)).toBe(200);
    expect(
      Number(encodeBinaryFrame(Buffer.alloc(70_000)).readBigUInt64BE(2)),
    ).toBe(70_000);
  });

  it("writes ping and pong as masked control frames", () => {
    const ping = encodePingFrame(Buffer.from("keep"));
    const pong = encodePongFrame(Buffer.from("keep"));
    expect(ping[0]).toBe(0x80 | OPCODE_PING);
    expect(pong[0]).toBe(0x80 | OPCODE_PONG);
    // Masked (a client always masks) and 4 bytes of payload.
    expect(ping[1]).toBe(0x84);
    expect(pong[1]).toBe(0x84);
    // A pong carries the ping's payload back verbatim - the whole point of
    // answering one, and the only way a peer can attribute it.
    const mask = pong.subarray(2, 6);
    const unmasked = Buffer.from(pong.subarray(6));
    for (let i = 0; i < unmasked.length; i++) unmasked[i] ^= mask[i & 3];
    expect(unmasked.toString()).toBe("keep");
  });

  it("writes a close with a code, and an empty payload for no status", () => {
    const withCode = encodeCloseFrame(4321, "bye");
    expect(withCode[1] & 0x7f).toBe(2 + 3);
    const noStatus = encodeCloseFrame(null, "ignored");
    // No code means no reason either - a reason cannot travel without one.
    expect(noStatus[1] & 0x7f).toBe(0);
  });
});

describe("ws-frames: close codes and reasons", () => {
  it("accepts only codes that may appear on the wire", () => {
    for (const code of [
      1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
      3000, 3999, 4000, 4999,
    ]) {
      expect(isTransmittableCloseCode(code)).toBe(true);
    }
    // 1004 was never assigned; 1005/1006 describe a LOCAL condition and cannot
    // be sent; 1015 is the TLS-failure code and is equally local. The rest are
    // outside the grammar.
    for (const code of [
      0,
      999,
      1004,
      1005,
      1006,
      1015,
      1016,
      2000,
      2999,
      5000,
      -1,
      1.5,
      NaN,
    ]) {
      expect(isTransmittableCloseCode(code)).toBe(false);
    }
  });

  it("truncates a reason on a code-point boundary, not a byte", () => {
    // Bun cuts a long reason blindly at 123 bytes, which can land inside a
    // multi-byte character and put invalid UTF-8 on the wire.
    const euro = "€"; // 3 bytes
    const long = euro.repeat(60); // 180 bytes
    const cut = truncateCloseReason(long);
    const bytes = Buffer.from(cut, "utf8");
    expect(bytes.length).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
    // Every character survived whole: 41 euros is 123 bytes exactly.
    expect(cut).toBe(euro.repeat(41));
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
  });

  it("leaves a reason that already fits alone, including at the boundary", () => {
    const exact = "a".repeat(MAX_CLOSE_REASON_BYTES);
    expect(truncateCloseReason(exact)).toBe(exact);
    expect(truncateCloseReason("")).toBe("");
    // One byte over, single-byte characters: the last one goes.
    const over = "a".repeat(MAX_CLOSE_REASON_BYTES + 1);
    expect(truncateCloseReason(over)).toBe(exact);
  });

  it("cuts a 4-byte character cleanly", () => {
    // An emoji is 4 bytes; a blind cut at 123 would leave one to three orphans.
    const emoji = "\u{1f600}";
    const long = emoji.repeat(40); // 160 bytes
    const cut = truncateCloseReason(long);
    expect(Buffer.from(cut, "utf8").length).toBe(120);
    expect(cut).toBe(emoji.repeat(30));
  });
});

describe("ws-frames: decoding whole frames", () => {
  it("reads text, binary, ping, pong and close", () => {
    const dec = decoder();
    const stream = Buffer.concat([
      serverFrame(OPCODE_TEXT, "hi"),
      serverFrame(OPCODE_BINARY, Buffer.from([0, 255, 7])),
      serverFrame(OPCODE_PING, "p"),
      serverFrame(OPCODE_PONG, "q"),
      serverFrame(OPCODE_CLOSE, Buffer.concat([u16(4321), Buffer.from("bye")])),
    ]);
    expect(collect(dec, stream)).toEqual([
      { kind: "text", text: "hi" },
      { kind: "binary", data: Buffer.from([0, 255, 7]) },
      { kind: "ping", payload: Buffer.from("p") },
      { kind: "pong", payload: Buffer.from("q") },
      { kind: "close", code: 4321, reason: "bye" },
    ]);
  });

  it("reads a close with no status as a null code", () => {
    const dec = decoder();
    expect(collect(dec, serverFrame(OPCODE_CLOSE, Buffer.alloc(0)))).toEqual([
      { kind: "close", code: null, reason: "" },
    ]);
  });

  it("accepts every length form, including a non-minimal one", () => {
    // A peer that writes a 40-byte payload with the 64-bit length form is being
    // wasteful, not hostile, and the value is bounded either way.
    const dec = decoder();
    const body = Buffer.alloc(40, 9);
    const got = collect(
      dec,
      Buffer.concat([
        serverFrame(OPCODE_BINARY, body, { lengthForm: 16 }),
        serverFrame(OPCODE_BINARY, body, { lengthForm: 64 }),
      ]),
    );
    expect(got).toEqual([
      { kind: "binary", data: body },
      { kind: "binary", data: body },
    ]);
  });

  it("copies payloads out of the read buffer", () => {
    // The decoder slices views out of a buffer it keeps re-slicing. A message
    // that still pointed into it could change after being handed over.
    const dec = decoder();
    const chunk = Buffer.concat([
      serverFrame(OPCODE_BINARY, Buffer.from([1, 2, 3])),
    ]);
    const got = collect(dec, chunk);
    chunk.fill(0);
    expect(got).toEqual([{ kind: "binary", data: Buffer.from([1, 2, 3]) }]);
  });
});

describe("ws-frames: fragmentation", () => {
  it("reassembles a fragmented text message", () => {
    const dec = decoder();
    const got = collect(
      dec,
      Buffer.concat([
        serverFrame(OPCODE_TEXT, "he", { fin: false }),
        serverFrame(OPCODE_CONTINUATION, "ll", { fin: false }),
        serverFrame(OPCODE_CONTINUATION, "o"),
      ]),
    );
    expect(got).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("lets a control frame interleave with the fragments", () => {
    // Legal, and the reason control frames must be small and unfragmented: a
    // ping has to be answerable while a big message is still arriving.
    const dec = decoder();
    const got = collect(
      dec,
      Buffer.concat([
        serverFrame(OPCODE_BINARY, Buffer.from([1]), { fin: false }),
        serverFrame(OPCODE_PING, "mid"),
        serverFrame(OPCODE_CONTINUATION, Buffer.from([2])),
      ]),
    );
    expect(got).toEqual([
      { kind: "ping", payload: Buffer.from("mid") },
      { kind: "binary", data: Buffer.from([1, 2]) },
    ]);
  });

  it("validates UTF-8 across the whole reassembled message, not per fragment", () => {
    // A 3-byte character split across two fragments is VALID text, and a
    // decoder that validated each fragment would reject it.
    const euro = Buffer.from("€", "utf8");
    const dec = decoder();
    const got = collect(
      dec,
      Buffer.concat([
        serverFrame(OPCODE_TEXT, euro.subarray(0, 1), { fin: false }),
        serverFrame(OPCODE_CONTINUATION, euro.subarray(1)),
      ]),
    );
    expect(got).toEqual([{ kind: "text", text: "€" }]);
  });

  it("refuses a continuation with no message in progress", () => {
    const res = pushAll(decoder(), serverFrame(OPCODE_CONTINUATION, "x"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(1002);
  });

  it("refuses a new data frame while a message is unfinished", () => {
    const res = pushAll(
      decoder(),
      Buffer.concat([
        serverFrame(OPCODE_TEXT, "a", { fin: false }),
        serverFrame(OPCODE_TEXT, "b"),
      ]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(1002);
  });
});

describe("ws-frames: refusing what a peer must not send", () => {
  const cases: { name: string; bytes: Buffer; code: 1002 | 1007 | 1009 }[] = [
    {
      name: "a reserved bit with no extension negotiated",
      bytes: serverFrame(OPCODE_TEXT, "x", { rsv: 0b100 }),
      code: 1002,
    },
    {
      name: "a masked server frame",
      bytes: serverFrame(OPCODE_TEXT, "x", { mask: true }),
      code: 1002,
    },
    {
      name: "an unknown opcode",
      bytes: serverFrame(0x3, "x"),
      code: 1002,
    },
    {
      name: "a fragmented control frame",
      bytes: serverFrame(OPCODE_PING, "x", { fin: false }),
      code: 1002,
    },
    {
      name: "a control frame over 125 bytes",
      bytes: serverFrame(OPCODE_PING, Buffer.alloc(126)),
      code: 1002,
    },
    {
      name: "a close payload of one byte",
      bytes: serverFrame(OPCODE_CLOSE, Buffer.from([3])),
      code: 1002,
    },
    {
      name: "a close code that cannot be transmitted",
      bytes: serverFrame(OPCODE_CLOSE, u16(1006)),
      code: 1002,
    },
    {
      name: "a close reason that is not UTF-8",
      bytes: serverFrame(
        OPCODE_CLOSE,
        Buffer.concat([u16(1000), Buffer.from([0xff, 0xfe])]),
      ),
      code: 1007,
    },
    {
      name: "a text frame that is not UTF-8",
      bytes: serverFrame(OPCODE_TEXT, Buffer.from([0xc3, 0x28])),
      code: 1007,
    },
    {
      name: "a lone continuation byte as text",
      bytes: serverFrame(OPCODE_TEXT, Buffer.from([0x80])),
      code: 1007,
    },
    {
      name: "a frame larger than the message cap",
      bytes: serverFrame(OPCODE_BINARY, Buffer.alloc(1025)),
      code: 1009,
    },
  ];
  for (const c of cases) {
    it(`refuses ${c.name}`, () => {
      const res = pushAll(decoder(1024), c.bytes);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure.code).toBe(c.code);
    });
  }

  it("refuses a 64-bit length over the cap without allocating for it", () => {
    // The header alone, claiming 2^62 bytes. Compared as a BigInt: converting to
    // a Number first loses precision above 2^53, and a length that compares as
    // something smaller than it is is exactly how a parser gets talked into an
    // allocation.
    const res = pushAll(
      decoder(1024),
      hugeLengthFrame(OPCODE_BINARY, 1n << 62n),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(1009);
  });

  it("calls a 64-bit length with the high bit set MALFORMED, not oversized", () => {
    // The RFC requires that bit to be zero, so this is a framing error (1002).
    // Answering 1009 would tell the peer its message was too big when the real
    // problem is that its length field is not a length at all.
    const res = pushAll(
      decoder(1024),
      hugeLengthFrame(OPCODE_BINARY, 0xffffffffffffffffn),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.code).toBe(1002);
      expect(res.failure.detail).toContain("high bit");
    }
  });

  it("still calls a structurally valid but over-cap 64-bit length oversized", () => {
    // High bit clear, so the length is well formed - it is simply far past the
    // cap, which is 1009.
    const res = pushAll(
      decoder(1024),
      hugeLengthFrame(OPCODE_BINARY, 1n << 62n),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe(1009);
  });

  it("refuses an over-cap aggregate from the continuation HEADER, before its payload", () => {
    // The bound has to bite on the CLAIM, not on the delivered bytes. With 900
    // bytes already retained under a 1024-byte cap, a continuation announcing
    // another 900 is individually legal - so a decoder that waited for the
    // payload would buffer it and only then object, holding nearly twice the cap.
    const dec = decoder(1024);
    const first = pushAll(
      dec,
      serverFrame(OPCODE_BINARY, Buffer.alloc(900), { fin: false }),
    );
    expect(first.ok).toBe(true);
    expect(dec.pendingBytes()).toBe(900);
    // ONLY the header of the continuation: 4 bytes announcing 900 more.
    const header = Buffer.alloc(4);
    header[0] = 0x80 | OPCODE_CONTINUATION;
    header[1] = 126;
    header.writeUInt16BE(900, 2);
    const second = pushAll(dec, header);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.code).toBe(1009);
      expect(second.failure.detail).toContain("over the cap");
    }
  });

  it("still accepts a fragmented message whose aggregate fits exactly", () => {
    const dec = decoder(1024);
    expect(
      collect(
        dec,
        Buffer.concat([
          serverFrame(OPCODE_BINARY, Buffer.alloc(1000, 1), { fin: false }),
          serverFrame(OPCODE_CONTINUATION, Buffer.alloc(24, 2)),
        ]),
      ),
    ).toEqual([
      {
        kind: "binary",
        data: Buffer.concat([Buffer.alloc(1000, 1), Buffer.alloc(24, 2)]),
      },
    ]);
  });

  it("refuses a fragmented message that walks past the cap in small steps", () => {
    const dec = decoder(1024);
    const first = pushAll(
      dec,
      serverFrame(OPCODE_BINARY, Buffer.alloc(600), { fin: false }),
    );
    expect(first.ok).toBe(true);
    const second = pushAll(
      dec,
      serverFrame(OPCODE_CONTINUATION, Buffer.alloc(600)),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.code).toBe(1009);
  });

  it("accepts a message exactly at the cap", () => {
    const dec = decoder(1024);
    expect(
      collect(dec, serverFrame(OPCODE_BINARY, Buffer.alloc(1024, 3))),
    ).toEqual([{ kind: "binary", data: Buffer.alloc(1024, 3) }]);
  });

  it("is spent after a failure and refuses further input", () => {
    const dec = decoder();
    expect(pushAll(dec, serverFrame(0x3, "x")).ok).toBe(false);
    // Even a perfectly good frame: the stream's framing is no longer known to be
    // where we think it is.
    const after = pushAll(dec, serverFrame(OPCODE_TEXT, "fine"));
    expect(after.ok).toBe(false);
  });
});

describe("ws-frames: TCP does not respect frame boundaries", () => {
  // One stream holding every shape that matters: short and 16-bit lengths, a
  // fragmented message, an interleaved control frame, a close at the end.
  const corpus = Buffer.concat([
    serverFrame(OPCODE_TEXT, "first"),
    serverFrame(OPCODE_BINARY, Buffer.alloc(300, 7), { lengthForm: 16 }),
    serverFrame(OPCODE_TEXT, "frag-", { fin: false }),
    serverFrame(OPCODE_PING, "mid"),
    serverFrame(OPCODE_CONTINUATION, "ment"),
    serverFrame(OPCODE_CLOSE, Buffer.concat([u16(1001), Buffer.from("done")])),
  ]);
  const expected: DecodedMessage[] = [
    { kind: "text", text: "first" },
    { kind: "binary", data: Buffer.alloc(300, 7) },
    { kind: "ping", payload: Buffer.from("mid") },
    { kind: "text", text: "frag-ment" },
    { kind: "close", code: 1001, reason: "done" },
  ];

  it("decodes the same messages from a single read", () => {
    expect(collect(decoder(4096), corpus)).toEqual(expected);
  });

  it("decodes the same messages split at EVERY byte boundary", () => {
    for (let cut = 1; cut < corpus.length; cut++) {
      const dec = decoder(4096);
      const got: DecodedMessage[] = [];
      for (const part of [corpus.subarray(0, cut), corpus.subarray(cut)]) {
        got.push(...collect(dec, Buffer.from(part)));
      }
      expect({ cut, got }).toEqual({ cut, got: expected });
    }
  });

  it("decodes the same messages one byte at a time", () => {
    const dec = decoder(4096);
    const got: DecodedMessage[] = [];
    for (const byte of corpus) {
      got.push(...collect(dec, Buffer.from([byte])));
    }
    expect(got).toEqual(expected);
  });

  it("keeps ONE decoded message in hand, not a whole read's worth", () => {
    // 200 frames in a single chunk. Because delivery is incremental, the decoder
    // is never holding the batch: after each message is handed over, the only
    // bytes it still owns are the ones it has not parsed yet - and by the end,
    // none. A decoder that returned an array instead would be retaining all 200
    // payloads at once, which is the accounting hole this shape closes.
    const dec = decoder(4096);
    const frames: Buffer[] = [];
    for (let i = 0; i < 200; i++) {
      frames.push(serverFrame(OPCODE_BINARY, Buffer.alloc(1024, i & 0xff)));
    }
    let seen = 0;
    let peakPending = 0;
    const result = dec.push(Buffer.concat(frames), () => {
      seen++;
      peakPending = Math.max(peakPending, dec.pendingBytes());
      return "continue";
    });
    expect(result.ok).toBe(true);
    expect(seen).toBe(200);
    expect(dec.pendingBytes()).toBe(0);
    // While delivering, what is still held is only the unparsed tail - which
    // shrinks. It is bounded by the chunk, never multiplied by it.
    expect(peakPending).toBeLessThanOrEqual(200 * (1024 + 4));
  });

  it("stops parsing the moment a handler says so", () => {
    // The relay says "stop" when a message closed the connection. What is left in
    // the buffer stays accounted for rather than being parsed into messages
    // nobody will read.
    const dec = decoder(4096);
    const stream = Buffer.concat([
      serverFrame(OPCODE_TEXT, "one"),
      serverFrame(OPCODE_TEXT, "two"),
      serverFrame(OPCODE_TEXT, "three"),
    ]);
    const seen: string[] = [];
    const result = dec.push(stream, (message) => {
      if (message.kind === "text") seen.push(message.text);
      return seen.length === 2 ? "stop" : "continue";
    });
    expect(result).toEqual({ ok: true, stopped: true });
    expect(seen).toEqual(["one", "two"]);
    expect(dec.pendingBytes()).toBe(serverFrame(OPCODE_TEXT, "three").length);
  });

  it("holds no more than the bytes it has been given", () => {
    // Half of a big frame's header, then nothing: the decoder must be waiting on
    // bytes, not sizing a buffer for the length it was promised.
    const dec = decoder(1024 * 1024);
    pushAll(dec, Buffer.from([0x82, 0x7f, 0, 0, 0, 0]));
    expect(dec.pendingBytes()).toBe(6);
    // A complete but unfinished fragment is accounted too.
    const dec2 = decoder(1024 * 1024);
    pushAll(
      dec2,
      serverFrame(OPCODE_BINARY, Buffer.alloc(500), { fin: false }),
    );
    expect(dec2.pendingBytes()).toBe(500);
  });
});

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}
