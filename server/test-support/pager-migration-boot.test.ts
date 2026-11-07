// The pager migration at boot (task 74e8fc07, slice 3): the pages of an
// older release's pager.json and pager-resolved.jsonl become paged asks and
// closed asks with their page ids; the files are only read, so a rollback
// finds them as they were; a second boot changes nothing. A paged ask from a
// slice 1 or 2 build, with no page id, gets one at boot.
//
// Seam: startTestServer(), files written into its state root, then a cold
// restart. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AskMemberWire, PagerEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function api(srv: TestServer, path: string, rawSessionId: string) {
  const res = await srv.http(path, { rawSessionId });
  return { status: res.status, body: (await res.json()) as unknown };
}

// Morgan owns the office and manages Bot in the first room. `sent`: what
// reached Discord; `schedulers`: the delivery engines run.
async function office(opts: { schedulers?: boolean } = {}) {
  const sent: string[] = [];
  const srv = await startTestServer({
    startServer: {
      pagerFetch: async (_url, init) => {
        sent.push(String(init.body));
        return new Response(null, { status: 204 });
      },
      ...(opts.schedulers
        ? {
            skipSchedulers: false,
            githubSyncFetch: async () => new Response(null, { status: 404 }),
          }
        : {}),
    },
  });
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const morganId = getUserByName("Morgan")!.id;
  const roomA = srv.agentManager.getRooms()[0].id;
  const bot = await srv.agentManager.spawn(
    "Bot",
    srv.workDir,
    "default",
    undefined,
    undefined,
    roomA,
    undefined,
    undefined,
    undefined,
    "Morgan",
    "claude",
    undefined,
    morganId,
  );
  if (!bot) throw new Error("spawn Bot failed");
  return { srv, s: morgan.rawSessionId, morganId, roomA, bot, sent };
}

type O = Awaited<ReturnType<typeof office>>;

// The older release's pages: open, acked (an 8-char id from before
// 2026-10), the office's own, one from an agent that is gone, and resolved
// ones in pager.json (its "resolved" message still owed) and the archive.
function oldPages(o: O): { live: PagerEntry[]; archived: PagerEntry[] } {
  const agentSource = {
    kind: "agent" as const,
    agentId: o.bot.id,
    name: "Bot",
    roomId: o.roomA,
  };
  const base = {
    source: agentSource,
    targetUserId: o.morganId,
    state: "open" as const,
    delivery: { state: "delivered" as const, sends: 2, lastAttemptAt: 150 },
  };
  return {
    live: [
      {
        ...base,
        id: "1111aaaa2222bbbb",
        createdAt: 100,
        lastRaisedAt: 300,
        raiseCount: 3,
        title: "Disk full",
        body: "90% on /var",
        key: "disk",
      },
      {
        ...base,
        id: "abcd1234",
        createdAt: 110,
        lastRaisedAt: 200,
        raiseCount: 1,
        title: "Box down",
        state: "acked",
        acked: { by: "Morgan", at: 210 },
      },
      {
        ...base,
        id: "3333cccc4444dddd",
        createdAt: 120,
        lastRaisedAt: 250,
        raiseCount: 1,
        source: {
          kind: "office",
          feature: "whatsapp",
          name: "WhatsApp",
          roomId: null,
        },
        title: "WhatsApp stopped",
        key: `whatsapp:${o.morganId}:dead`,
      },
      {
        ...base,
        id: "4444eeee5555ffff",
        createdAt: 130,
        lastRaisedAt: 130,
        raiseCount: 1,
        source: { ...agentSource, agentId: "gone-agent", name: "Old" },
        title: "Old news",
      },
      {
        ...base,
        id: "6666aaaa7777bbbb",
        createdAt: 140,
        lastRaisedAt: 140,
        raiseCount: 1,
        title: "Withdrawn",
        state: "resolved",
        resolved: { by: "Bot", at: 600 },
        delivery: { ...base.delivery, resolvedNotice: "pending" },
      },
    ],
    archived: [
      {
        ...base,
        id: "5555cccc6666dddd",
        createdAt: 90,
        lastRaisedAt: 90,
        raiseCount: 1,
        title: "Dismissed",
        state: "resolved",
        resolved: { by: "Morgan", at: 500 },
        delivery: { ...base.delivery, resolvedNotice: "done" },
      },
    ],
  };
}

const ids = (body: unknown) => (body as PagerEntry[]).map((e) => e.id);

describe("the pager migration at boot", () => {
  it("opens each live page as a paged ask with its id, closes the rest into the history, and never writes the old files", async () => {
    const o = await office();
    const { live, archived } = oldPages(o);
    const pagerPath = join(o.srv.stateRoot, "pager.json");
    const archivePath = join(o.srv.stateRoot, "pager-resolved.jsonl");
    writeFileSync(pagerPath, JSON.stringify(live, null, 2));
    writeFileSync(
      archivePath,
      archived.map((e) => JSON.stringify(e) + "\n").join(""),
    );
    const before = [readFileSync(pagerPath), readFileSync(archivePath)];

    const srv = await o.srv.restart();
    server = srv;
    const open = await api(srv, "/api/pager", o.s);
    expect(open.status).toBe(200);
    // Newest raise first.
    expect(ids(open.body)).toEqual([
      "1111aaaa2222bbbb",
      "3333cccc4444dddd",
      "abcd1234",
    ]);
    const disk = (open.body as PagerEntry[])[0];
    expect(disk).toMatchObject({
      createdAt: 100,
      lastRaisedAt: 300,
      raiseCount: 3,
      title: "Disk full",
      body: "90% on /var",
      key: "disk",
      state: "open",
      targetUserId: o.morganId,
    });
    expect(disk.delivery.sends).toBe(2);
    const acked = (open.body as PagerEntry[])[2];
    expect(acked).toMatchObject({
      state: "acked",
      acked: { by: "Morgan", at: 210 },
    });
    expect((open.body as PagerEntry[])[1].source.kind).toBe("office");

    const asks = (await api(srv, "/api/asks", o.s)).body as AskMemberWire[];
    const byPage = new Map(asks.map((a) => [a.page?.pageId, a]));
    expect(byPage.get("1111aaaa2222bbbb")).toMatchObject({
      id: disk.askId,
      prompt: "Disk full\n\n90% on /var",
      priority: "P1",
    });
    expect(byPage.get("abcd1234")?.page?.state).toBe("acked");
    expect(asks).toHaveLength(3);

    const closed = await api(srv, "/api/pager?state=resolved", o.s);
    const closedIds = ids(closed.body);
    expect([...closedIds].sort()).toEqual(
      ["4444eeee5555ffff", "5555cccc6666dddd", "6666aaaa7777bbbb"].sort(),
    );
    // In resolve order: the later resolve first.
    expect(closedIds.indexOf("6666aaaa7777bbbb")).toBeLessThan(
      closedIds.indexOf("5555cccc6666dddd"),
    );
    const withdrawn = (closed.body as PagerEntry[]).find(
      (e) => e.id === "6666aaaa7777bbbb",
    );
    expect(withdrawn?.resolved).toEqual({ by: "Bot", at: 600 });
    const dismissed = (closed.body as PagerEntry[]).find(
      (e) => e.id === "5555cccc6666dddd",
    );
    expect(dismissed?.resolved).toEqual({ by: "Morgan", at: 500 });

    // Read only.
    expect([readFileSync(pagerPath), readFileSync(archivePath)]).toEqual(
      before,
    );

    // A second boot changes nothing.
    const again = await srv.restart();
    server = again;
    const all = (await api(again, "/api/pager?state=all", o.s))
      .body as PagerEntry[];
    expect(all.map((e) => [e.id, e.askId, e.state, e.raiseCount])).toEqual(
      [...(open.body as PagerEntry[]), ...(closed.body as PagerEntry[])].map(
        (e) => [e.id, e.askId, e.state, e.raiseCount],
      ),
    );
    expect((await api(again, "/api/asks", o.s)).body).toHaveLength(3);
    expect([readFileSync(pagerPath), readFileSync(archivePath)]).toEqual(
      before,
    );

    // The old key still raises into the migrated page.
    const token = mintAgentToken(o.bot.id, o.morganId);
    const res = await again.http("/api/pager", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Disk full", key: "disk" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PagerEntry).raiseCount).toBe(4);
  });

  it("gives a paged ask from an older build a page id at boot, and keeps it", async () => {
    const o = await office();
    const token = mintAgentToken(o.bot.id, o.morganId);
    const made = await o.srv.http(`/api/agents/${o.bot.id}/asks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Restart the box?", page: true }),
    });
    expect(made.status).toBe(201);
    const askId = ((await made.json()) as AskMemberWire).id;
    // As a slice 1 or 2 build wrote it: no page id.
    const asksPath = join(o.srv.stateRoot, "asks.json");
    const stored = JSON.parse(readFileSync(asksPath, "utf-8")) as {
      id: string;
      page?: { pageId?: string };
    }[];
    for (const e of stored) delete e.page?.pageId;
    writeFileSync(asksPath, JSON.stringify(stored));

    const srv = await o.srv.restart();
    server = srv;
    const listed = await api(srv, "/api/pager", o.s);
    const [entry] = listed.body as PagerEntry[];
    expect(entry.askId).toBe(askId);
    expect(entry.id).toMatch(/^[0-9a-f]{16}$/);
    const again = await srv.restart();
    server = again;
    expect(ids((await api(again, "/api/pager", o.s)).body)).toEqual([entry.id]);
    const got = await api(again, `/api/pager/${entry.id}`, o.s);
    expect(got.status).toBe(200);
  });
});

describe("a migrated page's sends", () => {
  it("go on from its send record: a repeat due at boot goes out once the page is an ask", async () => {
    const o = await office({ schedulers: true });
    const saved = await o.srv.http("/api/users/Morgan/pager-settings", {
      method: "PATCH",
      rawSessionId: o.s,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookUrl:
          "https://discord.com/api/webhooks/123456789012345678/AbC-xyz",
        discordUserId: "112233445566778899",
      }),
    });
    expect(saved.status).toBe(200);
    // One open page, sent twice long ago: its next repeat is due.
    const [disk] = oldPages(o).live;
    writeFileSync(
      join(o.srv.stateRoot, "pager.json"),
      JSON.stringify([disk], null, 2),
    );
    expect(o.sent).toEqual([]);
    const srv = await o.srv.restart();
    server = srv;
    const deadline = Date.now() + 3000;
    while (o.sent.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(o.sent).toHaveLength(1);
    expect(o.sent[0]).toContain("Disk full");
    const got = await api(srv, `/api/pager/${disk.id}`, o.s);
    expect((got.body as PagerEntry).delivery.sends).toBe(3);
  });
});
