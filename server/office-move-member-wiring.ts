// The production wiring of the homes of members with their own OS user at
// an office move (task 78733adf, slice 5c-1): checkMoveMembers' deps, her
// runner's streams and her units through her runner. server/isomux-office.ts
// calls these; the logic and its tests are in office-move-members.ts.

import { spawnSync } from "node:child_process";
import { readRunnerInfo } from "./agent-runner/client.ts";
import {
  CALL_BOUND_MS,
  runnerSyncCall,
  type SyncCall,
} from "./member-app-host.ts";
import { memberRunnerSocketPath } from "./member-hosts.ts";
import { memberOsUserRecordsForMove } from "./member-os-users.ts";
import { runtimeSource } from "./member-runtime.ts";
import { memberUserCallRunning } from "./member-user-admin.ts";
import {
  checkMoveMembers,
  runnerMemberHomeSource,
  type MemberHomeSource,
  type MoveMember,
  type MoveMembersCheck,
} from "./office-move-members.ts";
import { listAgentUnits, type UnitRunner } from "./office-move-units.ts";
import { readPeerCredentials } from "./unix-socket-server.ts";

const readPeerUid = (fd: number) => readPeerCredentials(fd)?.uid ?? null;

/** passwd's uid and home of `name`, or null. */
export function passwdEntry(
  name: string,
): { uid: number; home: string } | null {
  const result = spawnSync("getent", ["passwd", "--", name], {
    encoding: "utf8",
    timeout: CALL_BOUND_MS,
  });
  if (result.status !== 0) return null;
  const fields = result.stdout.trim().split(":");
  if (fields.length < 7 || fields[0] !== name) return null;
  const uid = Number(fields[2]);
  if (!Number.isSafeInteger(uid)) return null;
  return { uid, home: fields[5] ?? "" };
}

// The PATH her systemctl runs with: the system folders only.
const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const UNIT_PROGRAMS = new Set(["systemctl", "systemd-run"]);

/** Runs systemctl or systemd-run as her, through her runner (Q5). A runner
 *  that does not answer gives exit 127. */
export function memberUnitRunner(
  member: Pick<MoveMember, "osUser" | "uid" | "home">,
  call: SyncCall = runnerSyncCall(
    memberRunnerSocketPath(member.osUser),
    member.uid,
  ),
): UnitRunner {
  const env = {
    PATH: SYSTEM_PATH,
    HOME: member.home,
    XDG_RUNTIME_DIR: `/run/user/${member.uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${member.uid}/bus`,
  };
  return (argv) => {
    if (!UNIT_PROGRAMS.has(argv[0] ?? ""))
      return { code: 127, stdout: "", stderr: `${argv[0]} is not allowed` };
    const answer = call(
      { op: "spawn", argv, cwd: member.home, fullEnv: env, stderr: "pipe" },
      undefined,
      CALL_BOUND_MS,
    );
    if (!answer)
      return {
        code: 127,
        stdout: "",
        stderr: "the member's runner did not answer",
      };
    const stdout = answer.stdout.toString("utf8");
    const stderr = answer.stderr.toString("utf8");
    if (answer.control.type === "exit")
      return { code: answer.control.code ?? 1, stdout, stderr };
    return {
      code: 127,
      stdout: "",
      stderr:
        answer.control.type === "error"
          ? `${answer.control.code} ${answer.control.message}`
          : "the runner sent no exit",
    };
  };
}

/** The check of the preflight and the lock, as production reads it. */
export function moveMembersCheck(input: {
  stateRoot: string;
  officeHome: string;
  appPrefix: string;
  nameOf(userId: string): string | null;
}): Promise<MoveMembersCheck> {
  return checkMoveMembers({
    records: () =>
      memberOsUserRecordsForMove(input.stateRoot, (id) => input.nameOf(id)),
    passwd: passwdEntry,
    busy: memberUserCallRunning,
    info: (os) =>
      readRunnerInfo(
        {
          path: memberRunnerSocketPath(os.name),
          peer: { uid: os.uid, read: readPeerUid },
        },
        CALL_BOUND_MS,
      ),
    expectedHash: async () => (await runtimeSource()).hash,
    listUnits: (member) =>
      listAgentUnits(memberUnitRunner(member), {
        home: member.home,
        appPrefix: input.appPrefix,
        officeUnit: null,
        uid: member.uid,
      }),
    officeHome: input.officeHome,
    stateRoot: input.stateRoot,
  });
}

/** Her runner's streams, on her recorded socket. */
export const productionMemberHomeSource: MemberHomeSource =
  runnerMemberHomeSource({
    socketPath: memberRunnerSocketPath,
    readPeerUid,
  });
