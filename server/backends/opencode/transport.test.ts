import { OPENCODE_SAFETY_TOOL } from "./safety-plugin-tool.ts";
import { describe, expect, it } from "bun:test";
import {
  interruptedToolResults,
  toolUpdateEvents,
  allowDiscoveredModels,
  discoverOpenCodeModels,
  allowMessages,
  OpenCodeTransport,
  OPENCODE_AUTH_FAILURE,
  OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
  OPENCODE_PERMISSION_ID_WARNING,
  openCodeModelGoneFailure,
  openCodeModelUnavailableFailure,
  handleOpenCodePermission,
  parseAllowedEvent,
} from "./transport.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import { join } from "node:path";
import { expectRejection } from "../../test-support/expect-rejection.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import type { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { OPENCODE_TURN_HANDLE_PLACEHOLDER } from "./office-proxy-shared.ts";
import type { NormalizedEvent } from "../types.ts";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import {
  renderLogText,
  type LogText,
} from "../../../shared/i18n/log-message.ts";

// Isomux's own lines are messages each reader words (task c37a7365); these
// checks read the English render.
const english = (text: LogText) => renderLogText(translatorFor("en"), text);
import {
  openCodeErrorMessage,
  openCodeProviderRefusal,
  openCodeRetryMessage,
} from "./errors.ts";
import { providerRefusal } from "../provider-text.ts";
import toolInputSequences from "./fixtures/tool-input-sequences.json";

type ToolUpdate = Parameters<typeof toolUpdateEvents>[1];
const capturedArgument = toolInputSequences.argument as ToolUpdate[];
const capturedInterrupted = toolInputSequences.interrupted as ToolUpdate[];

describe("OpenCode OC1 raw-ingress allowlist", () => {
  it("uses one stable per-transport authority handle and byte-identical prompt across turns", async () => {
    const systemPayloads: string[] = [];
    let eventController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/event") {
          return new Response(
            new ReadableStream({
              start(controller) {
                eventController = controller;
                controller.enqueue(new TextEncoder().encode(": connected\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/provider")
          return Response.json({ connected: [], all: [] });
        if (url.pathname === "/experimental/tool/ids")
          return Response.json([OPENCODE_SAFETY_TOOL]);
        if (url.pathname.endsWith("/prompt_async")) {
          const body = (await request.json()) as { system: string };
          systemPayloads.push(body.system);
          const controller = eventController;
          eventController = null;
          setTimeout(() => {
            controller?.enqueue(
              new TextEncoder().encode(
                'data: {"type":"session.idle","properties":{"sessionID":"session-1"}}\n\n',
              ),
            );
          }, 0);
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${server.port}`,
        authHeader: "Basic test",
        settle: () => {},
        beginTurn: async () => {},
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor;
    const sessionHandle = "session-handle";
    let activations = 0;
    const authorityBroker = {
      bind: () => ({
        handle: sessionHandle,
        activate: () => `turn-handle-${++activations}`,
        deactivate: () => {},
        unbind: () => {},
      }),
    } as unknown as OpenCodeAuthorityBroker;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: "provider/model",
      systemPrompt: `office ${OPENCODE_TURN_HANDLE_PLACEHOLDER}`,
      agentId: "agent-1",
      agentToken: "token-1",
      authorityBroker,
      supervisor,
      sessionId: "session-1",
    });
    const send = async () => {
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      await transport.send([{ type: "text", text: "go" }], (event) => {
        if (event.kind === "turn_completed") resolveCompletion();
      });
      await completion;
    };

    try {
      await send();
      await send();
      expect(systemPayloads).toEqual([
        `office ${sessionHandle}`,
        `office ${sessionHandle}`,
      ]);
      expect(Buffer.from(systemPayloads[0])).toEqual(
        Buffer.from(systemPayloads[1]),
      );
    } finally {
      transport.close();
      await server.stop(true);
    }
  });

  it("fails before prompt_async when office instructions have no binding", async () => {
    let leasesAcquired = 0;
    const supervisor = {
      acquire: async () => {
        leasesAcquired++;
        throw new Error("must not acquire");
      },
    } as unknown as OpenCodeSupervisor;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: "provider/model",
      systemPrompt: `office ${OPENCODE_TURN_HANDLE_PLACEHOLDER}`,
      supervisor,
    });
    const events: NormalizedEvent[] = [];

    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );

    expect(leasesAcquired).toBe(0);
    expect(events).toContainEqual({
      kind: "turn_completed",
      status: "failed",
      error:
        "OpenCode cannot send office instructions without an authority binding (Error; HTTP status: unavailable).",
    });
    transport.close();
  });

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
          settle: () => {},
          beginTurn: async () => {
            turnsStarted++;
          },
          endTurn: () => turnsEnded++,
          serverStopped: () => false,
          markUnresponsive: () => {},
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
      error:
        "OpenCode cannot send a turn without an Isomux system prompt (Error; HTTP status: unavailable).",
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
            "gate-model": {
              name: "Gate model",
              cost: canary,
              variants: {
                high: {},
                low: {},
                none: {},
                thinking: {},
              },
            },
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
          models: {
            model: { name: `secret ${canary}` },
            // Free only when every measured cost field is zero.
            free: {
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            },
            paid: { cost: { input: 0, output: 1 } },
          },
        },
        { id: 7, models: [] },
      ],
    });
    expect(models).toEqual([
      {
        id: "gate/gate-model",
        label: "Gate provider - Gate model",
        supportedEfforts: [{ level: "low" }, { level: "high" }],
      },
      {
        id: "safe/free",
        label: "safe - free",
        isFree: true,
        supportedEfforts: [],
      },
      { id: "safe/model", label: "safe - model", supportedEfforts: [] },
      { id: "safe/paid", label: "safe - paid", supportedEfforts: [] },
    ]);
    expect(JSON.stringify(models)).not.toContain(canary);
    expect(allowDiscoveredModels(null)).toEqual([]);
  });

  it("drops the house-provider prefix and keeps it for other providers", () => {
    const models = allowDiscoveredModels({
      connected: ["opencode", "gate"],
      all: [
        {
          id: "opencode",
          name: "OpenCode Zen",
          models: { "big-pickle": { name: "Big Pickle" } },
        },
        {
          id: "gate",
          name: "Gate provider",
          models: { "big-pickle": { name: "Big Pickle" } },
        },
      ],
    });
    expect(models).toEqual([
      {
        id: "opencode/big-pickle",
        label: "Big Pickle",
        supportedEfforts: [],
      },
      {
        id: "gate/big-pickle",
        label: "Gate provider - Big Pickle",
        supportedEfforts: [],
      },
    ]);
  });

  it("keeps only positive finite context limits from the shared provider parser", () => {
    const models = allowDiscoveredModels({
      connected: ["gate"],
      all: [
        {
          id: "gate",
          models: {
            valid: { limit: { context: 262_144 } },
            zero: { limit: { context: 0 } },
            negative: { limit: { context: -1 } },
            missing: {},
          },
        },
      ],
    });
    expect(models).toEqual([
      { id: "gate/missing", label: "gate - missing", supportedEfforts: [] },
      {
        id: "gate/negative",
        label: "gate - negative",
        supportedEfforts: [],
      },
      {
        id: "gate/valid",
        label: "gate - valid",
        contextLimit: 262_144,
        supportedEfforts: [],
      },
      { id: "gate/zero", label: "gate - zero", supportedEfforts: [] },
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

  it("retains permission metadata only on the in-process policy event", () => {
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
              total: 19,
              input: 9,
              output: 4,
              reasoning: 3,
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
        metadata: canary,
      },
      {
        kind: "step_finish",
        sessionId: "s",
        partId: "f",
        messageId: "m",
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
        contextBreakdown: {
          totalTokens: 19,
          inputTokens: 9,
          outputTokens: 4,
          reasoningTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
        cost: 0,
      },
    ]);
    expect(JSON.stringify(events)).toContain(canary);
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

  it("keeps committed OC1 fixtures free of credential-shaped values", async () => {
    let scanned = 0;
    for await (const name of new Bun.Glob("fixtures/**/*").scan(
      import.meta.dir,
    )) {
      scanned++;
      const text = await Bun.file(join(import.meta.dir, name)).text();
      expect(text).not.toMatch(
        /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|bearer\s+[a-z0-9._~-]+)/i,
      );
    }
    expect(scanned, "the scan found the committed fixtures").toBeGreaterThan(0);
  });
});

describe("OpenCode permission handling", () => {
  const envelope = {
    id: "permission-1",
    sessionId: "session-1",
    permission: "bash",
    patterns: ["printf safe"],
    metadata: { command: "printf safe" },
  };

  async function run(options: {
    autoApprove: boolean;
    event?: typeof envelope;
    evaluate?: Parameters<typeof handleOpenCodePermission>[1]["evaluate"];
    warningState?: { shown: boolean };
  }) {
    const replies: Array<{ reply: string; message?: string }> = [];
    const events: NormalizedEvent[] = [];
    const outcome = await handleOpenCodePermission(options.event ?? envelope, {
      cwd: "/tmp",
      autoApprove: options.autoApprove,
      warningState: options.warningState ?? { shown: false },
      reply: async (reply, message) => {
        replies.push({ reply, ...(message ? { message } : {}) });
      },
      sink: (event) => events.push(event),
      evaluate: options.evaluate,
    });
    return { outcome, replies, events };
  }

  it("rejects a policy denial before either mode can prompt", async () => {
    for (const autoApprove of [false, true]) {
      const result = await run({
        autoApprove,
        event: {
          ...envelope,
          metadata: { command: "git reset --hard" },
        },
      });
      expect(result.outcome).toBe("answered");
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]).toMatchObject({ reply: "reject" });
      expect(result.replies[0]?.message).toContain("git reset --hard");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ kind: "system_text" });
      expect(JSON.stringify(result.events)).toContain("git reset --hard");
    }
  });

  it("warns but keeps default-mode fail-open requests for the member", async () => {
    for (const event of [{ ...envelope, permission: undefined }, envelope]) {
      const result = await run({
        autoApprove: false,
        event: event as unknown as typeof envelope,
        ...(event === envelope
          ? {
              evaluate: () => {
                throw new Error("adapter fault");
              },
            }
          : {}),
      });
      expect(result).toEqual({
        outcome: "prompt",
        replies: [],
        events: [
          {
            kind: "system_text",
            text: SAFETY_WARNING,
          },
        ],
      });
    }
  });

  it("fails open on an unknown payload and warns once per turn", async () => {
    const warningState = { shown: false };
    const malformed = { ...envelope, permission: undefined };
    const first = await run({
      autoApprove: true,
      event: malformed as unknown as typeof envelope,
      warningState,
    });
    const second = await run({
      autoApprove: true,
      event: malformed as unknown as typeof envelope,
      warningState,
    });
    expect(first.replies).toEqual([{ reply: "once" }]);
    expect(first.events).toEqual([
      { kind: "system_text", text: SAFETY_WARNING },
    ]);
    expect(second.replies).toEqual([{ reply: "once" }]);
    expect(second.events).toEqual([]);
  });

  it("isolates a malformed event from a later valid policy denial", async () => {
    const warningState = { shown: false };
    const malformed = await run({
      autoApprove: true,
      event: {
        ...envelope,
        permission: undefined,
      } as unknown as typeof envelope,
      warningState,
    });
    const valid = await run({
      autoApprove: true,
      event: {
        ...envelope,
        metadata: { command: "git reset --hard" },
      },
      warningState,
    });
    expect(malformed.replies).toEqual([{ reply: "once" }]);
    expect(valid.replies[0]).toMatchObject({ reply: "reject" });
    expect(JSON.stringify(valid.events)).toContain("git reset --hard");
  });
});

describe("OpenCode permission event integration", () => {
  async function runFrames(
    frames: unknown[],
    agent?: string,
    connectedProviders: string[] = [],
    laterTurns: unknown[][] = [],
    stopOnText = false,
    // The agent's model, the full /provider body (null: /provider fails)
    // and the variables the lease's server was started with.
    server: {
      model?: string;
      provider?: object | null;
      launchVariables?: string[];
    } = {},
  ) {
    const replies: unknown[] = [];
    const replyIds: string[] = [];
    const contexts: number[] = [];
    const turns = [frames, ...laterTurns];
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/event") {
          return new Response(
            turns
              .shift()!
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/provider")
          return server.provider === null
            ? new Response("unavailable", { status: 500 })
            : Response.json(
                server.provider ?? { connected: connectedProviders },
              );
        if (url.pathname === "/experimental/tool/ids")
          return Response.json([OPENCODE_SAFETY_TOOL]);
        if (url.pathname.endsWith("/prompt_async")) return new Response(null);
        if (url.pathname.startsWith("/permission/") && request.body) {
          replies.push(await request.json());
          replyIds.push(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
          return new Response(null);
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${http.port}`,
        authHeader: "Basic test",
        hasLaunchVariable: (name: string) =>
          (server.launchVariables ?? []).includes(name),
        settle: () => {},
        beginTurn: async () => {},
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: server.model ?? "provider/model",
      systemPrompt: "system",
      supervisor,
      sessionId: "session-1",
      agent,
      completedStepSink: (value) => contexts.push(value.totalTokens),
    });
    const events: NormalizedEvent[] = [];
    for (let turn = 0; turn <= laterTurns.length; turn++) {
      await transport.send([{ type: "text", text: "go" }], (event) => {
        events.push(event);
        if (stopOnText && event.kind === "assistant_text")
          void transport.abort();
      });
      const deadline = Date.now() + 1_000;
      while (
        events.filter((event) => event.kind === "turn_completed").length <=
          turn &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
    }
    transport.close();
    await http.stop(true);
    return { events, replies, replyIds, contexts };
  }

  const frame = (type: string, properties: object) => ({
    type,
    properties: { sessionID: "session-1", ...properties },
  });
  const overflow = frame("session.error", {
    error: { name: "ContextOverflowError", data: { message: "too long" } },
  });
  const assistant = (id: string, summary = false) =>
    frame("message.updated", { info: { id, role: "assistant", summary } });
  const text = (id: string, value: string) =>
    frame("message.part.updated", {
      part: { id: id + "-text", messageID: id, type: "text", text: value },
    });
  const finish = (id: string) =>
    frame("message.part.updated", {
      part: { id: id + "-finish", messageID: id, type: "step-finish" },
    });
  const idle = frame("session.idle", {});
  const asked = (sessionID: string, id: string) => ({
    type: "permission.asked",
    properties: {
      sessionID,
      id,
      permission: "bash",
      patterns: [`printf ${id}`],
      metadata: { command: `printf ${id}` },
    },
  });
  // OpenCode's task tool runs a subagent in a child session.
  const created = (id: string, parentID: string) => ({
    type: "session.created",
    properties: { sessionID: id, info: { id, parentID } },
  });

  const billed = (partId: string, messageId: string, n: number) =>
    frame("message.part.updated", {
      part: {
        id: partId,
        messageID: messageId,
        type: "step-finish",
        cost: n / 8,
        tokens: {
          total: n * 10,
          input: n,
          output: n * 2,
          reasoning: 0,
          cache: { read: n * 3, write: n * 4 },
        },
      },
    });
  const totals = (n: number) => ({
    usage: {
      inputTokens: n,
      outputTokens: n * 2,
      cacheReadInputTokens: n * 3,
      cacheCreationInputTokens: n * 4,
    },
    cost: n / 8,
    costMode: "turn" as const,
    usageId: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  it("sums billed tool and compaction steps once per part and keeps context separate", async () => {
    const result = await runFrames(
      [
        assistant("tool"),
        billed("tool-a", "tool", 1),
        billed("tool-b", "tool", 2),
        billed("tool-a", "tool", 1),
        overflow,
        assistant("summary", true),
        billed("summary-step", "summary", 4),
        billed("summary-step", "summary", 4),
        assistant("answer"),
        billed("answer-step", "answer", 8),
        billed("answer-step", "answer", 16),
        idle,
      ],
      undefined,
      [],
      [[assistant("next"), billed("next-step", "next", 32), idle]],
    );
    expect(result.events.filter((e) => e.kind === "turn_completed")).toEqual([
      { kind: "turn_completed", status: "completed", ...totals(23) },
      { kind: "turn_completed", status: "completed", ...totals(32) },
    ]);
    expect(result.contexts).not.toContain(40);
    expect(result.contexts.at(-2)).toBe(160);
    expect(result.contexts.at(-1)).toBe(320);
    const replay = await runFrames([
      assistant("summary", true),
      billed("summary-step", "summary", 4),
      billed("tool-b", "tool", 2),
      billed("answer-step", "answer", 16),
      billed("tool-a", "tool", 1),
      idle,
    ]);
    const first = result.events.find((e) => e.kind === "turn_completed");
    const repeated = replay.events.find((e) => e.kind === "turn_completed");
    expect(repeated?.usageId).toBe(first?.usageId);
    expect(
      result.events.filter((e) => e.kind === "turn_completed")[1]?.usageId,
    ).not.toBe(first?.usageId);
  });

  it("keeps billed steps when overflow or a provider error ends the turn", async () => {
    for (const ending of [
      [overflow, idle],
      [
        frame("session.error", {
          error: { name: "APIError", data: { statusCode: 503 } },
        }),
      ],
      [], // A dropped event stream uses send()'s failure path.
    ]) {
      const result = await runFrames([
        assistant("tool"),
        billed("tool-a", "tool", 2),
        ...ending,
      ]);
      expect(result.events.filter((e) => e.kind === "turn_completed")).toEqual([
        {
          kind: "turn_completed",
          status: "failed",
          error: expect.any(String),
          ...totals(2),
        },
      ]);
    }
  });

  it("keeps billed steps when a member stops the turn", async () => {
    const result = await runFrames(
      [
        assistant("tool"),
        billed("tool-step", "tool", 4),
        text("tool", "partial"),
        idle,
      ],
      undefined,
      [],
      [],
      true,
    );
    expect(result.events.filter((e) => e.kind === "turn_completed")).toEqual([
      { kind: "turn_completed", status: "interrupted", ...totals(4) },
    ]);
  });

  it("keeps overflow open through compaction and delivers only the replay answer", async () => {
    const result = await runFrames([
      overflow,
      assistant("summary", true),
      text("summary", "private summary"),
      finish("summary"),
      assistant("answer"),
      text("answer", "original answer"),
      finish("answer"),
      idle,
    ]);
    expect(result.events.filter((e) => e.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", text: "original answer" },
    ]);
    expect(result.events.filter((e) => e.kind === "turn_completed")).toEqual([
      { kind: "turn_completed", status: "completed" },
    ]);
  });

  it("fails terminal overflow even after an earlier tool step or a summary", async () => {
    for (const frames of [
      [finish("tool"), overflow, idle],
      [overflow, assistant("summary", true), finish("summary"), idle],
    ]) {
      const result = await runFrames(frames);
      expect(result.events.at(-1)).toMatchObject({
        kind: "turn_completed",
        status: "failed",
        error: expect.stringMatching(/conversation.*long/i),
      });
    }
  });

  it("shows native retry attempts with the provider's message without settling the turn", async () => {
    const messages = [
      "SSE read timed out",
      "Free usage exceeded, subscribe to Go",
      "HTTP 503",
      "",
      "rate limit sk-abcdefghijklmnopqrstuvwxyz123456",
    ];
    for (const terminal of [false, true]) {
      const result = await runFrames([
        ...messages.map((message, i) =>
          frame("session.status", {
            status: { type: "retry", attempt: i + 1, message },
          }),
        ),
        ...(terminal
          ? [
              frame("session.error", {
                error: { name: "APIError", data: { statusCode: 503 } },
              }),
            ]
          : [
              assistant("answer"),
              text("answer", "answer"),
              finish("answer"),
              idle,
            ]),
      ]);
      const retries = result.events.flatMap((e) =>
        e.kind === "system_text" ? [{ text: english(e.text) }] : [],
      );
      expect(retries).toHaveLength(5);
      for (const [i, entry] of retries.entries()) {
        expect(entry.text).toMatch(new RegExp(`\\b${i + 1}\\b.*\\b5\\b`));
      }
      for (const i of [0, 1, 2]) {
        expect(retries[i].text).toContain("`provider`");
        expect(retries[i].text).toContain(`"${messages[i]}"`);
      }
      expect(retries[3].text).not.toContain("`provider`");
      expect(retries[4].text).toContain("rate limit");
      expect(JSON.stringify(result.events)).not.toContain(
        "abcdefghijklmnopqrstuvwxyz123456",
      );
      expect(
        result.events.filter((e) => e.kind === "turn_completed"),
      ).toHaveLength(1);
      expect(result.events.at(-1)).toMatchObject({
        kind: "turn_completed",
        status: terminal ? "failed" : "completed",
      });
    }
  });

  it("replaces pending overflow with a later compaction timeout", async () => {
    const result = await runFrames([
      overflow,
      frame("session.error", {
        error: {
          name: "APIError",
          data: { message: "SSE read timed out", isRetryable: true },
        },
      }),
      idle,
    ]);
    expect(result.events.at(-1)).toMatchObject({
      kind: "turn_completed",
      status: "failed",
      error: expect.stringMatching(/time/i),
    });
    expect(
      result.events.filter((e) => e.kind === "turn_completed"),
    ).toHaveLength(1);
  });

  // Task 1a963907: the provider's own words, so members see the refusal is
  // the provider's.
  it("quotes the provider's refusal instead of blaming the model", async () => {
    const message =
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";
    const result = await runFrames([
      frame("session.error", {
        error: {
          name: "APIError",
          data: { message, statusCode: 403, isRetryable: false },
        },
      }),
    ]);
    const last = result.events.at(-1);
    expect(last).toMatchObject({ kind: "turn_completed", status: "failed" });
    const error = english((last as { error: LogText }).error);
    expect(error).toContain("`provider`");
    expect(error).toContain(`"${message}"`);
    expect(error).not.toBe(openCodeModelUnavailableFailure("provider/model"));
  });

  it("writes the provider's refusal and retry as messages each reader words", async () => {
    const message = "Free usage exceeded, subscribe to Go";
    const error = { name: "APIError", statusCode: 403, message };
    const frames = [
      frame("session.status", {
        status: { type: "retry", attempt: 1, message },
      }),
      frame("session.error", {
        error: { name: "APIError", data: { message, statusCode: 403 } },
      }),
    ];
    const result = await runFrames(frames);
    const retry = result.events.find((e) => e.kind === "system_text");
    expect(retry).toMatchObject({
      text: openCodeRetryMessage(message, 1, "provider"),
    });
    expect(result.events.at(-1)).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: openCodeProviderRefusal(error, "provider")!,
    });
    // Both carry a message, not finished text.
    expect(typeof openCodeRetryMessage(message, 1, "provider")).toBe("object");
  });

  // Task 73951c9f: a model the provider refuses is no gone model, and the
  // member can still fix the turn by picking another one.
  it("keeps the model line for a 403 with no provider message, and offers the picker", async () => {
    const result = await runFrames([
      frame("session.error", {
        error: {
          name: "APIError",
          data: { statusCode: 403, isRetryable: false },
        },
      }),
    ]);
    expect(result.events.at(-1)).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: openCodeModelUnavailableFailure("provider/model"),
      pickModel: true,
    });
    // No words follow, so the line keeps its cause (task 81b290d6).
    expect(openCodeModelUnavailableFailure("provider/model")).not.toBe(
      openCodeModelUnavailableFailure("provider/model", true),
    );
  });

  // Task 10a09ec8: the sign-in line and its OPENCODE_API_KEY guidance only
  // when that key would fix the failure: a model of OpenCode's own providers
  // that is not free, on a server started without the key. Every other
  // classified auth failure shows OpenCode's words, with no sign-in signal.
  describe("sign-in failures", () => {
    const catalog = (connected: string[]) => ({
      connected,
      all: [
        {
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            "free-model": { name: "Free", cost: { input: 0, output: 0 } },
            "paid-model": { name: "Paid", cost: { input: 1, output: 5 } },
          },
        },
        {
          id: "opencode-go",
          name: "OpenCode Go",
          models: {
            "go-model": { name: "Go", cost: { input: 1, output: 2 } },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            claude: { name: "Claude", cost: { input: 3, output: 15 } },
          },
        },
      ],
    });
    const allConnected = catalog(["opencode", "opencode-go", "anthropic"]);
    const key = ["OPENCODE_API_KEY"];
    const keyMissing =
      "OpenCode API key is missing. Pass it using the 'apiKey' parameter.";
    const invalidKey = "Invalid API key for this request.";
    // OpenCode 1.18.35 sends the AI SDK's LoadAPIKeyError as
    // ProviderAuthError, and a provider's 401 as APIError.
    const providerAuth = (message?: string) =>
      frame("session.error", {
        error: {
          name: "ProviderAuthError",
          data: { providerID: "opencode", ...(message ? { message } : {}) },
        },
      });
    const unauthorized = (message?: string) =>
      frame("session.error", {
        error: {
          name: "APIError",
          data: {
            statusCode: 401,
            isRetryable: false,
            ...(message ? { message } : {}),
          },
        },
      });
    const modelNotFound = (model: string) =>
      `Model not found: ${model}. Did you mean: other`;
    const notFound = (model: string) =>
      frame("session.error", {
        error: {
          name: "UnknownError",
          data: { message: modelNotFound(model) },
        },
      });

    async function fail(
      errorFrame: object,
      server: {
        model: string;
        provider?: object | null;
        launchVariables?: string[];
      },
    ) {
      const { events } = await runFrames(
        [errorFrame],
        undefined,
        [],
        [],
        false,
        { provider: allConnected, ...server },
      );
      const ends = events.filter((event) => event.kind === "turn_completed");
      expect(ends, "one failed turn ends the run").toHaveLength(1);
      const end = events.at(-1) as Extract<
        NormalizedEvent,
        { kind: "turn_completed" }
      >;
      expect(end.kind).toBe("turn_completed");
      expect(end.status).toBe("failed");
      return {
        events,
        error: english(end.error!),
        signIns: events.filter((event) => event.kind === "auth_needed").length,
        signalFirst: events.at(-2)?.kind === "auth_needed",
      };
    }

    const signIn = async (
      errorFrame: object,
      server: Parameters<typeof fail>[1],
      message?: string,
    ) => {
      const result = await fail(errorFrame, server);
      const end = result.events.at(-1) as Extract<
        NormalizedEvent,
        { kind: "turn_completed" }
      >;
      // The key fixes this turn, not another model (task 73951c9f).
      expect(end.pickModel, "no model picker").toBeUndefined();
      expect(end.goneModel, "no gone model").toBeUndefined();
      expect(result.signIns, "one sign-in signal").toBe(1);
      expect(result.signalFirst, "the signal comes before the end").toBe(true);
      expect(result.error).toContain(OPENCODE_AUTH_FAILURE);
      if (message !== undefined) expect(result.error).toContain(message);
      return result;
    };

    const noSignIn = async (
      errorFrame: object,
      server: Parameters<typeof fail>[1],
      message?: string,
    ) => {
      const result = await fail(errorFrame, server);
      expect(result.signIns, "no sign-in signal").toBe(0);
      expect(result.error).not.toContain(OPENCODE_AUTH_FAILURE);
      if (message !== undefined) expect(result.error).toContain(message);
      return result;
    };

    it("asks for the key for a paid or unlisted model of OpenCode's providers on a server without it, with OpenCode's words", async () => {
      for (const model of [
        "opencode/paid-model",
        // With no key, OpenCode lists only the free Zen models.
        "opencode/unlisted-model",
        "opencode-go/go-model",
      ]) {
        const auth = await signIn(
          providerAuth(keyMissing),
          { model },
          keyMissing,
        );
        expect(auth.error).toContain(
          english(providerRefusal(model.split("/")[0], keyMissing)),
        );
        await signIn(unauthorized(invalidKey), { model }, invalidKey);
      }
    });

    it("treats a model as not free when the catalog does not load", async () => {
      await signIn(
        unauthorized(invalidKey),
        { model: "opencode/free-model", provider: null },
        invalidKey,
      );
    });

    it("shows the sign-in line alone when OpenCode sends no words", async () => {
      const result = await signIn(providerAuth(), {
        model: "opencode/paid-model",
      });
      expect(result.error).toBe(OPENCODE_AUTH_FAILURE);
    });

    it("shows a free model's refusal as the provider's, not as missing sign-in", async () => {
      const model = "opencode/free-model";
      const auth = await noSignIn(
        providerAuth(keyMissing),
        { model },
        keyMissing,
      );
      expect(auth.error).toContain(
        english(providerRefusal("opencode", keyMissing)),
      );
      const http = await noSignIn(
        unauthorized(invalidKey),
        { model },
        invalidKey,
      );
      expect(http.error).toContain(
        english(providerRefusal("opencode", invalidKey)),
      );
    });

    it("shows the provider's words when the server has the key", async () => {
      for (const model of ["opencode/paid-model", "opencode-go/go-model"]) {
        const provider = model.split("/")[0];
        const auth = await noSignIn(
          providerAuth(keyMissing),
          { model, launchVariables: key },
          keyMissing,
        );
        expect(auth.error).toContain(
          english(providerRefusal(provider, keyMissing)),
        );
        const http = await noSignIn(
          unauthorized(invalidKey),
          { model, launchVariables: key },
          invalidKey,
        );
        expect(http.error).toContain(
          english(providerRefusal(provider, invalidKey)),
        );
      }
    });

    it("never names OPENCODE_API_KEY for another provider's auth failure", async () => {
      const model = "anthropic/claude";
      const auth = await noSignIn(
        providerAuth(keyMissing),
        { model },
        keyMissing,
      );
      expect(auth.error).toContain(
        english(providerRefusal("anthropic", keyMissing)),
      );
      const http = await noSignIn(
        unauthorized(invalidKey),
        { model },
        invalidKey,
      );
      expect(http.error).toContain(
        english(providerRefusal("anthropic", invalidKey)),
      );
    });

    // Task 81b290d6: with no words from OpenCode, the line gives the next
    // step. A retry fails again; another model fixes the turn.
    it("offers the picker for a refusal that needs no key and has no words", async () => {
      for (const server of [
        { model: "opencode/free-model" },
        { model: "anthropic/claude" },
        // A key the provider rejects.
        { model: "opencode/paid-model", launchVariables: key },
      ]) {
        const lines = new Set<string>();
        for (const errorFrame of [providerAuth(), unauthorized()]) {
          const result = await noSignIn(errorFrame, server);
          const end = result.events.at(-1) as Extract<
            NormalizedEvent,
            { kind: "turn_completed" }
          >;
          expect(end.pickModel, `picker for ${server.model}`).toBe(true);
          expect(end.goneModel).toBeUndefined();
          expect(result.error).toContain(`\`${server.model}\``);
          lines.add(result.error);
        }
        expect(lines.size, "one line for both error shapes").toBe(1);
      }
      // OpenCode's words say why: no picker.
      const words = await noSignIn(
        providerAuth(keyMissing),
        { model: "opencode/free-model" },
        keyMissing,
      );
      expect(
        (words.events.at(-1) as { pickModel?: true }).pickModel,
      ).toBeUndefined();
    });

    it("classifies model-not-found by the model's provider and the server's key", async () => {
      // OpenCode's provider is not connected, the server has no key.
      const zen = "opencode/paid-model";
      await signIn(
        notFound(zen),
        { model: zen, provider: catalog(["anthropic"]) },
        modelNotFound(zen),
      );
      // With the key, a missing OpenCode provider is no sign-in failure.
      await noSignIn(
        notFound(zen),
        { model: zen, provider: catalog(["anthropic"]), launchVariables: key },
        modelNotFound(zen),
      );
      // Another provider that is not connected: pick another model.
      const other = "anthropic/claude";
      const result = await noSignIn(
        notFound(other),
        { model: other, provider: catalog(["opencode"]) },
        modelNotFound(other),
      );
      // OpenCode's words follow, so the first line does not state the cause
      // again (task 81b290d6).
      const [first, ...rest] = result.error.split("\n");
      expect(first).toBe(openCodeModelUnavailableFailure(other, true));
      expect(first).not.toBe(openCodeModelUnavailableFailure(other));
      expect(first).toContain(`\`${other}\``);
      expect(rest.join("\n")).toBe(
        english(providerRefusal("anthropic", modelNotFound(other))),
      );
      // A provider that is not connected is no proof the model is gone, but
      // a connected provider's model fixes the turn (task 73951c9f).
      const end = result.events.at(-1) as Extract<
        NormalizedEvent,
        { kind: "turn_completed" }
      >;
      expect(end.pickModel).toBe(true);
      expect(end.goneModel).toBeUndefined();
    });
  });

  // Task 73951c9f: OpenCode's "Model not found" for a model of a connected
  // provider means OpenCode no longer has the model: the line says so, names
  // it, offers the picker, and the event names the gone model for the flag.
  it("classifies model-not-found through connected-provider discovery", async () => {
    const frame = {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: {
          name: "UnknownError",
          data: {
            message: "Model not found: provider/model. Did you mean: other",
          },
        },
      },
    };
    const connected = await runFrames([frame], undefined, ["provider"]);
    const end = connected.events.at(-1) as Extract<
      NormalizedEvent,
      { kind: "turn_completed" }
    >;
    expect(end).toMatchObject({
      kind: "turn_completed",
      status: "failed",
      pickModel: true,
      goneModel: "provider/model",
    });
    const gone = english(openCodeModelGoneFailure("provider/model"));
    expect(gone).toContain("`provider/model`");
    // A gone model, not a refusal: another line than the 403's.
    expect(gone).not.toBe(
      english(openCodeModelUnavailableFailure("provider/model")),
    );
    expect(english(end.error!)).toContain(gone);
    // A model-not-found for another model is no verdict on this one.
    const otherError = {
      name: "UnknownError",
      message: "Model not found: provider/typo. Did you mean: model",
    };
    const other = await runFrames(
      [
        {
          ...frame,
          properties: {
            ...frame.properties,
            error: {
              name: otherError.name,
              data: { message: otherError.message },
            },
          },
        },
      ],
      undefined,
      ["provider"],
    );
    expect(other.events.at(-1)).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: openCodeErrorMessage(otherError),
    });
  });

  it("fails a no-id request visibly without claiming an allow", async () => {
    const result = await runFrames([
      {
        type: "permission.asked",
        properties: {
          sessionID: "session-1",
          permission: "bash",
          metadata: { command: "printf must-not-run" },
        },
      },
    ]);
    expect(result.replies).toEqual([]);
    expect(result.events).toContainEqual({
      kind: "system_text",
      text: OPENCODE_PERMISSION_ID_WARNING,
    });
    expect(result.events).toContainEqual({
      kind: "turn_completed",
      status: "failed",
      error: OPENCODE_PERMISSION_ID_WARNING,
    });
    expect(JSON.stringify(result.events)).not.toContain(SAFETY_WARNING);
  });

  it("answers a malformed owned request once and shows the warning", async () => {
    const result = await runFrames(
      [
        {
          type: "permission.asked",
          properties: {
            sessionID: "session-1",
            id: "permission-1",
            metadata: {},
          },
        },
      ],
      "isomux-interactive-bypass",
    );
    expect(result.replies).toEqual([{ reply: "once" }]);
    expect(result.events).toContainEqual({
      kind: "system_text",
      text: SAFETY_WARNING,
    });
  });

  // OpenCode runs the tool calls of one step in parallel, and each call can
  // ask for permission before any answer (probe of the pinned 1.18.23 server,
  // 2026-09-26, task 7a185be0). The event stream stays open here, as in a
  // live turn, so both requests are open when the answers arrive.
  async function withTwoOpenRequests(
    answer: (
      transport: OpenCodeTransport,
      events: NormalizedEvent[],
    ) => Promise<void>,
    options: { refuseRejects?: boolean; frames?: unknown[] } = {},
  ): Promise<{
    replies: { id: string; reply: unknown }[];
    events: NormalizedEvent[];
  }> {
    const replies: { id: string; reply: unknown }[] = [];
    const frames = options.frames ?? [
      asked("session-1", "permission-1"),
      asked("session-1", "permission-2"),
    ];
    const askedIds = frames.flatMap((frame) => {
      const { type, properties } = frame as {
        type: string;
        properties: { id?: string };
      };
      return type === "permission.asked" && properties.id
        ? [properties.id]
        : [];
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/event") {
          const body = frames
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join("");
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/provider")
          return Response.json({ connected: [] });
        if (url.pathname === "/experimental/tool/ids")
          return Response.json([OPENCODE_SAFETY_TOOL]);
        if (url.pathname.endsWith("/prompt_async")) return new Response(null);
        if (url.pathname.startsWith("/permission/") && request.body) {
          const reply = ((await request.json()) as { reply: unknown }).reply;
          replies.push({
            id: decodeURIComponent(url.pathname.split("/")[2] ?? ""),
            reply,
          });
          // The server did not apply this reject: every request stays open.
          if (options.refuseRejects && reply === "reject")
            return new Response("unavailable", { status: 503 });
          return new Response(null);
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${server.port}`,
        authHeader: "Basic test",
        settle: () => {},
        beginTurn: async () => {},
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: "provider/model",
      systemPrompt: "system",
      supervisor,
      sessionId: "session-1",
    });
    const events: NormalizedEvent[] = [];
    try {
      await transport.send([{ type: "text", text: "go" }], (event) =>
        events.push(event),
      );
      const deadline = Date.now() + 1_000;
      while (
        events.filter((event) => event.kind === "approval_request").length <
          askedIds.length &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(
        events.flatMap((event) =>
          event.kind === "approval_request" ? [event.approvalId] : [],
        ),
      ).toEqual(askedIds);
      await answer(transport, events);
    } finally {
      transport.close();
      await server.stop(true);
    }
    return { replies, events };
  }

  it("answers each of two open requests, not only the newest", async () => {
    const { replies } = await withTwoOpenRequests(async (transport) => {
      await transport.approve("permission-1", { kind: "allow_once" });
      await transport.approve("permission-2", { kind: "deny" });
    });
    // MUTANT: one pending slot, so the second request overwrites the first
    // and the answer to permission-1 is dropped.
    expect(replies).toEqual([
      { id: "permission-1", reply: "once" },
      { id: "permission-2", reply: "reject" },
    ]);
  });

  it("sends no reply for a request that a reject already closed", async () => {
    const { replies, events } = await withTwoOpenRequests(async (transport) => {
      await transport.approve("permission-1", { kind: "deny" });
      await transport.approve("permission-2", { kind: "allow_once" });
    });
    // OpenCode rejects every open request of the session with the first
    // reject, so an allow for the second has nothing left to answer.
    expect(replies).toEqual([{ id: "permission-1", reply: "reject" }]);
    // MUTANT: the transport forgets permission-2 silently, and the
    // orchestrator later shows a card for it.
    expect(
      events.filter((event) => event.kind === "approval_withdrawn"),
    ).toEqual([{ kind: "approval_withdrawn", approvalId: "permission-2" }]);
  });

  it("keeps every request open when OpenCode refuses a reject", async () => {
    let withdrawnBeforeClose: NormalizedEvent[] = [];
    const { replies } = await withTwoOpenRequests(
      async (transport, events) => {
        await expectRejection(
          transport.approve("permission-1", { kind: "deny" }),
          /503/,
        );
        await transport.approve("permission-2", { kind: "allow_once" });
        // The refused request itself also stays answerable.
        await transport.approve("permission-1", { kind: "allow_once" });
        // Closing the transport ends the turn, which withdraws whatever is
        // still open; only the answers are under test here.
        withdrawnBeforeClose = events.filter(
          (event) => event.kind === "approval_withdrawn",
        );
      },
      { refuseRejects: true },
    );
    // MUTANT: forgetting the session's requests before the reply succeeds
    // withdraws permission-2 while OpenCode still waits on it.
    expect(replies).toEqual([
      { id: "permission-1", reply: "reject" },
      { id: "permission-2", reply: "once" },
      { id: "permission-1", reply: "once" },
    ]);
    expect(withdrawnBeforeClose).toEqual([]);
  });

  it("withdraws the requests still open when the turn ends", async () => {
    const asked = (id: string) => ({
      type: "permission.asked",
      properties: {
        sessionID: "session-1",
        id,
        permission: "bash",
        patterns: [`printf ${id}`],
        metadata: { command: `printf ${id}` },
      },
    });
    const result = await runFrames([
      asked("permission-1"),
      asked("permission-2"),
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);
    const kinds = result.events.map((event) =>
      event.kind === "approval_withdrawn"
        ? `withdrawn:${event.approvalId}`
        : event.kind,
    );
    // MUTANT: the turn ends with both requests still open in the
    // orchestrator, which leaves a parked card behind.
    expect(kinds.slice(-3)).toEqual([
      "withdrawn:permission-1",
      "withdrawn:permission-2",
      "turn_completed",
    ]);
  });
  // Task 42500a30: a subagent's request was dropped as a foreign session's,
  // so the subagent and the agent's turn waited on it until the stream
  // deadline.
  describe("subagent requests", () => {
    it("answers a subagent's and a nested subagent's request under bypass", async () => {
      const result = await runFrames(
        [
          created("child-1", "session-1"),
          asked("child-1", "permission-child"),
          created("grandchild-1", "child-1"),
          asked("grandchild-1", "permission-grandchild"),
          assistant("answer"),
          finish("answer"),
          idle,
        ],
        "isomux-interactive-bypass",
      );
      // MUTANT: the own-session-only filter answers neither request.
      // MUTANT: no recursion answers only the child's request.
      expect(result.replyIds).toEqual([
        "permission-child",
        "permission-grandchild",
      ]);
      expect(result.replies).toEqual([{ reply: "once" }, { reply: "once" }]);
      expect(result.events.at(-1)).toMatchObject({
        kind: "turn_completed",
        status: "completed",
      });
    });

    it("runs the safety checks on a subagent's request under bypass", async () => {
      const result = await runFrames(
        [
          created("child-1", "session-1"),
          {
            type: "permission.asked",
            properties: {
              sessionID: "child-1",
              id: "permission-child",
              permission: "bash",
              patterns: ["git reset --hard"],
              metadata: { command: "git reset --hard" },
            },
          },
        ],
        "isomux-interactive-bypass",
      );
      expect(result.replyIds).toEqual(["permission-child"]);
      expect(result.replies[0]).toMatchObject({ reply: "reject" });
    });

    it("leaves the request of another session and of its subagent alone", async () => {
      const result = await runFrames(
        [
          asked("session-foreign", "permission-foreign"),
          created("child-foreign", "session-foreign"),
          asked("child-foreign", "permission-foreign-child"),
          assistant("answer"),
          finish("answer"),
          idle,
        ],
        "isomux-interactive-bypass",
      );
      expect(result.replyIds).toEqual([]);
      expect(
        result.events.some((event) => event.kind === "approval_request"),
      ).toBe(false);
      expect(
        result.events.at(-1),
        "the frames after them were read",
      ).toMatchObject({
        kind: "turn_completed",
        status: "completed",
      });
    });

    it("does not end the turn on a subagent's idle", async () => {
      const result = await runFrames([
        created("child-1", "session-1"),
        { type: "session.idle", properties: { sessionID: "child-1" } },
        assistant("answer"),
        finish("answer"),
        idle,
      ]);
      // MUTANT: routing every subagent event fails the turn at the child's
      // idle, before the agent's step completes.
      expect(
        result.events.filter((event) => event.kind === "turn_completed"),
      ).toMatchObject([{ status: "completed" }]);
    });

    it("asks the member and replies on the subagent's request", async () => {
      const { replies } = await withTwoOpenRequests(
        async (transport) => {
          await transport.approve("permission-child", { kind: "allow_once" });
        },
        {
          frames: [
            created("child-1", "session-1"),
            asked("child-1", "permission-child"),
          ],
        },
      );
      // MUTANT: approve() keeps only the agent's own session.
      expect(replies).toEqual([{ id: "permission-child", reply: "once" }]);
    });

    it("closes only the subagent's requests when the member denies one", async () => {
      let withdrawnBeforeClose: NormalizedEvent[] = [];
      const { replies } = await withTwoOpenRequests(
        async (transport, events) => {
          await transport.approve("permission-child-a", { kind: "deny" });
          await transport.approve("permission-1", { kind: "allow_once" });
          withdrawnBeforeClose = events.filter(
            (event) => event.kind === "approval_withdrawn",
          );
        },
        {
          frames: [
            asked("session-1", "permission-1"),
            created("child-1", "session-1"),
            asked("child-1", "permission-child-a"),
            asked("child-1", "permission-child-b"),
          ],
        },
      );
      // MUTANT: a deny that forgets the agent's session withdraws
      // permission-1 while OpenCode still waits on it, so its allow is
      // never sent.
      expect(replies).toEqual([
        { id: "permission-child-a", reply: "reject" },
        { id: "permission-1", reply: "once" },
      ]);
      expect(withdrawnBeforeClose).toEqual([
        { kind: "approval_withdrawn", approvalId: "permission-child-b" },
      ]);
    });

    it("rejects the open requests of each session when the turn stops", async () => {
      const { replies, events } = await withTwoOpenRequests(
        async (transport) => {
          await transport.abort();
        },
        {
          frames: [
            asked("session-1", "permission-1"),
            created("child-1", "session-1"),
            asked("child-1", "permission-child"),
            created("child-2", "session-1"),
            asked("child-2", "permission-child-2"),
          ],
        },
      );
      // MUTANT: a stop that rejects only the agent's session leaves the
      // subagents waiting. The rejects go out together.
      expect(replies.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "permission-1", reply: "reject" },
        { id: "permission-child", reply: "reject" },
        { id: "permission-child-2", reply: "reject" },
      ]);
      expect(
        events.filter((event) => event.kind === "approval_withdrawn"),
      ).toEqual([
        { kind: "approval_withdrawn", approvalId: "permission-1" },
        { kind: "approval_withdrawn", approvalId: "permission-child" },
        { kind: "approval_withdrawn", approvalId: "permission-child-2" },
      ]);
    });

    it("reports a subagent's question", async () => {
      const result = await runFrames([
        created("child-1", "session-1"),
        {
          type: "question.asked",
          properties: { sessionID: "child-1", id: "question-child" },
        },
      ]);
      expect(result.events).toContainEqual({
        kind: "input_request",
        inputType: "question",
        requestId: "question-child",
      });
    });

    // Task 386f6ad1: a subagent reopened with task_id sends no
    // session.created, so its request in a later turn hung the turn.
    describe("subagents named by a task part", () => {
      const taskPart = (sessionID: string, child: string) => ({
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: `${child}-task`,
            messageID: `${sessionID}-message`,
            sessionID,
            type: "tool",
            tool: "task",
            callID: `call-${child}`,
            state: {
              status: "running",
              input: { prompt: "go on", task_id: child },
              metadata: { parentSessionId: sessionID, sessionId: child },
            },
          },
        },
      });

      it("answers a reopened subagent's request under bypass", async () => {
        const result = await runFrames(
          [
            taskPart("session-1", "child-1"),
            asked("child-1", "permission-child"),
            assistant("answer"),
            finish("answer"),
            idle,
          ],
          "isomux-interactive-bypass",
        );
        // MUTANT: parseAllowedEvent does not read metadata.sessionId, so
        // the request is dropped as another session's.
        expect(result.replyIds).toEqual(["permission-child"]);
        expect(result.replies).toEqual([{ reply: "once" }]);
        expect(result.events.at(-1)).toMatchObject({
          kind: "turn_completed",
          status: "completed",
        });
      });

      it("answers a subagent whose parent is the session before an edit fork", async () => {
        const result = await runFrames(
          [
            created("child-1", "session-before-fork"),
            taskPart("session-1", "child-1"),
            asked("child-1", "permission-child"),
            assistant("answer"),
            finish("answer"),
            idle,
          ],
          "isomux-interactive-bypass",
        );
        // MUTANT: adopting only a session.created whose parent the turn
        // owns drops this request.
        expect(result.replyIds).toEqual(["permission-child"]);
      });

      it("leaves a session alone that only another session's task part names", async () => {
        const result = await runFrames(
          [
            taskPart("session-foreign", "child-foreign"),
            asked("child-foreign", "permission-foreign"),
            assistant("answer"),
            finish("answer"),
            idle,
          ],
          "isomux-interactive-bypass",
        );
        // MUTANT: adopting from the task part of any session answers it.
        expect(result.replyIds).toEqual([]);
        expect(
          result.events.some((event) => event.kind === "approval_request"),
        ).toBe(false);
        expect(result.events.at(-1)).toMatchObject({
          kind: "turn_completed",
          status: "completed",
        });
      });

      it("answers a nested subagent that a subagent's task part names", async () => {
        const result = await runFrames(
          [
            created("child-1", "session-1"),
            taskPart("child-1", "grandchild-1"),
            asked("grandchild-1", "permission-grandchild"),
            assistant("answer"),
            finish("answer"),
            idle,
          ],
          "isomux-interactive-bypass",
        );
        // MUTANT: adopting only from the agent's own task parts, or after
        // the filter that drops a subagent's tool events, drops it.
        expect(result.replyIds).toEqual(["permission-grandchild"]);
      });

      it("keeps a subagent for its turn only", async () => {
        const result = await runFrames(
          [
            taskPart("session-1", "child-1"),
            assistant("answer-1"),
            finish("answer-1"),
            idle,
          ],
          "isomux-interactive-bypass",
          [],
          [
            [
              asked("child-1", "permission-later"),
              assistant("answer-2"),
              finish("answer-2"),
              idle,
            ],
          ],
        );
        expect(
          result.events.filter((event) => event.kind === "turn_completed"),
        ).toHaveLength(2);
        // MUTANT: no per-turn reset of the subagent sessions answers it.
        expect(result.replyIds).toEqual([]);
      });
    });
  });
});

describe("OpenCode edit fork", () => {
  it("sends messageID only when there is a message to fork before", async () => {
    const bodies: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/session/session-1/fork") {
          bodies.push(await request.json());
          return Response.json({ id: `child-${bodies.length}` });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${server.port}`,
        authHeader: "Basic test",
        settle: () => {},
        beginTurn: async () => {},
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor;
    const transport = new OpenCodeTransport({
      cwd: "/tmp",
      model: "provider/model",
      systemPrompt: "office",
      agentId: "agent-1",
      supervisor,
      sessionId: "session-1",
    });
    try {
      expect(await transport.forkAtMessage("msg-2")).toBe("child-1");
      // null: the edited message never reached the session, keep it all.
      expect(await transport.forkAtMessage(null)).toBe("child-2");
      expect(bodies).toEqual([{ messageID: "msg-2" }, {}]);
    } finally {
      transport.close();
      await server.stop(true);
    }
  });
});

describe("OpenCode kept model catalog", () => {
  const catalog = {
    connected: ["provider"],
    all: [
      {
        id: "provider",
        models: {
          model: { variants: { low: {}, high: {} }, limit: { context: 1000 } },
          plain: {},
        },
      },
    ],
  };

  function catalogHarness(
    options: { failProvider?: () => boolean; holdProvider?: boolean } = {},
  ) {
    const providerDirectories: string[] = [];
    const promptBodies: Record<string, unknown>[] = [];
    const heldProviders: (() => void)[] = [];
    let eventController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/provider") {
          providerDirectories.push(url.searchParams.get("directory") ?? "");
          if (options.failProvider?.())
            return new Response("failed", { status: 500 });
          if (options.holdProvider)
            await new Promise<void>((resolve) => heldProviders.push(resolve));
          return Response.json(catalog);
        }
        if (url.pathname === "/event") {
          return new Response(
            new ReadableStream({
              start(controller) {
                eventController = controller;
                controller.enqueue(new TextEncoder().encode(": connected\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/experimental/tool/ids")
          return Response.json([OPENCODE_SAFETY_TOOL]);
        if (url.pathname.endsWith("/prompt_async")) {
          promptBodies.push((await request.json()) as Record<string, unknown>);
          const sessionID = decodeURIComponent(url.pathname.split("/")[2]);
          const controller = eventController;
          eventController = null;
          const events = [
            {
              type: "message.part.updated",
              properties: {
                sessionID,
                part: {
                  type: "step-finish",
                  id: `finish-${sessionID}`,
                  messageID: `message-${sessionID}`,
                  tokens: { input: 1, output: 0 },
                },
              },
            },
            { type: "session.idle", properties: { sessionID } },
          ];
          setTimeout(() => {
            try {
              for (const event of events)
                controller?.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(event)}\n\n`,
                  ),
                );
            } catch {
              // The stream can close first.
            }
          }, 0);
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    let serverKey = "server-1";
    let serverKeyReads = 0;
    const supervisor = {
      acquire: async () => ({
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${server.port}`,
        authHeader: "Basic test",
        get serverKey() {
          serverKeyReads++;
          return serverKey;
        },
        settle: () => {},
        beginTurn: async () => {},
        endTurn: () => {},
        serverStopped: () => false,
        markUnresponsive: () => {},
        release: () => {},
      }),
    } as unknown as OpenCodeSupervisor;
    const transport = (cwd: string, effort: string, model = "provider/model") =>
      new OpenCodeTransport({
        cwd,
        model,
        effort,
        systemPrompt: "system",
        supervisor,
        sessionId: `session-${cwd}-${effort}`,
      });
    const send = async (
      cwd: string,
      effort: string,
      model = "provider/model",
    ) => {
      const events: NormalizedEvent[] = [];
      const turn = transport(cwd, effort, model);
      const completed = new Promise<void>((resolve) => {
        void turn.send([{ type: "text", text: "go" }], (event) => {
          events.push(event);
          if (event.kind === "turn_completed") resolve();
        });
      });
      try {
        await Promise.race([
          completed,
          Bun.sleep(2_000).then(() => {
            throw new Error("the turn did not complete");
          }),
        ]);
      } finally {
        turn.close();
      }
      return {
        body: promptBodies.at(-1)!,
        notices: events.filter((event) => event.kind === "system_text"),
        completion: events.find((event) => event.kind === "turn_completed"),
      };
    };
    return {
      supervisor,
      providerDirectories,
      heldProviders,
      transport,
      send,
      serverKeyReads: () => serverKeyReads,
      replaceServer: () => {
        serverKey = "server-2";
      },
      stop: () => server.stop(true),
    };
  }

  it("loads one catalog per server and directory, and reloads after a replacement", async () => {
    const harness = catalogHarness();
    try {
      expect((await harness.send("/a", "low")).body).toMatchObject({
        variant: "low",
      });
      expect(
        (await harness.send("/a", "high")).body,
        "a new session on the same server",
      ).toMatchObject({ variant: "high" });
      await discoverOpenCodeModels(harness.supervisor, "/a");
      expect(harness.providerDirectories).toEqual(["/a"]);

      await harness.send("/b", "low");
      expect(harness.providerDirectories, "another directory").toEqual([
        "/a",
        "/b",
      ]);

      harness.replaceServer();
      expect((await harness.send("/a", "low")).body).toMatchObject({
        variant: "low",
      });
      expect(harness.providerDirectories, "the replaced server").toEqual([
        "/a",
        "/b",
        "/a",
      ]);
    } finally {
      await harness.stop();
    }
  });

  it("keeps no failed load: the next turn loads again", async () => {
    let failures = 1;
    const harness = catalogHarness({ failProvider: () => failures-- > 0 });
    try {
      const failed = await harness.send("/a", "high");
      expect(failed.body).not.toHaveProperty("variant");
      expect(failed.completion).toMatchObject({ status: "completed" });
      expect(failed.notices).toEqual([
        {
          kind: "system_text",
          text: OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
        },
      ]);
      const loaded = await harness.send("/a", "high");
      expect(loaded.body).toMatchObject({ variant: "high" });
      expect(loaded.notices).toEqual([]);
      expect(harness.providerDirectories).toEqual(["/a", "/a"]);
    } finally {
      await harness.stop();
    }
  });

  it("sends a model without variants silently at its default effort", async () => {
    const harness = catalogHarness();
    try {
      const plain = await harness.send("/a", "high", "provider/plain");
      expect(plain.body).not.toHaveProperty("variant");
      expect(plain.notices).toEqual([]);
    } finally {
      await harness.stop();
    }
  });
});
