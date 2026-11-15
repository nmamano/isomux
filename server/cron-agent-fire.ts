// The fires of a job with an agent target, which open no session.
//
// A plain one (task a0c26f59) sends the prompt to that agent as a message
// from the schedule.
//
// A command job's (task ab6851f2) runs a shell command in its folder with no
// model, and messages its agent target only when the command prints
// something, exits non-zero, is ended by a signal or the time limit, or
// cannot start. A quiet run (exit 0, no output) sends nothing, so it costs no
// model turn.
//
// The command runs as an ask's Run does (ask-command-runner.ts): the terminal
// panel's shell and environment for the job's member, through that member's
// host, with no terminal and no input. It gets no run token.

import {
  ASK_RUN_OUTPUT_TAIL,
  ASK_RUN_TIMEOUT_MS,
  startAskRun,
  type AskRunResult,
} from "./ask-command-runner.ts";
import { cwdProblem } from "./cwd-utils.ts";
import { errMessage } from "../shared/errors.ts";
import { errorText } from "./localized-error.ts";
import { hostFor } from "./member-hosts.ts";
import { terminalEnvForUser, type TerminalDeps } from "./terminal.ts";
import {
  generateCronjobRunId,
  type Cronjob,
  type CronjobCommandResult,
  type CronjobRun,
  type CronjobTarget,
} from "../shared/types.ts";
import {
  logTextFields,
  msg,
  type LogText,
} from "../shared/i18n/log-message.ts";
import {
  runEndFields,
  runStartFields,
  type RunEnd,
} from "./cronjob-run-state.ts";
import type { CommandRun, DeliveryRun, RunOwner } from "./cronjob-run-slots.ts";
import type { CwdProblem } from "./cwd-utils.ts";

export type CommandJob = Cronjob & { command: string; target: CronjobTarget };

export type RunCommand = (
  job: Cronjob & { command: string },
  opts: { cwd: string },
) => Promise<{ done: Promise<AskRunResult> }>;

export type DeliverToAgent = (
  job: Cronjob & { target: CronjobTarget },
  text: string,
) => Promise<
  | { ok: true; messageId: string; agentName: string }
  | { ok: false; reason: LogText }
>;

// The production runCommand: the terminal panel's shell and environment for
// the job's member (throws when the member's variables cannot be read), with
// TERM=dumb, through the member's host.
export function startScheduleCommand(
  deps: Pick<TerminalDeps, "buildEnvForUserId">,
): RunCommand {
  return async (job, opts) => {
    const userId = job.userId ?? null;
    const host = hostFor(userId);
    const { shell, env } = terminalEnvForUser(userId, {
      buildEnvForUserId: deps.buildEnvForUserId,
      host,
    });
    return startAskRun({
      command: job.command,
      cwd: opts.cwd,
      env: { ...env, TERM: "dumb" },
      shell,
      spawn: (argv, options) => host.spawnChild(argv, options),
    });
  };
}

// Whether a command's end needs nobody: exit 0 and no output.
export function quietEnd(result: AskRunResult): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    result.output.trim().length === 0
  );
}

// A fence longer than every backtick run in `text`, so the text cannot
// close it.
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text}\n${fence}`;
}

function endLine(result: AskRunResult): string {
  if (result.timedOut)
    return `it was stopped after ${ASK_RUN_TIMEOUT_MS / 60_000} minutes`;
  if (result.signal !== null) return `it was ended by ${result.signal}`;
  if (result.exitCode !== 0) return `it exited with code ${result.exitCode}`;
  return "it exited with code 0 and printed output";
}

// The message to the agent target. The prompt and a webhook's data come
// first, as written; then how the command ended, the command, and its output.
export function commandMessage(input: {
  jobName: string;
  prompt: string;
  block?: string;
  command: string;
  end: { result: AskRunResult } | { startError: string };
}): string {
  const report =
    "result" in input.end
      ? [
          `Schedule "${input.jobName}" ran its command, and ${endLine(input.end.result)}.`,
          `Command:\n${fenced(input.command)}`,
          ...(input.end.result.output.trim().length > 0
            ? [
                `Output (last ${ASK_RUN_OUTPUT_TAIL} characters at most, secrets masked):\n${fenced(input.end.result.output)}`,
              ]
            : []),
        ]
      : [
          `Schedule "${input.jobName}" could not run its command: ${input.end.startError}`,
          `Command:\n${fenced(input.command)}`,
        ];
  return [input.prompt.trim(), (input.block ?? "").trim(), ...report]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function commandResultOf(result: AskRunResult): CronjobCommandResult {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    output: result.output,
  };
}

export interface AgentFireDeps {
  now: () => number;
  limitRefusal?: (job: Cronjob) => LogText | null;
  runCommand?: RunCommand;
  deliverToAgent?: DeliverToAgent;
  appendRun: (jobId: string, run: CronjobRun) => void;
  announce: (run: CronjobRun) => void;
  hold: (owner: RunOwner) => void;
  endRun: (owner: RunOwner, end: RunEnd, extra?: Partial<CronjobRun>) => void;
  findRun: (jobId: string, runId: string) => CronjobRun | null;
  startCwdText: (problem: CwdProblem) => LogText;
}

// The fire of a command job. The row is written before anything runs, so
// Run now and a webhook can answer its id. Its owner holds the run's slot
// from the start of the command to the end of the send, so a scheduled slot
// that comes meanwhile is skipped.
export function fireCommandJob(
  deps: AgentFireDeps,
  job: CommandJob,
  trigger: CronjobRun["trigger"],
  extra: {
    triggeredBy?: string;
    webhook?: NonNullable<CronjobRun["webhook"]>;
    block?: string;
  },
): CronjobRun {
  const jobId = job.id;
  const runId = generateCronjobRunId();
  const now = deps.now();
  // The limits refuse the job as a whole: nothing runs and nobody is told.
  const refusal = deps.limitRefusal?.(job) ?? null;
  const startState =
    refusal === null
      ? runStartFields()
      : runEndFields({ status: "failed", reason: refusal }, now);
  const placeholderSessionId = `message-${runId}`;
  const run: CronjobRun = {
    id: runId,
    cronjobId: jobId,
    cronjobName: job.name,
    trigger,
    startedAt: now,
    ...startState,
    promptSnapshot:
      extra.block === undefined
        ? job.prompt
        : `${job.prompt}\n\n${extra.block}`,
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    ...(job.codexSandbox ? { codexSandboxSnapshot: job.codexSandbox } : {}),
    rootSessionId: placeholderSessionId,
    currentSessionId: placeholderSessionId,
    previewText: startState.errorReason ?? "",
    ...(extra.triggeredBy ? { triggeredBy: extra.triggeredBy } : {}),
    ...(extra.webhook ? { webhook: extra.webhook } : {}),
    commandSnapshot: job.command,
  };
  deps.appendRun(jobId, run);
  deps.announce(run);
  if (refusal !== null) return run;

  const owner: CommandRun = { kind: "command", jobId, runId, trigger };
  deps.hold(owner);
  const message = (end: { result: AskRunResult } | { startError: string }) =>
    commandMessage({
      jobName: job.name,
      prompt: job.prompt,
      ...(extra.block !== undefined ? { block: extra.block } : {}),
      command: job.command,
      end,
    });

  // Sends `text`; ends the run with `end` when the send works, else failed
  // with the send's reason.
  const send = async (
    text: string,
    end: RunEnd,
    kept: Partial<CronjobRun>,
  ): Promise<void> => {
    const deliver = deps.deliverToAgent;
    let reason: LogText;
    try {
      if (!deliver) {
        reason = msg("systemEntries.scheduleRun.sendFailed", {
          error: "this office cannot send schedule messages",
        });
      } else {
        const sent = await deliver(job, text);
        if (sent.ok) {
          deps.endRun(owner, end, {
            ...kept,
            ...(end.status === "completed"
              ? { previewText: sent.agentName }
              : {}),
            targetAgentSnapshot: {
              agentId: job.target.agentId,
              agentName: sent.agentName,
            },
          });
          return;
        }
        reason = sent.reason;
      }
    } catch (err) {
      console.error(
        `Cronjob run ${runId} send to ${job.target.agentId} failed:`,
        errMessage(err),
      );
      reason = msg("systemEntries.scheduleRun.sendFailed", {
        error: errorText(err),
      });
    }
    // A failed start keeps its own reason: the send failing too is logged.
    deps.endRun(
      owner,
      end.status === "failed" ? end : { status: "failed", reason },
      kept,
    );
  };

  // A start that fails: the run fails with the reason, and the agent is told.
  const failStart = (reason: LogText) => {
    const { content } = logTextFields(reason);
    return send(
      message({ startError: content }),
      { status: "failed", reason },
      {},
    );
  };

  void (async () => {
    let problem: CwdProblem | null;
    try {
      problem = cwdProblem(job.cwd);
    } catch (err) {
      await failStart(errMessage(err) || "Invalid cwd");
      return;
    }
    if (problem) {
      await failStart(deps.startCwdText(problem));
      return;
    }
    if (!deps.runCommand) {
      await failStart(
        msg("systemEntries.scheduleRun.commandStartFailed", {
          error: "this office cannot run schedule commands",
        }),
      );
      return;
    }
    let result: AskRunResult;
    try {
      const started = await deps.runCommand(job, { cwd: job.cwd });
      result = await started.done;
    } catch (err) {
      await failStart(
        msg("systemEntries.scheduleRun.commandStartFailed", {
          error: errorText(err),
        }),
      );
      return;
    }
    const kept = { commandResult: commandResultOf(result) };
    if (quietEnd(result)) {
      deps.endRun(owner, { status: "completed", reason: null }, kept);
      return;
    }
    await send(
      message({ result }),
      { status: "completed", reason: null },
      kept,
    );
  })().catch((err: unknown) => {
    // A row write that throws (a full disk) must not reach the process: Bun
    // ends the server on an unhandled rejection. endRun dropped the slot
    // before the write.
    console.error(`Cronjob run ${runId} end failed:`, errMessage(err));
  });
  return deps.findRun(jobId, runId) ?? run;
}

// A fire of a job with an agent target and no command: the prompt goes to
// that agent as a message from the schedule, and no session runs. The row is
// written before the send, so Run now and a webhook can answer its id. Its
// owner is a delivery, not a session, so a send in flight never makes the
// next slot a skip.
export function fireToAgentJob(
  deps: AgentFireDeps,
  job: Cronjob,
  target: CronjobTarget,
  trigger: CronjobRun["trigger"],
  extra: {
    triggeredBy?: string;
    webhook?: NonNullable<CronjobRun["webhook"]>;
  },
  prompt: string,
): CronjobRun {
  const jobId = job.id;
  const runId = generateCronjobRunId();
  const now = deps.now();
  // The maker agent's limits (below Standard) still stop the fire.
  const refusal = deps.limitRefusal?.(job) ?? null;
  const startState =
    refusal === null
      ? runStartFields()
      : runEndFields({ status: "failed", reason: refusal }, now);
  const placeholderSessionId = `message-${runId}`;
  const run: CronjobRun = {
    id: runId,
    cronjobId: jobId,
    cronjobName: job.name,
    trigger,
    startedAt: now,
    ...startState,
    promptSnapshot: prompt,
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    ...(job.codexSandbox ? { codexSandboxSnapshot: job.codexSandbox } : {}),
    rootSessionId: placeholderSessionId,
    currentSessionId: placeholderSessionId,
    previewText: startState.errorReason ?? "",
    ...(extra.triggeredBy ? { triggeredBy: extra.triggeredBy } : {}),
    ...(extra.webhook ? { webhook: extra.webhook } : {}),
    targetAgentSnapshot: { agentId: target.agentId, agentName: "" },
  };
  deps.appendRun(jobId, run);
  deps.announce(run);
  if (refusal !== null) return run;

  const owner: DeliveryRun = { kind: "delivery", jobId, runId };
  deps.hold(owner);
  const failWith = (reason: LogText) =>
    deps.endRun(owner, { status: "failed", reason });
  const deliver = deps.deliverToAgent;
  if (!deliver) {
    failWith(
      msg("systemEntries.scheduleRun.sendFailed", {
        error: "this office cannot send schedule messages",
      }),
    );
    return deps.findRun(jobId, runId) ?? run;
  }
  void (async () => {
    try {
      const result = await deliver({ ...job, target }, prompt);
      if (!result.ok) {
        failWith(result.reason);
        return;
      }
      deps.endRun(
        owner,
        { status: "completed", reason: null },
        {
          previewText: result.agentName,
          targetAgentSnapshot: {
            agentId: target.agentId,
            agentName: result.agentName,
          },
        },
      );
    } catch (err) {
      console.error(
        `Cronjob run ${runId} send to ${target.agentId} failed:`,
        errMessage(err),
      );
      failWith(
        msg("systemEntries.scheduleRun.sendFailed", {
          error: errorText(err),
        }),
      );
    }
  })();
  return run;
}
