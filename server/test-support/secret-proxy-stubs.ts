// Stub hosts for the secret proxy tests (internal-docs/secrets-design.md,
// appendix D). Nothing here reaches the network: every stub listens on
// 127.0.0.1, and the proxy reaches it through its `standIns` seam.

import { gzipSync } from "node:zlib";
import {
  connect as netConnect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import {
  connect as tlsConnect,
  createSecureContext,
  createServer as createTlsServer,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";

import {
  bodyFraming,
  ByteReader,
  readBody,
  readHead,
  serializeHead,
  type HeaderList,
} from "../secret-proxy/http1.ts";
import {
  createCertificateAuthority,
  createLeafIssuer,
  type CertificateAuthority,
} from "../secret-proxy/x509.ts";

export interface SeenRequest {
  sni: string | null;
  method: string;
  target: string;
  headers: HeaderList;
  body: string;
}

function listenOn(server: TcpServer | TlsServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    );
  });
}

function respond(
  socket: TLSSocket,
  status: string,
  headers: HeaderList,
  body: Buffer | string = "",
) {
  const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  socket.write(
    Buffer.concat([
      serializeHead(`HTTP/1.1 ${status}`, [
        ...headers,
        ["Content-Length", String(bytes.length)],
      ]),
      bytes,
    ]),
  );
}

// An HTTPS host for the given names, with certificates from its own CA (the
// test's stand-in for the system roots). Paths:
//   /reflect?v=<value>  the value raw, URL-encoded, base64 and hex in the
//                       body, and raw in an X-Echo header
//   /headers            the request's Authorization in the body
//   /redirect           302 to https://other.stub.test/landing
//   /gzip?v=<value>     the value in a gzip body, whatever Accept-Encoding says
//   /zstd               a body labelled zstd
//   /split?v=<value>    the value split across two chunked writes
//   /big?mb=<n>         n MiB of body, written as fast as the socket takes
//                       it; `bigSent` counts the bytes that went out
//   /sink               reads the head, never the body, never answers
//   anything else       200 "ok"
export async function startHttpsStub(names: string[]) {
  const ca = createCertificateAuthority();
  const issuer = createLeafIssuer(ca, () => true);
  const contexts = new Map(
    names.map((name) => {
      const leaf = issuer.issue(name);
      return [
        name,
        createSecureContext({ cert: leaf.certPem, key: leaf.keyPem }),
      ];
    }),
  );
  const seen: SeenRequest[] = [];
  const counters = { bigSent: 0 };
  const server = createTlsServer(
    {
      SNICallback: (name, done) => done(null, contexts.get(name)),
      ...(() => {
        const leaf = issuer.issue(names[0]);
        return { cert: leaf.certPem, key: leaf.keyPem };
      })(),
    },
    (socket) => void serve(socket),
  );
  const open = new Set<TLSSocket>();
  async function serve(socket: TLSSocket) {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    const reader = new ByteReader(socket);
    try {
      for (;;) {
        const head = await readHead(reader);
        if (!head) return void socket.end();
        const [method, target] = head.startLine.split(" ");
        if (target.startsWith("/sink")) {
          // Reads the head and nothing more: an upload to it stalls.
          seen.push({
            sni:
              (socket as unknown as { servername?: string }).servername || null,
            method,
            target,
            headers: head.headers,
            body: "",
          });
          reader.detach();
          socket.pause();
          return;
        }
        let body = "";
        for await (const piece of readBody(
          reader,
          bodyFraming(head.headers, { strict: true }),
        ))
          body += piece.toString("latin1");
        seen.push({
          sni:
            (socket as unknown as { servername?: string }).servername || null,
          method,
          target,
          headers: head.headers,
          body,
        });
        const url = new URL(target, "https://stub.test");
        const value = url.searchParams.get("v") ?? "";
        const auth =
          head.headers.find(
            ([n]) => n.toLowerCase() === "authorization",
          )?.[1] ?? "";
        if (url.pathname === "/reflect") {
          const text = [
            `raw=${value}`,
            `url=${encodeURIComponent(value)}`,
            `basic=${Buffer.from(`user:${value}`).toString("base64")}`,
            `b64=${Buffer.from(value).toString("base64")}`,
            `hex=${Buffer.from(value).toString("hex")}`,
          ].join("\n");
          respond(socket, "200 OK", [["X-Echo", value]], text);
        } else if (url.pathname === "/headers") {
          respond(socket, "200 OK", [], `authorization=${auth}`);
        } else if (url.pathname === "/redirect") {
          respond(socket, "302 Found", [
            ["Location", "https://other.stub.test/landing"],
          ]);
        } else if (url.pathname === "/gzip") {
          respond(
            socket,
            "200 OK",
            [["Content-Encoding", "gzip"]],
            gzipSync(Buffer.from(`gz=${value}`)),
          );
        } else if (url.pathname === "/zstd") {
          respond(socket, "200 OK", [["Content-Encoding", "zstd"]], "zzzz");
        } else if (url.pathname === "/split") {
          const half = Math.floor(value.length / 2);
          socket.write(
            serializeHead("HTTP/1.1 200 OK", [
              ["Transfer-Encoding", "chunked"],
            ]),
          );
          const first = `a=${value.slice(0, half)}`;
          socket.write(`${first.length.toString(16)}\r\n${first}\r\n`);
          await new Promise((r) => setTimeout(r, 30));
          const second = `${value.slice(half)};`;
          socket.write(
            `${second.length.toString(16)}\r\n${second}\r\n0\r\n\r\n`,
          );
        } else if (url.pathname === "/big") {
          const total = Number(url.searchParams.get("mb") ?? "1") * 1024 * 1024;
          const piece = Buffer.alloc(64 * 1024, 0x61);
          socket.write(
            serializeHead("HTTP/1.1 200 OK", [
              ["Content-Length", String(total)],
            ]),
          );
          counters.bigSent = 0;
          while (counters.bigSent < total && !socket.destroyed) {
            const fits = socket.write(piece);
            counters.bigSent += piece.length;
            if (!fits)
              await new Promise<void>((resolve) => {
                socket.once("drain", resolve);
                socket.once("close", resolve);
              });
          }
        } else if (method === "HEAD") {
          socket.write(
            serializeHead("HTTP/1.1 200 OK", [["Content-Length", "2"]]),
          );
        } else {
          respond(socket, "200 OK", [], "ok");
        }
      }
    } catch {
      socket.destroy();
    }
  }
  const port = await listenOn(server);
  return {
    port,
    ca,
    seen,
    counters,
    // A paused /sink socket never sees its peer close: destroy it here.
    close: () =>
      new Promise<void>((r) => {
        for (const socket of open) socket.destroy();
        server.close(() => r());
      }),
  };
}

// A TCP server that records the bytes each connection sends and echoes them.
export async function startEchoStub() {
  const received: string[] = [];
  const server = createTcpServer((socket) => {
    const index = received.push("") - 1;
    socket.on("error", () => {});
    socket.on("data", (data) => {
      received[index] += data.toString("latin1");
      socket.write(data);
    });
  });
  const port = await listenOn(server);
  return {
    port,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// A company proxy: answers CONNECT for the hosts in `routes` and pipes to
// the stub port given; logs every CONNECT target.
export async function startCompanyProxy(routes: Record<string, number>) {
  const connects: string[] = [];
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    const reader = new ByteReader(socket);
    void (async () => {
      const head = await readHead(reader).catch(() => null);
      if (!head) return void socket.destroy();
      const [, target] = head.startLine.split(" ");
      connects.push(target);
      const port = routes[target];
      if (port === undefined) {
        socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      const upstream: Socket = netConnect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const early = reader.detach();
        if (early.length) upstream.write(early);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      upstream.on("error", () => socket.destroy());
    })();
  });
  const port = await listenOn(server);
  return {
    port,
    connects,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// --- the agent side ---

export interface ProxyResponse {
  status: number;
  headers: HeaderList;
  body: string;
}

// CONNECT through the proxy; resolves with the raw socket after a 200, or
// with the refusal response.
export function connectThrough(
  proxyPort: number,
  authority: string,
): Promise<
  { socket: Socket; reader: ByteReader } | { refused: ProxyResponse }
> {
  // After a 200 the returned reader reads the tunnel (raw tests). tlsThrough
  // detaches it before TLS takes the socket.
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    socket.on("error", reject);
    const reader = new ByteReader(socket);
    readHead(reader).then(async (head) => {
      if (!head) return reject(new Error("proxy closed"));
      const status = Number(head.startLine.split(" ")[1]);
      if (status === 200) return resolve({ socket, reader });
      let body = "";
      for await (const piece of readBody(
        reader,
        bodyFraming(head.headers, { strict: false }),
      ))
        body += piece.toString("latin1");
      resolve({ refused: { status, headers: head.headers, body } });
    }, reject);
  });
}

// TLS through the proxy, trusting `ca` (the office CA). `servername` null
// sends no SNI.
export async function tlsThrough(
  proxyPort: number,
  host: string,
  ca: CertificateAuthority,
  servername: string | null = host,
): Promise<TLSSocket> {
  const tunnel = await connectThrough(proxyPort, `${host}:443`);
  if ("refused" in tunnel)
    throw new Error(`CONNECT refused ${tunnel.refused.status}`);
  tunnel.reader.detach();
  const socket = tlsConnect({
    socket: tunnel.socket,
    ...(servername ? { servername } : {}),
    ca: ca.certPem,
    ALPNProtocols: ["http/1.1"],
    checkServerIdentity: () => undefined,
  });
  tunnel.socket.resume();
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

// Sends raw request bytes and reads one response (or null at close).
export async function exchange(
  socket: TLSSocket,
  reader: ByteReader,
  raw: string,
  method = raw.split(" ")[0],
): Promise<ProxyResponse | null> {
  socket.write(raw);
  for (;;) {
    const head = await readHead(reader).catch(() => null);
    if (!head) return null;
    const status = Number(head.startLine.split(" ")[1]);
    if (status >= 100 && status < 200) continue;
    let body = "";
    const noBody = method === "HEAD" || status === 204 || status === 304;
    for await (const piece of readBody(
      reader,
      bodyFraming(head.headers, { strict: false, noBody }),
    ))
      body += piece.toString("latin1");
    return { status, headers: head.headers, body };
  }
}
