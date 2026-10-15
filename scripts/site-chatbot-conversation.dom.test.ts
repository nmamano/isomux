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
    // An empty stream, so the widget's reader finishes instead of throwing.
    return new Response(new ReadableStream({ start: (c) => c.close() }));
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
