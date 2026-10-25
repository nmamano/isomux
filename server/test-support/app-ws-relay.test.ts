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
  WS_UNREACHABLE,
  anOfficeWithAnApp,
  appHost,
  grantMemberAppRoom,
  deleteApp,
  raw,
  registerApp,
  signIn,
  wsConnect,
  type WsClient,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { APP_COOKIE_NAME } from "../app-auth.ts";
import {
  APP_STOPPED_BODY,
  BAD_REQUEST_BODY,
  APP_BAD_ORIGIN_BODY,
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
  // debug. Bun 1.4.4 runs the relay's close callbacks after server.stop()
  // resolves, so a test that ends with its client open releases the permit a
  // turn later: wait for it, and let the assertion report a real leak.
  await until(() => _testWsSocketsOpen().total === 0).catch(() => {});
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
): { stop(): void; closes: Array<{ code: number; reason: string }> } {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  // What the app itself heard when each socket ended.
  const closes: Array<{ code: number; reason: string }> = [];
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
      },
      message(ws, message) {
        if (message === "bye") ws.close(4001, "app done");
        else if (typeof message === "string") ws.send(`echo:${message}`);
        else ws.send(Buffer.concat([Buffer.from([0xff]), message]));
      },
      close(_ws, code, reason) {
        closes.push({ code, reason });
      },
    },
  });
  return { stop: () => void srv.stop(true), closes };
}

// An app that is NOT Bun: a raw TCP listener that writes its own 101. It exists
// for the subprotocol cases, and it exists BECAUSE Bun cannot express them - a
// Bun app asked for a subprotocol answers with the first one offered whether it
// meant to or not, so "the app selected none" is unbuildable with it.
function startRawApp(
  name: string,
  opts: {
    // `path` is the request target, so one app can answer two ways.
    protocolLine?: (offered: string | null, path: string) => string | null;
    // A close frame with NO status code: two bytes, 0x88 0x00. Unbuildable with
    // Bun's server API, which is why this listener writes frames by hand.
    closeWithNoStatus?: boolean;
    // Accept the upgrade and then drop the TCP connection with no close frame.
    // Since Bun 1.3.12 a Bun app cannot do this from `open`: terminate() there
    // discards the 101 before it is written (measured).
    dropAfterHandshake?: boolean;
  },
): { stop(): void; offers: Array<string | null> } {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  const offers: Array<string | null> = [];
  const srv = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(socket, chunk) {
        const head = Buffer.from(chunk).toString("latin1");
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const offered =
          /sec-websocket-protocol:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null;
        offers.push(offered);
        const path = /^GET (\S+)/.exec(head)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        const protocolLine = opts.protocolLine?.(offered, path) ?? null;
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
        if (opts.dropAfterHandshake) socket.end();
      },
    },
  });
  return { stop: () => srv.stop(true), offers };
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
    const retiredApp = startWsApp("hello", retiredSeen);
    app = retiredApp;
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
    // The old app leg is told the same thing, not left open on the reused port.
    await until(() => retiredApp.closes.length > 0);
    expect(retiredApp.closes).toEqual([
      { code: 1008, reason: "app registration retired" },
    ]);
    retiredApp.stop();
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

  it("carries the app's own close code and reason to the client on an open socket", async () => {
    // The app closes in answer to a message, so the socket is OPEN when the
    // close arrives - the path the greet-and-close case below never takes.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/echo");
    client.send("bye");
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
    // measured), so the relay chooses
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
    app = startRawApp("hello", { dropAfterHandshake: true });
    const cookie = await signIn(srv, label, rawSessionId);

    const client = await connected(srv, label, cookie, "/echo");
    expect(await client.next()).toEqual({ kind: "eof" });
  });

  it("carries the client's close to the app: its code and reason, or 1006 when it drops", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    const running = startWsApp("hello", seen);
    app = running;
    const cookie = await signIn(srv, label, rawSessionId);

    const polite = await connected(srv, label, cookie, "/echo");
    polite.sendClose(4002, "client done");
    await until(() => running.closes.length === 1);
    expect(running.closes[0]).toEqual({ code: 4002, reason: "client done" });

    // No close frame was exchanged with the browser, so none is exchanged with
    // the app either: the event is relayed as the same event.
    const dropped = await connected(srv, label, cookie, "/echo");
    dropped.drop();
    await until(() => running.closes.length === 2);
    expect(running.closes[1].code).toBe(1006);
    await until(() => _testWsSocketsOpen().total === 0);
  });
});

describe("app-host websockets: what never reaches the app", () => {
  it("refuses an upgrade with no live app session: no redirect, the dead cookie cleared, the app never dialed", async () => {
    const { srv, label } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    // On `/ws`, the office's own socket path: the answer is the app-host arm's
    // refusal, not the office handler's, so that handler never runs here.
    const withCookie = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/ws",
      cookie: "not-a-real-session",
    });
    const without = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/ws",
    });
    const answer = (result: Awaited<ReturnType<typeof wsConnect>>) =>
      result.ok
        ? "upgraded"
        : {
            status: result.response.status,
            body: result.response.body,
            // Never a redirect: no WebSocket client can follow one.
            location: result.response.headers.location ?? "none",
            setCookies: result.response.setCookies,
          };
    expect(answer(withCookie)).toEqual({
      status: WS_AUTH_REQUIRED.status,
      body: WS_AUTH_REQUIRED.body,
      location: "none",
      setCookies: [
        `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
      ],
    });
    expect(answer(without)).toEqual({
      status: WS_AUTH_REQUIRED.status,
      body: WS_AUTH_REQUIRED.body,
      location: "none",
      setCookies: [],
    });
    expect(seen).toEqual([]);
  });

  it("refuses an app that is not listening with a 502, and a stopped one without dialing its port", async () => {
    const { srv, label, rawSessionId } = await office();
    const cookie = await signIn(srv, label, rawSessionId);
    // Running, but nothing on its port: the dial fails BEFORE the upgrade, so
    // the browser gets an ordinary HTTP refusal (and the teardown proves the
    // slot taken for the dial came back).
    const unreachable = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/echo",
      cookie,
    });
    expect(
      unreachable.ok
        ? "upgraded"
        : {
            status: unreachable.response.status,
            body: unreachable.response.body,
          },
    ).toEqual({ status: WS_UNREACHABLE.status, body: WS_UNREACHABLE.body });

    const seen: SeenUpgrade[] = [];
    // Now something IS listening there - the point of the rest. A stopped app's
    // port is just a port, and whatever is on it is not the app.
    app = startWsApp("hello", seen);
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

  it("refuses an upgrade on the reserved prefix, even with a live app session", async () => {
    // The reserved check sits AHEAD of the upgrade branch: the other way round,
    // an upgrade to `/__isomux/auth` would be relayed to the app.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    for (const path of ["/__isomux", "/__isomux/auth"]) {
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

    // Every refused shape is the pure rule's table (app-ws-lifecycle.test.ts,
    // "allows an absent Origin and exactly one present value"); this is the
    // wiring: the rule runs against THIS app's host, before the app is dialed.
    for (const origin of [`https://${OFFICE_HOST}`]) {
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
          body: APP_BAD_ORIGIN_BODY,
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
});

describe("app-host websockets: access lost while a socket is open", () => {
  it("closes the socket when the member loses the app's room, and when the app's agent leaves it", async () => {
    // The relay's own recheck timer runs every 30 s and `until` gives up after
    // 2 s, so each close below proves the office rechecks open sockets on the
    // access change itself: the users hook, then the agents.move route.
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    const wsApp = startWsApp("hello", seen);
    app = wsApp;
    const member = getUserByName("Member");
    if (!member) throw new Error("seeded member is missing");
    const revoked = {
      kind: "close",
      code: 1008,
      reason: "session ended",
    } as const;

    const first = await connected(
      srv,
      label,
      await signIn(srv, label, rawSessionId),
      "/echo",
    );
    first.send("ping");
    expect(await first.next()).toEqual({ kind: "text", text: "echo:ping" });
    expect(updateUserById(member.id, { allowedRooms: [] }).ok).toBe(true);
    expect(await first.next()).toEqual(revoked);
    await until(() => wsApp.closes.length === 1);
    expect(wsApp.closes[0]).toEqual({ code: 1008, reason: "session ended" });

    grantMemberAppRoom(srv, "Member");
    const second = await connected(
      srv,
      label,
      await signIn(srv, label, rawSessionId),
      "/echo",
    );
    second.send("pong");
    expect(await second.next()).toEqual({ kind: "text", text: "echo:pong" });
    const creatorId = appRegistry.get("hello")!.createdByAgentId!;
    // An ordinary agent may not move agents; a privileged one acts as its
    // owner manager, as an owner's browser would.
    const privileged = mintAgentToken(
      creatorId,
      getUserByName("Morgan")!.id,
      true,
    );
    const moved = await srv.http(`/api/agents/${creatorId}/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${privileged}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetRoomId: srv.agentManager.createRoom("Elsewhere"),
      }),
    });
    expect(moved.status).toBe(200);
    expect(await second.next()).toEqual(revoked);
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
    const raw = startRawApp("hello", {
      protocolLine: (offered) =>
        offered?.includes("superchat") ? "superchat" : null,
    });
    app = raw;
    const cookie = await signIn(srv, label, rawSessionId);
    const client = await connected(srv, label, cookie, "/echo", {
      protocols: "chat, superchat",
    });
    // The client's offer reached the app untouched...
    expect(raw.offers).toEqual(["chat, superchat"]);
    // ...and the app's choice, not the runtime's, reached the client.
    expect(client.handshakeHeaders["sec-websocket-protocol"]).toBe("superchat");
    client.drop();
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("refuses when the app selects none of the offered protocols, or one nobody offered", async () => {
    // None: ruled 2026-08-07, refused rather than relayed, because a browser
    // fails a connection itself when its offer is not acknowledged (WHATWG 2.2
    // step 11.2) - so relaying it would make the hostname succeed where the
    // app's own port fails, with the two ends disagreeing about the protocol.
    // The relay decides that one itself; the unoffered one is the upstream's
    // refusal, which the relay has to answer with the same body.
    const { srv, label, rawSessionId } = await office();
    app = startRawApp("hello", {
      protocolLine: (_offered, path) =>
        path === "/none" ? null : "something-else",
    });
    const cookie = await signIn(srv, label, rawSessionId);
    for (const path of ["/none", "/other"]) {
      const result = await wsConnect(srv.port, {
        host: appHost(label),
        path,
        cookie,
        protocols: "chat",
      });
      expect(
        result.ok
          ? { path, upgraded: true }
          : {
              path,
              status: result.response.status,
              body: result.response.body,
            },
      ).toEqual({ path, status: 502, body: APP_WS_PROTOCOL_MISMATCH_BODY });
    }
  });

  it("refuses a malformed offer without dialing the app", async () => {
    const { srv, label, rawSessionId } = await office();
    const seen: SeenUpgrade[] = [];
    app = startWsApp("hello", seen);
    const cookie = await signIn(srv, label, rawSessionId);
    // Every malformed shape is the pure parser's table (app-ws-lifecycle
    // .test.ts, "parses a subprotocol offer strictly"). This is the wiring, on
    // the oversized case: it is refused HERE, with a 400 and no connection to
    // the app, rather than being forwarded into the upgrade request and refused
    // by the upstream's byte ceiling after a permit and a dial. `seen` staying
    // empty is the assertion that carries that.
    const oversized = "a".repeat(APP_WS_MAX_PROTOCOL_HEADER_BYTES + 1);
    for (const protocols of [oversized]) {
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
          body: BAD_REQUEST_BODY,
        });
      }
    }
    expect(seen).toEqual([]);
  });
});

// Poll until a condition holds. Socket lifecycle events land on their own turns,
// and a fixed sleep is either flaky or slow; this is neither.
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}
