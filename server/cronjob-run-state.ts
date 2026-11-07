// A cron run's state as its row stores it: running, or ended with a kind, a
// time and a reason. This module is the only producer of those fields; the
// cron manager writes them only through runEndFields and runTransitionPatch.
import {
  logTextFields,
  msg,
  type LogMessage,
  type LogText,
} from "../shared/i18n/log-message.ts";
import type { CronjobRun } from "../shared/types.ts";

export type RunTerminalFields = Pick<
  CronjobRun,
  "status" | "endedAt" | "errorReason" | "errorReasonMessage"
>;

export interface RunEnd {
  status: Exclude<CronjobRun["status"], "running">;
  reason: LogText | null;
}

export type RunTransition =
  // running -> ended.
  | { kind: "end"; end: RunEnd }
  // ended (not skipped) -> running: a follow-up or an edit resumes the run.
  | { kind: "reopen" }
  // running -> the ended fields it had before a refused reopen.
  | { kind: "restore"; to: RunTerminalFields };

// The fields of a run that ends now. errorReason is the English (what agents,
// the API and older rows read), errorReasonMessage the parts each reader
// words. The message key is always present, undefined for plain text: the
// store spreads a patch, so an absent key would keep an old message.
export function runEndFields(end: RunEnd, now: number): RunTerminalFields {
  return { status: end.status, endedAt: now, ...reasonFields(end.reason) };
}

function reasonFields(
  reason: LogText | null,
): Pick<CronjobRun, "errorReason" | "errorReasonMessage"> {
  if (reason === null)
    return { errorReason: null, errorReasonMessage: undefined };
  const { content, message } = logTextFields(reason);
  return { errorReason: content, errorReasonMessage: message };
}

// The end a session turn gives its run. A usage-limit stop wins over the
// turn's status: Claude reports a refused turn completed.
export function turnRunEnd(
  turn: { status: "completed" | "interrupted" | "failed"; error?: LogText },
  usageLimitReason: LogText | undefined,
): RunEnd {
  if (usageLimitReason) return { status: "failed", reason: usageLimitReason };
  if (turn.status === "completed") return { status: "completed", reason: null };
  return {
    status: "failed",
    reason: turn.error ?? turnStoppedText(turn.status),
  };
}

// A turn that ended without completing and without an error of its own.
export function turnStoppedText(status: "interrupted" | "failed"): LogMessage {
  return status === "interrupted"
    ? msg("systemEntries.scheduleRun.interrupted")
    : msg("systemEntries.scheduleRun.failed");
}

const RUNNING: RunTerminalFields = {
  status: "running",
  endedAt: null,
  errorReason: null,
  errorReasonMessage: undefined,
};

// The fields of a run that starts now.
export function runStartFields(): RunTerminalFields {
  return { ...RUNNING };
}

// The fields after `t`, or null when `t` does not apply to `row`.
export function runTransitionPatch(
  row: RunTerminalFields,
  t: RunTransition,
  now: number,
): RunTerminalFields | null {
  switch (t.kind) {
    case "end":
      return row.status === "running" ? runEndFields(t.end, now) : null;
    case "reopen":
      return row.status === "running" || row.status === "skipped"
        ? null
        : { ...RUNNING };
    case "restore":
      return row.status === "running" && t.to.status !== "running"
        ? {
            status: t.to.status,
            endedAt: t.to.endedAt,
            errorReason: t.to.errorReason,
            errorReasonMessage: t.to.errorReasonMessage,
          }
        : null;
  }
}
