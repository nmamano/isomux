// The chat widget (site/chatbot.js) sends a conversation id with each request,
// so /api/chat can group one conversation's posts in its Discord log. The
// widget keeps its messages only for the life of the page, and the id has the
// same life. The test runs the real file in a document, with `fetch` replaced,
// and reads the request bodies the widget tried to send.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setUpDomTestFile } from "../ui/test-support/dom.ts";

setUpDomTestFile();

const { conversationTag } = await import("../api/chat.ts");

const CHATBOT = readFileSync(
  join(import.meta.dir, "..", "site", "chatbot.js"),
  "utf8",
);

type ChatWindow = typeof window & {
  __chatOpen: () => void;
  __chatSend: (text: string) => void;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Load the widget once and send `texts` in turn; return each request body. */
async function pageLoad(
  texts: string[],
): Promise<{ conversationId?: unknown; messages: unknown[] }[]> {
  document.body.innerHTML = '<div id="chat-widget"></div>';
  const bodies: { conversationId?: unknown; messages: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    // A short answer, so the next request carries this exchange.
    return new Response(`data: ${JSON.stringify({ text: "ok" })}\n\n`);
  }) as unknown as typeof fetch;
  new Function(CHATBOT)();
  const w = window as ChatWindow;
  w.__chatOpen();
  for (const [index, text] of texts.entries()) {
    w.__chatSend(text);
    // The widget ignores a send while the previous answer loads.
    for (let tick = 0; bodies.length <= index && tick < 50; tick++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    for (let tick = 0; tick < 5; tick++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(bodies.length).toBe(texts.length);
  return bodies;
}

describe("the chat widget's conversation id", () => {
  it("sends one id the server accepts with every request of a page load", async () => {
    const bodies = await pageLoad(["first", "second", "third"]);
    // The later requests are the same conversation: they carry its history.
    expect(bodies.map((b) => b.messages.length)).toEqual([1, 3, 5]);
    const id = bodies[0].conversationId;
    expect(conversationTag(id)).not.toBe("");
    expect(bodies.map((b) => b.conversationId)).toEqual([id, id, id]);
  });

  it("makes a new id at the next page load", async () => {
    const ids = new Set<unknown>();
    for (let load = 0; load < 5; load++)
      ids.add((await pageLoad(["hi"]))[0].conversationId);
    expect(ids.size).toBe(5);
  });
});

// The widget trims what it sends so /api/chat accepts it: no failed or empty
// answers, alternating turns that end with the visitor's new one, and a size
// under CHAT_LIMITS, keeping the most recent turns that fit. These tests pass
// each request the widget makes to the real handler, with the model replaced
// by scripted answers, so any drift between the widget's numbers and the
// server's turns a request into a refusal.

const { default: handler, CHAT_LIMITS } = await import("../api/chat.ts");

const MODEL_URL = "https://api.anthropic.com/v1/messages";
type Message = { role: string; content: string };
/** How the model answers one turn: text, a failure, or text then a refusal. */
type Answer = { text: string } | { fail: true } | { refuseAfter: string };
let nextAddress = 0;

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function modelResponse(answer: Answer): Response {
  if ("fail" in answer) return new Response("overloaded", { status: 529 });
  const text = "text" in answer ? answer.text : answer.refuseAfter;
  // An answer with no text still streams: the model only thought.
  let body = text
    ? sse({ type: "content_block_delta", delta: { type: "text_delta", text } })
    : sse({ type: "message_stop" });
  if ("refuseAfter" in answer)
    body += sse({ type: "message_delta", delta: { stop_reason: "refusal" } });
  return new Response(body);
}

/**
 * Load the widget, send each turn and let the model give its answer. Returns
 * the messages of each request and the handler's status for it.
 */
async function converse(
  turns: { send: string; answer: Answer }[],
): Promise<{ sent: Message[][]; statuses: number[] }> {
  document.body.innerHTML = '<div id="chat-widget"></div>';
  const sent: Message[][] = [];
  const statuses: number[] = [];
  const answers = turns.map((t) => t.answer);
  let finished = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === MODEL_URL) return modelResponse(answers.shift()!);
    expect(url).toBe("/api/chat");
    const body = String(init.body);
    sent.push(JSON.parse(body).messages);
    const res = await handler(
      new Request("https://isomux.com/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).length),
          "x-forwarded-for": `192.0.2.${++nextAddress % 250}`,
        },
        body,
      }),
    );
    statuses.push(res.status);
    // Pass the answer on, and note when the widget has read all of it.
    const reader = res.body!.getReader();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            finished++;
            controller.close();
          } else controller.enqueue(value);
        },
      }),
      { status: res.status, headers: res.headers },
    );
  }) as unknown as typeof fetch;
  delete process.env.DISCORD_WEBHOOK_URL;
  new Function(CHATBOT)();
  const w = window as ChatWindow;
  w.__chatOpen();
  for (const [index, turn] of turns.entries()) {
    w.__chatSend(turn.send);
    for (let tick = 0; finished <= index && tick < 200; tick++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(index + 1);
    for (let tick = 0; tick < 5; tick++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(sent.length).toBe(turns.length);
  return { sent, statuses };
}

/**
 * The request for turn i is the most recent part of the conversation that
 * fits: whole exchanges, answers cut to the per-message cap, and the new
 * turn. One more exchange would break the count or the total cap.
 */
function expectMostRecentThatFits(
  request: Message[],
  history: { send: string; answer: string }[],
) {
  const cut = (text: string) => text.slice(0, CHAT_LIMITS.maxMessageChars);
  const all: Message[] = history.flatMap((t, i) =>
    i === history.length - 1
      ? [{ role: "user", content: t.send }]
      : [
          { role: "user", content: t.send },
          { role: "assistant", content: cut(t.answer) },
        ],
  );
  expect(request).toEqual(all.slice(all.length - request.length));
  if (request.length === all.length) return;
  const older = all.slice(all.length - request.length - 2);
  const total = older.reduce((sum, m) => sum + m.content.length, 0);
  expect(
    older.length > CHAT_LIMITS.maxMessages || total > CHAT_LIMITS.maxTotalChars,
  ).toBe(true);
}

describe("the chat widget's request size", () => {
  it("lets a visitor type a message up to the per-message cap", async () => {
    await pageLoad([]);
    const input = document.getElementById("chat-input") as HTMLInputElement;
    expect(input.maxLength).toBeGreaterThan(0);
    expect(input.maxLength).toBeLessThanOrEqual(CHAT_LIMITS.maxMessageChars);
  });

  it("keeps the most recent turns that fit when the visitor and the model write the most they can", async () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      send: `q${i}`.padEnd(CHAT_LIMITS.maxMessageChars, "x"),
      // Longer than one message may be, so the widget has to cut it.
      answer: `a${i}`.padEnd(CHAT_LIMITS.maxMessageChars + 4000, "y"),
    }));
    const { sent, statuses } = await converse(
      turns.map((t) => ({ send: t.send, answer: { text: t.answer } })),
    );
    expect(statuses).toEqual(turns.map(() => 200));
    // Later requests still carry an earlier exchange, not only the new turn.
    expect(sent.at(-1)!.length).toBeGreaterThan(1);
    for (const [i, request] of sent.entries())
      expectMostRecentThatFits(request, turns.slice(0, i + 1));
  });

  it("keeps the most recent turns that fit when a conversation has more turns than the cap", async () => {
    const turns = Array.from(
      { length: Math.ceil(CHAT_LIMITS.maxMessages / 2) + 3 },
      (_, i) => ({ send: `question ${i}`, answer: `answer ${i}` }),
    );
    const { sent, statuses } = await converse(
      turns.map((t) => ({ send: t.send, answer: { text: t.answer } })),
    );
    expect(statuses).toEqual(turns.map(() => 200));
    for (const [i, request] of sent.entries())
      expectMostRecentThatFits(request, turns.slice(0, i + 1));
    // The conversation outgrew the cap, so the last request dropped turns.
    expect(sent.at(-1)!.length).toBeLessThan(turns.length * 2 - 1);
  });

  it("does not cut an answer inside a character", async () => {
    // The cap falls between the two halves of an emoji's surrogate pair.
    const answer = `${"y".repeat(CHAT_LIMITS.maxMessageChars - 1)}${"😀".repeat(10)}`;
    const { sent, statuses } = await converse([
      { send: "first", answer: { text: answer } },
      { send: "second", answer: { text: "ok" } },
    ]);
    expect(statuses).toEqual([200, 200]);
    const kept = sent[1][1].content;
    expect(kept.isWellFormed()).toBe(true);
    expect(answer.startsWith(kept)).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(CHAT_LIMITS.maxMessageChars);
    expect(kept.length).toBeGreaterThan(CHAT_LIMITS.maxMessageChars - 2);
  });

  it("leaves failed and empty answers, and the turns they answered, out of the next request", async () => {
    const { sent, statuses } = await converse([
      { send: "q1", answer: { fail: true } },
      { send: "q2", answer: { text: "a2" } },
      { send: "q3", answer: { refuseAfter: "partial a3" } },
      { send: "q4", answer: { text: "" } },
      { send: "q5", answer: { text: "a5" } },
    ]);
    // The model failed on q1; every request the widget made was accepted.
    expect(statuses).toEqual([502, 200, 200, 200, 200]);
    const u = (content: string) => ({ role: "user", content });
    const a = (content: string) => ({ role: "assistant", content });
    expect(sent).toEqual([
      [u("q1")],
      [u("q2")],
      [u("q2"), a("a2"), u("q3")],
      // The part of an answer that streamed before the refusal is kept.
      [u("q2"), a("a2"), u("q3"), a("partial a3"), u("q4")],
      [u("q2"), a("a2"), u("q3"), a("partial a3"), u("q5")],
    ]);
  });
});
