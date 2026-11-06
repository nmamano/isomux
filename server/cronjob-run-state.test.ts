// The run state machine of a cron run row (task abc438ee): which transitions
// apply to which row, and the fields each one writes. The manager writes a
// run's status, endedAt and reason only through these two functions, so a
// terminal row refuses a second end whatever owner races to write it.

import { describe, it, expect } from "bun:test";
import { msg } from "../shared/i18n/log-message.ts";
import type { CronjobRun } from "../shared/types.ts";
import {
  runEndFields,
  runTransitionPatch,
  type RunTerminalFields,
} from "./cronjob-run-state.ts";
import { expectWordedText } from "./test-support/worded.ts";

const STARTED = 1_000;
const ENDED = 2_000;
const NOW = 3_000;

const running: RunTerminalFields = {
  status: "running",
  endedAt: null,
  errorReason: null,
  errorReasonMessage: undefined,
};

// A row that ended: a plain reason for a failure, none otherwise.
function ended(
  status: Exclude<CronjobRun["status"], "running">,
): RunTerminalFields {
  return {
    status,
    endedAt: ENDED,
    errorReason: status === "completed" ? null : `ended ${status}`,
    errorReasonMessage: undefined,
  };
}

const TERMINAL = ["completed", "failed", "timed_out", "skipped"] as const;

describe("cron run state", () => {
  it("an end writes the kind, the time and the reason", () => {
    const worded = runEndFields(
      {
        status: "failed",
        reason: msg("systemEntries.scheduleRun.jobDeleted"),
      },
      NOW,
    );
    expect(worded.status).toBe("failed");
    expect(worded.endedAt).toBe(NOW);
    expectWordedText(
      worded.errorReason ?? undefined,
      worded.errorReasonMessage,
      "systemEntries.scheduleRun.jobDeleted",
    );
    // A backend's own text stays plain; no reason clears both fields.
    expect(runEndFields({ status: "timed_out", reason: "boom" }, NOW)).toEqual({
      status: "timed_out",
      endedAt: NOW,
      errorReason: "boom",
      errorReasonMessage: undefined,
    });
    expect(runEndFields({ status: "completed", reason: null }, NOW)).toEqual({
      status: "completed",
      endedAt: NOW,
      errorReason: null,
      errorReasonMessage: undefined,
    });
  });

  it("only a running row ends, and a second end never overwrites the first", () => {
    const end = {
      kind: "end",
      end: { status: "failed", reason: "late" },
    } as const;
    expect(runTransitionPatch(running, end, NOW)).toEqual(
      runEndFields(end.end, NOW),
    );
    for (const status of TERMINAL) {
      expect([status, runTransitionPatch(ended(status), end, NOW)]).toEqual([
        status,
        null,
      ]);
    }
  });

  it("a follow-up reopens an ended run, but not a skipped or a running one", () => {
    for (const status of ["completed", "failed", "timed_out"] as const) {
      // The ENABLING CONDITION: the row carries an end time to clear, and a
      // reason when it failed.
      const row = ended(status);
      expect(row.endedAt).toBe(ENDED);
      expect([
        status,
        runTransitionPatch(row, { kind: "reopen" }, NOW),
      ]).toEqual([status, running]);
    }
    expect(
      runTransitionPatch(ended("skipped"), { kind: "reopen" }, NOW),
    ).toBeNull();
    expect(runTransitionPatch(running, { kind: "reopen" }, NOW)).toBeNull();
  });

  it("a refused follow-up puts back exactly the ended fields the run had", () => {
    const before = runEndFields(
      {
        status: "failed",
        reason: msg("systemEntries.scheduleRun.interrupted"),
      },
      STARTED,
    );
    const reopened = runTransitionPatch(before, { kind: "reopen" }, NOW);
    expect(reopened).toEqual(running);
    expect(
      runTransitionPatch(reopened!, { kind: "restore", to: before }, NOW),
    ).toEqual(before);
    // Only a running row is restored, and only to an ended state.
    expect(
      runTransitionPatch(
        before,
        { kind: "restore", to: ended("completed") },
        NOW,
      ),
    ).toBeNull();
    expect(
      runTransitionPatch(running, { kind: "restore", to: running }, NOW),
    ).toBeNull();
  });
});
