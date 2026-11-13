// A paged ask end to end on the real server (task 74e8fc07): an agent opens
// an ask with `page`, which rings for every member it is for, on Discord and
// Web Push, linking to the ask; P1 unless the agent sets a priority; at most
// 50 open per agent; any member who may answer it acks it, which keeps it
// open; the alarm is fixed at create; no wire carries the send records.
// The repeats, the room checks and the races are pinned at the engine seam
// (server/page-items.test.ts). Seam: startTestServer() with stub pagerFetch
// and webPushFetch. FakeBackend only, no Discord, no push service.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AskMemberWire } from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
  AskHistoryRes,
} from "../../shared/contract-shapes.ts";
import { ASK_PAGES_MAX_OPEN_PER_SOURCE } from "../asks.ts";
import * as managers from "../office-managers.ts";
import { browserDevice, decrypt } from "./web-push-receiver.ts";

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

type Res = { status: number; code?: string; body: unknown };
type Auth = { bearer?: string; rawSessionId?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  body?: { json?: unknown; text?: string },
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
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
    rawSessionId: auth.rawSessionId,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const error = (parsed as { error?: { code?: string } } | null)?.error;
  return { status: res.status, code: error?.code, body: parsed };
}

// Each member's own Discord webhook.
const hookOf = (n: number) =>
  `https://discord.com/api/webhooks/${String(n).repeat(18)}/token${n}`;

// Nil owns the office and manages Asker. Pat and Kim reach Asker's room; Sam
// reaches no room.
async function world() {
  const discord: { url: string; body: { embeds?: { url: string }[] } }[] = [];
  const pushed: { url: string; body: Uint8Array<ArrayBuffer> }[] = [];
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
    startServer: {
      pagerFetch: async (url, init) => {
        discord.push({ url, body: JSON.parse(init.body as string) });
        return new Response(null, { status: 204 });
      },
      webPushFetch: async (url, init) => {
        pushed.push({ url, body: init.body as Uint8Array<ArrayBuffer> });
        return new Response(null, { status: 201 });
      },
    },
  });
  const srv = server;
  const owner = await srv.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = srv.agentManager.getRooms();
  const asker = await srv.agentManager.spawn(
    "Asker",
    srv.workDir,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    ownerId,
  );
  if (!asker) throw new Error("spawn Asker failed");
  const seed = async (name: string, rooms: string[]) => {
    const m = await srv.seedMember(name);
    const id = getUserByName(m.username)!.id;
    expect(updateUserById(id, { allowedRooms: rooms })).toBeTruthy();
    return { ...m, id, auth: { rawSessionId: m.rawSessionId } as Auth };
  };
  const pat = await seed("Pat", [room.id]);
  const kim = await seed("Kim", [room.id]);
  const sam = await seed("Sam", []);
  const nil = {
    ...owner,
    id: ownerId,
    auth: { rawSessionId: owner.rawSessionId } as Auth,
  };
  const agentAuth: Auth = { bearer: getAgentTokenRaw(asker.id)! };
  const base = `/api/agents/${asker.id}/asks`;
  return {
    srv,
    room,
    asker,
    nil,
    pat,
    kim,
    sam,
    agentAuth,
    base,
    discord,
    pushed,
  };
}
type W = Awaited<ReturnType<typeof world>>;
type Who = W["nil"];

const create = (w: W, json: Record<string, unknown>) =>
  call(w.srv, "POST", w.base, w.agentAuth, { json });

async function opened(w: W, json: Record<string, unknown>) {
  const r = await create(w, json);
  expect([r.status, r.code]).toEqual([201, undefined]);
  return r.body as AskAgentWire;
}

const ack = (w: W, who: Auth, id: string) =>
  call(w.srv, "POST", `/api/asks/${id}/ack`, who);

const answer = (w: W, who: Who, id: string, verb: string, json = {}) =>
  call(w.srv, "POST", `/api/asks/${id}/${verb}`, who.auth, { json });

const openCount = async (w: W) =>
  ((await call(w.srv, "GET", w.base, w.agentAuth)).body as AskAgentWire[])
    .length;

async function listed(w: W, who: Who): Promise<AskMemberWire[]> {
  const r = await call(w.srv, "GET", "/api/asks", who.auth);
  expect(r.status).toBe(200);
  return r.body as AskMemberWire[];
}

// Every object key anywhere in a JSON value.
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  return out;
}

describe("opening a paged ask", () => {
  it("takes page as JSON true or text page=1, rings, and is P1 unless the agent sets a priority", async () => {
    const w = await world();
    const json = await opened(w, { text: "Restart the box?", page: true });
    expect(json.page?.state).toBe("ringing");
    expect(json.priority).toBe("P1");
    const text = await call(w.srv, "POST", `${w.base}?page=1`, w.agentAuth, {
      text: "Restart the box?",
    });
    expect(text.status).toBe(201);
    expect((text.body as AskAgentWire).page?.state).toBe("ringing");
    expect((text.body as AskAgentWire).priority).toBe("P1");
    const urgent = await opened(w, {
      text: "Now?",
      page: true,
      priority: "P0",
    });
    expect(urgent.priority).toBe("P0");
    // A plain ask keeps no priority and no alarm.
    const plain = await opened(w, { text: "Later?" });
    expect([plain.priority, plain.page]).toEqual([undefined, undefined]);
    // Pat's list shows the alarm too.
    const pats = await opened(w, {
      text: "Pat, now?",
      member: w.pat.username,
      page: true,
    });
    const seen = (await listed(w, w.pat)).find((e) => e.id === pats.id);
    expect(seen?.page?.state).toBe("ringing");
  });

  it("refuses any other page value with 400, and opens nothing", async () => {
    const w = await world();
    const outcomes: string[] = [];
    for (const page of ["yes", 1, "true"]) {
      const r = await create(w, { text: "Go?", page });
      outcomes.push(`${JSON.stringify(page)}: ${r.status} ${r.code}`);
    }
    const viaText = await call(
      w.srv,
      "POST",
      `${w.base}?page=yes`,
      w.agentAuth,
      { text: "Go?" },
    );
    outcomes.push(`text yes: ${viaText.status} ${viaText.code}`);
    expect(outcomes).toEqual([
      '"yes": 400 invalid_request',
      "1: 400 invalid_request",
      '"true": 400 invalid_request',
      "text yes: 400 invalid_request",
    ]);
    expect(await openCount(w)).toBe(0);
  });

  it("rings for named members and for a room", async () => {
    const w = await world();
    const named = await opened(w, {
      text: "Who restarts it?",
      member: [w.pat.username, w.kim.username],
      page: true,
    });
    expect(named.page?.state).toBe("ringing");
    const room = await opened(w, { text: "Anyone?", room: true, page: true });
    expect(room.page?.state).toBe("ringing");
  });

  it("holds at most 50 open paged asks per agent with 429, and plain asks still open", async () => {
    const w = await world();
    let first = "";
    for (let i = 0; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++) {
      const made = await opened(w, { text: `Page ${i}?`, page: true });
      first ||= made.id;
    }
    const over = await create(w, { text: "One more?", page: true });
    expect([over.status, over.code]).toEqual([429, "too_many_pages"]);
    expect((await create(w, { text: "Plain?" })).status).toBe(201);
    // The agent's delete frees a place.
    const del = await call(w.srv, "DELETE", `${w.base}/${first}`, w.agentAuth);
    expect(del.status).toBeLessThan(300);
    expect((await create(w, { text: "Now?", page: true })).status).toBe(201);
  });

  it("an edit cannot add or remove the alarm", async () => {
    const w = await world();
    const paged = await opened(w, { text: "Restart?", page: true });
    const plain = await opened(w, { text: "Later?" });
    const outcomes: string[] = [];
    for (const [id, page] of [
      [plain.id, true],
      [paged.id, false],
    ] as const) {
      const r = await call(w.srv, "PATCH", `${w.base}/${id}`, w.agentAuth, {
        json: { text: "Edited?", page },
      });
      outcomes.push(`${r.status} ${r.code}`);
    }
    expect(outcomes).toEqual(["400 invalid_request", "400 invalid_request"]);
    const back = (id: string) =>
      call(w.srv, "GET", `${w.base}/${id}`, w.agentAuth).then(
        (r) => r.body as AskAgentWire,
      );
    expect((await back(plain.id)).page).toBeUndefined();
    expect((await back(paged.id)).page?.state).toBe("ringing");
    // An edit without page keeps the alarm and the ask's text changes.
    const edited = await call(
      w.srv,
      "PATCH",
      `${w.base}/${paged.id}`,
      w.agentAuth,
      { json: { text: "Restart it now?" } },
    );
    expect(edited.status).toBe(200);
    expect((await back(paged.id)).page?.state).toBe("ringing");
  });
});

describe("acking a paged ask", () => {
  it("a member it is for acks it: the alarm stops for all, the ask stays open, and a second ack changes nothing", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Restart the box?",
      member: [w.pat.username, w.kim.username],
      page: true,
    });
    const first = await ack(w, w.pat.auth, made.id);
    expect(first.status).toBe(200);
    expect((first.body as AskMemberWire).page).toMatchObject({
      state: "acked",
      ackedBy: w.pat.username,
    });
    const kims = (await listed(w, w.kim)).find((e) => e.id === made.id);
    expect(kims?.page).toMatchObject({
      state: "acked",
      ackedBy: w.pat.username,
    });
    const again = await ack(w, w.kim.auth, made.id);
    expect(again.status).toBe(200);
    expect((again.body as AskMemberWire).page?.ackedBy).toBe(w.pat.username);
    // The agent sees the ack on its own read.
    const agentRead = await call(
      w.srv,
      "GET",
      `${w.base}/${made.id}`,
      w.agentAuth,
    );
    expect((agentRead.body as AskAgentWire).page?.state).toBe("acked");
  });

  it("an office owner acks another member's paged ask; nobody else outside it does", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Pat, restart?",
      member: w.pat.username,
      page: true,
    });
    const outcomes: string[] = [];
    for (const [label, auth] of [
      ["Kim, in the room but not named", w.kim.auth],
      ["Sam, outside the room", w.sam.auth],
      ["the asking agent", w.agentAuth],
    ] as const) {
      const r = await ack(w, auth, made.id);
      outcomes.push(`${label}: ${r.status === 200 ? "acked" : "refused"}`);
    }
    expect(outcomes).toEqual([
      "Kim, in the room but not named: refused",
      "Sam, outside the room: refused",
      "the asking agent: refused",
    ]);
    // The refusals of members are the same 404 as an unknown id.
    expect((await ack(w, w.kim.auth, made.id)).status).toBe(404);
    expect((await ack(w, w.sam.auth, made.id)).status).toBe(404);
    expect((await ack(w, w.pat.auth, "nosuchid")).status).toBe(404);
    expect((await listed(w, w.pat))[0].page?.state).toBe("ringing");
    const owner = await ack(w, w.nil.auth, made.id);
    expect(owner.status).toBe(200);
    expect((owner.body as AskMemberWire).page?.ackedBy).toBe(w.nil.username);
  });

  it("refuses a plain ask with 409 not_paged, and a closed one with 404", async () => {
    const w = await world();
    const plain = await opened(w, { text: "Later?" });
    const r = await ack(w, w.nil.auth, plain.id);
    expect([r.status, r.code]).toEqual([409, "not_paged"]);
    const paged = await opened(w, { text: "Now?", page: true });
    expect((await answer(w, w.nil, paged.id, "dismiss")).status).toBe(204);
    expect((await ack(w, w.nil.auth, paged.id)).status).toBe(404);
  });
});

describe("what a paged ask's wire carries", () => {
  it("no route sends the send records, and the history names who acked", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Restart the box?",
      member: [w.pat.username, w.kim.username],
      page: true,
    });
    const acked = await ack(w, w.pat.auth, made.id);
    const reads: [string, unknown][] = [
      ["create", made],
      ["ack", acked.body],
      ["member list", await listed(w, w.pat)],
      ["agent list", (await call(w.srv, "GET", w.base, w.agentAuth)).body],
      [
        "agent read",
        (await call(w.srv, "GET", `${w.base}/${made.id}`, w.agentAuth)).body,
      ],
      [
        "owner's others",
        (await call(w.srv, "GET", "/api/asks/others", w.nil.auth)).body,
      ],
    ];
    expect(
      (await answer(w, w.kim, made.id, "reply", { text: "done" })).status,
    ).toBe(204);
    const history = await call(w.srv, "GET", `${w.base}/history`, w.agentAuth);
    expect(history.status).toBe(200);
    reads.push(["history", history.body]);
    const byId = await call(w.srv, "GET", `/api/asks/${made.id}`, w.nil.auth);
    expect(byId.status).toBe(200);
    reads.push(["closed read", byId.body]);
    const leaks = reads
      .filter(([, body]) => {
        const keys = keysIn(body);
        // Slice 3: nor the raise count, the last raise or the key.
        return [
          "delivery",
          "ackedByUserId",
          "raiseCount",
          "lastRaisedAt",
          "key",
        ].some((k) => keys.has(k));
      })
      .map(([label]) => label);
    expect(leaks).toEqual([]);
    // Each read of the open ask names its page id (slice 3).
    expect(made.page?.pageId).toMatch(/^[0-9a-f]{16}$/);
    expect(
      reads
        .filter(
          ([, body]) => !JSON.stringify(body).includes(made.page!.pageId!),
        )
        .map(([label]) => label),
    ).toEqual([]);
    // The ack is in the closed ask's events, by name.
    const closed = (history.body as AskHistoryRes).asks.find(
      (a) => a.id === made.id,
    ) as AskClosedWire;
    const ackEvent = closed.events.find((e) => e.kind === "acked") as
      { by?: string | null; byUserId?: string } | undefined;
    expect(ackEvent?.by).toBe(w.pat.username);
    expect(ackEvent?.byUserId).toBeUndefined();
  });
});

describe("a paged ask's alarm on Discord and Web Push", () => {
  async function webhook(w: W, who: Who, n: number) {
    const r = await call(
      w.srv,
      "PATCH",
      `/api/users/${who.username}/pager-settings`,
      who.auth,
      { json: { webhookUrl: hookOf(n), discordUserId: String(n).repeat(18) } },
    );
    expect(r.status).toBe(200);
  }
  async function device(w: W, who: Who, n: number) {
    const dev = await browserDevice(n);
    const r = await call(
      w.srv,
      "POST",
      `/api/users/${who.username}/push-devices`,
      who.auth,
      {
        json: {
          endpoint: dev.input.endpoint,
          keys: { p256dh: dev.input.p256dh, auth: dev.input.auth },
        },
      },
    );
    expect(r.status).toBe(200);
    return dev;
  }

  it("each member it is for gets it on their own webhook, linking to the ask; a plain ask sends nothing", async () => {
    const w = await world();
    await webhook(w, w.pat, 1);
    await webhook(w, w.kim, 2);
    await webhook(w, w.nil, 3);
    await opened(w, {
      text: "Plain?",
      member: [w.pat.username, w.kim.username],
    });
    const made = await opened(w, {
      text: "Restart the box?",
      member: [w.pat.username, w.kim.username],
      page: true,
    });
    await waitUntil(() => w.discord.length >= 2, "two Discord sends");
    await sleep(50);
    expect(w.discord.map((c) => c.url).sort()).toEqual(
      [hookOf(1), hookOf(2)].sort(),
    );
    for (const c of w.discord)
      expect(c.body.embeds?.[0].url.endsWith(`/inbox/asks/${made.id}`)).toBe(
        true,
      );
  });

  it("pushes to each member it is for, and a reply sends the resolved push", async () => {
    const w = await world();
    const pat = await device(w, w.pat, 1);
    const nil = await device(w, w.nil, 2);
    const made = await opened(w, {
      text: "Restart the box?",
      member: w.pat.username,
      page: true,
    });
    const toPat = () => w.pushed.filter((c) => c.url === pat.input.endpoint);
    await waitUntil(() => toPat().length === 1, "the page push");
    const first = await decrypt(toPat()[0].body, pat);
    expect(first.url).toBe(`/inbox/asks/${made.id}`);
    expect(first.renotify).toBe(true);
    expect(
      (await answer(w, w.pat, made.id, "reply", { text: "done" })).status,
    ).toBe(204);
    await waitUntil(() => toPat().length === 2, "the resolved push");
    const resolved = await decrypt(toPat()[1].body, pat);
    expect(resolved.renotify).toBe(false);
    expect(resolved.tag).toBe(first.tag);
    // Nil is no recipient: no push.
    expect(w.pushed.filter((c) => c.url === nil.input.endpoint)).toEqual([]);
  });

  it("removing the agent closes its paged ask and sends the resolved push", async () => {
    const w = await world();
    const pat = await device(w, w.pat, 1);
    await opened(w, {
      text: "Restart the box?",
      member: w.pat.username,
      page: true,
    });
    const toPat = () => w.pushed.filter((c) => c.url === pat.input.endpoint);
    await waitUntil(() => toPat().length === 1, "the page push");
    await w.srv.agentManager.kill(w.asker.id);
    await waitUntil(() => toPat().length === 2, "the resolved push");
    const resolved = await decrypt(toPat()[1].body, pat);
    expect(resolved.renotify).toBe(false);
    expect(resolved.body).toContain("Asker");
  });
});

// An office page (task 74e8fc07, slice 2): the office raises a page about a
// member's own WhatsApp or Discord link (the supervisors' pager.raise), which
// opens a paged ask with no agent for that member only. Seam: the raisers the
// office hands its supervisors (office-managers `officePagers`), on the real
// server.
describe("an office page", () => {
  const raise = (
    feature: "whatsapp" | "discord",
    userId: string,
    key: string,
    title: string,
    body: string,
  ) => managers.officePagers[feature].raise(userId, key, title, body);
  const waKey = (userId: string) => `whatsapp:${userId}:dead`;

  async function patsOnly(w: W) {
    const asks = await listed(w, w.pat);
    expect(asks).toHaveLength(1);
    return asks[0];
  }

  it("opens a P1 paged ask for that member only, from the feature, on their list, socket and Discord", async () => {
    const w = await world();
    const r = await call(
      w.srv,
      "PATCH",
      `/api/users/${w.pat.username}/pager-settings`,
      w.pat.auth,
      { json: { webhookUrl: hookOf(1), discordUserId: "1".repeat(18) } },
    );
    expect(r.status).toBe(200);
    const patWs = await w.srv.connectWs(w.pat.rawSessionId);
    const kimWs = await w.srv.connectWs(w.kim.rawSessionId);
    const nilWs = await w.srv.connectWs(w.nil.rawSessionId);
    raise(
      "whatsapp",
      w.pat.id,
      waKey(w.pat.id),
      "WhatsApp stopped",
      "The bridge exited.",
    );

    const ask = await patsOnly(w);
    expect(ask.office).toEqual({ feature: "whatsapp", name: "WhatsApp" });
    expect(ask.page?.state).toBe("ringing");
    expect(ask.priority).toBe("P1");
    expect(ask.prompt.split("\n")[0]).toBe("WhatsApp stopped");
    expect(ask.prompt).toContain("The bridge exited.");
    expect(keysIn(ask).has("key")).toBe(false);
    // Nobody else sees it: not a member in the room, not the owner.
    expect(await listed(w, w.kim)).toEqual([]);
    expect(await listed(w, w.nil)).toEqual([]);
    const others = await call(w.srv, "GET", "/api/asks/others", w.nil.auth);
    expect((others.body as AskAgentWire[]).map((e) => e.id)).toEqual([]);
    const reads = await Promise.all(
      [w.pat, w.kim, w.nil].map(
        async (who) =>
          (await call(w.srv, "GET", `/api/asks/${ask.id}`, who.auth)).status,
      ),
    );
    expect(reads).toEqual([200, 404, 404]);
    // The member's socket gets it; the others' do not.
    const upserted = await patWs.waitFor("ask_upserted");
    expect((upserted.entry as { id?: string }).id).toBe(ask.id);
    await sleep(100);
    for (const ws of [kimWs, nilWs])
      expect(
        ws.messages.some(
          (m) => (m as { entry?: { id?: string } }).entry?.id === ask.id,
        ),
      ).toBe(false);
    // Discord: the member's webhook, linking to the ask.
    await waitUntil(() => w.discord.length === 1, "the Discord send");
    expect(w.discord[0].url).toBe(hookOf(1));
    expect(
      w.discord[0].body.embeds?.[0].url.endsWith(`/inbox/asks/${ask.id}`),
    ).toBe(true);
    for (const ws of [patWs, kimWs, nilWs]) ws.close();
  });

  it("a raise with the same key edits the open ask and keeps an ack; after a dismiss the key opens a new one", async () => {
    const w = await world();
    raise("whatsapp", w.pat.id, waKey(w.pat.id), "WhatsApp stopped", "First.");
    const first = await patsOnly(w);
    expect((await ack(w, w.pat.auth, first.id)).status).toBe(200);
    raise("whatsapp", w.pat.id, waKey(w.pat.id), "WhatsApp stopped", "Second.");
    const again = await patsOnly(w);
    expect(again.id).toBe(first.id);
    expect(again.prompt).toContain("Second.");
    expect(again.page?.state).toBe("acked");
    // Another member's key, and the Discord feature, are other pages.
    raise("whatsapp", w.kim.id, waKey(w.kim.id), "WhatsApp stopped", "Kim.");
    raise(
      "discord",
      w.pat.id,
      `discord:${w.pat.id}:b1:token`,
      "Discord bot stopped",
      "Bad token.",
    );
    const pats = await listed(w, w.pat);
    expect(pats.map((e) => e.office?.feature).sort()).toEqual([
      "discord",
      "whatsapp",
    ]);
    expect(await listed(w, w.kim)).toHaveLength(1);
    expect((await answer(w, w.pat, first.id, "dismiss")).status).toBe(204);
    raise("whatsapp", w.pat.id, waKey(w.pat.id), "WhatsApp stopped", "Third.");
    const fresh = (await listed(w, w.pat)).find(
      (e) => e.office?.feature === "whatsapp",
    );
    expect(fresh?.id).toBeDefined();
    expect(fresh?.id).not.toBe(first.id);
    expect(fresh?.page?.state).toBe("ringing");
  });

  it("nobody can answer it: reply, simplify and file-task are 409 no_agent; dismiss closes it, and its member reads the close", async () => {
    const w = await world();
    raise("whatsapp", w.pat.id, waKey(w.pat.id), "WhatsApp stopped", "Gone.");
    const ask = await patsOnly(w);
    const outcomes: string[] = [];
    for (const [verb, json] of [
      ["reply", { text: "ok" }],
      ["simplify", {}],
      ["file-task", {}],
    ] as const) {
      const r = await answer(w, w.pat, ask.id, verb, json);
      outcomes.push(`${verb}: ${r.status} ${r.code}`);
    }
    expect(outcomes).toEqual([
      "reply: 409 no_agent",
      "simplify: 409 no_agent",
      "file-task: 409 no_agent",
    ]);
    expect((await patsOnly(w)).id).toBe(ask.id);
    // Not another member's to dismiss.
    expect((await answer(w, w.kim, ask.id, "dismiss")).status).toBe(404);
    const patWs = await w.srv.connectWs(w.pat.rawSessionId);
    const nilWs = await w.srv.connectWs(w.nil.rawSessionId);
    expect((await answer(w, w.pat, ask.id, "dismiss")).status).toBe(204);
    // The removal goes to the member's socket, and to no owner's.
    const removed = await patWs.waitFor("ask_removed");
    expect(removed.id).toBe(ask.id);
    await sleep(100);
    expect(nilWs.messages.some((m) => JSON.stringify(m).includes(ask.id))).toBe(
      false,
    );
    patWs.close();
    nilWs.close();
    expect(await listed(w, w.pat)).toEqual([]);
    const closed = await call(w.srv, "GET", `/api/asks/${ask.id}`, w.pat.auth);
    expect(closed.status).toBe(200);
    expect(
      (closed.body as { closed?: { outcome?: string } }).closed?.outcome,
    ).toBe("dismissed");
    expect(
      (await call(w.srv, "GET", `/api/asks/${ask.id}`, w.nil.auth)).status,
    ).toBe(404);
  });
});
