import { expect, it, spyOn } from "bun:test";
import {
  logOpenCodeError,
  logOpenCodeStreamSilence,
  openCodeErrorMessage,
  openCodeRetryMessage,
} from "./errors.ts";
import type { OpenCodeStreamSilence } from "./transport.ts";

it("gives errors a cause without copying provider text", () => {
  for (const [error, cause] of [
    [{ name: "ContextOverflowError" }, /conversation.*long/i],
    [{ name: "APIError", statusCode: 429 }, /rate limit.*429/i],
    [{ name: "APIError", statusCode: 503 }, /HTTP 503/],
    [{ name: "APIError", message: "Header timeout SECRET_CANARY" }, /time/i],
    [
      { name: "APIError", message: "Connection reset by server SECRET_CANARY" },
      /connection/i,
    ],
    [
      { name: "UnknownError", message: 'Agent not found: "SECRET_CANARY"' },
      /configuration/i,
    ],
    [{ name: "UnknownError", message: "SECRET_CANARY" }, /OpenCode.*turn/i],
    [
      { name: "NewUnknownEvent", message: "SECRET_CANARY" },
      /provider or transport/i,
    ],
  ] as const) {
    const copy = openCodeErrorMessage(error);
    expect(copy).toMatch(cause);
    expect(copy).not.toContain("SECRET_CANARY");
  }
});

it("logs reviewed cause fields with secrets redacted", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    logOpenCodeError({
      name: "APIError",
      statusCode: 503,
      isRetryable: true,
      message:
        "Bearer bearer-canary https://user:pass-canary@example.com/?token=url-canary sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    const output = JSON.stringify(logged.mock.calls);
    for (const secret of [
      "bearer-canary",
      "pass-canary",
      "url-canary",
      "abcdefghijklmnopqrstuvwxyz123456",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("APIError");
    expect(output).toContain("503");
    expect(output).toContain("isRetryable");
  } finally {
    logged.mockRestore();
  }
});

it("logs the agent, the failure and OpenCode's log next to the cause", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    logOpenCodeError(
      { name: "Error" },
      {
        agentId: "agent-1",
        failure: "failure text",
        step: "begin_turn",
        openCodeLog: "/profile/opencode.log",
      },
    );
    expect(logged.mock.calls).toHaveLength(1);
    const [tag, line] = logged.mock.calls[0] as [string, string];
    expect(tag).toBe("[opencode]");
    expect(JSON.parse(line)).toEqual({
      agentId: "agent-1",
      name: "Error",
      failure: "failure text",
      step: "begin_turn",
      openCodeLog: "/profile/opencode.log",
    });
  } finally {
    logged.mockRestore();
  }
});

// Task 430d7bfd: one line per silent stream, in the same journal as a
// failure.
it("logs a stream silence as one tagged line with its fields", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const silence: OpenCodeStreamSilence = {
      agentId: "agent-1",
      sessionId: "ses_1",
      silence: 1,
      deadlineAt: "2026-10-17T00:46:30.000Z",
      lastEvent: { type: "server.heartbeat", at: "2026-10-17T00:46:00.000Z" },
      waitingOn: "tool",
      tools: ["bash"],
      probe: "healthy",
      outcome: "recovered",
      openCodeLog: "/profile/opencode.log",
    };
    logOpenCodeStreamSilence(silence);
    expect(logged.mock.calls).toHaveLength(1);
    const [tag, line] = logged.mock.calls[0] as [string, string];
    expect(tag).toBe("[opencode]");
    expect(JSON.parse(line)).toEqual({
      event: "event_stream_silent",
      ...silence,
    });
  } finally {
    logged.mockRestore();
  }
});

for (const [label, message, cause] of [
  ["timeout", "SSE read timed out SECRET_CANARY", /time/i],
  ["network", "Connection reset by server SECRET_CANARY", /connection/i],
  ["HTTP status", "HTTP 503 SECRET_CANARY", /503/],
  ["rate limit", "rate limit SECRET_CANARY", /rate limit/i],
  ["overloaded", "overloaded SECRET_CANARY", /busy/i],
  ["unknown", "SECRET_CANARY", /provider/i],
] as const) {
  it(`shows a reviewed ${label} retry cause and bounded attempt`, () => {
    const copy = openCodeRetryMessage(message, 2);
    expect(copy).toMatch(cause);
    expect(copy).toMatch(/retrying 2 of 5/);
    expect(copy).not.toContain("SECRET_CANARY");
  });
}
