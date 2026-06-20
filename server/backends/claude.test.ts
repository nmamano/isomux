// Claude backend — T2 adapter-contract tier.
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

describe("translateSDKMessage — system", () => {
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

  it("unknown system subtype is dropped", () => {
    const events = translate({ type: "system", subtype: "compact_boundary" });
    expect(events).toEqual([]);
  });
});

describe("translateSDKMessage — assistant", () => {
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

describe("translateSDKMessage — user (tool_result)", () => {
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

describe("translateSDKMessage — result", () => {
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

  it("error-subtype usage is NOT trusted — coerced to undefined", () => {
    const events = translate({
      type: "result",
      subtype: "error_max_turns",
      usage: { input_tokens: 5 },
      errors: [],
    });
    expect(events[0]).toMatchObject({ usage: undefined });
  });
});

describe("translateSDKMessage — unknown", () => {
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
// buildClaudeUserMessage — real persistence under unique agent id
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

  it("empty text with no attachments yields no content blocks", () => {
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", []);
    expect(msg.message.content).toEqual([]);
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

  it("image attachment is inlined as base64 image block", () => {
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
    expect(msg.message.content).toEqual([
      { type: "text", text: "see:" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: bytes.toString("base64"),
        },
      },
    ]);
  });

  it("small PDF attachment is inlined as base64 document block", () => {
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
    const content = msg.message.content as { type?: string }[];
    const docBlock = content.find((b) => b.type === "document");
    expect(docBlock).toBeDefined();
    expect(docBlock).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: bytes.toString("base64"),
      },
    });
  });

  it("text-file attachment is inlined as a fenced text block", () => {
    fixtureFile("hello.ts", "export const x = 1;\n");
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "look:", [
      {
        filename: "hello.ts",
        originalName: "hello.ts",
        mediaType: "text/plain",
        size: 10,
      },
    ]);
    const content = msg.message.content as { type?: string; text?: string }[];
    const textBlocks = content.filter((b) => b.type === "text") as {
      type: "text";
      text: string;
    }[];
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[1].text).toContain("--- File: hello.ts ---");
    expect(textBlocks[1].text).toContain("export const x = 1;");
  });

  it("unknown-extension attachment emits placeholder text", () => {
    fixtureFile("blob.xyz", Buffer.from([0, 1, 2]));
    const msg = buildClaudeUserMessage(TEST_AGENT_ID, "", [
      {
        filename: "blob.xyz",
        originalName: "blob.xyz",
        mediaType: "application/octet-stream",
        size: 3,
      },
    ]);
    const content = msg.message.content as { type?: string; text?: string }[];
    expect(content).toHaveLength(1);
    const block = content[0] as { type: "text"; text: string };
    expect(block.text).toContain("Attached file blob.xyz");
    expect(block.text).toContain("unable to see content");
  });
});
