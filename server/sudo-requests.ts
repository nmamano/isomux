// Sudo requests (task 43a28eed): an agent asks to run one command as root,
// and an office owner types the box account's password in the ask. The
// server runs the command once with it (sudo-runner.ts) and tells the agent
// the result. The password goes from the run body to sudo's stdin and
// nowhere else: no function here returns, logs, stores or emits it.
//
// An open request is an ask (AskEntry.sudo). It closes when the run starts,
// when the member declines it, or after SUDO_WRONG_PASSWORD_MAX attempts
// where sudo did not start the command (422 not_started, with sudo's reason:
// a wrong password, or a command the account may not run).
//
// One run per agent: run() takes the agent's lock before its first await and
// keeps it until sudo refuses or the run ends.

import { randomUUID } from "node:crypto";

import type { AskEntry, SudoAskRequest } from "../shared/types.ts";
import {
  msg,
  renderLogText,
  type LogMessage,
} from "../shared/i18n/log-message.ts";
import { english } from "./i18n.ts";
import {
  askVisibleTo,
  AsksUnavailableError,
  type AskAudienceDeps,
  type AskStore,
} from "./asks.ts";
import {
  checkSudoCommand,
  SUDO_COMMAND_MAX,
  type SudoCommandError,
} from "./sudo-command.ts";
import {
  SUDO_OUTPUT_TAIL,
  SUDO_TIMEOUT_MS,
  type SudoProbe,
  type SudoRunResult,
  type SudoStart,
  type SudoStartOptions,
} from "./sudo-runner.ts";
import type { SudoRunRow, SudoRunStore } from "./sudo-run-store.ts";

export type SudoOutcome =
  | "started" // the run started; the ask closed
  | "declined" // the member declined; the ask closed
  | "locked_out" // SUDO_WRONG_PASSWORD_MAX wrong passwords; the ask closed
  | "finished" // the run ended
  | "restarted"; // the server restarted during the run; its result is unknown

export const SUDO_REQUEST_REASON_MAX = 500;
// A sanity bound, not a quota.
export const SUDO_REQUESTS_OPEN_MAX = 10;
// Each wrong password goes to the box's auth log, and PAM can lock the
// account after a few.
export const SUDO_WRONG_PASSWORD_MAX = 3;
// sudo -S reads one line per attempt, and the rest of stdin goes to the
// command: a password is one line.
export const SUDO_PASSWORD_MAX = 1024;

export interface SudoRequestDeps {
  // The open requests.
  asks: AskStore;
  // Who sees and answers an ask (askVisibleTo).
  audience: AskAudienceDeps;
  // The agent's manager: a user id, null for an unowned agent, undefined
  // when there is no such agent.
  agentUserId: (agentId: string) => string | null | undefined;
  // The agent's working directory, or null when there is no such agent.
  agentCwd: (agentId: string) => string | null;
  // Whether the agent is below Standard access: it reads text from
  // strangers, so a prompt-injected root ask is the likeliest abuse.
  agentLimited: (agentId: string) => boolean;
  isOfficeOwner: (userId: string) => boolean;
  // A member by username (case-insensitive), or null.
  memberByName: (name: string) => { id: string; name: string } | null;
  // A member's name by id, or null when the member is gone.
  memberName: (userId: string) => string | null;
  probe: () => Promise<SudoProbe>;
  start: (opts: Omit<SudoStartOptions, "home">) => Promise<SudoStart>;
  runs: SudoRunStore;
  // An outcome: a system line in the agent's chat (with the request id and
  // the outcome as metadata), and, unless `notice` is null, an office notice
  // to the agent from `member`, whose act it reports. "started" closes the
  // ask and tells the agent nothing yet; "finished" and "restarted" carry
  // the result in the notice.
  report: (
    agentId: string,
    requestId: string,
    outcome: SudoOutcome,
    line: LogMessage,
    member: string,
    notice: string | null,
  ) => void;
  now: () => number;
}

export type SudoRequestFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 429 | 500;
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
};

export type SudoRequestResult<T> = ({ ok: true } & T) | SudoRequestFailure;

type SudoAsk = AskEntry & { sudo: SudoAskRequest };

const requestFailed: SudoRequestFailure = {
  ok: false,
  status: 500,
  code: "request_failed",
  message: "the request could not be saved",
};

// The line as the agent reads it.
const noticeOf = (line: LogMessage) =>
  `[Isomux: ${renderLogText(english, line)}]`;

function runningIn(seconds: number): string {
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.round(seconds / 60)} min`;
}

// What the agent hears when the run ends: how it ended and the last output.
function finishedNotice(command: string, member: string, r: SudoRunResult) {
  const took = runningIn(r.durationMs / 1000);
  const end = r.timedOut
    ? `It was stopped at the ${SUDO_TIMEOUT_MS / 60_000}-minute limit (${r.signal ?? "SIGTERM"}) after ${took}.`
    : r.exitCode !== null
      ? `It ended with exit code ${r.exitCode} after ${took}.`
      : `It was ended by ${r.signal ?? "a signal"} after ${took}.`;
  const output =
    r.output === ""
      ? "It wrote no output."
      : `The last ${SUDO_OUTPUT_TAIL} characters of its stdout and stderr:\n${r.output}`;
  return `[Isomux: ${member} ran your sudo request as root: ${command}\n${end} ${output}]`;
}

export function createSudoRequests(deps: SudoRequestDeps) {
  // The agents with a run in progress: from the run's first check to the
  // end of sudo's auth, or to the end of the run.
  const busy = new Set<string>();
  // Attempts sudo refused, by request.
  const refusals = new Map<string, number>();

  const openRequests = (): SudoAsk[] =>
    deps.asks.listAll().filter((e): e is SudoAsk => e.sudo !== undefined);

  // An unavailable asks store is the request's failure, never a throw.
  function guarded<T>(run: () => T): T | SudoRequestFailure {
    try {
      return run();
    } catch (err) {
      if (err instanceof AsksUnavailableError) return requestFailed;
      throw err;
    }
  }

  // The request, when this member may answer it: the member it names, and
  // still an office owner (the box account's password is the owner's).
  function answerable(
    userId: string | null,
    agentId: string,
    requestId: string,
    audience: AskAudienceDeps,
  ): SudoRequestResult<{ entry: SudoAsk; userId: string }> {
    const entry = openRequests().find((e) => e.sudo.requestId === requestId);
    if (!entry || entry.agentId !== agentId)
      return { ok: false, status: 404, code: "not_found" };
    if (
      !userId ||
      !askVisibleTo(entry, userId, audience) ||
      !audience.isOfficeOwner(userId) ||
      !deps.isOfficeOwner(userId)
    )
      return { ok: false, status: 403, code: "forbidden" };
    return { ok: true, entry, userId };
  }

  const inProgress: SudoRequestFailure = {
    ok: false,
    status: 409,
    code: "run_in_progress",
    message: "a sudo command of this agent is running",
  };

  // Calls `report`; a throw there (the agent went) never reaches the caller.
  function report(...args: Parameters<SudoRequestDeps["report"]>): void {
    try {
      deps.report(...args);
    } catch {
      console.error("[sudo-requests] the agent was not told an outcome");
    }
  }

  function memberLabel(userId: string): string {
    return deps.memberName(userId) ?? "A member";
  }

  // The run ended (or its promise failed): drop the row, tell the agent,
  // free the agent.
  function finish(
    entry: SudoAsk,
    userId: string,
    result: SudoRunResult | null,
  ): void {
    const { requestId, command } = entry.sudo;
    try {
      deps.runs.remove(requestId);
    } catch {
      console.error("[sudo-requests] a run row could not be removed");
    }
    try {
      if (result)
        report(
          entry.agentId,
          requestId,
          "finished",
          result.timedOut
            ? msg("systemEntries.sudoRequest.timedOut", { command })
            : result.exitCode !== null
              ? msg("systemEntries.sudoRequest.exited", {
                  command,
                  code: String(result.exitCode),
                })
              : msg("systemEntries.sudoRequest.killed", {
                  command,
                  signal: result.signal ?? "",
                }),
          userId,
          finishedNotice(command, memberLabel(userId), result),
        );
      else {
        const line = msg("systemEntries.sudoRequest.lost", { command });
        report(
          entry.agentId,
          requestId,
          "finished",
          line,
          userId,
          noticeOf(line),
        );
      }
    } catch {
      console.error("[sudo-requests] the agent was not told a run's end");
    } finally {
      busy.delete(entry.agentId);
    }
  }

  function open(
    agentId: string,
    body: unknown,
  ): Promise<SudoRequestResult<{ requestId: string }>> | SudoRequestFailure {
    const manager = deps.agentUserId(agentId);
    const cwd = deps.agentCwd(agentId);
    if (manager === undefined || cwd === null)
      return { ok: false, status: 404, code: "not_found" };
    if (deps.agentLimited(agentId))
      return {
        ok: false,
        status: 403,
        code: "agent_limited",
        message:
          "an agent below Standard access may not ask to run a command as root",
      };
    const b = (typeof body === "object" && body !== null ? body : {}) as {
      command?: unknown;
      reason?: unknown;
      member?: unknown;
    };
    const commandError = checkSudoCommand(b.command);
    if (commandError)
      return {
        ok: false,
        status: 400,
        code: "invalid_command",
        message: COMMAND_ERRORS[commandError],
        detail: { reason: commandError },
      };
    const command = b.command as string;
    if (
      typeof b.reason !== "string" ||
      b.reason.trim() === "" ||
      b.reason.length > SUDO_REQUEST_REASON_MAX
    )
      return {
        ok: false,
        status: 400,
        code: "invalid_reason",
        message: `reason: 1 to ${SUDO_REQUEST_REASON_MAX} characters`,
      };
    const reason = b.reason;
    let memberUserId: string | null = manager;
    if (b.member !== undefined) {
      const found =
        typeof b.member === "string" ? deps.memberByName(b.member) : null;
      if (!found)
        return {
          ok: false,
          status: 422,
          code: "unknown_member",
          message: "no member has this name",
        };
      memberUserId = found.id;
    }
    if (memberUserId === null || !deps.isOfficeOwner(memberUserId))
      return {
        ok: false,
        status: 403,
        code: "member_not_allowed",
        message: "only an office owner answers a sudo request",
      };
    const answerId = memberUserId;
    return (async (): Promise<SudoRequestResult<{ requestId: string }>> => {
      const probe = await deps.probe();
      if (probe === "unavailable")
        return {
          ok: false,
          status: 409,
          code: "sudo_unavailable",
          message: "the office's account cannot use sudo on this box",
        };
      if (probe === "no_password_needed")
        return {
          ok: false,
          status: 409,
          code: "no_password_needed",
          message:
            "sudo runs without a password here: run the command yourself",
        };
      return guarded((): SudoRequestResult<{ requestId: string }> => {
        const tooMany: SudoRequestFailure = {
          ok: false,
          status: 429,
          code: "too_many_requests",
          message: `at most ${SUDO_REQUESTS_OPEN_MAX} open sudo requests per agent`,
        };
        if (
          openRequests().filter((e) => e.agentId === agentId).length >=
          SUDO_REQUESTS_OPEN_MAX
        )
          return tooMany;
        const requestId = randomUUID();
        const made = deps.asks.create({
          agentId,
          memberUserId: answerId,
          prompt: reason,
          sudo: { requestId, command, cwd },
        });
        if (!made.ok) return tooMany;
        return { ok: true, requestId };
      });
    })();
  }

  return {
    open: (
      agentId: string,
      body: unknown,
    ): Promise<SudoRequestResult<{ requestId: string }>> =>
      Promise.resolve(guarded(() => open(agentId, body))),

    // The owner's run. Every check and the lock come before the first
    // await, so a second run, a decline or the agent's withdraw waits for
    // sudo's answer.
    async run(
      userId: string | null,
      agentId: string,
      requestId: string,
      body: unknown,
      audience: AskAudienceDeps = deps.audience,
    ): Promise<SudoRequestResult<{ requestId: string }>> {
      const found = guarded(() =>
        answerable(userId, agentId, requestId, audience),
      );
      if (!found.ok) return found;
      const password =
        typeof body === "object" && body !== null
          ? (body as { password?: unknown }).password
          : undefined;
      if (
        typeof password !== "string" ||
        password === "" ||
        password.length > SUDO_PASSWORD_MAX ||
        /[\n\r\0]/.test(password)
      )
        return {
          ok: false,
          status: 400,
          code: "invalid_password",
          message: `password: one line of 1 to ${SUDO_PASSWORD_MAX} characters`,
        };
      if (busy.has(agentId)) return inProgress;
      busy.add(agentId);
      const { entry } = found;
      let start: SudoStart;
      try {
        start = await deps.start({
          command: entry.sudo.command,
          cwd: entry.sudo.cwd,
          password,
        });
      } catch {
        busy.delete(agentId);
        console.error("[sudo-requests] sudo could not be started");
        return {
          ok: false,
          status: 500,
          code: "run_failed",
          message: "sudo could not be started",
        };
      }
      if (start.kind === "auth_failed") {
        const count = (refusals.get(requestId) ?? 0) + 1;
        const attemptsLeft = Math.max(0, SUDO_WRONG_PASSWORD_MAX - count);
        if (attemptsLeft === 0) {
          refusals.delete(requestId);
          try {
            deps.asks.remove(entry.id, {
              outcome: "refused",
              byUserId: found.userId,
            });
          } catch {
            console.error("[sudo-requests] a refused request stayed open");
          }
          const line = msg("systemEntries.sudoRequest.lockedOut", {
            command: entry.sudo.command,
            attempts: String(SUDO_WRONG_PASSWORD_MAX),
          });
          report(
            agentId,
            requestId,
            "locked_out",
            line,
            found.userId,
            noticeOf(line),
          );
        } else refusals.set(requestId, count);
        busy.delete(agentId);
        return {
          ok: false,
          status: 422,
          code: "not_started",
          message: "sudo did not start the command",
          detail: { reason: start.reason, attemptsLeft },
        };
      }
      // Started: the row first, so a restart from here on tells the agent.
      refusals.delete(requestId);
      try {
        deps.runs.add({
          requestId,
          agentId,
          command: entry.sudo.command,
          startedAt: deps.now(),
          memberUserId: found.userId,
        });
      } catch {
        console.error("[sudo-requests] a run row could not be written");
      }
      try {
        deps.asks.remove(entry.id, { outcome: "ran", byUserId: found.userId });
      } catch {
        console.error("[sudo-requests] a started request stayed open");
      }
      report(
        agentId,
        requestId,
        "started",
        msg("systemEntries.sudoRequest.started", {
          command: entry.sudo.command,
        }),
        found.userId,
        null,
      );
      start.done.then(
        (result) => finish(entry, found.userId, result),
        () => finish(entry, found.userId, null),
      );
      return { ok: true, requestId };
    },

    decline(
      userId: string | null,
      agentId: string,
      requestId: string,
      audience: AskAudienceDeps = deps.audience,
    ): SudoRequestResult<{ requestId: string }> {
      return guarded((): SudoRequestResult<{ requestId: string }> => {
        const found = answerable(userId, agentId, requestId, audience);
        if (!found.ok) return found;
        if (busy.has(agentId)) return inProgress;
        try {
          deps.asks.remove(found.entry.id, {
            outcome: "declined",
            byUserId: found.userId,
          });
        } catch {
          return requestFailed;
        }
        refusals.delete(requestId);
        const line = msg("systemEntries.sudoRequest.declined", {
          command: found.entry.sudo.command,
        });
        report(
          agentId,
          requestId,
          "declined",
          line,
          found.userId,
          noticeOf(line),
        );
        return { ok: true, requestId };
      });
    },

    // Whether the agent's sudo request is held by a run: the agent's own
    // withdraw of the ask waits too (handlers/asks.ts).
    runInProgress: (agentId: string): boolean => busy.has(agentId),

    // At boot: a run still in the store was in progress when the server
    // stopped; its agent hears that the result is unknown.
    recover(): void {
      let rows: SudoRunRow[];
      try {
        rows = deps.runs.list();
      } catch {
        console.error("[sudo-requests] the run rows could not be read");
        return;
      }
      for (const row of rows) {
        report(
          row.agentId,
          row.requestId,
          "restarted",
          msg("systemEntries.sudoRequest.restarted", { command: row.command }),
          row.memberUserId,
          `[Isomux: the server restarted during the run of your sudo request; its result is unknown. The command: ${row.command}]`,
        );
        try {
          deps.runs.remove(row.requestId);
        } catch {
          console.error("[sudo-requests] a run row could not be removed");
        }
      }
    },
  };
}

const COMMAND_ERRORS: Record<SudoCommandError, string> = {
  missing: "command: one shell line, without sudo",
  too_long: `command: at most ${SUDO_COMMAND_MAX} characters`,
  leading_sudo: "command: leave out the leading sudo; the server adds it",
  forbidden_character:
    "command: one line, with no tabs, line breaks, control or invisible characters, and no spaces but U+0020",
};

export type SudoRequests = ReturnType<typeof createSudoRequests>;
