// The owner's view of a member's own OS user (Settings > Members,
// internal-docs/member-os-user-design.md 2.1): the state from the records,
// what the root command last did for them, and the command for this office's
// shape. The command holds only the member id, checked against its pattern:
// nothing a member typed (their name) reaches a line an owner runs as root.

import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";

import type {
  MemberOsUserAttemptWire,
  MemberOsUserWire,
  MemberUserUnsupported,
} from "../shared/contract-shapes.ts";
import type { UserRecord } from "../shared/types.ts";
import { memberHostConnected, memberIsMoving } from "./member-hosts.ts";
import { memberOsUserState } from "./member-os-users.ts";
import { readUpdateConf, type UpdateConfRead } from "./update-conf.ts";

// The root command, as the installer and the image install it
// (deploy/install.sh MEMBER_USER_PATH, deploy/container/Dockerfile).
export const MEMBER_USER_COMMAND_PATH = "/usr/local/sbin/isomux-member-user";
// The container's compose folder (deploy/install.sh CONTAINER_DIR).
const CONTAINER_DIR = "/opt/isomux-container";
const MEMBER_ID = /^[0-9a-f]{8}$/;
// Docker's default hostname: the short container id, which docker exec takes.
const CONTAINER_ID = /^[0-9a-f]{12}$/;
// In the command of a container with another hostname: the owner puts its
// name in its place.
export const CONTAINER_PLACEHOLDER = "CONTAINER";

// Between prepare and go-on the root command makes the user and starts its
// runner: a few seconds. Past this, it stopped.
export const PREPARED_STALE_MS = 10 * 60_000;

// Where the root command runs: the installer's root install (Hosted too),
// the installer's container, or another Docker container. Elsewhere it
// cannot run, and the reason says why.
export type MemberUserSupport =
  | { ok: true; shape: "installer" | "container" }
  | { ok: true; shape: "docker"; container: string | null }
  | { ok: false; reason: MemberUserUnsupported };

export interface MemberUserSupportInput {
  env: { [key: string]: string | undefined };
  exists: (path: string) => boolean;
  platform: string;
  hostname: string;
  conf: UpdateConfRead;
}

export function memberUserSupport(
  input: MemberUserSupportInput = {
    env: process.env,
    exists: existsSync,
    platform: process.platform,
    hostname: osHostname(),
    conf: readUpdateConf(),
  },
): MemberUserSupport {
  const { env, exists, platform, hostname, conf } = input;
  // A read error counts as no file.
  const values = conf.state === "parsed" ? conf.values : null;
  if (platform !== "linux") return { ok: false, reason: "not_linux" };
  // The kubelet sets it in every pod, also with enableServiceLinks: false
  // (kubernetes pkg/kubelet/kubelet_pods.go, getServiceEnvVarMap). The pod
  // runs the image's entrypoint, so it also has the container's supervisor,
  // and it never runs as root (deploy/kubernetes/deployment.yaml).
  if (env.KUBERNETES_SERVICE_HOST) return { ok: false, reason: "kubernetes" };
  if (env.RENDER === "true") return { ok: false, reason: "render" };
  if (env.ISOMUX_APP_SUPERVISOR === "container") {
    if (values?.DEPLOYMENT_KIND === "container")
      return { ok: true, shape: "container" };
    return {
      ok: true,
      shape: "docker",
      container: CONTAINER_ID.test(hostname) ? hostname : null,
    };
  }
  // A from-source run or a user-level install has no system install.
  if (values?.SERVICE_KIND !== "system")
    return { ok: false, reason: "no_system_install" };
  if (!exists(MEMBER_USER_COMMAND_PATH))
    return { ok: false, reason: "no_command" };
  return { ok: true, shape: "installer" };
}

export function memberUserCommands(
  memberId: string,
  support: MemberUserSupport,
): { enable: string; disable: string } | null {
  if (!support.ok || !MEMBER_ID.test(memberId)) return null;
  const line = (verb: "enable" | "disable") => {
    const tail = `${MEMBER_USER_COMMAND_PATH} ${verb} ${memberId}`;
    switch (support.shape) {
      case "container":
        return `cd ${CONTAINER_DIR} && sudo docker compose --env-file office.env exec -u 0 office ${tail}`;
      case "docker":
        return `sudo docker exec -u 0 ${support.container ?? CONTAINER_PLACEHOLDER} ${tail}`;
      case "installer":
        return `sudo ${tail}`;
    }
  };
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

// The stage of what the root command last did for a member, if anything.
export function memberUserAttemptStage(
  userId: string,
): Attempt["stage"] | undefined {
  return attempts.get(userId)?.stage;
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
    support: MemberUserSupport;
    // How the page can run the command itself (member-os-user-run.ts).
    run?: MemberOsUserWire["run"];
    now?: number;
  },
): MemberOsUserWire {
  const now = opts.now ?? Date.now();
  const { support } = opts;
  const record = memberOsUserState(user.id);
  const attempt = attemptWire(attempts.get(user.id), now);
  // Slice 5c-3: a member who came with an office move is not ready until the
  // enable command places her home, also while its job runs. The office
  // refuses a plain disable of her: hers gives up the moved home.
  const movedIn = record.kind === "isolated" && record.movedIn !== undefined;
  const plain =
    user.role === "owner" ? null : memberUserCommands(user.id, support);
  const commands =
    plain && movedIn
      ? { enable: plain.enable, disable: `${plain.disable} --keep-files` }
      : plain;
  const common = {
    support: support.ok
      ? { ok: true as const }
      : { ok: false as const, reason: support.reason },
    commands,
    ...(commands &&
    support.ok &&
    support.shape === "docker" &&
    !support.container
      ? { commandHint: "container_name" as const }
      : {}),
    run: commands ? (opts.run ?? null) : null,
    ...(attempt ? { attempt } : {}),
  };
  if (record.kind === "none") return { state: "off", ...common };
  if (record.kind === "broken")
    return { state: "broken", reason: record.reason, ...common };
  const osUser = { name: record.osUser.name, uid: record.osUser.uid };
  // A move that a restart cut stays not ready until enable runs again.
  const state = movedIn
    ? "not_ready"
    : memberIsMoving(user.id)
      ? "moving"
      : memberHostConnected(user.id) && !record.unfinished
        ? "on"
        : "not_ready";
  return {
    state,
    osUser,
    ...(movedIn ? { movedIn: true as const } : {}),
    ...(record.unfinished && state === "not_ready"
      ? { unfinished: true as const }
      : {}),
    ...common,
  };
}
