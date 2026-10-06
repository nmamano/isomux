// Share modes in split mode (design section 3.1.1): the setgid bit must
// survive an explicit chmod, and the authority socket opens to the group.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpenCodeAuthorityBroker } from "../backends/opencode/authority-broker.ts";
import { chmodShare } from "./share-mode.ts";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const mode = (path: string) => statSync(path).mode & 0o7777;

describe("share modes", () => {
  it("sets a mode with the setgid bit and a plain mode", () => {
    root = mkdtempSync(join(tmpdir(), "share-mode-"));
    chmodShare(root, 0o2750);
    expect(mode(root)).toBe(0o2750);
    chmodShare(root, 0o700);
    expect(mode(root)).toBe(0o700);
  });

  it("gives the split broker a setgid directory and a group socket", () => {
    root = mkdtempSync(join(tmpdir(), "share-mode-"));
    const socketPath = join(root, "authority", "authority.sock");
    const broker = new OpenCodeAuthorityBroker(
      socketPath,
      process.getuid!() + 1,
      "http://127.0.0.1:9",
      undefined,
      true,
    );
    try {
      broker.bind("agent-1", "token").unbind();
      expect(mode(join(root, "authority"))).toBe(0o2750);
      expect(mode(socketPath)).toBe(0o660);
    } finally {
      broker.close();
    }
  });
});
