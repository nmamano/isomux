// The Apps tab's response-landing rule. Two shared panes - the log pane and its
// error - are written by requests that can outlive what asked for them, and the
// UI has no React render harness (see EditAgentDialog.test.ts), so the decision
// is extracted and covered here.
//
// The bug it exists to prevent: click `log` on A, click `log` on B before A
// answers, and A's journal appears under B's row.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, it, expect } from "bun:test";
import { nextPollDelay, shouldCommit } from "./AppsView.tsx";

describe("shouldCommit", () => {
  it("lets a response land under the row that asked for it", () => {
    expect(shouldCommit(1, 1, "alpha", "alpha")).toBe(true);
  });

  it("refuses A's response once B has been opened", () => {
    // A issued at gen 1; opening B bumped the generation AND moved the target.
    expect(shouldCommit(1, 2, "alpha", "beta")).toBe(false);
  });

  it("refuses a response whose row is no longer the open one", () => {
    // Belt and braces: even if a generation were somehow reused, the target
    // check alone still keeps A's journal out of B's pane.
    expect(shouldCommit(1, 1, "alpha", "beta")).toBe(false);
  });

  it("refuses a response that comes back after the pane was closed", () => {
    // Closing bumps the generation and clears the target, so a late answer
    // cannot populate the pane a LATER row opens.
    expect(shouldCommit(1, 2, "alpha", null)).toBe(false);
  });

  it("refuses a response for a row that was reopened as a new request", () => {
    // Same row, clicked twice: only the newest request may write.
    expect(shouldCommit(1, 3, "alpha", "alpha")).toBe(false);
    expect(shouldCommit(3, 3, "alpha", "alpha")).toBe(true);
  });

  it("refuses everything once nothing is open (unmount, delete)", () => {
    expect(shouldCommit(4, 4, "alpha", null)).toBe(false);
  });
});

describe("nextPollDelay", () => {
  it("waits a full interval after a snapshot that landed", () => {
    expect(nextPollDelay(false, true)).toBe(5000);
  });

  it("comes straight back when a delta overtook the snapshot", () => {
    // The reducer refused it, so the list is short until something replaces it.
    expect(nextPollDelay(false, false)).toBe(0);
  });

  it("STOPS once its loop is cancelled, whatever the outcome was", () => {
    // The blocker this exists for: a rehydrate replaces the polling effect, and
    // an outgoing loop that rescheduled itself here would poll forever
    // alongside the new one - one extra loop per reconnect.
    expect(nextPollDelay(true, true)).toBeNull();
    expect(nextPollDelay(true, false)).toBeNull();
  });
});
