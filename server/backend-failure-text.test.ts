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
  it("explains SIGTERM, the earlyoom signature", () => {
    const r = humanizeBackendFailure(
      "Claude Code process exited with code 143",
    );
    expect(r.id).toBe("sigterm:143");
    expect(r.text).toEqual(
      msg("systemEntries.backendFailure.sigterm", { code: 143 }),
    );
    // The raw string survives for the log entry's metadata.
    expect(r.raw).toBe("Claude Code process exited with code 143");
  });

  it("explains SIGKILL", () => {
    const r = humanizeBackendFailure(
      "Claude Code process exited with code 137",
    );
    expect(r.id).toBe("sigkill:137");
    expect(r.text).toEqual(
      msg("systemEntries.backendFailure.sigkill", { code: 137 }),
    );
  });

  it("names other signals without guessing at a cause", () => {
    // 130 = SIGINT. No OOM sentence: we have no reason to believe that is why.
    const r = humanizeBackendFailure("process exited with code 130");
    expect(r.id).toBe("signal:130");
    expect(r.text).toEqual(
      msg("systemEntries.backendFailure.signal", {
        signal: 2,
        code: 130,
      }),
    );
  });

  it("replaces the harness-internal ede_diagnostic blob", () => {
    const raw =
      "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
    const r = humanizeBackendFailure(raw);
    expect(r.text).toEqual(BACKEND_STOPPED_DURING_TURN);
    expect(r.id).toBe("stopped-during-turn");
    // The diagnostic is kept, just not shown in chat.
    expect(r.raw).toBe(raw);
  });

  it("names a provider capacity refusal as the provider's, not the subscription's", () => {
    // The Codex app-server's wording, observed 2026-09-10. The account's rate
    // limits read 68% weekly with no 5-hour limit while this fired, so the
    // sentence must point away from the subscription.
    const r = humanizeBackendFailure(
      "Selected model is at capacity. Please try a different model.",
    );
    expect(r.text).toEqual(
      msg("systemEntries.backendFailure.providerCapacity"),
    );
    expect(r.raw).toBe(
      "Selected model is at capacity. Please try a different model.",
    );
    expect(r.id).toBe("provider-capacity");
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
      expect(humanizeBackendFailure(raw)).toEqual({
        text: raw,
        id: "unclassified",
      });
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

// The identity the orchestrator de-duplicates on. It replaced a comparison of
// the rendered sentences, so it has to draw the SAME boundary those sentences
// drew: two failures that used to read differently are still two.
describe("failure identity", () => {
  it("differs for two signals, which are two different explanations", () => {
    const a = humanizeBackendFailure("process exited with code 130");
    const b = humanizeBackendFailure("process exited with code 131");
    expect(a.id).toBe("signal:130");
    expect(b.id).toBe("signal:131");
    expect(a.id).not.toBe(b.id);
    // The boundary this preserves: the old code compared these sentences, and
    // they are not the same sentence.
    expect(a.text).not.toEqual(b.text);
  });

  it("separates the named signals from the generic ones", () => {
    expect(humanizeBackendFailure("exited with code 143").id).toBe(
      "sigterm:143",
    );
    expect(humanizeBackendFailure("exited with code 137").id).toBe(
      "sigkill:137",
    );
    expect(humanizeBackendFailure("result was error_during_execution").id).toBe(
      "stopped-during-turn",
    );
  });
});
