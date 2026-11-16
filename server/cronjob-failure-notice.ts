// Who hears about a failing schedule, and when (task 420faed7). An
// unattended run (scheduled or webhook) that fails tells the agent that made
// the job at the first failure in a row and again after every 5 more; when
// that agent is gone or cannot take the message, the job's member gets a
// page. A run stopped by a usage limit makes the job wait for the reset.
//
// This module holds the pure parts; cronjob-manager.ts calls them at each
// run end, and office-managers.ts wires the delivery.

import type { Cronjob, CronjobRun } from "../shared/types.ts";

// The reason key of a row the boot ended because a restart cut its run.
const RESTART_KEY = "systemEntries.scheduleRun.serverRestarted";

// Every how many failures in a row after the first a notice is due again.
const NOTICE_EVERY = 5;

// A run nobody started by hand: a member who clicks Run now sees its end.
export function unattended(trigger: CronjobRun["trigger"]): boolean {
  return trigger === "scheduled" || trigger === "webhook";
}

// What a notice says: the page's title and body, and the agent message is
// both joined.
export interface FailureNotice {
  title: string;
  body: string;
}

// How many unattended runs in a row failed, newest first. A completed run of
// any trigger ends the count; running, skipped, manual failed and
// restart-ended rows neither count nor end it.
export function failureStreak(runs: readonly CronjobRun[]): number {
  // Rows are stored in the order they started: that order breaks a tie of
  // start times.
  const newestFirst = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => b.run.startedAt - a.run.startedAt || b.index - a.index);
  let streak = 0;
  for (const { run } of newestFirst) {
    if (run.status === "completed") break;
    if (run.status !== "failed" && run.status !== "timed_out") continue;
    if (!unattended(run.trigger)) continue;
    if (cutByRestart(run)) continue;
    streak++;
  }
  return streak;
}

function cutByRestart(run: CronjobRun): boolean {
  return (run.errorReasonMessage ?? []).some(
    (part) => typeof part !== "string" && part.key === RESTART_KEY,
  );
}

// Whether a failure with this streak sends a notice: the first, then after
// every 5 more (1, 6, 11, ...).
export function noticeDue(streak: number): boolean {
  return streak >= 1 && (streak - 1) % NOTICE_EVERY === 0;
}

// The notice for `run` of `job`. waitUntil: the usage-limit reset the job's
// next run waits for, or null.
export function failureNotice(
  job: Pick<Cronjob, "id" | "name">,
  run: Pick<CronjobRun, "id" | "status" | "errorReason">,
  streak: number,
  waitUntil: number | null,
): FailureNotice {
  const title = `Schedule "${job.name}" failed`;
  const reason =
    run.errorReason ??
    (run.status === "timed_out" ? "It ran out of time." : "No reason given.");
  const lines = [
    `Run ${run.id} of schedule "${job.name}" (id ${job.id}) failed: ${reason}`,
    ...(streak > 1 ? [`${streak} runs in a row failed.`] : []),
    ...(waitUntil !== null
      ? [
          `The next run waits for the usage limit to reset at ${new Date(waitUntil).toISOString()}.`,
        ]
      : []),
    `Its runs are on the Runs tab of the Automations page (GET /api/cronjobs/${job.id}/runs).`,
    `Isomux tells you again after ${NOTICE_EVERY} more failed runs in a row.`,
  ];
  return { title, body: lines.join("\n") };
}

export interface FailureRouteDeps {
  // Sends the notice to this agent as a message from the job. False when the
  // agent does not exist or does not take the message.
  messageAgent: (agentId: string, job: Cronjob, text: string) => boolean;
  // Opens or re-raises the member's page with this key.
  pageMember: (
    userId: string,
    key: string,
    title: string,
    body: string,
  ) => void;
  // A notice nobody can get (a job with no member and no live maker).
  undeliverable?: (job: Cronjob) => void;
}

// The page key of a job's failure page.
export function failurePageKey(jobId: string): string {
  return `cronjob:${jobId}`;
}

// Sends `notice` to the agent that made `job`, else to the job's member.
// Returns who got it.
export function routeFailureNotice(
  job: Pick<Cronjob, "id" | "userId" | "createdByAgentId">,
  notice: FailureNotice,
  deps: FailureRouteDeps,
): "agent" | "member" | "nobody" {
  if (job.createdByAgentId) {
    let taken = false;
    try {
      taken = deps.messageAgent(
        job.createdByAgentId,
        job as Cronjob,
        `${notice.title}\n\n${notice.body}`,
      );
    } catch {
      taken = false;
    }
    if (taken) return "agent";
  }
  if (job.userId) {
    deps.pageMember(
      job.userId,
      failurePageKey(job.id),
      notice.title,
      notice.body,
    );
    return "member";
  }
  deps.undeliverable?.(job as Cronjob);
  return "nobody";
}
