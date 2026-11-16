// The owner's view of a member's own OS user (Settings > Members,
// internal-docs/member-os-user-design.md 2.1): the state from the records,
// what the root command last did for them, and the command for this office's
// shape. The command holds only the member id, checked against its pattern:
// nothing a member typed (their name) reaches a line an owner runs as root.

import { existsSync } from "node:fs";

import type {
  MemberOsUserAttemptWire,
  MemberOsUserWire,
} from "../shared/contract-shapes.ts";
import type { UserRecord } from "../shared/types.ts";
import { memberHostConnected, memberIsMoving } from "./member-hosts.ts";
import { memberOsUserState } from "./member-os-users.ts";

// The root command, as the installer and the image install it
// (deploy/install.sh MEMBER_USER_PATH, deploy/container/Dockerfile).
export const MEMBER_USER_COMMAND_PATH = "/usr/local/sbin/isomux-member-user";
// The container's compose folder (deploy/install.sh CONTAINER_DIR).
const CONTAINER_DIR = "/opt/isomux-container";
const MEMBER_ID = /^[0-9a-f]{8}$/;

// Between prepare and go-on the root command makes the user and starts its
// runner: a few seconds. Past this, it stopped.
export const PREPARED_STALE_MS = 10 * 60_000;

export type MemberUserShape = "installer" | "container";

// Where the root command runs: the installer's root install (Hosted too) or
// the container; null where it cannot (a user-level install, macOS).
export function memberUserShape(
  env: { [key: string]: string | undefined } = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: string = process.platform,
): MemberUserShape | null {
  if (platform !== "linux") return null;
  if (env.ISOMUX_APP_SUPERVISOR === "container") return "container";
  return exists(MEMBER_USER_COMMAND_PATH) ? "installer" : null;
}

export function memberUserCommands(
  memberId: string,
  shape: MemberUserShape | null,
): { enable: string; disable: string } | null {
  if (shape === null || !MEMBER_ID.test(memberId)) return null;
  const line = (verb: "enable" | "disable") =>
    shape === "container"
      ? `cd ${CONTAINER_DIR} && sudo docker compose --env-file office.env exec -u 0 office ${MEMBER_USER_COMMAND_PATH} ${verb} ${memberId}`
      : `sudo ${MEMBER_USER_COMMAND_PATH} ${verb} ${memberId}`;
  return { enable: line("enable"), disable: line("disable") };
}

// What the root command last did for each member, by member id. In memory:
// a restart forgets it, and the page then shows the records only.
interface Attempt {
  action: "enable" | "disable";
  stage: "running" | "prepared" | "failed";
  at: number;
  message?: string;
}
const attempts = new Map<string, Attempt>();

export function noteMemberUserAttempt(
  userId: string,
  action: Attempt["action"],
  stage: Attempt["stage"],
  message?: string,
  now: number = Date.now(),
): void {
  attempts.set(userId, {
    action,
    stage,
    at: now,
    ...(message ? { message } : {}),
  });
}

export function clearMemberUserAttempt(userId: string): void {
  attempts.delete(userId);
}

// Tests.
export function resetMemberUserAttempts(): void {
  attempts.clear();
}

function attemptWire(
  attempt: Attempt | undefined,
  now: number,
): MemberOsUserAttemptWire | undefined {
  if (!attempt) return undefined;
  const base = { action: attempt.action, at: attempt.at };
  if (attempt.stage === "failed")
    return {
      ...base,
      status: "failed",
      ...(attempt.message ? { message: attempt.message } : {}),
    };
  if (attempt.stage === "prepared" && now - attempt.at > PREPARED_STALE_MS)
    return { ...base, status: "stopped" };
  return { ...base, status: "running" };
}

export function memberOsUserView(
  user: Pick<UserRecord, "id" | "role">,
  opts: {
    gate: boolean;
    shape?: MemberUserShape | null;
    now?: number;
  },
): MemberOsUserWire {
  const now = opts.now ?? Date.now();
  const shape = opts.shape === undefined ? memberUserShape() : opts.shape;
  const record = memberOsUserState(user.id);
  const attempt = attemptWire(attempts.get(user.id), now);
  const common = {
    gate: opts.gate,
    commands: user.role === "owner" ? null : memberUserCommands(user.id, shape),
    run: null,
    ...(attempt ? { attempt } : {}),
  };
  if (record.kind === "none") return { state: "off", ...common };
  if (record.kind === "broken")
    return { state: "broken", reason: record.reason, ...common };
  const osUser = { name: record.osUser.name, uid: record.osUser.uid };
  const state = memberIsMoving(user.id)
    ? "moving"
    : memberHostConnected(user.id)
      ? "on"
      : "not_ready";
  return { state, osUser, ...common };
}
