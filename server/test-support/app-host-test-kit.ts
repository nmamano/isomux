// Shared rig for the app-hostname tests: booting an office that HAS app
// hostnames, speaking raw HTTP/1.1 to it with a Host of our choosing, and
// registering apps through the real REST route.
//
// It lives outside a .test.ts file so both the dispatch and handshake tests
// drive an identical office and compare against
// identical placeholder constants. Duplicating the rig would let the two files'
// notions of "the neutral 404" drift a word apart, which is precisely the
// property the app-host arm promises.
//
// Raw sockets rather than fetch: byte-exact comparisons need unnormalized
// header order, an arbitrary Host, and the ability to hold a socket open
// through a 101.

import { expect } from "bun:test";
import { connect } from "net";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { STATE_ROOT } from "../config.ts";
import { appRegistry } from "../app-registry.ts";
import { APP_COOKIE_NAME } from "../app-auth.ts";
import {
  FrameDecoder,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodeTextFrame,
} from "../ws-frames.ts";
import { buildPublicOrigin } from "../auth.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo } from "../../shared/types.ts";

// The office's public host in the HTTPS-shaped tests, and therefore - the flat
// shape - its app-host domain too.
export const OFFICE_HOST = "office.example";
export const HTTPS_ORIGIN = `https://${OFFICE_HOST}`;

export function patchOfficeConfig(patch: Record<string, unknown>): void {
  const file = join(STATE_ROOT, "office-config.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    current = {};
  }
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

// An office reachable at https://office.example - which, under the flat shape,
// is all it takes for its children to become app hostnames. The signal is
// boot-frozen, so it goes to disk through the real Access route and a cold
// restart picks it up: the same mechanism auth-host-cookie.test.ts uses for
// the HTTPS cookie arm.
//
// `track` is called with every server this creates, including the one that is
// discarded by the restart, so a caller's afterEach can stop whichever is live
// even if the restart throws.
export async function startFlatOffice(
  track: (srv: TestServer) => void,
): Promise<TestServer> {
  const first = await startTestServer();
  track(first);
  const owner = await first.seedOwner("Boss");
  const r = await first.http("/api/office/access", {
    method: "PUT",
    rawSessionId: owner.rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalAccess: true, publicOrigin: HTTPS_ORIGIN }),
  });
  if (r.status !== 200) throw new Error(`access PUT failed: ${r.status}`);
  const srv = await first.restart();
  track(srv);
  if (buildPublicOrigin().origin !== HTTPS_ORIGIN) {
    throw new Error(`expected ${HTTPS_ORIGIN} after restart`);
  }
  return srv;
}

export interface RawResponse {
  // The full response as received, headers and body, verbatim.
  raw: string;
  status: number;
  // Everything but the Date header, which changes every second.
  stable: string;
  // Lowercased header names -> value, and the body on its own, so a contract
  // can be asserted by EQUALITY. "contains the right text" would survive
  // appending the host, the label or session material to a body these slices
  // promise is a constant.
  headers: Record<string, string>;
  // Every Set-Cookie line, in order: a response can carry more than one and the
  // single-value map above would keep only the last.
  setCookies: string[];
  body: string;
}

// One raw HTTP/1.1 request with a Host of our choosing. Resolves when the
// server closes the connection, or - so a wrongly-returned 101 fails as an
// assertion instead of hanging - shortly after it goes idle.
export function raw(
  port: number,
  opts: {
    host: string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
  },
): Promise<RawResponse> {
  return new Promise((resolve) => {
    let out = "";
    const extra = opts.headers ?? {};
    const keepOpen = Object.keys(extra).some(
      (k) => k.toLowerCase() === "connection",
    );
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `${opts.method ?? "GET"} ${opts.path ?? "/"} HTTP/1.1`,
          `Host: ${opts.host}`,
          ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
          ...(keepOpen ? [] : ["Connection: close"]),
          "",
          "",
        ].join("\r\n"),
      );
    });
    const done = () => {
      socket.destroy();
      resolve(parseRaw(out));
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      out += chunk.toString();
    });
    socket.on("end", done);
    socket.setTimeout(500, done);
    // A malformed Host makes the office's own URL parse throw and Bun resets
    // the connection, so "no response" is a real, comparable outcome here
    // rather than a test-harness failure. Resolving with a marker keeps it
    // comparable across two boots; a genuinely dead server surfaces as the
    // baseline sanity assertion failing instead.
    socket.on("error", (err) => {
      socket.destroy();
      const code = (err as { code?: string }).code ?? "ERR";
      resolve({
        raw: out,
        status: 0,
        stable: `<socket ${code}>`,
        headers: {},
        setCookies: [],
        body: "",
      });
    });
  });
}

export function parseRaw(out: string): RawResponse {
  const split = out.indexOf("\r\n\r\n");
  const head = split === -1 ? out : out.slice(0, split);
  const body = split === -1 ? "" : out.slice(split + 4);
  const lines = head.split("\r\n");
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "set-cookie") setCookies.push(value);
      headers[name] = value;
    }
  }
  return {
    raw: out,
    status: parseInt(lines[0]?.split(" ")[1] ?? "0", 10),
    stable: out
      .split("\r\n")
      .filter((line) => !/^date:/i.test(line))
      .join("\r\n"),
    headers,
    setCookies,
    body,
  };
}

// The exact contract for each placeholder response. Status, both headers and
// the body compared by equality: nothing from the request may appear in any of
// them.
export const NOT_FOUND = {
  status: 404,
  body: "not found\n",
  contentType: "text/plain; charset=utf-8",
  cacheControl: "no-store",
};
// A caller who is past the gate and asked for a WebSocket on an app whose port
// has nothing listening. The relay dials the app BEFORE upgrading, so a dial that
// cannot be made is still an ordinary HTTP refusal - which is the whole reason
// that ordering was chosen.
export const WS_UNREACHABLE = {
  status: 502,
  body: "this app did not respond\n",
  contentType: "text/plain; charset=utf-8",
  cacheControl: "no-store",
};
// The refusal an upgrade gets with no live app session. Never a redirect: no
// WebSocket client can follow one.
export const WS_AUTH_REQUIRED = {
  status: 401,
  body: "authentication required\n",
  contentType: "text/plain; charset=utf-8",
  cacheControl: "no-store",
};
// What a request that is PAST THE GATE looks like in an office where the app is
// registered and running but nothing is actually listening on its port - which
// is every test that registers an app without also binding one. The authenticated
// branch is the relay, so reaching this refusal is itself the
// proof that the caller was authenticated; what the relay does with a real app
// behind it is pinned in app-host-relay.test.ts.
export const RELAY_UNREACHABLE = {
  status: 502,
  body: "this app did not respond\n",
  contentType: "text/plain; charset=utf-8",
  cacheControl: "no-store",
};

export function expectPlaceholder(
  res: RawResponse,
  want: typeof NOT_FOUND,
  where: string,
): void {
  expect({
    where,
    status: res.status,
    body: res.body,
    contentType: res.headers["content-type"],
    cacheControl: res.headers["cache-control"],
  }).toEqual({
    where,
    status: want.status,
    body: want.body,
    contentType: want.contentType,
    cacheControl: want.cacheControl,
  });
}

// The office URL an unauthenticated document navigation is sent to. Built the
// way a caller expects to read it rather than by calling the production code,
// so a change to either side has to be made deliberately in both.
export function bounceLocation(label: string, path: string): string {
  return (
    `${HTTPS_ORIGIN}/auth/app?app=${encodeURIComponent(label)}` +
    `&r=${encodeURIComponent(path)}`
  );
}

// A bounce into the handshake, asserted by equality: the exact Location, plus
// the two headers that keep the code and the path out of a cache and out of the
// next request's Referer.
export function expectBounce(
  res: RawResponse,
  want: { label: string; path: string },
  where: string,
): void {
  expect({
    where,
    status: res.status,
    location: res.headers["location"],
    cacheControl: res.headers["cache-control"],
    referrerPolicy: res.headers["referrer-policy"],
  }).toEqual({
    where,
    status: 302,
    location: bounceLocation(want.label, want.path),
    cacheControl: "no-store",
    referrerPolicy: "no-referrer",
  });
}

// The refusal every unauthenticated non-navigation gets: no redirect, nothing
// cached, and a body that says only that a credential is needed.
export function expectAuthRequired(res: RawResponse, where: string): void {
  expect({
    where,
    status: res.status,
    body: res.body,
    cacheControl: res.headers["cache-control"],
    hasLocation: "location" in res.headers,
  }).toEqual({
    where,
    status: 401,
    body: "authentication required\n",
    cacheControl: "no-store",
    hasLocation: false,
  });
}

// A browser's top-level navigation, which is the only thing the arm bounces.
export const NAVIGATION_HEADERS = {
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Site": "none",
};

export const WS_UPGRADE_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

export async function spawnAgent(
  srv: TestServer,
  name: string,
): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// An agent bearer token, seeding the owner first if this office has none.
export async function anAgentToken(srv: TestServer): Promise<string> {
  if (!getUserByName("Boss")) await srv.seedOwner("Boss");
  const ownerId = getUserByName("Boss")!.id;
  const bot = await spawnAgent(srv, `AppBot-${Math.random()}`.slice(0, 20));
  return mintAgentToken(bot.id, ownerId);
}

// Register an app through the real REST route and return its hostname label.
export async function registerApp(
  srv: TestServer,
  bearer: string,
  name: string,
): Promise<string> {
  const res = await srv.http("/api/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      command: "bun run serve.ts",
      cwd: srv.stateRoot,
    }),
  });
  if (res.status !== 201) {
    throw new Error(`register ${name}: ${res.status} ${await res.text()}`);
  }
  const label = appRegistry.get(name)?.hostLabel;
  if (!label) throw new Error(`no label for ${name}`);
  return label;
}

export async function deleteApp(
  srv: TestServer,
  bearer: string,
  name: string,
): Promise<void> {
  const res = await srv.http(`/api/apps/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (res.status !== 204) throw new Error(`delete ${name}: ${res.status}`);
}

// The hops are asserted one by one in app-auth-handshake.test.ts. Here they are
// a means to an end: every relay test needs a request that is already past the
// gate, and there is exactly one way to get one.

export function appHost(label: string): string {
  return `${label}.${OFFICE_HOST}`;
}

// An office with one registered app and a signed-in member. A MEMBER rather
// than the owner on purpose: the accepted access rule is "any signed-in office
// user may open any app", and the owner's session is the one the lockout guard
// protects from sign-out.
export async function anOfficeWithAnApp(
  track: (srv: TestServer) => void,
  name = "hello",
): Promise<{
  srv: TestServer;
  label: string;
  rawSessionId: string;
  token: string;
}> {
  const srv = await startFlatOffice(track);
  const token = await anAgentToken(srv);
  const label = await registerApp(srv, token, name);
  const member = await srv.seedMember("Member");
  grantMemberAppRoom(srv, member.username);
  return { srv, label, rawSessionId: member.rawSessionId, token };
}

export function grantMemberAppRoom(srv: TestServer, username: string): void {
  const creatorRoomId = srv.agentManager.getRooms()[0].id;
  const memberRecord = getUserByName(username);
  if (!memberRecord) throw new Error("seeded member is missing");
  const granted = updateUserById(memberRecord.id, {
    allowedRooms: [creatorRoomId],
  });
  if (!granted.ok) throw new Error(`grant member app room: ${granted.error}`);
}

// The office's mint endpoint, without following the redirect.
export function mint(
  srv: TestServer,
  query: string,
  init: { rawSessionId?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return srv.http(`/auth/app${query}`, { ...init, redirect: "manual" });
}

export function codeFromMint(res: Response): string {
  const location = res.headers.get("location");
  if (!location) throw new Error("mint response carried no Location");
  const url = new URL(location);
  const code = url.searchParams.get("code");
  if (!code) throw new Error(`mint Location carried no code: ${location}`);
  return code;
}

// Redeem a code on the app host, over a raw socket so the Host header and the
// response bytes are ours to choose and to compare.
export function redeem(
  srv: TestServer,
  label: string,
  code: string,
): Promise<RawResponse> {
  return raw(srv.port, {
    host: appHost(label),
    path: `/__isomux/auth?code=${encodeURIComponent(code)}`,
    headers: NAVIGATION_HEADERS,
  });
}

export function cookieValue(res: RawResponse): string {
  const line = res.setCookies.find((c) => c.startsWith(`${APP_COOKIE_NAME}=`));
  if (!line)
    throw new Error(`no ${APP_COOKIE_NAME} in ${res.setCookies.join(" | ")}`);
  const value = line.slice(APP_COOKIE_NAME.length + 1).split(";")[0];
  if (!value) throw new Error(`empty app cookie: ${line}`);
  return value;
}

// Bounce -> mint -> redeem, returning the app cookie value.
export async function signIn(
  srv: TestServer,
  label: string,
  rawSessionId: string,
  path = "/",
): Promise<string> {
  const minted = await mint(
    srv,
    `?app=${encodeURIComponent(label)}&r=${encodeURIComponent(path)}`,
    { rawSessionId },
  );
  if (minted.status !== 302) {
    throw new Error(`mint: ${minted.status} ${await minted.text()}`);
  }
  const res = await redeem(srv, label, codeFromMint(minted));
  if (res.status !== 302) throw new Error(`redeem: ${res.status} ${res.body}`);
  return cookieValue(res);
}

export function withAppCookie(value: string): Record<string, string> {
  return { Cookie: `${APP_COOKIE_NAME}=${value}` };
}

// Why a hand-rolled client rather than `new WebSocket(...)`: these tests need a
// Host header of our choosing (the whole arm routes on it), an arbitrary Origin
// including none at all, a cookie the runtime would not attach, and the ability
// to DROP the TCP connection without a close frame - which is the only way to
// produce the 1006 the relay has to map honestly. None of that is reachable
// through a WebSocket client API.
//
// The frames are encoded with the office's own codec (server/ws-frames.ts),
// which is what a client role needs (masked out, unmasked in). That is not
// circular: the codec is independently tested in ws-frames.test.ts, and the leg
// this file actually exercises - the browser leg - is Bun's own server
// implementation on the other side of it.

export type WsEvent =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "close"; code: number | null; reason: string }
  // The socket ended with no close frame: the client's view of 1006.
  | { kind: "eof" };

export interface WsClient {
  send(text: string): void;
  sendBinary(data: Buffer): void;
  sendClose(code: number | null, reason?: string): void;
  // Hang up like a crashed tab: no close frame, just a dead socket.
  drop(): void;
  // The next event, waiting for it if it has not arrived.
  next(timeoutMs?: number): Promise<WsEvent>;
  // Everything seen so far, in order.
  seen: WsEvent[];
  handshakeHeaders: Record<string, string>;
}

export type WsConnectResult =
  | { ok: true; client: WsClient }
  // Anything that is not a 101, parsed like any other raw response so a refusal
  // can be compared byte for byte against the shared constants above.
  | { ok: false; response: RawResponse };

export function wsConnect(
  port: number,
  opts: {
    host: string;
    path?: string;
    cookie?: string;
    // Absent by default, since a hand-built client is exactly the case the
    // relay's Origin rule allows; pass a string to send one.
    origin?: string;
    protocols?: string;
    headers?: Record<string, string>;
  },
): Promise<WsConnectResult> {
  return new Promise((resolve) => {
    const seen: WsEvent[] = [];
    const waiters: Array<(event: WsEvent) => void> = [];
    const emit = (event: WsEvent): void => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else seen.push(event);
    };
    let upgraded = false;
    let head = Buffer.alloc(0);
    let settled = false;
    const decoder = new FrameDecoder({ maxMessageBytes: 8 * 1024 * 1024 });
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${opts.path ?? "/"} HTTP/1.1`,
          `Host: ${opts.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(opts.origin === undefined ? [] : [`Origin: ${opts.origin}`]),
          ...(opts.protocols === undefined
            ? []
            : [`Sec-WebSocket-Protocol: ${opts.protocols}`]),
          ...(opts.cookie === undefined
            ? []
            : [`Cookie: ${APP_COOKIE_NAME}=${opts.cookie}`]),
          ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
          "",
          "",
        ].join("\r\n"),
      );
    });
    const client: WsClient = {
      send(text) {
        socket.write(encodeTextFrame(text));
      },
      sendBinary(data) {
        socket.write(encodeBinaryFrame(data));
      },
      sendClose(code, reason = "") {
        socket.write(encodeCloseFrame(code, reason));
      },
      drop() {
        socket.destroy();
      },
      next(timeoutMs = 2000) {
        const ready = seen.shift();
        if (ready) return Promise.resolve(ready);
        return new Promise<WsEvent>((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error("no websocket event within the timeout")),
            timeoutMs,
          );
          waiters.push((event) => {
            clearTimeout(timer);
            res(event);
          });
        });
      },
      seen,
      handshakeHeaders: {},
    };
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        const headText = head.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(headText)) return; // handled on close/timeout
        for (const line of headText.split("\r\n").slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            client.handshakeHeaders[line.slice(0, colon).trim().toLowerCase()] =
              line.slice(colon + 1).trim();
          }
        }
        upgraded = true;
        settled = true;
        resolve({ ok: true, client });
        chunk = head.subarray(end + 4);
        head = Buffer.alloc(0);
        if (chunk.length === 0) return;
      }
      decoder.push(chunk, (message) => {
        if (message.kind === "text") emit({ kind: "text", text: message.text });
        else if (message.kind === "binary")
          emit({ kind: "binary", data: message.data });
        else if (message.kind === "close")
          emit({ kind: "close", code: message.code, reason: message.reason });
        return "continue";
      });
    });
    const finish = (): void => {
      if (settled) {
        emit({ kind: "eof" });
        return;
      }
      settled = true;
      resolve({ ok: false, response: parseRaw(head.toString("utf8")) });
    };
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
    // A refusal that leaves the connection open (Bun keeps it alive) still has
    // to resolve; the response is complete once the body has arrived.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ ok: false, response: parseRaw(head.toString("utf8")) });
      }
    }, 400);
  });
}
