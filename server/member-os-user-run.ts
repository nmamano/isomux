// Run on the owner's Members page (internal-docs/member-os-user-design.md
// 2.1; Nil, 2026-11-16, ask 841e2d89): the server runs the member's root
// command itself through the sudo runner, with the password the owner types.
// Only on the installer's root install, where the office's account may use
// sudo, and never on Hosted; elsewhere the page shows the command to copy.
//
// The command is the root command's fixed path, the verb and the member id
// (checked against its pattern): nothing a member typed reaches it. Task
// e15a82e7: the owner's pick of the OS user adds --user <name> or
// --existing-user <name>, the name checked against the root command's
// pattern (which the root command checks again).

import type { MemberOsUserWire } from "../shared/contract-shapes.ts";
import type { UserRecord } from "../shared/types.ts";
import {
  MEMBER_USER_COMMAND_PATH,
  memberUserAttemptStage,
  noteMemberUserAttempt,
  clearMemberUserAttempt,
  type MemberUserSupport,
} from "./member-os-user-view.ts";
import { OS_USER_NAME_PATTERN } from "./member-os-users.ts";
import {
  INVALID_SUDO_PASSWORD,
  isSudoPassword,
  SUDO_WRONG_PASSWORD_MAX,
} from "./sudo-requests.ts";
import type {
  SudoProbe,
  SudoRunResult,
  SudoStart,
  SudoStartOptions,
} from "./sudo-runner.ts";

export type RunMode = MemberOsUserWire["run"];

// deploy/isomux-member-user.sh MOVE_VERB_LIMIT_S, plus 10 minutes for the
// steps around the move.
export const MEMBER_USER_RUN_TIMEOUT_MS = (10_800 + 600) * 1000;
// After SUDO_WRONG_PASSWORD_MAX wrong passwords, that member's runs are
// refused for this long.
export const MEMBER_USER_LOCK_MS = 15 * 60_000;
// The page reads the run mode every 3 s while a run can change: the probe
// starts sudo twice, so its answer is kept this long.
const PROBE_KEEP_MS = 5 * 60_000;
// The failed attempt's message: the end of the command's own output.
const TAIL_MAX = 500;
const MEMBER_ID = /^[0-9a-f]{8}$/;

export function runMode(
  support: MemberUserSupport,
  hosted: boolean,
  probe: SudoProbe,
): RunMode {
  // A container's command runs on its host; Hosted gives its owner root SSH.
  if (!support.ok || support.shape !== "installer" || hosted) return null;
  if (probe === "available") return "password";
  if (probe === "no_password_needed") return "no_password";
  return null;
}

export interface MemberOsUserRunDeps {
  support: () => MemberUserSupport;
  hosted: () => boolean;
  probe: () => Promise<SudoProbe>;
  start: (opts: SudoStartOptions) => Promise<SudoStart>;
  now: () => number;
  // Whether the office's place job of a member who came with an office move
  // runs (member-user-admin.ts memberPlaceRunning): it goes on after the run
  // ends.
  placeRunning?: (userId: string) => boolean;
  // Task 4088f164: after each end of a run, as it may be the change a
  // member-os-user ask waits for.
  ended?: (userId: string) => void;
}

export type MemberOsUserRunResult =
  | { ok: true; action: "enable" | "disable" }
  | {
      ok: false;
      status: 400 | 409 | 422 | 429 | 500;
      code: string;
      message: string;
      detail?: Record<string, unknown>;
    };

export interface MemberOsUserRun {
  // How the page can run the command (the GET's run field).
  mode(): Promise<RunMode>;
  run(
    user: Pick<UserRecord, "id" | "role">,
    body: unknown,
  ): Promise<MemberOsUserRunResult>;
}

// The last probe answer, and the probe in flight: one for many reads.
let probeCache: { answer: SudoProbe; at: number } | null = null;
let probeInFlight: Promise<SudoProbe> | null = null;

// Tests: forget the cached sudo probe.
export function resetRunModeCache(): void {
  probeCache = null;
  probeInFlight = null;
}

function cachedProbe(deps: MemberOsUserRunDeps): Promise<SudoProbe> {
  if (probeCache && deps.now() - probeCache.at < PROBE_KEEP_MS)
    return Promise.resolve(probeCache.answer);
  if (probeInFlight) return probeInFlight;
  const inFlight = deps.probe().then(
    (answer) => {
      if (probeInFlight === inFlight) {
        probeCache = { answer, at: deps.now() };
        probeInFlight = null;
      }
      return answer;
    },
    () => {
      if (probeInFlight === inFlight) probeInFlight = null;
      return "unavailable" as const;
    },
  );
  probeInFlight = inFlight;
  return inFlight;
}

// The last non-empty lines of the command's output, at most TAIL_MAX
// characters, starting at a whole line where it can.
export function outputTail(output: string): string {
  const text = output.replace(/\s+$/, "");
  if (text.length <= TAIL_MAX) return text.replace(/^\s+/, "");
  const cut = text.slice(-TAIL_MAX);
  const line = cut.indexOf("\n");
  return (
    line >= 0 && line < cut.length - 1 ? cut.slice(line + 1) : cut
  ).replace(/^\s+/, "");
}

const refuse = (
  status: 400 | 409 | 422 | 429 | 500,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): MemberOsUserRunResult => ({
  ok: false,
  status,
  code,
  message,
  ...(detail ? { detail } : {}),
});

// The tail of the command for the owner's pick: "" (the default user),
// " --user <name>" (a new user) or " --existing-user <name>". Enable only.
function osUserPick(
  body: Record<string, unknown>,
  action: "enable" | "disable",
): { ok: true; tail: string } | { ok: false; refusal: MemberOsUserRunResult } {
  const { osUser, existing } = body;
  const bad = (message: string) => ({
    ok: false as const,
    refusal: refuse(400, "invalid_os_user", message),
  });
  if (osUser === undefined && existing === undefined)
    return { ok: true, tail: "" };
  if (action !== "enable") return bad("osUser and existing are for enable");
  if (existing !== undefined && typeof existing !== "boolean")
    return bad("existing is true or false");
  if (typeof osUser !== "string" || !OS_USER_NAME_PATTERN.test(osUser))
    return bad("osUser is not a user name");
  return {
    ok: true,
    tail: ` ${existing ? "--existing-user" : "--user"} ${osUser}`,
  };
}

export function createMemberOsUserRun(
  deps: MemberOsUserRunDeps,
): MemberOsUserRun {
  // Members with a run between its first check and its end.
  const busy = new Set<string>();
  // Wrong passwords in a row, and the end of a lock, by member id.
  const wrong = new Map<string, number>();
  const lockedUntil = new Map<string, number>();

  const mode = async (): Promise<RunMode> => {
    const support = deps.support();
    if (runMode(support, deps.hosted(), "available") === null) return null;
    return runMode(support, deps.hosted(), await cachedProbe(deps));
  };

  // The end: exit 0 clears what the verbs left; another end fails the
  // attempt with the output's tail, unless a verb failed it after the start
  // (the start wrote "running", so a "failed" now is the verb's).
  const settle = (
    id: string,
    action: "enable" | "disable",
    result: SudoRunResult | null,
  ) => {
    busy.delete(id);
    if (result && result.exitCode === 0 && !result.timedOut) {
      clearMemberUserAttempt(id);
      return;
    }
    // Slice 5c-3: the time limit cut the command while the office still
    // places the home of a member who came with a move. The move did not
    // fail: the page keeps her moved-in line, and the next enable collects
    // the job's outcome.
    if (result?.timedOut && deps.placeRunning?.(id)) {
      clearMemberUserAttempt(id);
      return;
    }
    if (memberUserAttemptStage(id) === "failed") return;
    const tail = result ? outputTail(result.output) : "";
    noteMemberUserAttempt(id, action, "failed", tail || undefined, deps.now());
  };
  // Then the office hears of the end (task 4088f164).
  const finish = (
    id: string,
    action: "enable" | "disable",
    result: SudoRunResult | null,
  ) => {
    try {
      settle(id, action, result);
    } finally {
      deps.ended?.(id);
    }
  };

  return {
    mode,
    async run(user, body) {
      const action =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as { action?: unknown }).action
          : undefined;
      if (action !== "enable" && action !== "disable")
        return refuse(400, "invalid_action", 'action: "enable" or "disable"');
      const pick = osUserPick(body as Record<string, unknown>, action);
      if (!pick.ok) return pick.refusal;
      if (!MEMBER_ID.test(user.id))
        return refuse(409, "run_unavailable", "Run is not available here");
      const id = user.id;
      const until = lockedUntil.get(id);
      if (until !== undefined) {
        if (deps.now() < until)
          return refuse(
            429,
            "locked_out",
            `${SUDO_WRONG_PASSWORD_MAX} wrong passwords; try again later`,
            { retryAfterS: Math.ceil((until - deps.now()) / 1000) },
          );
        lockedUntil.delete(id);
      }
      if (busy.has(id))
        return refuse(
          409,
          "run_in_progress",
          "a run for this member is in progress",
        );
      // Held from here, before the first await, until a refusal or the end.
      busy.add(id);
      let started = false;
      try {
        const how = await mode();
        if (how === null)
          return refuse(409, "run_unavailable", "Run is not available here");
        const typed = (body as { password?: unknown }).password;
        if (how === "password" && !isSudoPassword(typed))
          return INVALID_SUDO_PASSWORD;
        let start: SudoStart;
        try {
          start = await deps.start({
            command: `${MEMBER_USER_COMMAND_PATH} ${action} ${id}${pick.tail}`,
            cwd: "/",
            // Where sudo needs none, no typed text goes to its stdin.
            password: how === "password" ? (typed as string) : "",
            home: "/root",
            timeoutMs: MEMBER_USER_RUN_TIMEOUT_MS,
          });
        } catch {
          console.error("[member-os-user-run] sudo could not be started");
          return refuse(500, "run_failed", "sudo could not be started");
        }
        if (start.kind === "auth_failed") {
          const count = (wrong.get(id) ?? 0) + 1;
          const attemptsLeft = Math.max(0, SUDO_WRONG_PASSWORD_MAX - count);
          if (attemptsLeft === 0) {
            wrong.delete(id);
            lockedUntil.set(id, deps.now() + MEMBER_USER_LOCK_MS);
          } else wrong.set(id, count);
          return refuse(422, "not_started", "sudo did not start the command", {
            reason: start.reason,
            attemptsLeft,
          });
        }
        started = true;
        wrong.delete(id);
        noteMemberUserAttempt(id, action, "running", undefined, deps.now());
        start.done.then(
          (result) => finish(id, action, result),
          () => finish(id, action, null),
        );
        return { ok: true, action };
      } finally {
        if (!started) busy.delete(id);
      }
    },
  };
}
