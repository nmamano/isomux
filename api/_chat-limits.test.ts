// What one chat request may carry. The site widget sends a conversation that
// starts with a visitor turn, alternates, and ends with the visitor's new turn,
// and its size stays under CHAT_LIMITS. The endpoint refuses anything larger
// with 413 and any other shape with 400, before it calls the model or posts to
// the Discord log, and a refused request still counts against the rate limit.
// These tests run the real handler with fetch replaced; each request comes
// from its own address so the limiter never interferes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import handler, { CHAT_LIMITS } from "./chat.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";
const WEBHOOK = "https://discord.example/webhook";
const realFetch = globalThis.fetch;
const realWebhook = process.env.DISCORD_WEBHOOK_URL;
let calls: { url: string; body: string }[] = [];
let nextIp = 0;

beforeEach(() => {
  calls = [];
  process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: init.body as string });
    if (String(url) !== MODEL_URL) return new Response(null, { status: 204 });
    return new Response(
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi." } })}\n\n`,
    );
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = realWebhook;
});

type Message = { role: string; content: string };

/** POST a body as a real client does: with its true Content-Length. */
async function post(
  body: string,
  contentLength: number | null = new TextEncoder().encode(body).length,
): Promise<{ res: Response; json: { error?: { code: string } } | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": `198.51.100.${++nextIp % 250}`,
  };
  // null sends the body without the header, as a chunked upload does.
  if (contentLength !== null) headers["content-length"] = String(contentLength);
  const req = new Request("https://isomux.com/api/chat", {
    method: "POST",
    headers,
    body,
  });
  expect(req.headers.get("content-length")).toBe(
    contentLength === null ? null : String(contentLength),
  );
  const res = await handler(req);
  const text = await res.text();
  const json = res.headers.get("content-type")?.startsWith("application/json")
    ? JSON.parse(text)
    : null;
  return { res, json };
}

/** The messages the handler forwarded to the model, or null if it never called. */
function forwarded(): Message[] | null {
  const call = calls.find((c) => c.url === MODEL_URL);
  return call ? JSON.parse(call.body).messages : null;
}

/** An accepted request reaches the model with its messages unchanged. */
async function expectAccepted(messages: Message[], extra = {}) {
  const { res } = await post(JSON.stringify({ messages, ...extra }));
  expect(res.status).toBe(200);
  expect(forwarded()).toEqual(messages);
  // The visitor's turn went to the Discord log as well.
  expect(calls.some((c) => c.url === WEBHOOK)).toBe(true);
}

/** A refused request reaches neither the model nor the Discord log. */
async function expectRefused(
  status: number,
  code: string,
  body: string,
  contentLength?: number | null,
) {
  const { res, json } = await post(body, contentLength);
  expect(res.status).toBe(status);
  expect(json?.error?.code).toBe(code);
  expect(calls).toEqual([]);
}

/** n turns that start with the visitor and alternate, so n odd ends with one. */
function conversation(lengths: number[]): Message[] {
  return lengths.map((n, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(n),
  }));
}

/** The largest count with the widget's shape (odd) that the cap allows. */
const MAX_TURNS =
  CHAT_LIMITS.maxMessages % 2 === 1
    ? CHAT_LIMITS.maxMessages
    : CHAT_LIMITS.maxMessages - 1;

describe("chat request caps", () => {
  it("accepts a conversation at the message-count cap and refuses one longer", async () => {
    await expectAccepted(conversation(Array(MAX_TURNS).fill(10)));
    calls = [];
    await expectRefused(
      413,
      "request_too_large",
      JSON.stringify({ messages: conversation(Array(MAX_TURNS + 2).fill(10)) }),
    );
  });

  it("accepts a message at the per-message cap and refuses one longer, from either role", async () => {
    const max = CHAT_LIMITS.maxMessageChars;
    // The per-message cap must bind before the total cap for this test.
    expect(max + 2).toBeLessThanOrEqual(CHAT_LIMITS.maxTotalChars);
    await expectAccepted(conversation([max]));
    calls = [];
    await expectRefused(
      413,
      "request_too_large",
      JSON.stringify({ messages: conversation([max + 1]) }),
    );
    await expectRefused(
      413,
      "request_too_large",
      JSON.stringify({ messages: conversation([1, max + 1, 1]) }),
    );
  });

  it("accepts a conversation at the total cap and refuses one character more", async () => {
    // Five turns, each under the per-message cap even with the extra character.
    const each = Math.floor(CHAT_LIMITS.maxTotalChars / 5);
    const lengths = Array(5).fill(each);
    lengths[0] += CHAT_LIMITS.maxTotalChars - each * 5;
    expect(5).toBeLessThanOrEqual(CHAT_LIMITS.maxMessages);
    expect(Math.max(...lengths) + 1).toBeLessThanOrEqual(
      CHAT_LIMITS.maxMessageChars,
    );
    await expectAccepted(conversation(lengths));
    calls = [];
    lengths[2] += 1;
    await expectRefused(
      413,
      "request_too_large",
      JSON.stringify({ messages: conversation(lengths) }),
    );
  });

  it("refuses a body over the byte cap from its Content-Length, before parsing it", async () => {
    // pageContext is cut, not refused, so only the body cap stops this one.
    const messages = conversation([10]);
    const base = JSON.stringify({ messages, pageContext: "" }).length;
    const exact = JSON.stringify({
      messages,
      pageContext: "p".repeat(CHAT_LIMITS.maxBodyBytes - base),
    });
    expect(new TextEncoder().encode(exact).length).toBe(
      CHAT_LIMITS.maxBodyBytes,
    );
    const { res } = await post(exact);
    expect(res.status).toBe(200);
    expect(forwarded()).toEqual(messages);
    calls = [];
    await expectRefused(
      413,
      "request_too_large",
      JSON.stringify({
        messages,
        pageContext: "p".repeat(CHAT_LIMITS.maxBodyBytes - base + 1),
      }),
    );
    // Not valid JSON: only a check before the parse can answer 413 here.
    await expectRefused(
      413,
      "request_too_large",
      "{",
      CHAT_LIMITS.maxBodyBytes + 1,
    );
  });

  it("measures a body sent without Content-Length", async () => {
    const messages = conversation([10]);
    const base = JSON.stringify({ messages, pageContext: "" }).length;
    const body = (extra: number) =>
      JSON.stringify({
        messages,
        pageContext: "p".repeat(CHAT_LIMITS.maxBodyBytes - base + extra),
      });
    const { res } = await post(body(0), null);
    expect(res.status).toBe(200);
    expect(forwarded()).toEqual(messages);
    calls = [];
    await expectRefused(413, "request_too_large", body(1), null);
  });

  it("counts a refused request against the rate limit", async () => {
    const { res } = await post(
      JSON.stringify({
        messages: conversation([CHAT_LIMITS.maxMessageChars + 1]),
      }),
    );
    expect(res.status).toBe(413);
    const quotas = Object.fromEntries(
      res.headers
        .get("ratelimit-policy")!
        .split(",")
        .map((p) => [p.trim().split(";")[0], Number(/q=(\d+)/.exec(p)![1])]),
    );
    const remaining = Object.fromEntries(
      res.headers
        .get("ratelimit")!
        .split(",")
        .map((p) => [p.trim().split(";")[0], Number(/r=(\d+)/.exec(p)![1])]),
    );
    expect(Object.keys(quotas).length).toBeGreaterThan(0);
    for (const name of Object.keys(quotas))
      expect(remaining[name]).toBe(quotas[name] - 1);
  });
});

describe("chat request shape", () => {
  const cases: [string, Message[]][] = [
    [
      "starts with an assistant turn",
      [
        { role: "assistant", content: "a" },
        { role: "user", content: "q" },
      ],
    ],
    [
      "has two visitor turns in a row",
      [
        { role: "user", content: "q" },
        { role: "user", content: "q" },
      ],
    ],
    [
      "has two assistant turns in a row",
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q" },
      ],
    ],
    [
      "ends with an assistant turn",
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    ],
    ["has an empty visitor turn", [{ role: "user", content: "" }]],
    [
      "has a whitespace-only visitor turn",
      [{ role: "user", content: " \n\t" }],
    ],
    [
      "has an empty assistant turn",
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "" },
        { role: "user", content: "q" },
      ],
    ],
  ];

  for (const [name, messages] of cases) {
    it(`refuses a conversation that ${name}`, async () => {
      await expectRefused(400, "invalid_request", JSON.stringify({ messages }));
    });
  }

  it("accepts the widget's shape: visitor first, alternating, visitor last", async () => {
    await expectAccepted([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "q" },
    ]);
  });
});
