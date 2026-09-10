// In-memory CronPersistence for the T1 cron tier. Keeps CronjobManager DI tests
// fully disk-free and deterministic - the payoff of injecting the persistence
// surface. Map-backed for cronjob config + runs; the session-log / usage paths
// return sensible empties (the DI tests assert on events/sessions/scheduler,
// not on persisted log bytes).
//
// Not imported by any production path.

import type { CronPersistence } from "../cronjob-manager.ts";
import type { Cronjob, CronjobRun } from "../../shared/types.ts";

export function makeFakeCronPersistence(): CronPersistence {
  let cronjobs: Cronjob[] = [];
  let cronjobsPrompt: string | null = null;
  const runsByJob = new Map<string, CronjobRun[]>();
  const claudeRoots = new Map<string, string>();

  const zeroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
  };

  return {
    loadCronjobs: () => cronjobs,
    saveCronjobs: (next) => {
      cronjobs = next;
    },
    loadCronjobsPrompt: () => cronjobsPrompt,
    saveCronjobsPrompt: (value) => {
      cronjobsPrompt = value;
    },
    migrateCronjobsPromptFromOfficeConfig: () => {},
    loadCronjobHistory: () => ({}),
    saveCronjobHistory: () => {},
    loadRuns: (jobId) => runsByJob.get(jobId) ?? [],
    saveRuns: (jobId, runs) => {
      runsByJob.set(jobId, runs);
    },
    appendRun: (jobId, run) => {
      const runs = runsByJob.get(jobId) ?? [];
      runs.push(run);
      runsByJob.set(jobId, runs);
    },
    updateRun: (jobId, runId, patch) => {
      const run = (runsByJob.get(jobId) ?? []).find((r) => r.id === runId);
      if (!run) return null;
      Object.assign(run, patch);
      return run;
    },
    findRun: (jobId, runId) =>
      (runsByJob.get(jobId) ?? []).find((r) => r.id === runId) ?? null,
    listAllCronjobIdsOnDisk: () => [...runsByJob.keys()],
    loadRunSessionsMap: () => ({}),
    getRunSessionClaudeConfigDir: (job, run, session) =>
      claudeRoots.get(`${job}/${run}/${session}`),
    ensureRunSessionClaudeConfigDir: (job, run, session, root) => {
      const key = `${job}/${run}/${session}`;
      if (!claudeRoots.has(key)) claudeRoots.set(key, root);
      return claudeRoots.get(key)!;
    },
    persistRunSessionFork: () => {},
    findUsageAtForkRun: () => undefined,
    rollRunSessionUsageOnResume: () => {},
    accumulateRunSessionUsage: () => ({ ...zeroUsage }),
    appendRunSessionUsageSnapshot: () => {},
    appendRunLog: () => {},
    loadRunLog: () => [],
    loadRunLogWithAncestors: () => [],
  };
}
