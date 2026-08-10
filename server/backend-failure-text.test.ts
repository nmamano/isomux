// T0 unit tier: the death-message mapping (tasks 86678675, e8168c2a).
//
// These strings are the deliverable, not an implementation detail - Nil filed
// 86678675 because "Claude Code process exited with code 143" told an operator
// nothing about what happened or what to do. So the assertions are on the exact
// sentences, and a reword is meant to fail here and be re-approved.
//
// The pass-through cases matter as much as the rewrites: inventing a cause for
// a failure we do not recognize would be worse than the opaque original.
import { describe, expect, it } from "bun:test";

import {
  BACKEND_STOPPED_DURING_TURN,
  backendFailureMeta,
  humanizeBackendFailure,
} from "./backend-failure-text.ts";

describe("humanizeBackendFailure", () => {
  it("explains SIGTERM, the earlyoom signature", () => {
    const r = humanizeBackendFailure(
      "Claude Code process exited with code 143",
    );
    expect(r.text).toBe(
      "The agent backend was terminated by SIGTERM (exit code 143). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
    );
    // The raw string survives for the log entry's metadata.
    expect(r.raw).toBe("Claude Code process exited with code 143");
  });

  it("explains SIGKILL", () => {
    const r = humanizeBackendFailure(
      "Claude Code process exited with code 137",
    );
    expect(r.text).toBe(
      "The agent backend was killed by SIGKILL (exit code 137). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
    );
  });

  it("names other signals without guessing at a cause", () => {
    // 130 = SIGINT. No OOM sentence: we have no reason to believe that is why.
    const r = humanizeBackendFailure("process exited with code 130");
    expect(r.text).toBe(
      "The agent backend was stopped by signal 2 (exit code 130). The conversation is saved and can be resumed.",
    );
  });

  it("replaces the harness-internal ede_diagnostic blob", () => {
    const raw =
      "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
    const r = humanizeBackendFailure(raw);
    expect(r.text).toBe(
      "The agent backend stopped during the turn. The conversation is saved and can be resumed.",
    );
    expect(r.text).toBe(BACKEND_STOPPED_DURING_TURN);
    // The diagnostic is kept, just not shown in chat.
    expect(r.raw).toBe(raw);
  });

  it("passes an ordinary exit code through untouched", () => {
    // diagnoseProcessExit already says something specific about these; a vague
    // sentence here would only push its hint further down the chat.
    const r = humanizeBackendFailure("Claude Code process exited with code 1");
    expect(r.text).toBe("Claude Code process exited with code 1");
    expect(r.raw).toBeUndefined();
  });

  it("passes an unrecognized failure through untouched", () => {
    for (const raw of [
      "ECONNRESET",
      "Invalid API key",
      "",
      "process exited with code 200",
    ]) {
      expect(humanizeBackendFailure(raw)).toEqual({ text: raw });
    }
  });
});

describe("backendFailureMeta", () => {
  it("carries the raw diagnostic when the text was rewritten", () => {
    expect(
      backendFailureMeta(
        humanizeBackendFailure("Claude Code process exited with code 143"),
      ),
    ).toEqual({
      backendFailureRaw: "Claude Code process exited with code 143",
    });
  });

  it("is undefined when nothing was rewritten", () => {
    // An unchanged entry must not carry a redundant copy of its own content.
    expect(backendFailureMeta(humanizeBackendFailure("ECONNRESET"))).toBe(
      undefined,
    );
  });
});
