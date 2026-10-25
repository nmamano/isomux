// The egress allowlist proxy (egress-proxy.ts) on a real listener under Bun: a
// client sends CONNECT over TCP as the site's fetch does, and the tunnel reaches
// a local echo server. resolve() stands in for DNS and dial() sends the tunnel to
// the echo server, so the test needs no network.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import {
  connect,
  createServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createEgressProxy, type EgressOptions } from "./egress-proxy";

const ALLOW = "api.example.com:443,discord.com:443";
const PUBLIC = "93.184.216.34";

let echo: NetServer;
let echoPort = 0;
let closedPort = 0;
beforeAll(async () => {
  echo = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      // "bye" asks the far end to close the tunnel.
      if (chunk.toString() === "bye") socket.end();
      else socket.write(chunk);
    });
  });
  await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
  echoPort = (echo.address() as AddressInfo).port;
  // A port with nothing listening: bind, read the port, close.
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
});
afterAll(() => {
  echo.close();
});

type Harness = {
  port: number;
  logs: string[];
  dials: { address: string; port: number }[];
  resolved: string[];
};

const proxies: Server[] = [];
const clients: Socket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(
    proxies.splice(0).map(
      (proxy) =>
        new Promise<void>((done) => {
          proxy.closeAllConnections?.();
          proxy.close(() => done());
        }),
    ),
  );
});

async function start(
  answers: Record<string, string[] | Error | "hang"> = {
    "api.example.com": [PUBLIC],
    "discord.com": [PUBLIC],
  },
  options: EgressOptions = {},
  target: () => number = () => echoPort,
): Promise<Harness> {
  const harness: Harness = { port: 0, logs: [], dials: [], resolved: [] };
  const proxy = createEgressProxy(
    ALLOW,
    (message) => harness.logs.push(message),
    {
      resolve: async (host) => {
        harness.resolved.push(host);
        const answer = answers[host];
        if (answer === "hang") return new Promise<string[]>(() => {});
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
      dial: (address, port) => {
        harness.dials.push({ address, port });
        return connect(target(), "127.0.0.1");
      },
      ...options,
    },
  );
  proxies.push(proxy);
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", () => done()));
  harness.port = (proxy.address() as AddressInfo).port;
  return harness;
}

type Client = {
  socket: Socket;
  // The proxy's status line, and the bytes that came after its header.
  status: Promise<string>;
  data: () => string;
  closed: Promise<void>;
};

function open(port: number, request: string): Client {
  const socket = connect(port, "127.0.0.1");
  clients.push(socket);
  socket.on("error", () => {});
  let buffer = "";
  let resolveStatus: (line: string) => void = () => {};
  const status = new Promise<string>((done) => (resolveStatus = done));
  let headerEnd = -1;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    if (headerEnd < 0) {
      headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0)
        resolveStatus(buffer.slice(0, buffer.indexOf("\r\n")));
    }
  });
  const closed = new Promise<void>((done) =>
    socket.on("close", () => {
      if (headerEnd < 0) resolveStatus(buffer.split("\r\n")[0] ?? "");
      done();
    }),
  );
  socket.write(request);
  return {
    socket,
    status,
    data: () => (headerEnd < 0 ? "" : buffer.slice(headerEnd + 4)),
    closed,
  };
}

const connectRequest = (target: string, head = "") =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${head}`;

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`${what} did not happen within ${ms} ms`);
    }),
  ]);

async function tunnel(harness: Harness, target = "api.example.com:443") {
  const client = open(harness.port, connectRequest(target));
  expect(await within(client.status, 2000, "the CONNECT answer")).toMatch(
    /^HTTP\/1\.1 200\b/,
  );
  return client;
}

describe("allowed CONNECT", () => {
  it("tunnels bytes both ways to the checked address, including the bytes sent with the request", async () => {
    const harness = await start();
    const client = open(
      harness.port,
      connectRequest("api.example.com:443", "early"),
    );
    expect(await within(client.status, 2000, "the CONNECT answer")).toMatch(
      /^HTTP\/1\.1 200\b/,
    );
    await until(() => client.data() === "early");
    client.socket.write("ping");
    await until(() => client.data() === "earlyping");
    expect(harness.dials).toEqual([{ address: PUBLIC, port: 443 }]);
  });

  it("matches the allowlist without regard to case", async () => {
    const harness = await start();
    const client = await tunnel(harness, "API.Example.COM:443");
    client.socket.write("x");
    await until(() => client.data() === "x");
    expect(harness.resolved).toEqual(["api.example.com"]);
  });

  it("closes the client when the far end closes", async () => {
    const harness = await start();
    const client = await tunnel(harness);
    client.socket.write("bye");
    await within(client.closed, 2000, "the client close");
  });
});

describe("refusals", () => {
  const cases: {
    name: string;
    target: string;
    answers?: Record<string, string[] | Error | "hang">;
    options?: EgressOptions;
    status: number;
    resolves: boolean;
  }[] = [
    {
      name: "a host not on the list",
      target: "evil.example.com:443",
      status: 403,
      resolves: false,
    },
    {
      name: "an allowed host on another port",
      target: "api.example.com:80",
      status: 403,
      resolves: false,
    },
    {
      name: "a suffix of an allowed host",
      target: "xapi.example.com:443",
      status: 403,
      resolves: false,
    },
    {
      name: "a target with no port",
      target: "api.example.com",
      status: 403,
      resolves: false,
    },
    {
      name: "an address instead of a name",
      target: `${PUBLIC}:443`,
      status: 403,
      resolves: false,
    },
    {
      name: "a name that resolves to a private address",
      target: "api.example.com:443",
      answers: { "api.example.com": ["10.0.0.5"] },
      status: 403,
      resolves: true,
    },
    {
      name: "a name with one private address among public ones",
      target: "api.example.com:443",
      answers: { "api.example.com": [PUBLIC, "127.0.0.1"] },
      status: 403,
      resolves: true,
    },
    {
      name: "a name with no address",
      target: "api.example.com:443",
      answers: { "api.example.com": [] },
      status: 403,
      resolves: true,
    },
    {
      name: "a failed lookup",
      target: "api.example.com:443",
      answers: { "api.example.com": new Error("ENOTFOUND") },
      status: 502,
      resolves: true,
    },
    {
      name: "a lookup that does not answer in time",
      target: "api.example.com:443",
      answers: { "api.example.com": "hang" },
      options: { dnsMs: 50 },
      status: 502,
      resolves: true,
    },
  ];
  for (const c of cases) {
    it(`answers ${c.status} to ${c.name} and dials nothing`, async () => {
      const harness = await start(c.answers, c.options);
      const client = open(harness.port, connectRequest(c.target));
      expect(await within(client.status, 2000, "the answer")).toMatch(
        new RegExp(`^HTTP/1\\.1 ${c.status}\\b`),
      );
      await within(client.closed, 2000, "the close after a refusal");
      expect(harness.dials).toEqual([]);
      expect(harness.resolved.length > 0).toBe(c.resolves);
      expect(harness.logs.some((line) => line.startsWith("refused"))).toBe(
        true,
      );
    });
  }

  it("answers 502 when the checked address refuses the connection", async () => {
    const harness = await start(undefined, {}, () => closedPort);
    const client = open(harness.port, connectRequest("api.example.com:443"));
    expect(await within(client.status, 2000, "the answer")).toMatch(
      /^HTTP\/1\.1 502\b/,
    );
    expect(harness.dials).toEqual([{ address: PUBLIC, port: 443 }]);
  });

  it("answers 405 to a request that is not CONNECT", async () => {
    const harness = await start();
    const client = open(
      harness.port,
      "GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
    );
    expect(await within(client.status, 2000, "the answer")).toMatch(
      /^HTTP\/1\.1 405\b/,
    );
    expect(harness.dials).toEqual([]);
    expect(harness.resolved).toEqual([]);
  });
});

describe("only public addresses", () => {
  // Each answer goes through the proxy as the one address of an allowed name.
  const refused = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:10.0.0.1",
    "64:ff9b::808:808",
    "100::1",
    "2001:db8::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "not-an-address",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
  ];
  for (const address of refused)
    it(`refuses ${address}`, async () => {
      const harness = await start({ "api.example.com": [address] });
      const client = open(harness.port, connectRequest("api.example.com:443"));
      expect(await within(client.status, 2000, "the answer")).toMatch(
        /^HTTP\/1\.1 403\b/,
      );
      expect(harness.dials).toEqual([]);
    });
  for (const address of allowed)
    it(`tunnels to ${address}`, async () => {
      const harness = await start({ "api.example.com": [address] });
      await tunnel(harness);
      expect(harness.dials).toEqual([{ address, port: 443 }]);
    });
});

describe("limits", () => {
  it("refuses a tunnel over the cap with 503, and frees a slot when a tunnel closes", async () => {
    const harness = await start(undefined, { maxTunnels: 2 });
    const first = await tunnel(harness);
    await tunnel(harness, "discord.com:443");
    const third = open(harness.port, connectRequest("api.example.com:443"));
    expect(await within(third.status, 2000, "the answer")).toMatch(
      /^HTTP\/1\.1 503\b/,
    );
    expect(harness.dials).toHaveLength(2);
    first.socket.destroy();
    // The slot comes back once the proxy sees the close.
    let status = "";
    for (let tries = 0; tries < 50 && !status.includes(" 200"); tries++) {
      await Bun.sleep(20);
      const next = open(harness.port, connectRequest("api.example.com:443"));
      status = await within(next.status, 2000, "the answer");
    }
    expect(status).toMatch(/^HTTP\/1\.1 200\b/);
  });

  it("does not count refused requests against the cap", async () => {
    const harness = await start(
      {
        "api.example.com": [PUBLIC],
        "discord.com": new Error("ENOTFOUND"),
      },
      { maxTunnels: 2 },
    );
    for (const target of [
      "discord.com:443", // failed lookup
      "discord.com:443",
      "evil.example.com:443", // not allowed
      "evil.example.com:443",
    ]) {
      const client = open(harness.port, connectRequest(target));
      await within(client.closed, 2000, "the close after a refusal");
    }
    // A tunnel whose far end refused also gives its slot back.
    const harness2 = await start(
      undefined,
      { maxTunnels: 2 },
      () => closedPort,
    );
    for (let i = 0; i < 3; i++) {
      const client = open(harness2.port, connectRequest("api.example.com:443"));
      expect(await within(client.status, 2000, "the answer")).toMatch(
        /^HTTP\/1\.1 502\b/,
      );
    }
    await tunnel(harness);
    await tunnel(harness);
  });

  it("closes a tunnel that stays idle", async () => {
    const harness = await start(undefined, { idleMs: 100 });
    const client = await tunnel(harness);
    const opened = Date.now();
    await within(client.closed, 2000, "the idle close");
    expect(Date.now() - opened).toBeGreaterThanOrEqual(80);
  });

  it("closes a busy tunnel at the end of its lifetime", async () => {
    const harness = await start(undefined, { idleMs: 1000, lifetimeMs: 200 });
    const client = await tunnel(harness);
    const opened = Date.now();
    const timer = setInterval(() => client.socket.write("."), 20);
    try {
      await within(client.closed, 2000, "the lifetime close");
    } finally {
      clearInterval(timer);
    }
    expect(client.data().length).toBeGreaterThan(0);
    expect(Date.now() - opened).toBeGreaterThanOrEqual(150);
  });
});

describe("entry", () => {
  it("refuses to start without EGRESS_ALLOW", async () => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "egress-proxy.ts")],
      {
        env: { ...env, EGRESS_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await within(
      new Promise<number | null>((done) =>
        child.on("close", (status) => done(status)),
      ),
      5000,
      "the exit",
    ).finally(() => child.kill());
    expect(code).not.toBe(0);
    expect(output).toContain("EGRESS_ALLOW");
  });
});
