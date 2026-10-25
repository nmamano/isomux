// Cross-site requests to an app, through the REAL office (task 667bde95).
//
// SameSite=Lax keeps the app cookie off a cross-SITE POST, but a site is a
// registrable domain, not an origin: every office under one parent domain is
// same-site with every other office's app hosts. So the HTTP relay itself
// refuses a request that can change state (anything but GET, HEAD, OPTIONS)
// when the browser says another page sent it - an Origin that is not the
// app's own, or Sec-Fetch-Site same-site or cross-site - with the same 403 the
// WebSocket relay sends. The app's own pages, and clients that are not a
// browser, still reach the app.
//
// Each case goes through the whole chain - Host classification, the gate, the
// check, the relay - because the order is part of the contract: the check runs
// after the gate, so a caller with no session cannot use it to tell which
// labels are live.

import { describe, it, expect, afterEach } from "bun:test";
import {
  NAVIGATION_HEADERS,
  anAgentToken,
  appHost,
  cookieValue,
  grantMemberAppRoom,
  raw,
  registerApp,
  signIn,
  startFlatOffice,
  withAppCookie,
  type RawResponse,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry } from "../app-registry.ts";
import { mintPreviewGrant } from "../app-auth.ts";
import { APP_BAD_ORIGIN_BODY } from "../app-host-responses.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
let app: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  void app?.stop(true);
  app = null;
  await server?.stop();
  server = null;
});

const APP = "hello";

// What the app saw of each request that reached it.
interface Seen {
  method: string;
  path: string;
  member: string | null;
}

function startApp(seen: Seen[]): ReturnType<typeof Bun.serve> {
  const record = appRegistry.get(APP);
  if (!record) throw new Error(`no registered app ${APP}`);
  return Bun.serve({
    port: record.port,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        member: req.headers.get("x-isomux-member-id"),
      });
      return new Response("ok");
    },
  });
}

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
  const member = await srv.seedMember("Member");
  grantMemberAppRoom(srv, member.username);
  const record = getUserByName(member.username);
  if (!record) throw new Error("seeded member is missing");
  return { srv, label, rawSessionId: member.rawSessionId, memberId: record.id };
}

// The other office's host: same registrable domain as the app host, another
// origin. That is the case SameSite cannot see.
const SAME_SITE_PAGE = "https://evil.office.example";
const CROSS_SITE_PAGE = "https://evil.example.net";

interface Case {
  name: string;
  method: string;
  origin?: string;
  site?: string;
  expect: "relayed" | "refused";
}

function cases(label: string): Case[] {
  const own = `https://${appHost(label)}`;
  return [
    // The attack and its controls.
    {
      name: "same-site page POST",
      method: "POST",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "refused",
    },
    {
      name: "cross-site page POST",
      method: "POST",
      origin: CROSS_SITE_PAGE,
      site: "cross-site",
      expect: "refused",
    },
    {
      name: "the app's own POST",
      method: "POST",
      origin: own,
      site: "same-origin",
      expect: "relayed",
    },
    // Every unsafe method, not only POST.
    {
      name: "same-site page PUT",
      method: "PUT",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "refused",
    },
    {
      name: "same-site page PATCH",
      method: "PATCH",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "refused",
    },
    {
      name: "same-site page DELETE",
      method: "DELETE",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "refused",
    },
    // Safe methods are not guarded.
    {
      name: "same-site page GET",
      method: "GET",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "relayed",
    },
    {
      name: "same-site page HEAD",
      method: "HEAD",
      origin: SAME_SITE_PAGE,
      site: "same-site",
      expect: "relayed",
    },
    {
      name: "cross-site CORS preflight",
      method: "OPTIONS",
      origin: CROSS_SITE_PAGE,
      site: "cross-site",
      expect: "relayed",
    },
    // Origin, on its own: it must be exactly the app's origin.
    {
      name: "foreign Origin, no Sec-Fetch-Site",
      method: "POST",
      origin: SAME_SITE_PAGE,
      expect: "refused",
    },
    {
      name: "Origin with the app host as a prefix",
      method: "POST",
      origin: `${own}.evil.example`,
      expect: "refused",
    },
    {
      name: "Origin over http",
      method: "POST",
      origin: `http://${appHost(label)}`,
      expect: "refused",
    },
    {
      name: "empty Origin",
      method: "POST",
      origin: "",
      expect: "refused",
    },
    // Sec-Fetch-Site, on its own: the browser's word wins over a matching
    // Origin, and holds when Origin is absent.
    {
      name: "the app's Origin, Sec-Fetch-Site same-site",
      method: "POST",
      origin: own,
      site: "same-site",
      expect: "refused",
    },
    {
      name: "no Origin, Sec-Fetch-Site cross-site",
      method: "POST",
      site: "cross-site",
      expect: "refused",
    },
    {
      name: "no Origin, Sec-Fetch-Site none",
      method: "POST",
      site: "none",
      expect: "relayed",
    },
    // Origin null: a form POST from the app's own page that sets
    // Referrer-Policy no-referrer arrives as null + same-origin.
    {
      name: "Origin null from the app's own page",
      method: "POST",
      origin: "null",
      site: "same-origin",
      expect: "relayed",
    },
    {
      name: "Origin null from a same-site page",
      method: "POST",
      origin: "null",
      site: "same-site",
      expect: "refused",
    },
    {
      name: "Origin null, no Sec-Fetch-Site",
      method: "POST",
      origin: "null",
      expect: "refused",
    },
    // A client that is not a browser has no ambient cookie to abuse.
    {
      name: "no Origin, no Sec-Fetch-Site",
      method: "POST",
      expect: "relayed",
    },
  ];
}

function headersFor(c: Case, cookie: string): Record<string, string> {
  return {
    ...withAppCookie(cookie),
    ...(c.origin === undefined ? {} : { Origin: c.origin }),
    ...(c.site === undefined ? {} : { "Sec-Fetch-Site": c.site }),
    "Content-Length": "0",
  };
}

// What a case came to: the relay's 403 with its exact body, or the app's own
// answer with the request on the app's side, carrying `member`. Anything else
// is reported as it is.
function outcome(
  res: RawResponse,
  path: string,
  method: string,
  seen: Seen[],
  member: string | null,
): string {
  const reached = seen.filter((s) => s.path === path);
  if (
    res.status === 403 &&
    res.body === APP_BAD_ORIGIN_BODY &&
    reached.length === 0
  ) {
    return "refused";
  }
  if (
    res.status === 200 &&
    reached.length === 1 &&
    reached[0].method === method &&
    reached[0].member === member
  ) {
    return "relayed";
  }
  return `status ${res.status}, body ${JSON.stringify(res.body)}, reached ${JSON.stringify(reached)}`;
}

describe("app relay: requests from other pages", () => {
  it("refuses a state-changing request another page sent, and relays the app's own", async () => {
    const { srv, label, rawSessionId, memberId } = await office();
    const seen: Seen[] = [];
    app = startApp(seen);
    const cookie = await signIn(srv, label, rawSessionId);

    const table = cases(label);
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const [i, c] of table.entries()) {
      const path = `/case-${i}`;
      const res = await raw(srv.port, {
        host: appHost(label),
        path,
        method: c.method,
        headers: headersFor(c, cookie),
      });
      got[c.name] = outcome(res, path, c.method, seen, memberId);
      want[c.name] = c.expect;
    }
    expect(got).toEqual(want);
  });

  it("refuses a screenshot capture's state-changing request from another page too", async () => {
    const { srv, label } = await office();
    const seen: Seen[] = [];
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

    const got: Record<string, string> = {};
    for (const [name, c] of [
      [
        "own",
        {
          method: "POST",
          origin: `https://${appHost(label)}`,
          site: "same-origin",
        },
      ],
      [
        "same-site page",
        { method: "POST", origin: SAME_SITE_PAGE, site: "same-site" },
      ],
    ] as const) {
      const path = `/preview-${name.replace(/\W/g, "-")}`;
      const res = await raw(srv.port, {
        host: appHost(label),
        path,
        method: c.method,
        headers: headersFor({ name, expect: "relayed", ...c }, cookie),
      });
      got[name] = outcome(res, path, c.method, seen, null);
    }
    // The capture's own POST reached the app, so the session is live and the
    // refusal below is the check's, not the gate's.
    expect(got).toEqual({ own: "relayed", "same-site page": "refused" });
  });

  it("answers another page's POST with no session as it answers a label with no app", async () => {
    const { srv, label } = await office();
    const seen: Seen[] = [];
    app = startApp(seen);
    const attack = {
      Origin: SAME_SITE_PAGE,
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Dest": "empty",
      "Content-Length": "0",
    };
    const live = await raw(srv.port, {
      host: appHost(label),
      path: "/x",
      method: "POST",
      headers: attack,
    });
    const dead = await raw(srv.port, {
      host: appHost("nosuchapp"),
      path: "/x",
      method: "POST",
      headers: attack,
    });
    // The label really is live: without this the comparison would pass with
    // two dead labels.
    expect(appRegistry.get(APP)?.hostLabel).toBe(label);
    expect(live.status).toBe(401);
    expect(live.stable).toBe(dead.stable);
    expect(seen).toEqual([]);
  });
});
