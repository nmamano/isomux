// Push device routes (opIds pushDevices.*) and Web Push delivery through the
// real route table and server.
//
// Pins: the member and their own API token turn devices on, list, test and
// remove them; no agent token and no other member does; no response carries
// an endpoint; the keys and devices live in a 0600 file; a page an agent
// raises reaches the member's device with no Discord set up, and not when
// the page's room has notifications off; deleting the member removes their
// devices.
//
// Seam: startTestServer() with stub pagerFetch and webPushFetch. Zero LLM,
// no push service.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { base64UrlDecode, base64UrlEncode } from "../../shared/web-push.ts";
import type {
  ApiTokenCreateRes,
  PushDevice,
  PushDevicesRes,
} from "../../shared/contract-shapes.ts";

const ENDPOINT = "https://web.push.apple.com/QGuQyavXutnMH8Ac8ZyO1M3d-secret";
const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SUBSCRIBE = { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } };

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
  text: string;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function office() {
  const pushed: string[] = [];
  const discord: string[] = [];
  const srv = await startTestServer({
    startServer: {
      pagerFetch: async (url) => {
        discord.push(url);
        return new Response(null, { status: 204 });
      },
      webPushFetch: async (url) => {
        pushed.push(url);
        return new Response(null, { status: 201 });
      },
    },
  });
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const bossId = getUserByName("Boss")!.id;
  const agent = await srv.agentManager.spawn(
    "Bot",
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
  const botToken = mintAgentToken(agent.id, bossId);
  const path = `/api/users/${boss.username}/push-devices`;
  return { srv, boss, bossId, mia, roomA, botToken, pushed, discord, path };
}

describe("push devices REST: access", () => {
  it("the member turns a device on, lists, tests and removes it; no endpoint leaves the server", async () => {
    const { srv, boss, path, pushed } = await office();
    const first = await api(srv, path, { rawSessionId: boss.rawSessionId });
    expect(first.status).toBe(200);
    const empty = first.body as PushDevicesRes;
    expect(empty.devices).toEqual([]);
    expect(empty.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

    const added = await api(srv, path, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
      body: { ...SUBSCRIBE, label: "iPhone" },
    });
    expect(added.status).toBe(200);
    const device = added.body as PushDevice;
    expect(device.label).toBe("iPhone");
    expect(added.text).not.toContain("secret");

    const listed = await api(srv, path, { rawSessionId: boss.rawSessionId });
    expect((listed.body as PushDevicesRes).devices).toEqual([device]);
    // The key pair stays the same.
    expect((listed.body as PushDevicesRes).publicKey).toBe(empty.publicKey);
    expect(listed.text).not.toContain("secret");

    const tested = await api(srv, `${path}/${device.id}/test`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(tested.body).toEqual({ delivered: true });
    expect(pushed).toEqual([ENDPOINT]);

    const file = join(srv.stateRoot, "web-push.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(ENDPOINT);

    const removed = await api(srv, `${path}/${device.id}`, {
      method: "DELETE",
      rawSessionId: boss.rawSessionId,
    });
    expect(removed.status).toBe(204);
    const after = await api(srv, path, { rawSessionId: boss.rawSessionId });
    expect((after.body as PushDevicesRes).devices).toEqual([]);
    const again = await api(srv, `${path}/${device.id}`, {
      method: "DELETE",
      rawSessionId: boss.rawSessionId,
    });
    expect(again.status).toBe(404);
  });

  it("refuses an endpoint that is not a browser push service", async () => {
    const { srv, boss, path } = await office();
    const r = await api(srv, path, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
      body: { ...SUBSCRIBE, endpoint: "https://127.0.0.1:4000/api/agents" },
    });
    expect(r.status).toBe(422);
  });

  it("refuses a device key that is not on the P-256 curve", async () => {
    const { srv, boss, path } = await office();
    // Right length and prefix, last byte changed: off the curve.
    const bytes = base64UrlDecode(P256DH)!;
    bytes[64] ^= 1;
    const off = base64UrlEncode(bytes);
    const r = await api(srv, path, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
      body: { ...SUBSCRIBE, keys: { p256dh: off, auth: AUTH } },
    });
    expect(r.status).toBe(422);
    const list = await api(srv, path, { rawSessionId: boss.rawSessionId });
    expect((list.body as PushDevicesRes).devices).toEqual([]);
  });

  it("the member's own API token reaches the devices", async () => {
    const { srv, boss, path } = await office();
    const minted = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", expiresInDays: 30 }),
      rawSessionId: boss.rawSessionId,
    });
    const { token } = (await minted.json()) as ApiTokenCreateRes;
    expect((await api(srv, path, { bearer: token })).status).toBe(200);
  });

  it("no agent token and no other member reaches the devices", async () => {
    const { srv, boss, mia, botToken, path, pushed } = await office();
    const device = (
      await api(srv, path, {
        method: "POST",
        rawSessionId: boss.rawSessionId,
        body: SUBSCRIBE,
      })
    ).body as PushDevice;
    for (const who of [
      { bearer: botToken },
      { rawSessionId: mia.rawSessionId },
    ]) {
      for (const [method, p, body] of [
        ["GET", path, undefined],
        ["POST", path, SUBSCRIBE],
        ["DELETE", `${path}/${device.id}`, undefined],
        ["POST", `${path}/${device.id}/test`, undefined],
      ] as const) {
        const r = await api(srv, p, { method, body, ...who });
        expect(r.status).toBe(403);
      }
    }
    // Mia's own route cannot reach Boss's device either.
    const miaPath = `/api/users/${mia.username}/push-devices`;
    const r = await api(srv, `${miaPath}/${device.id}/test`, {
      method: "POST",
      rawSessionId: mia.rawSessionId,
    });
    expect(r.status).toBe(404);
    expect(pushed).toHaveLength(0);
  });
});

describe("push devices REST: delivery", () => {
  it("a raised page reaches the device with no Discord set up, whatever the member's notification rooms", async () => {
    const { srv, boss, bossId, roomA, botToken, path, pushed, discord } =
      await office();
    await api(srv, path, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
      body: SUBSCRIBE,
    });
    expect(getUserByName("Boss")!.notifRooms).toContain(roomA);
    const raised = await api(srv, "/api/pager", {
      method: "POST",
      bearer: botToken,
      body: { title: "Disk full" },
    });
    expect(raised.status).toBe(201);
    await sleep(50);
    expect(pushed).toEqual([ENDPOINT]);
    expect(discord).toHaveLength(0);

    updateUserById(bossId, { notifRooms: [] });
    expect(getUserByName("Boss")!.notifRooms).not.toContain(roomA);
    await api(srv, "/api/pager", {
      method: "POST",
      bearer: botToken,
      body: { title: "CPU hot", key: "cpu" },
    });
    await sleep(50);
    // A page ignores the room filter (PM ruling, 2026-10-16).
    expect(pushed).toHaveLength(2);
  });

  it("deleting the member removes their devices", async () => {
    const { srv, boss, mia } = await office();
    const miaPath = `/api/users/${mia.username}/push-devices`;
    await api(srv, miaPath, {
      method: "POST",
      rawSessionId: mia.rawSessionId,
      body: SUBSCRIBE,
    });
    const file = join(srv.stateRoot, "web-push.json");
    expect(readFileSync(file, "utf8")).toContain(ENDPOINT);
    const del = await api(srv, `/api/users/${mia.username}`, {
      method: "DELETE",
      rawSessionId: boss.rawSessionId,
    });
    expect(del.status).toBeLessThan(300);
    expect(readFileSync(file, "utf8")).not.toContain(ENDPOINT);
  });
});
