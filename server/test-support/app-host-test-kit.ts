// Shared rig for the app-hostname tests: booting an office that HAS app
// hostnames, speaking raw HTTP/1.1 to it with a Host of our choosing, and
// registering apps through the real REST route.
//
// It lives outside a .test.ts file so both the dispatch tests (slice 3) and the
// handshake tests (slice 4) drive an identical office and compare against
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
import { buildPublicOrigin } from "../auth.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
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
export const NOT_READY = {
  status: 503,
  body: "this app is not reachable yet\n",
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
