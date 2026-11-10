// Action asks, part 4 (task e3d1bc63): the actions that make or take back a
// credential. An agent asks a member for a sign-in link, a sign-out on every
// device, one session revoked (task 43b67f3a), a sign-in link taken back, a
// personal API token, a token revoked, or the office's outside access; the
// member runs it from the card. A sign-in link or a token the run makes is in
// the run's answer to the member's page and nowhere else: not in anything the
// agent reads, not in what the server stores. The ask closes when the state
// reaches the value, by the card or by hand on the page.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { createMember, getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  INVITE_TTL_MS,
  _testSetSessionExpiry,
  acceptInvite,
  mintInvite,
} from "../auth.ts";
import { STATE_ROOT } from "../config.ts";
import type {
  AgentInfo,
  AskEntry,
  InviteWire,
  SessionWire,
} from "../../shared/types.ts";
import type {
  AccessSettings,
  ApiTokenWire,
} from "../../shared/contract-shapes.ts";

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

// Morgan owns the office; Casey is a member with its first room.
async function office(opts: Parameters<typeof startTestServer>[0] = {}) {
  const srv = await startTestServer(opts);
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
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
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-cred-"));
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

function asBearer(
  o: Office,
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    .then(read);
}

const asAgent = (
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
) => asBearer(o, getAgentTokenRaw(agentId)!, method, path, body);

const codeOf = (res: Res) =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });
const succeeded = (res: Res) => res.status >= 200 && res.status < 300;

function ask(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please do this.",
    step,
    ...(member ? { member } : {}),
  });
}

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step, member);
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

// The rows of `operation` that name the ask, newest first, as [actor kind,
// actor id].
function auditRows(operation: string, askId: string) {
  return officeAuditStore()
    .list({ operation, limit: 1000 })
    .items.filter((r) => r.targets.includes(askId));
}
function auditedOnce(operation: string, askId: string, memberId: string) {
  expect(
    auditRows(operation, askId).map((r) => [r.actor.kind, r.actor.id]),
  ).toEqual([["member", memberId]]);
}

// A further session for a member, as a sign-in link on another device.
async function signIn(username: string, userAgent = "test"): Promise<string> {
  const user = getUserByName(username)!;
  const mint = await mintInvite({
    userId: user.id,
    createdBy: null,
    ttlMs: INVITE_TTL_MS,
  });
  if (!mint.ok) throw new Error(`mint failed: ${mint.error}`);
  const acc = await acceptInvite(mint.rawToken, { userAgent });
  if (!acc.ok) throw new Error(`accept failed: ${acc.error}`);
  return acc.rawSessionId;
}

// A further session for a member and its prefix, the one session the
// member's list gained.
async function signInWithPrefix(
  o: Office,
  username: string,
  userAgent = "test",
): Promise<{ session: string; prefix: string }> {
  const userId = getUserByName(username)!.id;
  const before = await sessionPrefixes(o, userId);
  const session = await signIn(username, userAgent);
  const added = (await sessionPrefixes(o, userId)).filter(
    (p) => !before.includes(p),
  );
  expect(added).toHaveLength(1);
  return { session, prefix: added[0] };
}

// Whether a session still signs in.
const alive = async (o: Office, session: string) =>
  (await asSession(o, session, "GET", "/api/sessions")).status === 200;

// A member's live session prefixes, read by the owner.
async function sessionPrefixes(o: Office, userId: string): Promise<string[]> {
  const res = await asSession(o, o.morgan, "GET", "/api/sessions");
  expect(res.status).toBe(200);
  return (res.body as { sessions: SessionWire[] }).sessions
    .filter((s) => s.userId === userId)
    .map((s) => s.sessionPrefix)
    .sort();
}

// A member's pending sign-in links, read by an owner session.
async function pendingLinks(
  o: Office,
  ownerSession: string,
  username: string,
): Promise<string[]> {
  const res = await asSession(o, ownerSession, "GET", "/api/invites");
  expect(res.status).toBe(200);
  return (res.body as { invites: InviteWire[] }).invites
    .filter((i) => i.username === username)
    .map((i) => i.tokenPrefix);
}

// The raw token at the end of a sign-in link.
const linkToken = (url: string) => {
  const m = /\/i\/([^/?#]+)$/.exec(url);
  if (!m) throw new Error(`not a sign-in link: ${url}`);
  return m[1];
};

async function mintToken(
  o: Office,
  session: string,
  name: string,
  limits?: Record<string, unknown>,
): Promise<{ token: string; id: string }> {
  const res = await asSession(o, session, "POST", "/api/me/api-tokens", {
    name,
    expiresInDays: 30,
    ...(limits ? { limits } : {}),
  });
  expect(succeeded(res)).toBe(true);
  const body = res.body as { token: string; apiToken: ApiTokenWire };
  return { token: body.token, id: body.apiToken.id };
}

async function tokensOf(o: Office, session: string): Promise<ApiTokenWire[]> {
  const res = await asSession(o, session, "GET", "/api/me/api-tokens");
  expect(res.status).toBe(200);
  return (res.body as { apiTokens: ApiTokenWire[] }).apiTokens;
}

// Everything the asking agent can read about its ask, and what its session
// was sent. Each read must succeed and carry the ask, so an empty read cannot
// pass for one without the secret.
async function agentView(o: Office, agentId: string, askId: string) {
  const parts: string[] = [];
  for (const path of [
    `/api/agents/${agentId}/asks`,
    `/api/agents/${agentId}/asks/${askId}`,
    `/api/agents/${agentId}/asks/history`,
    `/api/agents/${agentId}/asks/events`,
  ]) {
    const res = await asAgent(o, agentId, "GET", path);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    parts.push(JSON.stringify(res.body));
  }
  expect(parts.slice(1).every((p) => p.includes(askId))).toBe(true);
  parts.push(JSON.stringify(o.srv.agentManager.getAgentLogs(agentId)));
  parts.push(JSON.stringify(o.srv.fakeBackend.sessions.map((s) => s.sent)));
  parts.push(JSON.stringify(officeAuditStore().list({ limit: 1000 }).items));
  return parts.join("\n");
}

// The state files that hold `secret`, after the server stopped (so every
// pending write is on disk).
async function storedWith(secret: string): Promise<string[]> {
  await server?.stop();
  server = null;
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && readFileSync(path).includes(secret))
        hits.push(path);
    }
  };
  walk(STATE_ROOT);
  return hits;
}

// The answer to a step the asking agent cannot see or the member could not
// run, as an outcome.
const refused = (status: number, code: string) => ({ status, code });

const signInLinkStep = (username: string) => ({
  kind: "sign-in-link",
  username,
});
const sessionsStep = (username: string) => ({
  kind: "member-sessions",
  username,
});
const linksRevokeStep = (username: string) => ({
  kind: "sign-in-links-revoke",
  username,
});
const tokenStep = (
  name: string,
  expiresInDays: 30 | 365 | null = 30,
  limits?: Record<string, unknown>,
) => ({
  kind: "api-token",
  name,
  expiresInDays,
  ...(limits ? { limits } : {}),
});
const sessionRevokeStep = (username: string, sessionPrefix: string) => ({
  kind: "session-revoke",
  username,
  sessionPrefix,
});
const tokenRevokeStep = (tokenId: string) => ({
  kind: "api-token-revoke",
  tokenId,
});
const accessStep = (externalAccess: boolean, publicOrigin: string) => ({
  kind: "office-access",
  externalAccess,
  publicOrigin,
});

const TASKS_READ = { areas: { tasks: "read" } } as const;

describe("a sign-in-link ask at create", () => {
  it("opens for an owner for a member and for a member for themself, stored by id with no link; a link made before the ask does not make it done", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    // Casey has a pending link already.
    const before = await asSession(o, o.morgan, "POST", "/api/invites", {
      userId: o.caseyId,
    });
    expect(succeeded(before)).toBe(true);
    const forCasey = await opened(o, asker.id, signInLinkStep(o.caseyName));
    expect([forCasey.step, forCasey.link]).toEqual([
      { kind: "sign-in-link", userId: o.caseyId },
      undefined,
    ]);
    const own = await opened(o, caseys.id, signInLinkStep(o.caseyName));
    expect(own.step).toEqual({ kind: "sign-in-link", userId: o.caseyId });
    // Nothing ran: the one link is the one made before.
    expect(await pendingLinks(o, o.morgan, o.caseyName)).toEqual([
      (before.body as { invite: InviteWire }).invite.tokenPrefix,
    ]);
  });

  it("refuses a member's link for another member (403), an unknown member (422), and a step with extra keys or no username (400)", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    expect(
      outcome(await ask(o, caseys.id, signInLinkStep(o.morganName))),
    ).toEqual(refused(403, "member_not_allowed"));
    expect(outcome(await ask(o, caseys.id, signInLinkStep("nobody")))).toEqual(
      refused(422, "unknown_member"),
    );
    for (const step of [
      { kind: "sign-in-link" },
      { kind: "sign-in-link", username: o.caseyName, url: "x" },
      { kind: "sign-in-link", userId: o.caseyId },
    ])
      expect(outcome(await ask(o, caseys.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
  });
});

describe("a sign-in-link ask run from the card", () => {
  it("makes the member's link with the owner's session: the link is in the run's answer and signs that member in, the ask closes, the agent hears one line, one invites.mint row names the ask, and the link is in nothing the agent reads or the server stores", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, signInLinkStep(o.caseyName));
    const res = await run(o, o.morgan, entry.id);
    expect(succeeded(res)).toBe(true);
    const url = (res.body as { url: string }).url;
    const raw = linkToken(url);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    auditedOnce("invites.mint", entry.id, o.morganId);
    const seen = await agentView(o, asker.id, entry.id);
    expect(seen.includes(raw)).toBe(false);
    // The link is Casey's.
    const accepted = await acceptInvite(raw, { userAgent: "test" });
    expect(accepted.ok && accepted.username).toBe(o.caseyName);
    expect(await storedWith(raw)).toEqual([]);
  });

  it("a member's own link runs the self route with their session", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const entry = await opened(o, caseys.id, signInLinkStep(o.caseyName));
    const res = await run(o, o.casey, entry.id);
    expect(succeeded(res)).toBe(true);
    await closedAsDone(o, caseys.id, entry.id);
    auditedOnce("invites.mintSelf", entry.id, o.caseyId);
    expect(auditRows("invites.mint", entry.id)).toEqual([]);
  });

  it("a link made by hand on the Members page after the ask opened closes it; one made before stays pending and does not", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const before = await asSession(o, o.morgan, "POST", "/api/invites", {
      userId: o.caseyId,
    });
    expect(succeeded(before)).toBe(true);
    const entry = await opened(o, asker.id, signInLinkStep(o.caseyName));
    // Another link change runs the close check: Casey's link from before
    // the ask is still pending, and the ask stays open.
    expect(
      succeeded(await asSession(o, o.morgan, "POST", "/api/invites/self")),
    ).toBe(true);
    await Bun.sleep(100);
    expect(await pendingLinks(o, o.morgan, o.caseyName)).toHaveLength(1);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    const byHand = await asSession(o, o.morgan, "POST", "/api/invites", {
      userId: o.caseyId,
    });
    expect(succeeded(byHand)).toBe(true);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("an API token of the member the ask is for cannot run it: 403, no link made, the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, signInLinkStep(o.caseyName));
    const { token } = await mintToken(o, o.morgan, "script");
    const res = await asBearer(
      o,
      token,
      "POST",
      `/api/asks/${entry.id}/action`,
    );
    expect(res.status).toBe(403);
    expect(await pendingLinks(o, o.morgan, o.caseyName)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });
});

describe("a member-sessions ask at create", () => {
  it("opens for an owner for a member and for a member for themself, stored by id; refuses a member for another member (403) and a member with no live session (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect((await opened(o, asker.id, sessionsStep(o.caseyName))).step).toEqual(
      { kind: "member-sessions", userId: o.caseyId },
    );
    expect(
      (await opened(o, caseys.id, sessionsStep(o.caseyName))).step,
    ).toEqual({ kind: "member-sessions", userId: o.caseyId });
    expect(
      outcome(await ask(o, caseys.id, sessionsStep(o.morganName))),
    ).toEqual(refused(403, "member_not_allowed"));
    const quiet = createMember("Quinn", { role: "member" });
    expect(quiet.ok).toBe(true);
    expect(outcome(await ask(o, asker.id, sessionsStep("Quinn")))).toEqual(
      refused(409, "step_done"),
    );
    // Nothing ran.
    expect(await alive(o, o.casey)).toBe(true);
  });

  it("refuses to sign out the only owner with a live session (409 would_strand_office); opens once another owner has one", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    expect(outcome(await ask(o, asker.id, sessionsStep(o.morganName)))).toEqual(
      refused(409, "would_strand_office"),
    );
    const dana = await o.srv.seedMember("Dana");
    const promoted = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${dana.username}`,
      {
        role: "owner",
      },
    );
    expect(promoted.status).toBe(200);
    expect(await alive(o, dana.rawSessionId)).toBe(true);
    await opened(o, asker.id, sessionsStep(o.morganName));
  });
});

describe("a member-sessions ask run from the card", () => {
  it("ends every live session of the member at Apply, one made after the ask opened included, with one sessions.revoke row each naming the ask; the ask closes and the agent hears one line", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const second = await signIn(o.caseyName);
    const entry = await opened(o, asker.id, sessionsStep(o.caseyName));
    const later = await signIn(o.caseyName);
    const prefixes = await sessionPrefixes(o, o.caseyId);
    expect(prefixes).toHaveLength(3);
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(204);
    expect([
      await alive(o, o.casey),
      await alive(o, second),
      await alive(o, later),
      await alive(o, o.morgan),
    ]).toEqual([false, false, false, true]);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    const rows = auditRows("sessions.revoke", entry.id);
    expect(rows.map((r) => [r.actor.kind, r.actor.id])).toEqual(
      prefixes.map(() => ["member", o.morganId]),
    );
    expect(
      prefixes.map((p) => rows.filter((r) => r.targets.includes(p)).length),
    ).toEqual([1, 1, 1]);
  });

  it("signing themself out ends the member's other sessions first and the one they applied from last", async () => {
    const o = await office();
    const dana = await o.srv.seedMember("Dana");
    expect(
      (
        await asSession(o, o.morgan, "PATCH", `/api/users/${dana.username}`, {
          role: "owner",
        })
      ).status,
    ).toBe(200);
    const asker = await spawn(o, "Asker");
    const [here] = await sessionPrefixes(o, o.morganId);
    const other = await signIn(o.morganName);
    const entry = await opened(o, asker.id, sessionsStep(o.morganName));
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(204);
    expect([
      await alive(o, o.morgan),
      await alive(o, other),
      await alive(o, dana.rawSessionId),
    ]).toEqual([false, false, true]);
    const rows = auditRows("sessions.revoke", entry.id);
    expect(rows).toHaveLength(2);
    // Newest first: the last revoke is the session that applied.
    expect(rows[0].targets.includes(here)).toBe(true);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("a run that stops at the office's last owner session keeps what it did, answers with the refusal, and stays open; Apply again when another owner is signed in finishes it", async () => {
    const o = await office();
    const dana = await o.srv.seedMember("Dana");
    expect(
      (
        await asSession(o, o.morgan, "PATCH", `/api/users/${dana.username}`, {
          role: "owner",
        })
      ).status,
    ).toBe(200);
    const asker = await spawn(o, "Asker");
    const other = await signIn(o.morganName);
    const entry = await opened(o, asker.id, sessionsStep(o.morganName));
    // Dana signs out: Morgan's sessions are the office's last owner sessions.
    expect(
      (await asSession(o, dana.rawSessionId, "DELETE", "/api/sessions/current"))
        .status,
    ).toBeLessThan(300);
    const first = await run(o, o.morgan, entry.id);
    expect(outcome(first)).toEqual(refused(409, "would_strand_office"));
    expect([await alive(o, other), await alive(o, o.morgan)]).toEqual([
      false,
      true,
    ]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    await signIn(dana.username);
    const second = await run(o, o.morgan, entry.id);
    expect(second.status).toBe(204);
    expect(await alive(o, o.morgan)).toBe(false);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("revoking by hand the sessions that were live when the ask opened closes it, though a later one is live", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const [first] = await sessionPrefixes(o, o.caseyId);
    const entry = await opened(o, asker.id, sessionsStep(o.caseyName));
    const later = await signIn(o.caseyName);
    expect(
      (await asSession(o, o.morgan, "DELETE", `/api/sessions/${first}`)).status,
    ).toBe(204);
    await closedAsDone(o, asker.id, entry.id);
    expect(await alive(o, later)).toBe(true);
  });
});

describe("sign-in-links-revoke asks", () => {
  it("opens for an owner and for the member themself, stored by id; refuses a member for another member's links (403) and a member with no pending link (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect(
      outcome(await ask(o, asker.id, linksRevokeStep(o.caseyName))),
    ).toEqual(refused(409, "step_done"));
    expect(
      succeeded(
        await asSession(o, o.morgan, "POST", "/api/invites", {
          userId: o.caseyId,
        }),
      ),
    ).toBe(true);
    expect(
      (await opened(o, asker.id, linksRevokeStep(o.caseyName))).step,
    ).toEqual({ kind: "sign-in-links-revoke", userId: o.caseyId });
    await opened(o, caseys.id, linksRevokeStep(o.caseyName));
    expect(
      succeeded(await asSession(o, o.morgan, "POST", "/api/invites/self")),
    ).toBe(true);
    expect(
      outcome(await ask(o, caseys.id, linksRevokeStep(o.morganName))),
    ).toEqual(refused(403, "member_not_allowed"));
  });

  it("Apply takes the link back with the owner's session: it no longer signs in, the ask closes, one invites.revoke row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const minted = await asSession(o, o.morgan, "POST", "/api/invites", {
      userId: o.caseyId,
    });
    const raw = linkToken((minted.body as { url: string }).url);
    const entry = await opened(o, asker.id, linksRevokeStep(o.caseyName));
    expect(succeeded(await run(o, o.morgan, entry.id))).toBe(true);
    expect(await pendingLinks(o, o.morgan, o.caseyName)).toEqual([]);
    expect((await acceptInvite(raw, { userAgent: "test" })).ok).toBe(false);
    await closedAsDone(o, asker.id, entry.id);
    auditedOnce("invites.revoke", entry.id, o.morganId);
  });

  it("a new link made by hand, which replaces the one that was pending, closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await asSession(o, o.morgan, "POST", "/api/invites", { userId: o.caseyId });
    const entry = await opened(o, asker.id, linksRevokeStep(o.caseyName));
    await asSession(o, o.morgan, "POST", "/api/invites", { userId: o.caseyId });
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("an api-token ask at create", () => {
  it("opens with the token as asked, and a token of that name made before the ask does not make it done", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await mintToken(o, o.morgan, "deploy");
    const entry = await opened(
      o,
      asker.id,
      tokenStep("deploy", 365, TASKS_READ),
    );
    expect([entry.step, entry.link]).toEqual([
      {
        kind: "api-token",
        name: "deploy",
        expiresInDays: 365,
        limits: TASKS_READ,
      },
      undefined,
    ]);
    expect(await tokensOf(o, o.morgan)).toHaveLength(1);
  });

  it("refuses what POST /api/me/api-tokens refuses (400): no name, an expiry it does not offer, limits that do not parse, extra keys", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    for (const step of [
      { kind: "api-token", expiresInDays: 30 },
      tokenStep("", 30),
      { kind: "api-token", name: "x", expiresInDays: 7 },
      tokenStep("x", 30, { areas: { nowhere: "write" } }),
      { ...tokenStep("x", 30), token: "isx_x" },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
  });
});

describe("an api-token ask run from the card", () => {
  it("mints the token with the member's session: it is in the run's answer and the member's list with the limits asked, the ask closes, one apiTokens.mint row names the ask, and the token is in nothing the agent reads or the server stores", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(
      o,
      asker.id,
      tokenStep("deploy", 30, TASKS_READ),
    );
    const res = await run(o, o.morgan, entry.id);
    expect(succeeded(res)).toBe(true);
    const { token, apiToken } = res.body as {
      token: string;
      apiToken: ApiTokenWire;
    };
    const listed = await tokensOf(o, o.morgan);
    expect(
      listed.map((t) => ({ id: t.id, name: t.name, limits: t.limits })),
    ).toEqual([{ id: apiToken.id, name: "deploy", limits: TASKS_READ }]);
    // The token works.
    expect((await asBearer(o, token, "GET", "/api/tasks")).status).toBe(200);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    auditedOnce("apiTokens.mint", entry.id, o.morganId);
    const seen = await agentView(o, asker.id, entry.id);
    expect(seen.includes(token)).toBe(false);
    expect(await storedWith(token)).toEqual([]);
  });

  it("a token of that name made by hand after the ask opened closes it; one made before does not", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await mintToken(o, o.morgan, "deploy");
    const entry = await opened(o, asker.id, tokenStep("deploy"));
    // Another mint runs the close check: the "deploy" token from before the
    // ask does not close it.
    await mintToken(o, o.morgan, "other");
    await Bun.sleep(100);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    await mintToken(o, o.morgan, "deploy");
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("api-token-revoke asks", () => {
  it("opens for an owner on a member's token and for a member on their own; a token the member may not revoke answers as a missing one (422 unknown_token)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    const caseyToken = await mintToken(o, o.casey, "laptop");
    const morganToken = await mintToken(o, o.morgan, "ci");
    expect(
      (await opened(o, asker.id, tokenRevokeStep(caseyToken.id)))
        .step as unknown,
    ).toEqual({
      kind: "api-token-revoke",
      tokenId: caseyToken.id,
      // The token's owner, filled in by the server for the card.
      userId: o.caseyId,
    });
    await opened(o, caseys.id, tokenRevokeStep(caseyToken.id));
    const notHers = await ask(o, caseys.id, tokenRevokeStep(morganToken.id));
    const missing = await ask(
      o,
      caseys.id,
      tokenRevokeStep("0123456789abcdef"),
    );
    expect(outcome(notHers)).toEqual(refused(422, "unknown_token"));
    expect(notHers.body).toEqual(missing.body);
  });

  it("an owner's Apply revokes a member's token through the owner route; the member's Apply revokes their own; each ask closes with one row naming it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    const laptop = await mintToken(o, o.casey, "laptop");
    const phone = await mintToken(o, o.casey, "phone");
    const byOwner = await opened(o, asker.id, tokenRevokeStep(laptop.id));
    const byCasey = await opened(o, caseys.id, tokenRevokeStep(phone.id));
    expect(succeeded(await run(o, o.morgan, byOwner.id))).toBe(true);
    expect(succeeded(await run(o, o.casey, byCasey.id))).toBe(true);
    expect(await tokensOf(o, o.casey)).toEqual([]);
    await closedAsDone(o, asker.id, byOwner.id);
    await closedAsDone(o, caseys.id, byCasey.id);
    auditedOnce("apiTokens.adminRevoke", byOwner.id, o.morganId);
    auditedOnce("apiTokens.revoke", byCasey.id, o.caseyId);
  });

  it("a revoke by hand closes it", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const laptop = await mintToken(o, o.casey, "laptop");
    const entry = await opened(o, caseys.id, tokenRevokeStep(laptop.id));
    expect(
      (await asSession(o, o.casey, "DELETE", `/api/me/api-tokens/${laptop.id}`))
        .status,
    ).toBe(204);
    await closedAsDone(o, caseys.id, entry.id);
  });
});

// Task 43b67f3a: one session of a member revoked from the card.
describe("a session-revoke ask at create", () => {
  it("opens for an owner on a member's session and for a member on their own, stored by id with the prefix; refuses a member on another member's session (403), an unknown member (422), a prefix that is not a live session of that member (422 unknown_session, one answer), and a step with no prefix or extra keys (400); nothing runs", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    const curl = await signInWithPrefix(o, o.caseyName, "curl/8.5.0");
    // A second owner session, so no refusal below is the office's last one.
    const morgans = await signInWithPrefix(o, o.morganName);
    expect(
      (await opened(o, asker.id, sessionRevokeStep(o.caseyName, curl.prefix)))
        .step as unknown,
    ).toEqual({
      kind: "session-revoke",
      userId: o.caseyId,
      sessionPrefix: curl.prefix,
    });
    expect(
      (await opened(o, caseys.id, sessionRevokeStep(o.caseyName, curl.prefix)))
        .step as unknown,
    ).toEqual({
      kind: "session-revoke",
      userId: o.caseyId,
      sessionPrefix: curl.prefix,
    });
    expect(
      outcome(
        await ask(
          o,
          caseys.id,
          sessionRevokeStep(o.morganName, morgans.prefix),
        ),
      ),
    ).toEqual(refused(403, "member_not_allowed"));
    expect(
      outcome(await ask(o, asker.id, sessionRevokeStep("nobody", curl.prefix))),
    ).toEqual(refused(422, "unknown_member"));
    // Another member's live session, a prefix no session has, and an expired
    // session of the member answer alike.
    const stale = await signInWithPrefix(o, o.caseyName);
    expect(
      _testSetSessionExpiry(stale.session, { expiresAt: Date.now() - 1000 }),
    ).toBe(true);
    const notHers = await ask(
      o,
      asker.id,
      sessionRevokeStep(o.caseyName, morgans.prefix),
    );
    expect(outcome(notHers)).toEqual(refused(422, "unknown_session"));
    for (const prefix of ["zzzzzzzz", stale.prefix]) {
      const res = await ask(
        o,
        asker.id,
        sessionRevokeStep(o.caseyName, prefix),
      );
      expect({ prefix, body: res.body }).toEqual({
        prefix,
        body: notHers.body,
      });
    }
    for (const step of [
      { kind: "session-revoke", username: o.caseyName },
      { kind: "session-revoke", username: o.caseyName, sessionPrefix: "" },
      { ...sessionRevokeStep(o.caseyName, curl.prefix), userId: o.caseyId },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
    // Nothing ran.
    expect([
      await alive(o, curl.session),
      await alive(o, o.casey),
      await alive(o, morgans.session),
    ]).toEqual([true, true, true]);
  });

  it("refuses the office's last owner session (409 would_strand_office), and opens for one of two sessions of the only owner", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const [here] = await sessionPrefixes(o, o.morganId);
    expect(
      outcome(await ask(o, asker.id, sessionRevokeStep(o.morganName, here))),
    ).toEqual(refused(409, "would_strand_office"));
    // The other session keeps the office reachable: only this one ends.
    const second = await signInWithPrefix(o, o.morganName);
    await opened(o, asker.id, sessionRevokeStep(o.morganName, second.prefix));
    expect(await alive(o, second.session)).toBe(true);
  });
});

describe("a session-revoke ask run from the card", () => {
  it("an owner's Apply ends that one session of the member and no other; the ask closes, the agent hears one line, and one sessions.revoke row by the owner names the ask and the session", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const curl = await signInWithPrefix(o, o.caseyName, "curl/8.5.0");
    const entry = await opened(
      o,
      asker.id,
      sessionRevokeStep(o.caseyName, curl.prefix),
    );
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(204);
    expect([
      await alive(o, curl.session),
      await alive(o, o.casey),
      await alive(o, o.morgan),
    ]).toEqual([false, true, true]);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    const rows = auditRows("sessions.revoke", entry.id);
    expect(rows.map((r) => [r.actor.kind, r.actor.id])).toEqual([
      ["member", o.morganId],
    ]);
    expect(rows[0].targets.includes(curl.prefix)).toBe(true);
  });

  it("a member's Apply ends their own other session with their session", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const other = await signInWithPrefix(o, o.caseyName);
    const entry = await opened(
      o,
      caseys.id,
      sessionRevokeStep(o.caseyName, other.prefix),
    );
    expect((await run(o, o.casey, entry.id)).status).toBe(204);
    expect([await alive(o, other.session), await alive(o, o.casey)]).toEqual([
      false,
      true,
    ]);
    await closedAsDone(o, caseys.id, entry.id);
    auditedOnce("sessions.revoke", entry.id, o.caseyId);
  });

  it("an Apply that would end the office's last owner session refuses (409 would_strand_office), ends nothing, and the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const second = await signInWithPrefix(o, o.morganName);
    const entry = await opened(
      o,
      asker.id,
      sessionRevokeStep(o.morganName, second.prefix),
    );
    // Morgan signs out where the ask opened: the other session is now the
    // office's last owner session, and Morgan applies from it.
    expect(
      (await asSession(o, o.morgan, "DELETE", "/api/sessions/current")).status,
    ).toBe(204);
    const res = await run(o, second.session, entry.id);
    expect(outcome(res)).toEqual(refused(409, "would_strand_office"));
    expect(await alive(o, second.session)).toBe(true);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("the session revoked by hand closes it while the member keeps another session", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const curl = await signInWithPrefix(o, o.caseyName, "curl/8.5.0");
    const entry = await opened(
      o,
      asker.id,
      sessionRevokeStep(o.caseyName, curl.prefix),
    );
    expect(
      (await asSession(o, o.morgan, "DELETE", `/api/sessions/${curl.prefix}`))
        .status,
    ).toBe(204);
    await closedAsDone(o, asker.id, entry.id);
    expect(await alive(o, o.casey)).toBe(true);
  });
});

describe("office-access asks", () => {
  it("opens for an owner with the address as the save stores it, and runs nothing", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(
      o,
      asker.id,
      accessStep(true, " https://Office.Example/ "),
    );
    expect([entry.step, entry.link]).toEqual([
      {
        kind: "office-access",
        externalAccess: true,
        publicOrigin: "https://office.example",
      },
      undefined,
    ]);
    const now = await asSession(o, o.morgan, "GET", "/api/office/access");
    expect((now.body as AccessSettings).externalAccess).toBe(false);
  });

  it("refuses a member (403), an address the save refuses and an enable with no address (400), and the settings the office has (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect(
      outcome(
        await ask(o, caseys.id, accessStep(true, "https://office.example")),
      ),
    ).toEqual(refused(403, "member_not_allowed"));
    for (const step of [
      accessStep(true, "http://office.example"),
      accessStep(true, "https://office.example/path"),
      accessStep(true, ""),
      { kind: "office-access", externalAccess: "yes", publicOrigin: "" },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
    expect(outcome(await ask(o, asker.id, accessStep(false, "")))).toEqual(
      refused(409, "step_done"),
    );
  });

  it("refuses any change on a hosted office with the save's own answer (403 hosted_access_managed)", async () => {
    const o = await office({ startServer: { installKind: "hosted" } });
    const asker = await spawn(o, "Asker");
    expect(
      outcome(
        await ask(o, asker.id, accessStep(true, "https://office.example")),
      ),
    ).toEqual(refused(403, "hosted_access_managed"));
  });

  it("Apply saves with the owner's session: the sign-in link for the new address is in the run's answer, the ask closes, one office.setAccess row names the ask, and the link is in nothing the agent reads or the server stores", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(
      o,
      asker.id,
      accessStep(true, "https://office.example"),
    );
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    const body = res.body as { signInUrl: string; restartRequired: boolean };
    expect(body.restartRequired).toBe(true);
    expect(body.signInUrl.startsWith("https://office.example/i/")).toBe(true);
    const raw = linkToken(body.signInUrl);
    const now = await asSession(o, o.morgan, "GET", "/api/office/access");
    expect(now.body as AccessSettings).toMatchObject({
      externalAccess: true,
      publicOrigin: "https://office.example",
    });
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    auditedOnce("office.setAccess", entry.id, o.morganId);
    const seen = await agentView(o, asker.id, entry.id);
    expect(seen.includes(raw)).toBe(false);
    expect(await storedWith(raw)).toEqual([]);
  });

  it("a save by hand closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(
      o,
      asker.id,
      accessStep(true, "https://office.example"),
    );
    const saved = await asSession(o, o.morgan, "PUT", "/api/office/access", {
      externalAccess: true,
      publicOrigin: "https://office.example",
    });
    expect(saved.status).toBe(200);
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("credential asks from /mcp", () => {
  it("open_ask takes each part 4 kind", async () => {
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
    const caseyToken = await mintToken(o, o.casey, "laptop");
    const [caseyPrefix] = await sessionPrefixes(o, o.caseyId);
    await asSession(o, o.morgan, "POST", "/api/invites", { userId: o.caseyId });
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
        signInLinkStep(o.caseyName),
        { kind: "sign-in-link", userId: o.caseyId },
      ],
      [
        sessionsStep(o.caseyName),
        { kind: "member-sessions", userId: o.caseyId },
      ],
      [
        linksRevokeStep(o.caseyName),
        { kind: "sign-in-links-revoke", userId: o.caseyId },
      ],
      [
        sessionRevokeStep(o.caseyName, caseyPrefix),
        {
          kind: "session-revoke",
          userId: o.caseyId,
          sessionPrefix: caseyPrefix,
        },
      ],
      [tokenStep("deploy"), tokenStep("deploy")],
      [
        tokenRevokeStep(caseyToken.id),
        { ...tokenRevokeStep(caseyToken.id), userId: o.caseyId },
      ],
      [
        accessStep(true, "https://office.example"),
        accessStep(true, "https://office.example"),
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
      expect(entry.step as unknown).toEqual(stored);
    }
  });
});
