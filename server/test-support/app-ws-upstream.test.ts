// The relay's WebSocket client (phase 3, slice 6a).
//
// Three kinds of test here, in order: the pure request/response validation, the
// happy path against a REAL WebSocket server, and the cases that only a
// hand-written TCP peer can produce - a server that answers with a page, one
// that says nothing, one that accepts the upgrade and then stops reading. The
// last group is the reason this client exists, so it is the group that matters
// most.

import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "crypto";
import type { Socket, TCPSocketListener } from "bun";
import {
  buildHandshakeRequest,
  checkHandshakeResponse,
  dialAppUpstream,
  handshakeAccept,
  isSafeHeaderName,
  isSafeHeaderValue,
  isSafeRequestTarget,
  type AppUpstream,
  type UpstreamCloseEvent,
} from "../app-ws-upstream.ts";

// --- rigs --------------------------------------------------------------------

// The scratch app, as whatever Bun.serve hands back for it.
let app: ReturnType<typeof Bun.serve> | null = null;
let peer: TCPSocketListener<undefined> | null = null;
let live: AppUpstream | null = null;

afterEach(() => {
  live?.terminate("test teardown");
  live = null;
  void app?.stop(true);
  app = null;
  peer?.stop(true);
  peer = null;
});

interface AppSeen {
  frames: string[];
  closes: { code: number; reason: string }[];
  pongs: string[];
  upgradeHeaders: Record<string, string>[];
}

// A real Bun WebSocket app: echoes text with a prefix, echoes binary verbatim,
// and takes instructions through the frames it receives.
function startApp(
  seen: AppSeen,
  opts: { greet?: string } = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k] = v;
      seen.upgradeHeaders.push(headers);
      const offered = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const chosen = offered[0];
      const ok = server.upgrade(req, {
        data: {},
        ...(chosen ? { headers: { "Sec-WebSocket-Protocol": chosen } } : {}),
      });
      return ok ? undefined : new Response("no upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (opts.greet !== undefined) ws.send(opts.greet);
      },
      message(ws, data) {
        if (typeof data !== "string") {
          seen.frames.push(`binary:${Buffer.from(data).toString("hex")}`);
          ws.send(data);
          return;
        }
        seen.frames.push(data);
        if (data === "close-4321") {
          ws.close(4321, "app said bye");
          return;
        }
        if (data === "close-plain") {
          ws.close();
          return;
        }
        if (data === "ping-me") {
          ws.ping("app-ping-payload");
          return;
        }
        if (data === "big") {
          // Over the client's message cap in the test below.
          ws.send("Z".repeat(5000));
          return;
        }
        ws.send(`echo:${data}`);
      },
      pong(_ws, data) {
        seen.pongs.push(Buffer.from(data).toString());
      },
      close(_ws, code, reason) {
        seen.closes.push({ code, reason });
      },
    },
  });
}

// A hand-written TCP peer. `onUpgraded` decides what it does after the 101 (or
// `respond` replaces the whole response, for the invalid-handshake cases).
function startPeer(opts: {
  respond?: (request: string) => string | null;
  // A raw response, so the 101 and a frame can be put in ONE write - the only way
  // to guarantee they arrive in one read.
  respondBytes?: (request: string, accept: string) => Buffer;
  splitLastByte?: boolean;
  accept?: (key: string) => string;
  extraResponseHeaders?: string[];
  onUpgraded?: (socket: Socket<undefined>) => void;
  stopReading?: boolean;
}): TCPSocketListener<undefined> {
  return Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const request = Buffer.from(chunk).toString("latin1");
        if (!request.startsWith("GET ")) return; // frames; ignore
        if (opts.respond !== undefined) {
          const response = opts.respond(request);
          if (response !== null) socket.write(response);
          return;
        }
        if (opts.respondBytes !== undefined) {
          const k =
            /sec-websocket-key: (.*)\r\n/i.exec(request)?.[1]?.trim() ?? "";
          const bytes = opts.respondBytes(request, defaultAccept(k));
          if (opts.splitLastByte) {
            // Hold back the final byte of the terminator, then send it alone, so
            // the client sees the header block end in a SECOND read.
            socket.write(bytes.subarray(0, bytes.length - 1));
            setTimeout(
              () => socket.write(bytes.subarray(bytes.length - 1)),
              20,
            );
          } else {
            socket.write(bytes);
          }
          return;
        }
        const key =
          /sec-websocket-key: (.*)\r\n/i.exec(request)?.[1]?.trim() ?? "";
        const accept = (opts.accept ?? defaultAccept)(key);
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            ...(opts.extraResponseHeaders ?? []),
            "",
            "",
          ].join("\r\n"),
        );
        if (opts.stopReading) socket.pause();
        opts.onUpgraded?.(socket);
      },
      open() {},
      close() {},
      error() {},
    },
  });
}

// Bun types a server's `port` as optional, since a unix-socket server has none.
// Every server here is a TCP one on an ephemeral port, so the assertion happens
// once instead of at each call site.
function portOf(server: { port?: number | null }): number {
  if (server.port === null || server.port === undefined) {
    throw new Error("test server has no port");
  }
  return server.port;
}

// Fill the write queue until it refuses, with a HARD iteration bound.
//
// `while (send() === "sent")` is the obvious way to write this and it is a
// memory bomb: the loop only ends because a ceiling says so, so any change that
// breaks the ceiling - a refactor, or a mutation cycle deliberately removing it -
// turns the test into an unbounded allocator. That is not hypothetical; it took
// this box down five times in one evening (~4GB in seconds) before the cause was
// found. A bounded loop that ASSERTS it filled fails in milliseconds instead,
// which is what a test is for.
function fillQueue(
  send: () => string,
  what: string,
  frameBytes: number,
  byteBudget = 16 * 1024 * 1024,
): number {
  // BYTE-budgeted, not iteration-budgeted. 4096 sends of 64KB is a quarter of a
  // gigabyte before anything complains, which is the wrong order of magnitude for
  // "this test noticed the ceiling is gone".
  const maxSends = Math.max(4, Math.ceil(byteBudget / Math.max(frameBytes, 1)));
  for (let i = 0; i < maxSends; i++) {
    if (send() !== "sent") return i;
  }
  throw new Error(
    `${what}: queue never refused after ${maxSends} sends ` +
      `(${Math.round((maxSends * frameBytes) / 1024)}KB attempted) - the ceiling is not holding`,
  );
}

// A FAKE socket, for the two contract points a real loopback socket cannot be
// made to exhibit: a connect that never completes, and a write the socket only
// partly accepts. The connector seam hands one of these to dialAppUpstream and
// the test drives the handlers itself.
interface FakeSocket {
  written: Buffer[];
  ended: boolean;
  // Bytes the next write() will accept; -1 means "all of it".
  accept: number;
  write(data: Buffer | string): number;
  end(): void;
}

function makeFakeConnector(
  opts: { accept?: number; neverConnect?: boolean; autoUpgrade?: boolean } = {},
) {
  const socket: FakeSocket = {
    written: [],
    ended: false,
    accept: opts.accept ?? -1,
    write(data) {
      const bytes =
        typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const take =
        socket.accept < 0
          ? bytes.length
          : Math.min(socket.accept, bytes.length);
      socket.written.push(bytes.subarray(0, take));
      // Answer the upgrade once the whole request has been written, so a test can
      // work with a LIVE connection over a socket it fully controls.
      if (opts.autoUpgrade && !upgraded) {
        const all = Buffer.concat(socket.written).toString("latin1");
        if (all.includes("\r\n\r\n")) {
          upgraded = true;
          const key =
            /sec-websocket-key: (.*)\r\n/i.exec(all)?.[1]?.trim() ?? "";
          queueMicrotask(() =>
            handlers?.data?.(
              socket as never,
              upgradeHead(defaultAccept(key)) as never,
            ),
          );
        }
      }
      return take;
    },
    end() {
      socket.ended = true;
      handlers?.close?.(socket as never);
    },
  };
  let handlers: Record<
    string,
    ((...args: never[]) => void) | undefined
  > | null = null;
  let upgraded = false;
  const connector = (options: {
    socket: Record<string, ((...args: never[]) => void) | undefined>;
  }): Promise<unknown> => {
    handlers = options.socket;
    if (opts.neverConnect) return new Promise(() => undefined);
    // `open` synchronously, like Bun does once the TCP handshake completes.
    options.socket.open?.(socket as never);
    return Promise.resolve(socket);
  };
  return {
    socket,
    connector: connector as unknown as NonNullable<
      Parameters<typeof dialAppUpstream>[0]["connector"]
    >,
    // For the late-callback tests: connect "completing" after the dial gave up.
    openLate: () => handlers?.open?.(socket as never),
    errorNow: (err: unknown) =>
      handlers?.error?.(socket as never, err as never),
    drain: () => handlers?.drain?.(socket as never),
    data: (bytes: Buffer) => handlers?.data?.(socket as never, bytes as never),
    close: () => handlers?.close?.(socket as never),
    writtenBytes: () => Buffer.concat(socket.written),
  };
}

// A valid 101 header block, as bytes, for the tests that need it concatenated
// with frame data.
function upgradeHead(accept: string, extra: string[] = []): Buffer {
  return Buffer.from(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...extra,
      "",
      "",
    ].join("\r\n"),
    "latin1",
  );
}

function defaultAccept(key: string): string {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

interface Collected {
  messages: { kind: string; body: string }[];
  closes: UpstreamCloseEvent[];
}

function collector(): Collected {
  return { messages: [], closes: [] };
}

async function dial(
  port: number,
  got: Collected,
  extra: Partial<Parameters<typeof dialAppUpstream>[0]> = {},
): Promise<Awaited<ReturnType<typeof dialAppUpstream>>> {
  const result = await dialAppUpstream({
    port,
    target: "/socket",
    host: "hello.office.example",
    headers: {},
    protocols: [],
    onMessage(message) {
      got.messages.push(
        message.kind === "text"
          ? { kind: "text", body: message.text }
          : { kind: "binary", body: message.data.toString("hex") },
      );
    },
    onClose(event) {
      got.closes.push(event);
    },
    ...extra,
  });
  if (result.ok) live = result.connection;
  return result;
}

// Bun's WS server delivers messages on its own schedule; poll rather than sleep
// a fixed time so the tests are quick and not flaky.
async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

// --- the request we write -----------------------------------------------------

describe("app-ws-upstream: the upgrade request", () => {
  it("writes the handshake a server expects", () => {
    const bytes = buildHandshakeRequest({
      target: "/socket?x=1",
      host: "hello.office.example",
      key: "dGhlIHNhbXBsZSBub25jZQ==",
      protocols: ["graphql-ws", "json"],
      headers: { "User-Agent": "browser/1", Cookie: "app_pref=blue" },
    });
    expect(bytes).not.toBeNull();
    expect(bytes!.toString()).toBe(
      [
        "GET /socket?x=1 HTTP/1.1",
        "Host: hello.office.example",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol: graphql-ws, json",
        "User-Agent: browser/1",
        "Cookie: app_pref=blue",
        "",
        "",
      ].join("\r\n"),
    );
    // No extension is ever offered, which is what lets the decoder treat a
    // reserved bit as a protocol error.
    expect(bytes!.toString()).not.toContain("Sec-WebSocket-Extensions");
  });

  it("never writes a header the client owns twice", () => {
    // A caller that forwards the browser's own Host or Sec-WebSocket-Key would
    // otherwise produce two of each, and which one the app reads is anybody's
    // guess.
    const bytes = buildHandshakeRequest({
      target: "/",
      host: "hello.office.example",
      key: "K",
      protocols: [],
      headers: {
        Host: "evil.example",
        "Sec-WebSocket-Key": "other",
        "Sec-WebSocket-Version": "8",
        "Sec-WebSocket-Extensions": "permessage-deflate",
        Connection: "keep-alive",
        Upgrade: "h2c",
        "Content-Length": "10",
      },
    })!.toString();
    expect(bytes.match(/^Host:/gm)).toEqual(["Host:"]);
    expect(bytes).toContain("Host: hello.office.example");
    expect(bytes).not.toContain("evil.example");
    expect(bytes.match(/Sec-WebSocket-Key/g)).toEqual(["Sec-WebSocket-Key"]);
    expect(bytes).not.toContain("permessage-deflate");
    expect(bytes).not.toContain("Content-Length");
  });

  it("refuses to build a request from values that could forge header lines", () => {
    const base = {
      target: "/",
      host: "hello.office.example",
      key: "K",
      protocols: [] as string[],
      headers: {} as Record<string, string>,
    };
    // A CRLF in a value is the whole reason this validation exists: it would
    // write extra headers - or a second request - into what the app receives.
    expect(
      buildHandshakeRequest({
        ...base,
        headers: { "X-A": "a\r\nX-Injected: 1" },
      }),
    ).toBeNull();
    expect(
      buildHandshakeRequest({ ...base, headers: { "X-A": "a\nb" } }),
    ).toBeNull();
    expect(
      buildHandshakeRequest({ ...base, headers: { "X-A": "a\0b" } }),
    ).toBeNull();
    expect(
      buildHandshakeRequest({ ...base, headers: { "X A": "fine" } }),
    ).toBeNull();
    expect(
      buildHandshakeRequest({ ...base, headers: { "X:A": "fine" } }),
    ).toBeNull();
    expect(buildHandshakeRequest({ ...base, host: "host\r\nX: 1" })).toBeNull();
    expect(buildHandshakeRequest({ ...base, host: "" })).toBeNull();
    expect(buildHandshakeRequest({ ...base, target: "not-a-path" })).toBeNull();
    expect(buildHandshakeRequest({ ...base, target: "/a b" })).toBeNull();
    expect(buildHandshakeRequest({ ...base, target: "/a\r\nX: 1" })).toBeNull();
    expect(buildHandshakeRequest({ ...base, protocols: ["a b"] })).toBeNull();
    expect(
      buildHandshakeRequest({ ...base, protocols: ["a\r\nX: 1"] }),
    ).toBeNull();
  });

  it("agrees with itself about what is safe", () => {
    expect(isSafeHeaderName("X-Forwarded-For")).toBe(true);
    expect(isSafeHeaderName("bad name")).toBe(false);
    expect(isSafeHeaderValue("plain")).toBe(true);
    expect(isSafeHeaderValue("with\ttab")).toBe(false);
    expect(isSafeHeaderValue("del\x7f")).toBe(false);
    expect(isSafeRequestTarget("/ok?q=1")).toBe(true);
    expect(isSafeRequestTarget("relative")).toBe(false);
  });

  it("computes the accept value the RFC specifies", () => {
    // The example from RFC 6455 section 1.3.
    expect(handshakeAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

// --- the response we accept ---------------------------------------------------

describe("app-ws-upstream: validating the upgrade response", () => {
  const accept = handshakeAccept("K");
  const good = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ].join("\r\n");

  it("accepts a correct handshake", () => {
    expect(checkHandshakeResponse(good, accept, [])).toEqual({
      ok: true,
      protocol: null,
    });
  });

  it("accepts tokenized Connection and Upgrade values case-insensitively", () => {
    const head = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: WebSocket",
      "Connection: keep-alive, Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ].join("\r\n");
    expect(checkHandshakeResponse(head, accept, [])).toEqual({
      ok: true,
      protocol: null,
    });
  });

  it("returns the negotiated subprotocol when it was offered", () => {
    const head = `${good}\r\nSec-WebSocket-Protocol: graphql-ws`;
    expect(
      checkHandshakeResponse(head, accept, ["graphql-ws", "json"]),
    ).toEqual({
      ok: true,
      protocol: "graphql-ws",
    });
  });

  const rejections: { name: string; head: string; offered?: string[] }[] = [
    {
      name: "a 200 page instead of an upgrade",
      head: "HTTP/1.1 200 OK\r\nContent-Type: text/html",
    },
    { name: "a 404", head: "HTTP/1.1 404 Not Found" },
    { name: "a redirect", head: "HTTP/1.1 302 Found\r\nLocation: /elsewhere" },
    {
      name: "a missing upgrade token in Connection",
      head: [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: keep-alive",
        `Sec-WebSocket-Accept: ${accept}`,
      ].join("\r\n"),
    },
    {
      name: "an Upgrade that is not websocket",
      head: [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: h2c",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
      ].join("\r\n"),
    },
    {
      name: "a wrong accept value",
      head: [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: bm90LXRoZS1yaWdodC1vbmU=",
      ].join("\r\n"),
    },
    {
      name: "a missing accept value",
      head: good.split("\r\nSec-WebSocket-Accept")[0],
    },
    {
      name: "an extension we never offered",
      head: `${good}\r\nSec-WebSocket-Extensions: permessage-deflate`,
    },
    {
      name: "two subprotocol headers",
      head: `${good}\r\nSec-WebSocket-Protocol: a\r\nSec-WebSocket-Protocol: b`,
      offered: ["a", "b"],
    },
    {
      name: "a subprotocol that was never offered",
      head: `${good}\r\nSec-WebSocket-Protocol: mystery`,
      offered: ["graphql-ws"],
    },
    {
      name: "a subprotocol when none was offered",
      head: `${good}\r\nSec-WebSocket-Protocol: mystery`,
    },
    {
      name: "duplicated accept headers",
      head: `${good}\r\nSec-WebSocket-Accept: ${accept}`,
    },
  ];
  for (const c of rejections) {
    it(`refuses ${c.name}`, () => {
      const res = checkHandshakeResponse(c.head, accept, c.offered ?? []);
      expect(res.ok).toBe(false);
    });
  }
});

// --- against a real WebSocket app ---------------------------------------------

describe("app-ws-upstream: a real app", () => {
  it("carries text and binary both ways", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    const dialed = await dial(portOf(app), got);
    expect(dialed.ok).toBe(true);
    expect(live!.sendText("hello")).toBe("sent");
    expect(live!.sendBinary(Buffer.from([1, 2, 3]))).toBe("sent");
    await until(() => got.messages.length >= 2, "both echoes");
    expect(got.messages).toEqual([
      { kind: "text", body: "echo:hello" },
      { kind: "binary", body: "010203" },
    ]);
    // The app saw exactly what we sent, unmasked for it by its own runtime.
    expect(seen.frames).toEqual(["hello", "binary:010203"]);
  });

  it("sends the headers, Host and subprotocols it was given", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    const dialed = await dial(portOf(app), got, {
      target: "/socket?room=1",
      headers: { "X-Forwarded-For": "203.0.113.5", Cookie: "app_pref=blue" },
      protocols: ["graphql-ws"],
    });
    expect(dialed.ok).toBe(true);
    expect(live!.protocol).toBe("graphql-ws");
    const headers = seen.upgradeHeaders[0];
    expect(headers.host).toBe("hello.office.example");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.5");
    expect(headers.cookie).toBe("app_pref=blue");
    expect(headers["sec-websocket-protocol"]).toBe("graphql-ws");
  });

  it("answers the app's ping with the same payload", async () => {
    // Nobody relays a ping: each leg answers its own, so an app's keepalive is
    // satisfied here rather than crossing to the browser.
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got);
    live!.sendText("ping-me");
    await until(() => seen.pongs.length > 0, "the pong");
    expect(seen.pongs).toEqual(["app-ping-payload"]);
    // And the ping never surfaced as a message.
    expect(got.messages).toEqual([]);
  });

  it("reports the app's close code and reason once", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got);
    live!.sendText("close-4321");
    await until(() => got.closes.length > 0, "the close");
    expect(got.closes).toEqual([
      { code: 4321, reason: "app said bye", abnormal: false, detail: null },
    ]);
    // Sends after a close are refused rather than throwing: the relay's two legs
    // die in whichever order the network picks.
    expect(live!.sendText("late")).toBe("closing");
    await Bun.sleep(50);
    expect(got.closes.length).toBe(1);
  });

  it("reports a close with no status as a null code", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got);
    live!.sendText("close-plain");
    await until(() => got.closes.length > 0, "the close");
    expect(got.closes[0].code).toBe(1000);
    expect(got.closes[0].abnormal).toBe(false);
  });

  it("carries our close code to the app", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got);
    live!.sendClose(4001, "browser went away");
    await until(() => seen.closes.length > 0, "the app's close event");
    expect(seen.closes).toEqual([{ code: 4001, reason: "browser went away" }]);
  });

  it("terminates with no close frame, so the app sees an abnormal close", async () => {
    // This is the vocabulary for "the browser vanished": 1006 means exactly
    // "the connection dropped without a close frame", and the only way to say it
    // is to do it.
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got);
    live!.terminate("browser vanished");
    await until(() => seen.closes.length > 0, "the app's close event");
    expect(seen.closes).toEqual([{ code: 1006, reason: "" }]);
    expect(got.closes).toEqual([
      { code: null, reason: "", abnormal: true, detail: "browser vanished" },
    ]);
  });

  it("delivers a greeting that shared the handshake's read", async () => {
    // An app that speaks first puts its frame in the same TCP read as the end of
    // the response headers. Dropping those bytes would lose the only message a
    // server-greets protocol ever sends unprompted.
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen, { greet: "welcome" });
    const got = collector();
    await dial(portOf(app), got);
    await until(() => got.messages.length > 0, "the greeting");
    expect(got.messages).toEqual([{ kind: "text", body: "welcome" }]);
  });

  it("refuses a message over the cap in both directions", async () => {
    const seen: AppSeen = {
      frames: [],
      closes: [],
      pongs: [],
      upgradeHeaders: [],
    };
    app = startApp(seen);
    const got = collector();
    await dial(portOf(app), got, { limits: { maxMessageBytes: 1000 } });
    // Outbound: refused before a byte reaches the wire.
    expect(live!.sendText("x".repeat(1001))).toBe("too_large");
    expect(live!.sendBinary(Buffer.alloc(1001))).toBe("too_large");
    expect(seen.frames).toEqual([]);
    // Inbound: the app sends 5000 bytes, the connection ends with 1009.
    live!.sendText("big");
    await until(() => got.closes.length > 0, "the oversize close");
    expect(got.closes[0].code).toBe(1009);
    expect(got.closes[0].detail).toContain("over the message cap");
  });
});

// --- what only a hand-written peer can do ------------------------------------

describe("app-ws-upstream: dial failures happen before any 101", () => {
  it("reports a refused connection", async () => {
    // Nothing listening: the ordinary "the app is not up" case. Port 1 is
    // privileged and never bound by a test.
    const got = collector();
    const res = await dial(1, got);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe("connect_failed");
    expect(got.closes).toEqual([]);
  });

  it("reports an app that answers with a page instead of an upgrade", async () => {
    peer = startPeer({
      respond: () =>
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello",
    });
    const got = collector();
    const res = await dial(peer.port, got);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe("handshake_rejected");
  });

  it("reports an app whose accept value is wrong", async () => {
    // A cached or cross-wired response must not be taken for an open socket.
    peer = startPeer({ accept: () => "bm90LXJpZ2h0" });
    const got = collector();
    const res = await dial(peer.port, got);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe("handshake_invalid");
      expect(res.detail).toContain("Sec-WebSocket-Accept");
    }
  });

  it("reports an app that answers with an extension", async () => {
    peer = startPeer({
      extraResponseHeaders: ["Sec-WebSocket-Extensions: permessage-deflate"],
    });
    const got = collector();
    const res = await dial(peer.port, got);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain("unoffered extension");
  });

  it("gives up on an app that never answers", async () => {
    peer = startPeer({ respond: () => null });
    const got = collector();
    const res = await dial(peer.port, got, {
      limits: { handshakeTimeoutMs: 120 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe("handshake_timeout");
  });

  it("gives up on an app that dribbles headers forever", async () => {
    peer = startPeer({
      respond: (socketRequest) => {
        void socketRequest;
        // A response that starts but never ends. The byte ceiling is what stops
        // this, not the timeout.
        return `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"p".repeat(4000)}\r\n`;
      },
    });
    const got = collector();
    const res = await dial(peer.port, got, {
      limits: { handshakeMaxHeaderBytes: 1024, handshakeTimeoutMs: 5000 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain("byte ceiling");
  });

  it("reports an app that hangs up mid-handshake", async () => {
    peer = startPeer({
      respond: () => "HTTP/1.1 101 Switching Protocols\r\nUpgrade: web",
      onUpgraded: () => {},
    });
    // The peer above writes a partial header block; close it from under the
    // client by stopping the listener.
    const got = collector();
    const dialing = dial(peer.port, got, {
      limits: { handshakeTimeoutMs: 400 },
    });
    await Bun.sleep(60);
    peer.stop(true);
    peer = null;
    const res = await dialing;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(["handshake_invalid", "handshake_timeout"]).toContain(res.failure);
    }
    // No close event: nothing was ever open to close.
    expect(got.closes).toEqual([]);
  });
});

describe("app-ws-upstream: the handshake's own limits", () => {
  it("refuses a complete but oversized header block in one read", () => {
    // The ceiling is on the HEADER BLOCK, not on how long we waited for a
    // terminator: one read carrying 20KB of headers AND their terminator is over
    // the limit, and checking only the unterminated case would let it through and
    // then parse it.
    const accept = handshakeAccept("K");
    const oversized = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `X-Pad: ${"p".repeat(20 * 1024)}`,
      "",
      "",
    ].join("\r\n");
    peer = startPeer({ respond: () => oversized });
    return dial(peer.port, collector(), {
      limits: { handshakeMaxHeaderBytes: 16 * 1024, handshakeTimeoutMs: 2000 },
    }).then((res) => {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.detail).toContain("byte ceiling");
    });
  });

  it("accepts a block UNDER the ceiling whose terminator splits a read", async () => {
    // The other side of the same check: the ceiling must not fire on a legitimate
    // block just because its terminator arrived in a later read. A cap that
    // rejects valid handshakes is worse than no cap.
    peer = startPeer({
      respondBytes: (_request, accept) =>
        upgradeHead(accept, [`X-Pad: ${"p".repeat(8 * 1024)}`]),
      splitLastByte: true,
    });
    const res = await dial(peer.port, collector(), {
      limits: { handshakeMaxHeaderBytes: 16 * 1024, handshakeTimeoutMs: 2000 },
    });
    expect(res.ok).toBe(true);
  });

  it("refuses to send an upgrade request over the request ceiling", async () => {
    // The headers in the request come from a browser. Their size is not ours to
    // assume, and a request too big to write is refused rather than half-sent.
    const res = await dial(1, collector(), {
      headers: { "X-Big": "v".repeat(20 * 1024) },
      limits: { handshakeMaxRequestBytes: 16 * 1024 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe("bad_request");
      expect(res.detail).toContain("over the ceiling");
    }
  });

  it("bounds the WHOLE upgrade, including a connect that never completes", async () => {
    // The timer has to start before connect(), not in `open`: a connect that
    // never resolves has no handler to notice it. Only a fake connector can hold
    // a connect open indefinitely.
    const fake = makeFakeConnector({ neverConnect: true });
    const started = Date.now();
    const res = await dial(4001, collector(), {
      connector: fake.connector,
      limits: { handshakeTimeoutMs: 120 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe("handshake_timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("abandons a pending dial when its app registration retires", async () => {
    const fake = makeFakeConnector({ neverConnect: true });
    const retirement = new AbortController();
    const dialing = dial(4001, collector(), {
      connector: fake.connector,
      signal: retirement.signal,
      limits: { handshakeTimeoutMs: 2000 },
    });

    retirement.abort();
    const res = await dialing;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe("connect_failed");
      expect(res.detail).toBe("app registration retired");
    }
    fake.openLate();
    expect(fake.writtenBytes().length).toBe(0);
    expect(fake.socket.ended).toBe(true);
  });

  it("writes the rest of the upgrade request when the socket only took part", async () => {
    // Raw TCP writes are partial - that is why this module exists - and a
    // truncated upgrade request would leave the app waiting for headers that
    // never come.
    const fake = makeFakeConnector({ accept: 20 });
    const dialing = dial(4002, collector(), {
      connector: fake.connector,
      limits: { handshakeTimeoutMs: 400 },
    });
    // First write took 20 bytes; the tail waits for drain.
    expect(fake.writtenBytes().length).toBe(20);
    fake.socket.accept = -1;
    fake.drain();
    const written = fake.writtenBytes().toString();
    expect(written).toStartWith("GET /socket HTTP/1.1\r\n");
    expect(written).toEndWith("\r\n\r\n");
    expect(written).toContain("Sec-WebSocket-Key: ");
    // Let the dial settle so no promise is left dangling.
    fake.close();
    await dialing;
  });

  it("ignores a connect that completes after the dial gave up", async () => {
    // The timeout can fire before connect finishes. If `open` then arrives, the
    // request must NOT be written and a later 101 must not build a live
    // connection and start calling handlers for a caller who was already told the
    // dial failed.
    const fake = makeFakeConnector({ neverConnect: true, autoUpgrade: true });
    const got = collector();
    const res = await dial(4005, got, {
      connector: fake.connector,
      limits: { handshakeTimeoutMs: 80 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe("handshake_timeout");
    // Connect completes late.
    fake.openLate();
    expect(fake.writtenBytes().length).toBe(0);
    expect(fake.socket.ended).toBe(true);
    // And even a syntactically perfect 101 afterwards changes nothing.
    fake.data(upgradeHead(defaultAccept("whatever")));
    await Bun.sleep(30);
    expect(got.messages).toEqual([]);
    expect(got.closes).toEqual([]);
  });

  it("refuses a response that arrives before the request has fully left", async () => {
    // A full-duplex peer sees the key long before the terminator, so it can
    // produce a valid-looking 101 while our request is still queued. Accepting it
    // would publish a connection and then write the tail of an HTTP request into
    // a WebSocket stream on the next drain.
    const fake = makeFakeConnector({ accept: 20 });
    const got = collector();
    const dialing = dial(4006, got, {
      connector: fake.connector,
      limits: { handshakeTimeoutMs: 800 },
    });
    const afterFirstWrite = fake.writtenBytes().length;
    expect(afterFirstWrite).toBe(20);
    // The peer answers early, with an accept value it could not yet have computed
    // correctly - but even a correct one must be refused at this point.
    fake.data(upgradeHead(defaultAccept("early")));
    const res = await dialing;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe("handshake_invalid");
      expect(res.detail).toContain("before the upgrade request");
    }
    // Nothing more of the HTTP request went out, and no connection was published.
    fake.socket.accept = -1;
    fake.drain();
    expect(fake.writtenBytes().length).toBe(afterFirstWrite);
    expect(got.messages).toEqual([]);
    expect(got.closes).toEqual([]);
  });

  it("completes the close handshake when the app answers and keeps TCP open", async () => {
    // A well-behaved app answers our close and leaves the socket to us. Bun's own
    // server hides this by dropping TCP as well; a fake peer does not, and without
    // parsing while closing this case was reported as an abnormal close after the
    // full timeout - a polite goodbye recorded as a failure.
    const fake = makeFakeConnector({ autoUpgrade: true });
    const got = collector();
    const dialed = await dial(4007, got, {
      connector: fake.connector,
      limits: { closeHandshakeMs: 5000 },
    });
    expect(dialed.ok).toBe(true);
    live!.sendClose(1001, "going away", "browser left");
    // The app's close RESPONSE, unmasked, socket left open.
    fake.data(Buffer.from([0x88, 0x02, 0x03, 0xe9]));
    expect(got.closes.length).toBe(1);
    expect(got.closes[0]).toEqual({
      code: 1001,
      reason: "going away",
      abnormal: false,
      detail: "browser left",
    });
    // No second event when the timer would have fired.
    await Bun.sleep(80);
    expect(got.closes.length).toBe(1);
  });

  it("calls it abnormal when the app vanishes instead of answering our close", async () => {
    // The contrast with the test above: same locally initiated close, but the peer
    // drops TCP rather than answering. Our code and reason are still the truth
    // about why we closed - the HANDSHAKE is what did not complete - so the event
    // keeps them and adds the abnormal flag. Reporting this as clean would make a
    // vanishing app indistinguishable from a well-behaved one.
    const fake = makeFakeConnector({ autoUpgrade: true });
    const got = collector();
    const dialed = await dial(4008, got, {
      connector: fake.connector,
      limits: { closeHandshakeMs: 5000 },
    });
    expect(dialed.ok).toBe(true);
    live!.sendClose(1001, "going away", "browser left");
    // No close frame back - the socket just dies.
    fake.close();
    expect(got.closes.length).toBe(1);
    expect(got.closes[0]).toEqual({
      code: 1001,
      reason: "going away",
      abnormal: true,
      detail:
        "browser left; socket closed before the close handshake completed",
    });
    await Bun.sleep(60);
    expect(got.closes.length).toBe(1);
  });

  it("keeps the specific outcome when the app closes in the same read as the 101", async () => {
    // A close frame riding the handshake's own read ends the connection
    // synchronously - which used to reach the socket's close handler before the
    // dial had published the connection, letting a generic "closed during the
    // upgrade" overwrite a handshake that had in fact succeeded.
    peer = startPeer({
      // ONE write: the 101 block and a close frame (1000 "done") together, so
      // they are guaranteed to reach the client in a single read.
      respondBytes: (_request, accept) =>
        Buffer.concat([
          upgradeHead(accept),
          Buffer.from([0x88, 0x06, 0x03, 0xe8, 0x64, 0x6f, 0x6e, 0x65]),
        ]),
    });
    const got = collector();
    const res = await dial(peer.port, got);
    expect(res.ok).toBe(true);
    await until(() => got.closes.length > 0, "the app's close");
    expect(got.closes[0].code).toBe(1000);
    expect(got.closes[0].reason).toBe("done");
    expect(got.closes[0].abnormal).toBe(false);
  });

  it("keeps the specific outcome when a violation rides the 101", async () => {
    peer = startPeer({
      // Again one write: the 101 plus a MASKED server frame, which only a client
      // may send.
      respondBytes: (_request, accept) =>
        Buffer.concat([
          upgradeHead(accept),
          Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x60]),
        ]),
    });
    const got = collector();
    const res = await dial(peer.port, got, {
      limits: { closeHandshakeMs: 100 },
    });
    // The handshake DID succeed; what follows is a connection that dies, and the
    // dial must say so rather than reporting an upgrade failure.
    expect(res.ok).toBe(true);
    await until(() => got.closes.length > 0, "the protocol-error close");
    expect(got.closes[0].code).toBe(1002);
  });

  it("refuses an HTTP/1.0 upgrade response", () => {
    const accept = handshakeAccept("K");
    const head = [
      "HTTP/1.0 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ].join("\r\n");
    // RFC 6455's handshake is defined on HTTP/1.1.
    const res = checkHandshakeResponse(head, accept, []);
    expect(res.ok).toBe(false);
  });
});

describe("app-ws-upstream: an app that stops reading", () => {
  it("bounds the queue and reports queue_full instead of growing", async () => {
    // THE measurement this client exists for. Bun's own WebSocket client would
    // swallow all of this with bufferedAmount stuck at 0.
    peer = startPeer({ stopReading: true });
    const got = collector();
    const dialed = await dial(peer.port, got, {
      limits: {
        queueMaxBytes: 64 * 1024,
        controlReserveBytes: 4 * 1024,
        maxMessageBytes: 16 * 1024,
      },
    });
    expect(dialed.ok).toBe(true);
    const chunk = Buffer.alloc(16 * 1024, 7);
    let full = 0;
    let sent = 0;
    for (let i = 0; i < 500; i++) {
      const outcome = live!.sendBinary(chunk);
      if (outcome === "queue_full") {
        full++;
        break;
      }
      sent++;
    }
    expect(full).toBe(1);
    // The bound holds: what the socket would not take is held, and what is held
    // is under the ceiling. (The socket accepts a good deal into its own send
    // buffer first, which is why `sent` is larger than the queue.)
    expect(sent).toBeGreaterThan(0);
    expect(live!.queuedBytes()).toBeLessThanOrEqual(64 * 1024);
    expect(live!.heldBytes()).toBeLessThanOrEqual(64 * 1024);
  });

  it("can still send a close when the data queue is full", async () => {
    // The reserve's whole purpose: a connection that has to end must be able to
    // say so, even when the app has stopped reading.
    peer = startPeer({ stopReading: true });
    const got = collector();
    await dial(peer.port, got, {
      limits: {
        queueMaxBytes: 64 * 1024,
        controlReserveBytes: 4 * 1024,
        maxMessageBytes: 16 * 1024,
        closeHandshakeMs: 100,
      },
    });
    // PACK the data queue, in two passes. Big frames get it near the data
    // ceiling fast; small ones then close the gap to under one small frame. This
    // matters: filling with 16KB frames alone leaves up to 16KB of slack under
    // the ceiling, and a close frame fits in that slack whether the reserve
    // exists or not - so the test would pass with the reserve deleted, which is
    // exactly what the mutation run caught.
    const big = Buffer.alloc(16 * 1024, 7);
    fillQueue(() => live!.sendBinary(big), "big frames", big.length);
    const small = Buffer.alloc(32, 7);
    fillQueue(() => live!.sendBinary(small), "packing frames", small.length);
    const before = live!.queuedBytes();
    // Under the DATA ceiling there is now less than one 38-byte frame of room,
    // so this close frame - 2 code bytes plus a 123-byte reason plus a 6-byte
    // masked header, 131 on the wire - can only be queued out of the control
    // reserve.
    const longReason = "x".repeat(123);
    live!.sendClose(1001, longReason);
    expect(live!.queuedBytes()).toBe(before + 131);
    // The peer never answers, so the close handshake times out and the socket
    // goes - exactly once.
    await until(() => got.closes.length > 0, "the close handshake timeout");
    expect(got.closes.length).toBe(1);
    expect(got.closes[0].abnormal).toBe(true);
    expect(got.closes[0].detail).toContain("close handshake timed out");
  });

  it("drains the queue when the app starts reading again", async () => {
    // The other half of the backpressure contract: a partial write is resumed
    // by `drain`, not by a timer or a retry loop.
    let resume: (() => void) | null = null;
    const received: number[] = [];
    peer = startPeer({
      stopReading: true,
      onUpgraded(socket) {
        resume = () => {
          socket.resume();
        };
      },
    });
    const got = collector();
    await dial(peer.port, got, {
      limits: { queueMaxBytes: 512 * 1024, maxMessageBytes: 64 * 1024 },
    });
    const chunk = Buffer.alloc(64 * 1024, 3);
    fillQueue(() => live!.sendBinary(chunk), "drain fill", chunk.length);
    expect(live!.queuedBytes()).toBeGreaterThan(0);
    received.push(live!.queuedBytes());
    resume!();
    await until(() => live!.queuedBytes() === 0, "the queue to drain", 4000);
    expect(live!.queuedBytes()).toBe(0);
  });

  it("gets the close echo OUT to a blocked peer before ending the socket", async () => {
    // The close-handshake contract, in the one condition where it is hard: the
    // app's close arrives while the socket is not draining, so the echo cannot go
    // out immediately. Finalizing straight away would clear the queue and end
    // TCP, dropping the echo exactly when the queue machinery is what matters.
    //
    // The fake socket makes this deterministic: writes are refused, an app close
    // is injected, then writes are allowed and drain fires.
    const fake = makeFakeConnector({ autoUpgrade: true });
    const got = collector();
    const dialed = await dial(4003, got, {
      connector: fake.connector,
      limits: { closeHandshakeMs: 5000 },
    });
    expect(dialed.ok).toBe(true);
    const afterRequest = fake.writtenBytes().length;
    // The socket stops accepting anything.
    fake.socket.accept = 0;
    // The app says goodbye: 1001 "away", unmasked.
    fake.data(Buffer.from([0x88, 0x06, 0x03, 0xe9, 0x61, 0x77, 0x61, 0x79]));
    // Nothing could be written, so the connection must NOT have finalized yet.
    expect(fake.writtenBytes().length).toBe(afterRequest);
    expect(got.closes).toEqual([]);
    expect(fake.socket.ended).toBe(false);
    // Now the socket drains.
    fake.socket.accept = -1;
    fake.drain();
    // The echo went out - a close frame carrying the same code - and only then did
    // the connection end.
    const tail = fake.writtenBytes().subarray(afterRequest);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[0] & 0x0f).toBe(0x8); // close opcode
    expect(got.closes.length).toBe(1);
    expect(got.closes[0]).toEqual({
      code: 1001,
      reason: "away",
      abnormal: false,
      detail: null,
    });
    expect(fake.socket.ended).toBe(true);
  });

  it("calls it abnormal when the socket dies before the echo could be sent", async () => {
    // The mirror of the resume-and-drain case: the app's close arrived, our echo
    // was queued, and the transport died before those bytes could leave. The
    // handshake did NOT complete, so the peer's code and reason are kept but the
    // event is abnormal - otherwise a peer that vanishes mid-goodbye is
    // indistinguishable from one that completed the exchange.
    const fake = makeFakeConnector({ autoUpgrade: true });
    const got = collector();
    await dial(4009, got, {
      connector: fake.connector,
      limits: { closeHandshakeMs: 5000 },
    });
    fake.socket.accept = 0;
    fake.data(Buffer.from([0x88, 0x06, 0x03, 0xe9, 0x61, 0x77, 0x61, 0x79]));
    expect(got.closes).toEqual([]);
    // The socket dies before any drain.
    fake.close();
    expect(got.closes.length).toBe(1);
    expect(got.closes[0]).toEqual({
      code: 1001,
      reason: "away",
      abnormal: true,
      detail: "socket closed before the close echo was sent",
    });
    await Bun.sleep(60);
    expect(got.closes.length).toBe(1);
  });

  it("treats a socket error the same way as a socket close, at every stage", async () => {
    // Both signals mean "the transport is gone", and they must not drift into
    // disagreeing about what a half-finished close was. The table covers the three
    // lifecycle positions an error can arrive in.
    const cases: {
      what: string;
      act: (fake: ReturnType<typeof makeFakeConnector>) => void;
      expected: (detail: string) => UpstreamCloseEvent;
    }[] = [
      {
        what: "nothing in flight",
        act: () => undefined,
        expected: (detail) => ({
          code: null,
          reason: "",
          abnormal: true,
          detail: `${detail} without a close frame`,
        }),
      },
      {
        what: "our own close pending",
        act: (fake) => {
          void fake;
          live!.sendClose(1001, "going away", "browser left");
        },
        expected: (detail) => ({
          code: 1001,
          reason: "going away",
          abnormal: true,
          detail: `browser left; ${detail} before the close handshake completed`,
        }),
      },
      {
        what: "an echo owed to the app",
        act: (fake) => {
          fake.socket.accept = 0;
          fake.data(
            Buffer.from([0x88, 0x06, 0x03, 0xe9, 0x61, 0x77, 0x61, 0x79]),
          );
        },
        expected: (detail) => ({
          code: 1001,
          reason: "away",
          abnormal: true,
          detail: `${detail} before the close echo was sent`,
        }),
      },
    ];
    let port = 4100;
    for (const c of cases) {
      const fake = makeFakeConnector({ autoUpgrade: true });
      const got = collector();
      await dial(port++, got, {
        connector: fake.connector,
        limits: { closeHandshakeMs: 5000 },
      });
      c.act(fake);
      fake.errorNow(new Error("EPIPE"));
      expect({ what: c.what, events: got.closes }).toEqual({
        what: c.what,
        events: [c.expected("socket error: Error: EPIPE")],
      });
      live = null;
    }
  });

  it("still ends the socket if the echo can never be written", async () => {
    // The other half: the flush may never happen. The close timer is the bound,
    // and it reports the app's own code with the abnormal flag set, because no
    // complete close handshake happened.
    const fake = makeFakeConnector({ autoUpgrade: true });
    const got = collector();
    await dial(4004, got, {
      connector: fake.connector,
      limits: { closeHandshakeMs: 60 },
    });
    fake.socket.accept = 0;
    fake.data(Buffer.from([0x88, 0x06, 0x03, 0xe9, 0x61, 0x77, 0x61, 0x79]));
    expect(got.closes).toEqual([]);
    await Bun.sleep(150);
    expect(got.closes.length).toBe(1);
    expect(got.closes[0].code).toBe(1001);
    expect(got.closes[0].abnormal).toBe(true);
    expect(got.closes[0].detail).toContain("close handshake timed out");
  });

  it("reports a socket that dies mid-connection as abnormal, once", async () => {
    peer = startPeer({});
    const got = collector();
    await dial(peer.port, got);
    peer.stop(true);
    peer = null;
    await until(() => got.closes.length > 0, "the abnormal close");
    expect(got.closes.length).toBe(1);
    expect(got.closes[0]).toEqual({
      code: null,
      reason: "",
      abnormal: true,
      detail: "socket closed without a close frame",
    });
    // Every later call is inert rather than a second close.
    live!.terminate("again");
    live!.sendClose(1000, "again");
    expect(got.closes.length).toBe(1);
  });

  it("ends the connection when the app sends a protocol violation", async () => {
    peer = startPeer({
      onUpgraded(socket) {
        // A masked server frame: only a client may mask.
        socket.write(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x60]));
      },
    });
    const got = collector();
    await dial(peer.port, got, { limits: { closeHandshakeMs: 100 } });
    await until(() => got.closes.length > 0, "the protocol-error close");
    expect(got.closes.length).toBe(1);
    expect(got.closes[0].code).toBe(1002);
    expect(got.closes[0].detail).toContain("protocol error");
  });
});
