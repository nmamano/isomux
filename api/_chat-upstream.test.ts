// A chat reply has CHAT_UPSTREAM.timeoutMs from the request to Anthropic to its
// last byte. On Vercel the function limit ended a stalled reply; on the site
// host one process serves for months and nothing else would. These tests run
// the real handler with fetch replaced by an upstream that stalls until it is
// aborted, on a short timeout, and race each reply against a deadline so a
// missing timeout fails as "hung" instead of hanging the run.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import handler, { CHAT_UPSTREAM } from "./chat.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";
const WEBHOOK = "https://discord.example/webhook";
const TIMEOUT_MS = 200;
const DEADLINE_MS = 2000;
const realFetch = globalThis.fetch;
const realWebhook = process.env.DISCORD_WEBHOOK_URL;
const realTimeout = CHAT_UPSTREAM.timeoutMs;
let nextIp = 0;

const delta = (text: string) =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`,
  );

/** Settles when the signal aborts; never otherwise. */
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) =>
    signal?.addEventListener("abort", () =>
      reject(new Error("aborted", { cause: signal.reason })),
    ),
  );
}

/** A body that sends the given chunks, then stalls until aborted or cancelled. */
function stallingBody(
  chunks: Uint8Array[],
  signal: AbortSignal | null | undefined,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
}

beforeEach(() => {
  CHAT_UPSTREAM.timeoutMs = TIMEOUT_MS;
  delete process.env.DISCORD_WEBHOOK_URL;
});
afterEach(() => {
  CHAT_UPSTREAM.timeoutMs = realTimeout;
  globalThis.fetch = realFetch;
  if (realWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = realWebhook;
});

function ask(): Promise<Response> {
  return handler(
    new Request("https://isomux.com/api/chat", {
      method: "POST",
      headers: { "x-forwarded-for": `198.18.0.${++nextIp % 250}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    }),
  );
}

function withinDeadline<T>(work: Promise<T>): Promise<T | "hung"> {
  return Promise.race([
    work,
    new Promise<"hung">((done) => setTimeout(() => done("hung"), DEADLINE_MS)),
  ]);
}

/** The JSON payloads of a Server-Sent Events body, in order. */
function frames(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => f.slice(6))
    .map((p) => (p === "[DONE]" ? "[DONE]" : JSON.parse(p)));
}

describe("chat upstream timeout", () => {
  it("answers with an error when Anthropic sends no response in time", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      untilAborted(init?.signal)) as unknown as typeof fetch;
    const started = Date.now();
    const res = await withinDeadline(ask());
    expect(res).not.toBe("hung");
    const response = res as Response;
    // It waited for the timeout, not less.
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect([502, 504]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(typeof (await response.json()).error.code).toBe("string");
  });

  it("ends a reply that stalls after its first words with an error frame", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
      new Response(
        stallingBody([delta("Hi.")], init?.signal),
      )) as unknown as typeof fetch;
    const res = await ask();
    expect(res.status).toBe(200);
    const text = await withinDeadline(res.text());
    expect(text).not.toBe("hung");
    const sent = frames(text);
    expect(sent[0]).toEqual({ text: "Hi." });
    expect(sent).not.toContain("[DONE]");
    expect(typeof (sent.at(-1) as { error?: unknown }).error).toBe("string");
  });

  it("ends the reply when the Discord log stalls after the answer", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    globalThis.fetch = (async (url: string, init?: RequestInit) =>
      String(url) === MODEL_URL
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(delta("Hi."));
                controller.close();
              },
            }),
          )
        : untilAborted(init?.signal)) as unknown as typeof fetch;
    const res = await ask();
    const text = await withinDeadline(res.text());
    expect(text).not.toBe("hung");
    expect(frames(text)[0]).toEqual({ text: "Hi." });
  });

  it("lets a reply that ends in time through whole", async () => {
    CHAT_UPSTREAM.timeoutMs = 1000;
    // The body fails on abort, as a real fetch body does.
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          async start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
            controller.enqueue(delta("Hi"));
            await Bun.sleep(100);
            if (init?.signal?.aborted) return;
            controller.enqueue(delta(" there."));
            controller.close();
          },
        }),
      )) as unknown as typeof fetch;
    const res = await ask();
    const text = await withinDeadline(res.text());
    expect(frames(text)).toEqual([
      { text: "Hi" },
      { text: " there." },
      "[DONE]",
    ]);
  });

  it("ends the call to Anthropic when the visitor leaves mid-reply", async () => {
    // A long deadline, so only the visitor's leaving can end the call.
    CHAT_UPSTREAM.timeoutMs = 10_000;
    let upstreamSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      return new Response(stallingBody([delta("Hi.")], init?.signal));
    }) as unknown as typeof fetch;
    const res = await ask();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"text":"Hi."');
    expect(upstreamSignal?.aborted).toBe(false);
    await reader.cancel();
    await Bun.sleep(50);
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
