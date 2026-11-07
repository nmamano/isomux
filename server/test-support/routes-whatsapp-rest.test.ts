// WhatsApp link routes (opIds whatsapp.*, task d03a61d8) through the real
// route table and server: the member's own status, and a link refused before
// anything is downloaded. Who may call them is pinned in routes-table.test.ts;
// the link flow itself in server/whatsapp/supervisor.test.ts. A reply draft
// (slice 2b) end to end: the row's agent drafts, the member answers in the
// Inbox; what each answer sends is server/whatsapp/replies.test.ts.
//
// Seam: startTestServer(). No member is linked at boot, so no bridge starts.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { readRoutes, writeRoutes } from "../whatsapp/routes-store.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

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
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("whatsapp routes", () => {
  it("a member reads their own status; a bad number is refused before any download", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");

    expect(await api(srv, "/api/whatsapp", mia.rawSessionId)).toEqual({
      status: 200,
      body: { state: "unlinked" },
    });

    const bad = await api(srv, "/api/whatsapp/link", mia.rawSessionId, {
      method: "POST",
      body: { method: "code", phone: "12345" },
    });
    expect(bad.status).toBe(400);
    expect(existsSync(join(srv.stateRoot, "whatsapp", "runtime"))).toBe(false);
    expect((await api(srv, "/api/whatsapp", mia.rawSessionId)).body).toEqual({
      state: "unlinked",
    });
  });

  it("a member's rows and chats: empty, a row refused while not linked, an unknown row 404 (slice 2)", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    for (const path of ["/api/whatsapp/routes", "/api/whatsapp/chats"])
      expect(await api(srv, path, mia.rawSessionId)).toEqual({
        status: 200,
        body: [],
      });
    const created = await api(srv, "/api/whatsapp/routes", mia.rawSessionId, {
      method: "POST",
      body: { phone: "+44 7700 900123", name: "Mom", agentId: "agent-x" },
    });
    expect(created.status).toBe(400);
    expect(
      (
        await api(srv, "/api/whatsapp/routes/r-none", mia.rawSessionId, {
          method: "PATCH",
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(srv, "/api/whatsapp/routes/r-none", mia.rawSessionId, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(srv, "/api/whatsapp/routes", mia.rawSessionId)).body,
    ).toEqual([]);
  });
});

describe("a reply draft (slice 2b)", () => {
  it("the row's agent drafts in plain text; another agent gets 404 and a member 403; only the member's browser answers, and with no link a Send is 502 and the ask stays", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const spawn = async (name: string) => {
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
        owner.username,
        "claude",
        undefined,
        ownerId,
      );
      if (!a) throw new Error(`spawn ${name} failed`);
      return a;
    };
    const helper = await spawn("Helper");
    const other = await spawn("Other");
    // The rows are read from disk at each call; no link, so no bridge runs.
    writeRoutes(srv.stateRoot, ownerId, {
      phone: "447700900111",
      routes: [
        {
          id: "r1",
          chat: "447700900123@s.whatsapp.net",
          group: false,
          name: "Mom",
          agentId: helper.id,
          createdAt: 1,
        },
      ],
    });
    const path = "/api/messaging/routes/r1/messages";
    const post = (auth: { bearer: string } | { rawSessionId: string }) =>
      srv.http(path, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          ...("bearer" in auth
            ? { Authorization: `Bearer ${auth.bearer}` }
            : {}),
        },
        ...("rawSessionId" in auth ? { rawSessionId: auth.rawSessionId } : {}),
        body: "see you at 5",
      });
    const asks = async () =>
      (await api(srv, "/api/asks", owner.rawSessionId)).body as {
        id: string;
        agentId: string;
      }[];

    expect(
      (await post({ bearer: mintAgentToken(other.id, ownerId) })).status,
    ).toBe(404);
    expect((await post({ rawSessionId: owner.rawSessionId })).status).toBe(403);
    expect(await asks()).toEqual([]);

    const drafted = await post({ bearer: mintAgentToken(helper.id, ownerId) });
    expect(drafted.status).toBe(202);
    const { askId, status } = (await drafted.json()) as {
      askId: string;
      status: string;
    };
    expect(status).toBe("waiting_for_member");
    expect((await asks()).map((e) => [e.id, e.agentId])).toEqual([
      [askId, helper.id],
    ]);

    // The member's own API token cannot answer it.
    const minted = await api(srv, "/api/me/api-tokens", owner.rawSessionId, {
      method: "POST",
      body: { name: "Laptop", expiresInDays: 30 },
    });
    const apiToken = (minted.body as { token: string }).token;
    const byToken = await srv.http(`/api/asks/${askId}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ text: "Send" }),
    });
    expect(byToken.status).toBe(404);

    const reply = (text: string) =>
      api(srv, `/api/asks/${askId}/reply`, owner.rawSessionId, {
        method: "POST",
        body: { text },
      });
    expect((await reply("Send")).status).toBe(502);
    expect((await asks()).map((e) => e.id)).toEqual([askId]);
    expect((await reply("Don't send")).status).toBe(204);
    expect(await asks()).toEqual([]);
  });
});

// The Send step is optional per row (task 70fae82c). Turning it off removes
// the member's approval, so only what may answer a draft may turn it off:
// the member's browser session. The row's agent and the member's API token
// cannot.
describe("send at once (task 70fae82c)", () => {
  it("only the member's browser session turns the Send step off; then the row's agent sends at once, and with no link that is 502 with no ask", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const helper = await srv.agentManager.spawn(
      "Helper",
      srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      owner.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!helper) throw new Error("spawn failed");
    const row = {
      id: "r1",
      chat: "447700900123@s.whatsapp.net",
      group: false,
      name: "Mom",
      agentId: helper.id,
      createdAt: 1,
    };
    writeRoutes(srv.stateRoot, ownerId, {
      phone: "447700900111",
      routes: [row],
    });
    const minted = await api(srv, "/api/me/api-tokens", owner.rawSessionId, {
      method: "POST",
      body: { name: "Laptop", expiresInDays: 30 },
    });
    const apiToken = (minted.body as { token: string }).token;
    const agentToken = mintAgentToken(helper.id, ownerId);
    const call = (
      bearer: string,
      method: string,
      path: string,
      body: unknown,
    ) =>
      srv.http(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      });

    for (const [who, bearer] of [
      ["agent", agentToken],
      ["api token", apiToken],
    ] as const) {
      const patch = await call(bearer, "PATCH", "/api/whatsapp/routes/r1", {
        sendDirect: true,
      });
      expect([who, patch.status >= 400]).toEqual([who, true]);
      const create = await call(bearer, "POST", "/api/whatsapp/routes", {
        phone: "+44 7700 900124",
        name: "Dad",
        agentId: helper.id,
        sendDirect: true,
      });
      expect([who, create.status >= 400]).toEqual([who, true]);
    }
    expect(readRoutes(srv.stateRoot, ownerId).routes).toEqual([row]);

    // The condition: the member's browser session does turn it off.
    const byMember = await api(
      srv,
      "/api/whatsapp/routes/r1",
      owner.rawSessionId,
      { method: "PATCH", body: { sendDirect: true, prefix: "[Agent]:" } },
    );
    expect(byMember.status).toBe(200);
    expect(readRoutes(srv.stateRoot, ownerId).routes).toEqual([
      { ...row, sendDirect: true, prefix: "[Agent]:" },
    ]);

    const sent = await srv.http("/api/messaging/routes/r1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${agentToken}`,
      },
      body: "see you at 5",
    });
    expect(sent.status).toBe(502);
    expect(
      ((await sent.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("messaging_not_linked");
    expect((await api(srv, "/api/asks", owner.rawSessionId)).body).toEqual([]);
  });
});

// Own messages (task 610f7756): a chat setting like the others, set only by
// the member's browser session.
describe("own messages (task 610f7756)", () => {
  it("the member's session turns own messages on and off; the row's agent cannot", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const helper = await srv.agentManager.spawn(
      "Helper",
      srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      owner.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!helper) throw new Error("spawn failed");
    const row = {
      id: "r1",
      chat: "447700900111@s.whatsapp.net",
      group: false,
      name: "+447700900111",
      agentId: helper.id,
      createdAt: 1,
    };
    writeRoutes(srv.stateRoot, ownerId, {
      phone: "447700900111",
      routes: [row],
    });
    const byAgent = await srv.http("/api/whatsapp/routes/r1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mintAgentToken(helper.id, ownerId)}`,
      },
      body: JSON.stringify({ ownMessages: true }),
    });
    expect(byAgent.status >= 400).toBe(true);
    expect(readRoutes(srv.stateRoot, ownerId).routes).toEqual([row]);

    const patch = (ownMessages: unknown) =>
      api(srv, "/api/whatsapp/routes/r1", owner.rawSessionId, {
        method: "PATCH",
        body: { ownMessages },
      });
    expect((await patch(true)).status).toBe(200);
    expect(readRoutes(srv.stateRoot, ownerId).routes).toEqual([
      { ...row, ownMessages: true },
    ]);
    expect((await patch("yes")).status).toBe(400);
    expect((await patch(false)).status).toBe(200);
    expect(readRoutes(srv.stateRoot, ownerId).routes).toEqual([row]);
  });
});
