// The turn-end push through the real server (task 1eda8af8): a turn that a
// member started and the agent finished pushes to the devices of members
// who turned the option on, the same turns that sound the browser's
// turn-end sound.
//
// Pins: a member's message whose turn ends pushes once to a member with the
// option on and the room in their notification rooms; with the option off,
// nothing; a turn started by another agent, nothing; a member who cannot see
// the room gets nothing even with the room in a stale notifRooms; the option
// saves through PATCH /api/me/preferences.
//
// Seam: startTestServer() with an auto-completing FakeBackend and a stub
// webPushFetch. Zero LLM, no push service.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";

const ENDPOINT = "https://web.push.apple.com/turn-end-phone";
const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

async function office(opts: { turnEndPush: boolean }) {
  const pushed: string[] = [];
  const srv = await startTestServer({
    fakeBackend: new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
    startServer: {
      webPushFetch: async (url) => {
        pushed.push(url);
        return new Response(null, { status: 201 });
      },
    },
  });
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const bossId = getUserByName("Boss")!.id;
  const roomA = srv.agentManager.getRooms()[0].id;
  const spawn = async (name: string) => {
    const agent = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      roomA,
      undefined,
      undefined,
      undefined,
      "Boss",
      "claude",
      undefined,
      bossId,
    );
    if (!agent) throw new Error("spawn returned null");
    return agent;
  };
  const bot = await spawn("Bot");
  const http = (
    path: string,
    method: string,
    body?: unknown,
    bearer?: string,
  ) =>
    srv.http(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      rawSessionId: bearer ? undefined : boss.rawSessionId,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const added = await http(`/api/users/${boss.username}/push-devices`, "POST", {
    endpoint: ENDPOINT,
    keys: { p256dh: P256DH, auth: AUTH },
  });
  expect(added.status).toBe(200);
  const saved = await http("/api/me/preferences", "PATCH", {
    turnEndPush: opts.turnEndPush,
  });
  expect(saved.status).toBe(204);
  expect(getUserByName("Boss")!.turnEndPush === true).toBe(opts.turnEndPush);
  expect(getUserByName("Boss")!.notifRooms).toContain(roomA);
  const stateOf = (id: string) =>
    srv.agentManager.getAgent(id)?.state ?? "missing";
  return { srv, bot, spawn, http, pushed, stateOf, roomA };
}

describe("turn-end push", () => {
  it("a member's turn that ends pushes once to a member with the option on", async () => {
    const { bot, http, pushed, stateOf } = await office({ turnEndPush: true });
    const res = await http(`/api/agents/${bot.id}/messages`, "POST", {
      text: "hello",
    });
    expect(res.status).toBeLessThan(300);
    await waitUntil(() => pushed.length === 1);
    expect(stateOf(bot.id)).not.toBe("thinking");
    await sleep(50);
    expect(pushed).toEqual([ENDPOINT]);
  });

  it("a member who cannot see the room gets nothing, even with it in a stale notifRooms", async () => {
    const { srv, bot, http, pushed, roomA } = await office({
      turnEndPush: true,
    });
    const mia = await srv.seedMember("Mia");
    const miaHttp = (path: string, method: string, body: unknown) =>
      srv.http(path, {
        method,
        headers: { "Content-Type": "application/json" },
        rawSessionId: mia.rawSessionId,
        body: JSON.stringify(body),
      });
    const miaEndpoint = "https://web.push.apple.com/mia-phone";
    expect(
      (
        await miaHttp(`/api/users/${mia.username}/push-devices`, "POST", {
          endpoint: miaEndpoint,
          keys: { p256dh: P256DH, auth: AUTH },
        })
      ).status,
    ).toBe(200);
    expect(
      (await miaHttp("/api/me/preferences", "PATCH", { turnEndPush: true }))
        .status,
    ).toBe(204);
    // Around the clamp, like a stale users.json: the room is in her
    // notification rooms, but she has no access to it.
    const miaRecord = getUserByName("Mia")!;
    updateUserById(miaRecord.id, { notifRooms: [roomA] });
    expect(getUserByName("Mia")!.notifRooms).toContain(roomA);
    expect(getUserByName("Mia")!.allowedRooms).not.toContain(roomA);
    expect(getUserByName("Mia")!.turnEndPush).toBe(true);

    await http(`/api/agents/${bot.id}/messages`, "POST", { text: "hello" });
    await waitUntil(() => pushed.length >= 1);
    await sleep(50);
    expect(pushed).toEqual([ENDPOINT]);
  });

  it("with the option off, a turn end pushes nothing", async () => {
    const { bot, http, pushed, stateOf } = await office({ turnEndPush: false });
    await http(`/api/agents/${bot.id}/messages`, "POST", { text: "hello" });
    await waitUntil(() => stateOf(bot.id) === "waiting_for_response");
    await sleep(50);
    expect(pushed).toEqual([]);
  });

  it("a turn another agent started pushes nothing", async () => {
    const { bot, spawn, http, pushed, stateOf } = await office({
      turnEndPush: true,
    });
    const sender = await spawn("Sender");
    const res = await http(
      `/api/agents/${bot.id}/messages`,
      "POST",
      { text: "ping" },
      getAgentTokenRaw(sender.id)!,
    );
    expect(res.status).toBeLessThan(300);
    // The agent-started turn ran: its human-input flag is false.
    await waitUntil(
      () =>
        stateOf(bot.id) === "waiting_for_response" &&
        server!.agentManager.getAgent(bot.id)?.turnHadHumanInput === false,
    );
    await sleep(50);
    expect(pushed).toEqual([]);
  });
});
