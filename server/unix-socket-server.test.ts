import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readPeerCredentials,
  socketFileDescriptor,
} from "./unix-socket-server.ts";

// Runs on Linux (SO_PEERCRED) and in the macOS workflow (LOCAL_PEERCRED): the
// admin socket refuses the server's uid only if this read is right.

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("readPeerCredentials", () => {
  it("reads the uid and pid of a real Unix-socket peer", async () => {
    dir = mkdtempSync(join(tmpdir(), "unix-peer-"));
    const path = join(dir, "peer.sock");
    let resolvePeer!: (peer: { pid: number; uid: number } | null) => void;
    const peer = new Promise<{ pid: number; uid: number } | null>(
      (resolve) => (resolvePeer = resolve),
    );
    const server = Bun.listen({
      unix: path,
      socket: {
        open: (socket) => {
          const fd = socketFileDescriptor(socket);
          resolvePeer(fd === null ? null : readPeerCredentials(fd));
          socket.end();
        },
        data: () => {},
      },
    });
    try {
      const client = await Bun.connect({
        unix: path,
        socket: { data: () => {} },
      });
      expect(await peer).toEqual({
        pid: process.pid,
        uid: process.getuid!(),
      });
      client.end();
    } finally {
      server.stop(true);
    }
  });
});
