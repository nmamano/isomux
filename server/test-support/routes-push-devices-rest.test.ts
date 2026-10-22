// Push device routes (opIds pushDevices.*) and Web Push delivery through the
// real route table and server.
//
// Pins: the member and their own API token turn devices on, list, test and
// remove them; no agent token and no other member does; no response carries
// an endpoint; the keys and devices live in a 0600 file; a page an agent
// raises reaches the member's device with no Discord set up; deleting the
// member removes their devices.
//
// Seam: startTestServer() with stub pagerFetch and webPushFetch. Zero LLM,
// no push service.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
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

async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
  const morgan = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  const roomA = srv.agentManager.getRooms()[0].id;
  const morganId = getUserByName("Morgan")!.id;
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
    "Morgan",
    "claude",
    undefined,
    morganId,
  );
  if (!agent) throw new Error("spawn returned null");
  const botToken = mintAgentToken(agent.id, morganId);
  const path = `/api/users/${morgan.username}/push-devices`;
  return { srv, morgan, mia, botToken, pushed, discord, path };
}

describe("push devices REST: access", () => {
  it("the member turns a device on, lists, tests and removes it; no endpoint leaves the server; a bad endpoint or key is refused", async () => {
    const { srv, morgan, path, pushed } = await office();
    // Not a browser push service, and a key off the P-256 curve (right length
    // and prefix, last byte changed): both refused, nothing stored.
    const bytes = base64UrlDecode(P256DH)!;
    bytes[64] ^= 1;
    for (const body of [
      { ...SUBSCRIBE, endpoint: "https://127.0.0.1:4000/api/agents" },
      { ...SUBSCRIBE, keys: { p256dh: base64UrlEncode(bytes), auth: AUTH } },
    ]) {
      const r = await api(srv, path, {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
        body,
      });
      expect(r.status).toBe(422);
    }

    const first = await api(srv, path, { rawSessionId: morgan.rawSessionId });
    expect(first.status).toBe(200);
    const empty = first.body as PushDevicesRes;
    expect(empty.devices).toEqual([]);
    expect(empty.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

    const added = await api(srv, path, {
      method: "POST",
      rawSessionId: morgan.rawSessionId,
      body: { ...SUBSCRIBE, label: "iPhone" },
    });
    expect(added.status).toBe(200);
    const device = added.body as PushDevice;
    expect(device.label).toBe("iPhone");
    expect(added.text).not.toContain("secret");

    const listed = await api(srv, path, { rawSessionId: morgan.rawSessionId });
    expect((listed.body as PushDevicesRes).devices).toEqual([device]);
    // The key pair stays the same.
    expect((listed.body as PushDevicesRes).publicKey).toBe(empty.publicKey);
    expect(listed.text).not.toContain("secret");

    const tested = await api(srv, `${path}/${device.id}/test`, {
      method: "POST",
      rawSessionId: morgan.rawSessionId,
    });
    expect(tested.body).toEqual({ delivered: true });
    expect(pushed).toEqual([ENDPOINT]);

    const file = join(srv.stateRoot, "web-push.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(ENDPOINT);

    const removed = await api(srv, `${path}/${device.id}`, {
      method: "DELETE",
      rawSessionId: morgan.rawSessionId,
    });
    expect(removed.status).toBe(204);
    const after = await api(srv, path, { rawSessionId: morgan.rawSessionId });
    expect((after.body as PushDevicesRes).devices).toEqual([]);
    const again = await api(srv, `${path}/${device.id}`, {
      method: "DELETE",
      rawSessionId: morgan.rawSessionId,
    });
    expect(again.status).toBe(404);
  });

  it("the member's own API token reaches the devices", async () => {
    const { srv, morgan, path } = await office();
    const minted = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", expiresInDays: 30 }),
      rawSessionId: morgan.rawSessionId,
    });
    const { token } = (await minted.json()) as ApiTokenCreateRes;
    expect((await api(srv, path, { bearer: token })).status).toBe(200);
  });

  it("no agent token and no other member reaches the devices; deleting a member removes theirs", async () => {
    const { srv, morgan, mia, botToken, path, pushed } = await office();
    const device = (
      await api(srv, path, {
        method: "POST",
        rawSessionId: morgan.rawSessionId,
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
    // Mia's own route cannot reach Morgan's device either.
    const miaPath = `/api/users/${mia.username}/push-devices`;
    const r = await api(srv, `${miaPath}/${device.id}/test`, {
      method: "POST",
      rawSessionId: mia.rawSessionId,
    });
    expect(r.status).toBe(404);
    expect(pushed).toHaveLength(0);

    // Deleting Mia takes her device off the disk and leaves Morgan's.
    const miaEndpoint = `${ENDPOINT}-mia`;
    await api(srv, miaPath, {
      method: "POST",
      rawSessionId: mia.rawSessionId,
      body: { ...SUBSCRIBE, endpoint: miaEndpoint },
    });
    const file = join(srv.stateRoot, "web-push.json");
    expect(readFileSync(file, "utf8")).toContain(miaEndpoint);
    const del = await api(srv, `/api/users/${mia.username}`, {
      method: "DELETE",
      rawSessionId: morgan.rawSessionId,
    });
    expect(del.status).toBeLessThan(300);
    expect(readFileSync(file, "utf8")).not.toContain(miaEndpoint);
    expect(readFileSync(file, "utf8")).toContain(ENDPOINT);
  });
});

// The room filter on a page is web-push-delivery.test.ts ("goes for every
// page, whatever the member's notification rooms"); this is the wiring.
describe("push devices REST: delivery", () => {
  it("a raised page reaches the device with no Discord set up", async () => {
    const { srv, morgan, botToken, path, pushed, discord } = await office();
    await api(srv, path, {
      method: "POST",
      rawSessionId: morgan.rawSessionId,
      body: SUBSCRIBE,
    });
    const raised = await api(srv, "/api/pager", {
      method: "POST",
      bearer: botToken,
      body: { title: "Disk full" },
    });
    expect(raised.status).toBe(201);
    await waitFor(() => pushed.length > 0);
    expect(pushed).toEqual([ENDPOINT]);
    expect(discord).toHaveLength(0);
  });
});
