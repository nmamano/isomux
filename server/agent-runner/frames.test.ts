import { describe, expect, it } from "bun:test";
import {
  createFrameDecoder,
  encodeData,
  encodeFrame,
  encodeJson,
  FRAME_JSON,
  FRAME_STDOUT,
  MAX_FRAME_BYTES,
} from "./frames.ts";

describe("agent runner frames", () => {
  it("round-trips frames that arrive split and coalesced", () => {
    const bytes = Buffer.concat([
      encodeJson({ op: "info" }),
      encodeFrame(FRAME_STDOUT, Buffer.from("hello")),
    ]);
    const decode = createFrameDecoder();
    const frames = [];
    // One byte at a time, then the rest in one chunk.
    for (const byte of bytes.subarray(0, 7))
      frames.push(...decode(Uint8Array.of(byte)));
    frames.push(...decode(bytes.subarray(7)));
    expect(frames.map((f) => f.type)).toEqual([FRAME_JSON, FRAME_STDOUT]);
    expect(JSON.parse(frames[0].payload.toString())).toEqual({ op: "info" });
    expect(frames[1].payload.toString()).toBe("hello");
  });

  it("keeps a frame cut off mid-way pending instead of emitting it", () => {
    const frame = encodeFrame(FRAME_STDOUT, Buffer.from("partial"));
    const decode = createFrameDecoder();
    expect(decode(frame.subarray(0, frame.length - 1))).toEqual([]);
  });

  it("splits a byte stream larger than one frame", () => {
    const data = Buffer.alloc(MAX_FRAME_BYTES * 2 + 10, 7);
    const frames = encodeData(FRAME_STDOUT, data);
    expect(frames.length).toBe(3);
    const decode = createFrameDecoder();
    const decoded = frames.flatMap((f) => decode(f));
    expect(Buffer.concat(decoded.map((f) => f.payload)).equals(data)).toBe(
      true,
    );
  });

  it("refuses a bad length or an unknown type", () => {
    const zero = Buffer.alloc(5);
    expect(() => createFrameDecoder()(zero)).toThrow();
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => createFrameDecoder()(huge)).toThrow();
    const unknown = encodeFrame(FRAME_STDOUT, Buffer.from("x"));
    unknown[4] = 9;
    expect(() => createFrameDecoder()(unknown)).toThrow();
    expect(() =>
      encodeFrame(FRAME_STDOUT, Buffer.alloc(MAX_FRAME_BYTES)),
    ).toThrow();
  });
});
