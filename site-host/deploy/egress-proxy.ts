// Egress allowlist proxy for the self-hosted isomux.com (compose.yaml). The site
// container has no route to the internet; its fetch calls (HTTPS_PROXY=http://egress:3128)
// go through here, and this proxy opens a TLS tunnel only to the hosts in EGRESS_ALLOW.
// It never sees request contents or secrets: the TLS session runs end to end between
// the site and the API. A port of bigOspeedrun's ops/self-host/egress-proxy.mjs to Bun.
// Hardening: an allowed name must resolve only to public addresses, and the tunnel goes
// to the checked address, so DNS cannot point it inside. Tunnels are limited in number,
// idle time and total lifetime.
// Run: EGRESS_ALLOW=<host:port,...> bun site-host/deploy/egress-proxy.ts   (EGRESS_PORT default 3128)
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";

export type EgressLimits = {
  maxTunnels: number;
  idleMs: number;
  lifetimeMs: number;
  dnsMs: number;
};

export type EgressOptions = Partial<EgressLimits> & {
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => Socket;
};

// Addresses a tunnel must never reach: private, loopback, link-local, CGNAT, and other
// non-public ranges. An IPv4-mapped or NAT64 IPv6 answer is refused as a whole.
// One list per family: an IPv4 address also matches IPv4-mapped IPv6 rules, so a
// single list with ::ffff:0:0/96 would block every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(network, prefix, "ipv6");

export function isPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, "ipv4");
  if (family === 6) return !blocked6.check(address, "ipv6");
  return false;
}

// A chat reply streams for up to 45 s and the site's requests time out at 65 s, so the
// lifetime is above both; an idle tunnel closes much sooner.
export const defaultLimits: EgressLimits = {
  maxTunnels: 32,
  idleMs: 30_000,
  lifetimeMs: 90_000,
  dnsMs: 5_000,
};

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);
const defaultDial = (address: string, port: number) =>
  connect({ host: address, port });

export function createEgressProxy(
  allow: string,
  log: (message: string) => void = (message) => console.log(message),
  {
    resolve = defaultResolve,
    dial = defaultDial,
    ...limits
  }: EgressOptions = {},
): Server {
  const { maxTunnels, idleMs, lifetimeMs, dnsMs } = {
    ...defaultLimits,
    ...limits,
  };
  const allowed = new Set(
    allow
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  let open = 0;
  const server = createServer((req, res) => {
    // Plain HTTP requests could carry data anywhere in clear text: only CONNECT is served.
    log(`refused ${req.method} (only CONNECT)`);
    res
      .writeHead(405, { "Content-Type": "text/plain", Connection: "close" })
      .end("Only CONNECT to allowed hosts.\n");
  });
  const tunnel = async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = (req.url ?? "").toLowerCase();
    client.on("error", () => client.destroy());
    const refuse = (status: string, why: string) => {
      log(`refused CONNECT ${target.slice(0, 100)}: ${why}`);
      client.end(
        `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    };
    const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
    if (!match || !allowed.has(target))
      return refuse("403 Forbidden", "not allowed");
    if (open >= maxTunnels)
      return refuse("503 Service Unavailable", `${maxTunnels} tunnels open`);
    open++;
    let released = false;
    // Set once the address is checked; close() may run before that.
    const opened: {
      upstream?: Socket;
      lifetime?: ReturnType<typeof setTimeout>;
    } = {};
    const release = () => {
      if (released) return;
      released = true;
      open--;
      clearTimeout(opened.lifetime);
    };
    const close = () => {
      release();
      opened.upstream?.destroy();
      client.destroy();
    };
    client.on("close", close);
    let addresses: string[];
    try {
      addresses = await Promise.race([
        resolve(match[1]),
        new Promise<never>((_, fail) =>
          setTimeout(() => fail(new Error("timeout")), dnsMs).unref(),
        ),
      ]);
    } catch {
      release();
      return refuse("502 Bad Gateway", "DNS failed");
    }
    // Every answer must be public: a mixed answer could still reach an inside address.
    const inside = addresses.find((address) => !isPublic(address));
    if (!addresses.length || inside !== undefined) {
      release();
      return refuse("403 Forbidden", `resolves to ${inside ?? "nothing"}`);
    }
    if (released) return;
    let established = false;
    const socket = dial(addresses[0], Number(match[2]));
    opened.upstream = socket;
    opened.lifetime = setTimeout(close, lifetimeMs);
    socket.setTimeout(idleMs, close);
    client.setTimeout(idleMs, close);
    socket.once("connect", () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    socket.on("error", () => {
      if (established) close();
      else {
        release();
        refuse("502 Bad Gateway", "upstream refused");
      }
    });
    socket.on("close", () => {
      if (established) close();
    });
  };
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    // A throw (a dial that fails at once) closes this client, not the proxy.
    tunnel(req, client, head).catch(() => client.destroy());
  });
  return server;
}

if (import.meta.main) {
  // compose.yaml holds the one allowlist; without it the proxy does not start.
  const allow = process.env.EGRESS_ALLOW;
  if (!allow) {
    console.error("egress proxy: set EGRESS_ALLOW (host:port,...)");
    process.exit(1);
  }
  const server = createEgressProxy(allow);
  server.listen(Number(process.env.EGRESS_PORT ?? 3128), "0.0.0.0", () =>
    console.log(`egress proxy allows ${allow}`),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
