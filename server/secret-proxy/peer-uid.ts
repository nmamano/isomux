// The OS user that owns the client end of a loopback connection to the
// secret proxy (internal-docs/secrets-design.md, section 2.2). Linux only:
// the kernel lists every TCP socket with its uid in /proc/net/tcp and
// /proc/net/tcp6. Elsewhere the lookup finds nothing, and the proxy asks for
// its password as before.

import { readFile } from "node:fs/promises";
import { isIPv4, isIPv6, type Socket } from "node:net";
import { endianness } from "node:os";

export interface Endpoint {
  address: string;
  port: number;
}

const ROW_END = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/;
const DECIMAL = /^\d+$/;
const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

// One form per address: dotted for IPv4 and v4-mapped IPv6, the URL
// parser's compressed form for other IPv6. null when it is not an address.
function canonical(address: string): string | null {
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return null;
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = MAPPED.exec(host);
  if (!mapped) return host;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

// The kernel prints an address as 32-bit words, each in host byte order.
function rowAddress(hex: string, littleEndian: boolean): string | null {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const four = [0, 2, 4, 6].map((i) =>
      parseInt(hex.slice(word + i, word + i + 2), 16),
    );
    bytes.push(...(littleEndian ? four.reverse() : four));
  }
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return canonical(groups.join(":"));
}

// The uid of the socket in `table` (the text of /proc/net/tcp or
// /proc/net/tcp6) whose local end is `local` and whose remote end is
// `remote`, or null when no live row matches. A row with inode 0 (TIME_WAIT)
// carries uid 0 and no owner, so it never matches.
export function uidFromTable(
  table: string,
  local: Endpoint,
  remote: Endpoint,
  littleEndian = endianness() === "LE",
): number | null {
  const localAddress = canonical(local.address);
  const remoteAddress = canonical(remote.address);
  if (localAddress === null || remoteAddress === null) return null;
  const matches = (field: string, address: string, port: number) => {
    const end = ROW_END.exec(field);
    return (
      !!end &&
      parseInt(end[2], 16) === port &&
      rowAddress(end[1], littleEndian) === address
    );
  };
  for (const line of table.split("\n")) {
    // sl, local, remote, st, queues, timer, retransmits, uid, timeout, inode
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [, localField, remoteField, , , , , uid, , inode] = fields;
    if (!DECIMAL.test(uid) || !DECIMAL.test(inode) || Number(inode) === 0)
      continue;
    if (
      matches(localField, localAddress, local.port) &&
      matches(remoteField, remoteAddress, remote.port)
    )
      return Number(uid);
  }
  return null;
}

// The uid of the process at the other end of `socket`, an accepted
// connection, or null when it cannot be known. `readTable` is a seam for
// tests.
export async function peerUid(
  socket: Socket,
  readTable: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const { remoteAddress, remotePort, localAddress, localPort } = socket;
  if (!remoteAddress || !remotePort || !localAddress || !localPort) return null;
  // The client's row: its local end is our remote end.
  const client = { address: remoteAddress, port: remotePort };
  const proxy = { address: localAddress, port: localPort };
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const uid = uidFromTable(await readTable(file), client, proxy);
      if (uid !== null) return uid;
    } catch {
      // No such file (no IPv6) or no access: try the next, then give up.
    }
  }
  return null;
}
