// Who hears about a failing schedule, and when (task 420faed7): the pure
// parts. The manager wiring is in test-support/cronjob-failure-notice.di.test.ts.

import { describe, it, expect } from "bun:test";
import {
  failureStreak,
  noticeDue,
  failureNotice,
  failurePageKey,
  routeFailureNotice,
  type FailureNotice,
} from "./cronjob-failure-notice.ts";
import { runEndFields } from "./cronjob-run-state.ts";
import { msg } from "../shared/i18n/log-message.ts";
import type { Cronjob, CronjobRun } from "../shared/types.ts";

let seq = 0;
function row(
  trigger: CronjobRun["trigger"],
  status: CronjobRun["status"],
  startedAt: number,
  over: Partial<CronjobRun> = {},
): CronjobRun {
  return {
    id: `r${++seq}`,
    cronjobId: "job-1",
    cronjobName: "Mark main",
    trigger,
    status,
    startedAt,
    endedAt: status === "running" ? null : startedAt + 1,
    errorReason: status === "failed" ? "boom" : null,
    promptSnapshot: "p",
    agentTypeSnapshot: "claude",
    modelFamilySnapshot: "opus",
    effortSnapshot: "medium",
    cwdSnapshot: "/tmp",
    permissionModeSnapshot: "bypassPermissions",
    rootSessionId: "s",
    previewText: "",
    ...over,
  };
}
const fail = (at: number, trigger: CronjobRun["trigger"] = "scheduled") =>
  row(trigger, "failed", at);
const ok = (at: number, trigger: CronjobRun["trigger"] = "scheduled") =>
  row(trigger, "completed", at);
// The row the boot recovery writes for a run a restart cut.
const restartEnded = (at: number) => ({
  ...row("scheduled", "running", at),
  ...runEndFields(
    {
      status: "failed",
      reason: msg("systemEntries.scheduleRun.serverRestarted"),
    },
    at + 1,
  ),
});

describe("failureStreak", () => {
  it("counts the unattended failures since the last completed run, newest first by start time", () => {
    expect(failureStreak([])).toBe(0);
    // Stored oldest first.
    expect(failureStreak([fail(1), fail(2), fail(3)])).toBe(3);
    expect(failureStreak([fail(1), ok(2), fail(3), fail(4)])).toBe(2);
    expect(failureStreak([fail(1), fail(2), ok(3)])).toBe(0);
    // The order is the start time, not the array order: the completed run
    // started last.
    expect(failureStreak([ok(9), fail(3), fail(5)])).toBe(0);
    expect(failureStreak([fail(9), ok(3), fail(5)])).toBe(2);
  });

  it("breaks a tie of start times by stored order: the later row is newer", () => {
    // A Run now in the same millisecond as a scheduled run.
    expect(failureStreak([fail(5), ok(5, "manual"), fail(6)])).toBe(1);
    expect(failureStreak([ok(5, "manual"), fail(5)])).toBe(1);
    expect(failureStreak([fail(5), ok(5, "manual")])).toBe(0);
  });

  it("counts timed_out and webhook failures, and a completed run of any trigger ends the count", () => {
    expect(
      failureStreak([
        row("scheduled", "timed_out", 1),
        fail(2, "webhook"),
        fail(3),
      ]),
    ).toBe(3);
    expect(failureStreak([fail(1), ok(2, "manual"), fail(3)])).toBe(1);
    expect(failureStreak([fail(1), ok(2, "webhook"), fail(3)])).toBe(1);
  });

  it("skips manual failures, running and skipped rows, and runs a restart cut: they neither count nor end the count", () => {
    expect(failureStreak([fail(1), fail(2, "manual"), fail(3)])).toBe(2);
    expect(failureStreak([fail(1, "manual")])).toBe(0);
    expect(
      failureStreak([fail(1), row("scheduled", "skipped", 2), fail(3)]),
    ).toBe(2);
    expect(
      failureStreak([fail(1), fail(2), row("scheduled", "running", 3)]),
    ).toBe(2);
    expect(failureStreak([fail(1), restartEnded(2), fail(3)])).toBe(2);
    expect(failureStreak([ok(1), restartEnded(2), fail(3)])).toBe(1);
    // The enabling condition: the restart row is a failed scheduled row,
    // which counts unless the restart reason is read.
    expect(restartEnded(2).status).toBe("failed");
    expect(restartEnded(2).trigger).toBe("scheduled");
  });
});

describe("noticeDue", () => {
  it("is due at the first failure in a row and after every 5 more", () => {
    const due = Array.from({ length: 17 }, (_, i) => i).filter(noticeDue);
    expect(due).toEqual([1, 6, 11, 16]);
  });
});

describe("failureNotice", () => {
  const job = {
    id: "job-7f3a",
    name: "Mark main",
  } as Cronjob;
  const run = {
    ...fail(1),
    id: "run-c0ffee",
    errorReason: "Usage limit reached (canary-71)",
  };
  // Nov 20, 2:30 PM in the office's own time zone.
  const reset = new Date(2026, 10, 20, 14, 30).getTime();
  const isoLike = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  it("the agent's text names the job, its id, the run, its reason, the streak and the runs route", () => {
    const n = failureNotice(job, run, 6, null);
    const all = `${n.title}\n${n.agentBody}`;
    expect(n.title.length).toBeGreaterThan(0);
    expect(all).toContain("Mark main");
    expect(all).toContain("job-7f3a");
    expect(all).toContain("run-c0ffee");
    expect(all).toContain("canary-71");
    expect(all).toMatch(/\b6\b/);
    expect(all).toContain("/api/cronjobs/job-7f3a/runs");
  });

  it("the agent's text names the reset as an ISO time, only when there is one", () => {
    const iso = new Date(reset).toISOString();
    expect(failureNotice(job, run, 1, reset).agentBody).toContain(iso);
    const plain = failureNotice(job, run, 1, null);
    expect(`${plain.title}\n${plain.agentBody}`).not.toMatch(isoLike);
  });

  it("the member's text keeps the job's name, the reason and the streak, with no run id, job id or API path", () => {
    const n = failureNotice(job, run, 6, reset);
    const member = `${n.title}\n${n.memberBody}`;
    expect(member).toContain("Mark main");
    expect(member).toContain("canary-71");
    expect(member).toMatch(/\b6\b/);
    expect(member).not.toContain("job-7f3a");
    expect(member).not.toContain("run-c0ffee");
    expect(member).not.toContain("/api/");
    expect(member).not.toContain("GET ");
    // The same lines as the agent's text, each one shorter or the same.
    const agentLines = n.agentBody.split("\n");
    const memberLines = n.memberBody.split("\n");
    expect(memberLines.length).toBe(agentLines.length);
    // At the first failure too.
    const first = failureNotice(job, run, 1, null);
    expect(first.memberBody.split("\n").length).toBe(
      first.agentBody.split("\n").length,
    );
  });

  it("the member's text names the reset in the office's time with its zone, not as an ISO time", () => {
    const withReset = failureNotice(job, run, 1, reset).memberBody;
    const without = failureNotice(job, run, 1, null).memberBody;
    expect(withReset).not.toMatch(isoLike);
    expect(withReset).not.toContain(new Date(reset).toISOString());
    const added = withReset
      .split("\n")
      .filter((line) => !without.split("\n").includes(line));
    expect(added.length).toBe(1);
    const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(reset)
      .find((p) => p.type === "timeZoneName")?.value;
    expect(zone).toBeDefined();
    expect(added[0]).toContain("Nov");
    expect(added[0]).toMatch(/\b20\b/);
    expect(added[0]).toContain("2:30");
    expect(added[0]).toContain(zone!);
  });
});

describe("routeFailureNotice", () => {
  const notice: FailureNotice = {
    title: "T-canary",
    agentBody: "A-canary",
    memberBody: "M-canary",
  };
  function rig(agentTakes: boolean | "throws") {
    const messaged: { agentId: string; text: string }[] = [];
    const paged: {
      userId: string;
      key: string;
      title: string;
      body: string;
    }[] = [];
    const undeliverable: string[] = [];
    return {
      messaged,
      paged,
      undeliverable,
      deps: {
        messageAgent: (agentId: string, _job: Cronjob, text: string) => {
          messaged.push({ agentId, text });
          if (agentTakes === "throws") throw new Error("queue full");
          return agentTakes;
        },
        pageMember: (
          userId: string,
          key: string,
          title: string,
          body: string,
        ) => paged.push({ userId, key, title, body }),
        undeliverable: (job: Cronjob) => undeliverable.push(job.id),
      },
    };
  }
  const job = (over: Partial<Cronjob>) =>
    ({ id: "job-1", name: "Mark main", userId: "u-1", ...over }) as Cronjob;

  it("messages the agent that made the job, and pages nobody when it takes the message", () => {
    const r = rig(true);
    const to = routeFailureNotice(
      job({ createdByAgentId: "agent-maker" }),
      notice,
      r.deps,
    );
    expect(to).toBe("agent");
    expect(r.messaged.map((m) => m.agentId)).toEqual(["agent-maker"]);
    expect(r.messaged[0].text).toContain("T-canary");
    expect(r.messaged[0].text).toContain("A-canary");
    expect(r.messaged[0].text).not.toContain("M-canary");
    expect(r.paged.length).toBe(0);
  });

  it("pages the job's member under the job's key when the maker is gone, refuses, or throws", () => {
    for (const takes of [false, "throws"] as const) {
      const r = rig(takes);
      const to = routeFailureNotice(
        job({ createdByAgentId: "agent-gone" }),
        notice,
        r.deps,
      );
      expect(to).toBe("member");
      expect(r.messaged.length).toBe(1);
      expect(r.paged).toEqual([
        {
          userId: "u-1",
          key: failurePageKey("job-1"),
          title: "T-canary",
          body: "M-canary",
        },
      ]);
    }
    expect(failurePageKey("job-1")).not.toBe(failurePageKey("job-2"));
  });

  it("pages the member at once for a job no agent made", () => {
    const r = rig(true);
    expect(routeFailureNotice(job({}), notice, r.deps)).toBe("member");
    expect(r.messaged.length).toBe(0);
    expect(r.paged.map((p) => p.userId)).toEqual(["u-1"]);
  });

  it("tells nobody about a job with no member whose maker cannot take it", () => {
    for (const over of [
      { userId: null },
      { userId: null, createdByAgentId: "agent-gone" },
    ]) {
      const r = rig(false);
      expect(routeFailureNotice(job(over), notice, r.deps)).toBe("nobody");
      expect(r.paged.length).toBe(0);
      expect(r.undeliverable).toEqual(["job-1"]);
    }
  });
});
