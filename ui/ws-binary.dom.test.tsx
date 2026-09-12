import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const ws = await import("./ws.ts");

it("binary messages bypass text consumers and the store, including on an obsolete socket", () => {
  const original = globalThis.WebSocket;
  const sockets: Array<{
    binaryType: string;
    onmessage?: (e: { data: unknown }) => void;
    close: () => void;
  }> = [];
  globalThis.WebSocket = class {
    binaryType = "blob";
    close() {}
    constructor() {
      sockets.push(this);
    }
  } as unknown as typeof WebSocket;
  const text: string[] = [],
    binary: ArrayBuffer[] = [],
    state: unknown[] = [];
  const onText = (s: string) => text.push(s),
    onBinary = (b: ArrayBuffer) => binary.push(b);
  ws.setShim(null);
  ws.addRawListener(onText);
  ws.addBinaryListener(onBinary);
  try {
    ws.connect((m) => state.push(m));
    expect(sockets[0].binaryType).toBe("arraybuffer");
    const bytes = new ArrayBuffer(4);
    sockets[0].onmessage?.({ data: bytes });
    expect(binary).toEqual([bytes]);
    expect(text).toEqual([]);
    expect(state).toEqual([]);
    for (const type of [
      "log_entry",
      "terminal_output",
      "api_token_log_entry",
    ]) {
      const data = JSON.stringify({ type });
      sockets[0].onmessage?.({ data });
      expect(text.at(-1)).toBe(data);
      expect(state.at(-1)).toEqual({ type });
    }
    ws.connect((m) => state.push(m));
    sockets[0].onmessage?.({ data: bytes });
    expect(binary).toHaveLength(1);
    sockets[1].onmessage?.({ data: bytes });
    expect(binary).toHaveLength(2);
  } finally {
    ws.removeRawListener(onText);
    ws.removeBinaryListener(onBinary);
    ws.setShim(() => {});
    globalThis.WebSocket = original;
  }
});
