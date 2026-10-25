// The handler logs each chat to a Discord channel through a webhook: the
// visitor message, then the answer. A reader of that channel groups the posts
// by the conversation id in their first line, and puts an answer that did not
// fit in one post back together from its parts. These tests run the real
// handler with `fetch` replaced: Anthropic answers with a canned stream, and
// the webhook records what it was sent.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import handler, { botPosts, conversationTag } from "./chat.ts";

const WEBHOOK = "https://discord.test/webhook";
// The header a reader of the channel parses: the protocol between this
// handler and the Discord bot that forwards the channel.
const HEADER =
  /^\[isomux\.com\](?: \[conversation ([a-z0-9]{8,32})\])? \*\*(Visitor|Bot)(?: \((\d+)\/(\d+)\))?:\*\*\n/u;

const realFetch = globalThis.fetch;
const realWebhook = process.env.DISCORD_WEBHOOK_URL;
let posts: string[] = [];
let mentionRules: unknown[] = [];
let answer = "";
let nextIp = 0;

beforeEach(() => {
  posts = [];
  mentionRules = [];
  process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url) === WEBHOOK) {
      // A post is recorded when it lands, trimmed as Discord stores it. The
      // earlier parts of an answer take longer to land, so parts sent all at
      // once would land out of order.
      const body = JSON.parse(init.body as string);
      mentionRules.push(body.allowed_mentions);
      const content: string = body.content.trim();
      const [, part, of] = content.match(/\*\*Bot \((\d+)\/(\d+)\)/u) ?? [];
      const lag = part ? (Number(of) - Number(part)) * 10 : 0;
      await new Promise((resolve) => setTimeout(resolve, lag));
      posts.push(content);
      return new Response(null, { status: 204 });
    }
    // Anthropic: the answer in three deltas, so the handler joins them.
    const third = Math.ceil(answer.length / 3);
    const frames = [0, 1, 2]
      .map((i) => answer.slice(i * third, (i + 1) * third))
      .map(
        (text) =>
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`,
      )
      .join("");
    return new Response(frames);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = realWebhook;
});

/** Send one chat request and read the stream to its end. */
async function chat(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  answer = text;
  const res = await handler(
    new Request("https://isomux.com/api/chat", {
      method: "POST",
      // Each request gets its own address: the limit is 5 a minute per IP.
      headers: { "x-forwarded-for": `198.51.100.${++nextIp}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: "How do I start?" }],
        ...extra,
      }),
    }),
  );
  await res.text();
  return res;
}

function parse(post: string) {
  const match = post.match(HEADER);
  expect(match, post.slice(0, 80)).not.toBeNull();
  return {
    id: match![1],
    role: match![2],
    part: match![3] ? Number(match![3]) : undefined,
    of: match![4] ? Number(match![4]) : undefined,
    body: post.slice(match![0].length),
  };
}

/** A text of `length` characters made of lines of words, ending in a word. */
function prose(length: number): string {
  const line = "the quick brown fox jumps over the lazy dog again\n";
  return `${line.repeat(Math.ceil(length / line.length)).slice(0, length - 1)}.`;
}

describe("conversation id in the Discord log", () => {
  it("puts the id the widget sent in the first line of every post", async () => {
    const res = await chat(prose(4500), { conversationId: "k3j9x0ab12cd" });
    expect(res.status).toBe(200);
    expect(posts.length).toBeGreaterThan(2);
    const parsed = posts.map(parse);
    expect(parsed.map((p) => p.id)).toEqual(posts.map(() => "k3j9x0ab12cd"));
    expect(parsed[0].role).toBe("Visitor");
    expect(parsed.slice(1).every((p) => p.role === "Bot")).toBe(true);
  });

  it("lets no post ping anyone, whatever the visitor typed", async () => {
    await chat(`@everyone @here ${prose(4500)}`);
    expect(mentionRules.length).toBe(posts.length);
    expect(
      mentionRules.every((m) => JSON.stringify(m) === '{"parse":[]}'),
    ).toBe(true);
  });

  it("keeps two conversations apart", async () => {
    await chat("first", { conversationId: "aaaaaaaa" });
    await chat("second", { conversationId: "bbbbbbbb" });
    const byId = new Map<string, string[]>();
    for (const post of posts) {
      const { id, body } = parse(post);
      byId.set(id, [...(byId.get(id) ?? []), body]);
    }
    expect(byId.get("aaaaaaaa")?.[1]).toBe("first");
    expect(byId.get("bbbbbbbb")?.[1]).toBe("second");
  });

  it("drops an id that is not 8 to 32 lowercase letters and digits", async () => {
    for (const conversationId of [
      "short12",
      "a".repeat(33),
      "UPPERCASE1",
      "abc12345] [conversation zzzzzzzz",
      "abc12345\n",
      12345678,
      null,
    ]) {
      posts = [];
      expect((await chat("ok", { conversationId })).status).toBe(200);
      expect(posts.length, String(conversationId)).toBe(2);
      for (const post of posts)
        expect(parse(post).id, String(conversationId)).toBeUndefined();
    }
  });

  it("accepts the ends of the length range", () => {
    expect(conversationTag("a".repeat(8))).not.toBe("");
    expect(conversationTag("a".repeat(32))).not.toBe("");
    expect(conversationTag("a".repeat(7))).toBe("");
    expect(conversationTag("a".repeat(33))).toBe("");
  });
});

describe("long answers in the Discord log", () => {
  const tag = conversationTag("k3j9x0ab12cd");

  /**
   * Check the posts fit, are numbered in order, and, as Discord stores them,
   * join to the answer.
   */
  function expectParts(text: string, posts: string[]): void {
    const parsed = posts.map((post) => parse(post.trim()));
    for (const post of posts) expect(post.length).toBeLessThanOrEqual(2000);
    expect(parsed.map((p) => [p.part, p.of])).toEqual(
      parsed.map((_, i) => [i + 1, posts.length]),
    );
    expect(parsed.map((p) => p.body).join("")).toBe(text);
  }

  it("splits an answer of several thousand characters, in order", async () => {
    const text = prose(4500);
    await chat(text, { conversationId: "k3j9x0ab12cd" });
    const botPostsSent = posts.slice(1);
    expect(botPostsSent.length).toBe(3);
    expectParts(text, botPostsSent);
    // The cuts fall at line ends, not inside a word: each later part opens
    // with the line break.
    for (const post of botPostsSent.slice(1))
      expect(parse(post).body.startsWith("\n")).toBe(true);
  });

  it("sends one unnumbered post when the answer fits, and splits one character more", () => {
    const fits = "x".repeat(2000 - `[isomux.com]${tag} **Bot:**\n`.length);
    expect(botPosts(fits, tag).length).toBe(1);
    expect(botPosts(fits, tag)[0].length).toBe(2000);
    expect(parse(botPosts(fits, tag)[0]).part).toBeUndefined();
    const over = `${fits}x`;
    expect(botPosts(over, tag).length).toBe(2);
    expectParts(over, botPosts(over, tag));
  });

  it("cuts at a space when a line is longer than a post", () => {
    const text = `${"word ".repeat(1000)}end`;
    const parts = botPosts(text, tag);
    expectParts(text, parts);
    for (const post of parts.slice(1))
      expect(parse(post).body.startsWith(" ")).toBe(true);
  });

  it("keeps a blank line at a cut", () => {
    // Paragraphs: the last break before the budget is the second of a pair,
    // and the part must not end in the first.
    const text = `${"a paragraph of words that runs on for a while\n\n".repeat(100)}end`;
    const parts = botPosts(text, tag);
    expect(parts.length).toBeGreaterThan(1);
    expectParts(text, parts);
    for (const post of parts.slice(1))
      expect(parse(post).body.startsWith("\n\n")).toBe(true);
  });

  it("cuts text with no break anywhere without splitting a character", () => {
    // Each emoji is two UTF-16 units; the leading "x" puts an odd number of
    // units before every pair, so a cut at the budget lands inside one.
    for (const text of [`x${"😀".repeat(2500)}`, `${"😀".repeat(2500)}`]) {
      const parts = botPosts(text, "");
      expectParts(text, parts);
      for (const post of parts) {
        const { body } = parse(post);
        expect(body.isWellFormed()).toBe(true);
      }
    }
  });
});
