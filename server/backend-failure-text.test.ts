// T0 unit tier: the death-message mapping (tasks 86678675, e8168c2a).
//
// The pass-through cases matter as much as the rewrites: inventing a cause for
// a failure we do not recognize would be worse than the opaque original.
import { describe, expect, it } from "bun:test";

import {
  backendStoppedDuringTurn,
  backendFailureMeta,
  humanizeBackendFailure,
} from "./backend-failure-text.ts";
import { msg } from "../shared/i18n/log-message.ts";

// The sentence is a message each reader words (task c37a7365), so the
// expectations are the message, not text in one language.
const BACKEND_STOPPED_DURING_TURN = backendStoppedDuringTurn();

describe("humanizeBackendFailure", () => {
  const EDE =
    "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
  const CAPACITY =
    "Selected model is at capacity. Please try a different model.";
  // [case, raw failure, id, message]. The raw string always survives
  // byte-identical for the log entry's metadata. The id is what the
  // orchestrator de-duplicates on, so it carries the code: two signals are
  // two different deaths.
  it.each([
    [
      "explains SIGTERM, the earlyoom signature",
      "Claude Code process exited with code 143",
      "sigterm:143",
      msg("systemEntries.backendFailure.sigterm", { code: 143 }),
    ],
    [
      "explains SIGKILL",
      "Claude Code process exited with code 137",
      "sigkill:137",
      msg("systemEntries.backendFailure.sigkill", { code: 137 }),
    ],
    // 130 = SIGINT. No OOM sentence: we have no reason to believe that is why.
    // The phrase, not the product name, classifies it.
    [
      "names other signals without guessing at a cause",
      "process exited with code 130",
      "signal:130",
      msg("systemEntries.backendFailure.signal", { signal: 2, code: 130 }),
    ],
    [
      "names another signal as another death",
      "process exited with code 131",
      "signal:131",
      msg("systemEntries.backendFailure.signal", { signal: 3, code: 131 }),
    ],
    // The diagnostic is kept, just not shown in chat.
    [
      "replaces the harness-internal ede_diagnostic blob",
      EDE,
      "stopped-during-turn",
      BACKEND_STOPPED_DURING_TURN,
    ],
    // The Codex app-server's wording, observed 2026-09-10. The account's rate
    // limits read 68% weekly with no 5-hour limit while this fired, so the
    // sentence must point away from the subscription.
    [
      "names a provider capacity refusal as the provider's, not the subscription's",
      CAPACITY,
      "provider-capacity",
      msg("systemEntries.backendFailure.providerCapacity"),
    ],
  ] as const)("%s", (_case, raw, id, text) => {
    expect(humanizeBackendFailure(raw)).toEqual({ text, raw, id });
  });

  it("passes an ordinary exit code or an unrecognized failure through untouched", () => {
    // diagnoseProcessExit already says something specific about ordinary
    // exit codes; a vague sentence here would only push its hint further
    // down the chat.
    for (const raw of [
      "Claude Code process exited with code 1",
      "ECONNRESET",
      "Invalid API key",
      "",
      "process exited with code 200",
    ]) {
      expect(humanizeBackendFailure(raw)).toEqual({
        text: raw,
        id: "unclassified",
      });
    }
  });
});

describe("backendFailureMeta", () => {
  it("carries the raw diagnostic only when the text was rewritten", () => {
    expect(
      backendFailureMeta(
        humanizeBackendFailure("Claude Code process exited with code 143"),
      ),
    ).toEqual({
      backendFailureRaw: "Claude Code process exited with code 143",
    });
    // An unchanged entry must not carry a redundant copy of its own content.
    expect(backendFailureMeta(humanizeBackendFailure("ECONNRESET"))).toBe(
      undefined,
    );
  });
});
