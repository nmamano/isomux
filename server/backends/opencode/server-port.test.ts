import { describe, expect, it } from "bun:test";
import { parseOpenCodeServerPort } from "./server-port.ts";

describe("OpenCode startup address", () => {
  it("reads a complete loopback listening line amid other output", () => {
    expect(parseOpenCodeServerPort(
      "diagnostic output\nopencode server listening on http://127.0.0.1:34567\nmore output\n",
    )).toBe(34567);
    expect(parseOpenCodeServerPort(
      "opencode server listening on http://127.0.0.1:65535\r\n",
    )).toBe(65535);
  });

  it.each([
    "opencode server listening on http://127.0.0.1:34567",
    "opencode server listening on http://localhost:34567\n",
    "opencode server listening on http://0.0.0.0:34567\n",
    "opencode server listening on http://127.0.0.1:0\n",
    "opencode server listening on http://127.0.0.1:65536\n",
    "opencode server listening on http://127.0.0.1:34567/path\n",
    "opencode server listening on http://127.0.0.1:34567 trailing\n",
    "prefix opencode server listening on http://127.0.0.1:34567\n",
    "opencode server listening on http://127.0.0.1:12.5\n",
  ])("ignores an incomplete or invalid address: %j", (output) => {
    expect(parseOpenCodeServerPort(output)).toBeNull();
  });
});
