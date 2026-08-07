// The WebSocket relay's lifecycle, caps and refusals, driven directly (slice 6b).
//
// app-ws-relay.test.ts proves the chain works through the real office. This file
// proves the things that cannot be provoked from outside it: a cap that refuses
// on the third socket rather than the sixty-fifth, a revalidation timer that
// fires in milliseconds rather than half a minute, a browser that stops reading,
// and terminal signals arriving in the same tick.
//
// It still runs against a REAL office and a REAL app - the registry, the app
// session, the supervisor and the upstream socket are all genuine - and reaches
// inside at exactly one seam: the upgrade thunk hands back the relay object, so
// a test can play the part Bun would play. The alternative was faking the
// upstream, which would have tested the fake.

import { describe, it, expect, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  anOfficeWithAnApp,
  appHost,
  signIn,
  registerApp,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { createHash } from "crypto";
import { APP_COOKIE_NAME } from "../app-auth.ts";
import { APP_BUSY_BODY } from "../app-host-responses.ts";
import {
  AppWsRelay,
  APP_WS_MAX_PROTOCOL_HEADER_BYTES,
  originAllowed,
  parseOfferedProtocols,
  relayWsToApp,
  _testResetWsRelay,
  _testWsSocketsOpen,
  type AppRelayWsData,
} from "../app-ws-relay.ts";

let server: TestServer | null = null;
const stoppers: Array<() => void> = [];
afterEach(async () => {
  while (stoppers.length > 0) stoppers.pop()!();
  await server?.stop();
  server = null;
  // DRAIN BEFORE RESETTING, in that order. Stopping the office and the app kills
  // the upstream sockets, and each of those releases its permit on a later turn;
  // resetting the counters first would let those releases land afterwards and
  // drive the count negative, so the next test's cap would be wrong instead of
  // this one's teardown being wrong.
  await Bun.sleep(50);
  _testResetWsRelay();
});

// A stand-in for Bun's server socket, which is what the office would supply.
// Records everything the relay does to it, and lets a test dictate the two
// answers that drive the backpressure policy: what send() returns and what
// getBufferedAmount() reports.
interface FakeWs {
  ws: ServerWebSocket<AppRelayWsData>;
  sent: Array<string | Buffer>;
  closes: Array<{ code: number; reason: string }>;
  terminated: number;
  sendReturns: number | null;
  buffered: number;
}

function fakeWs(): FakeWs {
  const state: FakeWs = {
    sent: [],
    closes: [],
    terminated: 0,
    sendReturns: null,
    buffered: 0,
    ws: null as unknown as ServerWebSocket<AppRelayWsData>,
  };
  state.ws = {
    send(data: string | Buffer) {
      state.sent.push(data);
      if (state.sendReturns !== null) return state.sendReturns;
      return typeof data === "string" ? Buffer.byteLength(data) : data.length;
    },
    getBufferedAmount() {
      return state.buffered;
    },
    close(code: number, reason: string) {
      state.closes.push({ code, reason });
    },
    terminate() {
      state.terminated++;
    },
  } as unknown as ServerWebSocket<AppRelayWsData>;
  return state;
}

// A real WebSocket app on the port the registry allocated, RECORDING THE CLOSES
// IT SEES. That recording is the point: a relay-diagnosed fault has to reach both
// ends with the same code, and a test that only watches the browser leg passes
// while the app is being told something else entirely - which is exactly the
// defect this file used to hide.
function startApp(name: string): {
  closes: Array<{ code: number; reason: string }>;
} {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  const closes: Array<{ code: number; reason: string }> = [];
  const srv = Bun.serve({
    port: record.port,
    hostname: "127.0.0.1",
    fetch(req, s) {
      if (s.upgrade(req)) return;
      return new Response("no");
    },
    websocket: {
      message(ws, m) {
        ws.send(m);
      },
      close(_ws, code, reason) {
        closes.push({ code, reason });
      },
    },
  });
  stoppers.push(() => void srv.stop(true));
  return { closes };
}

// An app that speaks the handshake by hand and then answers NOTHING - no echo of
// a close, no frames. It exists to hold the app leg physically open after the
// office has initiated a close, which is the window the socket cap has to keep
// counting through. A Bun app cannot do this: it answers a close immediately.
function startSilentApp(
  name: string,
  opts: { closeOnConnect?: boolean } = {},
): void {
  const record = appRegistry.get(name);
  if (!record) throw new Error(`no registered app ${name}`);
  const srv = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: record.port,
    socket: {
      data(socket, chunk) {
        const head = Buffer.from(chunk).toString("latin1");
        if (!head.startsWith("GET ")) return; // ignore frames entirely
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        const parts: Buffer[] = [
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            "latin1",
          ),
        ];
        if (opts.closeOnConnect) {
          const payload = Buffer.concat([
            Buffer.from([0x0f, 0xa1]), // 4001
            Buffer.from("app done", "utf8"),
          ]);
          parts.push(
            Buffer.concat([Buffer.from([0x88, payload.length]), payload]),
          );
        }
        socket.write(Buffer.concat(parts));
      },
    },
  });
  stoppers.push(() => srv.stop(true));
}

interface Opened {
  relay: AppWsRelay;
  browser: FakeWs;
}

// One relayed socket, opened the way production opens it (through
// relayWsToApp), with the browser leg played by a fake. `seams` are the same
// test-only overrides the HTTP relay has.
async function open(
  srv: TestServer,
  name: string,
  cookie: string,
  seams: Parameters<typeof relayWsToApp>[1] extends infer T
    ? Partial<Omit<T, "app" | "host" | "apps" | "supervisor" | "upgrade">>
    : never = {},
): Promise<{ ok: true; opened: Opened } | { ok: false; response: Response }> {
  const app = appRegistry.get(name);
  if (!app) throw new Error(`no registered app ${name}`);
  const host = appHost(app.hostLabel);
  const req = new Request(`http://${host}/socket`, {
    headers: {
      Host: host,
      Upgrade: "websocket",
      Connection: "Upgrade",
      Cookie: `${APP_COOKIE_NAME}=${cookie}`,
    },
  });
  let captured: AppWsRelay | null = null;
  const response = await relayWsToApp(req, {
    app,
    host,
    apps: appRegistry.list(),
    supervisor: srv.appSupervisor,
    upgrade: (_req, data) => {
      captured = data.relay;
      return true;
    },
    ...seams,
  });
  if (response !== undefined) return { ok: false, response };
  if (captured === null) throw new Error("upgrade was never called");
  const browser = fakeWs();
  (captured as AppWsRelay).attachBrowser(browser.ws);
  return { ok: true, opened: { relay: captured, browser } };
}

async function office(name = "hello") {
  const rig = await anOfficeWithAnApp((srv) => {
    server = srv;
  }, name);
  const app = startApp(name);
  const cookie = await signIn(rig.srv, rig.label, rig.rawSessionId);
  return { ...rig, cookie, app };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await Bun.sleep(5);
  }
}

describe("app-ws relay: the socket caps", () => {
  it("refuses past the per-app cap and frees the slot when a socket ends", async () => {
    const { srv, cookie } = await office();
    const seams = { maxPerApp: 2, maxTotal: 8 };
    const first = await open(srv, "hello", cookie, seams);
    const second = await open(srv, "hello", cookie, seams);
    expect(first.ok && second.ok).toBe(true);
    expect(_testWsSocketsOpen()).toEqual({ total: 2, perApp: 2 });

    const third = await open(srv, "hello", cookie, seams);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.response.status).toBe(429);
      expect(await third.response.text()).toBe(APP_BUSY_BODY);
    }
    // The refusal did not take a slot of its own, which is the accounting bug a
    // cap normally has: it refuses and leaks.
    expect(_testWsSocketsOpen()).toEqual({ total: 2, perApp: 2 });

    if (first.ok) first.opened.relay.browserClosed(1000, "done");
    await until(() => _testWsSocketsOpen().total === 1);
    const fourth = await open(srv, "hello", cookie, seams);
    expect(fourth.ok).toBe(true);
  });

  it("refuses past the office-wide cap across different apps", async () => {
    const { srv, cookie, token } = await office();
    const otherLabel = await registerApp(srv, token, "other");
    startApp("other");
    const otherCookie = await signIn(
      srv,
      otherLabel,
      (await srv.seedMember("Two")).rawSessionId,
    );
    const seams = { maxPerApp: 8, maxTotal: 2 };
    expect((await open(srv, "hello", cookie, seams)).ok).toBe(true);
    expect((await open(srv, "other", otherCookie, seams)).ok).toBe(true);
    // The pool is office-wide: a third socket is refused even though neither app
    // is anywhere near its own cap.
    const third = await open(srv, "hello", cookie, seams);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.response.status).toBe(429);
  });

  // BOTH genuine terminal entry points, injected in the same tick, in both
  // orders of arrival. The earlier version of this test called browserClosed
  // twice and never injected an upstream close at all - so it was named for a
  // race it did not run, and the real upstream close only arrived later as an
  // incidental socket event.
  for (const first of ["upstream", "browser"] as const) {
    it(`releases exactly once when both legs die in the same tick (${first} first)`, async () => {
      const { srv, cookie } = await office();
      const result = await open(srv, "hello", cookie, { maxTotal: 4 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(_testWsSocketsOpen().total).toBe(1);
      const relay = result.opened.relay;
      const upstreamClose = () =>
        relay.onUpstreamClose({
          code: 1000,
          reason: "app done",
          abnormal: false,
          detail: null,
        });
      const browserClose = () => relay.browserClosed(1006, "");
      if (first === "upstream") {
        upstreamClose();
        browserClose();
      } else {
        browserClose();
        upstreamClose();
      }
      // And a third signal for good measure: a relay that released per signal
      // would go negative here, and the NEXT test's cap would fail instead of
      // this one.
      relay.browserClosed(1000, "again");
      await until(() => _testWsSocketsOpen().total === 0);
      expect(_testWsSocketsOpen()).toEqual({ total: 0, perApp: 0 });
    });
  }
});

describe("app-ws relay: the cap counts SOCKETS, not relay objects", () => {
  // The invariant these three exist for: a permit released when a close is
  // INITIATED would let a replacement take the slot while the old sockets are
  // still physically up, and a repeated fault could then hold more than the
  // ruled 64/32 real sockets under a cap of 64/32. Each case below occupies the
  // only slot, initiates a close, proves a replacement is REFUSED while a leg
  // has not reported, and then frees exactly one slot with the terminal
  // callback.

  it("keeps the slot while the app leg has not ended (relay-diagnosed fault)", async () => {
    const { srv, cookie } = await office();
    // Silent app: it will never answer our close, so the app leg stays up until
    // slice 6a's close-handshake budget expires - a deterministic window.
    while (stoppers.length > 0) stoppers.pop()!();
    startSilentApp("hello");
    const seams = {
      maxPerApp: 1,
      bufferMaxBytes: 4096,
      upstreamLimits: { closeHandshakeMs: 400 },
    };
    const first = await open(srv, "hello", cookie, seams);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.opened.browser.buffered = 4000;
    first.opened.relay.onUpstreamMessage({
      kind: "text",
      text: "x".repeat(200),
    });
    expect(first.opened.browser.closes[0].code).toBe(1011);

    // BOTH legs are still up. The slot is not free, and a replacement is
    // refused rather than admitted alongside two live sockets.
    expect(_testWsSocketsOpen()).toEqual({ total: 1, perApp: 1 });
    const denied = await open(srv, "hello", cookie, seams);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(429);

    // The browser leg reports first: still not free, because the app leg is up.
    first.opened.relay.browserClosed(1011, "browser stopped reading");
    expect(_testWsSocketsOpen().total).toBe(1);
    const stillDenied = await open(srv, "hello", cookie, seams);
    expect(stillDenied.ok).toBe(false);

    // Only when the app leg finally ends does the slot come back - exactly one.
    await until(() => _testWsSocketsOpen().total === 0, 4000);
    const replacement = await open(srv, "hello", cookie, seams);
    expect(replacement.ok).toBe(true);
    expect(_testWsSocketsOpen()).toEqual({ total: 1, perApp: 1 });
  });

  it("keeps the slot while the browser leg has not ended (app closed first)", async () => {
    const { srv, cookie } = await office();
    // An app that closes the moment it connects: the app leg ends immediately
    // and the browser leg is the one still outstanding.
    while (stoppers.length > 0) stoppers.pop()!();
    startSilentApp("hello", { closeOnConnect: true });
    const seams = { maxPerApp: 1 };
    const first = await open(srv, "hello", cookie, seams);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The app's own code reached the browser leg...
    await until(() => first.opened.browser.closes.length > 0);
    expect(first.opened.browser.closes[0]).toEqual({
      code: 4001,
      reason: "app done",
    });
    // ...and that leg has not reported back, so the slot is still taken.
    expect(_testWsSocketsOpen().total).toBe(1);
    const denied = await open(srv, "hello", cookie, seams);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(429);

    first.opened.relay.browserClosed(4001, "app done");
    await until(() => _testWsSocketsOpen().total === 0);
    // Exactly one slot came back, not two.
    expect(_testWsSocketsOpen()).toEqual({ total: 0, perApp: 0 });
    const replacement = await open(srv, "hello", cookie, seams);
    expect(replacement.ok).toBe(true);
  });

  it("keeps the slot when the runtime attaches SYNCHRONOUSLY inside upgrade()", async () => {
    // The sharpest case, and it only exists because of a measured Bun behavior:
    // `server.upgrade()` runs the socket's `open` handler INSIDE the call. With
    // an app that greets and closes before the upgrade, that means attachBrowser
    // flushes the greeting, applies the recorded close and finishes the relay
    // while upgrade() has not yet returned. If the browser leg were marked live
    // only AFTER the call, that finish would see no browser leg, hand the permit
    // back while the browser's close handshake was still live, and set the flag
    // on a leg that no longer had a permit behind it.
    //
    // The upgrade seam here attaches synchronously on purpose: it plays exactly
    // the part the runtime plays, so the ordering is deterministic rather than a
    // race the test hopes to lose.
    const { srv, cookie } = await office();
    while (stoppers.length > 0) stoppers.pop()!();
    startSilentApp("hello", { closeOnConnect: true });

    const app = appRegistry.get("hello")!;
    const host = appHost(app.hostLabel);
    const req = new Request(`http://${host}/socket`, {
      headers: {
        Host: host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        Cookie: `${APP_COOKIE_NAME}=${cookie}`,
      },
    });
    const browser = fakeWs();
    let relay: AppWsRelay | null = null;
    const response = await relayWsToApp(req, {
      app,
      host,
      apps: appRegistry.list(),
      supervisor: srv.appSupervisor,
      maxPerApp: 1,
      upgrade: (_r, data) => {
        relay = data.relay;
        // Synchronously, before returning - what Bun does.
        data.relay.attachBrowser(browser.ws);
        return true;
      },
    });
    expect(response).toBeUndefined();
    // The app's own close reached the browser leg...
    expect(browser.closes[0]).toEqual({ code: 4001, reason: "app done" });
    // ...and that leg has NOT reported back, so the slot is still occupied and a
    // replacement is refused.
    expect(_testWsSocketsOpen()).toEqual({ total: 1, perApp: 1 });
    const denied = await open(srv, "hello", cookie, { maxPerApp: 1 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(429);
    // Only the real close callback frees it, and exactly once.
    (relay as unknown as AppWsRelay).browserClosed(4001, "app done");
    await until(() => _testWsSocketsOpen().total === 0);
    expect(_testWsSocketsOpen()).toEqual({ total: 0, perApp: 0 });
  });

  it("holds nothing when the runtime refuses the upgrade, and nothing when it throws", async () => {
    const { srv, cookie } = await office();
    for (const mode of ["refuse", "throw"] as const) {
      const app = appRegistry.get("hello")!;
      const host = appHost(app.hostLabel);
      const req = new Request(`http://${host}/socket`, {
        headers: {
          Host: host,
          Upgrade: "websocket",
          Connection: "Upgrade",
          Cookie: `${APP_COOKIE_NAME}=${cookie}`,
        },
      });
      const response = await relayWsToApp(req, {
        app,
        host,
        apps: appRegistry.list(),
        supervisor: srv.appSupervisor,
        upgrade: () => {
          if (mode === "throw") throw new Error("runtime seam blew up");
          return false;
        },
      });
      expect(response).toBeDefined();
      expect(response!.status).toBe(500);
      expect(await response!.text()).toBe("websocket upgrade failed\n");
      // There is no browser leg, so the slot comes back as soon as the app leg
      // ends - and it must come back, including through the throwing seam.
      await until(() => _testWsSocketsOpen().total === 0, 4000);
    }
  });

  it("frees nothing at all while a browser-initiated close is in flight", async () => {
    const { srv, cookie } = await office();
    while (stoppers.length > 0) stoppers.pop()!();
    startSilentApp("hello");
    const seams = { maxPerApp: 1, upstreamLimits: { closeHandshakeMs: 400 } };
    const first = await open(srv, "hello", cookie, seams);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The browser hangs up. Its leg is gone, but the app leg is mid-close.
    first.opened.relay.browserClosed(1000, "bye");
    expect(_testWsSocketsOpen().total).toBe(1);
    const denied = await open(srv, "hello", cookie, seams);
    expect(denied.ok).toBe(false);
    await until(() => _testWsSocketsOpen().total === 0, 4000);
  });
});

describe("app-ws relay: a socket that is no longer allowed to exist", () => {
  it("closes 1008 when the app is deleted under it", async () => {
    const { srv, cookie, token } = await office();
    const result = await open(srv, "hello", cookie, { recheckMs: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two ticks with nothing wrong: the timer must not close a healthy socket.
    await Bun.sleep(60);
    expect(result.opened.browser.closes).toEqual([]);

    const { deleteApp } = await import("./app-host-test-kit.ts");
    await deleteApp(srv, token, "hello");
    await until(() => result.opened.browser.closes.length > 0);
    expect(result.opened.browser.closes[0]).toEqual({
      code: 1008,
      reason: "session ended",
    });
    // The close was INITIATED, not completed: the browser leg has not reported
    // back, so the socket still exists and the slot is still occupied.
    expect(_testWsSocketsOpen().total).toBe(1);
    result.opened.relay.browserClosed(1008, "session ended");
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("closes 1008 when the office session behind the app session is revoked", async () => {
    const { srv, cookie, rawSessionId } = await office();
    const result = await open(srv, "hello", cookie, { recheckMs: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Signing out kills the office session; the app session is bound to it by
    // hash, so it stops validating on the next tick.
    await srv.http("/auth/logout", { method: "POST", rawSessionId });
    await until(() => result.opened.browser.closes.length > 0);
    expect(result.opened.browser.closes[0].code).toBe(1008);
  });
});

describe("app-ws relay: backpressure on the browser leg", () => {
  it("closes 1011 rather than handing the runtime more than the ceiling", async () => {
    const { srv, cookie } = await office();
    const result = await open(srv, "hello", cookie, { bufferMaxBytes: 4096 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { relay, browser } = result.opened;
    // The runtime says it is holding almost the whole ceiling already.
    browser.buffered = 4000;
    relay.onUpstreamMessage({ kind: "text", text: "x".repeat(200) });
    // Checked BEFORE the send, so the message never reached the runtime at all.
    expect(browser.sent).toEqual([]);
    expect(browser.closes).toEqual([
      { code: 1011, reason: "browser stopped reading" },
    ]);
    // Still occupied: asking a socket to close is not the same as it closing.
    expect(_testWsSocketsOpen().total).toBe(1);
    relay.browserClosed(1011, "browser stopped reading");
    await until(() => _testWsSocketsOpen().total === 0);
  });

  it("treats a dropped message as fatal, but not an empty one", async () => {
    const { srv, cookie } = await office();
    const dropped = await open(srv, "hello", cookie, {});
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    // 0 from send() is Bun saying it DISCARDED the message (measured, past its
    // own backpressure limit). A relay that carries on has a hole in the stream.
    dropped.opened.browser.sendReturns = 0;
    dropped.opened.relay.onUpstreamMessage({ kind: "text", text: "lost" });
    expect(dropped.opened.browser.closes).toEqual([
      { code: 1011, reason: "browser stopped reading" },
    ]);

    const empty = await open(srv, "hello", cookie, {});
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    // An EMPTY message also returns 0 and is not a drop. Without the size guard
    // this would kill every connection an app sends an empty frame on.
    empty.opened.browser.sendReturns = 0;
    empty.opened.relay.onUpstreamMessage({ kind: "text", text: "" });
    expect(empty.opened.browser.closes).toEqual([]);
  });

  it("closes 1009 for a message over the relay's message cap", async () => {
    const { srv, cookie } = await office();
    const result = await open(srv, "hello", cookie, {
      upstreamLimits: { maxMessageBytes: 64 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.opened.relay.browserMessage("y".repeat(65));
    expect(result.opened.browser.closes).toEqual([
      { code: 1009, reason: "message too large" },
    ]);
  });

  it("closes 1011 when the app stops reading, and the ceiling really refuses", async () => {
    const { srv, cookie } = await office();
    const result = await open(srv, "hello", cookie, {
      // A queue too small to hold much: the data ceiling is queueMax minus the
      // control reserve, so a few hundred bytes fill it.
      upstreamLimits: { queueMaxBytes: 2048, controlReserveBytes: 1024 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { relay, browser } = result.opened;
    // BYTE-BUDGETED, and it THROWS if the ceiling never refuses (slice 6a's
    // post-incident pattern): a mutation that removes the cap turns this loop
    // into an unbounded allocator otherwise, and the budget is what makes the
    // failure instant instead of an OOM.
    const chunk = "z".repeat(1000);
    let written = 0;
    while (browser.closes.length === 0) {
      relay.browserMessage(chunk);
      written += chunk.length;
      if (written > 5_000_000) {
        throw new Error("the upstream queue ceiling never refused a write");
      }
    }
    expect(browser.closes[0]).toEqual({
      code: 1011,
      reason: "app stopped reading",
    });
  });
});

describe("app-ws relay: the window before the socket opens", () => {
  // An app that writes its 101 AND a data frame in ONE write, so the frame
  // shares the TCP read that ends the handshake. That is what makes this test
  // deterministic rather than a race: slice 6a hands those leftover bytes to the
  // connection inside begin(), which runs BEFORE the dial's promise continuation
  // - so they are guaranteed to arrive while no relay object exists yet.
  function startGreetingApp(
    name: string,
    payloadBytes: number,
  ): { ended(): number } {
    const record = appRegistry.get(name)!;
    let ended = 0;
    const srv = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: record.port,
      socket: {
        data(socket, chunk) {
          const head = Buffer.from(chunk).toString("latin1");
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
          const accept = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          const payload = Buffer.alloc(payloadBytes, 0x61);
          // An UNMASKED text frame: server-to-client frames carry no mask.
          const header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(payload.length, 2);
          socket.write(
            Buffer.concat([
              Buffer.from(
                `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
                "latin1",
              ),
              header,
              payload,
            ]),
          );
        },
        close() {
          ended++;
        },
      },
    });
    stoppers.push(() => srv.stop(true));
    return { ended: () => ended };
  }

  it("refuses BEFORE the upgrade when the app floods the pre-open buffer", async () => {
    const { srv, cookie } = await office("hello");
    // Replace the echo app with one that greets past the ceiling in its first
    // write. 2KB of payload against a 1KB ceiling.
    while (stoppers.length > 0) stoppers.pop()!();
    const app = startGreetingApp("hello", 2048);

    // The close-handshake budget is seamed short: this app never answers a
    // close, so the app leg lives until that budget expires - and waiting the
    // production two seconds for it is how this test used to race the default
    // `until` timeout and flake.
    const result = await open(srv, "hello", cookie, {
      bufferMaxBytes: 1024,
      upstreamLimits: { closeHandshakeMs: 200 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 503, NOT the cap's 429 - the two share a body and differ only by status,
      // so both are pinned here, together, where the distinction is visible.
      expect({
        status: result.response.status,
        body: await result.response.text(),
      }).toEqual({ status: 503, body: APP_BUSY_BODY });
    }
    // No socket was opened and the connection to the app was closed rather than
    // left holding bytes nobody will read - but the slot stays occupied until
    // that connection has actually ended, which for an app that never answers a
    // close is slice 6a's close-handshake budget.
    expect(_testWsSocketsOpen().total).toBe(1);
    await until(() => app.ended() > 0, 4000);
    await until(() => _testWsSocketsOpen().total === 0, 4000);
  });

  it("releases exactly once when the browser vanishes before it ever opens", async () => {
    // Measured on Bun 1.3.11: `open` fires SYNCHRONOUSLY inside server.upgrade()
    // and fires even for a socket that has already been reset (observed order:
    // open -> upgrade() returns -> close(1006)). So a stranded permit is not
    // reachable through the runtime. This drives the defensive path anyway - a
    // relay that was upgraded and never attached - because the day that ordering
    // changes, this is the accounting that would silently drift.
    const { srv, cookie } = await office();
    const app = appRegistry.get("hello")!;
    const host = appHost(app.hostLabel);
    const req = new Request(`http://${host}/socket`, {
      headers: {
        Host: host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        Cookie: `${APP_COOKIE_NAME}=${cookie}`,
      },
    });
    let captured: AppWsRelay | null = null;
    const response = await relayWsToApp(req, {
      app,
      host,
      apps: appRegistry.list(),
      supervisor: srv.appSupervisor,
      upgrade: (_r, data) => {
        captured = data.relay;
        return true;
      },
    });
    expect(response).toBeUndefined();
    expect(_testWsSocketsOpen().total).toBe(1);
    // No attachBrowser: the socket died between the 101 and the callback.
    (captured as unknown as AppWsRelay).browserClosed(1006, "");
    await until(() => _testWsSocketsOpen().total === 0);
    // And a second terminal signal on the same relay does not double-release.
    (captured as unknown as AppWsRelay).browserClosed(1000, "again");
    expect(_testWsSocketsOpen()).toEqual({ total: 0, perApp: 0 });
  });
});

describe("app-ws relay: a diagnosed fault reaches BOTH ends the same way", () => {
  // The defect this whole describe exists for: the relay used to tell the
  // browser the ruled code and tell the app a flat 1001 "going away" - so an app
  // whose client sent an oversized message learned that the office was shutting
  // down. Every case below asserts the APP's own close, not just the browser's.
  it("tells the app 1009 when the browser sends an oversized message", async () => {
    const { srv, cookie, app } = await office();
    const result = await open(srv, "hello", cookie, {
      upstreamLimits: { maxMessageBytes: 64 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.opened.relay.browserMessage("y".repeat(65));
    expect(result.opened.browser.closes).toEqual([
      { code: 1009, reason: "message too large" },
    ]);
    await until(() => app.closes.length > 0);
    expect(app.closes[0]).toEqual({ code: 1009, reason: "message too large" });
  });

  it("tells the app 1011 when the browser stops reading", async () => {
    const { srv, cookie, app } = await office();
    const result = await open(srv, "hello", cookie, { bufferMaxBytes: 4096 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.opened.browser.buffered = 4000;
    result.opened.relay.onUpstreamMessage({
      kind: "text",
      text: "x".repeat(200),
    });
    expect(result.opened.browser.closes).toEqual([
      { code: 1011, reason: "browser stopped reading" },
    ]);
    await until(() => app.closes.length > 0);
    // 1011, not 1013: measured, Bun's server turns a peer close carrying
    // 1012-1014 or 3000-3999 into 1006 with no reason, so the semantically
    // perfect code is the one code that cannot be delivered here.
    expect(app.closes[0]).toEqual({
      code: 1011,
      reason: "browser stopped reading",
    });
  });

  it("tells the app 1008 when the session behind the socket is revoked", async () => {
    const { srv, cookie, app, rawSessionId } = await office();
    const result = await open(srv, "hello", cookie, { recheckMs: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await srv.http("/auth/logout", { method: "POST", rawSessionId });
    await until(() => app.closes.length > 0);
    expect(app.closes[0]).toEqual({ code: 1008, reason: "session ended" });
    expect(result.opened.browser.closes[0]).toEqual({
      code: 1008,
      reason: "session ended",
    });
  });
});

describe("app-ws relay: the pure rules", () => {
  it("parses a subprotocol offer strictly", () => {
    expect(parseOfferedProtocols(null)).toEqual([]);
    expect(parseOfferedProtocols("chat")).toEqual(["chat"]);
    expect(parseOfferedProtocols("chat, superchat")).toEqual([
      "chat",
      "superchat",
    ]);
    // The size bound, at the boundary: one byte under is a list, one byte over
    // is refused. A token can be syntactically perfect and still be absurd, and
    // an absurd one would otherwise be forwarded into slice 6a's upgrade
    // request and refused there, after a permit and a dial.
    const atBound = "a".repeat(APP_WS_MAX_PROTOCOL_HEADER_BYTES);
    expect(parseOfferedProtocols(atBound)).toEqual([atBound]);
    expect(
      parseOfferedProtocols("a".repeat(APP_WS_MAX_PROTOCOL_HEADER_BYTES + 1)),
    ).toBe(null);
    // Also over the bound as a LIST of legal tokens, not one long one.
    expect(
      parseOfferedProtocols(
        Array.from(
          { length: 200 },
          (_, i) => `chat-${i}-${"x".repeat(20)}`,
        ).join(", "),
      ),
    ).toBe(null);
    // Every malformed shape is `null`, i.e. refuse - never "no offer", because
    // Bun would then answer with a value nothing validated.
    for (const bad of [
      "",
      "   ",
      "chat, chat",
      "not a token",
      "chat,,x",
      "chat, ",
      "ch@t",
      "chat\r\nX-Evil: 1",
    ]) {
      expect({ bad, parsed: parseOfferedProtocols(bad) }).toEqual({
        bad,
        parsed: null,
      });
    }
  });

  it("allows an absent Origin and exactly one present value", () => {
    expect(originAllowed(null, "hello.office.example")).toBe(true);
    expect(
      originAllowed("https://hello.office.example", "hello.office.example"),
    ).toBe(true);
    for (const bad of [
      "http://hello.office.example",
      "https://hello.office.example:443",
      "https://hello.office.example/",
      "https://office.example",
      "https://evil.test",
      "null",
      "",
    ]) {
      expect({ bad, ok: originAllowed(bad, "hello.office.example") }).toEqual({
        bad,
        ok: false,
      });
    }
  });
});
