// Who listens on an app's port (internal-docs/member-os-user-design.md,
// slice 3b). The relays connect to 127.0.0.1:<port> and send the app's proxy
// secret. With isolated members, another OS user on the box can listen on
// that port while the app is down, so before each relayed request (HTTP and
// each WebSocket upgrade, no cache) the office asks the kernel for its
// listening TCP sockets: every one on the port must belong to the uid that
// runs the app, and one of them must accept 127.0.0.1. Else the relay
// answers 502 and sends nothing.
//
// The kernel answers through sock_diag netlink, LISTEN sockets only, in
// about a millisecond. /proc/net/tcp and tcp6 are the fallback (a seccomp
// profile without netlink): the kernel walks every socket of the box for
// them, about 10 ms each on a large host.
//
// Neither shows IPV6_V6ONLY, so a "::" socket counts as accepting
// 127.0.0.1. That is safe under the all-sockets rule: any other IPv4 socket
// on the port is another row, and with none the connect fails. Linux gives a
// shared port (SO_REUSEPORT) only to sockets of one effective uid.

import { dlopen, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

const LISTEN = "0A";

export interface PortListener {
  // Dotted IPv4, or "::", "::ffff:<dotted>" or the hex of another IPv6.
  address: string;
  port: number;
  uid: number;
}

// The bytes of one 32-bit word of /proc/net/tcp*, which the kernel prints in
// host order (little-endian on every platform Isomux runs on).
function wordBytes(hex: string): number[] {
  const value = Number.parseInt(hex, 16);
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    value >>> 24,
  ];
}

function addressOf(hex: string): string | null {
  if (hex.length === 8) return wordBytes(hex).join(".");
  if (hex.length !== 32) return null;
  const bytes: number[] = [];
  for (let at = 0; at < 32; at += 8)
    bytes.push(...wordBytes(hex.slice(at, at + 8)));
  return addressOfBytes(bytes);
}

// An address in network byte order: 4 bytes (IPv4) or 16 (IPv6).
function addressOfBytes(bytes: readonly number[]): string {
  if (bytes.length === 4) return bytes.join(".");
  if (bytes.every((b) => b === 0)) return "::";
  if (
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  )
    return `::ffff:${bytes.slice(12).join(".")}`;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The LISTEN rows of one /proc/net/tcp or /proc/net/tcp6 text.
export function parseListeners(text: string): PortListener[] {
  const rows: PortListener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[3] !== LISTEN) continue;
    const [addressHex, portHex] = fields[1].split(":");
    if (
      !/^[0-9A-Fa-f]+$/.test(addressHex ?? "") ||
      !/^[0-9A-Fa-f]{4}$/.test(portHex ?? "")
    )
      continue;
    const address = addressOf(addressHex);
    const uid = Number(fields[7]);
    if (address === null || !Number.isInteger(uid)) continue;
    rows.push({ address, port: Number.parseInt(portHex, 16), uid });
  }
  return rows;
}

const ACCEPTS_LOOPBACK = new Set([
  "127.0.0.1",
  "0.0.0.0",
  "::",
  "::ffff:127.0.0.1",
  "::ffff:0.0.0.0",
]);

export type PortVerdict =
  { ok: true } | { ok: false; reason: string; uids: number[] };

// The rule itself: all LISTEN sockets on `port` have `expectedUid`, and one
// accepts 127.0.0.1.
export function portOwnerVerdict(
  listeners: readonly PortListener[],
  port: number,
  expectedUid: number | null,
): PortVerdict {
  const rows = listeners.filter((row) => row.port === port);
  const uids = [...new Set(rows.map((row) => row.uid))];
  if (expectedUid === null)
    return {
      ok: false,
      reason: "the uid that runs the app is not known",
      uids,
    };
  if (rows.some((row) => row.uid !== expectedUid))
    return {
      ok: false,
      reason: `another OS user listens on port ${port}`,
      uids,
    };
  if (!rows.some((row) => ACCEPTS_LOOPBACK.has(row.address)))
    return {
      ok: false,
      reason: `nothing of the app listens on 127.0.0.1:${port}`,
      uids,
    };
  return { ok: true };
}

const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0x80000;
const NETLINK_SOCK_DIAG = 4;
const SOCK_DIAG_BY_FAMILY = 20;
const NLM_F_REQUEST = 0x1;
const NLM_F_DUMP = 0x300;
const NLMSG_ERROR = 2;
const NLMSG_DONE = 3;
const IPPROTO_TCP = 6;
const TCP_LISTEN = 10;
const SOL_SOCKET = 1;
const SO_RCVTIMEO = 20;
// struct nlmsghdr, struct inet_diag_req_v2 (linux/inet_diag.h).
const NLMSG_HEADER = 16;
const REQUEST_BYTES = NLMSG_HEADER + 56;

function openNetlinkLibc() {
  return dlopen("libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    send: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
    recv: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
    setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  });
}
let netlinkLibc: ReturnType<typeof openNetlinkLibc> | null | undefined;

// The LISTEN TCP sockets of one family, from sock_diag; null when the kernel
// cannot be asked.
function diagListeners(family: number): PortListener[] | null {
  if (netlinkLibc === undefined) {
    try {
      netlinkLibc = openNetlinkLibc();
    } catch {
      netlinkLibc = null;
    }
  }
  const libc = netlinkLibc;
  if (!libc) return null;
  const fd = libc.symbols.socket(
    AF_NETLINK,
    SOCK_DGRAM | SOCK_CLOEXEC,
    NETLINK_SOCK_DIAG,
  );
  if (fd < 0) return null;
  try {
    // A kernel that does not answer cannot hold the event loop.
    const timeout = new BigInt64Array([1n, 0n]);
    if (
      libc.symbols.setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, ptr(timeout), 16) !==
      0
    )
      return null;
    const request = Buffer.alloc(REQUEST_BYTES);
    request.writeUInt32LE(REQUEST_BYTES, 0);
    request.writeUInt16LE(SOCK_DIAG_BY_FAMILY, 4);
    request.writeUInt16LE(NLM_F_REQUEST | NLM_F_DUMP, 6);
    request.writeUInt32LE(1, 8);
    request[NLMSG_HEADER] = family;
    request[NLMSG_HEADER + 1] = IPPROTO_TCP;
    request.writeUInt32LE(1 << TCP_LISTEN, NLMSG_HEADER + 4);
    if (
      Number(libc.symbols.send(fd, ptr(request), REQUEST_BYTES, 0)) !==
      REQUEST_BYTES
    )
      return null;
    const rows: PortListener[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    const addressBytes = family === AF_INET ? 4 : 16;
    for (;;) {
      const got = Number(libc.symbols.recv(fd, ptr(buffer), buffer.length, 0));
      if (got <= 0) return null;
      let at = 0;
      while (at + NLMSG_HEADER <= got) {
        const length = buffer.readUInt32LE(at);
        const type = buffer.readUInt16LE(at + 4);
        if (type === NLMSG_DONE) return rows;
        if (type === NLMSG_ERROR || length < NLMSG_HEADER || at + length > got)
          return null;
        // struct inet_diag_msg: family, state, timer, retrans, then the
        // socket id (sport, dport, src[16], ...), then expires, rqueue,
        // wqueue, uid.
        const message = at + NLMSG_HEADER;
        if (length >= NLMSG_HEADER + 72 && buffer[message + 1] === TCP_LISTEN)
          rows.push({
            address: addressOfBytes([
              ...buffer.subarray(message + 8, message + 8 + addressBytes),
            ]),
            port: buffer.readUInt16BE(message + 4),
            uid: buffer.readUInt32LE(message + 64),
          });
        at += (length + 3) & ~3;
      }
    }
  } finally {
    libc.symbols.close(fd);
  }
}

// The LISTEN sockets now: sock_diag, else the /proc tables. `read` (tests)
// reads the /proc tables only.
export function readListeners(
  read?: (path: string) => string,
): PortListener[] | null {
  if (!read) {
    const v4 = diagListeners(AF_INET);
    const v6 = v4 === null ? null : diagListeners(AF_INET6);
    if (v4 !== null && v6 !== null) return [...v4, ...v6];
  }
  return readProcListeners(
    read ?? ((path: string) => readFileSync(path, "utf8")),
  );
}

// The /proc tables. tcp6 is absent on a host without IPv6; tcp must be
// there (Linux).
function readProcListeners(
  read: (path: string) => string,
): PortListener[] | null {
  let v4: string;
  try {
    v4 = read("/proc/net/tcp");
  } catch {
    return null;
  }
  let v6 = "";
  try {
    v6 = read("/proc/net/tcp6");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return [...parseListeners(v4), ...parseListeners(v6)];
}

export interface AppPortCheckDeps {
  // The uid that runs the app (AppSupervisorRouter.appUid).
  appUid: (appName: string) => number | null;
  // No /proc (macOS development): the check is skipped only while no member
  // has an OS user.
  platform: NodeJS.Platform;
  anyIsolated: () => boolean;
  read?: (path: string) => string;
  log?: (line: string) => void;
}

export function createAppPortCheck(
  deps: AppPortCheckDeps,
): (app: { name: string; port: number }) => PortVerdict {
  const log = deps.log ?? ((line: string) => console.error(line));
  return (app) => {
    if (deps.platform !== "linux" && !deps.anyIsolated()) return { ok: true };
    const listeners = readListeners(deps.read);
    const verdict: PortVerdict =
      listeners === null
        ? { ok: false, reason: "the socket tables could not be read", uids: [] }
        : portOwnerVerdict(listeners, app.port, deps.appUid(app.name));
    if (!verdict.ok)
      log(
        `[apps] "${app.name}": not relayed: ${verdict.reason} (uids listening: ${verdict.uids.join(", ") || "none"})`,
      );
    return verdict;
  };
}
