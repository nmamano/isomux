import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OpenCodeAuthorityBroker,
  type OpenCodeAuthorityProcessReaders,
} from "./authority-broker.ts";
import type { ProcessHop } from "./process-identity.ts";

// These cases drive the broker's identity checks through a fake process table,
// so each check fails on its own on every host. The real-process cases are in
// authority-broker.ancestry.test.ts.

const UID = 501;
const SERVER = 100;
const SHELL = 200;
const PEER = 300;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isomux-abi-"));
  const socketPath = join(root, "private", "authority.sock");
  const upstream = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const table = new Map<number, ProcessHop>([
    [SERVER, { pid: SERVER, parentPid: 1, startTicks: "server-1" }],
    [SHELL, { pid: SHELL, parentPid: SERVER, startTicks: "shell-1" }],
    [PEER, { pid: PEER, parentPid: SHELL, startTicks: "peer-1" }],
  ]);
  const state = {
    peer: { pid: PEER, uid: UID } as { pid: number; uid: number } | null,
    accepted: 0,
    // Called for every hop read; may return a replacement hop.
    onRead: (_pid: number, hop: ProcessHop | null) => hop,
  };
  const readers: OpenCodeAuthorityProcessReaders = {
    readPeerCredentials: () => {
      state.accepted += 1;
      return state.peer;
    },
    readProcessHop: (pid) => state.onRead(pid, table.get(pid) ?? null),
  };
  const broker = new OpenCodeAuthorityBroker(
    socketPath,
    UID,
    `http://127.0.0.1:${upstream.port}`,
    readers,
  );
  cleanup.push(async () => {
    broker.close();
    await upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  const handle = broker.bind("agent-b", "token-b").activate(SERVER);
  return { socketPath, table, state, handle };
}

// Connects, waits until the broker has accepted the connection, runs
// afterAccept, and only then sends the request.
async function request(
  f: ReturnType<typeof fixture>,
  afterAccept: () => void = () => {},
): Promise<number> {
  const acceptedBefore = f.state.accepted;
  return await new Promise<number>((resolve, reject) => {
    let text = "";
    void Bun.connect({
      unix: f.socketPath,
      socket: {
        async open(socket) {
          while (f.state.accepted === acceptedBefore) await Bun.sleep(1);
          afterAccept();
          socket.write(
            `GET /agents HTTP/1.1\r\nHost: isomux\r\nX-Isomux-Turn: ${f.handle}\r\n\r\n`,
          );
        },
        data(_socket, chunk) {
          text += chunk.toString();
        },
        close() {
          resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]));
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

describe("OpenCode authority broker identity checks", () => {
  it("lets a descendant of the bound server through", async () => {
    const f = fixture();
    expect(await request(f)).toBe(200);
  });

  it("refuses when peer credentials cannot be read", async () => {
    const f = fixture();
    f.state.peer = null;
    expect(await request(f)).toBe(403);
  });

  it("refuses another user's descendant", async () => {
    const f = fixture();
    f.state.peer = { pid: PEER, uid: UID + 1 };
    expect(await request(f)).toBe(403);
  });

  it("refuses a process of the same user outside the server's tree", async () => {
    const f = fixture();
    f.table.set(400, { pid: 400, parentPid: 1, startTicks: "other-1" });
    f.state.peer = { pid: 400, uid: UID };
    expect(await request(f)).toBe(403);
  });

  it("refuses when the peer pid names a new process by request time", async () => {
    const f = fixture();
    expect(
      await request(f, () =>
        f.table.set(PEER, {
          pid: PEER,
          parentPid: SHELL,
          startTicks: "peer-2",
        }),
      ),
    ).toBe(403);
  });

  it("refuses when the peer identity is unreadable at accept", async () => {
    const f = fixture();
    f.table.delete(PEER);
    expect(
      await request(f, () =>
        f.table.set(PEER, {
          pid: PEER,
          parentPid: SHELL,
          startTicks: "peer-1",
        }),
      ),
    ).toBe(403);
  });

  it("refuses when an intermediate process changes during the walk", async () => {
    const f = fixture();
    let shellReads = 0;
    f.state.onRead = (pid, hop) => {
      if (pid !== SHELL || !hop) return hop;
      shellReads += 1;
      return shellReads === 1 ? hop : { ...hop, startTicks: "shell-2" };
    };
    expect(await request(f)).toBe(403);
    expect(shellReads).toBe(2);
  });

  it("refuses when the bound server pid names a new process", async () => {
    const f = fixture();
    f.table.set(SERVER, { pid: SERVER, parentPid: 1, startTicks: "server-2" });
    expect(await request(f)).toBe(403);
  });

  it("refuses to bind a server whose identity cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-abi-"));
    const broker = new OpenCodeAuthorityBroker(
      join(root, "authority.sock"),
      UID,
      "http://127.0.0.1:9",
      {
        readPeerCredentials: () => null,
        readProcessHop: () => null,
      },
    );
    cleanup.push(() => {
      broker.close();
      rmSync(root, { recursive: true, force: true });
    });
    expect(() => broker.bind("agent-b", "token-b").activate(SERVER)).toThrow();
  });
});
