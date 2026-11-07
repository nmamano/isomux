// Enterprise seats, the office side (task 8b80e61f; contract in task
// 71718489): an office whose owner checks the Enterprise Contract box and
// pastes the account's secret asks the seat service before each member add,
// releases a seat after a removal, and checks in. The service here is a real
// HTTP server on a free port, so the office's real request path (headers,
// redirects, timeout, body) is under test.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintMemberLink } from "./member-link.ts";
import { _testMintLegacyInvite } from "../auth.ts";
import { getUserByName, listUsers } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { FakeBackend } from "./fake-backend.ts";
import type { EnterpriseViewRes } from "../../shared/contract-shapes.ts";

interface SeatCall {
  auth: string | null;
  body: { office: string; members: number; add: boolean };
}

type Respond = (call: SeatCall) => Response | Promise<Response>;

const ANSWER = {
  company: "Acme Corp",
  kind: "standard",
  seats: 18,
  inUse: 7,
  offices: 3,
} as const;

const ok = (answer: object = ANSWER) => Response.json(answer);
const refuse = (status: number, body: object) =>
  Response.json(body, { status });
const hang = () => new Promise<Response>(() => {});

// A seat service that records every call and answers with `respond`.
function fakeSeatService() {
  const calls: SeatCall[] = [];
  let respond: Respond = () => ok();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const call: SeatCall = {
        auth: req.headers.get("authorization"),
        body: (await req.json()) as SeatCall["body"],
      };
      calls.push(call);
      return respond(call);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/api/enterprise/v1/seats`,
    calls,
    respond(fn: Respond) {
      respond = fn;
    },
    stop: () => server.stop(true),
  };
}

let server: TestServer | null = null;
let service: ReturnType<typeof fakeSeatService> | null = null;
const extraServices: { stop: () => unknown }[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  service?.stop();
  service = null;
  for (const s of extraServices.splice(0)) s.stop();
});

const startServerOpts: {
  enterpriseSeats?: { url?: string; timeoutMs?: number };
  installKind?: "hosted" | "self-hosted";
} = {};

async function boot(timeoutMs = 300, fakeBackend?: FakeBackend) {
  service = fakeSeatService();
  startServerOpts.enterpriseSeats = { url: service.url, timeoutMs };
  startServerOpts.installKind = "self-hosted";
  const srv = (server = await startTestServer({
    startServer: startServerOpts,
    fakeBackend,
  }));
  const owner = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  return { srv, svc: service, owner, mia };
}

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: { method?: string; body?: unknown; rawSessionId?: string } = {},
): Promise<Res> {
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers:
      init.body !== undefined ? { "Content-Type": "application/json" } : {},
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errOf = (r: Res) =>
  (r.body as { error?: { code?: string; message?: string } })?.error ?? {};
const viewOf = (r: Res) => r.body as EnterpriseViewRes;

const getView = (srv: TestServer, sid: string) =>
  api(srv, "/api/office/enterprise", { rawSessionId: sid });
const setEnabled = (srv: TestServer, sid: string, enabled: boolean) =>
  api(srv, "/api/office/enterprise", {
    method: "PUT",
    rawSessionId: sid,
    body: { enabled },
  });
const paste = (srv: TestServer, sid: string, secret: string) =>
  api(srv, "/api/office/enterprise/secret", {
    method: "POST",
    rawSessionId: sid,
    body: { secret },
  });
const check = (srv: TestServer, sid: string) =>
  api(srv, "/api/office/enterprise/check", {
    method: "POST",
    rawSessionId: sid,
  });
const createMember = (srv: TestServer, sid: string, name: string) =>
  api(srv, "/api/users", {
    method: "POST",
    rawSessionId: sid,
    body: { name, role: "member" },
  });

// Box on and SECRET accepted.
const SECRET = "isx_ent_1_goodmac";
async function connect(srv: TestServer, sid: string, secret = SECRET) {
  expect((await setEnabled(srv, sid, true)).status).toBe(200);
  const r = await paste(srv, sid, secret);
  expect(r.status).toBe(200);
  expect(viewOf(r).locked).toBe(false);
}

async function until(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// Every file under the state root that holds `needle`.
function filesHolding(root: string, needle: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => {
      try {
        return readFileSync(path, "utf8").includes(needle);
      } catch {
        return false;
      }
    });
}

// The lock is the server's refusal of messages to agents (task f1304a60):
// the UI gets no lock state and no lock event.
const officeOf = async (ws: Awaited<ReturnType<TestServer["connectWs"]>>) =>
  ((await ws.waitFor("full_state")) as { office: Record<string, unknown> })
    .office;
const lockEventCount = (messages: unknown[]) =>
  (messages as { type: string }[]).filter(
    (m) => m.type === "office_enterprise_lock",
  ).length;

const HEX32 = /^[0-9a-f]{32}$/;

describe("the Enterprise Contract box and its secret", () => {
  it("is locked from the check until a secret is accepted, and sends the UI no lock state", async () => {
    const { srv, svc, owner, mia } = await boot();
    const miaWs = await srv.connectWs(mia.rawSessionId);
    expect(Object.keys(await officeOf(miaWs))).not.toContain(
      "enterpriseLocked",
    );

    const on = await setEnabled(srv, owner.rawSessionId, true);
    expect([on.status, viewOf(on)]).toEqual([
      200,
      {
        available: true,
        enabled: true,
        locked: true,
        connected: null,
        problem: null,
      },
    ]);
    const lateWs = await srv.connectWs(mia.rawSessionId);
    expect(Object.keys(await officeOf(lateWs))).not.toContain(
      "enterpriseLocked",
    );

    // No secret to ask with: the office adds nobody while locked.
    const add = await createMember(srv, owner.rawSessionId, "Owen");
    expect([add.status, errOf(add).code]).toEqual([
      409,
      "enterprise_secret_needed",
    ]);
    expect(getUserByName("Owen")).toBeUndefined();
    expect(svc.calls).toHaveLength(0);

    // The pasted secret is trimmed; the first join is add=false with the
    // office's member count.
    const joined = await paste(srv, owner.rawSessionId, `  ${SECRET}  `);
    expect(joined.status).toBe(200);
    const view = viewOf(joined);
    expect(view).toMatchObject({
      available: true,
      enabled: true,
      locked: false,
      problem: null,
      connected: ANSWER,
    });
    expect(typeof view.connected?.checkedAt).toBe("number");
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].auth).toBe(`Bearer ${SECRET}`);
    expect(svc.calls[0].body).toEqual({
      office: expect.stringMatching(HEX32),
      members: 2,
      add: false,
    });
    // No lock event went out for the lock or the unlock: an add after them
    // reaches Mia's socket, and nothing about the lock came before it.
    const usersLists = () =>
      (miaWs.messages as { type: string }[]).filter(
        (m) => m.type === "users_list",
      ).length;
    const listsBefore = usersLists();
    expect((await createMember(srv, owner.rawSessionId, "Owen")).status).toBe(
      201,
    );
    await until(() => usersLists() > listsBefore, "users_list after the add");
    expect(lockEventCount(miaWs.messages)).toBe(0);

    // Owner-only, and the secret never comes back.
    expect((await getView(srv, mia.rawSessionId)).status).toBe(403);
    const read = await getView(srv, owner.rawSessionId);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain("goodmac");
    // One file holds it, readable by the office user only.
    const holders = filesHolding(srv.stateRoot, SECRET);
    expect(holders).toHaveLength(1);
    expect(statSync(holders[0]).mode & 0o777).toBe(0o600);
    miaWs.close();
    lateWs.close();
  });

  it("stores nothing and keeps the lock when the service refuses a pasted secret", async () => {
    const { srv, svc, owner } = await boot();
    await setEnabled(srv, owner.rawSessionId, true);
    const cases = [
      [400, { error: "bad_request" }, 502, "enterprise_bad_request"],
      [401, { error: "bad_secret" }, 403, "enterprise_secret_rejected"],
      [403, { error: "not_signed" }, 403, "enterprise_not_signed"],
      [429, { error: "rate_limited" }, 429, "enterprise_rate_limited"],
    ] as const;
    for (const [i, [status, body, want, code]] of cases.entries()) {
      svc.respond(() => refuse(status, body));
      const secret = `isx_ent_1_refused${i}`;
      const r = await paste(srv, owner.rawSessionId, secret);
      expect([status, r.status, errOf(r).code]).toEqual([status, want, code]);
      expect(svc.calls.at(-1)?.auth).toBe(`Bearer ${secret}`);
      expect(viewOf(await getView(srv, owner.rawSessionId))).toMatchObject({
        enabled: true,
        locked: true,
        connected: null,
      });
      expect(filesHolding(srv.stateRoot, secret)).toEqual([]);
    }
    expect(svc.calls).toHaveLength(cases.length);
  });

  it("does not accept a secret the service could not judge", async () => {
    const { srv, svc, owner } = await boot();
    // A redirect would carry the bearer to another host: the office does not
    // follow it.
    const elsewhere = fakeSeatService();
    extraServices.push(elsewhere);
    await setEnabled(srv, owner.rawSessionId, true);
    const cases: [string, Respond][] = [
      ["5xx", () => refuse(503, { error: "down" })],
      ["bad body", () => ok({ company: "Acme Corp" })],
      ["timeout", hang],
      [
        "redirect",
        () =>
          new Response(null, {
            status: 307,
            headers: { location: elsewhere.url },
          }),
      ],
    ];
    for (const [name, respond] of cases) {
      svc.respond(respond);
      const before = svc.calls.length;
      const r = await paste(srv, owner.rawSessionId, SECRET);
      expect([name, r.status, errOf(r).code]).toEqual([
        name,
        503,
        "enterprise_unreachable",
      ]);
      expect(svc.calls.length).toBe(before + 1);
      expect(viewOf(await getView(srv, owner.rawSessionId))).toMatchObject({
        locked: true,
        connected: null,
      });
    }
    expect(elsewhere.calls).toHaveLength(0);
    expect(filesHolding(srv.stateRoot, SECRET)).toEqual([]);
  });

  it("refuses a secret that cannot go in a header before it calls the service", async () => {
    const { srv, svc, owner } = await boot();
    await setEnabled(srv, owner.rawSessionId, true);
    for (const bad of [
      "isx_ent_1 inner",
      "isx_ent_1\nnext",
      "isx_ent_1\u0007bell",
      "isx_ent_1_é",
      "x".repeat(513),
    ]) {
      const r = await paste(srv, owner.rawSessionId, bad);
      expect([JSON.stringify(bad), r.status, errOf(r).code]).toEqual([
        JSON.stringify(bad),
        400,
        "invalid_secret",
      ]);
    }
    expect(svc.calls).toHaveLength(0);
    // 512 characters is still sent.
    const longest = "x".repeat(512);
    expect((await paste(srv, owner.rawSessionId, longest)).status).toBe(200);
    expect(svc.calls.map((c) => c.auth)).toEqual([`Bearer ${longest}`]);
  });

  it("replaces an accepted secret only when the service accepts the new one", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const office = svc.calls[0].body.office;

    svc.respond(() => refuse(401, { error: "bad_secret" }));
    const refused = await paste(srv, owner.rawSessionId, "isx_ent_1_typo");
    expect([refused.status, errOf(refused).code]).toEqual([
      403,
      "enterprise_secret_rejected",
    ]);
    svc.respond(() => refuse(503, { error: "down" }));
    expect(
      (await paste(srv, owner.rawSessionId, "isx_ent_1_outage")).status,
    ).toBe(503);
    svc.respond(() => ok());
    const kept = await check(srv, owner.rawSessionId);
    expect(viewOf(kept)).toMatchObject({ locked: false, connected: ANSWER });
    expect(svc.calls.at(-1)?.auth).toBe(`Bearer ${SECRET}`);

    expect((await paste(srv, owner.rawSessionId, "isx_ent_1_new")).status).toBe(
      200,
    );
    await check(srv, owner.rawSessionId);
    expect(svc.calls.at(-1)?.auth).toBe("Bearer isx_ent_1_new");
    expect(new Set(svc.calls.map((c) => c.body.office))).toEqual(
      new Set([office]),
    );
    expect(filesHolding(srv.stateRoot, SECRET)).toEqual([]);
  });

  it("frees the office's seats and forgets the secret when the box is unchecked", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const office = svc.calls[0].body.office;

    const off = await setEnabled(srv, owner.rawSessionId, false);
    expect([off.status, viewOf(off)]).toEqual([
      200,
      {
        available: true,
        enabled: false,
        locked: false,
        connected: null,
        problem: null,
      },
    ]);
    expect(svc.calls.at(-1)).toEqual({
      auth: `Bearer ${SECRET}`,
      body: { office, members: 0, add: false },
    });
    expect(filesHolding(srv.stateRoot, SECRET)).toEqual([]);
    // Box off: adds make no seat call.
    const calls = svc.calls.length;
    expect((await createMember(srv, owner.rawSessionId, "Owen")).status).toBe(
      201,
    );
    expect((await check(srv, owner.rawSessionId)).status).toBe(200);
    expect(svc.calls).toHaveLength(calls);

    // Back on: locked again, and the office keeps its id.
    expect(viewOf(await setEnabled(srv, owner.rawSessionId, true)).locked).toBe(
      true,
    );
    await connect(srv, owner.rawSessionId, "isx_ent_1_second");
    expect(svc.calls.at(-1)?.body.office).toBe(office);

    // An outage does not stop the uncheck.
    svc.respond(() => refuse(503, { error: "down" }));
    const offDown = await setEnabled(srv, owner.rawSessionId, false);
    expect([offDown.status, viewOf(offDown).enabled]).toEqual([200, false]);
    expect(svc.calls.at(-1)?.body).toEqual({ office, members: 0, add: false });
  });
});

// While locked, the office runs as usual, but nobody texts an agent
// (task f1304a60; Nil at sign-off, 2026-11-07). The routes that take the
// refusal are pinned in routes-table.test.ts; these cases drive it end to end.
describe("while locked, nobody texts an agent", () => {
  // Every turn ends at once, so each message reaches the backend.
  const quickBackend = () =>
    new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });

  async function spawnAgent(
    srv: TestServer,
    name: string,
    ownerName: string,
    agentType: "claude" | "opencode" = "claude",
  ) {
    const [room] = srv.agentManager.getRooms();
    const info = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      agentType === "opencode" ? "gate/gate-model" : undefined,
      undefined,
      undefined,
      agentType,
      undefined,
      getUserByName(ownerName)!.id,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  }

  async function post(
    srv: TestServer,
    path: string,
    auth: { rawSessionId?: string; bearer?: string },
    body: { json?: unknown; text?: string },
  ): Promise<Res> {
    const headers: Record<string, string> = {
      "Content-Type":
        body.text !== undefined ? "text/plain" : "application/json",
    };
    if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
    const res = await srv.http(path, {
      method: "POST",
      headers,
      rawSessionId: auth.rawSessionId,
      body: body.text ?? JSON.stringify(body.json),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  const sentTo = (srv: TestServer, agentId: string) =>
    srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === agentId)
      .flatMap((s) => s.sent.map((m) => m.text));

  // The refusal: 409, the locked code, and a message for the sender.
  const refused = (r: Res) => {
    const e = errOf(r);
    return [
      r.status,
      e.code,
      typeof e.message === "string" && e.message.length > 0,
    ];
  };
  const LOCKED = [409, "enterprise_secret_needed", true];

  it("refuses a member's message, an agent's message and an ask reply, and takes them with the box off or a secret accepted", async () => {
    const { srv, owner } = await boot(300, quickBackend());
    const ada = await spawnAgent(srv, "Ada", owner.username);
    const bob = await spawnAgent(srv, "Bob", owner.username);
    const member = { rawSessionId: owner.rawSessionId };
    const bobToken = { bearer: getAgentTokenRaw(bob.id)! };
    const toAda = `/api/agents/${ada.id}/messages`;

    expect(viewOf(await setEnabled(srv, owner.rawSessionId, true)).locked).toBe(
      true,
    );
    expect(
      refused(await post(srv, toAda, member, { json: { text: "m1" } })),
    ).toEqual(LOCKED);
    expect(
      refused(await post(srv, toAda, bobToken, { json: { text: "b1" } })),
    ).toEqual(LOCKED);
    // An agent still opens an ask for its member; the member's reply is
    // the message that is refused.
    const opened = await post(
      srv,
      `/api/agents/${ada.id}/asks`,
      { bearer: getAgentTokenRaw(ada.id)! },
      { text: "Ship it?\n" },
    );
    expect(opened.status).toBe(201);
    const askId = (opened.body as { id: string }).id;
    const reply = (text: string) =>
      post(srv, `/api/asks/${askId}/reply`, member, { json: { text } });
    expect(refused(await reply("r1"))).toEqual(LOCKED);
    await Bun.sleep(50);
    expect(sentTo(srv, ada.id).filter((t) => /\b(m1|b1|r1)\b/.test(t))).toEqual(
      [],
    );

    // Box off: messages go through.
    expect(
      viewOf(await setEnabled(srv, owner.rawSessionId, false)).locked,
    ).toBe(false);
    expect(
      (await post(srv, toAda, member, { json: { text: "m2" } })).status,
    ).toBe(200);
    await until(() => sentTo(srv, ada.id).some((t) => t.includes("m2")), "m2");

    // On again: locked again until the secret is accepted.
    expect(viewOf(await setEnabled(srv, owner.rawSessionId, true)).locked).toBe(
      true,
    );
    expect(
      refused(await post(srv, toAda, member, { json: { text: "m3" } })),
    ).toEqual(LOCKED);
    const joined = await paste(srv, owner.rawSessionId, SECRET);
    expect([joined.status, viewOf(joined).locked]).toEqual([200, false]);
    expect(
      (await post(srv, toAda, member, { json: { text: "m4" } })).status,
    ).toBe(200);
    expect(
      (await post(srv, toAda, bobToken, { json: { text: "b4" } })).status,
    ).toBe(200);
    const replied = await reply("r4");
    expect(replied.status).toBeLessThan(300);
    await until(
      () =>
        ["m4", "b4", "r4"].every((w) =>
          sentTo(srv, ada.id).some((t) => t.includes(w)),
        ),
      "m4, b4 and r4 at Ada",
    );
    expect(sentTo(srv, ada.id).some((t) => t.includes("m3"))).toBe(false);
  });

  it("takes the answer to a running turn's permission prompt", async () => {
    // A turn that stays open until the test ends it.
    const { srv, owner } = await boot(
      300,
      new FakeBackend({
        session: {
          onSend: (_t, _a, s) =>
            s.push({ kind: "assistant_text", text: "..." }),
        },
      }),
    );
    const ada = await spawnAgent(srv, "Ada", owner.username, "opencode");
    const other = await spawnAgent(srv, "Other", owner.username);
    const member = { rawSessionId: owner.rawSessionId };
    expect(
      (
        await post(srv, `/api/agents/${ada.id}/messages`, member, {
          json: { text: "run something" },
        })
      ).status,
    ).toBe(200);
    const agentOf = () =>
      srv.agentManager.getAllAgents().find((a) => a.id === ada.id)!;
    await until(() => agentOf().state === "thinking", "Ada's turn");
    srv.fakeBackend.sessionForAgent(ada.id)!.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "Ada wants to use Bash",
    });
    await until(
      () => agentOf().pendingPrompt === "permission",
      "Ada parked on a permission prompt",
    );

    expect(viewOf(await setEnabled(srv, owner.rawSessionId, true)).locked).toBe(
      true,
    );
    // Locked: a message that answers no prompt is refused...
    expect(
      refused(
        await post(srv, `/api/agents/${other.id}/messages`, member, {
          json: { text: "hello" },
        }),
      ),
    ).toEqual(LOCKED);
    // ...and so is an agent's message to Ada: only a member answers her prompt...
    expect(
      refused(
        await post(
          srv,
          `/api/agents/${ada.id}/messages`,
          { bearer: getAgentTokenRaw(other.id)! },
          { json: { text: "from other" } },
        ),
      ),
    ).toEqual(LOCKED);
    // ...and the member's answer to Ada's prompt goes through to the running turn.
    const answer = await post(srv, `/api/agents/${ada.id}/messages`, member, {
      json: { text: "no, use grep instead" },
    });
    expect(answer.status).toBe(200);
    const session = srv.fakeBackend.sessionForAgent(ada.id)!;
    await until(() => session.approvals.length === 1, "the answer");
    expect(session.approvals).toEqual([
      {
        approvalId: "ap-1",
        decision: { kind: "deny", reason: "no, use grep instead" },
      },
    ]);
  });
});

describe("member adds take a seat first", () => {
  it("asks with the count after the add and adds the member on a 200 or an outage", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);

    const r = await createMember(srv, owner.rawSessionId, "Owen");
    expect(r.status).toBe(201);
    expect(svc.calls.at(-1)).toEqual({
      auth: `Bearer ${SECRET}`,
      body: { office: expect.stringMatching(HEX32), members: 3, add: true },
    });

    // Our outage never blocks a customer.
    for (const [name, respond] of [
      ["5xx", () => refuse(500, { error: "boom" })],
      ["timeout", hang],
    ] as [string, Respond][]) {
      svc.respond(respond);
      const before = svc.calls.length;
      const add = await createMember(srv, owner.rawSessionId, `Outage ${name}`);
      expect([name, add.status]).toEqual([name, 201]);
      expect(svc.calls.length).toBe(before + 1);
      expect(svc.calls.at(-1)?.body.add).toBe(true);
    }
    expect(listUsers()).toHaveLength(5);
  });

  it("adds nobody when the service refuses, and says why", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);

    svc.respond(() =>
      refuse(409, { error: "seats_full", seats: 18, inUse: 19 }),
    );
    const full = await createMember(srv, owner.rawSessionId, "Owen");
    expect([full.status, errOf(full).code]).toEqual([409, "seats_full"]);
    // The message names the account's seats and the seats in use.
    expect(errOf(full).message).toContain("18");
    expect(errOf(full).message).toContain("19");
    expect(svc.calls.at(-1)?.body).toMatchObject({ members: 3, add: true });

    // A name the office refuses anyway costs no seat call, so a full account
    // never hides the real reason.
    const calls = svc.calls.length;
    const taken = await createMember(srv, owner.rawSessionId, "mia");
    expect([taken.status, errOf(taken).code]).toEqual([409, "name_taken"]);
    const invalid = await createMember(srv, owner.rawSessionId, "Bad<Name>");
    expect([invalid.status, errOf(invalid).code]).toEqual([
      400,
      "invalid_name",
    ]);
    expect(svc.calls).toHaveLength(calls);

    const cases = [
      [429, "rate_limited", 429, "enterprise_rate_limited", null],
      [400, "bad_request", 502, "enterprise_bad_request", undefined],
      [401, "bad_secret", 403, "enterprise_secret_rejected", "bad_secret"],
      [403, "not_signed", 403, "enterprise_not_signed", "not_signed"],
    ] as const;
    for (const [status, error, want, code, problem] of cases) {
      svc.respond(() => refuse(status, { error }));
      const r = await createMember(srv, owner.rawSessionId, "Owen");
      expect([error, r.status, errOf(r).code]).toEqual([error, want, code]);
      const view = viewOf(await getView(srv, owner.rawSessionId));
      // A refused add never locks the office.
      expect(view.locked).toBe(false);
      // seats_full and rate_limited answer that one request; a refused
      // secret or account shows in Settings.
      if (problem !== undefined)
        expect([error, view.problem]).toEqual([error, problem]);
    }
    expect(getUserByName("Owen")).toBeUndefined();

    svc.respond(() => ok());
    expect((await createMember(srv, owner.rawSessionId, "Owen")).status).toBe(
      201,
    );
    expect(viewOf(await getView(srv, owner.rawSessionId)).problem).toBeNull();
  });

  it("sends one seat call at a time, each with the count the add before it left", async () => {
    const { srv, svc, owner } = await boot(2000);
    await connect(srv, owner.rawSessionId);
    // The office's member count when each add call arrived. The first add
    // is slow, so a second call that does not wait for it arrives early.
    const present: number[] = [];
    svc.respond(async (call) => {
      if (!call.body.add) return ok();
      present.push(listUsers().length);
      if (present.length === 1) await Bun.sleep(150);
      return ok();
    });
    const [a, b] = await Promise.all([
      createMember(srv, owner.rawSessionId, "Ada"),
      createMember(srv, owner.rawSessionId, "Bea"),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const adds = svc.calls.filter((c) => c.body.add);
    expect(adds.map((c) => c.body.members)).toEqual([3, 4]);
    // The second call left only after the first member was added.
    expect(present).toEqual([2, 3]);
  });

  it("a release waits for a seat call in flight and sends the count at send time", async () => {
    const { srv, svc, owner } = await boot(2000);
    await connect(srv, owner.rawSessionId);
    let releaseAdd!: () => void;
    const held = new Promise<void>((r) => (releaseAdd = r));
    svc.respond(async (call) => {
      if (call.body.add) await held;
      return ok();
    });
    const adding = createMember(srv, owner.rawSessionId, "Ada");
    await until(() => svc.calls.some((c) => c.body.add), "the add call");
    const removed = await api(srv, "/api/users/Mia", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(removed.status).toBe(204);
    // Give a release that skipped the queue time to arrive.
    await Bun.sleep(100);
    releaseAdd();
    expect((await adding).status).toBe(201);
    await until(
      () => svc.calls.filter((c) => !c.body.add).length === 2,
      "the release",
    );
    // join, add (Morgan + Mia + Ada), release (Morgan + Ada).
    expect(svc.calls.map((c) => [c.body.add, c.body.members])).toEqual([
      [false, 2],
      [true, 3],
      [false, 2],
    ]);
  });

  it("a removal releases the seat with the new count", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const r = await api(srv, "/api/users/Mia", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(204);
    await until(() => svc.calls.length === 2, "the release");
    expect(svc.calls[1]).toEqual({
      auth: `Bearer ${SECRET}`,
      body: { office: svc.calls[0].body.office, members: 1, add: false },
    });
  });

  it("a restore from Removed members takes a seat", async () => {
    const { srv, svc, owner } = await boot();
    const miaId = getUserByName("Mia")!.id;
    await connect(srv, owner.rawSessionId);
    await api(srv, "/api/users/Mia", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    await until(() => svc.calls.length === 2, "the release");

    svc.respond(() =>
      refuse(409, { error: "seats_full", seats: 18, inUse: 18 }),
    );
    const restore = () =>
      api(srv, `/api/removed-members/${miaId}/restore`, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: {},
      });
    const full = await restore();
    expect([full.status, errOf(full).code]).toEqual([409, "seats_full"]);
    expect(getUserByName("Mia")).toBeUndefined();
    expect(svc.calls.at(-1)?.body).toMatchObject({ members: 2, add: true });

    svc.respond(() => ok());
    expect((await restore()).status).toBe(200);
    expect(getUserByName("Mia")?.id).toBe(miaId);
    expect(svc.calls.at(-1)?.body).toMatchObject({ members: 2, add: true });
  });

  it("a legacy new-member invite takes a seat at accept; a created member's first sign-in does not", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const accept = (token: string, name?: string) =>
      srv.http("/auth/accept", {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ token, ...(name ? { name } : {}) }),
      });

    // A created member's seat was taken at the create.
    expect((await createMember(srv, owner.rawSessionId, "Marc")).status).toBe(
      201,
    );
    const calls = svc.calls.length;
    const link = await mintMemberLink("Marc");
    expect((await accept(link.rawToken)).status).toBe(302);
    expect(svc.calls).toHaveLength(calls);

    const legacy = await _testMintLegacyInvite({
      username: null,
      role: "member",
      createdBy: "Morgan",
    });
    svc.respond(() =>
      refuse(409, { error: "seats_full", seats: 18, inUse: 18 }),
    );
    const full = await accept(legacy.rawToken, "Lena");
    expect(full.status).toBeGreaterThanOrEqual(400);
    expect(full.headers.get("set-cookie") ?? "").toBe("");
    expect(getUserByName("Lena")).toBeUndefined();
    expect(svc.calls.at(-1)?.body).toMatchObject({ members: 4, add: true });

    // An accept that fails (the name is taken) leaves the service with the
    // office's real count: either no call, or the add and then a release.
    svc.respond(() => ok());
    const before = svc.calls.length;
    const taken = await accept(legacy.rawToken, "Morgan");
    expect(taken.status).toBe(400);
    await Bun.sleep(100);
    const after = svc.calls.slice(before).map((c) => c.body);
    if (after.length > 0)
      expect(after).toEqual([
        { office: expect.stringMatching(HEX32), members: 4, add: true },
        { office: expect.stringMatching(HEX32), members: 3, add: false },
      ]);
    expect(listUsers()).toHaveLength(3);

    const second = await _testMintLegacyInvite({
      username: null,
      role: "member",
      createdBy: "Morgan",
    });
    expect((await accept(second.rawToken, "Lena")).status).toBe(302);
    expect(getUserByName("Lena")).toBeDefined();
    expect(svc.calls.at(-1)?.body).toMatchObject({ members: 4, add: true });
  });
});

describe("check-in", () => {
  it("reports the account's count and shows a refusal or an outage without locking anyone out", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const later = { ...ANSWER, seats: 20, inUse: 9, offices: 4 };
    svc.respond(() => ok(later));
    const fresh = await check(srv, owner.rawSessionId);
    expect(fresh.status).toBe(200);
    expect(viewOf(fresh)).toMatchObject({ connected: later, problem: null });
    expect(svc.calls.at(-1)).toEqual({
      auth: `Bearer ${SECRET}`,
      body: { office: svc.calls[0].body.office, members: 2, add: false },
    });

    for (const [name, respond, problem] of [
      [
        "new AUTH_SECRET",
        () => refuse(401, { error: "bad_secret" }),
        "bad_secret",
      ],
      ["not signed", () => refuse(403, { error: "not_signed" }), "not_signed"],
      ["5xx", () => refuse(502, { error: "down" }), "unreachable"],
      ["timeout", hang, "unreachable"],
    ] as [string, Respond, string][]) {
      svc.respond(respond);
      const r = await check(srv, owner.rawSessionId);
      expect([name, r.status, viewOf(r).problem, viewOf(r).locked]).toEqual([
        name,
        200,
        problem,
        false,
      ]);
      // Settings keeps the last count it had.
      expect(viewOf(r).connected).toMatchObject(later);
    }

    svc.respond(() => ok());
    expect(viewOf(await check(srv, owner.rawSessionId))).toMatchObject({
      connected: ANSWER,
      problem: null,
    });
  });

  it("makes no call while the box is on and no secret was accepted", async () => {
    const { srv, svc, owner } = await boot();
    await setEnabled(srv, owner.rawSessionId, true);
    const r = await check(srv, owner.rawSessionId);
    expect([r.status, viewOf(r).locked, viewOf(r).connected]).toEqual([
      200,
      true,
      null,
    ]);
    expect(svc.calls).toHaveLength(0);
  });
});

describe("across a restart", () => {
  it("keeps the connection, the secret and the office id", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const office = svc.calls[0].body.office;

    const again = (server = await srv.restart());
    const view = viewOf(await getView(again, owner.rawSessionId));
    expect(view).toMatchObject({
      enabled: true,
      locked: false,
      connected: ANSWER,
    });
    await check(again, owner.rawSessionId);
    expect(svc.calls.at(-1)).toEqual({
      auth: `Bearer ${SECRET}`,
      body: { office, members: 2, add: false },
    });
  });

  it("asks for the current secret when the secret file is gone, and locks nobody out", async () => {
    const { srv, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    const [holder] = filesHolding(srv.stateRoot, SECRET);
    rmSync(holder);
    const again = (server = await srv.restart());
    expect(viewOf(await getView(again, owner.rawSessionId))).toMatchObject({
      enabled: true,
      locked: false,
      problem: "bad_secret",
    });
  });

  it("boots with a damaged state file and reads it as off", async () => {
    const { srv, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    writeFileSync(join(srv.stateRoot, "enterprise-seats.json"), "{not json");
    const again = (server = await srv.restart());
    const r = await getView(again, owner.rawSessionId);
    expect([r.status, viewOf(r).enabled, viewOf(r).locked]).toEqual([
      200,
      false,
      false,
    ]);
  });
});

describe("Hosted", () => {
  it("shows no section, refuses the writes, and makes no seat call even with a connected state", async () => {
    const { srv, svc, owner } = await boot();
    await connect(srv, owner.rawSessionId);
    // The same state on a Hosted box (a backup restored there).
    startServerOpts.installKind = "hosted";
    const hosted = (server = await srv.restart());
    const calls = svc.calls.length;

    const view = await getView(hosted, owner.rawSessionId);
    expect([view.status, viewOf(view).available]).toEqual([200, false]);
    expect(viewOf(view).locked).toBe(false);
    for (const r of [
      await setEnabled(hosted, owner.rawSessionId, true),
      await paste(hosted, owner.rawSessionId, SECRET),
    ])
      expect([r.status, errOf(r).code]).toEqual([403, "hosted"]);

    expect(
      (await createMember(hosted, owner.rawSessionId, "Owen")).status,
    ).toBe(201);
    await check(hosted, owner.rawSessionId);
    expect(svc.calls).toHaveLength(calls);
  });
});
