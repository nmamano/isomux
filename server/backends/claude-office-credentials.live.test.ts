// The office sign-in in an isolated member's own space, live tier
// (ISOMUX_TEST_LIVE=1), task 56b68f0f. Isomux writes the office's current
// Claude access token into the member's .credentials.json, with a dummy
// refresh token and a far expiry (server/office-login-sync.ts), and rewrites
// it when the office token changes. That rests on two things the real
// Claude Code process does, which an SDK upgrade can change:
// - a running session re-reads .credentials.json when it changes on disk,
//   and sends the new access token at its next request;
// - a far expiry keeps it from renewing on its own, so it never sends the
//   dummy refresh token while the access token works.
//
// No model is called: the API base URL is a local server that answers each
// request with a minimal reply and refuses a revoked token. The session runs
// in a temporary home; the file is written as office-login-sync writes it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
import { writeFileAtomic } from "../agent-runner/atomic-write.ts";
import { MEMBER_OFFICE_DUMMY_REFRESH } from "../office-login-sync.ts";
import { LIVE } from "../test-support/live-gate.ts";

let root: string;
let server: ReturnType<typeof Bun.serve> | undefined;
// Every HTTPS request goes through this proxy, which refuses it: no real
// network, and a renewal shows as a CONNECT to its host.
let proxy: Server | undefined;
let proxyPort = 0;
const connects: string[] = [];
// The bearer of each model request, and the paths of the others.
const bearers: string[] = [];
const other: string[] = [];
const revoked = new Set<string>();

function reply(model: string): Response {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const body = [
    event("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", {}),
  ].join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function writeCredentials(accessToken: string): Promise<void> {
  return writeFileAtomic(
    join(root, "config", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: MEMBER_OFFICE_DUMMY_REFRESH,
        expiresAt: Date.UTC(2100, 0, 1),
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
      },
    }),
    0o600,
  );
}

beforeAll(async () => {
  if (!LIVE) return;
  proxy = createServer((_req, res) => res.writeHead(403).end());
  proxy.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", () => r()));
  proxyPort = (proxy.address() as { port: number }).port;
  root = mkdtempSync(join(tmpdir(), "claude-office-credentials-live-"));
  for (const dir of ["config", "home", "folder"])
    mkdirSync(join(root, dir), { recursive: true });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/v1/messages")) {
        other.push(url.pathname);
        return new Response("{}", { status: 404 });
      }
      const bearer = (req.headers.get("authorization") ?? "").replace(
        /^Bearer /,
        "",
      );
      bearers.push(bearer);
      if (revoked.has(bearer))
        return Response.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "OAuth token has expired",
            },
          },
          { status: 401 },
        );
      const body = (await req.json().catch(() => ({}))) as { model?: string };
      return reply(body.model ?? "claude");
    },
  });
});

afterAll(() => {
  void server?.stop(true);
  proxy?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("a member's Claude on the office token file", () => {
  test("continues on a rewritten token, and never renews by itself", async () => {
    await writeCredentials("office-access-A");
    const queue: unknown[] = [];
    const waker: { wake?: () => void } = {};
    async function* input() {
      for (;;) {
        while (queue.length === 0)
          await new Promise<void>((r) => (waker.wake = r));
        const next = queue.shift();
        if (next === null) return;
        yield next as never;
      }
    }
    const send = (text: string) => {
      queue.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      });
      waker.wake?.();
    };
    const q = query({
      prompt: input(),
      options: {
        cwd: join(root, "folder"),
        pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
        settingSources: [],
        maxTurns: 1,
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server!.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: "127.0.0.1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });
    const results: { error: boolean }[] = [];
    const resulted: { notify?: () => void } = {};
    const reader = (async () => {
      for await (const m of q as AsyncIterable<{
        type: string;
        is_error?: boolean;
      }>)
        if (m.type === "result") {
          results.push({ error: !!m.is_error });
          resulted.notify?.();
        }
    })();
    const turn = async (text: string) => {
      const before = results.length;
      const done = new Promise<void>((r) => (resulted.notify = r));
      send(text);
      await Promise.race([done, Bun.sleep(30_000)]);
      return results.length > before ? results.at(-1)! : null;
    };
    try {
      const first = await turn("one");
      const firstBearers = [...new Set(bearers)];
      // The office renews: the old token is refused, Isomux writes the new.
      revoked.add("office-access-A");
      await writeCredentials("office-access-B");
      bearers.length = 0;
      connects.length = 0;
      const second = await turn("two");
      expect({
        first,
        firstBearers,
        second,
        secondBearers: [...new Set(bearers)],
        // No renewal of its own: no request left for another host.
        connects: [...connects],
      }).toEqual({
        first: { error: false },
        firstBearers: ["office-access-A"],
        second: { error: false },
        secondBearers: ["office-access-B"],
        connects: [],
      });
    } finally {
      queue.push(null);
      waker.wake?.();
      try {
        await (q as { interrupt?: () => Promise<void> }).interrupt?.();
      } catch {}
      await Promise.race([reader, Bun.sleep(2_000)]);
    }
  }, 90_000);
});
