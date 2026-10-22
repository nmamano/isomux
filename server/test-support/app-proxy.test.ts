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
import { _testSetAppRegistrationGeneration } from "../app-registry.ts";
import { officeSessionCookieNames } from "../auth.ts";
import {
  _testResetAppLifecycles,
  retireAppRegistration,
} from "../app-lifecycle.ts";

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
  stop(): Promise<void>;
}

const GZIP_TEXT = "compressed ".repeat(40);

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
                for (let i = 0; i < 100; i++) {
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
    stop: () => server.stop(true),
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
    username: "Morgan",
    createdBy: "Morgan",
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
const SETTLE_DEADLINE_MS = 1_000;

// Bounded polling for a state the relay reaches asynchronously (a permit
// released after a cancel, an abort seen by the app). The deadline only
// diagnoses a state that never comes; it never decides a pass.
async function settlesTo<T>(read: () => T, expected: T): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (Bun.deepEquals(read(), expected)) return;
    await Bun.sleep(5);
  }
  expect(read()).toEqual(expected);
}

const NO_PERMITS = { total: 0, perApp: 0 };

afterEach(async () => {
  await up?.stop();
  up = null;
  _testResetRelay();
  _testResetAppLifecycles();
});

describe("relay: the app's bytes", () => {
  it("streams a POST body with the framing the client used", async () => {
    // A STREAM body, as the server hands the relay for an ordinary upload. With
    // the client's Content-Length the app gets that length; without one it gets
    // chunked framing. A relay that buffered the upload would still deliver the
    // bytes, but would re-frame the chunked one with a length.
    up = startUpstream();
    const app = appRecord(up.port);
    const stream = (...parts: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts)
            controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      });
    const payload = "x".repeat(5000);
    const fixed = await relay(
      get("/echo", {
        method: "POST",
        body: stream(payload),
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(payload.length),
        },
      }),
      { app },
    );
    expect(fixed.status).toBe(200);
    expect(await fixed.text()).toBe(payload);
    const chunked = await relay(
      get("/echo", { method: "POST", body: stream("chunk-one;", "chunk-two") }),
      { app },
    );
    expect(chunked.status).toBe(200);
    expect(await chunked.text()).toBe("chunk-one;chunk-two");
    expect(
      up.seen.map((s) => ({
        length: s.headers["content-length"],
        encoding: s.headers["transfer-encoding"],
      })),
    ).toEqual([
      { length: String(payload.length), encoding: undefined },
      { length: undefined, encoding: "chunked" },
    ]);
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
});

describe("relay: what the app is not handed", () => {
  it("strips every isomux credential cookie and keeps the app's own", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    await relay(
      get("/plain", {
        headers: {
          Cookie: [
            "__Host-isomux_app=APPTOKEN",
            "__Host-isomux_session=OFFICETOKEN",
            "isomux_session=LEGACYTOKEN",
            // This office's own names, and another office's on the same host.
            `${officeSessionCookieNames().host}=OWNHOST`,
            `${officeSessionCookieNames().plain}=OWNPLAIN`,
            "__Host-isomux_session_0123456789ab=OTHERHOST",
            "isomux_session_0123456789ab=OTHERPLAIN",
            "isomux_session_id=theirs",
            "ISOMUX_SESSION=theirs-too",
            "isomux_session_0123456789abc=thirteen",
            "isomux_session_0123456789AB=upper",
            "my__Host-isomux_app=nope",
            "theme=dark",
          ].join("; "),
        },
      }),
      { app },
    );
    // Only isomux credentials: no Cookie header at all, not an empty one.
    await relay(
      get("/plain", {
        headers: {
          Cookie: `__Host-isomux_app=APPTOKEN; ${officeSessionCookieNames().host}=OWNHOST`,
        },
      }),
      { app },
    );
    expect(up.seen.map((s) => s.headers["cookie"] ?? null)).toEqual([
      "isomux_session_id=theirs; ISOMUX_SESSION=theirs-too; isomux_session_0123456789abc=thirteen; isomux_session_0123456789AB=upper; my__Host-isomux_app=nope; theme=dark",
      null,
    ]);
  });

  it("drops hop-by-hop headers and everything Connection names, both ways", async () => {
    // The runtime forwards every one of these itself (measured on Bun 1.4.2),
    // so each absence below is the relay's doing.
    up = startUpstream();
    const res = await relay(
      get("/hop", {
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
    expect({
      secretHop: seen["x-secret-hop"],
      keepAlive: seen["keep-alive"],
      te: seen["te"],
      trailer: seen["trailer"],
      upgrade: seen["upgrade"],
      proxyAuth: seen["proxy-authorization"],
      ordinary: seen["x-ordinary"],
    }).toEqual({
      secretHop: undefined,
      keepAlive: undefined,
      te: undefined,
      trailer: undefined,
      upgrade: undefined,
      proxyAuth: undefined,
      ordinary: "arrives",
    });
    // ...and the app's own hop-by-hop headers stay off the browser's response.
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

  it("owns the forwarding headers and names only the real peer", async () => {
    // Every request carries a client's forged forwarding headers. The relay
    // writes its own Host, proto and forwarded host, and X-Forwarded-For only
    // from the socket peer: unwrapped from the IPv4-mapped form Bun reports
    // for a dual-stack loopback peer, a real IPv6 peer written bare (brackets
    // belong to the `Forwarded` grammar), and no header at all when there is
    // no peer to name.
    up = startUpstream();
    const app = appRecord(up.port);
    const cases: {
      peer: () => string | null;
      xff: string | undefined;
    }[] = [
      { peer: () => "203.0.113.7", xff: "203.0.113.7" },
      { peer: () => "::ffff:127.0.0.1", xff: "127.0.0.1" },
      { peer: () => "2001:db8::1", xff: "2001:db8::1" },
      { peer: () => null, xff: undefined },
      {
        peer: () => {
          throw new Error("socket gone");
        },
        xff: undefined,
      },
    ];
    for (const { peer } of cases) {
      const res = await relay(
        get("/plain", {
          headers: {
            Host: "impostor.example",
            "X-Forwarded-For": "9.9.9.9",
            "X-Forwarded-Proto": "http",
            "X-Forwarded-Host": "impostor.example",
            Forwarded: "for=9.9.9.9;host=impostor.example",
          },
        }),
        { app, peer },
      );
      expect(res.status).toBe(200);
    }
    expect(
      up.seen.map(({ headers }) => ({
        host: headers["host"],
        xff: headers["x-forwarded-for"],
        proto: headers["x-forwarded-proto"],
        xfh: headers["x-forwarded-host"],
        forwarded: headers["forwarded"],
      })),
    ).toEqual(
      cases.map(({ xff }) => ({
        host: APP_HOST,
        xff,
        proto: "https",
        xfh: APP_HOST,
        forwarded: undefined,
      })),
    );
  });
});

describe("relay: content encoding", () => {
  // Exercise the relay against real bytes, including coding lists that a
  // runtime might decode partly. This must pass on installed Bun 1.3.11 and
  // the new 1.4.2 pin without a version-dependent decoder list.
  it("preserves aliases, case, stacked codings and unknown codings byte for byte", async () => {
    const raw = Buffer.from("payload ".repeat(20));
    const gzip = gzipSync(raw);
    const brotli = brotliCompressSync(raw);
    const cases: { header: string; body: Buffer<ArrayBuffer> }[] = [
      { header: "gzip", body: gzip },
      { header: "deflate", body: deflateSync(raw) },
      { header: "br", body: brotli },
      { header: "zstd", body: zstdCompressSync(raw) },
      { header: " gzip ", body: gzip },
      { header: "GZIP", body: gzip },
      { header: "Gzip", body: gzip },
      { header: "x-gzip", body: gzip },
      { header: "Deflate", body: deflateSync(raw) },
      { header: "BR", body: brotli },
      { header: "identity", body: raw },
      { header: "identity, gzip", body: gzip },
      { header: "gzip, identity", body: gzip },
      { header: "gzip, br", body: brotliCompressSync(gzip) },
      { header: "br, gzip", body: gzipSync(brotli) },
      { header: "foo", body: raw },
      { header: "foo, gzip", body: gzip },
      { header: "gzip, foo", body: gzip },
    ];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const entry = cases[Number(new URL(req.url).pathname.slice(1))];
        return new Response(new Uint8Array(entry.body), {
          headers: {
            "Content-Encoding": entry.header,
            "Content-Length": String(entry.body.length),
          },
        });
      },
    });
    try {
      for (let i = 0; i < cases.length; i++) {
        const entry = cases[i];
        const res = await relay(get(`/${i}`), { app: appRecord(server.port!) });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBe(entry.header.trim());
        expect(res.headers.get("content-length")).toBe(
          String(entry.body.length),
        );
        expect(Buffer.from(await res.arrayBuffer())).toEqual(entry.body);
      }
    } finally {
      void server.stop(true);
    }
  });

  it("lets the downstream HTTP client decode the app response", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    const downstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => relay(get("/gzip"), { app }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${downstream.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(await res.text()).toBe(GZIP_TEXT);
    } finally {
      void downstream.stop(true);
    }
  });

  it("keeps the metadata of a bodyless HEAD and 304, which describe a body they never carried", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    const head = await relay(get("/head-gzip", { method: "HEAD" }), { app });
    expect({
      status: head.status,
      encoding: head.headers.get("content-encoding"),
      length: head.headers.get("content-length"),
      type: head.headers.get("content-type"),
      body: await head.text(),
    }).toEqual({
      status: 200,
      encoding: "gzip",
      length: "12345",
      type: "text/html",
      body: "",
    });
    // A 304 updates a cached representation: its encoding describes what the
    // browser already holds. Content-Length is NOT asserted: the runtime
    // rewrites it to 0 on a bodyless status whatever the relay sets.
    const notModified = await relay(get("/304"), { app });
    expect({
      status: notModified.status,
      etag: notModified.headers.get("etag"),
      encoding: notModified.headers.get("content-encoding"),
    }).toEqual({ status: 304, etag: '"v1"', encoding: "gzip" });
  });
});

describe("relay: refusing before connecting", () => {
  // The locked constraint, in its strongest form: a raw listener that counts
  // TCP CONNECTIONS, not HTTP requests. A stopped app's port can be squatted by
  // any local process, so the relay must not open a socket to find out.
  it("refuses every state that is not proof the app is up, without a connection", async () => {
    let count = 0;
    const server: NetServer = createServer((socket) => {
      count++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const app = appRecord((server.address() as { port: number }).port);
      const cases: {
        state?: AppRuntime["state"] | "missing";
        supervisorThrows?: boolean;
      }[] = [
        { state: "stopped" },
        { state: "failed" },
        { state: "starting" },
        { state: "unknown" },
        { state: "missing" },
        // The supervisor itself cannot answer.
        { supervisorThrows: true },
      ];
      for (const opts of cases) {
        const res = await relay(get("/plain"), { app, ...opts });
        expect({ ...opts, status: res.status, body: await res.text() }).toEqual(
          { ...opts, status: 503, body: APP_STOPPED_BODY },
        );
      }
      expect(count).toBe(0);
      expect(_testRelayInFlight()).toEqual(NO_PERMITS);
    } finally {
      server.close();
    }
  });
});

describe("relay: failures", () => {
  it("answers 502 when the app cannot be reached or its headers do not arrive in time", async () => {
    // A port that was bound and released: nothing is there, so the connection
    // is refused - the shape of a running unit whose process just died.
    const scratch = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("x"),
    });
    const closedPort = scratch.port as number;
    void scratch.stop(true);
    const refused = await relay(get("/plain"), { app: appRecord(closedPort) });
    expect(refused.status).toBe(502);
    expect(await refused.text()).toBe(APP_UNREACHABLE_BODY);
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);

    up = startUpstream();
    const slow = await relay(get("/slow-headers"), {
      app: appRecord(up.port),
      ttfbMs: 150,
    });
    expect(slow.status).toBe(502);
    expect(await slow.text()).toBe(APP_UNREACHABLE_BODY);
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
  });

  it("does not cut a stream off at the header deadline", async () => {
    // The TTFB timer is cleared when headers arrive: an SSE stream running long
    // past it is the feature, not a timeout. Keep reading until well after the
    // deadline: the first chunk can come out of the stream's own queue and
    // would survive an abort that killed everything behind it. The headers
    // arriving well inside the deadline is a precondition, asserted so that a
    // loaded box fails here rather than as a fake stream defect (15e23dd3).
    const ttfbMs = 1500;
    const mustStreamPastMs = ttfbMs + 250;
    const started = performance.now();
    up = startUpstream();
    const res = await relay(get("/sse"), {
      app: appRecord(up.port),
      ttfbMs,
    });
    const headersAtMs = performance.now() - started;
    expect(res.status).toBe(200);
    expect(headersAtMs).toBeLessThan(ttfbMs / 2);
    const reader = res.body!.getReader();
    let chunksRead = 0;
    while (performance.now() - started < mustStreamPastMs) {
      let readError: string | undefined;
      const chunk = await reader.read().catch((error: unknown) => {
        readError = String(error);
        return { done: true, value: undefined };
      });
      expect({ done: chunk.done, error: readError }).toEqual({
        done: false,
        error: undefined,
      });
      chunksRead++;
    }
    expect(chunksRead).toBeGreaterThan(0);
    expect(performance.now() - started).toBeGreaterThan(ttfbMs);
    await reader.cancel();
  });

  it("does not punish a slow client for the app's patience", async () => {
    // BACKPRESSURE, not a stall: the app produced a chunk and nobody has read
    // it yet. A guard that runs while the chunk sits in the queue would abort a
    // healthy app for the crime of being read slowly - and, since no read is
    // outstanding to notice the abort, would strand the permit too. Proving a
    // timer does NOT fire takes waiting past it: four stall windows here.
    up = startUpstream();
    const res = await relay(get("/sse"), {
      app: appRecord(up.port),
      stallMs: 150,
    });
    expect(res.status).toBe(200);
    await Bun.sleep(600);
    expect(up.aborted).toEqual([]);
    expect(_testRelayInFlight().total).toBe(1);
    // ...and the stream is still perfectly usable when the client gets around
    // to it.
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    await reader.cancel();
    await settlesTo(_testRelayInFlight, NO_PERMITS);
  });

  it("tears down a started response that goes silent", async () => {
    up = startUpstream();
    const res = await relay(get("/stall"), {
      app: appRecord(up.port),
      stallMs: 200,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first\n");
    // The app is alive, the client is attached, and nothing is coming: the one
    // failure abort propagation cannot see.
    expect(
      await reader.read().then(
        () => "resolved",
        () => "rejected",
      ),
    ).toBe("rejected");
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
  });
});

describe("relay: the client going away", () => {
  it("reaches the app when the client cancels the response", async () => {
    up = startUpstream();
    const res = await relay(get("/sse"), { app: appRecord(up.port) });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(_testRelayInFlight()).toEqual({ total: 1, perApp: 1 });
    await reader.cancel();
    await settlesTo(() => up!.aborted.includes("/sse"), true);
    await settlesTo(_testRelayInFlight, NO_PERMITS);
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
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
  });

  it("reaches the app when the request itself is aborted", async () => {
    up = startUpstream();
    const ac = new AbortController();
    const res = await relay(
      new Request(`https://${APP_HOST}/sse`, { signal: ac.signal }),
      { app: appRecord(up.port) },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ac.abort();
    expect(
      await reader.read().then(
        () => "resolved",
        () => "rejected",
      ),
    ).toBe("rejected");
    await settlesTo(() => up!.aborted.includes("/sse"), true);
    await settlesTo(_testRelayInFlight, NO_PERMITS);
  });
});

describe("relay: concurrency permits", () => {
  it("releases on every way out", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    // Normal EOF.
    const normal = await relay(get("/plain"), { app });
    expect(normal.status).toBe(200);
    await normal.text();
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
    // A null-body response releases without waiting for a stream that will
    // never come, and still carries its status.
    const noContent = await relay(get("/204"), { app });
    expect({ status: noContent.status, body: await noContent.text() }).toEqual({
      status: 204,
      body: "",
    });
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
    await relay(get("/head-gzip", { method: "HEAD" }), { app });
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
    // A refusal that never took one at all.
    expect((await relay(get("/plain"), { app, state: "stopped" })).status).toBe(
      503,
    );
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
  });

  it("refuses over the shared total even when the app has room", async () => {
    up = startUpstream();
    const a = appRecord(up.port);
    const b = appRecord(up.port, { hostLabel: "other", hostGen: 1 });
    const limits = { maxPerApp: 4, maxTotal: 2 };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (const app of [a, b]) {
      const res = await relay(get("/sse"), { app, ...limits });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      readers.push(reader);
    }
    // One open stream holds exactly one permit.
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    // Neither app is anywhere near its own cap; the office as a whole is full.
    const refused = await relay(get("/plain"), { app: a, ...limits });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe(APP_BUSY_BODY);
    // A refusal takes nothing: the counters are exactly where they were.
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    for (const reader of readers) await reader.cancel();
    await settlesTo(_testRelayInFlight, NO_PERMITS);
  });

  it("refuses over the per-app cap and admits again once one finishes", async () => {
    up = startUpstream();
    const app = appRecord(up.port);
    const open = await Promise.all(
      Array.from({ length: APP_RELAY_MAX_CONCURRENT_PER_APP }, async () => {
        const res = await relay(get("/sse"), { app });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        await reader.read();
        return reader;
      }),
    );
    expect(_testRelayInFlight().perApp).toBe(APP_RELAY_MAX_CONCURRENT_PER_APP);
    const refused = await relay(get("/plain"), { app });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe(APP_BUSY_BODY);

    await open.pop()!.cancel();
    await settlesTo(_testRelayInFlight, {
      total: APP_RELAY_MAX_CONCURRENT_PER_APP - 1,
      perApp: APP_RELAY_MAX_CONCURRENT_PER_APP - 1,
    });
    const admitted = await relay(get("/plain"), { app });
    expect(admitted.status).toBe(200);
    await admitted.text();
    await Promise.all(open.map((reader) => reader.cancel()));
    await settlesTo(_testRelayInFlight, NO_PERMITS);
  });

  it("counts by registration identity, so a reused name gets its own bucket", async () => {
    up = startUpstream();
    // Same name and public origin, next registration: a deleted app
    // re-registered while an older response is still unwinding. The two must
    // not share a counter, or the dead app's release would decrement the live
    // app's bucket.
    const gen1 = appRecord(up.port);
    const gen2 = appRecord(up.port);
    _testSetAppRegistrationGeneration(gen2, 2);
    const first = await relay(get("/sse"), { app: gen1 });
    expect(first.status).toBe(200);
    const firstReader = first.body!.getReader();
    await firstReader.read();
    const second = await relay(get("/sse"), { app: gen2 });
    expect(second.status).toBe(200);
    const secondReader = second.body!.getReader();
    await secondReader.read();
    expect(_testRelayInFlight()).toEqual({ total: 2, perApp: 1 });
    await firstReader.cancel();
    await settlesTo(_testRelayInFlight, { total: 1, perApp: 1 });
    await secondReader.cancel();
    await settlesTo(_testRelayInFlight, NO_PERMITS);
  });

  it("retires a live stream synchronously, before its name and port can be reused", async () => {
    // The delete path retires the registration and then frees the name and
    // port in the same turn. The old response must be gone by then - permit
    // back, browser stream aborted, connection to the old port closed - while
    // the app on that port is still running.
    up = startUpstream();
    const retired = appRecord(up.port);
    const oldResponse = await relay(get("/sse"), { app: retired });
    expect(oldResponse.status).toBe(200);
    const oldReader = oldResponse.body!.getReader();
    expect((await oldReader.read()).done).toBe(false);
    expect(_testRelayInFlight()).toEqual({ total: 1, perApp: 1 });

    retireAppRegistration(retired);
    expect(_testRelayInFlight()).toEqual(NO_PERMITS);
    const ended = await oldReader.read().then(
      () => null,
      (error: unknown) => (error as Error).name,
    );
    expect(ended).toBe("AbortError");
    await settlesTo(() => up!.aborted.includes("/sse"), true);
  });
});
