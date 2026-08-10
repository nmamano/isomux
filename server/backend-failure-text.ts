// User-visible wording for a backend that died (tasks 86678675, e8168c2a).
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

// A process killed by signal N exits with code 128+N (POSIX shell convention,
// which is what the SDK reports). 192 is the top of the useful range - beyond it
// the number is far more likely to be an ordinary application exit code.
const SIGNAL_EXIT_MIN = 129;
const SIGNAL_EXIT_MAX = 192;

// The two we can name a likely cause for. Both are what the box's OOM killer
// (earlyoom here) uses: SIGTERM first, SIGKILL if the process ignores it.
const SIGTERM_EXIT = 143;
const SIGKILL_EXIT = 137;

const RESUMABLE = "The conversation is saved and can be resumed." as const;
const OOM_CAUSE =
  "The likely cause is the out-of-memory protection on this machine." as const;

// Used for a death with no cause information at all: the stream simply ended
// mid-turn. Exported so the orchestrator's own stream-ended path words itself
// identically rather than becoming a fourth inconsistent death surface.
export const BACKEND_STOPPED_DURING_TURN =
  `The agent backend stopped during the turn. ${RESUMABLE}` as const;

export interface BackendFailureText {
  // What the user reads in chat.
  text: string;
  // The original string, present only when `text` differs from it. Callers put
  // this in the log entry's metadata so the diagnostic survives on disk.
  raw?: string;
}

// Matches the SDK's subprocess-exit wording ("Claude Code process exited with
// code 143"). Anchored on the phrase rather than the product name so a reworded
// or non-Claude variant still classifies.
const EXIT_CODE_RE = /exited with code (\d+)/i;

export function humanizeBackendFailure(raw: string): BackendFailureText {
  const exitMatch = EXIT_CODE_RE.exec(raw);
  if (exitMatch) {
    const code = Number(exitMatch[1]);
    if (code === SIGTERM_EXIT) {
      return {
        text: `The agent backend was terminated by SIGTERM (exit code ${SIGTERM_EXIT}). ${OOM_CAUSE} ${RESUMABLE}`,
        raw,
      };
    }
    if (code === SIGKILL_EXIT) {
      return {
        text: `The agent backend was killed by SIGKILL (exit code ${SIGKILL_EXIT}). ${OOM_CAUSE} ${RESUMABLE}`,
        raw,
      };
    }
    if (code >= SIGNAL_EXIT_MIN && code <= SIGNAL_EXIT_MAX) {
      return {
        text: `The agent backend was stopped by signal ${code - 128} (exit code ${code}). ${RESUMABLE}`,
        raw,
      };
    }
    // An ordinary non-signal exit code. diagnoseProcessExit already annotates
    // the common causes of those with something specific, so adding a vague
    // sentence here would only push its hint further down the chat.
    return { text: raw };
  }

  // The SDK's error-subtype result. The [ede_diagnostic] blob it carries is
  // harness-internal (result_type, stop_reason, ...) and means nothing to a
  // user, so the whole line is replaced rather than appended to.
  if (raw.includes("error_during_execution")) {
    return { text: BACKEND_STOPPED_DURING_TURN, raw };
  }

  return { text: raw };
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
