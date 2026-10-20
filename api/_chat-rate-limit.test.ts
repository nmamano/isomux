// The chat endpoint allows 5 requests a minute and 20 an hour per IP, in
// sliding windows. Every response tells the client where it stands, in the
// RateLimit-Policy and RateLimit fields of the IETF draft
// draft-ietf-httpapi-ratelimit-headers, and a 429 carries Retry-After: the
// number of seconds after which the next request is allowed. These tests run
// the real handler on a fixed clock, each with its own address, and check the
// fields against what the limiter then does.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import handler from "./chat.ts";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const realFetch = globalThis.fetch;
const realWebhook = process.env.DISCORD_WEBHOOK_URL;
let upstream: "stream" | "error" = "stream";
let nextIp = 0;
let ip = "";
let lastBody = "";

beforeEach(() => {
  ip = `203.0.113.${++nextIp}`;
  upstream = "stream";
  delete process.env.DISCORD_WEBHOOK_URL;
  globalThis.fetch = (async () =>
    upstream === "error"
      ? new Response("overloaded", { status: 529 })
      : new Response(
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi." } })}\n\n`,
        )) as unknown as typeof fetch;
});
afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
  if (realWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = realWebhook;
});

/** Set the clock to T0 plus the given seconds. */
function at(seconds: number) {
  setSystemTime(new Date(T0 + seconds * 1000));
}

/** Parse a structured-field list such as `"minute";r=4;t=60, "hour";r=19`. */
function fields(value: string | null): Record<string, Record<string, number>> {
  expect(value).not.toBeNull();
  const out: Record<string, Record<string, number>> = {};
  for (const item of value!.split(",")) {
    const [name, ...params] = item.trim().split(";");
    const key = JSON.parse(name);
    out[key] = {};
    for (const param of params) {
      const [k, v] = param.trim().split("=");
      out[key][k] = Number(v);
    }
  }
  return out;
}

/** A counted request that never reaches upstream: the body is not JSON. */
async function badJson(): Promise<Response> {
  const res = await handler(
    new Request("https://isomux.com/api/chat", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: "{",
    }),
  );
  lastBody = await res.text();
  return res;
}

async function ask(): Promise<Response> {
  const res = await handler(
    new Request("https://isomux.com/api/chat", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    }),
  );
  await res.text();
  return res;
}

async function peek(): Promise<Response> {
  const res = await handler(
    new Request("https://isomux.com/api/chat", {
      headers: { "x-forwarded-for": ip },
    }),
  );
  await res.text();
  return res;
}

describe("chat rate-limit fields", () => {
  it("publishes both policies and the remaining quota on every response", async () => {
    at(0);
    const fresh = await peek();
    expect(fresh.status).toBe(405);
    expect(fields(fresh.headers.get("ratelimit-policy"))).toEqual({
      minute: { q: 5, w: 60 },
      hour: { q: 20, w: 3600 },
    });
    expect(fields(fresh.headers.get("ratelimit")).minute.r).toBe(5);
    expect(fields(fresh.headers.get("ratelimit")).hour.r).toBe(20);
    // A 405 is not counted, so looking costs nothing.
    expect(fields((await peek()).headers.get("ratelimit")).minute.r).toBe(5);

    const invalid = await badJson();
    expect(invalid.status).toBe(400);
    expect(fields(invalid.headers.get("ratelimit-policy")).hour.q).toBe(20);
    expect(fields(invalid.headers.get("ratelimit"))).toEqual({
      minute: { r: 4, t: 60 },
      hour: { r: 19, t: 3600 },
    });

    at(10);
    upstream = "error";
    const failed = await ask();
    expect(failed.status).toBe(502);
    expect(fields(failed.headers.get("ratelimit-policy")).minute.q).toBe(5);
    expect(fields(failed.headers.get("ratelimit"))).toEqual({
      minute: { r: 3, t: 50 },
      hour: { r: 18, t: 3590 },
    });

    at(20);
    upstream = "stream";
    const answered = await ask();
    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe("text/event-stream");
    expect(fields(answered.headers.get("ratelimit-policy")).minute.w).toBe(60);
    expect(fields(answered.headers.get("ratelimit"))).toEqual({
      minute: { r: 2, t: 40 },
      hour: { r: 17, t: 3580 },
    });

    // The first request leaves the minute window at 60 s, not the hour one.
    at(61);
    expect(fields((await peek()).headers.get("ratelimit"))).toEqual({
      minute: { r: 3, t: 9 },
      hour: { r: 17, t: 3539 },
    });
  });

  it("names the second the minute window frees, and keeps its word", async () => {
    for (const s of [0, 10, 20, 30, 40]) {
      at(s);
      expect((await badJson()).status).toBe(400);
    }
    at(45);
    const limited = await badJson();
    expect(limited.status).toBe(429);
    expect(JSON.parse(lastBody).error.code).toBe("rate_limit_exceeded");
    expect(limited.headers.get("retry-after")).toBe("15");
    expect(fields(limited.headers.get("ratelimit")).minute).toEqual({
      r: 0,
      t: 15,
    });
    expect(fields(limited.headers.get("ratelimit-policy")).minute.q).toBe(5);

    at(59);
    expect((await badJson()).status).toBe(429);
    at(60);
    expect((await badJson()).status).toBe(400);
  });

  it("waits for the hour window when both windows are spent", async () => {
    // 15 requests a minute apart, then 5 in one minute: 20 in the hour.
    for (let i = 0; i < 15; i++) {
      at(i * 61);
      expect((await badJson()).status).toBe(400);
    }
    for (const s of [920, 921, 922, 923, 924]) {
      at(s);
      expect((await badJson()).status).toBe(400);
    }
    at(930);
    const limited = await badJson();
    expect(limited.status).toBe(429);
    expect(fields(limited.headers.get("ratelimit"))).toEqual({
      minute: { r: 0, t: 50 },
      hour: { r: 0, t: 2670 },
    });
    expect(limited.headers.get("retry-after")).toBe("2670");

    // Once the minute window frees, the hour window still refuses.
    at(980);
    expect((await badJson()).status).toBe(429);
    at(3599);
    expect((await badJson()).status).toBe(429);
    at(3600);
    expect((await badJson()).status).toBe(400);
  });
});
