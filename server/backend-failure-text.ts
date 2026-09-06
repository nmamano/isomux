// User-visible wording for a backend that died.
//
// Three orchestrator sites log a backend failure into the agent's chat, and all
// three used to paste the raw string the backend threw:
//
//   "Claude Code process exited with code 143"
//   "Agent stopped: error_during_execution. [ede_diagnostic] result_type=user ..."
//
// Neither says what happened, what caused it, or what to do next. This module
// maps the raw string to a sentence that answers all three, and hands the raw
// string back so the caller can keep it in the log entry's metadata.
//
// PASS-THROUGH IS THE DEFAULT. An unrecognized failure keeps its original text
// verbatim: a wrong explanation is worse than an opaque one, and the raw string
// is the only thing that helps when the cause is genuinely novel.
//
// CALLERS MUST CLASSIFY ON THE RAW TEXT, NOT ON `text`. detectAgentAuthError and
// diagnoseProcessExit both pattern-match the backend's own wording; running them
// against the humanized sentence would silently stop recognizing auth failures
// and session-file problems.
//
// The DECISIONS here are made on the raw backend text and are the same in every
// language; only the sentence this module selects is worded for the reader
// (internal-docs/i18n-loop.md, S7, ruled into the slice by the PM). The raw
// string is handed back byte-identical, and an unrecognized failure is still
// passed through exactly as it arrived - that text is the backend's, not ours
// (ruling 11).
//
// `id` is the language-INDEPENDENT identity of a failure. It exists because the
// orchestrator de-duplicates a death that two writers both saw, and it used to
// do that by comparing the rendered sentences. Two writers can now resolve to
// two languages, so comparing text would silently stop suppressing the
// duplicate; they compare this instead.
//
// It carries the SELECTED KEY AND the parameters that make two failures read
// differently, not just the branch that was taken: signal 130 and signal 131
// produce different explanations and are different deaths, so a bare "signal"
// would have widened the suppression the sentence comparison used to draw.

import type { Translator } from "../shared/i18n/translate.ts";

// A process killed by signal N exits with code 128+N (POSIX shell convention,
// which is what the SDK reports). 192 is the top of the useful range - beyond it
// the number is far more likely to be an ordinary application exit code.
const SIGNAL_EXIT_MIN = 129;
const SIGNAL_EXIT_MAX = 192;

// The two we can name a likely cause for. Both are what the box's OOM killer
// (earlyoom here) uses: SIGTERM first, SIGKILL if the process ignores it.
const SIGTERM_EXIT = 143;
const SIGKILL_EXIT = 137;

/**
 * What was decided about a failure and on what value, independent of the words
 * used to say it. Two results are the same failure exactly when these match.
 * "unclassified" is the pass-through case, where `text` IS the backend's own
 * string; it never takes part in suppression (only a classified death is ever
 * suppressed), so it needs no parameter.
 */
export type BackendFailureId =
  | `sigterm:${number}`
  | `sigkill:${number}`
  | `signal:${number}`
  | "stopped-during-turn"
  | "unclassified";

/**
 * The wording for a death with no cause information at all: the stream simply
 * ended mid-turn. Exported so the orchestrator's own stream-ended path words
 * itself identically rather than becoming a fourth inconsistent death surface.
 */
export function backendStoppedDuringTurn(t: Translator["t"]): string {
  return t("systemEntries.backendFailure.stoppedDuringTurn");
}

export interface BackendFailureText {
  // What the user reads in chat, in the reader's language.
  text: string;
  // The original string, present only when `text` differs from it. Callers put
  // this in the log entry's metadata so the diagnostic survives on disk. Always
  // the backend's own bytes.
  raw?: string;
  // What was decided and on what value, for callers that must compare two
  // failures without comparing their words.
  id: BackendFailureId;
}

// Matches the SDK's subprocess-exit wording ("Claude Code process exited with
// code 143"). Anchored on the phrase rather than the product name so a reworded
// or non-Claude variant still classifies.
const EXIT_CODE_RE = /exited with code (\d+)/i;

export function humanizeBackendFailure(
  t: Translator["t"],
  raw: string,
): BackendFailureText {
  const exitMatch = EXIT_CODE_RE.exec(raw);
  if (exitMatch) {
    const code = Number(exitMatch[1]);
    if (code === SIGTERM_EXIT) {
      return {
        text: t("systemEntries.backendFailure.sigterm", { code: SIGTERM_EXIT }),
        raw,
        id: `sigterm:${SIGTERM_EXIT}`,
      };
    }
    if (code === SIGKILL_EXIT) {
      return {
        text: t("systemEntries.backendFailure.sigkill", { code: SIGKILL_EXIT }),
        raw,
        id: `sigkill:${SIGKILL_EXIT}`,
      };
    }
    if (code >= SIGNAL_EXIT_MIN && code <= SIGNAL_EXIT_MAX) {
      return {
        text: t("systemEntries.backendFailure.signal", {
          signal: code - 128,
          code,
        }),
        raw,
        // The CODE is part of the identity: signal 130 and signal 131 are
        // different deaths with different explanations.
        id: `signal:${code}`,
      };
    }
    // An ordinary non-signal exit code. diagnoseProcessExit already annotates
    // the common causes of those with something specific, so adding a vague
    // sentence here would only push its hint further down the chat.
    return { text: raw, id: "unclassified" };
  }

  // The SDK's error-subtype result. The [ede_diagnostic] blob it carries is
  // harness-internal (result_type, stop_reason, ...) and means nothing to a
  // user, so the whole line is replaced rather than appended to.
  if (raw.includes("error_during_execution")) {
    return {
      text: backendStoppedDuringTurn(t),
      raw,
      id: "stopped-during-turn",
    };
  }

  return { text: raw, id: "unclassified" };
}

// Convenience for the log-entry metadata blob: undefined when nothing was
// rewritten, so an unchanged entry doesn't carry a redundant copy of itself.
export function backendFailureMeta(
  failure: BackendFailureText,
): Record<string, unknown> | undefined {
  return failure.raw === undefined
    ? undefined
    : { backendFailureRaw: failure.raw };
}
