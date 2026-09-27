// A real turn on the pinned OpenCode server makes an office call through the
// authority broker: a mock provider asks for a bash tool call, and OpenCode
// runs curl as a descendant of its own server. It spends no model credits, but
// starting the server makes it too costly for the default suite:
//
//   ISOMUX_TEST_OPENCODE=1 bun test server/backends/opencode/authority-broker.opencode.test.ts

import { afterEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NormalizedEvent } from "../types.ts";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { OPENCODE_TURN_HANDLE_PLACEHOLDER } from "./office-proxy-shared.ts";
import {
  OPENCODE_INTERACTIVE_BYPASS_AGENT,
  OpenCodeSupervisor,
} from "./supervisor.ts";
import { OpenCodeTransport } from "./transport.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function officeCall(socketPath: string, handle: string): string {
  return `curl -s -w ' status=%{http_code}' --unix-socket ${quote(socketPath)} -H ${quote(`X-Isomux-Turn: ${handle}`)} http://isomux/agents`;
}

it.skipIf(!LIVE)(
  "runs an office call from a real OpenCode bash tool and refuses a process outside its server",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-abo-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "authority", "authority.sock");

    const officeCalls: Array<{ authorization: string | null; path: string }> =
      [];
    const office = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        officeCalls.push({
          authorization: request.headers.get("authorization"),
          path: new URL(request.url).pathname,
        });
        return Response.json({ office: "reached" });
      },
    });
    cleanup.push(() => office.stop(true));
    const broker = new OpenCodeAuthorityBroker(
      socketPath,
      process.getuid?.() ?? -1,
      `http://127.0.0.1:${office.port}`,
    );
    cleanup.push(() => broker.close());

    let outsiderStatus = "";
    let toolResult = "";
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models")
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        if (url.pathname !== "/v1/chat/completions")
          return new Response("not found", { status: 404 });
        const body = (await request.json()) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        const messages = body.messages ?? [];
        const text = (content: unknown) =>
          typeof content === "string" ? content : JSON.stringify(content);
        const handle = /Office handle: (\S+)/.exec(
          messages
            .filter((message) => message.role === "system")
            .map((message) => text(message.content))
            .join("\n"),
        )?.[1];
        const tool = messages.find((message) => message.role === "tool");
        const base = {
          id: "gate",
          object: "chat.completion.chunk",
          created: 1,
          model: "gate-model",
        };
        const chunks: unknown[] = [
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          },
        ];
        if (!tool && handle) {
          // This provider runs in the test process, which is outside the
          // OpenCode server's tree, while the turn is active.
          const outsider = Bun.spawn(
            ["sh", "-c", officeCall(socketPath, handle)],
            { stdout: "pipe" },
          );
          await outsider.exited;
          outsiderStatus = (await new Response(outsider.stdout).text()).trim();
          chunks.push(
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_office",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: officeCall(socketPath, handle),
                            description: "Call the office",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          );
        } else {
          toolResult = tool ? text(tool.content) : "no tool result";
          chunks.push(
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { content: "Office call done." },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          );
        }
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of chunks)
              controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
            controller.enqueue("data: [DONE]\n\n");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    cleanup.push(() => provider.stop(true));

    const supervisor = new OpenCodeSupervisor({
      profileDir: join(root, "profile"),
      serverCwd: root,
      config: {
        autoupdate: false,
        share: "disabled",
        model: "gate/gate-model",
        small_model: "gate/gate-model",
        permission: { bash: "ask", edit: "ask", question: "deny" },
        agent: {
          [OPENCODE_INTERACTIVE_BYPASS_AGENT]: {
            description: "Isomux interactive non-asking agent",
            mode: "primary",
            permission: { bash: "ask", edit: "ask", question: "deny" },
          },
        },
        provider: {
          gate: {
            name: "Gate mock",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "gate-model": {
                name: "Gate model",
                tool_call: true,
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
              },
            },
            options: {
              apiKey: "test-only",
              baseURL: `http://127.0.0.1:${provider.port}/v1`,
            },
          },
        },
      },
    });
    cleanup.push(() => supervisor.shutdown());

    const transport = new OpenCodeTransport({
      supervisor,
      cwd: root,
      model: "gate/gate-model",
      systemPrompt: `Office handle: ${OPENCODE_TURN_HANDLE_PLACEHOLDER}`,
      agentToken: "agent-token-x",
      agentId: "agent-x",
      authorityBroker: broker,
      agent: OPENCODE_INTERACTIVE_BYPASS_AGENT,
    });
    cleanup.push(() => transport.close());
    const events: NormalizedEvent[] = [];
    const completed = Promise.withResolvers<void>();
    await transport.send([{ type: "text", text: "Call the office." }], (event) => {
      events.push(event);
      if (event.kind === "turn_completed") completed.resolve();
    });
    await completed.promise;

    expect(events.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "completed",
    });
    expect(outsiderStatus).toEndWith("status=403");
    expect(toolResult).toContain('{"office":"reached"} status=200');
    expect(officeCalls).toEqual([
      { authorization: "Bearer agent-token-x", path: "/agents" },
    ]);
  },
  90_000,
);
