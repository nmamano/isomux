// The HTTP relay, against a real upstream on a real loopback socket (phase 3,
// slice 5).
//
// Everything here drives `relayToApp` directly, with a scratch server on an
// EPHEMERAL port standing in for the app. That is deliberate: the questions
// this file asks - does a gzip response come out intact, does a client hanging
// up reach the app, does a stopped app get a connection - are about the relay
// itself, and answering them through the registry would mean binding ports in
// the production 21000-21999 window for no extra coverage. The end-to-end pins
// that DO need the whole office live in app-host-relay.test.ts.
//
// The strongest assertions in the file are the negative ones: what the app is
// NOT handed (the office's cookies, a client's X-Forwarded-*), and the socket
// that is NOT opened when an app is not running.

import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server as NetServer } from "net";
import {
  gzipSync,
  brotliCompressSync,
  deflateSync,
  zstdCompressSync,
} from "zlib";
import {
  carriesDecodedCoding,
  forwardedForValue,
  relayToApp,
  _testRelayInFlight,
  _testResetRelay,
  APP_RELAY_MAX_CONCURRENT_PER_APP,
} from "../app-proxy.ts";
import {
  APP_BUSY_BODY,
  APP_STOPPED_BODY,
  APP_UNREACHABLE_BODY,
} from "../app-host-responses.ts";
import { createFakeAppSupervisor } from "./fake-app-supervisor.ts";
import type { AppRuntime } from "../app-supervisor.ts";
import type { AppRecord } from "../../shared/types.ts";

const APP_HOST = "hello.office.example";

// What the scratch upstream saw, so a test can assert on the request the APP
// got rather than only on the response the browser got.
interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

interface Upstream {
  port: number;
  seen: SeenRequest[];
  // Requests whose handler observed an abort - the only proof that a client
  // hanging up reached the app rather than being swallowed by the relay.
  aborted: string[];
  stop(): void;
}

const GZIP_TEXT = "compressed ".repeat(40);
const BINARY = new Uint8Array(1024);
for (let i = 0; i < BINARY.length; i++) BINARY[i] = (i * 31) % 256;

function startUpstream(): Upstream {
  const seen: SeenRequest[] = [];
  const aborted: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
      const wantsBody = req.method !== "GET" && req.method !== "HEAD";
      const body = wantsBody ? await req.text() : "";
      seen.push({ method: req.method, path, headers, body });

      switch (path) {
        case "/binary":
          return new Response(BINARY, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        case "/echo":
          return new Response(body, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        case "/gzip": {
          const gz = gzipSync(Buffer.from(GZIP_TEXT));
          return new Response(gz, {
            headers: {
              "Content-Encoding": "gzip",
              "Content-Length": String(gz.length),
              "Content-Type": "text/plain",
            },
          });
        }
        case "/brotli": {
          const br = brotliCompressSync(Buffer.from(GZIP_TEXT));
          return new Response(br, {
            headers: {
              "Content-Encoding": "br",
              "Content-Length": String(br.length),
            },
          });
        }
        case "/shouty-gzip": {
          // `GZIP` is a legal spelling that Bun does NOT decode: the body
          // arrives here still compressed, so the encoding headers are the
          // app's own truth and must survive.
          const gz = gzipSync(Buffer.from(GZIP_TEXT));
          return new Response(gz, {
            headers: {
              "Content-Encoding": "GZIP",
              "Content-Length": String(gz.length),
            },
          });
        }
        case "/opaque-coding":
          // An encoding Bun does not decode: the bytes and both headers are
          // the app's own and must arrive untouched.
          return new Response("rawbytes", {
            headers: { "Content-Encoding": "foo", "Content-Length": "8" },
          });
        case "/head-gzip":
          // HEAD metadata describes the GET representation. There is no body,
          // so nothing was decoded and nothing may be rewritten.
          return new Response(null, {
            headers: {
              "Content-Encoding": "gzip",
              "Content-Length": "12345",
              "Content-Type": "text/html",
            },
          });
        case "/304":
          return new Response(null, {
            status: 304,
            headers: {
              ETag: '"v1"',
              "Content-Encoding": "gzip",
              "Content-Length": "4321",
            },
          });
        case "/204":
          return new Response(null, { status: 204 });
        case "/cookies": {
          const h = new Headers();
          // Two field lines, the first with an Expires date - which contains a
          // comma, so a relay that folds them into one string produces one
          // malformed cookie instead of two good ones.
          h.append(
            "Set-Cookie",
            "sid=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/",
          );
          h.append("Set-Cookie", "theme=dark; Path=/; SameSite=Lax");
          return new Response("ok", { headers: h });
        }
        case "/redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: "/somewhere-else" },
          });
        case "/hop":
          return new Response("ok", {
            headers: {
              Connection: "X-Private, keep-alive",
              "X-Private": "secret",
              "Keep-Alive": "timeout=5",
              "Proxy-Authenticate": "Basic",
              "X-Public": "fine",
            },
          });
        case "/slow-headers":
          await Bun.sleep(2000);
          return new Response("late");
        case "/stall": {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
              // ...and then nothing, ever. The client is still attached and
              // the connection is alive: exactly what abort propagation cannot
              // see.
              await new Promise(() => {});
            },
          });
          return new Response(stream);
        }
        case "/sse": {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              req.signal.addEventListener("abort", () => aborted.push(path));
              try {
                for (let i = 0; i < 50; i++) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${i}\n\n`),
                  );
                  await Bun.sleep(30);
                }
                controller.close();
              } catch {
                // The consumer went away mid-stream; nothing to do.
              }
            },
            cancel() {
              aborted.push(path);
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        default:
          return new Response("ok", {
            headers: { "Content-Type": "text/plain" },
          });
      }
    },
  });
  return {
    port: server.port as number,
    seen,
    aborted,
    stop: () => {
      void server.stop(true);
    },
  };
}

function appRecord(port: number, over: Partial<AppRecord> = {}): AppRecord {
  return {
    name: "hello",
    hostLabel: "hello",
    hostGen: 1,
    port,
    command: "bun run serve.ts",
    cwd: "/tmp",
    dataDir: "/tmp/hello",
    userId: "u1",
    username: "Boss",
    createdBy: "Boss",
    createdAt: 1,
    ...over,
  };
}

// The relay under test, with a supervisor that says what the test wants it to
// say. `state` is what systemd would report for the app.
function relay(
  req: Request,
  opts: {
    app: AppRecord;
    state?: AppRuntime["state"] | "missing";
    supervisorThrows?: boolean;
    peer?: () => string | null | undefined;
    ttfbMs?: number;
    stallMs?: number;
    maxPerApp?: number;
    maxTotal?: number;
  },
): Promise<Response> {
  const fake = createFakeAppSupervisor();
  if (opts.state !== "missing") {
    fake.setRuntime(opts.app.name, {
      state: opts.state ?? "running",
      restartCount: 0,
    });
  }
  const supervisor = opts.supervisorThrows
    ? {
        ...fake,
        states: () => {
          throw new Error("systemctl unavailable");
        },
      }
    : fake;
  return relayToApp(req, {
    app: opts.app,
    host: APP_HOST,
    apps: [opts.app],
    supervisor,
    peer: opts.peer,
    ttfbMs: opts.ttfbMs,
    stallMs: opts.stallMs,
    maxPerApp: opts.maxPerApp,
    maxTotal: opts.maxTotal,
  });
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`https://${APP_HOST}${path}`, init);
}

let up: Upstream | null = null;
afterEach(() => {
  up?.stop();
  up = null;
  _testResetRelay();
});

describe("relay: the app's bytes", () => {
  it("passes a binary body through byte-exact", async () => {
    up = startUpstream();
    const res = await relay(get("/binary"), { app: appRecord(up.port) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(BINARY.length);
    expect(Buffer.from(bytes).equals(Buffer.from(BINARY))).toBe(true);
  });

  it("streams a fixed-length POST body and preserves its framing", async () => {
    // A STREAM body plus the client's own Content-Length, which is what the
    // server hands the relay for an ordinary upload. If the length were dropped
    // the bytes would still arrive, just re-framed as chunked - so the framing
    // is what this asserts, and a buffered body would not be able to tell the
    // difference.
    up = startUpstream();
    const payload = "x".repeat(5000);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const res = await relay(
      get("/echo", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(payload.length),
        },
      }),
      { app: appRecord(up.port) },
    );
    expect(await res.text()).toBe(payload);
    expect(up.seen[0].headers["content-length"]).toBe(String(payload.length));
    expect(up.seen[0].headers["transfer-encoding"]).toBeUndefined();
  });

  it("streams a chunked POST body when the client sent no length", async () => {
    up = startUpstream();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-one;"));
        controller.enqueue(new TextEncoder().encode("chunk-two"));
        controller.close();
      },
    });
    const res = await relay(get("/echo", { method: "POST", body }), {
      app: appRecord(up.port),
    });
    expect(await res.text()).toBe("chunk-one;chunk-two");
    expect(up.seen[0].headers["transfer-encoding"]).toBe("chunked");
    expect(up.seen[0].headers["content-length"]).toBeUndefined();
  });

  it("sends no body on GET or HEAD", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    await relay(get("/plain"), { app });
    await relay(get("/plain", { method: "HEAD" }), { app });
    for (const seen of up.seen) {
      expect(seen.headers["content-length"] ?? "0").toBe("0");
      expect(seen.headers["transfer-encoding"]).toBeUndefined();
    }
  });

  it("does not follow a redirect", async () => {
    up = startUpstream();
    const res = await relay(get("/redirect"), { app: appRecord(up.port) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/somewhere-else");
    // One request: the relay did not chase it.
    expect(up.seen.map((s) => s.path)).toEqual(["/redirect"]);
  });

  it("keeps two Set-Cookie lines separate, comma and all", async () => {
    up = startUpstream();
    const res = await relay(get("/cookies"), { app: appRecord(up.port) });
    expect(res.headers.getSetCookie()).toEqual([
      "sid=abc; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/",
      "theme=dark; Path=/; SameSite=Lax",
    ]);
  });

  it("streams incrementally rather than buffering", async () => {
    up = startUpstream();
    const res = await relay(get("/sse"), { app: appRecord(up.port) });
    const reader = res.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain("data: 0");
    // The whole stream is 50 ticks at 30ms; a buffering relay could not have
    // produced the first one this early.
    expect(firstAt).toBeLessThan(500);
    await reader.cancel();
  });
});

describe("relay: what the app is not handed", () => {
  it("strips every isomux credential cookie and keeps the app's own", async () => {
    up = startUpstream();
    await relay(
      get("/plain", {
        headers: {
          Cookie: [
            "__Host-isomux_app=APPTOKEN",
            "__Host-isomux_session=OFFICETOKEN",
            "isomux_session=LEGACYTOKEN",
            "isomux_session_id=theirs",
            "ISOMUX_SESSION=theirs-too",
            "my__Host-isomux_app=nope",
            "theme=dark",
          ].join("; "),
        },
      }),
      { app: appRecord(up.port) },
    );
    expect(up.seen[0].headers["cookie"]).toBe(
      "isomux_session_id=theirs; ISOMUX_SESSION=theirs-too; my__Host-isomux_app=nope; theme=dark",
    );
  });

  it("sends no Cookie header at all when only ours were present", async () => {
    up = startUpstream();
    await relay(
      get("/plain", { headers: { Cookie: "__Host-isomux_app=APPTOKEN" } }),
      { app: appRecord(up.port) },
    );
    expect(up.seen[0].headers["cookie"]).toBeUndefined();
  });

  it("drops hop-by-hop headers and everything Connection names", async () => {
    up = startUpstream();
    await relay(
      get("/plain", {
        headers: {
          Connection: "X-Secret-Hop, keep-alive",
          "X-Secret-Hop": "must not arrive",
          "Keep-Alive": "timeout=5",
          TE: "trailers",
          Trailer: "X-Thing",
          Upgrade: "h2c",
          "Proxy-Authorization": "Basic abc",
          "X-Ordinary": "arrives",
        },
      }),
      { app: appRecord(up.port) },
    );
    const seen = up.seen[0].headers;
    for (const name of [
      "x-secret-hop",
      "keep-alive",
      "te",
      "trailer",
      "upgrade",
      "proxy-authorization",
    ]) {
      expect({ name, value: seen[name] }).toEqual({
        name,
        value: undefined as string | undefined,
      });
    }
    expect(seen["x-ordinary"]).toBe("arrives");
  });

  it("owns the forwarding headers instead of relaying the client's", async () => {
    up = startUpstream();
    await relay(
      get("/plain", {
        headers: {
          Host: "impostor.example",
          "X-Forwarded-For": "9.9.9.9",
          "X-Forwarded-Proto": "http",
          "X-Forwarded-Host": "impostor.example",
          Forwarded: "for=9.9.9.9;host=impostor.example",
        },
      }),
      { app: appRecord(up.port), peer: () => "203.0.113.7" },
    );
    const seen = up.seen[0].headers;
    expect({
      host: seen["host"],
      xff: seen["x-forwarded-for"],
      proto: seen["x-forwarded-proto"],
      xfh: seen["x-forwarded-host"],
      forwarded: seen["forwarded"],
    }).toEqual({
      host: APP_HOST,
      xff: "203.0.113.7",
      proto: "https",
      xfh: APP_HOST,
      forwarded: undefined as string | undefined,
    });
  });

  it("writes an IPv4-mapped loopback peer the way a proxy writes it", async () => {
    // Bun reports a dual-stack loopback peer as `::ffff:127.0.0.1`. Same
    // address, spelling most XFF parsers have never met.
    up = startUpstream();
    await relay(get("/plain"), {
      app: appRecord(up.port),
      peer: () => "::ffff:127.0.0.1",
    });
    expect(up.seen[0].headers["x-forwarded-for"]).toBe("127.0.0.1");
    // A real IPv6 peer is written bare - the bracketed form belongs to the
    // `Forwarded` header's grammar, not this one.
    expect(forwardedForValue("2001:db8::1")).toBe("2001:db8::1");
    expect(forwardedForValue(null)).toBeNull();
  });

  it("omits X-Forwarded-For when there is no peer to name", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    await relay(get("/plain", { headers: { "X-Forwarded-For": "9.9.9.9" } }), {
      app,
      peer: () => null,
    });
    await relay(get("/plain"), {
      app,
      peer: () => {
        throw new Error("socket gone");
      },
    });
    expect(up.seen.map((s) => s.headers["x-forwarded-for"])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not relay the app's own hop-by-hop headers back", async () => {
    up = startUpstream();
    const res = await relay(get("/hop"), { app: appRecord(up.port) });
    expect({
      priv: res.headers.get("x-private"),
      keepAlive: res.headers.get("keep-alive"),
      proxyAuth: res.headers.get("proxy-authenticate"),
      pub: res.headers.get("x-public"),
    }).toEqual({
      priv: null,
      keepAlive: null,
      proxyAuth: null,
      pub: "fine",
    });
  });
});

describe("relay: content encoding", () => {
  it("drops the encoding headers Bun's fetch has already made untrue", async () => {
    up = startUpstream();
    const res = await relay(get("/gzip"), { app: appRecord(up.port) });
    // Bun decompressed on the way in: forwarding `gzip` plus the COMPRESSED
    // length would hand the browser a lie and a wrong framing.
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe(GZIP_TEXT);
  });

  it("does the same for brotli", async () => {
    up = startUpstream();
    const res = await relay(get("/brotli"), { app: appRecord(up.port) });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe(GZIP_TEXT);
  });

  it("leaves an encoding it did not decode completely alone", async () => {
    up = startUpstream();
    const res = await relay(get("/opaque-coding"), { app: appRecord(up.port) });
    expect(res.headers.get("content-encoding")).toBe("foo");
    expect(res.headers.get("content-length")).toBe("8");
    expect(await res.text()).toBe("rawbytes");
  });

  it("leaves a spelling the runtime does not decode alone, bytes and all", async () => {
    // The trap in the other direction, and the reason the rewrite matches the
    // decoder rather than the HTTP grammar: `GZIP` is a legal way to name the
    // coding, but this runtime hands it over still compressed. Stripping the
    // headers here would leave the browser holding gzip bytes with nothing
    // saying so.
    up = startUpstream();
    const res = await relay(get("/shouty-gzip"), { app: appRecord(up.port) });
    expect(res.headers.get("content-encoding")).toBe("GZIP");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).equals(gzipSync(Buffer.from(GZIP_TEXT)))).toBe(
      true,
    );
  });

  // The assumption the rewrite rests on, pinned against the runtime itself
  // rather than against our own code. If a Bun upgrade widens or narrows what
  // `fetch` decodes, this fails first and names the set to change - the
  // alternative is shipping bodies whose Content-Encoding is a lie.
  it("pins exactly which codings this runtime decodes", async () => {
    const text = "payload ".repeat(20);
    const bodies: Record<string, Buffer> = {
      gzip: gzipSync(Buffer.from(text)),
      br: brotliCompressSync(Buffer.from(text)),
      deflate: deflateSync(Buffer.from(text)),
      zstd: zstdCompressSync(Buffer.from(text)),
    };
    const cases: { header: string; body: keyof typeof bodies }[] = [
      { header: "gzip", body: "gzip" },
      { header: "deflate", body: "deflate" },
      { header: "br", body: "br" },
      { header: "zstd", body: "zstd" },
      { header: " gzip ", body: "gzip" },
      { header: "GZIP", body: "gzip" },
      { header: "Gzip", body: "gzip" },
      { header: "x-gzip", body: "gzip" },
      { header: "identity, gzip", body: "gzip" },
      { header: "foo", body: "gzip" },
    ];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const i = Number(new URL(req.url).pathname.slice(1));
        const body = new Uint8Array(bodies[cases[i].body]);
        return new Response(body, {
          headers: {
            "Content-Encoding": cases[i].header,
            "Content-Length": String(body.length),
          },
        });
      },
    });
    try {
      const observed: Record<string, boolean> = {};
      for (let i = 0; i < cases.length; i++) {
        const res = await fetch(`http://127.0.0.1:${server.port}/${i}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        observed[cases[i].header] = bytes.length === text.length;
      }
      expect(observed).toEqual({
        gzip: true,
        deflate: true,
        br: true,
        zstd: true,
        " gzip ": true,
        GZIP: false,
        Gzip: false,
        "x-gzip": false,
        "identity, gzip": false,
        foo: false,
      });
      // ...and the relay's rule says the same thing about each of them.
      for (const [header, decoded] of Object.entries(observed)) {
        expect({ header, rewrite: carriesDecodedCoding(header) }).toEqual({
          header,
          rewrite: decoded,
        });
      }
    } finally {
      void server.stop(true);
    }
  });

  it("keeps the metadata of a HEAD, which describes a body it never carried", async () => {
    up = startUpstream();
    const res = await relay(get("/head-gzip", { method: "HEAD" }), {
      app: appRecord(up.port),
    });
    expect({
      encoding: res.headers.get("content-encoding"),
      length: res.headers.get("content-length"),
      type: res.headers.get("content-type"),
    }).toEqual({ encoding: "gzip", length: "12345", type: "text/html" });
    expect(await res.text()).toBe("");
  });

  it("keeps the metadata of a 304, which updates a cached representation", async () => {
    up = startUpstream();
    const res = await relay(get("/304"), { app: appRecord(up.port) });
    // Content-Length is NOT asserted here: a 304 carries no body, and the
    // runtime rewrites the length to 0 on a bodyless status whatever we set.
    // The encoding is the one that matters - it describes the cached
    // representation the browser already holds, and the relay must not have
    // treated it as a claim about bytes it decoded.
    expect({
      status: res.status,
      etag: res.headers.get("etag"),
      encoding: res.headers.get("content-encoding"),
    }).toEqual({ status: 304, etag: '"v1"', encoding: "gzip" });
  });

  it("relays a 204 with no body", async () => {
    up = startUpstream();
    const res = await relay(get("/204"), { app: appRecord(up.port) });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("relay: refusing before connecting", () => {
  // The locked constraint, in its strongest form: a raw listener that counts
  // TCP CONNECTIONS, not HTTP requests. A stopped app's port can be squatted by
  // any local process, so the relay must not open a socket to find out.
  async function withCountingListener(
    run: (port: number, connections: () => number) => Promise<void>,
  ): Promise<void> {
    let count = 0;
    const server: NetServer = createServer((socket) => {
      count++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      await run(port, () => count);
    } finally {
      server.close();
    }
  }

  it("refuses every state that is not proof the app is up, without a connection", async () => {
    await withCountingListener(async (port, connections) => {
      const app = appRecord(port);
      for (const state of [
        "stopped",
        "failed",
        "starting",
        "unknown",
        "missing",
      ] as const) {
        const res = await relay(get("/plain"), { app, state });
        expect({ state, status: res.status, body: await res.text() }).toEqual({
          state,
          status: 503,
          body: APP_STOPPED_BODY,
        });
      }
      expect(connections()).toBe(0);
    });
  });

  it("refuses when the supervisor itself cannot answer", async () => {
    await withCountingListener(async (port, connections) => {
      const res = await relay(get("/plain"), {
        app: appRecord(port),
        supervisorThrows: true,
      });
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(APP_STOPPED_BODY);
      expect(connections()).toBe(0);
    });
  });
});

describe("relay: failures", () => {
  it("answers 502 when nothing is listening on the app's port", async () => {
    // A port that was bound and released: nothing is there, so the connection
    // is refused - the shape of a running unit whose process just died.
    const scratch = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("x"),
    });
    const port = scratch.port as number;
    void scratch.stop(true);
    const res = await relay(get("/plain"), { app: appRecord(port) });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(APP_UNREACHABLE_BODY);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("answers 502 when headers do not arrive in time", async () => {
    up = startUpstream();
    const res = await relay(get("/slow-headers"), {
      app: appRecord(up.port),
      ttfbMs: 150,
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(APP_UNREACHABLE_BODY);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("does not cut a stream off at the header deadline", async () => {
    // The TTFB timer is cleared when headers arrive: an SSE stream running long
    // past it is the feature, not a timeout. Several chunks are read, not one -
    // the first can come out of the stream's own queue and would survive an
    // abort that killed everything behind it.
    up = startUpstream();
    const res = await relay(get("/sse"), {
      app: appRecord(up.port),
      ttfbMs: 100,
    });
    const reader = res.body!.getReader();
    await Bun.sleep(300);
    for (let i = 0; i < 4; i++) {
      const chunk = await reader.read();
      expect({ i, done: chunk.done }).toEqual({ i, done: false });
    }
    await reader.cancel();
  });

  it("does not punish a slow client for the app's patience", async () => {
    // BACKPRESSURE, not a stall: the app produced a chunk and nobody has read
    // it yet. A guard that runs while the chunk sits in the queue would abort a
    // healthy app for the crime of being read slowly - and, since no read is
    // outstanding to notice the abort, would strand the permit too.
    up = startUpstream();
    const res = await relay(get("/sse"), {
      app: appRecord(up.port),
      stallMs: 150,
    });
    // Nothing is read for several times the stall window.
    await Bun.sleep(600);
    expect(up.aborted).toEqual([]);
    expect(_testRelayInFlight().total).toBe(1);
    // ...and the stream is still perfectly usable when the client gets around
    // to it.
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    await reader.cancel();
    await Bun.sleep(100);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("tears down a started response that goes silent", async () => {
    up = startUpstream();
    const res = await relay(get("/stall"), {
      app: appRecord(up.port),
      stallMs: 200,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first\n");
    // The app is alive, the client is attached, and nothing is coming: the one
    // failure abort propagation cannot see.
    expect(reader.read()).rejects.toThrow();
    expect(_testRelayInFlight().total).toBe(0);
  });
});

describe("relay: the client going away", () => {
  it("reaches the app when the client cancels the response", async () => {
    up = startUpstream();
    const res = await relay(get("/sse"), { app: appRecord(up.port) });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(150);
    expect(up.aborted.length).toBeGreaterThan(0);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("does no upstream work for a client that is already gone", async () => {
    // The socket can die between the office receiving the request and the relay
    // reaching this point - a state lookup and a permit later. `abort` has
    // already fired by then, and addEventListener does not replay it.
    up = startUpstream();
    const ac = new AbortController();
    ac.abort();
    const res = await relay(
      new Request(`https://${APP_HOST}/plain`, { signal: ac.signal }),
      { app: appRecord(up.port) },
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(APP_UNREACHABLE_BODY);
    // Whatever the runtime does with an aborted fetch, the app was never asked
    // to do anything, and the permit came back.
    expect(up.seen).toEqual([]);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("reaches the app when the request itself is aborted", async () => {
    up = startUpstream();
    const ac = new AbortController();
    const res = await relay(
      new Request(`https://${APP_HOST}/sse`, { signal: ac.signal }),
      { app: appRecord(up.port) },
    );
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    expect(reader.read()).rejects.toThrow();
    await Bun.sleep(150);
    expect(up.aborted.length).toBeGreaterThan(0);
    expect(_testRelayInFlight().total).toBe(0);
  });
});

describe("relay: concurrency permits", () => {
  it("releases on every way out", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    // Normal EOF.
    await (await relay(get("/plain"), { app })).text();
    expect(_testRelayInFlight().total).toBe(0);
    // A null-body response releases without waiting for a stream that will
    // never come.
    await relay(get("/204"), { app });
    expect(_testRelayInFlight().total).toBe(0);
    await relay(get("/head-gzip", { method: "HEAD" }), { app });
    expect(_testRelayInFlight().total).toBe(0);
    // A refusal that never took one at all.
    await relay(get("/plain"), { app, state: "stopped" });
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("holds exactly one permit while a stream is open", async () => {
    up = startUpstream();
    const res = await relay(get("/sse"), { app: appRecord(up.port) });
    const reader = res.body!.getReader();
    await reader.read();
    expect(_testRelayInFlight()).toEqual({ total: 1, perApp: 1 });
    await reader.cancel();
    await Bun.sleep(50);
    expect(_testRelayInFlight()).toEqual({ total: 0, perApp: 0 });
  });

  it("refuses over the shared total even when the app has room", async () => {
    up = startUpstream();
    const a = appRecord(up.port);
    const b = appRecord(up.port, { hostLabel: "other", hostGen: 1 });
    const limits = { maxPerApp: 4, maxTotal: 2 };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (const app of [a, b]) {
      const res = await relay(get("/sse"), { app, ...limits });
      const reader = res.body!.getReader();
      await reader.read();
      readers.push(reader);
    }
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    // Neither app is anywhere near its own cap; the office as a whole is full.
    const refused = await relay(get("/plain"), { app: a, ...limits });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe(APP_BUSY_BODY);
    // A refusal takes nothing: the counters are exactly where they were.
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    for (const reader of readers) await reader.cancel();
    await Bun.sleep(50);
    expect(_testRelayInFlight()).toEqual({ total: 0, perApp: 0 });
  });

  it("refuses over the per-app cap and admits again once one finishes", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    const open: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < APP_RELAY_MAX_CONCURRENT_PER_APP; i++) {
      const res = await relay(get("/sse"), { app });
      const reader = res.body!.getReader();
      await reader.read();
      open.push(reader);
    }
    expect(_testRelayInFlight().perApp).toBe(APP_RELAY_MAX_CONCURRENT_PER_APP);
    const refused = await relay(get("/plain"), { app });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe(APP_BUSY_BODY);

    await open.pop()!.cancel();
    await Bun.sleep(50);
    const admitted = await relay(get("/plain"), { app });
    expect(admitted.status).toBe(200);
    await admitted.text();
    for (const reader of open) await reader.cancel();
    await Bun.sleep(50);
    expect(_testRelayInFlight().total).toBe(0);
  });

  it("counts by issuance, so a reused name gets its own bucket", async () => {
    up = startUpstream();
    // Same NAME, next generation: a deleted app re-registered while an older
    // response is still unwinding. The two must not share a counter, or the
    // dead app's release would decrement the live app's bucket.
    const gen1 = appRecord(up.port);
    const gen2 = appRecord(up.port, { hostLabel: "hello-g2", hostGen: 2 });
    const first = await relay(get("/sse"), { app: gen1 });
    const firstReader = first.body!.getReader();
    await firstReader.read();
    const second = await relay(get("/sse"), { app: gen2 });
    const secondReader = second.body!.getReader();
    await secondReader.read();
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    await firstReader.cancel();
    await Bun.sleep(50);
    expect(_testRelayInFlight()).toEqual({ total: 1, perApp: 1 });
    await secondReader.cancel();
    await Bun.sleep(50);
    expect(_testRelayInFlight()).toEqual({ total: 0, perApp: 0 });
  });
});
