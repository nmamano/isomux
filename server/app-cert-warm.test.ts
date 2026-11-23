// The certificate warm-up (server/app-cert-warm.ts), against local servers on
// random ports: a TLS server stands in for the terminator, a closed port for a
// target that is not there, a TCP server that never answers for a terminator
// that is still obtaining, and a TCP server that answers garbage for one that
// refuses the handshake. No test opens a real :443 or looks up a name in DNS.

import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createTcpServer, type Server, type Socket } from "net";
import { createSecureContext, createServer as createTlsServer } from "tls";

import { warmAppCertificate } from "./app-cert-warm.ts";
import {
  createCertificateAuthority,
  createLeafIssuer,
} from "./secret-proxy/x509.ts";

const HOSTNAME = "hello.office.example";

// Any certificate will do: the warm-up does not verify it.
const leaf = createLeafIssuer(createCertificateAuthority(), () => true).issue(
  "api.example-stub.test",
);

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

interface Handshake {
  // The name the client asked for.
  sni: string;
  // Resolves when the TCP connection closes.
  closed: Promise<void>;
}

// A terminator: completes the handshake and records each client. The name is
// read in the SNI callback and the close on the raw TCP socket, because Bun's
// TLS server does not call its connection listener for a client that hangs up
// right after the handshake.
async function tlsTarget(): Promise<{ port: number; seen: Handshake[] }> {
  const seen: Handshake[] = [];
  const closes: Promise<void>[] = [];
  const context = createSecureContext({ cert: leaf.certPem, key: leaf.keyPem });
  const server = createTlsServer({
    cert: leaf.certPem,
    key: leaf.keyPem,
    SNICallback: (name, cb) => {
      // One SNI per connection, in connection order.
      seen.push({ sni: name, closed: closes[seen.length] });
      cb(null, context);
    },
  });
  server.on("connection", (socket: Socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    closes.push(new Promise((r) => socket.on("close", () => r())));
  });
  return { port: await listen(server), seen };
}

// A port with nothing listening: connection refused.
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

// Accepts TCP and never says a word: a terminator still obtaining.
async function silentTarget(): Promise<number> {
  return listen(
    createTcpServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
    }),
  );
}

// Answers the ClientHello with bytes that are not TLS, then hangs up: a
// terminator that refuses the handshake.
async function garbageTarget(): Promise<number> {
  return listen(
    createTcpServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    }),
  );
}

const local = (port: number) => ({ host: "127.0.0.1", port });

describe("warmAppCertificate", () => {
  test("completes a handshake that names the app, then hangs up", async () => {
    const target = await tlsTarget();
    const ok = await warmAppCertificate(HOSTNAME, {
      targets: [local(target.port)],
      timeoutMs: 5_000,
    });
    expect(ok).toBe(true);
    expect(target.seen.map((h) => h.sni)).toEqual([HOSTNAME]);
    // It closes the connection itself: the server sees the close without
    // closing first.
    const closed = await Promise.race([
      target.seen[0].closed.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    expect(closed).toBe(true);
  });

  test("goes on to the next target when one refuses the connection", async () => {
    const target = await tlsTarget();
    const ok = await warmAppCertificate(HOSTNAME, {
      targets: [local(await closedPort()), local(target.port)],
      timeoutMs: 5_000,
    });
    expect(ok).toBe(true);
    expect(target.seen.map((h) => h.sni)).toEqual([HOSTNAME]);
  });

  test("goes on to the next target when one fails the handshake", async () => {
    const target = await tlsTarget();
    const ok = await warmAppCertificate(HOSTNAME, {
      targets: [local(await garbageTarget()), local(target.port)],
      timeoutMs: 5_000,
    });
    expect(ok).toBe(true);
    expect(target.seen.map((h) => h.sni)).toEqual([HOSTNAME]);
  });

  test("resolves false, without throwing, when no target completes a handshake", async () => {
    const ok = await warmAppCertificate(HOSTNAME, {
      targets: [local(await closedPort()), local(await garbageTarget())],
      timeoutMs: 5_000,
    });
    expect(ok).toBe(false);
  });

  test("gives up at the deadline on a target that never answers", async () => {
    const timeoutMs = 300;
    const started = performance.now();
    const ok = await warmAppCertificate(HOSTNAME, {
      targets: [local(await silentTarget())],
      timeoutMs,
    });
    const elapsed = performance.now() - started;
    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsed).toBeLessThan(2_000);
  });
});
