// The client uid lookup of the secret proxy (internal-docs/secrets-design.md,
// section 2.2): the /proc/net/tcp parser on rows in the kernel's own format,
// and the real lookup on a loopback connection (Linux only).

import { describe, expect, test } from "bun:test";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { endianness } from "node:os";

import { peerUid, uidFromTable } from "./peer-uid.ts";

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP6_HEADER =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

// One row as the kernel prints it: addresses and ports in hex, then the
// state, queues, timers, uid, timeout and inode.
function row(
  sl: number,
  local: string,
  remote: string,
  uid: number,
  inode: number,
  state = "01",
) {
  return `${String(sl).padStart(4)}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 20 4 30 10 -1`;
}
const table = (header: string, rows: string[]) =>
  [header, ...rows, ""].join("\n");

// 127.0.0.1 as a little-endian host prints it; ports 50000 (C350) and 4000
// (0FA0). The client is 127.0.0.1:50000, the proxy listens on :4000.
const LO = "0100007F";
const CLIENT = { address: "127.0.0.1", port: 50000 };
const PROXY = { address: "127.0.0.1", port: 4000 };
const CLIENT_UID = 1001;
const PROXY_UID = 2002;

describe("uidFromTable", () => {
  // Both ends of one loopback connection are in the table: the client's row
  // and the proxy's own accepted row. Different uids tell them apart.
  const both = table(TCP_HEADER, [
    row(0, `${LO}:0FA0`, "00000000:0000", 3003, 900, "0A"),
    row(1, `${LO}:0FA0`, `${LO}:C350`, PROXY_UID, 901),
    row(2, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 902),
  ]);

  test("the row whose local end is the client and remote end the proxy gives the client's uid", () => {
    expect(uidFromTable(both, CLIENT, PROXY, true)).toBe(CLIENT_UID);
    // The same table read the other way is the proxy's own socket.
    expect(uidFromTable(both, PROXY, CLIENT, true)).toBe(PROXY_UID);
  });

  test("a row that matches on one end, or on ports only, is not the client", () => {
    const near = table(TCP_HEADER, [
      // Same client end, another remote port.
      row(0, `${LO}:C350`, `${LO}:1388`, 4004, 910),
      // Same client end, another remote address (127.0.0.2).
      row(1, `${LO}:C350`, "0200007F:0FA0", 4005, 911),
      // Same ports, another local address.
      row(2, "0200007F:C350", `${LO}:0FA0`, 4006, 912),
      // Same addresses, another local port (50001).
      row(3, `${LO}:C351`, `${LO}:0FA0`, 4007, 913),
    ]);
    expect(uidFromTable(near, CLIENT, PROXY, true)).toBeNull();
    const withClient = table(TCP_HEADER, [
      ...near.split("\n").slice(1, -1),
      row(4, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 914),
    ]);
    expect(uidFromTable(withClient, CLIENT, PROXY, true)).toBe(CLIENT_UID);
  });

  test("a row with inode 0 (TIME_WAIT, uid 0) is not a live socket", () => {
    const waiting = row(0, `${LO}:C350`, `${LO}:0FA0`, 0, 0, "06");
    expect(
      uidFromTable(table(TCP_HEADER, [waiting]), CLIENT, PROXY, true),
    ).toBeNull();
    const reused = table(TCP_HEADER, [
      waiting,
      row(1, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 920),
    ]);
    expect(uidFromTable(reused, CLIENT, PROXY, true)).toBe(CLIENT_UID);
  });

  test("a live root socket gives uid 0, not null", () => {
    const root = table(TCP_HEADER, [
      row(0, `${LO}:C350`, `${LO}:0FA0`, 0, 930),
    ]);
    expect(uidFromTable(root, CLIENT, PROXY, true)).toBe(0);
  });

  test("an IPv4 end matches its v4-mapped form in /proc/net/tcp6", () => {
    // ::ffff:127.0.0.1, four 32-bit words in little-endian host order.
    const mapped = "0000000000000000FFFF00000100007F";
    const tcp6 = table(TCP6_HEADER, [
      row(0, `${mapped}:0FA0`, `${mapped}:C350`, PROXY_UID, 940),
      row(1, `${mapped}:C350`, `${mapped}:0FA0`, CLIENT_UID, 941),
    ]);
    expect(uidFromTable(tcp6, CLIENT, PROXY, true)).toBe(CLIENT_UID);
    // A node socket can name the same end in its v4-mapped form.
    expect(
      uidFromTable(
        tcp6,
        { address: "::ffff:127.0.0.1", port: 50000 },
        { address: "::ffff:127.0.0.1", port: 4000 },
        true,
      ),
    ).toBe(CLIENT_UID);
    // 127.0.0.2 is not 127.0.0.1.
    expect(
      uidFromTable(tcp6, { address: "127.0.0.2", port: 50000 }, PROXY, true),
    ).toBeNull();
  });

  test("a v4-mapped end matches a /proc/net/tcp row", () => {
    const tcp = table(TCP_HEADER, [
      row(0, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 950),
    ]);
    expect(
      uidFromTable(
        tcp,
        { address: "::ffff:127.0.0.1", port: 50000 },
        { address: "::ffff:127.0.0.1", port: 4000 },
        true,
      ),
    ).toBe(CLIENT_UID);
  });

  test("on a big-endian host the words are printed in network order", () => {
    const be = table(TCP_HEADER, [
      row(0, "7F000001:C350", "7F000001:0FA0", CLIENT_UID, 960),
    ]);
    expect(uidFromTable(be, CLIENT, PROXY, false)).toBe(CLIENT_UID);
    expect(uidFromTable(be, CLIENT, PROXY, true)).toBeNull();
    const be6 = table(TCP6_HEADER, [
      row(
        0,
        "00000000000000000000FFFF7F000001:C350",
        "00000000000000000000FFFF7F000001:0FA0",
        CLIENT_UID,
        961,
      ),
    ]);
    expect(uidFromTable(be6, CLIENT, PROXY, false)).toBe(CLIENT_UID);
  });

  test("without the flag, the host's own byte order is used", () => {
    // Every box this runs on is little-endian.
    const tcp = table(TCP_HEADER, [
      row(0, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 970),
    ]);
    expect(uidFromTable(tcp, CLIENT, PROXY)).toBe(CLIENT_UID);
  });

  test("malformed rows are skipped, never thrown on", () => {
    const client = row(9, `${LO}:C350`, `${LO}:0FA0`, CLIENT_UID, 980);
    const malformed = [
      "",
      "   0:",
      "   1: 0100007F:C350",
      `   2: ZZZZZZZZ:C350 ${LO}:0FA0 01 00000000:00000000 00:00000000 00000000  1001        0 981 1`,
      `   3: ${LO}:C350 ${LO}:0FA0 01 00000000:00000000 00:00000000 00000000   abc        0 982 1`,
      `   4: ${LO}:C350 ${LO}:0FA0 01 00000000:00000000 00:00000000 00000000  1001`,
      `   5: ${LO} ${LO}:0FA0 01 00000000:00000000 00:00000000 00000000  1001        0 983 1`,
      "garbage",
    ];
    expect(
      uidFromTable(table(TCP_HEADER, malformed), CLIENT, PROXY, true),
    ).toBeNull();
    expect(
      uidFromTable(
        table(TCP_HEADER, [...malformed, client]),
        CLIENT,
        PROXY,
        true,
      ),
    ).toBe(CLIENT_UID);
    expect(uidFromTable("", CLIENT, PROXY, true)).toBeNull();
  });
});

// A real accepted loopback connection: the server's end, and a close.
async function acceptedSocket() {
  const accepted = Promise.withResolvers<Socket>();
  const server = createServer((socket) => accepted.resolve(socket));
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  const client = netConnect(port, "127.0.0.1");
  const socket = await accepted.promise;
  return {
    socket,
    close: async () => {
      socket.destroy();
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(process.platform !== "linux")("peerUid on Linux", () => {
  test("an accepted loopback connection belongs to this process's uid", async () => {
    const { socket, close } = await acceptedSocket();
    try {
      expect(await peerUid(socket)).toBe(process.getuid!());
    } finally {
      await close();
    }
  });

  describe("the tables it reads", () => {
    const le = endianness() === "LE";
    const v4 = le ? LO : "7F000001";
    const v6 = le
      ? "0000000000000000FFFF00000100007F"
      : "00000000000000000000FFFF7F000001";
    const hexPort = (port: number) =>
      port.toString(16).toUpperCase().padStart(4, "0");
    // The client's row and the proxy's own accepted row of `socket`, with
    // different uids: only the client's row may decide.
    function rows(socket: Socket, address: string) {
      const client = `${address}:${hexPort(socket.remotePort!)}`;
      const proxy = `${address}:${hexPort(socket.localPort!)}`;
      return [
        row(0, proxy, client, PROXY_UID, 990),
        row(1, client, proxy, CLIENT_UID, 991),
      ];
    }

    test("the client's row decides, not the proxy's own row", async () => {
      const { socket, close } = await acceptedSocket();
      try {
        const read: string[] = [];
        const uid = await peerUid(socket, async (path) => {
          read.push(path);
          return table(TCP_HEADER, rows(socket, v4));
        });
        expect(uid).toBe(CLIENT_UID);
        expect(read).toEqual(["/proc/net/tcp"]);
      } finally {
        await close();
      }
    });

    test("no row in /proc/net/tcp, or no such file: /proc/net/tcp6 is read next", async () => {
      const { socket, close } = await acceptedSocket();
      try {
        const tcp6 = table(TCP6_HEADER, rows(socket, v6));
        const withoutClient = table(TCP_HEADER, [rows(socket, v4)[0]]);
        const read: string[] = [];
        expect(
          await peerUid(socket, async (path) => {
            read.push(path);
            return path === "/proc/net/tcp" ? withoutClient : tcp6;
          }),
        ).toBe(CLIENT_UID);
        expect(read).toEqual(["/proc/net/tcp", "/proc/net/tcp6"]);
        expect(
          await peerUid(socket, async (path) => {
            if (path === "/proc/net/tcp") throw new Error("ENOENT");
            return tcp6;
          }),
        ).toBe(CLIENT_UID);
      } finally {
        await close();
      }
    });

    test("no row in either table, or neither file readable: null", async () => {
      const { socket, close } = await acceptedSocket();
      try {
        expect(
          await peerUid(socket, async (path) =>
            path === "/proc/net/tcp"
              ? table(TCP_HEADER, [rows(socket, v4)[0]])
              : table(TCP6_HEADER, []),
          ),
        ).toBeNull();
        expect(
          await peerUid(socket, async () => {
            throw new Error("EACCES");
          }),
        ).toBeNull();
      } finally {
        await close();
      }
    });
  });
});
