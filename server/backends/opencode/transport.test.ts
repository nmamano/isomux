import { describe, expect, it } from "bun:test";
import {
  interruptedToolResults,
  toolUpdateEvents,
  isAuthenticationError,
  allowDiscoveredModels,
  discoverOpenCodeModels,
  allowMessages,
  OpenCodeTransport,
  parseAllowedEvent,
} from "./transport.ts";
import { writeSafeContractFixture } from "./contract-fixture.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expectRejection } from "../../test-support/expect-rejection.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import type { NormalizedEvent } from "../types.ts";
import toolInputSequences from "./fixtures/tool-input-sequences.json";

type ToolUpdate = Parameters<typeof toolUpdateEvents>[1];
const capturedArgument = toolInputSequences.argument as ToolUpdate[];
const capturedInterrupted = toolInputSequences.interrupted as ToolUpdate[];

describe("OpenCode OC1 raw-ingress allowlist", () => {
  it("fails closed if an administrative transport is asked to send", async () => {
    let leasesAcquired = 0;
    let turnsStarted = 0;
    let turnsEnded = 0;
    const supervisor = {
      acquire: async () => {
        leasesAcquired++;
        return {
          pid: process.pid,
          baseUrl: "http://127.0.0.1:1",
          authHeader: "Basic test",
          beginTurn: async () => {
            turnsStarted++;
          },
          endTurn: () => turnsEnded++,
          release: () => {},
        };
      },
    } as unknown as OpenCodeSupervisor;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: "provider/model",
      supervisor,
      sessionId: "session-1",
    });
    const events: NormalizedEvent[] = [];

    await transport.send([{ type: "text", text: "must not send" }], (event) =>
      events.push(event),
    );

    expect(events).toContainEqual({
      kind: "turn_completed",
      status: "failed",
      error: "OpenCode cannot send a turn without an Isomux system prompt.",
    });
    expect(leasesAcquired).toBe(0);
    expect(turnsStarted).toBe(0);
    expect(turnsEnded).toBe(0);
    transport.close();
  });

  it("keeps only connected provider model labels and composite ids", () => {
    const canary = "PROVIDER_OPTION_SECRET_CANARY";
    const models = allowDiscoveredModels({
      connected: ["gate", "safe"],
      all: [
        {
          id: "gate",
          name: "Gate provider",
          options: { apiKey: canary },
          models: {
            "gate-model": { name: "Gate model", cost: canary },
            "gate/gate-model": { name: "duplicate", metadata: canary },
          },
        },
        {
          id: "offline",
          name: "Offline",
          models: { hidden: { name: canary } },
        },
        {
          id: "safe",
          name: `API key ${canary}`,
          models: { model: { name: `secret ${canary}` } },
        },
        { id: 7, models: [] },
      ],
    });
    expect(models).toEqual([
      { id: "gate/gate-model", label: "Gate provider - Gate model" },
      { id: "safe/model", label: "safe - model" },
    ]);
    expect(JSON.stringify(models)).not.toContain(canary);
  });

  it("returns no models for malformed or empty connected discovery", () => {
    expect(allowDiscoveredModels(null)).toEqual([]);
    expect(
      allowDiscoveredModels({
        connected: [],
        all: [{ id: "gate", models: { model: { name: "Model" } } }],
      }),
    ).toEqual([]);
  });

  it("keeps connected models first and offers only measured provider defaults", () => {
    const models = allowDiscoveredModels({
      connected: ["z-connected"],
      default: {
        anthropic: "claude-sonnet-4-6",
        openai: "gpt-5.3-chat-latest",
        "github-copilot": "gpt-5",
      },
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
          },
        },
        {
          id: "z-connected",
          name: "Zed",
          models: { model: { name: "Model" } },
        },
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          models: { "gpt-5": { name: "GPT-5" } },
        },
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.3-chat-latest": { name: "GPT-5.3 Chat" },
          },
        },
      ],
    });

    expect(models).toEqual([
      { id: "z-connected/model", label: "Zed - Model" },
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "Anthropic",
        requiresConnection: true,
      },
      {
        id: "openai/gpt-5.3-chat-latest",
        label: "OpenAI",
        requiresConnection: true,
      },
    ]);
  });

  it("releases the discovery lease when the provider request fails", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("failed", { status: 500 }),
    });
    let releases = 0;
    const supervisor = {
      acquire: async () => ({
        baseUrl: `http://127.0.0.1:${server.port}`,
        authHeader: "Basic test",
        release: () => releases++,
      }),
    } as unknown as OpenCodeSupervisor;
    try {
      await expectRejection(
        discoverOpenCodeModels(supervisor, "/tmp"),
        /OpenCode HTTP 500/,
      );
      expect(releases).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
  it("keeps only message ids, roles, and text for edit matching", () => {
    const canary = "HISTORY_PRIVATE_CANARY";
    expect(
      allowMessages([
        {
          info: { id: "m1", role: "user", providerMetadata: canary },
          parts: [
            { type: "text", text: "safe", metadata: canary },
            { type: "tool", state: { output: canary } },
          ],
          metadata: canary,
        },
      ]),
    ).toEqual([{ uuid: "m1", role: "user", text: "safe" }]);
  });

  it("synthetically flushes a deferred call before its interrupted result", () => {
    const pending = {
      callId: "running",
      name: "bash",
      input: {},
      callEmitted: false,
      terminal: false,
    };
    expect(
      interruptedToolResults([
        pending,
        {
          callId: "done",
          name: "read",
          input: { path: "README.md" },
          callEmitted: true,
          terminal: true,
        },
      ]),
    ).toEqual([
      {
        kind: "tool_call",
        toolUseId: "running",
        name: "bash",
        input: {},
      },
      {
        kind: "tool_result",
        toolUseId: "running",
        content: "Tool interrupted.",
        isError: true,
      },
    ]);
    expect(pending.callEmitted).toBe(true);
    expect(toolUpdateEvents(pending, { status: "running", input: {} })).toEqual(
      [],
    );
  });

  it("replays captured argument input, then a synthetic completion", () => {
    const tool = {
      callId: "call",
      name: "bash",
      input: {},
      callEmitted: false,
      terminal: false,
    };
    expect(toolInputSequences.provenance).toEqual({
      server: "pinned OpenCode server",
      model: "mimo-v2.5-free",
      captured: "2026-08-29",
    });
    expect(toolUpdateEvents(tool, capturedArgument[0])).toEqual([]);
    expect(toolUpdateEvents(tool, capturedArgument[1])).toEqual([
      {
        kind: "tool_call",
        toolUseId: "call",
        name: "bash",
        input: { command: "printf opencode-capture-argument" },
      },
    ]);
    expect(
      // The live capture ended after running; completion is a synthetic step
      // that verifies the later terminal event adds only the paired result.
      toolUpdateEvents(tool, {
        status: "completed",
        input: { command: "printf opencode-capture-argument" },
        output: "captured",
      }),
    ).toEqual([
      {
        kind: "tool_result",
        toolUseId: "call",
        content: "captured",
      },
    ]);
  });

  it("replays the captured ordinary interrupt after the call emitted", () => {
    const tool = {
      callId: "interrupted",
      name: "bash",
      input: {},
      callEmitted: false,
      terminal: false,
    };
    expect(toolUpdateEvents(tool, capturedInterrupted[0])).toEqual([]);
    expect(toolUpdateEvents(tool, capturedInterrupted[1])).toEqual([
      {
        kind: "tool_call",
        toolUseId: "interrupted",
        name: "bash",
        input: { command: "sleep 30" },
      },
    ]);
    expect(interruptedToolResults([tool])).toEqual([
      {
        kind: "tool_result",
        toolUseId: "interrupted",
        content: "Tool interrupted.",
        isError: true,
      },
    ]);
  });

  it("synthetically pairs a terminal part whose input never populated", () => {
    // The pinned tool catalog has no legitimate zero-argument tool. This
    // synthetic boundary covers a terminal provider event that still has {}.
    const tool = {
      callId: "empty",
      name: "empty-tool",
      input: {},
      callEmitted: false,
      terminal: false,
    };
    expect(
      toolUpdateEvents(tool, { status: "completed", input: {}, output: "ok" }),
    ).toEqual([
      {
        kind: "tool_call",
        toolUseId: "empty",
        name: "empty-tool",
        input: {},
      },
      {
        kind: "tool_result",
        toolUseId: "empty",
        content: "ok",
      },
    ]);
  });

  it("keeps only text shape and drops provider fields before normalization", () => {
    const canary = "PROVIDER_SECRET_CANARY";
    const parsed = parseAllowedEvent(
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            type: "text",
            id: "part-1",
            messageID: "message-1",
            text: "safe",
          },
          responseHeaders: { "x-provider-secret": canary },
        },
      }),
    );
    expect(parsed).toEqual({
      kind: "text",
      sessionId: "session-1",
      messageId: "message-1",
      partId: "part-1",
      text: "safe",
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });

  it("keeps only the reviewed provider error fields", () => {
    const canary = "PROVIDER_SECRET_CANARY";
    const parsed = parseAllowedEvent(
      JSON.stringify({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: {
            name: "APIError",
            data: {
              message: "invalid credential",
              statusCode: 401,
              isRetryable: false,
              responseHeaders: { "x-provider-secret": canary },
              responseBody: canary,
              metadata: { url: canary },
              futureField: canary,
            },
          },
        },
      }),
    );
    expect(parsed).toEqual({
      kind: "error",
      sessionId: "session-1",
      error: {
        name: "APIError",
        message: "invalid credential",
        statusCode: 401,
        isRetryable: false,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });

  it("keeps only reviewed reasoning, tool, permission, and completion fields", () => {
    const canary = "CONTROL_EVENT_SECRET_CANARY";
    const events = [
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s",
          part: {
            type: "reasoning",
            id: "r",
            messageID: "m",
            text: "why",
            time: { start: 10, end: 14 },
            metadata: canary,
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s",
          part: {
            type: "tool",
            id: "p",
            messageID: "m",
            tool: "bash",
            callID: "call",
            state: {
              status: "error",
              input: { command: "false" },
              error: "exit 1",
              time: { start: 20, end: 25 },
              metadata: { exit: 1, private: canary },
            },
          },
        },
      },
      {
        type: "permission.asked",
        properties: {
          sessionID: "s",
          id: "perm",
          permission: "bash",
          patterns: ["false"],
          metadata: canary,
          always: [canary],
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s",
          part: {
            type: "step-finish",
            id: "f",
            messageID: "m",
            tokens: {
              input: 9,
              output: 4,
              cache: { read: 2, write: 1 },
              provider: canary,
            },
            cost: 0,
            snapshot: canary,
          },
        },
      },
    ].map((event) => parseAllowedEvent(JSON.stringify(event)));
    expect(events).toEqual([
      {
        kind: "reasoning",
        sessionId: "s",
        messageId: "m",
        partId: "r",
        text: "why",
        durationMs: 4,
      },
      {
        kind: "tool",
        sessionId: "s",
        partId: "p",
        callId: "call",
        name: "bash",
        status: "error",
        input: { command: "false" },
        error: "exit 1",
        exitCode: 1,
        durationMs: 5,
      },
      {
        kind: "permission",
        sessionId: "s",
        id: "perm",
        permission: "bash",
        patterns: ["false"],
      },
      {
        kind: "step_finish",
        sessionId: "s",
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
        cost: 0,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it("keeps only the question request identity", () => {
    const canary = "QUESTION_PRIVATE_CANARY";
    const parsed = parseAllowedEvent(
      JSON.stringify({
        type: "question.asked",
        properties: {
          sessionID: "session-1",
          id: "question-1",
          questions: [{ question: canary, options: [canary] }],
          tool: { messageID: canary, callID: canary },
          metadata: canary,
        },
      }),
    );
    expect(parsed).toEqual({
      kind: "question",
      sessionId: "session-1",
      id: "question-1",
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });

  it("classifies only observed structured authentication failures", () => {
    expect(
      isAuthenticationError(
        {
          name: "APIError",
          message: "invalid credential",
          statusCode: 401,
          isRetryable: false,
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message:
            "Model not found: openai/gpt-4o. Did you mean: gpt-4o, gpt-4o-mini?",
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: openai/typo. Did you mean: gpt-4o?",
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        {
          name: "APIError",
          message: "provider unavailable",
          statusCode: 500,
          isRetryable: true,
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: opencode/fake. Did you mean: fake?",
        },
        "opencode/fake",
        ["opencode"],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: openai/retired. Did you mean: current?",
        },
        "openai/retired",
        ["openai"],
      ),
    ).toBe(false);
  });

  it("refuses to record a credential-shaped fixture before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-fixture-"));
    const path = join(root, "fixture.json");
    await expectRejection(
      writeSafeContractFixture(path, ["authorization: Bearer secret-canary"]),
      /Refusing to write/,
    );
    expect(await Bun.file(path).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps committed OC1 fixtures free of credential-shaped values", async () => {
    for await (const name of new Bun.Glob("fixtures/**/*").scan(
      import.meta.dir,
    )) {
      const text = await Bun.file(join(import.meta.dir, name)).text();
      expect(text).not.toMatch(
        /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|bearer\s+[a-z0-9._~-]+)/i,
      );
    }
  });
});
