// Pager settings routes (opIds pagerSettings.*) and Discord delivery through
// the real route table and server.
//
// Pins: the member and their own API token read and change their settings;
// no agent token and no other member does; only Discord webhook URLs save;
// the URL leaves the server only in its masked form (responses, socket
// events, the agent's env); a raised page reaches the webhook with the
// mention and a link to the page; ack stops it.
//
// Seam: startTestServer() with a stub pagerFetch. Zero LLM, no Discord.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import type { PagerEntry } from "../../shared/types.ts";
import type {
  ApiTokenCreateRes,
  PagerSettingsRes,
} from "../../shared/contract-shapes.ts";

const TOKEN = "SeCrEt_WeBhOoK-tOkEn9876";
const URL_ = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const DISCORD_ID = "112233445566778899";

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

interface Sent {
  url: string;
  body: {
    content: string;
    allowed_mentions: unknown;
    embeds?: Array<{ url: string }>;
  };
}

async function office() {
  const sent: Sent[] = [];
  const srv = await startTestServer({
    startServer: {
      pagerFetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body as string) });
        return new Response(null, { status: 204 });
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
  const settingsPath = `/api/users/${boss.username}/pager-settings`;
  return { srv, boss, mia, agent, botToken, sent, settingsPath };
}

describe("pager settings REST: access", () => {
  it("the member reads defaults and saves; responses carry only the mask", async () => {
    const { srv, boss, settingsPath } = await office();
    const first = await api(srv, settingsPath, {
      rawSessionId: boss.rawSessionId,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      webhookUrlMasked: null,
      discordUserId: null,
      repeatMinutes: 5,
    });
    const saved = await api(srv, settingsPath, {
      method: "PATCH",
      rawSessionId: boss.rawSessionId,
      body: { webhookUrl: URL_, discordUserId: DISCORD_ID },
    });
    expect(saved.status).toBe(200);
    const res = saved.body as PagerSettingsRes;
    expect(res.webhookUrlMasked).not.toBeNull();
    expect(res.discordUserId).toBe(DISCORD_ID);
    expect(saved.text).not.toContain(TOKEN);
    const read = await api(srv, settingsPath, {
      rawSessionId: boss.rawSessionId,
    });
    expect(read.body).toEqual(res);
    expect(read.text).not.toContain(TOKEN);
    // A partial save keeps the URL.
    const interval = await api(srv, settingsPath, {
      method: "PATCH",
      rawSessionId: boss.rawSessionId,
      body: { repeatMinutes: null },
    });
    expect(interval.body).toEqual({ ...res, repeatMinutes: null });
    // Its own 0600 file, and not the env injected into agents.
    const file = join(srv.stateRoot, "pager-settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(TOKEN);
    const env = await api(srv, `/api/users/${boss.username}/env`, {
      rawSessionId: boss.rawSessionId,
    });
    expect(env.status).toBe(200);
    expect(env.text).not.toContain(TOKEN);
  });

  it("the member's own API token reaches the settings", async () => {
    const { srv, boss, settingsPath } = await office();
    const minted = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", expiresInDays: 30 }),
      rawSessionId: boss.rawSessionId,
    });
    const { token } = (await minted.json()) as ApiTokenCreateRes;
    const r = await api(srv, settingsPath, { bearer: token });
    expect(r.status).toBe(200);
  });

  it("no agent token reaches the settings, not even the manager's own", async () => {
    const { srv, botToken, settingsPath, sent } = await office();
    for (const [method, path, body] of [
      ["GET", settingsPath, undefined],
      ["PATCH", settingsPath, { webhookUrl: URL_ }],
      ["POST", `${settingsPath}/test`, {}],
    ] as const) {
      const r = await api(srv, path, { method, bearer: botToken, body });
      expect(r.status).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  it("a member cannot read or change another member's settings", async () => {
    const { srv, mia, settingsPath } = await office();
    expect(
      (await api(srv, settingsPath, { rawSessionId: mia.rawSessionId })).status,
    ).toBe(403);
    expect(
      (
        await api(srv, settingsPath, {
          method: "PATCH",
          rawSessionId: mia.rawSessionId,
          body: { repeatMinutes: 1 },
        })
      ).status,
    ).toBe(403);
  });

  it("refuses a URL that is not a Discord webhook", async () => {
    const { srv, boss, settingsPath } = await office();
    for (const webhookUrl of [
      "https://example.com/api/webhooks/1/x",
      URL_.replace("https:", "http:"),
      "http://127.0.0.1:4000/api/pager",
    ]) {
      const r = await api(srv, settingsPath, {
        method: "PATCH",
        rawSessionId: boss.rawSessionId,
        body: { webhookUrl },
      });
      expect(r.status).toBe(422);
    }
  });
});

describe("pager settings REST: delivery", () => {
  it("the test button sends one message to the saved webhook", async () => {
    const { srv, boss, settingsPath, sent } = await office();
    const none = await api(srv, `${settingsPath}/test`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(none.body).toEqual({ delivered: false, failure: "no_webhook" });
    expect(sent).toHaveLength(0);
    await api(srv, settingsPath, {
      method: "PATCH",
      rawSessionId: boss.rawSessionId,
      body: { webhookUrl: URL_, discordUserId: DISCORD_ID },
    });
    const r = await api(srv, `${settingsPath}/test`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(URL_);
    expect(sent[0].body.allowed_mentions).toEqual({
      parse: [],
      users: [DISCORD_ID],
    });
  });

  it("a raised page reaches the webhook once with the mention and the link; the URL stays server-side", async () => {
    const { srv, boss, botToken, settingsPath, sent } = await office();
    const ws = await srv.connectWs(boss.rawSessionId);
    await api(srv, settingsPath, {
      method: "PATCH",
      rawSessionId: boss.rawSessionId,
      body: { webhookUrl: URL_, discordUserId: DISCORD_ID },
    });
    const raised = await api(srv, "/api/pager", {
      method: "POST",
      bearer: botToken,
      body: { title: "Disk full" },
    });
    expect(raised.status).toBe(201);
    const page = raised.body as PagerEntry;
    await sleep(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.content).toContain(`<@${DISCORD_ID}>`);
    expect(sent[0].body.embeds![0].url).toMatch(
      new RegExp(`^https?://[^/]+/\\?pager=${page.id}$`),
    );
    const got = await api(srv, `/api/pager/${page.id}`, { bearer: botToken });
    expect((got.body as PagerEntry).delivery).toMatchObject({
      state: "delivered",
      sends: 1,
    });
    const ack = await api(srv, `/api/pager/${page.id}/ack`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    expect(ack.status).toBe(200);
    await sleep(50);
    expect(JSON.stringify(ws.messages)).not.toContain(TOKEN);
    expect(raised.text + got.text + ack.text).not.toContain(TOKEN);
    expect(
      readFileSync(join(srv.stateRoot, "pager.json"), "utf8"),
    ).not.toContain(TOKEN);
  });

  // A page the member acked before any webhook existed: the resolve is the
  // first request to the webhook, so nothing waits for the send spacing.
  it("a resolve sends the resolved message in the member's language", async () => {
    const { srv, boss, botToken, settingsPath, sent } = await office();
    updateUserById(getUserByName("Boss")!.id, { language: "es" });
    const page = (
      await api(srv, "/api/pager", {
        method: "POST",
        bearer: botToken,
        body: { title: "Disk full" },
      })
    ).body as PagerEntry;
    await api(srv, `/api/pager/${page.id}/ack`, {
      method: "POST",
      rawSessionId: boss.rawSessionId,
    });
    await api(srv, settingsPath, {
      method: "PATCH",
      rawSessionId: boss.rawSessionId,
      body: { webhookUrl: URL_, discordUserId: DISCORD_ID },
    });
    expect(sent).toHaveLength(0);
    const resolved = await api(srv, `/api/pager/${page.id}/resolve`, {
      method: "POST",
      bearer: botToken,
    });
    expect(resolved.status).toBe(200);
    await sleep(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.content).toBe(
      translatorFor("es").t("pager.discord.resolved", { title: "Disk full" }),
    );
    expect(sent[0].body.allowed_mentions).toEqual({ parse: [] });
  });
});
