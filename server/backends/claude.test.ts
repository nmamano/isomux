// Claude backend - T2 adapter-contract tier.
//
// This file is the Claude half of the adapter-contract net (the Codex half is
// server/backends/codex/adapter.test.ts). It freezes the claude-agent-sdk
// SDKMessage -> NormalizedEvent translation by feeding curated SDK messages to
// the pure `translateSDKMessage` generator and asserting the emitted events.
// Zero LLM: plain `bun test` runs it always; refresh the fixtures on
// claude-agent-sdk bumps. The session-lifecycle seam (ClaudeSession + the
// injected SdkClient), user messages and session-message flattening are
// covered in claude.session.test.ts; the live end-to-end smoke is
// server/backends/live-smoke.test.ts (T3, opt-in). See
// internal-docs/generic-runtime-refactor.md, Testing strategy -> test tiers.
import { describe, expect, it } from "bun:test";
import {
  translateSDKMessage,
  type ImageSink,
  type TranslateOptions,
} from "./claude";
import { msg } from "../../shared/i18n/log-message.ts";
import { inertMarkdown, providerText } from "./provider-text.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopSink: ImageSink = () => null;

function recordingSink(): {
  sink: ImageSink;
  calls: Parameters<ImageSink>[0][];
} {
  const calls: Parameters<ImageSink>[0][] = [];
  const sink: ImageSink = (args) => {
    calls.push(args);
    return {
      filename: args.suggestedName,
      originalName: args.suggestedName,
      mediaType: args.mediaType,
      size: args.data.length,
    };
  };
  return { sink, calls };
}

function translate(
  msg: unknown,
  sink: ImageSink = noopSink,
  options?: TranslateOptions,
) {
  return [...translateSDKMessage(msg as SDKMessage, sink, options)];
}

// ---------------------------------------------------------------------------
// translateSDKMessage
// ---------------------------------------------------------------------------

describe("translateSDKMessage - system", () => {
  it("init with all fields emits system_init", () => {
    const events = translate({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      slash_commands: ["help"],
      model: "claude-opus-4-8",
    });
    expect(events).toEqual([
      {
        kind: "system_init",
        sessionId: "s-1",
        slashCommands: ["help"],
        model: "claude-opus-4-8",
      },
    ]);
  });

  it("init carries the MCP servers, the API key source and the plugins", () => {
    const [event] = translate({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      slash_commands: [],
      model: "x",
      apiKeySource: "none",
      mcp_servers: [
        { name: "claude.ai Gmail", status: "pending", source: "claudeai" },
        { name: "local", status: "connected" },
      ],
      plugins: [
        { name: "p", path: "/plugins/p", source: "p@m" },
        { name: "core", path: "builtin", source: "core@builtin" },
      ],
    });
    expect(event).toMatchObject({
      kind: "system_init",
      apiKeySource: "none",
      mcpServers: [
        { name: "claude.ai Gmail", status: "pending", source: "claudeai" },
        { name: "local", status: "connected" },
      ],
      plugins: [
        { name: "p", path: "/plugins/p", source: "p@m" },
        { name: "core", path: "builtin", source: "core@builtin" },
      ],
    });
  });

  it("init without session_id or slash_commands still emits", () => {
    const events = translate({
      type: "system",
      subtype: "init",
      model: "x",
    });
    expect(events).toEqual([
      {
        kind: "system_init",
        sessionId: undefined,
        slashCommands: [],
        model: "x",
      },
    ]);
  });

  it("local_command_output emits system_text; empty content is dropped", () => {
    const events = translate({
      type: "system",
      subtype: "local_command_output",
      content: "Hello",
    });
    expect(events).toEqual([{ kind: "system_text", text: "Hello" }]);
    expect(
      translate({
        type: "system",
        subtype: "local_command_output",
        content: "",
      }),
    ).toEqual([]);
  });

  // decision_reason and the subagent's agent_id are optional.
  for (const [extra, expected] of [
    [
      {
        decision_reason_type: "classifier",
        decision_reason: "Auto mode declined this command",
      },
      { decisionReason: "Auto mode declined this command" },
    ],
    [{}, {}],
    [{ agent_id: "subagent-7" }, { agentId: "subagent-7" }],
  ] as const) {
    it(`permission_denied ${JSON.stringify(Object.keys(extra))} emits a permission_denied event`, () => {
      const events = translate({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "toolu-1",
        message: "Permission to use Bash has been denied.",
        uuid: "u-1",
        session_id: "s-1",
        ...extra,
      });
      expect(events).toEqual([
        {
          kind: "permission_denied",
          toolUseId: "toolu-1",
          toolName: "Bash",
          message: "Permission to use Bash has been denied.",
          ...expected,
        },
      ]);
    });
  }

  it("permission_denied free text is collapsed to one capped line", () => {
    const events = translate({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu-3",
      message: `multi\nline\t${"x".repeat(300)}`,
      uuid: "u-3",
      session_id: "s-1",
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as { kind: string; message: string };
    expect(ev.kind).toBe("permission_denied");
    expect(ev.message).not.toInclude("\n");
    expect(ev.message).toStartWith("multi line x");
    expect(ev.message.length).toBeLessThanOrEqual(200);
  });

  it("an unknown system subtype or message type is dropped", () => {
    expect(translate({ type: "system", subtype: "compact_boundary" })).toEqual(
      [],
    );
    expect(translate({ type: "tool_progress", whatever: 1 })).toEqual([]);
  });
});

describe("translateSDKMessage - assistant", () => {
  it("an empty text or thinking block is dropped", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    expect(events).toEqual([]);
  });

  it("synthetic model text routes to system_text", () => {
    const events = translate({
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "queue flushed" }],
      },
    });
    expect(events).toEqual([{ kind: "system_text", text: "queue flushed" }]);
  });

  it("synthetic oauth_org_not_allowed marks the notice claudeAccessDenied", () => {
    const events = translate({
      type: "assistant",
      error: "oauth_org_not_allowed",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "org text" }],
      },
    });
    expect(events).toEqual([
      { kind: "system_text", text: "org text", claudeAccessDenied: true },
    ]);
  });

  // Bedrock and Vertex own authentication: their words pass through, and
  // Claude's sign-in card does not apply.
  for (const provider of ["bedrock", "vertex"])
    it(`passes a ${provider} sign-in notice through as text`, () => {
      const events = translate(
        {
          type: "assistant",
          error: "authentication_failed",
          message: {
            model: "<synthetic>",
            content: [{ type: "text", text: "Not logged in" }],
          },
        },
        noopSink,
        { provider },
      );
      expect(events).toEqual([{ kind: "system_text", text: "Not logged in" }]);
    });

  // Task 2bd836d5. Claude Code turns every 401 and 403 from the API into a
  // synthetic authentication_failed message (CLI 2.1.293, read from the
  // bundled binary 2026-10-19): "Failed to authenticate. API Error: <status>
  // <body>" in SDK mode, "Please run /login · API Error: ..." otherwise. A 403
  // is the provider refusing the request: the member reads its words, and the
  // line is Isomux's own, so the orchestrator does not sniff it for sign-in.
  describe("provider refusal", () => {
    const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const BODY = `403 {"type":"error","error":{"type":"forbidden","message":"Request not allowed. See [your account](https://evil.example/login) ${SECRET}"}}`;
    const synthetic = (text: string, error?: string) => ({
      type: "assistant",
      ...(error ? { error } : {}),
      message: { model: "<synthetic>", content: [{ type: "text", text }] },
    });
    // The line is a message each reader words (task c37a7365).
    const refusalLine = (provider: string) =>
      msg("systemEntries.providerRefused", {
        provider,
        message: inertMarkdown(providerText(BODY)!),
      });

    it("quotes a 403 as the provider's refusal", () => {
      for (const text of [
        `Failed to authenticate. API Error: ${BODY}`,
        `Please run /login \u00b7 API Error: ${BODY}`,
      ]) {
        const events = translate(
          synthetic(text, "authentication_failed"),
          noopSink,
          { provider: "bedrock" },
        );
        expect(events).toEqual([
          {
            kind: "system_text",
            text: refusalLine("bedrock"),
          },
        ]);
        expect(JSON.stringify(events)).not.toContain(SECRET.slice(7));
      }
    });

    it("keeps a 401 on the sign-in path", () => {
      const text = `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`;
      expect(
        translate(synthetic(text, "authentication_failed"), noopSink, {
          provider: "anthropic",
        }),
      ).toEqual([{ kind: "auth_needed" }]);
    });

    // The match keys on the CLI's typed error code, not on text alone: a
    // synthetic notice that only quotes a 403 is passed on as it is.
    it("needs the authentication_failed code", () => {
      const text = `Failed to authenticate. API Error: ${BODY}`;
      for (const error of [undefined, "rate_limit", "server_error"])
        expect(
          translate(synthetic(text, error), noopSink, {
            provider: "anthropic",
          }),
        ).toEqual([{ kind: "system_text", text }]);
    });
  });

  it("thinking, text and tool_use blocks emit in order; a tool_use without input gets {}", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "think" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "u1", name: "Read", input: { path: "/x" } },
          { type: "tool_use", id: "u2", name: "Read" },
        ],
      },
    });
    expect(events).toEqual([
      { kind: "thinking", text: "think" },
      { kind: "assistant_text", text: "hi" },
      {
        kind: "tool_call",
        toolUseId: "u1",
        name: "Read",
        input: { path: "/x" },
      },
      { kind: "tool_call", toolUseId: "u2", name: "Read", input: {} },
    ]);
  });

  it("missing message content is dropped", () => {
    const events = translate({ type: "assistant", message: {} });
    expect(events).toEqual([]);
  });
});

describe("translateSDKMessage - user (tool_result)", () => {
  it("string content emits tool_result; is_error sets isError", () => {
    const events = translate({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "u1", content: "ok" },
          {
            type: "tool_result",
            tool_use_id: "u2",
            content: "err",
            is_error: true,
          },
        ],
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_result",
        toolUseId: "u1",
        content: "ok",
        attachments: undefined,
        isError: false,
      },
      {
        kind: "tool_result",
        toolUseId: "u2",
        content: "err",
        attachments: undefined,
        isError: true,
      },
    ]);
  });

  for (const [label, content, flat] of [
    [
      "text blocks join with newline",
      [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      "line1\nline2",
    ],
    ["object content stringifies to JSON", { foo: "bar" }, '{"foo":"bar"}'],
  ] as const) {
    it(`tool_result ${label}`, () => {
      const events = translate({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "u1", content }],
        },
      });
      expect(events[0]).toMatchObject({ content: flat });
    });
  }

  it("image block calls imageSink and attaches what it saved", () => {
    const { sink, calls } = recordingSink();
    const events = translate(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "u1",
              content: [
                { type: "text", text: "Here:" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: Buffer.from("PNGDATA").toString("base64"),
                  },
                },
              ],
            },
          ],
        },
      },
      sink,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].mediaType).toBe("image/png");
    expect(calls[0].suggestedName).toBe("image.png");
    expect(calls[0].data).toEqual(Buffer.from("PNGDATA"));
    expect(events[0]).toMatchObject({
      attachments: [{ mediaType: "image/png" }],
    });
    // content is the joined text from non-image blocks
    expect(events[0]).toMatchObject({ content: "Here:" });
    // A sink that saves nothing leaves no attachment, not [null].
    const unsaved = translate(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "u1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AAAA",
                  },
                },
              ],
            },
          ],
        },
      },
      () => null,
    );
    expect(unsaved[0]).toMatchObject({ attachments: undefined });
  });

  it("missing user content is dropped", () => {
    const events = translate({ type: "user", message: {} });
    expect(events).toEqual([]);
  });

  it("non-tool_result blocks in user content are skipped", () => {
    const events = translate({
      type: "user",
      message: {
        content: [{ type: "text", text: "ignored" }],
      },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSDKMessage - result", () => {
  it("success with usage and cost emits turn_completed completed", () => {
    const events = translate({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
      total_cost_usd: 0.001,
    });
    expect(events).toEqual([
      {
        kind: "turn_completed",
        status: "completed",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
        },
        cost: 0.001,
      },
    ]);
    // Missing usage subfields default to zero.
    const sparse = translate({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1 },
      total_cost_usd: 0,
    });
    expect(sparse[0]).toMatchObject({
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("error subtype -> turn_completed failed, naming the subtype and its errors", () => {
    const events = translate({
      type: "result",
      subtype: "error_during_execution",
      errors: ["err1", "err2"],
    });
    expect(events[0]).toMatchObject({
      kind: "turn_completed",
      status: "failed",
    });
    const { error } = events[0] as { error: string };
    for (const part of ["error_during_execution", "err1", "err2"])
      expect(error).toContain(part);
    // With no errors listed, the line names the subtype and nothing undefined.
    const [bare] = translate({
      type: "result",
      subtype: "error_max_turns",
    }) as {
      error: string;
    }[];
    expect(bare.error).toContain("error_max_turns");
    expect(bare.error).not.toContain("undefined");
  });

  it("an auth-shaped failure is a sign-in signal ahead of the failed turn", () => {
    const events = translate({
      type: "result",
      subtype: "error_during_execution",
      errors: ["401 Unauthorized"],
    });
    expect(events.map((ev) => ev.kind)).toEqual([
      "auth_needed",
      "turn_completed",
    ]);
    expect(events[1]).toMatchObject({ status: "failed" });
  });

  it("error-subtype usage is NOT trusted - coerced to undefined", () => {
    const events = translate({
      type: "result",
      subtype: "error_max_turns",
      usage: { input_tokens: 5 },
      errors: [],
    });
    expect(events[0]).toMatchObject({ usage: undefined });
  });
});

// The SDK forwards a subagent's tool_use/tool_result blocks on the SAME stream
// as the parent's, marked only by a non-null parent_tool_use_id. Without that
// mark the transcript reads as one flat run of tool calls (verified against a
// real office log: an Agent call, 56 rows of the subagent's Bash/Read, then the
// Agent call's own result).
describe("translateSDKMessage - subagent origin", () => {
  function subagentToolUse(over: Record<string, unknown> = {}) {
    return {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "tool_use", id: "toolu_child", name: "Read", input: {} },
        ],
      },
      parent_tool_use_id: "toolu_parent",
      subagent_type: "Explore",
      task_description: "Find every caller of foo",
      ...over,
    };
  }

  for (const [label, over, subagent] of [
    [
      "with the parent call id, type and description",
      {},
      {
        parentToolUseId: "toolu_parent",
        type: "Explore",
        description: "Find every caller of foo",
      },
    ],
    [
      "with the parent id alone when the SDK omits type and description",
      { subagent_type: undefined, task_description: undefined },
      { parentToolUseId: "toolu_parent" },
    ],
    [
      "with a multi-line task description collapsed to one line",
      { task_description: "line one\n\n  line two  " },
      {
        parentToolUseId: "toolu_parent",
        type: "Explore",
        description: "line one line two",
      },
    ],
    [
      "not at all when it is the agent's own call",
      {
        parent_tool_use_id: null,
        subagent_type: undefined,
        task_description: undefined,
      },
      undefined,
    ],
  ] as const) {
    it(`marks a tool_call ${label}`, () => {
      const [event] = translate(subagentToolUse(over));
      expect(event).toMatchObject({ kind: "tool_call", name: "Read" });
      expect((event as { subagent?: unknown }).subagent).toEqual(subagent);
    });
  }

  it("marks the subagent's tool_result too, and not the agent's own", () => {
    const events = translate({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_child", content: "done" },
        ],
      },
      parent_tool_use_id: "toolu_parent",
    });
    expect(events[0]).toMatchObject({
      kind: "tool_result",
      subagent: { parentToolUseId: "toolu_parent" },
    });
    const [own] = translate({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
        ],
      },
      parent_tool_use_id: null,
    });
    expect(own).not.toHaveProperty("subagent");
  });
});
