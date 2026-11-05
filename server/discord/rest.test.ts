// The Discord REST calls the server makes (task 7fd44c30): the token check,
// the catch-up reads and the active threads. A fake fetch stands in for
// Discord. Each call answers a result and never throws; a 429 is waited out a
// bounded number of times; no error text carries the token.

import { describe, expect, it } from "bun:test";
import {
  DISCORD_RATE_LIMIT_RETRIES,
  DISCORD_RATE_LIMIT_WAIT_MAX_MS,
  createDiscordRest,
  type DiscordRest,
} from "./rest.ts";

const BASE = "http://discord.test/api/v10";
const TOKEN = "fake.Token-0001";
const BOT_USER = "1100000000000000001";
const ROLE = "1500000000000000001";
const GUILD = "1200000000000000001";
const CHANNEL = "1300000000000000002";

interface Call {
  method: string;
  url: string;
  auth: string | null;
}

function harness(
  answer: (call: Call, n: number) => Response | Promise<Response>,
) {
  const h = {
    calls: [] as Call[],
    sleeps: [] as number[],
    rest: undefined as unknown as DiscordRest,
  };
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
    };
    h.calls.push(call);
    return answer(call, h.calls.length);
  }) as typeof fetch;
  h.rest = createDiscordRest({
    baseUrl: BASE,
    fetch: fakeFetch,
    sleep: async (ms) => void h.sleeps.push(ms),
    redact: (text) => text.split(TOKEN).join("[token]"),
  });
  return h;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("discord rest: the token check", () => {
  it("reads the bot user with the token as a Bot authorization", async () => {
    const h = harness(() =>
      json(200, { id: BOT_USER, username: "Office Bot", bot: true }),
    );
    expect(await h.rest.me(TOKEN)).toEqual({
      ok: true,
      id: BOT_USER,
      name: "Office Bot",
      bot: true,
    });
    expect(h.calls).toEqual([
      { method: "GET", url: `${BASE}/users/@me`, auth: `Bot ${TOKEN}` },
    ]);
    // A user account's token: bot is false.
    const user = harness(() => json(200, { id: "5", username: "Nelly" }));
    expect(await user.rest.me(TOKEN)).toMatchObject({ ok: true, bot: false });
  });

  it("a 401 is unauthorized, another status or a network error is failed, and no error text carries the token", async () => {
    expect(
      await harness(() => json(401, { message: "401: Unauthorized" })).rest.me(
        TOKEN,
      ),
    ).toMatchObject({ ok: false, reason: "unauthorized" });
    const server = await harness(() =>
      json(500, { message: `bad token ${TOKEN}` }),
    ).rest.me(TOKEN);
    expect(server).toMatchObject({ ok: false, reason: "failed" });
    const down = await harness(() => {
      throw new Error(`connect failed for Bot ${TOKEN}`);
    }).rest.me(TOKEN);
    expect(down).toMatchObject({ ok: false, reason: "failed" });
    const garbled = await harness(
      () => new Response("<html>", { status: 200 }),
    ).rest.me(TOKEN);
    expect(garbled).toMatchObject({ ok: false, reason: "failed" });
    for (const res of [server, down, garbled]) {
      if (res.ok) throw new Error("expected a failure");
      expect(typeof res.error).toBe("string");
      expect(res.error).not.toContain(TOKEN);
    }
  });
});

describe("discord rest: rate limits", () => {
  it("waits out a 429 for its retry_after, then answers", async () => {
    const h = harness((_c, n) =>
      n === 1
        ? json(429, { message: "slow down", retry_after: 1.5, global: false })
        : json(200, { id: BOT_USER, username: "Office Bot", bot: true }),
    );
    expect(await h.rest.me(TOKEN)).toMatchObject({ ok: true });
    expect(h.sleeps).toEqual([1500]);
    expect(h.calls).toHaveLength(2);
  });

  it("gives up after the retries, and does not wait a retry_after over the cap", async () => {
    const always = harness(() => json(429, { retry_after: 0.25 }));
    expect(await always.rest.me(TOKEN)).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
    expect(always.sleeps).toEqual(Array(DISCORD_RATE_LIMIT_RETRIES).fill(250));
    expect(always.calls).toHaveLength(DISCORD_RATE_LIMIT_RETRIES + 1);

    const long = harness(() =>
      json(429, { retry_after: DISCORD_RATE_LIMIT_WAIT_MAX_MS / 1000 + 1 }),
    );
    expect(await long.rest.me(TOKEN)).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
    expect(long.sleeps).toEqual([]);
    expect(long.calls).toHaveLength(1);
  });
});

// A message as Discord's REST API returns it.
function apiMessage(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    channel_id: CHANNEL,
    type: 0,
    content: `text ${id}`,
    author: { id: "1600000000000000001", username: "nelly", bot: false },
    mentions: [],
    mention_roles: [],
    attachments: [],
    timestamp: "2026-11-05T10:00:00.000+00:00",
    ...over,
  };
}

describe("discord rest: messages", () => {
  it("reads one page before a message, newest first, in the gateway's shape", async () => {
    const page = [
      apiMessage("1700000000000000005", {
        type: 19,
        content: "an answer",
        referenced_message: apiMessage("1700000000000000001", {
          author: { id: BOT_USER, username: "Office Bot", bot: true },
        }),
        attachments: [
          {
            id: "9",
            filename: "plot.png",
            url: "https://cdn.discordapp.com/attachments/plot.png",
            size: 7,
          },
        ],
      }),
      apiMessage("1700000000000000004", {
        mentions: [{ id: BOT_USER, username: "Office Bot" }],
      }),
      apiMessage("1700000000000000003", { mention_roles: [ROLE] }),
      apiMessage("1700000000000000002", {
        webhook_id: "1800000000000000001",
        author: { id: "1800000000000000001", username: "Hook", bot: true },
      }),
    ];
    const h = harness(() => json(200, page));
    const res = await h.rest.messages(TOKEN, {
      guildId: GUILD,
      channelId: CHANNEL,
      before: "1700000000000000009",
      limit: 100,
      botUserId: BOT_USER,
      botRoleIds: [ROLE],
    });
    expect(h.calls).toHaveLength(1);
    const url = new URL(h.calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${BASE}/channels/${CHANNEL}/messages`,
    );
    expect(url.searchParams.get("before")).toBe("1700000000000000009");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(h.calls[0].auth).toBe(`Bot ${TOKEN}`);
    if (!res.ok) throw new Error("expected a page");
    expect(res.messages.map((m) => m.id)).toEqual(page.map((m) => m.id));
    const ts = Date.parse("2026-11-05T10:00:00.000+00:00");
    expect(res.messages[0]).toEqual({
      ev: "message",
      id: "1700000000000000005",
      guildId: GUILD,
      channelId: CHANNEL,
      author: { id: "1600000000000000001", name: "nelly", bot: false },
      webhook: false,
      type: 19,
      content: "an answer",
      mentionsBot: false,
      replyToBot: true,
      attachments: [
        {
          name: "plot.png",
          url: "https://cdn.discordapp.com/attachments/plot.png",
        },
      ],
      ts,
    });
    expect(
      res.messages.map((m) => [m.mentionsBot, m.replyToBot, m.webhook]),
    ).toEqual([
      [false, true, false],
      [true, false, false],
      [true, false, false],
      [false, false, true],
    ]);
  });

  it("reads the first page with no before, and fails without throwing on a bad page", async () => {
    const h = harness(() => json(200, []));
    await h.rest.messages(TOKEN, {
      guildId: GUILD,
      channelId: CHANNEL,
      limit: 50,
      botUserId: BOT_USER,
      botRoleIds: [],
    });
    expect(new URL(h.calls[0].url).searchParams.has("before")).toBe(false);
    const bad = await harness(() => json(200, { not: "a list" })).rest.messages(
      TOKEN,
      {
        guildId: GUILD,
        channelId: CHANNEL,
        limit: 50,
        botUserId: BOT_USER,
        botRoleIds: [],
      },
    );
    expect(bad).toMatchObject({ ok: false, reason: "failed" });
  });
});

describe("discord rest: active threads", () => {
  it("lists the guild's active threads with their channel", async () => {
    const h = harness(() =>
      json(200, {
        threads: [
          { id: "1900000000000000001", parent_id: CHANNEL, name: "q" },
          { id: "1900000000000000002", parent_id: "1300000000000000003" },
        ],
        members: [],
      }),
    );
    expect(await h.rest.activeThreads(TOKEN, GUILD)).toEqual({
      ok: true,
      threads: [
        { id: "1900000000000000001", parentId: CHANNEL },
        { id: "1900000000000000002", parentId: "1300000000000000003" },
      ],
    });
    expect(h.calls[0].url).toBe(`${BASE}/guilds/${GUILD}/threads/active`);
  });
});
