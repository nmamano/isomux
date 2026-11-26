// Action asks for two Settings changes an agent must never send a member to
// the page for (task 8852553c): give a member's sign-in link another 3 days
// (Settings › Invites, Extend), and set a member's avatar. Also the agent's
// read of a member's sign-in links, which names a link's expiry without the
// link itself.
//
// The extend step is keyed by member: since task 1492af52 a member has at
// most one link an owner can extend. The server stores that link's prefix
// and expiry at the create; the ask closes when the link's expiry passes the
// stored one, by the card or by hand. Only an office owner can apply it, and
// that refusal comes before any answer about the member's links.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resetStateRoot } from "./temp-state.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { inThePast, mintExpiredLink } from "./member-link.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { createMember, getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  INVITE_TTL_MS,
  SELF_INVITE_TTL_MS,
  acceptInvite,
  mintInvite,
} from "../auth.ts";
import { STATE_ROOT } from "../config.ts";
import type { AgentInfo, AskEntry, InviteWire } from "../../shared/types.ts";
import type { MemberSignInLinkWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const folders: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

interface Res {
  status: number;
  body: unknown;
}

// Morgan owns the office; Casey is a member with its first room. Each was
// signed in by a link, so neither has an unused link at the start. Dana is a
// member who never signed in: a link minted in the past for Casey would be
// older than the link Casey used, which no mint makes, so the link cases use
// Dana.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const dana = createMember("Dana", { role: "member" });
  if (!dana.ok) throw new Error(`create failed: ${dana.error}`);
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    room,
    morgan: morgan.rawSessionId,
    morganName: morgan.username,
    morganId: getUserByName(morgan.username)!.id,
    casey: casey.rawSessionId,
    caseyName: casey.username,
    caseyId: getUserByName(casey.username)!.id,
    danaName: "Dana",
    danaId: dana.user.id,
  };
  const rooms = await asSession(
    o,
    o.morgan,
    "PUT",
    `/api/users/${o.caseyName}/access`,
    { allowedRooms: [room] },
  );
  expect(rooms.status).toBe(200);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(
  o: Office,
  name: string,
  manager: "Morgan" | "Casey" = "Morgan",
): Promise<AgentInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-link-avatar-"));
  folders.push(cwd);
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    manager === "Morgan" ? o.morganName : o.caseyName,
    "claude",
    undefined,
    manager === "Morgan" ? o.morganId : o.caseyId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function read(res: Response): Promise<Res> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawSessionId: session,
    })
    .then(read);
}

function asAgent(
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agentId)!}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    .then(read);
}

const errorOf = (res: Res) =>
  (res.body as { error?: { code?: string; message?: string } } | null)?.error;
const outcome = (res: Res) => ({
  status: res.status,
  code: errorOf(res)?.code,
});
const refused = (status: number, code: string) => ({ status, code });
const succeeded = (res: Res) => res.status >= 200 && res.status < 300;

function ask(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please do this.",
    step,
  });
}

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

// "open", the closed ask's outcome, or the status of a refused read.
async function askStatus(o: Office, askerId: string, askId: string) {
  const res = await asAgent(
    o,
    askerId,
    "GET",
    `/api/agents/${askerId}/asks/${askId}`,
  );
  if (res.status !== 200) return String(res.status);
  return (
    (res.body as { closed?: { outcome: string } }).closed?.outcome ?? "open"
  );
}

const run = (o: Office, session: string, askId: string) =>
  asSession(o, session, "POST", `/api/asks/${askId}/action`);

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const closedAsDone = (o: Office, askerId: string, askId: string) =>
  waitUntil(
    async () => (await askStatus(o, askerId, askId)) === "done",
    "the ask closes as done",
  );

// The step lines in the agent's chat.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
    .filter((key): key is string => key !== undefined);

function auditedOnce(operation: string, askId: string, memberId: string) {
  expect(
    officeAuditStore()
      .list({ operation, limit: 1000 })
      .items.filter((r) => r.targets.includes(askId))
      .map((r) => [r.actor.kind, r.actor.id]),
  ).toEqual([["member", memberId]]);
}

// The member's links as the agent read route gives them.
async function linksOf(
  o: Office,
  agentId: string,
  username: string,
): Promise<MemberSignInLinkWire[]> {
  const res = await asAgent(
    o,
    agentId,
    "GET",
    `/api/users/${username}/sign-in-links`,
  );
  expect(res.status).toBe(200);
  return (res.body as { links: MemberSignInLinkWire[] }).links;
}

// The enabling state, through the owners' own list (GET /api/invites,
// which predates this task): Dana's only link has this prefix, unused, and an
// owner can extend it; marked expired or not.
async function ownerSeesExtendable(
  o: Office,
  prefix: string,
  expired: boolean,
): Promise<void> {
  const res = await asSession(o, o.morgan, "GET", "/api/invites");
  expect(res.status).toBe(200);
  const rows = (res.body as { invites: InviteWire[] }).invites.filter(
    (i) => i.username === o.danaName,
  );
  expect(
    rows.map((i) => [i.tokenPrefix, i.expired ?? false, i.extendable]),
  ).toEqual([[prefix, expired, true]]);
}

// Dana's own 1h link, as the self route mints it (Dana has no session to
// call it); its prefix.
async function danaSelfLink(): Promise<string> {
  const user = getUserByName("Dana")!;
  const minted = await mintInvite({
    userId: user.id,
    createdBy: user.name,
    ttlMs: SELF_INVITE_TTL_MS,
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return minted.invite.tokenPrefix;
}

// An owner-made 3-day link for Dana, minted `ago` ms in the past: live
// while `ago` < INVITE_TTL_MS. The clock moved, so an extend now always
// moves the expiry.
async function danaLinkMadeAgo(o: Office, ago: number) {
  const minted = await inThePast(ago, () =>
    mintInvite({
      userId: o.danaId,
      createdBy: o.morganName,
      ttlMs: INVITE_TTL_MS,
    }),
  );
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return { rawToken: minted.rawToken, prefix: minted.invite.tokenPrefix };
}

const extendStep = (username: string) => ({
  kind: "sign-in-link-extend",
  username,
});
const avatarStep = (
  username: string,
  fields: { avatarColor?: string; avatarVariant?: string },
) => ({ kind: "member-avatar", username, ...fields });

const avatarOf = (
  username: string,
): { avatarColor: string; avatarVariant: string } => {
  const u = getUserByName(username)!;
  return { avatarColor: u.avatarColor, avatarVariant: u.avatarVariant };
};

describe("an agent reads a member's sign-in links", () => {
  it("gives each unused link that is live, or expired and extendable, with its prefix, times and flags, and nothing else; a used link and an expired link that cannot be extended are not listed", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    // Another member's link is not Dana's.
    expect(
      succeeded(
        await asSession(o, o.morgan, "POST", "/api/invites", {
          userId: o.caseyId,
        }),
      ),
    ).toBe(true);
    expect(await linksOf(o, asker.id, o.caseyName)).toHaveLength(1);
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([]);

    // An expired owner link: listed, marked expired and extendable.
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    const [row] = await linksOf(o, asker.id, o.danaName);
    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "expired",
      "expiresAt",
      "extendable",
      "tokenPrefix",
    ]);
    expect(row.tokenPrefix).toBe(expired.tokenPrefix);
    expect([row.expired, row.extendable]).toEqual([true, true]);
    expect(row.expiresAt - row.createdAt).toBe(INVITE_TTL_MS);
    expect(row.expiresAt).toBeLessThan(Date.now());
    const body = JSON.stringify(
      (
        await asAgent(
          o,
          asker.id,
          "GET",
          `/api/users/${o.danaName}/sign-in-links`,
        )
      ).body,
    );
    expect(body.includes(expired.rawToken)).toBe(false);

    // A live owner link replaces it: live and extendable, not expired.
    const live = await danaLinkMadeAgo(o, 60_000);
    const [liveRow] = await linksOf(o, asker.id, o.danaName);
    expect({
      prefix: liveRow.tokenPrefix,
      expired: liveRow.expired,
      extendable: liveRow.extendable,
      live: liveRow.expiresAt > Date.now(),
    }).toEqual({
      prefix: live.prefix,
      expired: undefined,
      extendable: true,
      live: true,
    });
    expect(await linksOf(o, asker.id, o.danaName)).toHaveLength(1);

    // Used: gone from the list.
    expect((await acceptInvite(live.rawToken, { userAgent: "test" })).ok).toBe(
      true,
    );
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([]);

    // Dana's own 1h link: expired, not listed; live, listed and not
    // extendable.
    await mintExpiredLink(o.danaName, {
      createdBy: o.danaName,
      ttlMs: SELF_INVITE_TTL_MS,
    });
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([]);
    const selfLink = await danaSelfLink();
    const [self] = await linksOf(o, asker.id, o.danaName);
    expect({
      prefix: self.tokenPrefix,
      expired: self.expired,
      extendable: self.extendable,
    }).toEqual({ prefix: selfLink, expired: undefined, extendable: undefined });
  });

  it("an owner's agent reads any member; a member's agent reads only its manager; a session cookie is refused", async () => {
    const o = await office();
    const morgans = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    const path = (u: string) => `/api/users/${u}/sign-in-links`;
    expect((await asAgent(o, morgans.id, "GET", path(o.danaName))).status).toBe(
      200,
    );
    expect(
      (await asAgent(o, morgans.id, "GET", path(o.morganName))).status,
    ).toBe(200);
    expect((await asAgent(o, caseys.id, "GET", path(o.caseyName))).status).toBe(
      200,
    );
    expect(
      (await asAgent(o, caseys.id, "GET", path(o.morganName))).status,
    ).toBe(403);
    expect((await asAgent(o, caseys.id, "GET", path(o.danaName))).status).toBe(
      403,
    );
    expect(
      (await asAgent(o, morgans.id, "GET", path("nobody-here"))).status,
    ).toBe(403);
    expect((await asSession(o, o.morgan, "GET", path(o.danaName))).status).toBe(
      403,
    );
  });
});

describe("a sign-in-link-extend ask at create", () => {
  it("opens for an owner on a member's expired link and on a live one, stored with the link's prefix and expiry", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const [row] = await linksOf(o, asker.id, o.danaName);
    expect((await opened(o, asker.id, extendStep(o.danaName))).step).toEqual({
      kind: "sign-in-link-extend",
      userId: o.danaId,
      tokenPrefix: expired.tokenPrefix,
      expiresAt: row.expiresAt,
    });
    const live = await danaLinkMadeAgo(o, 60_000);
    const [liveRow] = await linksOf(o, asker.id, o.danaName);
    expect((await opened(o, asker.id, extendStep(o.danaName))).step).toEqual({
      kind: "sign-in-link-extend",
      userId: o.danaId,
      tokenPrefix: live.prefix,
      expiresAt: liveRow.expiresAt,
    });
  });

  it("a member with no link an owner can extend: 409 no_extendable_link, whose message names the sign-in-link step; none, a used one, and a 1h self link", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const none = await ask(o, asker.id, extendStep(o.danaName));
    expect(outcome(none)).toEqual(refused(409, "no_extendable_link"));
    // The next move for an agent that reads no reference page: the step
    // kind that makes a new link (a protocol value).
    expect(errorOf(none)?.message ?? "").toMatch(/\bsign-in-link\b(?!-)/);

    const used = await danaLinkMadeAgo(o, 60_000);
    expect((await acceptInvite(used.rawToken, { userAgent: "test" })).ok).toBe(
      true,
    );
    expect(outcome(await ask(o, asker.id, extendStep(o.danaName)))).toEqual(
      refused(409, "no_extendable_link"),
    );

    await danaSelfLink();
    // The enabling condition: Dana has a live link, just not one an owner
    // can extend.
    const owners = await asSession(o, o.morgan, "GET", "/api/invites");
    expect(
      (owners.body as { invites: InviteWire[] }).invites
        .filter((i) => i.username === o.danaName)
        .map((i) => [i.expired ?? false, i.extendable ?? false]),
    ).toEqual([[false, false]]);
    expect(outcome(await ask(o, asker.id, extendStep(o.danaName)))).toEqual(
      refused(409, "no_extendable_link"),
    );
  });

  it("an ask for a member who is no office owner: 403 member_not_allowed, before any answer about links", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    // No link at all: still the 403, not the 409 that tells whether one is
    // there. Casey for herself, and the owner.
    expect(outcome(await ask(o, caseys.id, extendStep(o.caseyName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
    expect(outcome(await ask(o, caseys.id, extendStep(o.morganName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
    // With an extendable link: the same 403.
    const link = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, link.tokenPrefix, true);
    expect(outcome(await ask(o, caseys.id, extendStep(o.danaName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
  });

  it("refuses an unknown member (422), and a step with no username or with keys the agent does not send (400)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    expect(outcome(await ask(o, asker.id, extendStep("nobody-here")))).toEqual(
      refused(422, "unknown_member"),
    );
    expect(
      (await ask(o, asker.id, { kind: "sign-in-link-extend" })).status,
    ).toBe(400);
    for (const extra of [
      { tokenPrefix: expired.tokenPrefix },
      { expiresAt: Date.now() + INVITE_TTL_MS },
    ])
      expect(
        (await ask(o, asker.id, { ...extendStep(o.danaName), ...extra }))
          .status,
      ).toBe(400);
  });
});

describe("a sign-in-link-extend ask run from the card", () => {
  it("gives the expired link another 3 days from now with the owner's session: the same link signs Dana in, the ask closes, the agent hears one line, one invites.extend row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const entry = await opened(o, asker.id, extendStep(o.danaName));
    const before = Date.now();
    expect(succeeded(await run(o, o.morgan, entry.id))).toBe(true);
    const [row] = await linksOf(o, asker.id, o.danaName);
    expect(row.tokenPrefix).toBe(expired.tokenPrefix);
    expect(row.expired).toBeUndefined();
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.signInLinkExtended",
    ]);
    auditedOnce("invites.extend", entry.id, o.morganId);
    const accepted = await acceptInvite(expired.rawToken, {
      userAgent: "test",
    });
    expect(accepted.ok && accepted.username).toBe(o.danaName);
  });

  it("a live link: Apply moves its expiry later and the ask closes", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const live = await danaLinkMadeAgo(o, 3_600_000);
    await ownerSeesExtendable(o, live.prefix, false);
    const entry = await opened(o, asker.id, extendStep(o.danaName));
    const asked = (entry.step as { expiresAt: number }).expiresAt;
    expect(asked).toBeGreaterThan(Date.now());
    expect(succeeded(await run(o, o.morgan, entry.id))).toBe(true);
    expect(
      (await linksOf(o, asker.id, o.danaName))[0].expiresAt,
    ).toBeGreaterThan(asked);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("an extend by hand in Settings › Invites closes it; another link change before does not", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const entry = await opened(o, asker.id, extendStep(o.danaName));
    // A link change that is not this extend runs the close check.
    expect(
      succeeded(await asSession(o, o.morgan, "POST", "/api/invites/self")),
    ).toBe(true);
    await Bun.sleep(100);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    expect(
      succeeded(
        await asSession(
          o,
          o.morgan,
          "POST",
          `/api/invites/${expired.tokenPrefix}/extend`,
        ),
      ),
    ).toBe(true);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("a link replaced or taken back before Apply: the ask stays open, and Apply answers the route's refusal in words and extends nothing", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const old = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, old.tokenPrefix, true);
    const replacedAsk = await opened(o, asker.id, extendStep(o.danaName));
    // A new link for Dana drops the expired one.
    const fresh = await danaLinkMadeAgo(o, 0);
    await ownerSeesExtendable(o, fresh.prefix, false);
    await Bun.sleep(100);
    expect(await askStatus(o, asker.id, replacedAsk.id)).toBe("open");
    const freshExpiry = (await linksOf(o, asker.id, o.danaName))[0].expiresAt;
    const res = await run(o, o.morgan, replacedAsk.id);
    expect(res.status).toBe(404);
    const err = errorOf(res);
    expect(err?.code).toBe("not_found");
    // Words for the card, not the code alone.
    expect((err?.message ?? "").length).toBeGreaterThan(
      (err?.code ?? "").length + 5,
    );
    expect(await askStatus(o, asker.id, replacedAsk.id)).toBe("open");
    // The new link is untouched.
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([
      expect.objectContaining({
        tokenPrefix: fresh.prefix,
        expiresAt: freshExpiry,
      }),
    ]);

    // Taken back by hand.
    const revokedAsk = await opened(o, asker.id, extendStep(o.danaName));
    expect(
      (await asSession(o, o.morgan, "DELETE", `/api/invites/${fresh.prefix}`))
        .status,
    ).toBeLessThan(300);
    await Bun.sleep(100);
    expect(await askStatus(o, asker.id, revokedAsk.id)).toBe("open");
    expect((await run(o, o.morgan, revokedAsk.id)).status).toBe(404);
    expect(await askStatus(o, asker.id, revokedAsk.id)).toBe("open");
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([]);
  });
});

describe("sign-in-links-revoke takes back an expired link an owner could extend", () => {
  it("opens on a member whose only link is expired and extendable, and Apply removes it: nothing is left to extend", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const entry = await opened(o, asker.id, {
      kind: "sign-in-links-revoke",
      username: o.danaName,
    });
    expect(succeeded(await run(o, o.morgan, entry.id))).toBe(true);
    await closedAsDone(o, asker.id, entry.id);
    expect(await linksOf(o, asker.id, o.danaName)).toEqual([]);
    expect(outcome(await ask(o, asker.id, extendStep(o.danaName)))).toEqual(
      refused(409, "no_extendable_link"),
    );
    expect(
      (
        await asSession(
          o,
          o.morgan,
          "POST",
          `/api/invites/${expired.tokenPrefix}/extend`,
        )
      ).status,
    ).toBe(404);
  });

  it("an expired extendable link taken back by hand closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const entry = await opened(o, asker.id, {
      kind: "sign-in-links-revoke",
      username: o.danaName,
    });
    expect(
      (
        await asSession(
          o,
          o.morgan,
          "DELETE",
          `/api/invites/${expired.tokenPrefix}`,
        )
      ).status,
    ).toBeLessThan(300);
    await closedAsDone(o, asker.id, entry.id);
  });
});

// Dana with a session of her own, signed in by a link used 5 days ago: an
// expired 3-day link minted after it is still hers to extend. Her agent.
async function danaSignedIn(o: Office) {
  const session = await inThePast(5 * 86_400_000, async () => {
    const mint = await mintInvite({
      userId: o.danaId,
      createdBy: o.morganName,
      ttlMs: INVITE_TTL_MS,
    });
    if (!mint.ok) throw new Error(`mint failed: ${mint.error}`);
    const acc = await acceptInvite(mint.rawToken, { userAgent: "test" });
    if (!acc.ok) throw new Error(`accept failed: ${acc.error}`);
    return acc.rawSessionId;
  });
  // The enabling condition: the session still signs in.
  expect((await asSession(o, session, "GET", "/api/sessions")).status).toBe(
    200,
  );
  // Her agent sits in the first room, so she needs it.
  expect(
    (
      await asSession(o, o.morgan, "PUT", `/api/users/${o.danaName}/access`, {
        allowedRooms: [o.room],
      })
    ).status,
  ).toBe(200);
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-link-avatar-"));
  folders.push(cwd);
  const agent = await o.srv.agentManager.spawn(
    "Dana's helper",
    cwd,
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    o.danaName,
    "claude",
    undefined,
    o.danaId,
  );
  if (!agent) throw new Error("spawn failed: Dana's helper");
  return { session, agent };
}

describe("a member takes back their own expired link an owner could extend", () => {
  it("opens for the member themself, and their Apply removes the link: the ask closes", async () => {
    const o = await office();
    const dana = await danaSignedIn(o);
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    await ownerSeesExtendable(o, expired.tokenPrefix, true);
    const entry = await opened(o, dana.agent.id, {
      kind: "sign-in-links-revoke",
      username: o.danaName,
    });
    expect(succeeded(await run(o, dana.session, entry.id))).toBe(true);
    await closedAsDone(o, dana.agent.id, entry.id);
    expect(await linksOf(o, dana.agent.id, o.danaName)).toEqual([]);
  });

  it("a member's DELETE of another member's expired extendable link, or of their own expired 1h link, stays 403 and removes nothing", async () => {
    const o = await office();
    const dana = await danaSignedIn(o);
    const foreign = await mintExpiredLink("Eve", { createdBy: o.morganName });
    const del = (prefix: string) =>
      asSession(o, dana.session, "DELETE", `/api/invites/${prefix}`);
    expect((await del(foreign.tokenPrefix)).status).toBe(403);
    // Eve's link is still there for an owner to extend.
    const owners = await asSession(o, o.morgan, "GET", "/api/invites");
    expect(
      (owners.body as { invites: InviteWire[] }).invites
        .filter((i) => i.username === "Eve")
        .map((i) => [i.tokenPrefix, i.extendable]),
    ).toEqual([[foreign.tokenPrefix, true]]);
    // Control: the 403 is the row, not the member: Dana's own expired
    // owner-made link goes.
    const mine = await mintExpiredLink(o.danaName, { createdBy: o.morganName });
    await ownerSeesExtendable(o, mine.tokenPrefix, true);
    expect((await del(mine.tokenPrefix)).status).toBeLessThan(300);
    // Her own 1h link, expired: an owner cannot extend it, so it is not
    // hers to take back either.
    const own = await mintExpiredLink(o.danaName, {
      createdBy: o.danaName,
      ttlMs: SELF_INVITE_TTL_MS,
    });
    expect((await del(own.tokenPrefix)).status).toBe(403);
  });
});

describe("a member-avatar ask", () => {
  it("opens for an owner on a member with the colour as the record stores it, and with one field alone", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const now = avatarOf(o.caseyName);
    const color = now.avatarColor === "#aabbcc" ? "#AABBCD" : "#AABBCC";
    const variant = now.avatarVariant === "sleepy" ? "nightcap" : "sleepy";
    expect(
      (
        await opened(
          o,
          asker.id,
          avatarStep(o.caseyName, {
            avatarColor: color,
            avatarVariant: variant,
          }),
        )
      ).step,
    ).toEqual({
      kind: "member-avatar",
      userId: o.caseyId,
      avatarColor: color.toLowerCase(),
      avatarVariant: variant,
    });
    expect(
      (
        await opened(
          o,
          asker.id,
          avatarStep(o.caseyName, { avatarColor: color }),
        )
      ).step,
    ).toEqual({
      kind: "member-avatar",
      userId: o.caseyId,
      avatarColor: color.toLowerCase(),
    });
    expect(
      (
        await opened(
          o,
          asker.id,
          avatarStep(o.caseyName, { avatarVariant: variant }),
        )
      ).step,
    ).toEqual({
      kind: "member-avatar",
      userId: o.caseyId,
      avatarVariant: variant,
    });
  });

  it("refuses no field, a colour or shape the record does not take, an extra key (400), and an unknown member (422)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    for (const bad of [
      avatarStep(o.caseyName, {}),
      avatarStep(o.caseyName, { avatarColor: "red" }),
      avatarStep(o.caseyName, { avatarColor: "#12345" }),
      avatarStep(o.caseyName, { avatarVariant: "dragon" }),
      { ...avatarStep(o.caseyName, { avatarVariant: "sleepy" }), name: "X" },
      { kind: "member-avatar", avatarVariant: "sleepy" },
    ])
      expect({ bad, status: (await ask(o, asker.id, bad)).status }).toEqual({
        bad,
        status: 400,
      });
    expect(
      outcome(
        await ask(
          o,
          asker.id,
          avatarStep("nobody-here", { avatarVariant: "sleepy" }),
        ),
      ),
    ).toEqual(refused(422, "unknown_member"));
  });

  it("a member applies their own; another member's is 403 member_not_allowed, before step_done; the values the record has are 409 step_done", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const asker = await spawn(o, "Asker");
    const morganNow = avatarOf(o.morganName);
    // Morgan's avatar as it is: refused for who would apply it, not done.
    expect(
      outcome(await ask(o, caseys.id, avatarStep(o.morganName, morganNow))),
    ).toEqual(refused(403, "member_not_allowed"));
    const variant =
      morganNow.avatarVariant === "sleepy" ? "nightcap" : "sleepy";
    expect(
      outcome(
        await ask(
          o,
          caseys.id,
          avatarStep(o.morganName, { avatarVariant: variant }),
        ),
      ),
    ).toEqual(refused(403, "member_not_allowed"));
    const caseyNow = avatarOf(o.caseyName);
    await opened(
      o,
      caseys.id,
      avatarStep(o.caseyName, {
        avatarVariant:
          caseyNow.avatarVariant === "sleepy" ? "nightcap" : "sleepy",
      }),
    );
    expect(
      outcome(await ask(o, asker.id, avatarStep(o.caseyName, caseyNow))),
    ).toEqual(refused(409, "step_done"));
    expect(
      outcome(
        await ask(
          o,
          asker.id,
          avatarStep(o.caseyName, {
            avatarColor: caseyNow.avatarColor.toUpperCase(),
          }),
        ),
      ),
    ).toEqual(refused(409, "step_done"));
  });

  it("Apply by an owner sets the member's avatar to what was asked: the ask closes, the agent hears one line, one users.update row by the owner names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const now = avatarOf(o.caseyName);
    const want = {
      avatarColor: now.avatarColor === "#aabbcc" ? "#ccbbaa" : "#aabbcc",
      avatarVariant: now.avatarVariant === "sleepy" ? "nightcap" : "sleepy",
    };
    const entry = await opened(o, asker.id, avatarStep(o.caseyName, want));
    expect(succeeded(await run(o, o.morgan, entry.id))).toBe(true);
    expect(avatarOf(o.caseyName)).toEqual(want);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.memberAvatarSet",
    ]);
    auditedOnce("users.update", entry.id, o.morganId);
  });

  it("Apply sends only the fields asked: a shape changed by hand before Apply stays, and the member's own Apply works with their session", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const now = avatarOf(o.caseyName);
    const color = now.avatarColor === "#aabbcc" ? "#ccbbaa" : "#aabbcc";
    const entry = await opened(
      o,
      caseys.id,
      avatarStep(o.caseyName, { avatarColor: color }),
    );
    const byHand =
      now.avatarVariant === "wisp-tail" ? "glow-halo" : "wisp-tail";
    expect(
      (
        await asSession(o, o.casey, "PATCH", `/api/users/${o.caseyName}`, {
          avatarVariant: byHand,
        })
      ).status,
    ).toBe(200);
    // The enabling condition: the shape changed, the colour did not.
    expect(avatarOf(o.caseyName)).toEqual({
      avatarColor: now.avatarColor,
      avatarVariant: byHand,
    });
    expect(await askStatus(o, caseys.id, entry.id)).toBe("open");
    expect(succeeded(await run(o, o.casey, entry.id))).toBe(true);
    expect(avatarOf(o.caseyName)).toEqual({
      avatarColor: color,
      avatarVariant: byHand,
    });
    await closedAsDone(o, caseys.id, entry.id);
    auditedOnce("users.update", entry.id, o.caseyId);
  });

  it("the avatar set by hand closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const now = avatarOf(o.caseyName);
    const variant = now.avatarVariant === "sleepy" ? "nightcap" : "sleepy";
    const entry = await opened(
      o,
      asker.id,
      avatarStep(o.caseyName, { avatarVariant: variant }),
    );
    expect(
      (
        await asSession(o, o.morgan, "PATCH", `/api/users/${o.caseyName}`, {
          avatarVariant: variant,
        })
      ).status,
    ).toBe(200);
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("the two steps from /mcp", () => {
  it("open_ask takes sign-in-link-extend and member-avatar", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${agent.id}/access`,
      { access: "office" },
    );
    expect(lowered.status).toBe(200);
    const expired = await mintExpiredLink(o.danaName, {
      createdBy: o.morganName,
    });
    const now = avatarOf(o.caseyName);
    const variant = now.avatarVariant === "sleepy" ? "nightcap" : "sleepy";
    const client = new Client({ name: "action-asks-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}` },
        },
      }),
    );
    clients.push(client);
    for (const [step, stored] of [
      [
        extendStep(o.danaName),
        {
          kind: "sign-in-link-extend",
          userId: o.danaId,
          tokenPrefix: expired.tokenPrefix,
        },
      ],
      [
        avatarStep(o.caseyName, {
          avatarColor: "#ABCDEF",
          avatarVariant: variant,
        }),
        {
          kind: "member-avatar",
          userId: o.caseyId,
          avatarColor: "#abcdef",
          avatarVariant: variant,
        },
      ],
    ] as const) {
      const result = (await client.callTool({
        name: "open_ask",
        arguments: { prompt: "Please do this.", step },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      expect({ kind: step.kind, error: result.isError ?? false }).toEqual({
        kind: step.kind,
        error: false,
      });
      const entry = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
      expect(entry.step as unknown).toMatchObject(stored);
    }
  });
});

// Later files in the same bun process: none of this file's members or their
// files on disk.
afterAll(() => resetStateRoot(STATE_ROOT));
