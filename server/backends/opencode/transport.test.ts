import { describe, expect, it } from "bun:test";
import {
  interruptedToolResults,
  isAuthenticationError,
  parseAllowedEvent,
} from "./transport.ts";
import { writeSafeContractFixture } from "./contract-fixture.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expectRejection } from "../../test-support/expect-rejection.ts";

describe("OpenCode OC1 raw-ingress allowlist", () => {
  it("closes only non-terminal tools when an abort reaches idle", () => {
    expect(
      interruptedToolResults([
        { callId: "running", terminal: false },
        { callId: "done", terminal: true },
      ]),
    ).toEqual([
      {
        kind: "tool_result",
        toolUseId: "running",
        content: "Tool interrupted.",
        isError: true,
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
          part: { type: "text", id: "part-1", messageID: "message-1", text: "safe" },
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
        properties: { sessionID: "s", part: { type: "reasoning", id: "r", messageID: "m", text: "why", time: { start: 10, end: 14 }, metadata: canary } },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "s", part: { type: "tool", id: "p", messageID: "m", tool: "bash", callID: "call", state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 20, end: 25 }, metadata: { exit: 1, private: canary } } } },
      },
      {
        type: "permission.asked",
        properties: { sessionID: "s", id: "perm", permission: "bash", patterns: ["false"], metadata: canary, always: [canary] },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "s", part: { type: "step-finish", id: "f", messageID: "m", tokens: { input: 9, output: 4, cache: { read: 2, write: 1 }, provider: canary }, cost: 0, snapshot: canary } },
      },
    ].map((event) => parseAllowedEvent(JSON.stringify(event)));
    expect(events).toEqual([
      { kind: "reasoning", sessionId: "s", messageId: "m", partId: "r", text: "why", durationMs: 4 },
      { kind: "tool", sessionId: "s", partId: "p", callId: "call", name: "bash", status: "error", input: { command: "false" }, error: "exit 1", exitCode: 1, durationMs: 5 },
      { kind: "permission", sessionId: "s", id: "perm", permission: "bash", patterns: ["false"] },
      { kind: "step_finish", sessionId: "s", usage: { inputTokens: 9, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 }, cost: 0 },
    ]);
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it("classifies only observed structured authentication failures", () => {
    expect(
      isAuthenticationError(
        { name: "APIError", message: "invalid credential", statusCode: 401, isRetryable: false },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: openai/gpt-4o. Did you mean: gpt-4o, gpt-4o-mini?",
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        { name: "UnknownError", message: "Model not found: openai/typo. Did you mean: gpt-4o?" },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        { name: "APIError", message: "provider unavailable", statusCode: 500, isRetryable: true },
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
    for await (const name of new Bun.Glob("fixtures/**/*").scan(import.meta.dir)) {
      const text = await Bun.file(join(import.meta.dir, name)).text();
      expect(text).not.toMatch(
        /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|bearer\s+[a-z0-9._~-]+)/i,
      );
    }
  });
});
