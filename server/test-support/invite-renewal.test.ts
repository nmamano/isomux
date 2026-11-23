// A guest who opens an owner's sign-in link after it expired (task 1492af52).
//
// What this freezes, through the real HTTP routes and the real ask store:
//   - The expired-link page (GET /i/<token>, and POST /auth/accept on a link
//     that expired after the page loaded) offers a renewal button only when an
//     owner can still extend the link.
//   - POST /auth/invite-renewal is origin-checked like /auth/accept, signs
//     nobody in, and opens one ringing page per owner per link: to the owner
//     who made the link when they are an owner now, else to every owner. A
//     second tap opens nothing new.
//   - The page's member wire names the link its Re-enable button extends
//     (signInLinkRenewal), only for the sign-in-links feature.
//   - Each open page closes (outcome done) once its link is no longer an
//     expired link an owner can extend: extended, replaced, revoked, or its
//     member removed.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { INVITE_TTL_MS, SELF_INVITE_TTL_MS } from "../auth.ts";
import { getUserByName, setUserRole } from "../users.ts";
import { mintExpiredLink } from "./member-link.ts";
import * as managers from "../office-managers.ts";
import type { AskMemberWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const RENEWAL_ACTION = 'action="/auth/invite-renewal"';

// The renewal form in a page, or null: from its action to its </form>.
function renewalForm(html: string): string | null {
  const at = html.indexOf(RENEWAL_ACTION);
  if (at < 0) return null;
  const end = html.indexOf("</form>", at);
  return end < 0 ? null : html.slice(at, end);
}

// A `createdBy`-made link for a member who has never signed in, run out a
// second ago after its real window.
async function expiredLink(
  name: string,
  createdBy: string,
): Promise<{ rawToken: string; prefix: string; userId: string }> {
  // A self-made link (createdBy = the member's name) keeps its real 1h
  // window; any other link has the owner window.
  const m = await mintExpiredLink(name, {
    createdBy,
    ttlMs: createdBy === name ? SELF_INVITE_TTL_MS : INVITE_TTL_MS,
  });
  return { rawToken: m.rawToken, prefix: m.tokenPrefix, userId: m.userId };
}

function renew(srv: TestServer, rawToken: string): Promise<Response> {
  return srv.http("/auth/invite-renewal", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: rawToken }).toString(),
  });
}

async function asksOf(
  srv: TestServer,
  rawSessionId: string,
): Promise<AskMemberWire[]> {
  const res = await srv.http("/api/asks", { rawSessionId });
  expect(res.status).toBe(200);
  return (await res.json()) as AskMemberWire[];
}
async function linkPagesOf(srv: TestServer, rawSessionId: string) {
  return (await asksOf(srv, rawSessionId)).filter(
    (a) => a.office?.feature === "sign-in-links",
  );
}
async function closedOutcome(
  srv: TestServer,
  rawSessionId: string,
  askId: string,
): Promise<string | undefined> {
  const res = await srv.http(`/api/asks/${askId}`, { rawSessionId });
  if (res.status !== 200) return `status ${res.status}`;
  return ((await res.json()) as { closed?: { outcome?: string } }).closed
    ?.outcome;
}

async function twoOwners(srv: TestServer) {
  const morgan = await srv.seedOwner("Morgan");
  const olga = await srv.seedMember("Olga");
  setUserRole("Olga", "owner");
  return { morgan, olga };
}

describe("the expired-link page", () => {
  it("offers the renewal button, carrying the token, only for a link an owner can extend; also on an accept after expiry", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const dan = await expiredLink("Dan", "Morgan");
    // Ben's own link (createdBy = his name) is not extendable by policy.
    const ben = await expiredLink("Ben", "Ben");

    const page = await srv.http(`/i/${dan.rawToken}`, { redirect: "manual" });
    expect(page.status).toBe(410);
    const form = renewalForm(await page.text());
    expect(form).not.toBeNull();
    expect(form).toContain(`value="${dan.rawToken}"`);

    const other = await srv.http(`/i/${ben.rawToken}`, { redirect: "manual" });
    expect(other.status).toBe(410);
    expect(renewalForm(await other.text())).toBeNull();

    // The accept form loaded while the link was live, posted after it expired.
    const accept = await srv.http("/auth/accept", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: dan.rawToken }).toString(),
    });
    expect(accept.status).toBe(410);
    expect(accept.headers.get("set-cookie")).toBeNull();
    expect(renewalForm(await accept.text())).toContain(
      `value="${dan.rawToken}"`,
    );
  });
});

describe("POST /auth/invite-renewal", () => {
  it("refuses another origin and opens nothing", async () => {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    const dan = await expiredLink("Dan", "Morgan");
    const res = await fetch(`${srv.baseUrl}/auth/invite-renewal`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "https://evil.example",
        Connection: "close",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: dan.rawToken }).toString(),
    });
    expect(res.status).toBe(403);
    // The same request from the office origin opens a page: the refusal above
    // was the origin, not the token.
    expect(await linkPagesOf(srv, morgan.rawSessionId)).toEqual([]);
    expect((await renew(srv, dan.rawToken)).status).toBe(200);
    expect(await linkPagesOf(srv, morgan.rawSessionId)).toHaveLength(1);
  });

  it("pages the owner who made the link, once, with the link on the wire; signs nobody in; a second tap opens nothing new", async () => {
    const srv = (server = await startTestServer());
    const { morgan, olga } = await twoOwners(srv);
    const dan = await expiredLink("Dan", "Morgan");

    const res = await renew(srv, dan.rawToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The reply page carries no second renewal button.
    expect(renewalForm(await res.text())).toBeNull();

    const pages = await linkPagesOf(srv, morgan.rawSessionId);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.agentId).toBe("");
    expect(page.priority).toBe("P1");
    expect(page.page?.state).toBe("ringing");
    expect(page.prompt).toContain("Dan");
    expect(page.signInLinkRenewal).toEqual({ tokenPrefix: dan.prefix });
    // Only the maker: the other owner gets nothing.
    expect(await linkPagesOf(srv, olga.rawSessionId)).toEqual([]);

    const again = await renew(srv, dan.rawToken);
    expect(again.status).toBe(200);
    const after = await linkPagesOf(srv, morgan.rawSessionId);
    expect(after.map((a) => a.id)).toEqual([page.id]);

    // Another office page whose key happens to look the same carries no
    // renewal: the field is the sign-in-links feature's only.
    const morganId = getUserByName("Morgan")!.id;
    managers.officePagers.whatsapp.raise(
      morganId,
      `sign-in-link:${dan.prefix}`,
      "WhatsApp stopped",
      "",
    );
    const wa = (await asksOf(srv, morgan.rawSessionId)).find(
      (a) => a.office?.feature === "whatsapp",
    );
    expect(wa).toBeDefined();
    expect(wa?.signInLinkRenewal).toBeUndefined();
  });

  it("a link made by someone who is not an owner now pages every owner, and one owner's extend closes every page", async () => {
    const srv = (server = await startTestServer());
    const { morgan, olga } = await twoOwners(srv);
    // An agent-made link: createdBy is the agent's name.
    const dan = await expiredLink("Dan", "Build Bot");
    expect((await renew(srv, dan.rawToken)).status).toBe(200);
    const mPages = await linkPagesOf(srv, morgan.rawSessionId);
    const oPages = await linkPagesOf(srv, olga.rawSessionId);
    expect(mPages).toHaveLength(1);
    expect(oPages).toHaveLength(1);

    const ext = await srv.http(`/api/invites/${dan.prefix}/extend`, {
      method: "POST",
      rawSessionId: olga.rawSessionId,
    });
    expect(ext.status).toBe(200);
    expect(await closedOutcome(srv, morgan.rawSessionId, mPages[0].id)).toBe(
      "done",
    );
    expect(await closedOutcome(srv, olga.rawSessionId, oPages[0].id)).toBe(
      "done",
    );
  });

  it("an unknown token or a link no owner can extend gets the error page and opens nothing", async () => {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    const ben = await expiredLink("Ben", "Ben");
    const outcomes = [];
    for (const token of ["not-a-real-token", ben.rawToken]) {
      const res = await renew(srv, token);
      outcomes.push({
        status: res.status,
        cookie: res.headers.get("set-cookie"),
      });
    }
    expect(outcomes).toEqual([
      { status: 410, cookie: null },
      { status: 410, cookie: null },
    ]);
    expect(await linkPagesOf(srv, morgan.rawSessionId)).toEqual([]);
    // Control: a renewable link through the same helper does open one.
    const dan = await expiredLink("Dan", "Morgan");
    expect((await renew(srv, dan.rawToken)).status).toBe(200);
    expect(await linkPagesOf(srv, morgan.rawSessionId)).toHaveLength(1);
  });
});

describe("the owner's sign-in-links page closes with its link", () => {
  const cases: [
    string,
    (
      srv: TestServer,
      session: string,
      link: { prefix: string; userId: string },
    ) => Promise<number>,
  ][] = [
    [
      "extended",
      async (srv, session, link) =>
        (
          await srv.http(`/api/invites/${link.prefix}/extend`, {
            method: "POST",
            rawSessionId: session,
          })
        ).status,
    ],
    [
      "replaced by a new link",
      async (srv, session, link) =>
        (
          await srv.http("/api/invites", {
            method: "POST",
            rawSessionId: session,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: link.userId }),
          })
        ).status,
    ],
    [
      "revoked",
      async (srv, session, link) =>
        (
          await srv.http(`/api/invites/${link.prefix}`, {
            method: "DELETE",
            rawSessionId: session,
          })
        ).status,
    ],
    [
      "its member removed",
      async (srv, session) =>
        (
          await srv.http("/api/users/Dan", {
            method: "DELETE",
            rawSessionId: session,
          })
        ).status,
    ],
  ];
  for (const [label, act] of cases)
    it(`when the link is ${label}`, async () => {
      const srv = (server = await startTestServer());
      const morgan = await srv.seedOwner("Morgan");
      const dan = await expiredLink("Dan", "Morgan");
      expect((await renew(srv, dan.rawToken)).status).toBe(200);
      const [page] = await linkPagesOf(srv, morgan.rawSessionId);
      expect(page).toBeDefined();

      const status = await act(srv, morgan.rawSessionId, dan);
      expect(status).toBeLessThan(300);
      expect(await closedOutcome(srv, morgan.rawSessionId, page.id)).toBe(
        "done",
      );
      expect(await linkPagesOf(srv, morgan.rawSessionId)).toEqual([]);
    });

  it("stays open while its link is still an expired link an owner can extend (another member's change)", async () => {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    const dan = await expiredLink("Dan", "Morgan");
    expect((await renew(srv, dan.rawToken)).status).toBe(200);
    const [page] = await linkPagesOf(srv, morgan.rawSessionId);
    // Extending another member's link is an invites mutation that leaves
    // Dan's link as it was.
    const other = await expiredLink("Eve", "Morgan");
    const res = await srv.http(`/api/invites/${other.prefix}/extend`, {
      method: "POST",
      rawSessionId: morgan.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(
      (await linkPagesOf(srv, morgan.rawSessionId)).map((a) => a.id),
    ).toEqual([page.id]);
  });
});
