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
  backendStoppedDuringTurn,
  backendFailureMeta,
  humanizeBackendFailure,
} from "./backend-failure-text.ts";
import { english, translatorForLanguage } from "./i18n.ts";

// The sentences below are the signed-off ENGLISH, so the matrix runs on the
// English translator and every assertion it always made is unchanged. The
// language block at the bottom is the S7 addition.
const t = english.t;
const BACKEND_STOPPED_DURING_TURN = backendStoppedDuringTurn(t);

describe("humanizeBackendFailure", () => {
  it("explains SIGTERM, the earlyoom signature", () => {
    const r = humanizeBackendFailure(
      t,
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
      t,
      "Claude Code process exited with code 137",
    );
    expect(r.text).toBe(
      "The agent backend was killed by SIGKILL (exit code 137). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
    );
  });

  it("names other signals without guessing at a cause", () => {
    // 130 = SIGINT. No OOM sentence: we have no reason to believe that is why.
    const r = humanizeBackendFailure(t, "process exited with code 130");
    expect(r.text).toBe(
      "The agent backend was stopped by signal 2 (exit code 130). The conversation is saved and can be resumed.",
    );
  });

  it("replaces the harness-internal ede_diagnostic blob", () => {
    const raw =
      "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
    const r = humanizeBackendFailure(t, raw);
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
    const r = humanizeBackendFailure(t, "Claude Code process exited with code 1");
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
      expect(humanizeBackendFailure(t, raw)).toEqual({
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
        humanizeBackendFailure(t, "Claude Code process exited with code 143"),
      ),
    ).toEqual({
      backendFailureRaw: "Claude Code process exited with code 143",
    });
  });

  it("is undefined when nothing was rewritten", () => {
    // An unchanged entry must not carry a redundant copy of its own content.
    expect(backendFailureMeta(humanizeBackendFailure(t, "ECONNRESET"))).toBe(
      undefined,
    );
  });
});

// The decisions are made on the RAW backend text and are the same in every
// language; only the selected sentence follows the reader
// (internal-docs/i18n-loop.md, S7). Literal strings (ruling 14).
describe("in the reader's language", () => {
  const es = translatorForLanguage("es").t;
  const ca = translatorForLanguage("ca").t;

  it("words a known failure in the reader's language, keeping the raw bytes", () => {
    const raw = "Claude Code process exited with code 143";
    const r = humanizeBackendFailure(es, raw);
    expect(r.text).toBe(
      "El backend del agente se terminó con SIGTERM (código de salida 143). La causa más probable es la protección contra falta de memoria de esta máquina. La conversación está guardada y se puede retomar.",
    );
    // Same decision, same raw bytes: only the wording moved.
    expect(r.id).toBe("sigterm:143");
    expect(r.raw).toBe(raw);
    expect(backendFailureMeta(r)).toEqual({ backendFailureRaw: raw });
  });

  it("classifies on the raw text, not on the words it produced", () => {
    // The Catalan sentence contains none of the English the matcher keys on,
    // so a classifier that read `text` instead of `raw` would stop recognizing
    // this the moment the reader was not English.
    const r = humanizeBackendFailure(ca, "Claude Code process exited with code 137");
    expect(r.id).toBe("sigkill:137");
    expect(r.text).toContain("SIGKILL");
    expect(r.text).toContain("La conversa està desada i es pot reprendre.");
  });

  it("passes an unrecognized failure through in the backend's own bytes", () => {
    // Not translated in any language: this text is the backend's, not ours.
    for (const reader of [es, ca]) {
      expect(humanizeBackendFailure(reader, "ECONNRESET")).toEqual({
        text: "ECONNRESET",
        id: "unclassified",
      });
      expect(
        humanizeBackendFailure(reader, "Claude Code process exited with code 1")
          .text,
      ).toBe("Claude Code process exited with code 1");
    }
  });
});

// The identity the orchestrator de-duplicates on. It replaced a comparison of
// the rendered sentences, so it has to draw the SAME boundary those sentences
// drew: same failure in any language is one death, and two failures that used
// to read differently are still two (internal-docs/i18n-loop.md, S7).
describe("failure identity", () => {
  const en = english.t;
  const ca = translatorForLanguage("ca").t;

  it("is equal for the same failure read in different languages", () => {
    const raw = "Claude Code process exited with code 143";
    expect(humanizeBackendFailure(en, raw).id).toBe(
      humanizeBackendFailure(ca, raw).id,
    );
    // ... and the sentences genuinely differ, so this is not equal-by-accident.
    expect(humanizeBackendFailure(en, raw).text).not.toBe(
      humanizeBackendFailure(ca, raw).text,
    );
  });

  it("differs for two signals, which are two different explanations", () => {
    const a = humanizeBackendFailure(en, "process exited with code 130");
    const b = humanizeBackendFailure(en, "process exited with code 131");
    expect(a.id).toBe("signal:130");
    expect(b.id).toBe("signal:131");
    expect(a.id).not.toBe(b.id);
    // The boundary this preserves: the old code compared these sentences, and
    // they are not the same sentence.
    expect(a.text).not.toBe(b.text);
  });

  it("separates the named signals from the generic ones", () => {
    expect(humanizeBackendFailure(en, "exited with code 143").id).toBe(
      "sigterm:143",
    );
    expect(humanizeBackendFailure(en, "exited with code 137").id).toBe(
      "sigkill:137",
    );
    expect(
      humanizeBackendFailure(en, "result was error_during_execution").id,
    ).toBe("stopped-during-turn");
  });
});
