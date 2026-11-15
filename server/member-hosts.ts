// The agent host of each member (internal-docs/member-os-user-design.md,
// section 1.1). A member with no OS user, and an agent with no manager, use the
// office host (server/agent-host.ts). A member with an OS user
// (server/member-os-users.ts) uses the RunnerAgentHost of their runner, which
// runs as that user; until it is connected and its checks pass, a not-ready
// host that fails every operation. hostFor never gives such a member the
// office host.

import { spawn, spawnSync } from "child_process";
import { realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  failedAgentChild,
  failedAgentProcess,
  memberEnvOwner,
  officeAgentHost,
  type AgentFs,
  type AgentHost,
} from "./agent-host.ts";
import { RunnerAgentHost } from "./agent-runner/client.ts";
import {
  installMemberRuntime,
  memberSharePath,
  pruneMemberRuntime,
  runtimeSource,
  writeMemberCaBundle,
} from "./member-runtime.ts";
import { removeMemberShareFiles } from "./member-share-files.ts";
import { checkMemberShare, type ShareVerdict } from "./member-share-check.ts";
import { STATE_ROOT } from "./config.ts";
import {
  memberOsUserIds,
  memberOsUserState,
  type MemberOsUser,
} from "./member-os-users.ts";
import { CODE_ROOT, readAgentIdentity } from "./split/start.ts";
import {
  agentAccess,
  privateChecks,
  realFs,
  type CheckFailure,
  type CheckId,
  type FsProbe,
} from "./split/trusted-checks.ts";
import { readPeerCredentials } from "./unix-socket-server.ts";

export const MEMBER_HOST_NOT_READY = "MEMBER_HOST_NOT_READY";
// What home() and bunPath() of a not-ready host return: a path that does not
// exist, never an office value. username() is "".
export const NOT_READY_PATH = "/nonexistent/isomux-member-host-not-ready";

const DEFAULT_RUNNER_ROOT = "/run";
let runnerRoot = DEFAULT_RUNNER_ROOT;

// The member runner's socket: <root>/isomux-runner-<name>/runner.sock, where
// the unit's RuntimeDirectory puts it. Root is /run; tests set another.
export function memberRunnerSocketPath(osUserName: string): string {
  return join(runnerRoot, `isomux-runner-${osUserName}`, "runner.sock");
}

export function setMemberRunnerRoot(root: string | null): void {
  runnerRoot = root ?? DEFAULT_RUNNER_ROOT;
}

interface Connected {
  osUser: MemberOsUser;
  host: AgentHost;
  // The runtime its runner runs.
  runtimeHash: string;
}

const connected = new Map<string, Connected>();
const refusals = new Map<string, string>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
// Members whose files move into their agent space (go-on,
// server/member-move.ts): their host keeps its paths and starts nothing.
const moving = new Set<string>();
const MOVING_REASON = "the member's files are moving";
let connectedHook: ((userId: string) => void) | null = null;
// Called after each connect of a member who is not moving: the office's
// own work for a connected member, such as their skill lists and folders.
const connectedListeners = new Set<(userId: string) => void>();

// Adds a listener; the result removes it.
export function onMemberConnected(
  listener: (userId: string) => void,
): () => void {
  connectedListeners.add(listener);
  return () => connectedListeners.delete(listener);
}

// The secret proxy's side of a member connect (secret-proxy/runtime.ts),
// set at boot: the tie of the member's uid, and the text of the CA bundle.
export interface MemberSecretHooks {
  tie(uid: number): Promise<boolean>;
  caBundle(): string | null;
}
let secretHooks: MemberSecretHooks | null = null;

export function setMemberSecretHooks(hooks: MemberSecretHooks | null): void {
  secretHooks = hooks;
}

// The host for the agents of `userId`.
export function hostFor(userId: string | null | undefined): AgentHost {
  const state = memberOsUserState(userId);
  if (state.kind === "none") return officeAgentHost();
  if (state.kind === "broken") return createNotReadyHost(userId!, state.reason);
  const entry = connected.get(userId!);
  if (
    entry &&
    entry.osUser.name === state.osUser.name &&
    entry.osUser.uid === state.osUser.uid
  )
    return moving.has(userId!)
      ? createMovingHost(entry.host, userId!)
      : entry.host;
  return createNotReadyHost(
    userId!,
    moving.has(userId!) ? MOVING_REASON : "the member's OS user is not ready",
  );
}

// While a member's files move: hostFor answers a host with their paths that
// starts nothing and touches no file, and only the move gets the runner
// (memberMoveHost).
export function markMemberMoving(userId: string): void {
  moving.add(userId);
}

export function clearMemberMoving(userId: string): void {
  moving.delete(userId);
}

// The connected runner host of a member whose files move; undefined when
// they are not moving or not connected.
export function memberMoveHost(userId: string): AgentHost | undefined {
  if (!moving.has(userId)) return undefined;
  const state = memberOsUserState(userId);
  const entry = connected.get(userId);
  if (
    state.kind !== "isolated" ||
    !entry ||
    entry.osUser.name !== state.osUser.name ||
    entry.osUser.uid !== state.osUser.uid
  )
    return undefined;
  return entry.host;
}

// The member's runner is connected for their current record.
export function memberHostConnected(userId: string): boolean {
  const state = memberOsUserState(userId);
  const entry = connected.get(userId);
  return (
    state.kind === "isolated" &&
    !!entry &&
    entry.osUser.name === state.osUser.name &&
    entry.osUser.uid === state.osUser.uid
  );
}

// Called after each connect of a member that is not moving (the check for
// a move that did not finish, server/member-move.ts). Null removes it.
export function setMemberConnectedHook(
  hook: ((userId: string) => void) | null,
): void {
  connectedHook = hook;
}

function createMovingHost(host: AgentHost, userId: string): AgentHost {
  const stopped = createNotReadyHost(userId, MOVING_REASON);
  return {
    ...stopped,
    baseEnv: () => host.baseEnv(),
    home: () => host.home(),
    agentRoot: () => host.agentRoot(),
    username: () => host.username(),
    bunPath: () => host.bunPath(),
    claudeBin: () => host.claudeBin(),
    codexLauncher: () => host.codexLauncher(),
    openCodeBin: () => host.openCodeBin(),
  };
}

function notReadyError(reason: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`the member's OS user is not ready: ${reason}`),
    { code: MEMBER_HOST_NOT_READY },
  );
}

// Every operation fails: spawnChild emits "error" with code
// MEMBER_HOST_NOT_READY, spawnPipe's exited resolves non-zero, run, fs and
// runEntry reject, isomuxDiff returns git_error. baseEnv() is {}.
export function createNotReadyHost(userId: string, reason: string): AgentHost {
  const reject = () => Promise.reject(notReadyError(reason));
  const fs: AgentFs = {
    readText: reject,
    stat: reject,
    readBytes: reject,
    writeText: reject,
    mkdir: reject,
    rm: reject,
    exists: reject,
    chmod: reject,
    enter: reject,
  };
  const host: AgentHost = {
    kind: "runner",
    member: userId,
    baseEnv: () => ({}),
    home: () => NOT_READY_PATH,
    agentRoot: () => NOT_READY_PATH,
    username: () => "",
    bunPath: () => NOT_READY_PATH,
    spawnPipe: () => failedAgentProcess(),
    spawnChild: () => failedAgentChild(notReadyError(reason)),
    run: reject,
    fs,
    isomuxDiff: async (req) => ({
      kind: "git_error",
      cwd: req.dir ?? req.agentCwd,
      message: notReadyError(reason).message,
    }),
    runEntry: reject,
    claudeBin: () => NOT_READY_PATH,
    codexLauncher: () => NOT_READY_PATH,
    openCodeBin: () => NOT_READY_PATH,
    ptySidecarArgv: () => [NOT_READY_PATH],
    openCodeHelperArgv: () => [NOT_READY_PATH],
  };
  return host;
}

export interface MemberCheckInput {
  officeUid: number;
  // The office user's groups (process.getgroups()).
  officeGroups: number[];
  member: { uid: number; gid: number; groups: number[] };
  // The gids of sudo, wheel, admin, adm and docker that exist on this box.
  privilegedGroups: number[];
  officeHome: string;
  stateRoot: string;
  codeRoot: string;
  fs?: FsProbe;
  // False skips the code-tree walk below codeRoot (its ancestors are still
  // checked): the connect walks the tree once per member identity, in a child
  // process (memberCodeTreeChecks).
  walkCode?: boolean;
}

const SEARCH = 1;

// Design section 1.2, the part the office user can make: the member's uid,
// its groups, no effective search on the office home and no effective write
// on STATE_ROOT, the code tree and their ancestors. "Cannot become root" is
// the root command's (slice 1b).
export function memberTrustedChecks(input: MemberCheckInput): CheckFailure[] {
  const fs = input.fs ?? realFs;
  const { member, officeUid } = input;
  const failures: CheckFailure[] = [];
  const fail = (check: CheckId, detail: string, path?: string) =>
    failures.push({ check, path, detail });
  const groups = [member.gid, ...member.groups];
  if (member.uid === 0) fail("agent-not-root", "the member's OS user is root");
  if (member.uid === officeUid)
    fail("agent-not-server", "the member's OS user is the office user");
  const shared = groups.filter((gid) => input.officeGroups.includes(gid));
  if (shared.length > 0)
    fail(
      "server-group-private",
      `the member's OS user is in the office user's group ${shared[0]}`,
    );
  const privileged = groups.filter((gid) =>
    input.privilegedGroups.includes(gid),
  );
  if (privileged.length > 0)
    fail(
      "member-privileged-group",
      `the member's OS user is in the privileged group ${privileged[0]}`,
    );
  if (failures.length > 0) return failures;

  const { facts, acl, resolvePrivate, walkPrivate } = privateChecks(
    fs,
    officeUid,
    member,
    fail,
  );
  // The office home: no search, so nothing below it is reachable by name.
  const home = resolvePrivate(input.officeHome);
  const homeFacts = home ? facts(home) : null;
  if (home && homeFacts) {
    const access = acl(home, "access");
    if (access.ok && agentAccess(homeFacts, access.entries, member) & SEARCH)
      fail(
        "office-home-closed",
        `the member's OS user can search it; run chmod o-x ${home} and remove any group or ACL grant`,
        home,
      );
  }
  // The state root: private and closed, also when it is outside the home.
  const state = resolvePrivate(input.stateRoot);
  const stateFacts = state ? facts(state) : null;
  if (state && stateFacts) {
    const access = acl(state, "access");
    if (access.ok && agentAccess(stateFacts, access.entries, member) !== 0)
      fail(
        "state-root-closed",
        "the member's OS user can read, write or search it",
        state,
      );
  }
  if (input.walkCode === false) resolvePrivate(input.codeRoot);
  else walkPrivate(input.codeRoot, Infinity, new Map());
  return failures;
}

// The whole code walk of the member checks, in a child process: it takes
// seconds on a full install (12.8 s for 53k entries, measured 2026-11-14) and
// must not hold the event loop. The verdict is kept per member identity for
// the life of this process: the code tree changes only with an update, which
// restarts the server. A child that fails is not kept, and fails closed.
const codeTreeVerdicts = new Map<string, Promise<CheckFailure[]>>();
const CODE_CHECK_CHILD = join(import.meta.dir, "member-code-check.ts");

// The child's answer. `kept`: false when the child gave no verdict (it could
// not start, timed out, crashed or answered no list); the failure then fails
// closed for this connect only.
interface CodeCheckAnswer {
  failures: CheckFailure[];
  kept: boolean;
}

function runCodeCheckChild(input: MemberCheckInput): Promise<CodeCheckAnswer> {
  return new Promise((resolve) => {
    const { command, timeoutMs } = deps.codeCheck;
    let settled = false;
    const settle = (answer: CodeCheckAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const failed = (detail: string) =>
      settle({
        failures: [
          {
            check: "missing",
            path: input.codeRoot,
            detail: `the code check gave no verdict: ${detail}`,
          },
        ],
        kept: false,
      });
    let child: ReturnType<typeof spawn> | null = null;
    const timer = setTimeout(() => {
      if (child?.pid !== undefined)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      failed(`no answer within ${timeoutMs} ms`);
    }, timeoutMs);
    timer.unref?.();
    try {
      // detached: the walk leads its own group, so a time-out ends all of it.
      child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      failed((error as Error).message);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin!.on("error", () => {});
    child.once("error", (error) => failed(error.message));
    child.once("close", (code) => {
      if (code !== 0)
        return failed(`exit ${code}: ${Buffer.concat(err).toString().trim()}`);
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString()) as unknown;
        if (!Array.isArray(parsed)) throw new Error("not a list");
        settle({ failures: parsed as CheckFailure[], kept: true });
      } catch (error) {
        failed(`no list: ${(error as Error).message}`);
      }
    });
    child.stdin!.end(
      JSON.stringify({
        officeUid: input.officeUid,
        member: input.member,
        codeRoot: input.codeRoot,
      }),
    );
  });
}

function codeVerdictKey(
  member: { uid: number; gid: number; groups: number[] },
  codeRoot: string,
): string {
  return [
    member.uid,
    member.gid,
    [...member.groups].sort((a, b) => a - b).join(","),
    codeRoot,
  ].join(":");
}

// Forget every kept code verdict of the identity with this uid (a go-on: the
// user may be new, or its groups changed since the verdict).
export function forgetMemberCodeVerdicts(uid: number): void {
  for (const key of codeTreeVerdicts.keys())
    if (key.startsWith(`${uid}:`)) codeTreeVerdicts.delete(key);
}

export function memberCodeTreeChecks(
  input: MemberCheckInput,
): Promise<CheckFailure[]> {
  const key = codeVerdictKey(input.member, input.codeRoot);
  let verdict = codeTreeVerdicts.get(key);
  if (!verdict) {
    verdict = runCodeCheckChild(input).then((answer) => {
      // A child that gave no verdict is asked again at the next connect.
      if (!answer.kept) codeTreeVerdicts.delete(key);
      return answer.failures;
    });
    codeTreeVerdicts.set(key, verdict);
  }
  return verdict;
}

// The checks a connect makes: the cheap ones in process, then the code walk
// (cached, in a child) only when they pass.
export async function defaultMemberChecks(
  input: MemberCheckInput,
): Promise<CheckFailure[]> {
  const cheap = memberTrustedChecks({ ...input, walkCode: false });
  if (cheap.length > 0) return cheap;
  return memberCodeTreeChecks(input);
}

// A connected member runner (RunnerAgentHost.connectMember).
export interface MemberRunner {
  host: AgentHost;
  // The runtime hash the runner reports: member data, compared only.
  runtimeHash: string | null;
  // Ask the runner to exit, so its unit starts runtime/current.
  exit(): Promise<void>;
}

export interface MemberHostDeps {
  // The peer uid of a connected client socket's fd (SO_PEERCRED).
  readPeerUid: (fd: number) => number | null;
  // The system's user database: uid, primary gid and groups of a name.
  lookupUser: (name: string) => { uid: number; gid: number; groups: number[] };
  checks: (input: MemberCheckInput) => CheckFailure[] | Promise<CheckFailure[]>;
  // Connects the runner at socketPath; all socket work happens here.
  connectRunner: (
    socketPath: string,
    opts: {
      userId: string;
      uid: number;
      share: string;
      readPeerUid: (fd: number) => number | null;
    },
  ) => Promise<MemberRunner>;
  // The member share check (server/member-share-check.ts).
  checkShare: (input: {
    share: string;
    officeUid: number;
    memberGid: number;
    scope: "root" | "all";
  }) => ShareVerdict;
  // The member runtime (server/member-runtime.ts): the hash this server
  // installs (built at the first call), its install in a share (a no-op
  // when it is there and passes the share check), and the prune.
  runtime: {
    hash(): Promise<string>;
    install(share: string, memberGid: number): Promise<void>;
    prune(share: string, keep: string[]): Promise<void>;
  };
  // After an exit, how long the runner has to come back on its new runtime,
  // and the pause between connect tries.
  restartWaitMs: number;
  restartPollMs: number;
  retryMs: number;
  // The code-walk child (server/member-code-check.ts) and its time limit;
  // after it, the child is killed and the connect fails closed.
  codeCheck: { command: string[]; timeoutMs: number };
  // The secret proxy ties `uid` to its member: false when it did not.
  tieProxyUid: (uid: number) => Promise<boolean>;
  // The CA bundle's text, or null while the office has no secret material,
  // and its write to a share (member-runtime.ts, writeMemberCaBundle).
  caBundle: () => string | null;
  writeCaBundle: (share: string, pem: string) => Promise<void>;
}

const DEFAULT_DEPS: MemberHostDeps = {
  readPeerUid: (fd) => readPeerCredentials(fd)?.uid ?? null,
  lookupUser: readAgentIdentity,
  checks: defaultMemberChecks,
  connectRunner: (socketPath, opts) =>
    RunnerAgentHost.connectMember(socketPath, opts),
  checkShare: (input) => checkMemberShare(input),
  runtime: {
    hash: async () => (await runtimeSource()).hash,
    install: async (share, memberGid) => {
      await installMemberRuntime(share, await runtimeSource(), { memberGid });
    },
    prune: async (share, keep) => {
      await pruneMemberRuntime(share, keep);
    },
  },
  restartWaitMs: 30_000,
  restartPollMs: 500,
  retryMs: 30_000,
  codeCheck: {
    command: [process.execPath, CODE_CHECK_CHILD],
    timeoutMs: 120_000,
  },
  // No hooks: no secrets runtime in this process, so no proxy to tie.
  tieProxyUid: (uid) => secretHooks?.tie(uid) ?? Promise.resolve(true),
  caBundle: () => secretHooks?.caBundle() ?? null,
  writeCaBundle: writeMemberCaBundle,
};
let deps: MemberHostDeps = DEFAULT_DEPS;

// Tests: replace some of the dependencies; null restores the defaults.
export function setMemberHostDeps(over: Partial<MemberHostDeps> | null): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

const PRIVILEGED_GROUP_NAMES = ["sudo", "wheel", "admin", "adm", "docker"];

// The gids of the privileged groups that exist here (getent exits 2 when one
// is missing; the found lines still count).
function privilegedGroupIds(): number[] {
  const result = spawnSync("getent", ["group", ...PRIVILEGED_GROUP_NAMES], {
    encoding: "utf8",
  });
  const gids: number[] = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const gid = Number(line.split(":")[2]);
    if (line && Number.isSafeInteger(gid)) gids.push(gid);
  }
  return gids;
}

function scheduleRetry(userId: string): void {
  if (retries.has(userId)) return;
  const timer = setTimeout(() => {
    retries.delete(userId);
    if (memberOsUserState(userId).kind === "isolated")
      void connectMemberHost(userId);
  }, deps.retryMs);
  timer.unref?.();
  retries.set(userId, timer);
}

const inflight = new Map<string, Promise<boolean>>();

// Connect one member: `id -u <name>` and the runner's peer uid (SO_PEERCRED
// on our side of the socket) must equal the recorded uid, the share check
// and the trusted checks must pass, and the runner must run the runtime this
// server installs, which is installed first. On another runtime: ask the
// runner to exit and connect again once (the unit starts runtime/current);
// the member is not ready meanwhile. True when registered; else the member stays on the
// not-ready host, the reason is logged and a retry is set. One connect per
// member at a time.
export function connectMemberHost(userId: string): Promise<boolean> {
  const running = inflight.get(userId);
  if (running) return running;
  const run = connectNow(userId).finally(() => inflight.delete(userId));
  inflight.set(userId, run);
  return run;
}

async function connectNow(userId: string): Promise<boolean> {
  const state = memberOsUserState(userId);
  if (state.kind !== "isolated") {
    connected.delete(userId);
    if (state.kind === "broken")
      console.error(`[member-hosts] ${userId}: ${state.reason}`);
    return false;
  }
  const { osUser } = state;
  const refuse = (reason: string): false => {
    connected.delete(userId);
    refusals.set(userId, reason);
    console.error(
      `[member-hosts] ${userId} (${osUser.name}) is not ready: ${reason}`,
    );
    scheduleRetry(userId);
    return false;
  };
  let identity: { uid: number; gid: number; groups: number[] };
  try {
    identity = deps.lookupUser(osUser.name);
  } catch (error) {
    return refuse((error as Error).message);
  }
  if (identity.uid !== osUser.uid)
    return refuse(
      `the record names uid ${osUser.uid}, but ${osUser.name} is uid ${identity.uid}`,
    );
  const officeUid = process.getuid!();
  const share = memberSharePath(osUser.name);
  const checkShare = (scope: "root" | "all"): string | null => {
    let verdict: ShareVerdict;
    try {
      verdict = deps.checkShare({
        share,
        officeUid,
        memberGid: identity.gid,
        scope,
      });
    } catch (error) {
      return `the member share check failed: ${(error as Error).message}`;
    }
    return verdict.ok
      ? null
      : `the member share at ${verdict.path}: ${verdict.reason}`;
  };
  // Before the install, only what the server does not make: a runtime that
  // is broken (runtime/current names a folder that is gone) is what the
  // install repairs.
  const shareProblem = checkShare("root");
  if (shareProblem) return refuse(shareProblem);
  // Before the runner: a share whose runtime is missing or broken has no
  // runner to answer, and only this install repairs it. A no-op when
  // runtime/<hash> is there and passes the share check.
  let wanted: string;
  try {
    wanted = await deps.runtime.hash();
    // A connected runner on another runtime is not used from the install
    // (runtime/current moves) to its restart.
    if (connected.get(userId)?.runtimeHash !== wanted) connected.delete(userId);
    await deps.runtime.install(share, identity.gid);
  } catch (error) {
    return refuse(`the member runtime: ${(error as Error).message}`);
  }
  const bundleWritten = await writeCaBundleTo(userId, share);
  const installedProblem = checkShare("all");
  if (installedProblem) return refuse(installedProblem);
  const socketPath = memberRunnerSocketPath(osUser.name);
  const connectRunner = () =>
    deps.connectRunner(socketPath, {
      userId,
      uid: osUser.uid,
      share,
      readPeerUid: deps.readPeerUid,
    });
  let runner: MemberRunner;
  try {
    runner = await connectRunner();
  } catch (error) {
    return refuse(`cannot reach the runner: ${(error as Error).message}`);
  }
  let failures: CheckFailure[];
  try {
    failures = await deps.checks({
      officeUid,
      officeGroups: process.getgroups?.() ?? [process.getgid!()],
      member: identity,
      privilegedGroups: privilegedGroupIds(),
      officeHome: homedir(),
      stateRoot: STATE_ROOT,
      codeRoot: realpathSync(CODE_ROOT),
    });
  } catch (error) {
    return refuse(`the trusted checks failed: ${(error as Error).message}`);
  }
  if (failures.length > 0)
    return refuse(
      failures
        .map((f) => `${f.check}${f.path ? ` at ${f.path}` : ""}: ${f.detail}`)
        .join("; "),
    );
  if (runner.runtimeHash !== wanted) {
    // Not ready from here to the reconnect: the runner runs another
    // runtime than runtime/current.
    connected.delete(userId);
    await runner.exit().catch(() => {});
    const next = await reconnectRunner(connectRunner);
    if (!next) return refuse("the runner did not come back after its update");
    runner = next;
    if (runner.runtimeHash !== wanted)
      return refuse(
        `the runner runs runtime ${runner.runtimeHash ?? "none"}, not ${wanted}`,
      );
  }
  try {
    await deps.runtime.prune(share, [wanted]);
  } catch (error) {
    console.error(
      `[member-hosts] ${userId}: cannot prune old runtimes: ${(error as Error).message}`,
    );
  }
  const host = runner.host;
  // The member's agent space, made by the runner as the member: the office
  // never makes files there with its own fs.
  try {
    await host.fs.mkdir(host.agentRoot(), 0o700);
  } catch (error) {
    return refuse(
      `cannot make the agent space ${host.agentRoot()}: ${(error as Error).message}`,
    );
  }
  // Before the member's agents can start: the proxy must tie their uid to
  // them, or their agents' proxy password would reach every secret.
  if (!(await deps.tieProxyUid(osUser.uid)))
    return refuse("the secret proxy has not tied the member's OS user");
  // The record may have changed while we connected.
  const now = memberOsUserState(userId);
  if (
    now.kind !== "isolated" ||
    now.osUser.name !== osUser.name ||
    now.osUser.uid !== osUser.uid
  )
    return refuse("the record changed while connecting");
  connected.set(userId, { osUser, host, runtimeHash: wanted });
  refusals.delete(userId);
  clearRetry(userId);
  // The office's bundle was made since the write above: writeMemberCaBundles
  // covers only connected members, so this connect writes it, before the
  // member's agents start.
  if (deps.caBundle() !== bundleWritten) await writeCaBundleTo(userId, share);
  console.log(`[member-hosts] ${userId} runs as ${osUser.name}`);
  if (!moving.has(userId))
    for (const listener of connectedListeners)
      try {
        listener(userId);
      } catch (error) {
        console.error(
          `[member-hosts] ${userId}: a connect listener failed: ${(error as Error).message}`,
        );
      }
  if (!moving.has(userId) && connectedHook) {
    try {
      connectedHook(userId);
    } catch (error) {
      console.error(
        `[member-hosts] ${userId}: the connect hook failed: ${(error as Error).message}`,
      );
    }
  }
  return true;
}

// The CA bundle copy in a member's share; returns the text it tried to
// write, or null when the office has no bundle. A failure is logged: the
// member's TLS through the proxy then fails until the next write (their
// connect, or the office's next bundle).
async function writeCaBundleTo(
  userId: string,
  share: string,
): Promise<string | null> {
  const pem = deps.caBundle();
  if (pem === null) return null;
  try {
    await deps.writeCaBundle(share, pem);
  } catch (error) {
    console.error(
      `[member-hosts] ${userId}: cannot write the CA bundle: ${(error as Error).message}`,
    );
  }
  return pem;
}

// The office's CA bundle was made or read: a copy to each connected member.
export function writeMemberCaBundles(): Promise<void> {
  return Promise.all(
    [...connected].map(([userId, entry]) =>
      writeCaBundleTo(userId, memberSharePath(entry.osUser.name)),
    ),
  ).then(() => {});
}

// The member's share, or null when they have no OS user.
export function memberShareOf(userId: string): string | null {
  const state = memberOsUserState(userId);
  return state.kind === "isolated" ? memberSharePath(state.osUser.name) : null;
}

// Install this server's runtime in the member's share again (a no-op when
// it is there and passes the share check). runtime/current moves; a
// running runner keeps the runtime folder it started from, and moves to the
// new one at its next connect.
export async function reinstallMemberRuntime(userId: string): Promise<void> {
  const state = memberOsUserState(userId);
  if (state.kind !== "isolated")
    throw new Error(`${userId} has no OS user of their own`);
  const identity = deps.lookupUser(state.osUser.name);
  if (identity.uid !== state.osUser.uid)
    throw new Error(
      `the record names uid ${state.osUser.uid}, but ${state.osUser.name} is uid ${identity.uid}`,
    );
  await deps.runtime.install(memberSharePath(state.osUser.name), identity.gid);
}

// Why the last connect of `userId` failed; undefined after a success.
export function memberHostRefusal(userId: string): string | undefined {
  return refusals.get(userId);
}

function clearRetry(userId: string): void {
  const timer = retries.get(userId);
  if (timer) clearTimeout(timer);
  retries.delete(userId);
}

// Drop `userId`'s host, retry and last refusal (disable, or a go-on that
// is undone), with the share files of their agents (member-share-files.ts)
// and what the forgotten hooks hold for them (their authority socket).
// Called before the record goes; hostFor then follows the record alone.
export function forgetMemberHost(userId: string): void {
  const share = memberShareOf(userId);
  connected.delete(userId);
  refusals.delete(userId);
  clearRetry(userId);
  if (share)
    try {
      removeMemberShareFiles(share);
    } catch (error) {
      console.error(
        `[member-hosts] ${userId}: cannot remove the share files: ${(error as Error).message}`,
      );
    }
  for (const hook of forgottenHooks)
    try {
      hook(userId);
    } catch (error) {
      console.error(
        `[member-hosts] ${userId}: a forget hook failed: ${(error as Error).message}`,
      );
    }
}

const forgottenHooks = new Set<(userId: string) => void>();

// Runs at forgetMemberHost for each member (the OpenCode authority broker).
export function onMemberHostForgotten(hook: (userId: string) => void): void {
  forgottenHooks.add(hook);
}

// Connect again after an exit, until the runner answers or restartWaitMs
// ends. Null when it does not come back.
async function reconnectRunner(
  connect: () => Promise<MemberRunner>,
): Promise<MemberRunner | null> {
  const end = Date.now() + deps.restartWaitMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, deps.restartPollMs));
    try {
      return await connect();
    } catch {
      if (Date.now() >= end) return null;
    }
  }
}

// Boot: connect every member with an OS user.
export async function connectMemberHosts(): Promise<void> {
  await Promise.all(memberOsUserIds().map((id) => connectMemberHost(id)));
}

// Tests: forget every connected host and retry timer.
export function resetMemberHosts(): void {
  inflight.clear();
  refusals.clear();
  codeTreeVerdicts.clear();
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
  connected.clear();
  moving.clear();
}

// Runner-reply rule (design 1.1): the server never signals a pid that a
// runner sent; a stop goes through the runner (a signal control message).
// Audit of the 18 process.kill sites in server/ (tests excluded), 2026-11-14:
// - server-stop.ts:71, office-lockdown-route.ts:147, hook-live-probe.ts:171,
//   opencode/process-loss-harness.ts:44: this process's own pid.
// - agent-host.ts (local child group), preview-capture.ts:314 (its own
//   Chrome child), process-isolation.ts (signalIsolated: pids of local
//   children, and inside the runner its own children): pids this process
//   spawned itself.
// - agent-runner/runner.ts: the runner's own children, as the member user.
// - opencode/start-server.ts:174,219,252: runs as the agent's user (through
//   the host), on records of that user; opencode/server-startup.ts:48: probe
//   with signal 0 of the helper's child it started. The OpenCode supervisor
//   only compares a record's pid with /proc (processIdentityMatches) and stops
//   the server through the helper, on the agent's host.
// - stop-reap.ts:164, office-lockdown-route.ts:140: pids read from this
//   office's own systemd cgroup (cgroup.procs), never from a runner.
// - codex/live-client-reap.ts:15,48, codex/hook-live-probe.ts:121,161: live
//   tests and probes on the local host only (live-client-reap says so).

// The host of an env's member tag: the member's host for an env that
// buildEnvForUserId built for an isolated member, else the office host. Use
// it only where the env arrives from buildEnvForUserId unchanged or spread
// (a copy that drops the tag lands on the office host, which then runs it as
// any office env); a site that has the user id uses hostFor.
export function hostForEnv(env: object | undefined): AgentHost {
  const owner = memberEnvOwner(env);
  return owner !== undefined ? hostFor(owner) : officeAgentHost();
}

// True for an env built for an isolated member.
export function isMemberEnv(env: object | undefined): boolean {
  return memberEnvOwner(env) !== undefined;
}

// A sync read of the office's file system never answers for an isolated
// member's paths: the caller uses the function's OnHost twin, or skips the
// check.
export function refuseMemberEnv(env: object | undefined, what: string): void {
  if (isMemberEnv(env))
    throw new Error(
      `${what} reads the office's files; an isolated member's env goes through their host`,
    );
}
