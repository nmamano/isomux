// Mock Anthropic Messages API for the tier B load test. The real claude CLI
// talks to it through ANTHROPIC_BASE_URL, so no tokens are spent.
//
// A member message "LT <id> <events> <intervalMs> <bytes>" starts a turn of
// R = ceil(events/3) model rounds. Each round but the last answers with a text
// block "LTOUT <id> <k> <ms>" and a Bash tool_use (echo); the last answers with
// text and end_turn. Each response waits <intervalMs> (model time), then
// streams, so the timestamp in the text is the moment it leaves the mock.
// Calls without tools (the CLI's small-model side calls) get a plain "ok".
// Env: MOCK_PORT, LT_DIR (engine.jsonl receipt times, mock.log call counts).
import { appendFileSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.MOCK_PORT ?? 18080);
const DIR = process.env.LT_DIR ?? ".";
const now = () => performance.timeOrigin + performance.now();
let receipts: string[] = [];
let other = 0;
let calls = 0;
setInterval(() => {
  if (receipts.length) {
    appendFileSync(join(DIR, "engine.jsonl"), receipts.join("\n") + "\n");
    receipts = [];
  }
}, 1000);

type Block = {
  type: string;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
};
type Msg = { role: string; content: string | Block[] };

function textOf(c: Msg["content"]): string {
  if (typeof c === "string") return c;
  return c
    .map((b) =>
      b.type === "text"
        ? (b.text ?? "")
        : b.type === "tool_result"
          ? JSON.stringify(b.content ?? "")
          : "",
    )
    .join("\n");
}

function sse(build: () => [string, unknown][], waitMs: number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      if (waitMs > 0) await Bun.sleep(waitMs);
      for (const [ev, data] of build())
        ctl.enqueue(
          enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      ctl.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

let seq = 0;
function reply(
  model: string,
  stream: boolean,
  textAt: () => string,
  tool: string | null,
  spreadMs: number,
): Response {
  const id = `msg_lt${++seq}`;
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const stop = tool ? "tool_use" : "end_turn";
  const toolId = `toolu_lt${seq}`;
  if (!stream) {
    const content: unknown[] = [{ type: "text", text: textAt() }];
    if (tool)
      content.push({
        type: "tool_use",
        id: toolId,
        name: "Bash",
        input: { command: tool, description: "echo" },
      });
    return Response.json({
      id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage,
    });
  }
  return sse(() => {
    const text = textAt();
    const evs: [string, unknown][] = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      ],
    ];
    const parts = text.match(/.{1,200}/gs) ?? [""];
    for (const p of parts)
      evs.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: p },
        },
      ]);
    evs.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
    if (tool) {
      evs.push([
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: {},
          },
        },
      ]);
      evs.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              command: tool,
              description: "echo",
            }),
          },
        },
      ]);
      evs.push([
        "content_block_stop",
        { type: "content_block_stop", index: 1 },
      ]);
    }
    evs.push([
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ]);
    evs.push(["message_stop", { type: "message_stop" }]);
    return evs;
  }, spreadMs);
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    calls++;
    if (
      req.method === "POST" &&
      url.pathname.endsWith("/v1/messages/count_tokens")
    )
      return Response.json({ input_tokens: 100 });
    if (req.method === "GET" && url.pathname.endsWith("/v1/models"))
      return Response.json({
        data: [
          { id: "claude-sonnet-4-5", type: "model", display_name: "Mock" },
        ],
        has_more: false,
      });
    if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
      appendFileSync(join(DIR, "mock.log"), `${req.method} ${url.pathname}\n`);
      return new Response("{}", { status: 404 });
    }
    const t = now();
    const body = (await req.json()) as {
      model: string;
      stream?: boolean;
      messages: Msg[];
      tools?: unknown[];
    };
    const msgs = body.messages ?? [];
    // The newest LT marker in a user message names the turn; the tool_results
    // after it count the rounds already done.
    let at = -1;
    let m: RegExpExecArray | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const mm = /LT (\S+) (\d+) (\d+) (\d+)/.exec(textOf(msgs[i].content));
      if (mm && !textOf(msgs[i].content).includes("LTOUT")) {
        at = i;
        m = mm;
        break;
      }
    }
    const hasTools = (body.tools?.length ?? 0) > 0;
    if (!m || !hasTools) {
      other++;
      return reply(body.model, !!body.stream, () => "ok", null, 0);
    }
    const [, id, evs, iv, bytes] = m;
    let done = 0;
    for (let i = at + 1; i < msgs.length; i++)
      if (
        msgs[i].role === "user" &&
        typeof msgs[i].content !== "string" &&
        (msgs[i].content as Block[]).some((b) => b.type === "tool_result")
      )
        done++;
    // The CLI appends system messages after the conversation; skip them.
    let lastConv = msgs.length - 1;
    while (lastConv > 0 && msgs[lastConv].role === "system") lastConv--;
    if (done === 0 && at === lastConv) receipts.push(JSON.stringify({ id, t }));
    const rounds = Math.max(1, Math.ceil(Number(evs) / 3));
    const k = done;
    const pad = "x".repeat(Number(bytes));
    const last = k >= rounds - 1;
    const tool = last ? null : `echo LTOUT ${id} ${k * 3 + 1} done`;
    // The last round's text marks the end of the turn for the generator.
    const kk = last ? Number(evs) - 1 : k * 3;
    return reply(
      body.model,
      !!body.stream,
      () => `LTOUT ${id} ${kk} ${now()} ${pad}`,
      tool,
      Number(iv),
    );
  },
});
setInterval(
  () =>
    appendFileSync(join(DIR, "mock.log"), `calls=${calls} other=${other}\n`),
  10000,
);
console.log(`mock on ${PORT}`);
