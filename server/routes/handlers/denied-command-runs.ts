// The member's Run of a refused command (task 0faacc4e): the refused card's
// Run, after its confirm. POST /api/agents/:id/denied-command-runs runs the
// command the agent's tool call was refused, as an ask's Run does
// (ask-command-runner.ts): the terminal panel's shell, environment and cwd,
// as the agent host user, with no input and no terminal. The run ends in a
// system entry in the agent's chat and a notice to the agent.

import { fail, ok, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import {
  deniedRunLine,
  deniedRunNotice,
  type AskRunResult,
} from "../../ask-command-runner.ts";
import type { AskCommandRun, LogEntry } from "../../../shared/types.ts";
import { commandForPermissionDenial } from "../../../shared/permission-denial.ts";
import { isRunnableCommand } from "../../../shared/runnable-command.ts";
import type { LogMessage } from "../../../shared/i18n/log-message.ts";
import { RUN_NOT_YOURS } from "../../identity/member-reach.ts";

export interface DeniedCommandRunDeps {
  // The terminal panel's gate, then the agent's access: the same answer as
  // the ask Run's refusal (isomux-office.ts commandRuns.refusal).
  refusal(
    identity: Identity,
    agentId: string,
  ): "terminal_forbidden" | "member_reach" | "agent_limited" | null;
  // The agent's log entries of its current conversation; null when the
  // agent does not exist.
  logEntries(agentId: string): readonly LogEntry[] | null;
  start(
    agentId: string,
    command: string,
  ): Promise<{ done: Promise<AskRunResult> }>;
  // The run's end: `line` as a system entry in the agent's chat with
  // `metadata`, and `notice` to the agent from the member who ran it.
  report(
    agentId: string,
    line: LogMessage,
    metadata: Record<string, unknown>,
    memberUserId: string,
    notice: string,
  ): void;
  memberName(userId: string): string | null;
  now(): number;
}

export function deniedCommandRunHandlers(
  deps: DeniedCommandRunDeps,
): Record<string, RouteHandler> {
  // The refusals whose run has not ended, by agent and tool call id.
  const running = new Set<string>();

  const runDeniedCommand: RouteHandler = async (ctx) => {
    const agentId = ctx.params.id;
    const entries = deps.logEntries(agentId);
    if (!entries || !ctx.identity.userId)
      return fail(404, "not_found", "No such agent.");
    const refusal = deps.refusal(ctx.identity, agentId);
    if (refusal === "terminal_forbidden")
      return fail(
        403,
        refusal,
        "You cannot use this agent's terminal, so you cannot run its commands.",
      );
    if (refusal === "member_reach") return fail(403, refusal, RUN_NOT_YOURS);
    if (refusal === "agent_limited")
      return fail(403, refusal, "Run is off for agents below Standard access.");
    const body = ctx.body as { toolUseId?: unknown; command?: unknown } | null;
    const toolUseId = body?.toolUseId;
    const command = body?.command;
    if (typeof toolUseId !== "string" || typeof command !== "string")
      return fail(400, "invalid_request", "Send toolUseId and command.");
    // Only a call the log holds as refused, and only its own command.
    const refused = entries.some(
      (entry) =>
        entry.kind === "system" &&
        (
          entry.metadata?.permissionDenied as
            { toolUseId?: unknown } | undefined
        )?.toolUseId === toolUseId,
    );
    if (
      !refused ||
      commandForPermissionDenial({ toolUseId }, entries) !== command
    )
      return fail(
        409,
        "command_changed",
        "The chat has no refused command like this one.",
      );
    if (!isRunnableCommand(command))
      return fail(
        409,
        "command_not_runnable",
        "This command has characters that do not show, so it has no Run.",
      );
    // Claimed before the first await, until the run's end is handled.
    const key = `${agentId}\u0000${toolUseId}`;
    if (running.has(key))
      return fail(409, "run_in_progress", "This command is running.");
    running.add(key);
    const memberUserId = ctx.identity.userId;
    const run: AskCommandRun = {
      command,
      by: memberUserId,
      startedAt: deps.now(),
      state: "running",
    };
    let started: { done: Promise<AskRunResult> };
    try {
      started = await deps.start(agentId, command);
    } catch (err) {
      running.delete(key);
      console.error(
        `[denied-run] ${agentId}: the command could not start:`,
        err,
      );
      return fail(500, "run_failed", "The command could not start.");
    }
    const finish = (result: AskRunResult) => {
      const done: AskCommandRun = {
        ...run,
        state: "done",
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.timedOut ? { timedOut: true as const } : {}),
        durationMs: result.durationMs,
        output: result.output,
      };
      const member = deps.memberName(memberUserId) ?? "A member";
      deps.report(
        agentId,
        deniedRunLine(done),
        { deniedCommandRun: { ...done, toolUseId } },
        memberUserId,
        deniedRunNotice(member, done),
      );
    };
    void started.done
      .then(finish, (err: unknown) =>
        finish({
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: deps.now() - run.startedAt,
          output: `The run failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
      .catch((err: unknown) =>
        console.error(`[denied-run] ${agentId}: the end of a run failed:`, err),
      )
      .finally(() => running.delete(key));
    return ok(run, 202);
  };

  return { "agents.runDeniedCommand": runDeniedCommand };
}
