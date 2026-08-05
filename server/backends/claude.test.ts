// Claude backend - T2 adapter-contract tier.
//
// This file is the Claude half of the adapter-contract net (the Codex half is
// server/backends/codex/adapter.test.ts). It freezes the claude-agent-sdk
// SDKMessage -> NormalizedEvent translation by feeding curated SDK messages to
// the pure `translateSDKMessage` generator and asserting the emitted events,
// plus the user-message builder (`buildClaudeUserMessage`) and session-message
// flattening. Zero LLM: plain `bun test` runs it always; refresh the fixtures
// on claude-agent-sdk bumps. The session-lifecycle seam (ClaudeSession + the
// injected SdkClient) is covered in claude.session.test.ts; the live
// end-to-end smoke is server/backends/live-smoke.test.ts (T3, opt-in). See
// internal-docs/generic-runtime-refactor.md, Testing strategy -> test tiers.
import { describe, expect, it, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { STATE_ROOT } from "../config.ts";
import {
  translateSDKMessage,
  flattenSessionMessageText,
  buildClaudeUserMessage,
  type ImageSink,
} from "./claude";
import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

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

function translate(msg: unknown, sink: ImageSink = noopSink) {
  return [...translateSDKMessage(msg as SDKMessage, sink)];
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

  it("init without session_id emits with undefined sessionId", () => {
    const events = translate({
      type: "system",
      subtype: "init",
      slash_commands: [],
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

  it("init falls back to empty slash_commands when missing", () => {
    const events = translate({
      type: "system",
      subtype: "init",
      session_id: "s",
    });
    expect(events[0]).toMatchObject({ slashCommands: [] });
  });

  it("local_command_output with content emits system_text", () => {
    const events = translate({
      type: "system",
      subtype: "local_command_output",
      content: "Hello",
    });
    expect(events).toEqual([{ kind: "system_text", text: "Hello" }]);
  });

  it("local_command_output with empty content is dropped", () => {
    const events = translate({
      type: "system",
      subtype: "local_command_output",
      content: "",
    });
    expect(events).toEqual([]);
  });

  it("permission_denied emits a permission_denied event", () => {
    const events = translate({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu-1",
      decision_reason_type: "classifier",
      decision_reason: "Auto mode declined this command",
      message: "Permission to use Bash has been denied.",
      uuid: "u-1",
      session_id: "s-1",
    });
    expect(events).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "toolu-1",
        toolName: "Bash",
        message: "Permission to use Bash has been denied.",
        decisionReason: "Auto mode declined this command",
      },
    ]);
  });

  it("permission_denied without decision_reason omits decisionReason", () => {
    const events = translate({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Write",
      tool_use_id: "toolu-2",
      message: "Denied by rule.",
      uuid: "u-2",
      session_id: "s-1",
    });
    expect(events).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "toolu-2",
        toolName: "Write",
        message: "Denied by rule.",
      },
    ]);
  });

  it("permission_denied preserves the subagent agent_id", () => {
    const events = translate({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu-4",
      agent_id: "subagent-7",
      message: "Denied.",
      uuid: "u-4",
      session_id: "s-1",
    });
    expect(events).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "toolu-4",
        toolName: "Bash",
        message: "Denied.",
        agentId: "subagent-7",
      },
    ]);
  });

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

  it("unknown system subtype is dropped", () => {
    const events = translate({ type: "system", subtype: "compact_boundary" });
    expect(events).toEqual([]);
  });
});

describe("translateSDKMessage - assistant", () => {
  it("text block emits assistant_text", () => {
    const events = translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(events).toEqual([{ kind: "assistant_text", text: "hi" }]);
  });

  it("empty text block is dropped", () => {
    const events = translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
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

  it("tool_use block emits tool_call with id/name/input", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "u1", name: "Read", input: { path: "/x" } },
        ],
      },
    });
    expect(events).toEqual([
      {
        kind: "tool_call",
        toolUseId: "u1",
        name: "Read",
        input: { path: "/x" },
      },
    ]);
  });

  it("tool_use without input defaults to empty object", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "u1", name: "Read" }],
      },
    });
    expect(events[0]).toMatchObject({ input: {} });
  });

  it("thinking block emits thinking event", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "ponder" }],
      },
    });
    expect(events).toEqual([{ kind: "thinking", text: "ponder" }]);
  });

  it("empty thinking is dropped", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "" }],
      },
    });
    expect(events).toEqual([]);
  });

  it("multiple blocks emit in order", () => {
    const events = translate({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "think" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "u1", name: "X", input: {} },
        ],
      },
    });
    expect(events.map((e) => e.kind)).toEqual([
      "thinking",
      "assistant_text",
      "tool_call",
    ]);
  });

  it("non-array message content is dropped", () => {
    const events = translate({
      type: "assistant",
      message: { content: "not-array" },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSDKMessage - user (tool_result)", () => {
  it("string content emits tool_result", () => {
    const events = translate({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }],
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
    ]);
  });

  it("array of text blocks joins with newline", () => {
    const events = translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "u1",
            content: [
              { type: "text", text: "line1" },
              { type: "text", text: "line2" },
            ],
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({ content: "line1\nline2" });
  });

  it("is_error: true sets isError", () => {
    const events = translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "u1",
            content: "err",
            is_error: true,
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({ isError: true });
  });

  it("object content stringifies to JSON", () => {
    const events = translate({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "u1", content: { foo: "bar" } },
        ],
      },
    });
    expect(events[0]).toMatchObject({ content: '{"foo":"bar"}' });
  });

  it("image block calls imageSink and attaches result", () => {
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
  });

  it("imageSink returning null leaves attachments undefined", () => {
    const events = translate(
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
    expect(events[0]).toMatchObject({ attachments: undefined });
  });

  it("unknown image media_type falls back to default extension via suggestedName", () => {
    // media_type like "image/svg+xml" → suggestedName uses split("/")[1] = "svg+xml"
    const { sink, calls } = recordingSink();
    translate(
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
                    media_type: "image/svg+xml",
                    data: "AAAA",
                  },
                },
              ],
            },
          ],
        },
      },
      sink,
    );
    expect(calls[0].suggestedName).toBe("image.svg+xml");
  });

  it("non-array user content is dropped", () => {
    const events = translate({
      type: "user",
      message: { content: "not-array" },
    });
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
  });

  it("success with missing usage subfields defaults to zero", () => {
    const events = translate({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1 },
      total_cost_usd: 0,
    });
    expect(events[0]).toMatchObject({
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("error subtype with errors → turn_completed failed with joined message", () => {
    const events = translate({
      type: "result",
      subtype: "error_during_execution",
      errors: ["err1", "err2"],
    });
    expect(events[0]).toMatchObject({
      kind: "turn_completed",
      status: "failed",
      error: "Agent stopped: error_during_execution. err1, err2",
    });
  });

  it("error subtype without errors yields empty error suffix", () => {
    const events = translate({
      type: "result",
      subtype: "error_max_turns",
    });
    expect(events[0]).toMatchObject({
      error: "Agent stopped: error_max_turns. ",
    });
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

  it("marks a subagent's tool_call with the parent call id, type and description", () => {
    const events = translate(subagentToolUse());
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      name: "Read",
      subagent: {
        parentToolUseId: "toolu_parent",
        type: "Explore",
        description: "Find every caller of foo",
      },
    });
  });

  it("leaves the agent's own tool_call unmarked", () => {
    const events = translate(
      subagentToolUse({
        parent_tool_use_id: null,
        subagent_type: undefined,
        task_description: undefined,
      }),
    );
    expect(events[0]).toMatchObject({ kind: "tool_call" });
    expect(events[0]).not.toHaveProperty("subagent");
  });

  it("marks with the parent id alone when the SDK omits type/description", () => {
    const events = translate(
      subagentToolUse({
        subagent_type: undefined,
        task_description: undefined,
      }),
    );
    expect(events[0]).toMatchObject({
      subagent: { parentToolUseId: "toolu_parent" },
    });
    const { subagent } = events[0] as unknown as {
      subagent: Record<string, unknown>;
    };
    expect(subagent).not.toHaveProperty("type");
    expect(subagent).not.toHaveProperty("description");
  });

  it("collapses a multi-line task description to one line", () => {
    const events = translate(
      subagentToolUse({ task_description: "line one\n\n  line two  " }),
    );
    expect(events[0]).toMatchObject({
      subagent: { description: "line one line two" },
    });
  });

  it("leaves a subagent's text and thinking alone - this marks tool cards only", () => {
    // Scope guard: the SDK only forwards subagent text when forwardSubagentText
    // is set (isomux does not set it), and if that ever changes the events must
    // keep their current shape rather than silently gaining a field.
    const events = translate({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "thinking", thinking: "weighing options" },
          { type: "text", text: "done" },
        ],
      },
      parent_tool_use_id: "toolu_parent",
      subagent_type: "Explore",
    });
    expect(events).toEqual([
      { kind: "thinking", text: "weighing options" },
      { kind: "assistant_text", text: "done" },
    ]);
  });

  it("marks the subagent's tool_result too", () => {
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
  });

  it("leaves the agent's own tool_result unmarked", () => {
    const events = translate({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
        ],
      },
      parent_tool_use_id: null,
    });
    expect(events[0]).not.toHaveProperty("subagent");
  });
});

describe("translateSDKMessage - unknown", () => {
  it("ignores unknown message types", () => {
    const events = translate({ type: "tool_progress" });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flattenSessionMessageText
// ---------------------------------------------------------------------------

describe("flattenSessionMessageText", () => {
  it("string content is returned verbatim", () => {
    expect(
      flattenSessionMessageText({
        message: { content: "hello" },
      } as unknown as SessionMessage),
    ).toBe("hello");
  });

  it("array of text blocks is joined without separator", () => {
    expect(
      flattenSessionMessageText({
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      } as unknown as SessionMessage),
    ).toBe("ab");
  });

  it("non-text blocks are skipped", () => {
    expect(
      flattenSessionMessageText({
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", id: "x", name: "R", input: {} },
            { type: "text", text: "b" },
          ],
        },
      } as unknown as SessionMessage),
    ).toBe("ab");
  });

  it("null content yields empty string", () => {
    expect(
      flattenSessionMessageText({
        message: { content: null },
      } as unknown as SessionMessage),
    ).toBe("");
  });

  it("missing message yields empty string", () => {
    expect(flattenSessionMessageText({} as unknown as SessionMessage)).toBe("");
  });

  it("malformed text block (missing text field) is skipped", () => {
    expect(
      flattenSessionMessageText({
        message: {
          content: [{ type: "text" }, { type: "text", text: "ok" }],
        },
      } as unknown as SessionMessage),
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeUserMessage - real persistence under unique agent id
// ---------------------------------------------------------------------------
// buildClaudeUserMessage resolves attachments via getFilePath (looks under
// STATE_ROOT/logs/<agentId>/files/<filename>). We allocate a unique agentId per
// test and write fixtures directly under that path; an afterAll hook cleans up
// the agent dir. Uses STATE_ROOT (the config-root seam) rather than a hardcoded
// ~/.isomux, so it follows ISOMUX_HOME: the bun test preload points STATE_ROOT
// at a temp dir, and getFilePath reads from there too (previously the hardcode
// happened to match only because STATE_ROOT defaulted to ~/.isomux).

const TEST_AGENT_ID = `test-build-msg-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const AGENT_FILES_DIR = join(STATE_ROOT, "logs", TEST_AGENT_ID, "files");

function fixtureFile(filename: string, contents: Buffer | string) {
  mkdirSync(AGENT_FILES_DIR, { recursive: true });
  writeFileSync(join(AGENT_FILES_DIR, filename), contents);
}

afterAll(() => {
  try {
    rmSync(join(STATE_ROOT, "logs", TEST_AGENT_ID), {
      recursive: true,
      force: true,
    });
  } catch {}
});

describe("buildClaudeUserMessage", () => {
  it("text-only message has a single text block", () => {
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "hello world", []);
    expect(msg.type).toBe("user");
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("empty text with no attachments yields a single empty text block", () => {
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", []);
    expect(msg.message.content).toEqual([{ type: "text", text: "" }]);
  });

  it("missing attachment file is silently skipped", () => {
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "hi", [
      {
        filename: "nope.png",
        originalName: "nope.png",
        mediaType: "image/png",
        size: 0,
      },
    ]);
    expect(msg.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("image attachment becomes a path-notice text block, not an inline image", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fixtureFile("pic.png", bytes);
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "see:", [
      {
        filename: "pic.png",
        originalName: "pic.png",
        mediaType: "image/png",
        size: bytes.length,
      },
    ]);
    const content = msg.message.content as { type?: string; text?: string }[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "see:" });
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain('[Attachment: "pic.png" (image/png,');
    expect(content[1].text).toContain(join(AGENT_FILES_DIR, "pic.png"));
    expect(content.some((b) => b.type === "image")).toBe(false);
  });

  it("PDF attachment becomes a path-notice text block, not a document block", () => {
    const bytes = Buffer.from("%PDF-1.4\nfake-pdf");
    fixtureFile("doc.pdf", bytes);
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", [
      {
        filename: "doc.pdf",
        originalName: "doc.pdf",
        mediaType: "application/pdf",
        size: bytes.length,
      },
    ]);
    const content = msg.message.content as { type?: string; text?: string }[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain(
      '[Attachment: "doc.pdf" (application/pdf,',
    );
    expect(content[0].text).toContain(join(AGENT_FILES_DIR, "doc.pdf"));
    expect(content.some((b) => b.type === "document")).toBe(false);
  });

  it("text-file attachment is not inlined; contents stay out of the prompt", () => {
    fixtureFile("hello.ts", "export const x = 1;\n");
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "look:", [
      {
        filename: "hello.ts",
        originalName: "hello.ts",
        mediaType: "text/plain",
        size: 20,
      },
    ]);
    const content = msg.message.content as { type: "text"; text: string }[];
    expect(content).toHaveLength(2);
    expect(content[1].text).toContain('[Attachment: "hello.ts" (text/plain,');
    expect(content[1].text).not.toContain("export const x = 1;");
  });

  it("multiple attachments join as one text block, one line each, in order", () => {
    fixtureFile("a.png", Buffer.from([1]));
    fixtureFile("b.bin", Buffer.from([2]));
    const spec = (name: string, mediaType: string) => ({
      filename: name,
      originalName: name,
      mediaType,
      size: 1,
    });
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", [
      spec("a.png", "image/png"),
      spec("missing.txt", "text/plain"),
      spec("b.bin", "application/octet-stream"),
    ]);
    const content = msg.message.content as { type: "text"; text: string }[];
    expect(content).toHaveLength(1);
    const lines = content[0].text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"a.png"');
    expect(lines[1]).toContain('"b.bin"');
    expect(content[0].text).not.toContain("missing.txt");
  });

  it("empty text with all attachments missing yields a single empty text block", () => {
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", [
      {
        filename: "gone1.png",
        originalName: "gone1.png",
        mediaType: "image/png",
        size: 1,
      },
      {
        filename: "gone2.pdf",
        originalName: "gone2.pdf",
        mediaType: "application/pdf",
        size: 1,
      },
    ]);
    expect(msg.message.content).toEqual([{ type: "text", text: "" }]);
  });
});
