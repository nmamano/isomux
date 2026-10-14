// Screenshot grants against the REAL server: POST /api/agents/:id/preview-url
// on an app host. The server's Chrome starts every capture with an empty
// profile, so without a grant the app gate sends it to the office sign-in page.
//
// The "browser" is a fake script (ISOMUX_PREVIEW_BROWSER). It writes the URL it
// was told to load and then waits, so this file can act as the browser while
// the capture is in flight: redeem the code, hold the cookie, ask the gate.
// Pre-flight fetches to anything but loopback are answered by a stub, because
// office.example does not resolve.
//
// What this freezes:
//   - an agent whose manager may open a member-only app gets a grant, and the
//     cookie it yields passes the HTTP gate of that app only (never the
//     WebSocket gate);
//   - an agent whose manager may not open the app gets the plain URL, as
//     before grants existed, and so the same sign-in bounce;
//   - a URL that is not exactly the app's origin, or names a reserved path,
//     gets no grant;
//   - the code is single-use and bound to its app host; the session is
//     revalidated per request and dies when the capture ends.

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NAVIGATION_HEADERS,
  OFFICE_HOST,
  RELAY_UNREACHABLE,
  WS_AUTH_REQUIRED,
  WS_UPGRADE_HEADERS,
  anOfficeWithAnApp,
  appHost,
  cookieValue,
  expectBounce,
  expectPlaceholder,
  raw,
  registerApp,
  spawnAgent,
  withAppCookie,
  type RawResponse,
} from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import {
  APP_COOKIE_NAME,
  APP_PREVIEW_MINT_MAX_PER_WINDOW,
  _testPreviewCodeCount,
  mintPreviewGrant,
} from "../app-auth.ts";
import { appRegistry } from "../app-registry.ts";

const SIGN_IN_FAILED_BODY =
  "sign-in link expired; open the app again from the office\n";

let server: TestServer | null = null;
let handoffDir: string;
let scriptDir: string;
const realFetch = globalThis.fetch;
const savedBrowser = process.env.ISOMUX_PREVIEW_BROWSER;
const savedHandoff = process.env.PREVIEW_GRANT_HANDOFF;

beforeAll(() => {
  scriptDir = mkdtempSync(join(tmpdir(), "preview-grant-scripts-"));
  const browser = join(scriptDir, "fake-browser.sh");
  // Records the last argument (the URL), waits for `go`, then writes a PNG
  // that isCompletePng accepts.
  writeFileSync(
    browser,
    `#!/bin/sh
out=""; url=""
for a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; esac; url="$a"; done
printf '%s' "$url" > "$PREVIEW_GRANT_HANDOFF/url.tmp"
mv "$PREVIEW_GRANT_HANDOFF/url.tmp" "$PREVIEW_GRANT_HANDOFF/url"
while [ ! -e "$PREVIEW_GRANT_HANDOFF/go" ]; do sleep 0.05; done
printf '\\211PNG\\r\\n\\032\\n' > "$out"
printf 'IHDRfakepixels' >> "$out"
printf '\\0\\0\\0\\0IEND\\256B\\140\\202' >> "$out"
`,
  );
  chmodSync(browser, 0o755);
  process.env.ISOMUX_PREVIEW_BROWSER = browser;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const hostname = new URL(href).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return Promise.resolve(new Response("pre-flight stub"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedBrowser === undefined) delete process.env.ISOMUX_PREVIEW_BROWSER;
  else process.env.ISOMUX_PREVIEW_BROWSER = savedBrowser;
  if (savedHandoff === undefined) delete process.env.PREVIEW_GRANT_HANDOFF;
  else process.env.PREVIEW_GRANT_HANDOFF = savedHandoff;
  rmSync(scriptDir, { recursive: true, force: true });
});

afterEach(async () => {
  await server?.stop();
  server = null;
  if (handoffDir) rmSync(handoffDir, { recursive: true, force: true });
});

function freshHandoff(): void {
  handoffDir = mkdtempSync(join(tmpdir(), "preview-grant-handoff-"));
  process.env.PREVIEW_GRANT_HANDOFF = handoffDir;
}

async function browserUrl(): Promise<string> {
  const file = join(handoffDir, "url");
  for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(25);
  return readFileSync(file, "utf-8");
}

// One capture: start it, hand the URL Chrome would load to `act` while the
// capture is in flight, then let the browser finish.
async function capture(
  srv: TestServer,
  agent: { id: string; token: string },
  url: string,
  act: (navigateUrl: string) => Promise<void> = async () => {},
  // False when `act` kills the agent, whose card then has nowhere to go.
  expectCard = true,
): Promise<string> {
  freshHandoff();
  const pending = srv.http(`/api/agents/${agent.id}/preview-url`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agent.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  const navigateUrl = await browserUrl();
  try {
    await act(navigateUrl);
  } catch (err) {
    writeFileSync(join(handoffDir, "go"), "");
    await pending.catch(() => {});
    throw err;
  }
  writeFileSync(join(handoffDir, "go"), "");
  const res = await pending;
  if (expectCard) expect(res.status).toBe(200);
  return navigateUrl;
}

// What the browser does with a grant URL: present it on the host it names.
function present(navigateUrl: string, host?: string): Promise<RawResponse> {
  const u = new URL(navigateUrl);
  return raw(server!.port, {
    host: host ?? u.host,
    path: `${u.pathname}${u.search}`,
    headers: NAVIGATION_HEADERS,
  });
}

function getWithCookie(
  host: string,
  path: string,
  cookie: string,
): Promise<RawResponse> {
  return raw(server!.port, {
    host,
    path,
    headers: { ...NAVIGATION_HEADERS, ...withAppCookie(cookie) },
  });
}

// An office with app "hello", built by an owner's agent in the first room, and
// an agent whose manager is a MEMBER. `memberHasRoom` decides whether that
// member may open the app (creator-room access); the member owns nothing.
async function officeWithMemberAgent(memberHasRoom: boolean) {
  const office = await anOfficeWithAnApp((srv) => {
    server = srv;
  });
  const { srv } = office;
  const outsider = await srv.seedMember("Outsider");
  const userName = memberHasRoom ? "Member" : outsider.username;
  const userId = getUserByName(userName)!.id;
  const bot = await spawnAgent(srv, `Shot-${userName}`);
  const agent = { id: bot.id, token: mintAgentToken(bot.id, userId) };
  return { ...office, agent, userName };
}

describe("preview-url screenshot grants", () => {
  it("lets an agent whose manager may open a member-only app capture it", async () => {
    const { srv, label, agent, token, userName } =
      await officeWithMemberAgent(true);
    const host = appHost(label);
    const other = await registerApp(srv, token, "other");
    let cookie = "";
    let code = "";
    const logged: string[] = [];
    const saved = { ...console };
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
    }

    let navigateUrl: string;
    try {
      navigateUrl = await capture(
        srv,
        agent,
        `https://${host}/dash?tab=1#scene=petal&t=1`,
        async (nav) => {
          const u = new URL(nav);
          expect(`${u.origin}${u.pathname}`).toBe(
            `https://${host}/__isomux/preview`,
          );
          code = u.searchParams.get("code") ?? "";
          // Chrome gets the fragment; the redeem's Location has none, so the
          // browser keeps it for the page it lands on.
          expect(u.hash).toBe("#scene=petal&t=1");

          const redeemed = await present(nav);
          expect(redeemed.status).toBe(302);
          expect(redeemed.headers["location"]).toBe("/dash?tab=1");
          cookie = cookieValue(redeemed);
          // Host-only (__Host-, no Domain) and short-lived: a redirect to
          // another app host or to the office carries no credential.
          expect(redeemed.setCookies).toHaveLength(1);
          const attrs = redeemed.setCookies[0].split("; ");
          expect(attrs[0]).toBe(`${APP_COOKIE_NAME}=${cookie}`);
          expect(attrs.some((a) => a.toLowerCase().startsWith("domain"))).toBe(
            false,
          );
          expect(attrs).toContain("Secure");
          expect(attrs).toContain("Path=/");
          const maxAge = Number(
            attrs.find((a) => a.startsWith("Max-Age="))!.slice(8),
          );
          expect(maxAge).toBeGreaterThan(0);
          expect(maxAge).toBeLessThanOrEqual(22);

          // Past the HTTP gate of this app. Not past its WebSocket gate: the
          // socket relay only revalidates office sessions.
          expectPlaceholder(
            await getWithCookie(host, "/dash?tab=1", cookie),
            RELAY_UNREACHABLE,
            "grant cookie on its app",
          );
          expectPlaceholder(
            await raw(srv.port, {
              host,
              path: "/ws",
              headers: { ...WS_UPGRADE_HEADERS, ...withAppCookie(cookie) },
            }),
            WS_AUTH_REQUIRED,
            "grant cookie on its app's upgrade",
          );

          // Not past another app's gate, nor the office's.
          expectBounce(
            await getWithCookie(appHost(other), "/", cookie),
            { label: other, path: "/" },
            "grant cookie on a sibling app",
          );
          const office = await raw(srv.port, {
            host: OFFICE_HOST,
            path: "/agents",
            headers: withAppCookie(cookie),
          });
          expect(office.status).toBe(401);

          // Single use.
          const replay = await present(nav);
          expect(replay.status).toBe(400);
          expect(replay.body).toBe(SIGN_IN_FAILED_BODY);
        },
      );
    } finally {
      Object.assign(console, saved);
    }
    expect(code.length).toBeGreaterThan(0);
    expect(navigateUrl).not.toContain("tab=1");

    // Neither the code nor the grant URL reaches the card or a log line.
    const card = srv.agentManager
      .getAgentLogs(agent.id)
      .filter((e) => e.kind === "file-view");
    expect(card).toHaveLength(1);
    expect(card[0].content).toBe(`https://${host}/dash`);
    const cardText = JSON.stringify(card[0]);
    expect(cardText).not.toContain(code);
    expect(cardText).not.toContain("__isomux");
    expect(cardText).not.toContain("scene=petal");
    for (const line of logged) {
      expect(line).not.toContain(code);
      expect(line).not.toContain("__isomux/preview");
    }

    // The capture is over: the session is gone, though the cookie would not
    // yet have expired.
    expectBounce(
      await getWithCookie(host, "/dash?tab=1", cookie),
      { label, path: "/dash?tab=1" },
      `after the capture of ${userName}'s agent`,
    );
  });

  it("asks the access question again on every request", async () => {
    const { srv, label, agent } = await officeWithMemberAgent(true);
    const host = appHost(label);
    await capture(srv, agent, `https://${host}/`, async (nav) => {
      const cookie = cookieValue(await present(nav));
      expectPlaceholder(
        await getWithCookie(host, "/", cookie),
        RELAY_UNREACHABLE,
        "with room access",
      );
      const member = getUserByName("Member")!;
      expect(updateUserById(member.id, { allowedRooms: [] }).ok).toBe(true);
      expectBounce(
        await getWithCookie(host, "/", cookie),
        { label, path: "/" },
        "after the room grant is removed",
      );
    });
  });

  it("ends the session when the agent is gone", async () => {
    const { srv, label, agent } = await officeWithMemberAgent(true);
    const host = appHost(label);
    await capture(
      srv,
      agent,
      `https://${host}/`,
      async (nav) => {
        const cookie = cookieValue(await present(nav));
        expectPlaceholder(
          await getWithCookie(host, "/", cookie),
          RELAY_UNREACHABLE,
          "while the agent lives",
        );
        await srv.agentManager.kill(agent.id);
        expectBounce(
          await getWithCookie(host, "/", cookie),
          { label, path: "/" },
          "after the agent is killed",
        );
      },
      false,
    );
  });

  it("refuses a code presented on another app's host, and spends it", async () => {
    const { srv, label, agent, token } = await officeWithMemberAgent(true);
    const other = await registerApp(srv, token, "other");
    await capture(srv, agent, `https://${appHost(label)}/`, async (nav) => {
      const elsewhere = await present(nav, appHost(other));
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.body).toBe(SIGN_IN_FAILED_BODY);
      expect(elsewhere.setCookies).toEqual([]);
      const home = await present(nav);
      expect(home.status).toBe(400);
      expect(home.body).toBe(SIGN_IN_FAILED_BODY);
    });
  });

  it("refuses the capture, with no browser, when the agent's grants are spent", async () => {
    const { srv, label, agent } = await officeWithMemberAgent(true);
    const app = appRegistry.list().find((a) => a.hostLabel === label)!;
    for (let i = 0; i < APP_PREVIEW_MINT_MAX_PER_WINDOW; i++) {
      const spent = mintPreviewGrant({
        agentId: agent.id,
        app,
        appHost: appHost(label),
        returnPath: "/",
        revalidate: () => true,
        expiresAt: Date.now() + 60_000,
      });
      expect(spent).not.toBeNull();
      spent!.release();
    }
    freshHandoff();
    // A browser that does run finishes at once, so a fallback fails on the
    // status below rather than on the test timeout.
    writeFileSync(join(handoffDir, "go"), "");
    const res = await srv.http(`/api/agents/${agent.id}/preview-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: `https://${appHost(label)}/` }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("capture_busy");
    // The browser never ran, so no sign-in page was captured in the app's place.
    expect(existsSync(join(handoffDir, "url"))).toBe(false);
    expect(
      srv.agentManager
        .getAgentLogs(agent.id)
        .filter((e) => e.kind === "file-view"),
    ).toEqual([]);
  });

  it("gives an agent whose manager may not open the app the plain URL", async () => {
    const { srv, label, agent } = await officeWithMemberAgent(false);
    const url = `https://${appHost(label)}/dash?tab=1#scene=petal`;
    let minted = -1;
    const navigateUrl = await capture(srv, agent, url, async () => {
      minted = _testPreviewCodeCount();
    });
    expect(navigateUrl).toBe(url);
    expect(minted).toBe(0);
    // Which is today's answer for Chrome's empty profile: the sign-in bounce.
    expectBounce(
      await raw(srv.port, {
        host: appHost(label),
        path: "/dash?tab=1",
        headers: NAVIGATION_HEADERS,
      }),
      { label, path: "/dash?tab=1" },
      "plain URL, no cookie",
    );
  });

  it("gives no grant to a URL that is not exactly an app's origin", async () => {
    const { srv, label, agent } = await officeWithMemberAgent(true);
    const host = appHost(label);
    for (const url of [
      `https://${OFFICE_HOST}/`,
      `https://${OFFICE_HOST}/${label}`,
      `http://${host}/`,
      `https://${host}:8443/`,
      `https://${host}.evil.test/`,
      `https://x.${host}/`,
      `https://nosuchapp.${OFFICE_HOST}/`,
      `https://${host}/__isomux/auth?code=x`,
      `https://${host}/__isomux`,
    ]) {
      let minted = -1;
      const navigateUrl = await capture(srv, agent, url, async () => {
        minted = _testPreviewCodeCount();
      });
      expect({ url, navigateUrl, minted }).toEqual({
        url,
        navigateUrl: new URL(url).href,
        minted: 0,
      });
    }
  });
});
