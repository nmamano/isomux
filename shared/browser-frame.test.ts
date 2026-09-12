import { expect, test } from "bun:test";
import { encodeBrowserFrame, decodeBrowserFrame } from "./browser-frame.ts";

const frame = { agentId: "agent-é", generation: 2 ** 32 + 9, width: 1280, height: 800, jpeg: new Uint8Array([255, 216, 12, 255, 217]) };
test("binary frame is self-contained, big-endian and accepts unaligned views", () => {
  const encoded = encodeBrowserFrame(frame);
  expect([...encoded.slice(0, 8)]).toEqual([73, 83, 77, 88, 1, 1, 0, 8]);
  const unaligned = new Uint8Array(encoded.length + 1);
  unaligned.set(encoded, 1);
  expect(decodeBrowserFrame(unaligned.subarray(1))).toEqual(frame);
});
test("rejects truncated identities, payloads, foreign binary protocols and versions", () => {
  const encoded = encodeBrowserFrame(frame);
  for (let n = 0; n < encoded.length; n++) expect(decodeBrowserFrame(encoded.slice(0, n))).toBeNull();
  for (const offset of [0, 4, 5, 6, 7, 24]) {
    const bad = encoded.slice(); bad[offset] ^= 2;
    expect(decodeBrowserFrame(bad)).toBeNull();
  }
  const badId = encoded.slice(); badId[28] = 255;
  expect(decodeBrowserFrame(badId)).toBeNull();
  const badGeneration = encoded.slice(); new DataView(badGeneration.buffer).setFloat64(8, NaN);
  expect(decodeBrowserFrame(badGeneration)).toBeNull();
});
