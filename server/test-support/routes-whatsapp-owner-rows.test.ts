// Whose agent a WhatsApp row may reach (task 0b53ff37), through the real
// server: an agent the member manages, or any agent for an office owner. A
// row of an owner to another member's agent delivers, and that agent's reply
// is a draft in the owner's Inbox; when the owner is no longer an owner, the
// row is dead.
//
// Seam: startTestServer(). A link file written after boot links the member
// with no bridge.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { writeLink } from "../whatsapp/store.ts";
import { writeRoutes } from "../whatsapp/routes-store.ts";
import type { AgentInfo } from "../../shared/types.ts";
import type { WhatsAppRoute } from "../../shared/whatsapp.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const GROUP = "120363000000000001@g.us";

async function api(
  srv: TestServer,
  path: string,
  rawSessionId: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers:
      init.body !== undefined ? { "Content-Type": "application/json" } : {},
    rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Morgan and Dana own the office; Casey is a member with its first room.
async function office() {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  const dana = await srv.seedMember("Dana");
  const casey = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  // Dana becomes the second owner.
  expect(
    (
      await api(srv, `/api/users/${dana.username}`, morgan.rawSessionId, {
        method: "PATCH",
        body: { role: "owner" },
      })
    ).status,
  ).toBe(200);
  const ids = {
    morgan: getUserByName(morgan.username)!.id,
    casey: getUserByName(casey.username)!.id,
  };
  expect(
    (
      await api(
        srv,
        `/api/users/${casey.username}/access`,
        morgan.rawSessionId,
        {
          method: "PUT",
          body: { allowedRooms: [room] },
        },
      )
    ).status,
  ).toBe(200);
  const spawn = async (name: string, who: "morgan" | "casey") => {
    const user = who === "morgan" ? morgan : casey;
    const a = await srv.agentManager.spawn(
      name,
      srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      user.username,
      "claude",
      undefined,
      ids[who],
    );
    if (!a) throw new Error(`spawn ${name} failed`);
    return a;
  };
  const linkOf = (
    userId: string,
    phone: string,
    routes: WhatsAppRoute[] = [],
  ) => {
    writeLink(srv.stateRoot, userId, { phone, linkedAt: Date.now() });
    writeRoutes(srv.stateRoot, userId, { phone, routes });
  };
  return { srv, morgan, dana, casey, ids, spawn, linkOf };
}

const row = (id: string, agent: AgentInfo): WhatsAppRoute => ({
  id,
  chat: GROUP,
  group: true,
  name: "Akido",
  agentId: agent.id,
  trigger: "mention",
  createdAt: 1,
});

const deadOf = async (o: Awaited<ReturnType<typeof office>>, session: string) =>
  (
    (await api(o.srv, "/api/whatsapp/routes", session)).body as WhatsAppRoute[]
  ).map((r) => [r.id, r.dead ?? null]);

describe("a row's agent", () => {
  it("an owner adds a row to another member's agent and it stays live; a member cannot add one to an owner's agent", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const helper = await o.spawn("Helper", "morgan");
    o.linkOf(o.ids.morgan, "447700900111");
    o.linkOf(o.ids.casey, "447700900222");

    const added = await api(
      o.srv,
      "/api/whatsapp/routes",
      o.morgan.rawSessionId,
      {
        method: "POST",
        body: { chat: GROUP, name: "Akido", agentId: pm.id },
      },
    );
    expect(added.status).toBe(200);
    const id = (added.body as WhatsAppRoute).id;
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([[id, null]]);

    const refused = await api(
      o.srv,
      "/api/whatsapp/routes",
      o.casey.rawSessionId,
      {
        method: "POST",
        body: { chat: GROUP, name: "Akido", agentId: helper.id },
      },
    );
    expect(refused.status).toBe(400);
    expect(await deadOf(o, o.casey.rawSessionId)).toEqual([]);
  });

  it("an owner's row to another member's agent goes dead when the owner becomes a member; the row to their own agent stays live", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const helper = await o.spawn("Helper", "morgan");
    o.linkOf(o.ids.morgan, "447700900111", [
      row("r1", pm),
      { ...row("r2", helper), chat: "120363000000000002@g.us" },
    ]);
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([
      ["r1", null],
      ["r2", null],
    ]);
    const demoted = await api(
      o.srv,
      `/api/users/${o.morgan.username}`,
      o.dana.rawSessionId,
      {
        method: "PATCH",
        body: { role: "member" },
      },
    );
    expect(demoted.status).toBe(200);
    expect(await deadOf(o, o.morgan.rawSessionId)).toEqual([
      ["r1", "agent_not_yours"],
      ["r2", null],
    ]);
  });
});

describe("a reply on an owner's row to another member's agent", () => {
  it("is a draft in the owner's Inbox; another agent of the same manager gets 404", async () => {
    const o = await office();
    const pm = await o.spawn("PM", "casey");
    const other = await o.spawn("Other", "casey");
    o.linkOf(o.ids.morgan, "447700900111", [row("r1", pm)]);
    // Casey has a link and no row: the PM's manager holds no r1.
    o.linkOf(o.ids.casey, "447700900222");

    const post = (agent: AgentInfo) =>
      o.srv.http("/api/messaging/routes/r1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${mintAgentToken(agent.id, o.ids.casey)}`,
        },
        body: "Read it, thanks.",
      });
    const asksOf = async (session: string) =>
      (
        (await api(o.srv, "/api/asks", session)).body as {
          agentId: string;
          memberUserId: string;
        }[]
      ).map((e) => [e.agentId, e.memberUserId]);

    expect((await post(other)).status).toBe(404);
    expect(await asksOf(o.morgan.rawSessionId)).toEqual([]);

    const drafted = await post(pm);
    expect(drafted.status).toBe(202);
    expect(await asksOf(o.morgan.rawSessionId)).toEqual([
      [pm.id, o.ids.morgan],
    ]);
    expect(await asksOf(o.casey.rawSessionId)).toEqual([]);
  });
});
