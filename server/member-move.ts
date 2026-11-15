// The office side of the file move on enable
// (internal-docs/member-os-user-design.md, sections 2.2 and 6, slice 1):
// the files of a member's agents that are in the office's folders go to
// their agent space, through their runner (server/member-move-receive.ts).
//
// The office reads files that the member's agents wrote while they ran as
// the office user, so it trusts no name in them: a walk with lstat that
// never enters a link or another file system, only regular files with one
// link and a size bound, each opened O_NOFOLLOW and checked by fstat
// against the walk. Anything else is skipped and logged.

import { randomBytes } from "node:crypto";
import {
  constants,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentHost } from "./agent-host.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { openCodeProfileKey } from "./backends/opencode/access.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import { claudeConfigRoot } from "./claude-session-root.ts";
import { claudeProjectDir, findCodexRolloutPath } from "./cwd-utils.ts";
import { buildEnvForUserId, buildOfficeEnv } from "./env-loader.ts";
import { hostFor } from "./member-hosts.ts";
import { hasMemberOsUser } from "./member-os-users.ts";
import { officeUsageTarget } from "./member-usage-cap.ts";
import { profileKeyForOwner } from "./opencode-profile-keys.ts";
import {
  getSessionClaudeConfigDir,
  loadSessionsMap,
  setSessionClaudeConfigDir,
} from "./persistence.ts";
import {
  officePersonalProviderHome,
  personalProviderHome,
} from "./provider-homes.ts";
import { AGENT_ROOT } from "./split/roots.ts";

export const MOVE_FILE_MAX = 2 * 1024 * 1024 * 1024;
export const MOVE_TOTAL_MAX = 32 * 1024 * 1024 * 1024;
// deploy/isomux-member-user.sh MOVE_VERB_LIMIT_S is above the worst sum of
// these: change both together.
export const MOVE_IN_TIMEOUT_MS = 60 * 60 * 1000;
export const MOVE_STEP_TIMEOUT_MS = 30 * 60 * 1000;

export interface MemberMoveDeps {
  fileMax: number;
  totalMax: number;
  // Tests: runs between the walk's lstat and the open of each file.
  afterWalkBeforeOpen?: (path: string) => void;
  log: (line: string) => void;
}

const DEFAULT_DEPS: MemberMoveDeps = {
  fileMax: MOVE_FILE_MAX,
  totalMax: MOVE_TOTAL_MAX,
  log: (line) => console.log(line),
};
let deps = DEFAULT_DEPS;

// Tests: replace some dependencies; null restores the defaults.
export function setMemberMoveDeps(over: Partial<MemberMoveDeps> | null): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

export interface MemberMoveAgent {
  id: string;
  agentType: string;
  // For a session with no cwd of its own (persisted before per-session cwd).
  cwd: string;
}

// What moves, from the office's paths. The destinations come after the
// connect (stageMemberMove).
export interface MemberMovePlan {
  userId: string;
  // Trees moved whole: the destination is <agentRoot>/<destParts...>.
  trees: { src: string; destParts: string[] }[];
  // Codex rollouts found under `home`: the destination is
  // <member CODEX_HOME>/<rel>.
  codex: { src: string; home: string; rel: string }[];
  // Claude sessions: the transcript <projectDir>/<id>.jsonl and the folder
  // <projectDir>/<id>/ under `root`. personal: under the member's provider
  // home, which a tree carries.
  claude: {
    agentId: string;
    sessionId: string;
    cwd: string;
    root: string;
    personal: boolean;
  }[];
}

function skip(userId: string, path: string, reason: string): void {
  deps.log(`[member-move] ${userId}: skipped ${path}: ${reason}`);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function realFolder(path: string): boolean {
  const stats = lstatOrNull(path);
  return !!stats && stats.isDirectory();
}

// The files of the member's agents in the office's folders. Made before the
// record (go-on), so every path helper still answers the office's paths.
export function planMemberMove(
  userId: string,
  agents: MemberMoveAgent[],
): MemberMovePlan {
  const plan: MemberMovePlan = { userId, trees: [], codex: [], claude: [] };
  const providerHomes = dirname(officePersonalProviderHome(userId, "claude"));
  if (realFolder(providerHomes))
    plan.trees.push({
      src: providerHomes,
      destParts: ["provider-homes", userId],
    });
  const memberKey = profileKeyForOwner(userId);
  for (const key of [memberKey, openCodeProfileKey(memberKey, "chat")]) {
    // The office's profile, whatever the member's host answers now.
    const name = basename(openCodeProfilePaths(key).profileDir);
    const office = join(AGENT_ROOT, "opencode", "profiles", name);
    if (realFolder(office))
      plan.trees.push({
        src: office,
        destParts: ["opencode", "profiles", name],
      });
  }
  const personalClaude = resolve(officePersonalProviderHome(userId, "claude"));
  // A member who already has their own OS user (a rerun, or the check at
  // connect): only the office's roots, never a path in their home.
  const isolated = hasMemberOsUser(userId);
  const memberHome = isolated ? resolve(hostFor(userId).home()) : null;
  const claudeRoots = [
    ...(isolated ? [] : [claudeConfigRoot(buildEnvForUserId(userId))]),
    claudeConfigRoot(buildOfficeEnv()),
    personalClaude,
  ];
  const officePin = (pin: string | undefined) =>
    pin && (!memberHome || !within(resolve(pin), memberHome)) ? pin : undefined;
  const codexHomes = [ISOMUX_CODEX_HOME];
  try {
    codexHomes.push(officeUsageTarget("codex").dir);
  } catch {}
  const seenCodex = new Set<string>();
  for (const agent of agents) {
    const sessions = loadSessionsMap(agent.id);
    for (const [sessionId, session] of Object.entries(sessions)) {
      const agentType = session.agentType ?? agent.agentType;
      if (agentType === "codex") {
        for (const home of [...new Set(codexHomes.map((h) => resolve(h)))]) {
          const path = findCodexRolloutPath(sessionId, { CODEX_HOME: home });
          if (path === "") {
            skip(userId, home, `the search for ${sessionId} stopped early`);
            continue;
          }
          if (!path || seenCodex.has(path)) continue;
          seenCodex.add(path);
          if (within(resolve(path), providerHomes)) break;
          plan.codex.push({ src: path, home, rel: relative(home, path) });
          break;
        }
      } else if (agentType === "claude") {
        const cwd = session.cwd || agent.cwd;
        const roots = [
          ...new Set(
            [officePin(session.claudeConfigDir), ...claudeRoots]
              .filter((r): r is string => !!r)
              .map((r) => resolve(r)),
          ),
        ];
        for (const root of roots) {
          const file = join(
            claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: root }),
            `${sessionId}.jsonl`,
          );
          if (!lstatOrNull(file)) continue;
          plan.claude.push({
            agentId: agent.id,
            sessionId,
            cwd,
            root,
            personal: within(root, providerHomes),
          });
          break;
        }
      }
    }
  }
  return plan;
}

export function memberMovePlanIsEmpty(plan: MemberMovePlan): boolean {
  return (
    plan.trees.length === 0 &&
    plan.codex.length === 0 &&
    plan.claude.length === 0
  );
}

// An entry that the walk saw, with what it saw: the delete removes it only
// when an lstat still shows that device and inode, reached through real
// folders from `root`.
interface Seen {
  path: string;
  root: string;
  dev: number;
  ino: number;
}

interface MoveFile extends Seen {
  dest: string;
  size: number;
  mode: number;
  // Every byte went into the stream (moveRecords).
  sent: boolean;
}

// What a walk collects. `removable`: entries that hold no content of their
// own (links, FIFOs, sockets, extra names of a file with more links), which
// the delete removes with the files that moved. `folders`: the real folders
// walked, removed when empty.
interface Collected {
  files: MoveFile[];
  removable: Seen[];
  folders: Seen[];
  // No log lines (the check at connect, warnUnfinishedMemberMove).
  quiet: boolean;
}

function collected(quiet = false): Collected {
  return { files: [], removable: [], folders: [], quiet };
}

function note(c: Collected, userId: string, path: string, reason: string) {
  if (!c.quiet) skip(userId, path, reason);
}

// A regular file with one link on `dev`, within the size bound; else why
// not.
function fileRefusal(stats: Stats, dev: number): string | null {
  if (stats.isSymbolicLink()) return "a link";
  if (!stats.isFile()) return "not a regular file";
  if (stats.nlink !== 1) return `${stats.nlink} links`;
  if (stats.dev !== dev) return "another file system";
  if (stats.size > deps.fileMax) return `larger than ${deps.fileMax} bytes`;
  return null;
}

// A skipped entry with no content of its own: the delete may remove it.
function holdsNoContent(stats: Stats, dev: number): boolean {
  if (stats.dev !== dev) return false;
  return !stats.isFile() || stats.nlink > 1;
}

// Each folder from `root` down to the parent of `path` is a real folder on
// `dev`.
function parentsReal(root: string, path: string, dev: number): boolean {
  const top = lstatOrNull(root);
  if (!top?.isDirectory() || top.dev !== dev) return false;
  let dir = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    const stats = lstatOrNull(dir);
    if (!stats?.isDirectory() || stats.dev !== dev) return false;
  }
  return true;
}

// The files of a tree, by an lstat walk that enters only real folders on
// the root's file system. `checkRoot` is where the delete starts its parent
// check (the session root for a Claude <id>/ folder).
function walkTree(
  userId: string,
  top: string,
  destRoot: string,
  c: Collected,
  checkRoot: string = top,
): void {
  const topStats = lstatOrNull(top);
  if (!topStats) return;
  if (!topStats.isDirectory()) {
    note(c, userId, top, "not a folder");
    return;
  }
  const dev = topStats.dev;
  c.folders.push({ path: top, root: checkRoot, dev, ino: topStats.ino });
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const dir = join(top, rel);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      note(c, userId, dir, (error as Error).message);
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stats = lstatOrNull(path);
      if (!stats) continue;
      if (stats.isDirectory()) {
        if (stats.dev !== dev) note(c, userId, path, "another file system");
        else {
          stack.push(join(rel, name));
          c.folders.push({ path, root: checkRoot, dev, ino: stats.ino });
        }
        continue;
      }
      const refusal = fileRefusal(stats, dev);
      if (refusal) {
        note(c, userId, path, refusal);
        if (holdsNoContent(stats, dev))
          c.removable.push({ path, root: checkRoot, dev, ino: stats.ino });
        continue;
      }
      c.files.push({
        path,
        root: checkRoot,
        dest: join(destRoot, rel, name),
        size: stats.size,
        mode: stats.mode & 0o777,
        dev,
        ino: stats.ino,
        sent: false,
      });
    }
  }
}

// One file under `root`: each folder from the root down is a real folder on
// the root's file system.
function singleFile(
  userId: string,
  root: string,
  path: string,
  dest: string,
  c: Collected,
): void {
  const top = lstatOrNull(root);
  if (!top) return;
  if (!top.isDirectory()) {
    note(c, userId, path, `${root} is not a folder`);
    return;
  }
  if (!parentsReal(root, path, top.dev)) {
    note(
      c,
      userId,
      path,
      "a folder above it is a link or on another file system",
    );
    return;
  }
  const stats = lstatOrNull(path);
  if (!stats) return;
  const refusal = fileRefusal(stats, top.dev);
  if (refusal) {
    note(c, userId, path, refusal);
    return;
  }
  c.files.push({
    path,
    root,
    dest,
    size: stats.size,
    mode: stats.mode & 0o777,
    dev: top.dev,
    ino: stats.ino,
    sent: false,
  });
}

// A tree under `root` whose top is `top` (the Claude <id>/ folder): its
// parents are checked like a single file's.
function subtree(
  userId: string,
  root: string,
  top: string,
  destTop: string,
  c: Collected,
): void {
  const rootStats = lstatOrNull(root);
  if (!rootStats?.isDirectory() || !lstatOrNull(top)) return;
  if (!parentsReal(root, top, rootStats.dev)) {
    note(
      c,
      userId,
      top,
      "a folder above it is a link or on another file system",
    );
    return;
  }
  walkTree(userId, top, destTop, c, root);
}

function u32(n: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(n, 0);
  return buffer;
}

// The records of files-in. A file that changed since the walk (another
// inode, type, link count or size) is skipped. Each file sent in full is
// marked `sent`.
async function* moveRecords(
  userId: string,
  files: MoveFile[],
): AsyncGenerator<Uint8Array> {
  for (const file of files) {
    deps.afterWalkBeforeOpen?.(file.path);
    let handle;
    try {
      handle = await open(
        file.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      skip(userId, file.path, (error as Error).message);
      continue;
    }
    try {
      const stats = await handle.stat();
      const refusal =
        stats.dev !== file.dev || stats.ino !== file.ino
          ? "it changed during the move"
          : (fileRefusal(stats, file.dev) ??
            (stats.size !== file.size ? "its size changed" : null));
      if (refusal) {
        skip(userId, file.path, refusal);
        continue;
      }
      const header = Buffer.from(
        JSON.stringify({ dest: file.dest, size: file.size, mode: file.mode }),
      );
      yield Buffer.concat([u32(header.length), header]);
      let left = file.size;
      while (left > 0) {
        const want = Math.min(left, 1024 * 1024);
        const buffer = Buffer.alloc(want);
        const { bytesRead } = await handle.read(buffer, 0, want, null);
        if (bytesRead === 0)
          throw new Error(`${file.path} became shorter while it was read`);
        left -= bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      file.sent = true;
    } finally {
      await handle.close();
    }
  }
  yield u32(0);
}

export interface PinChange {
  agentId: string;
  sessionId: string;
  root: string;
}

export interface StagedMove {
  // The Claude pins to write once the files are placed: the sessions whose
  // transcript moved.
  pins: PinChange[];
  // Remove what the runner placed (as the member) and its staging.
  undo(): Promise<void>;
  // Remove the staging of a kept move.
  done(): Promise<void>;
  // Delete the office's copies of what moved; failures are logged.
  deleteOfficeCopies(): void;
}

// Remove `seen` when an lstat still shows what the walk saw, reached
// through real folders. A folder goes only when empty.
function removeSeen(userId: string, seen: Seen, folder: boolean): void {
  if (!parentsReal(seen.root, seen.path, seen.dev) && seen.path !== seen.root)
    return;
  const stats = lstatOrNull(seen.path);
  if (!stats || stats.dev !== seen.dev || stats.ino !== seen.ino) return;
  try {
    if (folder) rmdirSync(seen.path);
    else unlinkSync(seen.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
    deps.log(
      `[member-move] ${userId}: cannot delete the office copy ${seen.path}: ${(error as Error).message}`,
    );
  }
}

// The office's copies of what moved: each file sent, the entries with no
// content of their own, then the folders that are now empty, deepest
// first. A skipped file stays, and so does its folder.
function deleteMoved(userId: string, c: Collected): void {
  for (const file of c.files) if (file.sent) removeSeen(userId, file, false);
  for (const entry of c.removable) removeSeen(userId, entry, false);
  const folders = [...c.folders].sort(
    (a, b) => b.path.split(sep).length - a.path.split(sep).length,
  );
  for (const folder of folders) removeSeen(userId, folder, true);
}

interface Destinations {
  home: string;
  agentRoot: string;
  codexHome: string;
  claudeRoot: string;
  personalClaude: string;
}

// The walk of a plan: what moves where, and the Claude sessions with the
// path of their transcript.
function collectPlan(
  plan: MemberMovePlan,
  to: Destinations,
  c: Collected,
): {
  session: MemberMovePlan["claude"][number];
  transcript: string;
  root: string;
}[] {
  const { userId } = plan;
  const inHome = (dest: string) => within(dest, to.home) && dest !== to.home;
  const sessions: {
    session: MemberMovePlan["claude"][number];
    transcript: string;
    root: string;
  }[] = [];
  for (const tree of plan.trees)
    walkTree(userId, tree.src, join(to.agentRoot, ...tree.destParts), c);
  for (const rollout of plan.codex) {
    const dest = join(to.codexHome, rollout.rel);
    if (!inHome(dest)) {
      note(
        c,
        userId,
        rollout.src,
        `its destination ${dest} is outside the member's home`,
      );
      continue;
    }
    singleFile(userId, rollout.home, rollout.src, dest, c);
  }
  for (const session of plan.claude) {
    const projectDir = claudeProjectDir(session.cwd, {
      CLAUDE_CONFIG_DIR: session.root,
    });
    const transcript = join(projectDir, `${session.sessionId}.jsonl`);
    if (session.personal) {
      // The tree of the provider homes carries it.
      sessions.push({ session, transcript, root: to.personalClaude });
      continue;
    }
    const destDir = join(to.claudeRoot, relative(session.root, projectDir));
    if (!inHome(destDir)) {
      note(
        c,
        userId,
        transcript,
        `its destination ${destDir} is outside the member's home`,
      );
      continue;
    }
    singleFile(
      userId,
      session.root,
      transcript,
      join(destDir, `${session.sessionId}.jsonl`),
      c,
    );
    subtree(
      userId,
      session.root,
      join(projectDir, session.sessionId),
      join(destDir, session.sessionId),
      c,
    );
    sessions.push({ session, transcript, root: to.claudeRoot });
  }
  return sessions;
}

// Where a member's files go on their connected host. During a move,
// hostFor answers the moving host, so buildEnvForUserId gives the member's
// env with their real paths.
function destinationsOn(userId: string, host: AgentHost): Destinations {
  const agentRoot = resolve(host.agentRoot());
  const memberEnv = buildEnvForUserId(userId) ?? {};
  return {
    home: resolve(host.home()),
    agentRoot,
    codexHome: resolve(memberEnv.CODEX_HOME || join(agentRoot, "codex-home")),
    claudeRoot: resolve(claudeConfigRoot(memberEnv)),
    personalClaude: resolve(personalProviderHome(userId, "claude")),
  };
}

// The destinations of a plan on the connected member host, then files-in
// and files-place. Throws on a failure; the runner side is undone first.
export async function stageMemberMove(
  plan: MemberMovePlan,
  host: AgentHost,
): Promise<StagedMove> {
  const { userId } = plan;
  if (!host.runEntryStream) throw new Error("the member host has no runner");
  const to = destinationsOn(userId, host);
  const { home, agentRoot } = to;
  const c = collected();
  const sessions = collectPlan(plan, to, c);
  const total = c.files.reduce((sum, file) => sum + file.size, 0);
  if (total > deps.totalMax)
    throw new Error(
      `the member's files take ${total} bytes; a move takes at most ${deps.totalMax}`,
    );
  const nonce = randomBytes(16).toString("hex");
  const step = { nonce, agentRoot };
  const undo = async () => {
    await host.runEntry("files-undo", step, MOVE_STEP_TIMEOUT_MS);
  };
  try {
    await host.runEntryStream(
      "files-in",
      { ...step, home, total },
      moveRecords(userId, c.files),
      MOVE_IN_TIMEOUT_MS,
    );
    await host.runEntry("files-place", step, MOVE_STEP_TIMEOUT_MS);
  } catch (error) {
    await undo().catch((undoError: unknown) =>
      deps.log(
        `[member-move] ${userId}: the undo failed: ${(undoError as Error).message}`,
      ),
    );
    throw error;
  }
  const sent = new Set(c.files.filter((f) => f.sent).map((f) => f.path));
  const pins = sessions
    .filter(({ transcript }) => sent.has(transcript))
    .map(({ session, root }) => ({
      agentId: session.agentId,
      sessionId: session.sessionId,
      root,
    }));
  return {
    pins,
    undo,
    done: async () => {
      await host.runEntry("files-done", step, MOVE_STEP_TIMEOUT_MS);
    },
    deleteOfficeCopies: () => deleteMoved(userId, c),
  };
}

// Write the Claude pins of a placed move. On a failure, the pins written so
// far get their earlier values back, and the error is thrown.
export function applyMemberMovePins(pins: PinChange[]): void {
  const written: (PinChange & { before: string | null })[] = [];
  try {
    for (const pin of pins) {
      const before =
        getSessionClaudeConfigDir(pin.agentId, pin.sessionId) ?? null;
      setSessionClaudeConfigDir(pin.agentId, pin.sessionId, pin.root);
      written.push({ ...pin, before });
    }
  } catch (error) {
    for (const pin of written.reverse()) {
      try {
        setSessionClaudeConfigDir(pin.agentId, pin.sessionId, pin.before);
      } catch {}
    }
    throw error;
  }
}

// A connect of an isolated member with a file in the office that a move
// would take: a move that did not finish (the server stopped during it).
// The walk is the move's, with no destinations and no log lines, so a file
// that a move skips does not count.
export function warnUnfinishedMemberMove(
  userId: string,
  agents: MemberMoveAgent[],
): void {
  const plan = planMemberMove(userId, agents);
  if (memberMovePlanIsEmpty(plan)) return;
  const c = collected(true);
  collectPlan(plan, destinationsOn(userId, hostFor(userId)), c);
  if (c.files.length > 0)
    deps.log(
      `[member-move] ${userId}: an earlier move did not finish; run isomux-member-user enable again`,
    );
}
