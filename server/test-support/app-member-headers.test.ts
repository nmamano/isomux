// Member identity on relayed app requests, through the REAL office.
//
// The relay tells an app which signed-in member sent a request, in two headers
// it owns: X-Isomux-Member-Id and X-Isomux-Member-Name (percent-encoded). The
// office owns the whole X-Isomux- prefix toward an app, so a browser cannot
// pre-fill these or any later relay header. A screenshot capture has no member
// and gets none.
//
// Every case goes through the whole chain - Host classification, the gate, the
// relay - because the member is resolved at the gate and written by the relay,
// and only the chain proves the two are joined.

import { describe, it, expect, afterEach } from "bun:test";
import {
  NAVIGATION_HEADERS,
  anAgentToken,
  appHost,
  grantMemberAppRoom,
  raw,
  registerApp,
  signIn,
  startFlatOffice,
  withAppCookie,
  wsConnect,
  cookieValue,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { mintPreviewGrant } from "../app-auth.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
let app: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  void app?.stop(true);
  app = null;
  await server?.stop();
  server = null;
});

const APP = "whoami";
// Non-ASCII on purpose: a header value must be ASCII, so the name only arrives
// intact if the relay encodes it.
const MEMBER_NAME = "Zoë Ñúñez 名前";

// Headers a browser could send to pose as someone, or to pre-fill a relay
// header that does not exist yet. Mixed case, because header names are not.
const FORGED = {
  "X-Isomux-Member-Id": "ffffffff",
  "X-Isomux-Member-Name": "Nil",
  "x-isomux-member-role": "owner",
  "X-ISOMUX-Signature": "forged",
};

// Every header the app saw on each request, names lowercased by the runtime.
type Seen = Record<string, string>[];

function isomuxHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith("x-isomux-")),
  );
}

// An app that records every request's headers and upgrades a WebSocket when
// asked for one, on the port the registry allocated.
function startApp(seen: Seen): ReturnType<typeof Bun.serve> {
  const record = appRegistry.get(APP);
  if (!record) throw new Error(`no registered app ${APP}`);
  return Bun.serve({
    port: record.port,
    hostname: "127.0.0.1",
    fetch(req, s) {
      seen.push(Object.fromEntries(req.headers));
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (s.upgrade(req, { data: undefined })) return;
      }
      return new Response("ok");
    },
    websocket: { message() {} },
  });
}

// An office with the app and a member who may open it.
async function office(): Promise<{
  srv: TestServer;
  label: string;
  rawSessionId: string;
  memberId: string;
}> {
  const srv = await startFlatOffice((s) => {
    server = s;
  });
  const token = await anAgentToken(srv);
  const label = await registerApp(srv, token, APP);
  const member = await srv.seedMember(MEMBER_NAME);
  grantMemberAppRoom(srv, member.username);
  const record = getUserByName(member.username);
  if (!record) throw new Error("seeded member is missing");
  // The condition every case below depends on: the stored name is the
  // non-ASCII one, not a normalized copy.
  expect(record.name).toBe(MEMBER_NAME);
  return { srv, label, rawSessionId: member.rawSessionId, memberId: record.id };
}

function expectMember(headers: Record<string, string>, memberId: string): void {
  // Exactly the two member headers: every forged X-Isomux- header is gone.
  expect(Object.keys(isomuxHeaders(headers)).sort()).toEqual([
    "x-isomux-member-id",
    "x-isomux-member-name",
  ]);
  expect(headers["x-isomux-member-id"]).toBe(memberId);
  const encoded = headers["x-isomux-member-name"];
  expect(decodeURIComponent(encoded)).toBe(MEMBER_NAME);
}

describe("app relay: member identity", () => {
  it("tells the app which member sent an HTTP request, and drops forged copies", async () => {
    const { srv, label, rawSessionId, memberId } = await office();
    const seen: Seen = [];
    app = startApp(seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const res = await raw(srv.port, {
      host: appHost(label),
      path: "/page",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie), ...FORGED },
    });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    expectMember(seen[0], memberId);
  });

  it("tells the app which member opened a WebSocket, and drops forged copies", async () => {
    const { srv, label, rawSessionId, memberId } = await office();
    const seen: Seen = [];
    app = startApp(seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const result = await wsConnect(srv.port, {
      host: appHost(label),
      path: "/socket",
      cookie,
      headers: FORGED,
    });
    expect(result.ok).toBe(true);
    if (result.ok) result.client.drop();
    expect(seen.length).toBe(1);
    expect(seen[0].upgrade?.toLowerCase()).toBe("websocket");
    expectMember(seen[0], memberId);
  });

  it("names no member on a screenshot capture, forged or not", async () => {
    const { srv, label } = await office();
    const seen: Seen = [];
    app = startApp(seen);
    const record = appRegistry.get(APP);
    if (!record) throw new Error(`no registered app ${APP}`);
    const grant = mintPreviewGrant({
      agentId: "preview-agent",
      app: record,
      appHost: appHost(label),
      returnPath: "/",
      revalidate: () => true,
      expiresAt: Date.now() + 60_000,
    });
    if (!grant) throw new Error("preview grant refused");
    const redeemed = await raw(srv.port, {
      host: appHost(label),
      path: `/__isomux/preview?code=${encodeURIComponent(grant.code)}`,
      headers: NAVIGATION_HEADERS,
    });
    expect(redeemed.status).toBe(302);
    const cookie = cookieValue(redeemed);

    const plain = await raw(srv.port, {
      host: appHost(label),
      path: "/page",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
    });
    const forged = await raw(srv.port, {
      host: appHost(label),
      path: "/page",
      headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie), ...FORGED },
    });
    // The capture reached the app both times: the absence below is the relay's
    // doing, not a refusal.
    expect([plain.status, forged.status]).toEqual([200, 200]);
    expect(seen.map(isomuxHeaders)).toEqual([{}, {}]);
  });
});
