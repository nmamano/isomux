// The WebSocket relay end to end, through the REAL office (phase 3, slice 6b).
//
// Every test here drives a whole chain: a hand-built client speaks HTTP/1.1 with
// a Host of its choosing, the office classifies it as an app host, the slice-4
// gate checks the app session, and the relay dials a real WebSocket app on the
// port the registry allocated. Two independent implementations sit on the two
// legs - Bun's own server WebSocket faces the client, and the office's in-house
// client (slice 6a) faces the app - which is what makes an echo here mean
// something rather than a codec agreeing with itself.
//
// The lifecycle's internals (caps, races, revocation, the buffer ceilings) are
// driven directly in app-ws-lifecycle.test.ts, where a seam can make a timer fire
// in milliseconds and a cap refuse on the third socket. What only THIS file can
// prove is that the chain holds together at all.

import { describe, it, expect, afterEach } from "bun:test";
import {
  NOT_FOUND,
  OFFICE_HOST,
  WS_AUTH_REQUIRED,
  anOfficeWithAnApp,
  appHost,
  deleteApp,
  raw,
  registerApp,
  signIn,
  wsConnect,
  type WsClient,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { APP_COOKIE_NAME } from "../app-auth.ts";
import {
  APP_STOPPED_BODY,
  APP_WS_BAD_ORIGIN_BODY,
  APP_WS_PROTOCOL_MISMATCH_BODY,
} from "../app-host-responses.ts";
import { createHash } from "crypto";
import {
  APP_WS_MAX_PROTOCOL_HEADER_BYTES,
  _testWsSocketsOpen,
} from "../app-ws-relay.ts";

let server: TestServer | null = null;
let app: { stop(): void } | null = null;
afterEach(async () => {
  app?.stop();
  app = null;
  await server?.stop();
  server = null;
  // Nothing may still hold a socket permit once every socket is gone. Asserted
  // in the teardown of every test rather than in one of them, because a leak
  // shows up as "some later test refuses" and that is a miserable thing to
  // debug.
  expect(_testWsSocketsOpen().total).toBe(0);
});

function office(name = "hello") {
  return anOfficeWithAnApp((srv) => {
    server = srv;
  }, name);
}

interface SeenUpgrade {
  method: string;
  upgrade: string | null;
  path: string;
  cookie: string | null;
  host: string | null;
  origin: string | null;
  protocol: string | null;
  forwardedProto: string | null;
}

// A real WebSocket app, on the port the registry allocated for it. Bun's own
// server implementation, deliberately: the client leg of these tests is the
// office's codec, so the app leg being someone else's code is what keeps the
// echo honest.
function startWsApp(
  name: string,
  seen: SeenUpgrade[],
): { stop(): void; server: ReturnType<typeof Bun.serve> } {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  const srv = Bun.serve<{ path: string }>({
    port: record.port,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        upgrade: req.headers.get("upgrade"),
        path: url.pathname,
        cookie: req.headers.get("cookie"),
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        protocol: req.headers.get("sec-websocket-protocol"),
        forwardedProto: req.headers.get("x-forwarded-proto"),
      });
      if (s.upgrade(req, { data: { path: url.pathname } })) return;
      return new Response("not a websocket here", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.path === "/greet") {
          ws.send("good morning");
          ws.close(4321, "app said so");
        }
        if (ws.data.path === "/bye") ws.close(4001, "app done");
        if (ws.data.path === "/drop") ws.terminate();
        if (ws.data.path === "/nostatus") {
          // A close frame with NO status code. Bun's server API cannot send one,
          // so this app is the one place a raw frame is written by hand - which
          // is exactly the case the relay's mapping has to get right.
          ws.terminate();
        }
      },
      message(ws, message) {
        if (typeof message === "string") ws.send(`echo:${message}`);
        else ws.send(Buffer.concat([Buffer.from([0xff]), message]));
      },
      close() {},
    },
  });
  return { stop: () => void srv.stop(true), server: srv };
}

// An app that is NOT Bun: a raw TCP listener that writes its own 101. It exists
// for the subprotocol cases, and it exists BECAUSE Bun cannot express them - a
// Bun app asked for a subprotocol answers with the first one offered whether it
// meant to or not, so "the app selected none" is unbuildable with it.
function startRawApp(
  name: string,
  opts: {
    protocolLine?: (offered: string | null) => string | null;
    // A close frame with NO status code: two bytes, 0x88 0x00. Unbuildable with
    // Bun's server API, which is why this listener writes frames by hand.
    closeWithNoStatus?: boolean;
  },
): { stop(): void } {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  const srv = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(socket, chunk) {
        const head = Buffer.from(chunk).toString("latin1");
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const offered =
          /sec-websocket-protocol:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        const protocolLine = opts.protocolLine?.(offered) ?? null;
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            ...(protocolLine === null
              ? []
              : [`Sec-WebSocket-Protocol: ${protocolLine}`]),
            "",
            "",
          ].join("\r\n"),
        );
        if (opts.closeWithNoStatus) socket.write(Buffer.from([0x88, 0x00]));
      },
    },
  });
  return { stop: () => srv.stop(true) };
}

async function connected(
  srv: TestServer,
  label: string,
  cookie: string,
  path: string,
  extra: Parameters<typeof wsConnect>[1] extends infer T
    ? Partial<T>
    : never = {},
): Promise<WsClient> {
  const result = await wsConnect(srv.port, {
    host: appHost(label),
    path,
    cookie,
    ...extra,
  });
  if (!result.ok) {
    throw new Error(
      `expected an upgrade, got ${result.response.status}: ${result.response.body}`,
    );
  }
  return result.client;
}

describe("app-host websockets: frames both ways", () => {
  it("relays text and binary in both directions", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/echo");
    client.send("hello app");
    expect(await client.next()).toEqual({
      kind: "text",
      text: "echo:hello app",
    });
    client.sendBinary(Buffer.from([1, 2, 3]));
    expect(await client.next()).toEqual({
      kind: "binary",
      data: Buffer.from([0xff, 1, 2, 3]),
    });
    // One socket, accounted for.
    expect(_testWsSocketsOpen()).toEqual({ total: 1, perApp: 1 });
    client.drop();
    // ...and released when it goes. Polled rather than awaited on a fixed sleep:
    // the release rides the app-side close, which is a socket event.
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("closes both old legs before the same port serves a replacement", async () => {
    const { srv, label, rawSessionId, token } = await office();
    const retiredSeen: SeenUpgrade[] = [];
    app = startWsApp("hello", retiredSeen);
    const retiredCookie = await signIn(srv, label, rawSessionId);
    const retiredClient = await connected(srv, label, retiredCookie, "/echo");
    retiredClient.send("old");
    expect(await retiredClient.next()).toEqual({
      kind: "text",
      text: "echo:old",
    });
    const port = appRegistry.get("hello")!.port;

    await deleteApp(srv, token, "hello");
    expect(await retiredClient.next()).toEqual({
      kind: "close",
      code: 1008,
      reason: "app registration retired",
    });
    app.stop();
    app = null;

    const replacementLabel = await registerApp(srv, token, "hello");
    expect(replacementLabel).toBe(label);
    expect(appRegistry.get("hello")!.port).toBe(port);
    const replacementSeen: SeenUpgrade[] = [];
    app = startWsApp("hello", replacementSeen);
    const replacementCookie = await signIn(srv, replacementLabel, rawSessionId);
    const replacementClient = await connected(
      srv,
      replacementLabel,
      replacementCookie,
      "/echo",
    );
    replacementClient.send("new");
    expect(await replacementClient.next()).toEqual({
      kind: "text",
      text: "echo:new",
    });
    expect(retiredSeen.map((request) => request.path)).toEqual(["/echo"]);
    expect(replacementSeen.map((request) => request.path)).toEqual(["/echo"]);
    replacementClient.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("carries the app's own close code and reason to the client", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/bye");
    expect(await client.next()).toEqual({
      kind: "close",
      code: 4001,
      reason: "app done",
    });
  });

  it("delivers a message the app sent before the socket opened, and THEN its close", async () => {
    // The window the whole state machine exists for: the app is dialed before
    // the browser is upgraded, so it can greet and hang up while there is no
    // browser leg yet. The greeting must not be lost to the goodbye.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/greet");
    expect(await client.next()).toEqual({ kind: "text", text: "good morning" });
    expect(await client.next()).toEqual({
      kind: "close",
      code: 4321,
      reason: "app said so",
    });
  });

  it("maps a status-less close to a clean 1000, never to a drop", async () => {
    // An app can close with a close FRAME carrying no status code. Bun's server
    // API cannot express that downstream (ws.close() puts 1000 on the wire -
    // measured, pinned by the runtime canary below), so the relay chooses
    // between inventing 1000 and reporting 1006. It invents 1000: the app closed
    // CLEANLY, and 1006 is what every reconnect loop treats as a failure.
    const { srv, label, rawSessionId } = await office();
    app = startRawApp("hello", { closeWithNoStatus: true });
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo");
    expect(await client.next()).toEqual({
      kind: "close",
      code: 1000,
      reason: "",
    });
  });

  it("tells the client the truth when the app's connection drops", async () => {
    // No close frame was exchanged, so none is invented: the client sees its
    // socket end, which is what 1006 means.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/drop");
    expect(await client.next()).toEqual({ kind: "eof" });
  });

  it("carries the client's close code and reason to the app", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    const running = startWsApp("hello", seen);
    app = running;
    const cookie = await signIn(srv, label, rawSessionId);
    const closes: Array<{ code: number; reason: string }> = [];
    // Re-serve with a close recorder: the app has to report what IT saw.
    running.stop();
    const record = appRegistry.get("hello")!;
    const srvApp = Bun.serve({
      port: record.port,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("no");
      },
      websocket: {
        message() {},
        close(_ws, code, reason) {
          closes.push({ code, reason });
        },
      },
    });
    app = { stop: () => void srvApp.stop(true) };

    const client = await connected(srv, label, cookie, "/echo");
    client.sendClose(4002, "client done");
    await until(() => closes.length > 0);
    expect(closes[0]).toEqual({ code: 4002, reason: "client done" });
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("tells the app the truth when the client's connection drops", async () => {
    const { srv, label, rawSessionId } = await office();
    const closes: Array<{ code: number; reason: string }> = [];
    const record = (await registerAndRead(srv)).port;
    const srvApp = Bun.serve({
      port: record,
      hostname: "127.0.0.1",
      fetch(req, s) {
        if (s.upgrade(req)) return;
        return new Response("no");
      },
      websocket: {
        message() {},
        close(_ws, code, reason) {
          closes.push({ code, reason });
        },
      },
    });
    app = { stop: () => void srvApp.stop(true) };
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/echo");
    client.drop();
    await until(() => closes.length > 0);
    // 1006: no close frame was exchanged with the app either, because none was
    // exchanged with the browser. The event is relayed as the same event.
    expect(closes[0].code).toBe(1006);
  });
});

describe("app-host websockets: what never reaches the app", () => {
  it("refuses an upgrade with no app session, and never redirects one", async () => {
    const { srv, label } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const result = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect({
        status: result.response.status,
        body: result.response.body,
      }).toEqual({
        status: WS_AUTH_REQUIRED.status,
        body: WS_AUTH_REQUIRED.body,
      });
      // Never a redirect: no WebSocket client can follow one.
      expect(result.response.headers.location).toBeUndefined();
    }
    expect(seen).toEqual([]);
  });

  it("clears a presented-but-dead app cookie, and clears nothing when none was sent", async () => {
    const { srv, label } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const withCookie = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
      cookie: "not-a-real-session",
    });
    const without = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
    });
    expect(withCookie.ok).toBe(false);
    expect(without.ok).toBe(false);
    if (!withCookie.ok && !without.ok) {
      expect(withCookie.response.setCookies).toEqual([
        `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
      ]);
      expect(without.response.setCookies).toEqual([]);
    }
    expect(seen).toEqual([]);
  });

  it("refuses a stopped app without dialing its port", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    // Something IS listening there - the point of the test. A stopped app's port
    // is just a port, and whatever is on it is not the app.
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    srv.appSupervisor.setRuntime("hello", {
      state: "stopped",
      restartCount: 0,
    });

    const result = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
      cookie,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect({
        status: result.response.status,
        body: result.response.body,
      }).toEqual({ status: 503, body: APP_STOPPED_BODY });
    }
    expect(seen).toEqual([]);
  });

  it("refuses an upgrade on the reserved prefix, authenticated or not", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    for (const path of ["/__isomux", "/__isomux/auth", "/__isomux/anything"]) {
      const result = await wsConnect(srv.port, {
        host: appHost(label),
        path,
        cookie,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect({
          path,
          status: result.response.status,
          body: result.response.body,
        }).toEqual({ path, status: NOT_FOUND.status, body: NOT_FOUND.body });
      }
    }
    expect(seen).toEqual([]);
  });

  it("strips every isomux credential from the upgrade it sends the app", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo", {
      headers: {
        Cookie:
          `${APP_COOKIE_NAME}=${cookie}; __Host-isomux_session=STOLEN; ` +
          "isomux_session=ALSO-STOLEN; app_pref=blue",
      },
    });
    client.send("x");
    await client.next();
    expect(seen).toHaveLength(1);
    expect(seen[0].cookie).toBe("app_pref=blue");
    expect(seen[0].host).toBe(appHost(label));
    expect(seen[0].forwardedProto).toBe("https");
    expect(JSON.stringify(seen[0])).not.toContain(cookie);
  });

  it("refuses an upgrade whose Origin is not the app's own, and allows none", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    for (const origin of [
      "https://evil.test",
      `http://${appHost(label)}`,
      `https://${OFFICE_HOST}`,
      `https://${appHost(label)}:443`,
    ]) {
      const result = await wsConnect(srv.port, {
        host: appHost(label),
        path: "/echo",
        cookie,
        origin,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect({
          origin,
          status: result.response.status,
          body: result.response.body,
        }).toEqual({
          origin,
          status: 403,
          body: APP_WS_BAD_ORIGIN_BODY,
        });
      }
    }
    expect(seen).toEqual([]);

    // The app's own origin passes, and so does no origin at all: a client that
    // sends none is not a browser, and has no ambient cookie to be abused.
    const good = await connected(srv, label, cookie, "/echo", {
      origin: `https://${appHost(label)}`,
    });
    good.drop();
    const headless = await connected(srv, label, cookie, "/echo");
    headless.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("keeps the office's own /ws working and unreachable from an app host", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    // The office's socket, on the office's host, still opens and hydrates.
    const ws = await srv.connectWs(rawSessionId);
    const hydrated = await ws.waitFor("session_context");
    expect(hydrated.type).toBe("session_context");
    ws.close();
    // And an app host cannot reach it. `/ws` on an app host is just a path the
    // APP serves: the upgrade succeeds, and what answers is the app - which is
    // the sharper proof, because the office's own /ws would have pushed a
    // session_context frame the instant it opened and this socket only ever says
    // what the app says.
    const onApp = await connected(srv, label, cookie, "/ws");
    onApp.send("who is there");
    expect(await onApp.next()).toEqual({
      kind: "text",
      text: "echo:who is there",
    });
    expect(onApp.seen).toEqual([]);
    expect(seen.map((s) => s.path)).toEqual(["/ws"]);
    onApp.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });
});

describe("app-host websockets: what is not an upgrade", () => {
  it("treats a non-GET carrying Upgrade as an ordinary request", async () => {
    // A WebSocket handshake is a GET (RFC 6455 4.1). Anything else with the
    // header is a normal request, and the HTTP relay drops `Upgrade` as
    // hop-by-hop - so the app sees a POST, not a half-understood handshake.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    // A RAW socket, not fetch: fetch refuses to send `Upgrade` at all, so a test
    // built on it never exercises this branch - which is exactly how the first
    // version of this test passed against a relay that had no method check.
    const res = await raw(srv.port, {
      method: "POST",
      host: appHost(label),
      path: "/echo",
      headers: {
        Cookie: `${APP_COOKIE_NAME}=${cookie}`,
        Upgrade: "websocket",
        "Content-Length": "0",
      },
    });
    // The app's fetch handler answered it as HTTP (it only upgrades GETs), and
    // what reached it was a POST with no Upgrade header at all - the HTTP relay
    // strips that as hop-by-hop. A relay that treated any method as a handshake
    // would have dialed the app and answered 502 instead.
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(1);
    expect({ method: seen[0].method, upgrade: seen[0].upgrade }).toEqual({
      method: "POST",
      upgrade: null,
    });
    expect(_testWsSocketsOpen().total).toBe(0);
  });
});

describe("app-host websockets: subprotocol negotiation", () => {
  it("relays the app's selection exactly, not the runtime's guess", async () => {
    // The app selects the SECOND offered protocol, deliberately. Bun's own
    // answer, if the relay did not set the header itself, is the FIRST offered
    // (measured) - so an app that picks the first would let a broken relay pass
    // this test. Picking the second is what makes the assertion mean something.
    const { srv, label, rawSessionId } = await office();
    app = startRawApp("hello", {
      protocolLine: (offered) =>
        offered?.includes("superchat") ? "superchat" : null,
    });
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo", {
      protocols: "chat, superchat",
    });
    expect(client.handshakeHeaders["sec-websocket-protocol"]).toBe("superchat");
    client.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("passes the client's offer through to the app untouched", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo", {
      protocols: "chat, superchat",
    });
    expect(seen[0].protocol).toBe("chat, superchat");
    client.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("refuses when the app selects none of the offered protocols", async () => {
    // Ruled 2026-08-07: refused rather than relayed, because a browser fails a
    // connection itself when its offer is not acknowledged (WHATWG 2.2 step
    // 11.2) - so relaying it would make the hostname succeed where the app's own
    // port fails, with the two ends disagreeing about the protocol.
    const { srv, label, rawSessionId } = await office();
    app = startRawApp("hello", { protocolLine: () => null });
    const cookie = await signIn(srv, label, rawSessionId);
    const result = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
      cookie,
      protocols: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect({
        status: result.response.status,
        body: result.response.body,
      }).toEqual({
        status: 502,
        body: APP_WS_PROTOCOL_MISMATCH_BODY,
      });
    }
  });

  it("refuses when the app selects a protocol nobody offered", async () => {
    const { srv, label, rawSessionId } = await office();
    app = startRawApp("hello", { protocolLine: () => "something-else" });
    const cookie = await signIn(srv, label, rawSessionId);
    const result = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
      cookie,
      protocols: "chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect({
        status: result.response.status,
        body: result.response.body,
      }).toEqual({
        status: 502,
        body: APP_WS_PROTOCOL_MISMATCH_BODY,
      });
    }
  });

  it("refuses a malformed offer without dialing the app", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    // The oversized case is in this list deliberately: it is refused HERE, with
    // a 400 and no connection to the app, rather than being forwarded into the
    // upgrade request and refused by slice 6a's byte ceiling after a permit and
    // a dial. `seen` staying empty is the assertion that carries that.
    const oversized = "a".repeat(APP_WS_MAX_PROTOCOL_HEADER_BYTES + 1);
    for (const protocols of [
      "",
      "chat, chat",
      "not a token",
      "chat,,x",
      oversized,
    ]) {
      const result = await wsConnect(srv.port, {
        host: appHost(label),
        path: "/echo",
        cookie,
        protocols,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect({
          protocols: protocols.slice(0, 20),
          status: result.response.status,
          body: result.response.body,
        }).toEqual({
          protocols: protocols.slice(0, 20),
          status: 400,
          body: "bad request\n",
        });
      }
    }
    expect(seen).toEqual([]);
  });

  it("answers with no protocol and no extension when none was offered", async () => {
    // The canary for two measured runtime defaults. Bun fabricates nothing when
    // the client offers nothing, and negotiates no extension even when one is
    // offered - which is what lets slice 6a's decoder refuse a reserved bit. If a
    // runtime upgrade changes either, this fails and points here.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo", {
      headers: { "Sec-WebSocket-Extensions": "permessage-deflate" },
    });
    expect(client.handshakeHeaders["sec-websocket-protocol"]).toBeUndefined();
    expect(client.handshakeHeaders["sec-websocket-extensions"]).toBeUndefined();
    client.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });
});

describe("app-host websockets: inert without app hostnames", () => {
  it("never upgrades an app host on an office with no app-host domain", async () => {
    const { startTestServer } = await import("./harness.ts");
    const srv = await startTestServer();
    server = srv;
    const result = await wsConnect(srv.port, {
      host: `hello.${OFFICE_HOST}`,
      path: "/ws",
    });
    // Falls through to the office, which refuses an unauthenticated /ws in its
    // own words - the proof that no app-host code ran at all.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.body).toBe("unauthenticated");
    }
  });
});

// A registered app's port, for the tests that build their own listener.
async function registerAndRead(_srv: TestServer): Promise<{ port: number }> {
  const record = appRegistry.get("hello");
  if (!record) throw new Error("no registered app hello");
  return { port: record.port };
}

// Poll until a condition holds. Socket lifecycle events land on their own turns,
// and a fixed sleep is either flaky or slow; this is neither.
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}
