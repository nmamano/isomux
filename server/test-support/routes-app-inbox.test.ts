// An app its owner lets into their Inbox (task 4a1e58c9, for Antifeed): the
// app lists and answers the open asks addressed to its owner, reads the files
// of those asks, and reads and acks the pages addressed to the owner. Only the
// owner turns the switch on; it holds only while the app's owner agent is live
// and managed by that owner.
//
// The whole-table reach of app:inbox is in routes-table.test.ts; this file pins
// what only a real server shows: the live record, the ask store both callers
// close, the message the agent reads, the audit row and the file bytes.
// FakeBackend and the harness's fake supervisor. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import { officeAuditStore } from "../audit-store.ts";
import type {
  AgentInfo,
  AppWire,
  AskEntry,
  PagerEntry,
  TaskItem,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Auth = { bearer: string } | { rawSessionId: string };
type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  body?: { json?: unknown; text?: string },
): Promise<Res> {
  const headers: Record<string, string> = {};
  if ("bearer" in auth) headers["Authorization"] = `Bearer ${auth.bearer}`;
  let payload: string | undefined;
  if (body?.text !== undefined) {
    headers["Content-Type"] = "text/plain";
    payload = body.text;
  } else if (body?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  const res = await srv.http(path, {
    method,
    headers,
    body: payload,
    ...("rawSessionId" in auth ? { rawSessionId: auth.rawSessionId } : {}),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

// Every turn completes at once.
function backend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 2, 0]);

// Owner Nil (an office owner who is not the app's owner); members Mara and
// Pat, each with room A. Mara manages Builder (which registers app "feed")
// and Asker; Pat manages PatAsker. Nil's NilBot sits in room B, which Mara
// cannot reach.
async function office() {
  const srv = await startTestServer({ fakeBackend: backend() });
  server = srv;
  const nil = await srv.seedOwner("Nil");
  const mara = await srv.seedMember("Mara");
  const pat = await srv.seedMember("Pat");
  const roomA = srv.agentManager.getRooms()[0].id;
  const roomB = srv.agentManager.createRoom("Room B");
  const user = (name: string) => {
    const u = getUserByName(name);
    if (!u) throw new Error(`no user ${name}`);
    return { username: u.name, id: u.id };
  };
  const maraUser = user(mara.username);
  const patUser = user(pat.username);
  const nilUser = user(nil.username);
  for (const id of [maraUser.id, patUser.id])
    expect(updateUserById(id, { allowedRooms: [roomA] })).toBeTruthy();
  const spawn = async (
    name: string,
    manager: { username: string; id: string },
    roomId = roomA,
  ): Promise<AgentInfo> => {
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
      manager.username,
      "claude",
      undefined,
      manager.id,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  };
  const builder = await spawn("Builder", maraUser);
  const asker = await spawn("Asker", maraUser);
  const patAsker = await spawn("PatAsker", patUser);
  const nilBot = await spawn("NilBot", nilUser, roomB);
  const as = (agentId: string): Auth => ({
    bearer: getAgentTokenRaw(agentId)!,
  });
  const register = async (by: AgentInfo, name: string): Promise<Auth> => {
    const reg = await call(srv, "POST", "/api/apps", as(by.id), {
      // An agent cannot let its app in by naming the field at registration.
      json: {
        name,
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
        inboxAccess: true,
      },
    });
    expect(reg.status).toBe(201);
    const raw = srv.appSupervisor.tokenFiles.get(name);
    if (!raw) throw new Error(`no token file for ${name}`);
    return { bearer: raw };
  };
  const app = await register(builder, "feed");
  return {
    srv,
    nil: { rawSessionId: nil.rawSessionId } as Auth,
    mara: { rawSessionId: mara.rawSessionId } as Auth,
    pat: { rawSessionId: pat.rawSessionId } as Auth,
    maraUser,
    patUser,
    builder,
    asker,
    patAsker,
    nilBot,
    as,
    register,
    app,
  };
}
type Office = Awaited<ReturnType<typeof office>>;

async function openAsk(
  o: Office,
  agent: AgentInfo,
  prompt: string,
  query = "",
): Promise<AskEntry> {
  const r = await call(
    o.srv,
    "POST",
    `/api/agents/${agent.id}/asks${query}`,
    o.as(agent.id),
    { text: `${prompt}\n` },
  );
  expect(r.status).toBe(201);
  return r.body as AskEntry;
}

const setInbox = (o: Office, auth: Auth, enabled: unknown, name = "feed") =>
  call(o.srv, "PUT", `/api/apps/${name}/inbox-access`, auth, {
    json: { enabled },
  });

// The record as its owner reads it.
async function inboxOn(o: Office, name = "feed", owner = o.mara) {
  const r = await call(o.srv, "GET", `/api/apps/${name}`, owner);
  expect(r.status).toBe(200);
  return (r.body as AppWire).inboxAccess === true;
}

const askIds = async (o: Office, auth: Auth) => {
  const r = await call(o.srv, "GET", "/api/asks", auth);
  expect(r.status).toBe(200);
  return (r.body as AskEntry[]).map((e) => e.id).sort();
};

const latestAudit = (operation: string) =>
  officeAuditStore().list({ operation, limit: 1 }).items[0];

function userMessage(o: Office, agentId: string, content: string) {
  return o.srv.agentManager
    .getAgentLogs(agentId)
    .find((e) => e.kind === "user_message" && e.content === content);
}

describe("the switch", () => {
  it("is off by default, and only the app's owner sets it, from a session or an API token", async () => {
    const o = await office();
    await openAsk(o, o.asker, "Ship it?");
    // Registration named inboxAccess: true, and the record is still off.
    expect(await inboxOn(o)).toBe(false);
    const appList = await call(o.srv, "GET", "/api/asks", o.app);
    expect(`${appList.status} ${appList.code}`).toBe("403 forbidden");

    // Refused: the owner agent (it holds app:write and manages the app), the
    // same agent made privileged, the app itself, an office owner who is not
    // the owner, another member.
    const builderToken = o.as(o.builder.id);
    const refused: Array<[string, () => Promise<Res>]> = [
      ["owner agent", () => setInbox(o, builderToken, true)],
      [
        "privileged owner agent",
        async () => {
          await o.srv.agentManager.setPrivileged(o.builder.id, true);
          expect(o.srv.agentManager.getAgent(o.builder.id)?.privileged).toBe(
            true,
          );
          // setPrivileged re-mints the token: the old one is revoked.
          return setInbox(o, o.as(o.builder.id), true);
        },
      ],
      ["the app", () => setInbox(o, o.app, true)],
      ["office owner", () => setInbox(o, o.nil, true)],
      ["another member", () => setInbox(o, o.pat, true)],
    ];
    for (const [who, attempt] of refused) {
      const r = await attempt();
      expect(`${who} ${r.status}`).toBe(`${who} 403`);
      expect(await inboxOn(o)).toBe(false);
    }
    // The office owner was refused for not being the owner, not for lacking
    // the app: it reads the record.
    expect((await call(o.srv, "GET", "/api/apps/feed", o.nil)).status).toBe(
      200,
    );

    // A body that is not a boolean changes nothing.
    const bad = await setInbox(o, o.mara, "yes");
    expect(bad.code).toBe("invalid_request");
    expect(await inboxOn(o)).toBe(false);

    // The owner's session turns it on; the app's next call has the reach.
    const on = await setInbox(o, o.mara, true);
    expect(on.status).toBe(200);
    expect((on.body as AppWire).inboxAccess).toBe(true);
    expect(await inboxOn(o)).toBe(true);
    expect((await call(o.srv, "GET", "/api/asks", o.app)).status).toBe(200);
    expect(latestAudit("apps.setInboxAccess")?.actor).toMatchObject({
      kind: "member",
      id: o.maraUser.id,
    });

    // The owner's API token turns it off and on again; off holds on the
    // app's very next call.
    const api = await mintApiToken({
      userId: o.maraUser.id,
      name: "laptop",
      expiresInDays: null,
    });
    const viaApi = { bearer: api.token };
    const off = await setInbox(o, viaApi, false);
    expect(off.status).toBe(200);
    expect((off.body as AppWire).inboxAccess === true).toBe(false);
    const afterOff = await call(o.srv, "GET", "/api/asks", o.app);
    expect(`${afterOff.status} ${afterOff.code}`).toBe("403 forbidden");
    expect((await setInbox(o, viaApi, true)).status).toBe(200);
    expect(await inboxOn(o)).toBe(true);
  });

  it("is not set by an app update, and a new registration of the name starts off", async () => {
    const o = await office();
    // The owner agent's PATCH goes through (the description changes) and
    // leaves the switch alone.
    const patched = await call(
      o.srv,
      "PATCH",
      "/api/apps/feed",
      o.as(o.builder.id),
      { json: { description: "cards", inboxAccess: true } },
    );
    expect(patched.status).toBe(200);
    expect((patched.body as AppWire).description).toBe("cards");
    expect(await inboxOn(o)).toBe(false);

    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    expect(
      (await call(o.srv, "DELETE", "/api/apps/feed", o.mara)).status,
    ).toBeLessThan(300);
    const again = await o.register(o.builder, "feed");
    expect(await inboxOn(o)).toBe(false);
    const r = await call(o.srv, "GET", "/api/asks", again);
    expect(`${r.status} ${r.code}`).toBe("403 forbidden");
  });
});

describe("an app in its owner's Inbox", () => {
  it("lists its owner's open asks and answers one as the owner, recorded as the app", async () => {
    const o = await office();
    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    const a = await openAsk(o, o.asker, "Pull the spend breakdown?");
    const b = await openAsk(o, o.asker, "Book the room?");
    // Pat's ask, in a room Mara reaches: never Mara's app's.
    const p = await openAsk(o, o.patAsker, "Pat's question?");
    expect(await askIds(o, o.app)).toEqual([a.id, b.id].sort());
    expect(await askIds(o, o.pat)).toEqual([p.id]);

    // A device in the body is a member's alone, and refusing it leaves the
    // ask open.
    const withDevice = await call(
      o.srv,
      "POST",
      `/api/asks/${a.id}/reply`,
      o.app,
      { json: { text: "hi", device: "Phone" } },
    );
    expect(withDevice.status).toBe(400);
    expect(await askIds(o, o.app)).toEqual([a.id, b.id].sort());

    const r = await call(o.srv, "POST", `/api/asks/${a.id}/reply`, o.app, {
      json: { text: "yes, per agent" },
    });
    expect(r.status).toBe(204);
    await waitUntil(
      () => userMessage(o, o.asker.id, "yes, per agent") !== undefined,
      "reply logged",
    );
    // The agent reads it as Mara's message, the app named as her device,
    // linked to the ask.
    const entry = userMessage(o, o.asker.id, "yes, per agent")!;
    expect(entry.metadata?.username).toBe(o.maraUser.username);
    expect(entry.metadata?.device).toContain("feed");
    expect((entry.metadata?.ask as { id?: string } | undefined)?.id).toBe(a.id);
    const sent = o.srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === o.asker.id)
      .flatMap((s) => s.sent.map((m) => m.text))
      .find((t) => t.includes("yes, per agent"));
    expect(sent?.startsWith(`[${o.maraUser.username}`)).toBe(true);
    expect(latestAudit("asks.reply")?.actor).toMatchObject({
      kind: "app",
      name: "feed",
    });

    // Closed for the Inbox too.
    expect(await askIds(o, o.mara)).toEqual([b.id]);
    const late = await call(o.srv, "POST", `/api/asks/${a.id}/reply`, o.mara, {
      json: { text: "again" },
    });
    expect(`${late.status} ${late.code}`).toBe("404 not_found");

    // And the other way: the Inbox dismisses b, and the app no longer has it.
    expect(
      (await call(o.srv, "POST", `/api/asks/${b.id}/dismiss`, o.mara, {}))
        .status,
    ).toBe(204);
    expect(await askIds(o, o.app)).toEqual([]);
    for (const verb of ["reply", "dismiss", "file-task"]) {
      const gone = await call(
        o.srv,
        "POST",
        `/api/asks/${b.id}/${verb}`,
        o.app,
        { json: verb === "reply" ? { text: "x" } : {} },
      );
      expect(`${verb} ${gone.status} ${gone.code}`).toBe(
        `${verb} 404 not_found`,
      );
    }
  });

  it("dismisses one and files one as a task, named as the app", async () => {
    const o = await office();
    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    const d = await openAsk(o, o.asker, "Keep the old branch?");
    const f = await openAsk(o, o.asker, "Refactor the pager?");

    const dismissed = await call(
      o.srv,
      "POST",
      `/api/asks/${d.id}/dismiss`,
      o.app,
      { json: { text: "not now" } },
    );
    expect(dismissed.status).toBe(204);
    await waitUntil(
      () => userMessage(o, o.asker.id, "not now") !== undefined,
      "dismiss logged",
    );
    const dEntry = userMessage(o, o.asker.id, "not now")!;
    expect(dEntry.metadata?.username).toBe(o.maraUser.username);
    expect(dEntry.metadata?.ask).toMatchObject({ id: d.id, dismissed: true });

    const filed = await call(
      o.srv,
      "POST",
      `/api/asks/${f.id}/file-task`,
      o.app,
      {},
    );
    expect(filed.status).toBe(201);
    const task = filed.body as TaskItem;
    expect(task.createdBy).toContain("feed");
    expect(task.username).toBe(o.maraUser.username);
    expect(o.srv.agentManager.getTasks().map((t) => t.id)).toEqual([task.id]);
    expect(latestAudit("asks.fileTask")?.actor).toMatchObject({
      kind: "app",
      name: "feed",
    });
    expect(await askIds(o, o.mara)).toEqual([]);
  });

  it("never sees or answers a secret request, or another member's ask", async () => {
    const o = await office();
    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    const made = await call(
      o.srv,
      "POST",
      `/api/agents/${o.asker.id}/secret-requests`,
      o.as(o.asker.id),
      {
        json: {
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          reason: "To open the pull request.",
        },
      },
    );
    expect(made.status).toBe(200);
    const requestId = (made.body as { requestId: string }).requestId;
    const p = await openAsk(o, o.patAsker, "Pat's question?");
    // Mara's Inbox holds the request: the app's empty list is the filter.
    const inbox = (await call(o.srv, "GET", "/api/asks", o.mara))
      .body as AskEntry[];
    expect(inbox.map((e) => e.secret?.requestId)).toEqual([requestId]);
    const secret = inbox[0];
    expect(await askIds(o, o.app)).toEqual([]);

    for (const id of [secret.id, p.id]) {
      for (const verb of ["reply", "dismiss", "file-task"]) {
        const r = await call(o.srv, "POST", `/api/asks/${id}/${verb}`, o.app, {
          json: verb === "reply" ? { text: "ghp_x" } : {},
        });
        expect(`${verb} ${r.status} ${r.code}`).toBe(`${verb} 404 not_found`);
      }
    }
    const save = await call(
      o.srv,
      "POST",
      `/api/agents/${o.asker.id}/secret-requests/${requestId}/save`,
      o.app,
      { json: { value: "ghp_FAKEappinboxFAKE" } },
    );
    expect(save.status).toBe(403);
    // Both are still open where they belong, and nothing was filed.
    expect(await askIds(o, o.mara)).toEqual([secret.id]);
    expect(await askIds(o, o.pat)).toEqual([p.id]);
    expect(o.srv.agentManager.getTasks()).toEqual([]);

    // An app of Pat's agent, let in by Pat, has Pat's asks and not Mara's.
    const patBuilder = await o.srv.agentManager.spawn(
      "PatBuilder",
      o.srv.stateRoot,
      "default",
      undefined,
      undefined,
      o.patAsker.roomId,
      undefined,
      undefined,
      undefined,
      o.patUser.username,
      "claude",
      undefined,
      o.patUser.id,
    );
    const patApp = await o.register(patBuilder!, "patfeed");
    expect((await setInbox(o, o.pat, true, "patfeed")).status).toBe(200);
    const m = await openAsk(o, o.asker, "Mara's question?");
    expect(await askIds(o, patApp)).toEqual([p.id]);
    const r = await call(o.srv, "POST", `/api/asks/${m.id}/reply`, patApp, {
      json: { text: "from Pat's app" },
    });
    expect(`${r.status} ${r.code}`).toBe("404 not_found");
  });

  it("loses the reach when its owner agent dies", async () => {
    const o = await office();
    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    const a = await openAsk(o, o.asker, "Still there?");
    expect(await askIds(o, o.app)).toEqual([a.id]);
    await o.srv.agentManager.kill(o.builder.id);
    expect(o.srv.agentManager.getAgent(o.builder.id)).toBeUndefined();
    const r = await call(o.srv, "GET", "/api/asks", o.app);
    expect(`${r.status} ${r.code}`).toBe("403 forbidden");
    const reply = await call(o.srv, "POST", `/api/asks/${a.id}/reply`, o.app, {
      json: { text: "x" },
    });
    expect(`${reply.status} ${reply.code}`).toBe("403 forbidden");
    expect(await askIds(o, o.mara)).toEqual([a.id]);
  });

  it("is off again when its owner agent moves to another member, until that member turns it on", async () => {
    const o = await office();
    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    const p = await openAsk(o, o.patAsker, "Pat's question?");
    const moved = await call(
      o.srv,
      "PUT",
      `/api/agents/${o.builder.id}/manager`,
      o.nil,
      { json: { userId: o.patUser.id } },
    );
    expect(moved.status).toBe(200);
    // The app is Pat's now, and the switch Mara set did not come with it.
    const record = (await call(o.srv, "GET", "/api/apps/feed", o.pat))
      .body as AppWire;
    expect(record.userId).toBe(o.patUser.id);
    expect(record.inboxAccess === true).toBe(false);
    const r = await call(o.srv, "GET", "/api/asks", o.app);
    expect(`${r.status} ${r.code}`).toBe("403 forbidden");
    // Pat's own consent opens it, to Pat's asks.
    expect((await setInbox(o, o.pat, true)).status).toBe(200);
    expect(await askIds(o, o.app)).toEqual([p.id]);
  });
});

describe("an ask's files", () => {
  it("are readable by the app while the ask is open, and no other file is", async () => {
    const o = await office();
    // Three contents, so no two copies can share a stored name.
    const bytes = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);
    for (const [name, n] of [
      ["plot.png", 1],
      ["closed.png", 2],
      ["pat.png", 3],
    ] as const)
      writeFileSync(join(o.srv.stateRoot, name), bytes(n));
    const a = await openAsk(o, o.asker, "Look at this?", "?readFile=plot.png");
    const closed = await openAsk(
      o,
      o.asker,
      "And this?",
      "?readFile=closed.png",
    );
    const p = await openAsk(o, o.patAsker, "Pat's plot?", "?readFile=pat.png");
    const fileOf = (e: AskEntry) => e.readFiles![0].filename;
    expect(new Set([a, closed, p].map(fileOf)).size).toBe(3);
    const get = (agentId: string, filename: string, auth: Auth) =>
      o.srv.http(`/api/files/${agentId}/${filename}`, {
        method: "GET",
        ...("bearer" in auth
          ? { headers: { Authorization: `Bearer ${auth.bearer}` } }
          : { rawSessionId: auth.rawSessionId }),
      });
    const status = async (agentId: string, filename: string, auth: Auth) =>
      (await get(agentId, filename, auth)).status;

    // Switch off: refused.
    expect(await status(o.asker.id, fileOf(a), o.app)).toBe(403);

    expect((await setInbox(o, o.mara, true)).status).toBe(200);
    expect(
      (await call(o.srv, "POST", `/api/asks/${closed.id}/dismiss`, o.mara, {}))
        .status,
    ).toBe(204);

    const res = await get(o.asker.id, fileOf(a), o.app);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes(1))).toBe(true);

    // Mara reads each of these (they exist and her rooms reach them); the
    // app does not.
    for (const [label, agentId, filename] of [
      ["a closed ask's file", o.asker.id, fileOf(closed)],
      ["another member's ask's file", o.patAsker.id, fileOf(p)],
    ] as const) {
      expect(`${label} ${await status(agentId, filename, o.mara)}`).toBe(
        `${label} 200`,
      );
      expect(`${label} ${await status(agentId, filename, o.app)}`).toBe(
        `${label} 403`,
      );
    }
    // An open ask's file named under another agent: the refusal, not the
    // missing-file answer a match on the name alone would reach.
    expect(await status(o.patAsker.id, fileOf(a), o.app)).toBe(403);

    // Off again: refused on the next call.
    expect((await setInbox(o, o.mara, false)).status).toBe(200);
    expect(await status(o.asker.id, fileOf(a), o.app)).toBe(403);
  });
});

describe("its owner's pages", () => {
  const pagerArchived = (srv: TestServer, id: string) => {
    const path = join(srv.stateRoot, "pager-resolved.jsonl");
    return (
      existsSync(path) &&
      readFileSync(path, "utf-8")
        .split("\n")
        .filter(Boolean)
        .some((l) => (JSON.parse(l) as PagerEntry).id === id)
    );
  };

  it("are read by id in each state and acked, with no switch; a page in a room the owner cannot reach is unknown", async () => {
    const o = await office();
    expect(await inboxOn(o)).toBe(false);
    const raise = async (agent: AgentInfo) => {
      const r = await call(o.srv, "POST", "/api/pager", o.as(agent.id), {
        json: { title: "Disk full" },
      });
      expect(r.status).toBe(201);
      return r.body as PagerEntry;
    };
    const page = await raise(o.asker);
    expect(page.targetUserId).toBe(o.maraUser.id);
    const state = async () => {
      const r = await call(o.srv, "GET", `/api/pager/${page.id}`, o.app);
      expect(r.status).toBe(200);
      return (r.body as PagerEntry).state;
    };
    expect(await state()).toBe("open");
    const ack = await call(o.srv, "POST", `/api/pager/${page.id}/ack`, o.app, {
      json: {},
    });
    expect(ack.status).toBe(200);
    expect(await state()).toBe("acked");
    const resolved = await call(
      o.srv,
      "POST",
      `/api/pager/${page.id}/resolve`,
      o.as(o.asker.id),
      { json: {} },
    );
    expect(resolved.status).toBe(200);
    await waitUntil(() => pagerArchived(o.srv, page.id), "page archived", 5000);
    expect(await state()).toBe("resolved");

    // NilBot's page is in room B: Nil sees it, Mara's app gets 404.
    const hidden = await raise(o.nilBot);
    expect(
      (await call(o.srv, "GET", `/api/pager/${hidden.id}`, o.nil)).status,
    ).toBe(200);
    const r = await call(o.srv, "GET", `/api/pager/${hidden.id}`, o.app);
    expect(r.status).toBe(404);
  });
});
