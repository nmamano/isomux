// The office side of the move back on disable
// (internal-docs/member-os-user-design.md, section 2.3): the member's runner
// reads the files of their agent space as the member (files-out,
// server/member-move-receive.ts) and the office writes them into its own
// folders.
//
// The stream comes from a process the member controls, so the office trusts
// nothing in it but the bytes: each record names one of the sources the
// office asked for, and the office picks every destination. A Codex record
// must be the rollout of the thread it asked for, and a Claude record the
// transcript or a file under that session's folder; only the member's own
// trees take any normalised path. Each file is written O_EXCL|O_NOFOLLOW
// 0600 into a staging folder on the destination's file system, and linked
// into place without replacing a file.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AgentHost } from "./agent-host.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { openCodeProfileKey } from "./backends/opencode/access.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import {
  claudeConfigRoot,
  isolatedMemberClaudeRoots,
} from "./claude-session-root.ts";
import { claudeProjectDirIn } from "./claude-session-files.ts";
import { STATE_ROOT } from "./config.ts";
import { buildEnvForUserId, buildOfficeEnv } from "./env-loader.ts";
import {
  memberAppDataSources,
  OFFICE_APP_DATA_ROOT,
} from "./member-app-move.ts";
import {
  MOVE_FILE_MAX,
  MOVE_IN_TIMEOUT_MS,
  MOVE_STEP_TIMEOUT_MS,
  MOVE_TOTAL_MAX,
  type MemberMoveAgent,
  type PinChange,
} from "./member-move.ts";
import { spaceNeeded } from "./member-move-receive.ts";
import { profileKeyForOwner } from "./opencode-profile-keys.ts";
import { getSessionClaudeConfigDir, loadSessionsMap } from "./persistence.ts";
import {
  officePersonalProviderHome,
  personalProviderHome,
} from "./provider-homes.ts";
import { AGENT_ROOT } from "./split/roots.ts";

export interface MemberMoveOutDeps {
  fileMax: number;
  totalMax: number;
  log: (line: string) => void;
  // Free bytes on the file system of `path`.
  freeBytes: (path: string) => number;
}

const DEFAULT_DEPS: MemberMoveOutDeps = {
  fileMax: MOVE_FILE_MAX,
  totalMax: MOVE_TOTAL_MAX,
  log: (line) => console.log(line),
  freeBytes: (path) => {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};
let deps = DEFAULT_DEPS;

// Tests: replace some dependencies; null restores the defaults.
export function setMemberMoveOutDeps(
  over: Partial<MemberMoveOutDeps> | null,
): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

// One source the office asks the runner for, and where its files go.
export type MoveOutSource =
  // A tree of the member's agent space: any normalised rel, under destRoot.
  | { index: number; kind: "tree"; path: string; destRoot: string }
  // A Codex rollout by thread id under the member's Codex home: rel must be
  // that thread's rollout path, put under destRoot (the office Codex home).
  | {
      index: number;
      kind: "codex";
      home: string;
      threadId: string;
      destRoot: string;
    }
  // A Claude transcript (rel ""), to dest.
  | {
      index: number;
      kind: "claude-file";
      path: string;
      dest: string;
      session: { agentId: string; sessionId: string; root: string };
    }
  // A Claude session folder <id>/: any normalised rel under destRoot.
  | { index: number; kind: "claude-dir"; path: string; destRoot: string };

type SourceWithoutIndex = MoveOutSource extends infer S
  ? S extends MoveOutSource
    ? Omit<S, "index">
    : never
  : never;

export interface MemberMoveOutPlan {
  userId: string;
  sources: MoveOutSource[];
  // Sessions in the member's personal home, carried by its tree: their pin
  // changes when the transcript (rel under the tree) arrives.
  personal: {
    agentId: string;
    sessionId: string;
    // The transcript's rel under the provider-homes tree (index 0).
    rel: string;
    root: string;
  }[];
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

// What the move back asks for, from the member's paths on their connected
// host (the moving one during the disable: their real paths, nothing
// started).
export function planMemberMoveOut(
  userId: string,
  agents: MemberMoveAgent[],
  host: AgentHost,
): MemberMoveOutPlan {
  const agentRoot = resolve(host.agentRoot());
  const memberEnv = buildEnvForUserId(userId) ?? {};
  const sources: MoveOutSource[] = [];
  const personal: MemberMoveOutPlan["personal"] = [];
  const add = (source: SourceWithoutIndex) =>
    sources.push({ ...source, index: sources.length });

  const memberHomes = join(agentRoot, "provider-homes", userId);
  add({
    kind: "tree",
    path: memberHomes,
    destRoot: dirname(officePersonalProviderHome(userId, "claude")),
  });
  const memberKey = profileKeyForOwner(userId);
  for (const key of [memberKey, openCodeProfileKey(memberKey, "chat")]) {
    const name = basename(openCodeProfilePaths(key).profileDir);
    add({
      kind: "tree",
      path: join(agentRoot, "opencode", "profiles", name),
      destRoot: join(AGENT_ROOT, "opencode", "profiles", name),
    });
  }
  // The data of the member's apps (member-app-move.ts).
  for (const tree of memberAppDataSources(userId, agentRoot))
    add({ kind: "tree", path: tree.path, destRoot: tree.destRoot });
  const codexHome = resolve(
    memberEnv.CODEX_HOME || join(agentRoot, "codex-home"),
  );
  const memberRoots = isolatedMemberClaudeRoots(memberEnv, userId);
  const personalClaude = resolve(personalProviderHome(userId, "claude"));
  const officeClaude = resolve(claudeConfigRoot(buildOfficeEnv()));
  const officePersonal = resolve(officePersonalProviderHome(userId, "claude"));
  const seen = new Set<string>();
  for (const agent of agents) {
    for (const [sessionId, session] of Object.entries(
      loadSessionsMap(agent.id),
    )) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const agentType = session.agentType ?? agent.agentType;
      if (agentType === "codex") {
        // A Codex home in the personal home is in that tree.
        if (within(codexHome, memberHomes)) continue;
        add({
          kind: "codex",
          home: codexHome,
          threadId: sessionId,
          destRoot: ISOMUX_CODEX_HOME,
        });
      } else if (agentType === "claude") {
        const cwd = session.cwd || agent.cwd;
        const pin = getSessionClaudeConfigDir(agent.id, sessionId);
        const root =
          pin && memberRoots.includes(resolve(pin))
            ? resolve(pin)
            : resolve(claudeConfigRoot(memberEnv));
        const projectDir = claudeProjectDirIn(root, cwd);
        if (within(root, personalClaude)) {
          personal.push({
            agentId: agent.id,
            sessionId,
            rel: relative(memberHomes, join(projectDir, `${sessionId}.jsonl`)),
            root: officePersonal,
          });
          continue;
        }
        const officeDir = claudeProjectDirIn(officeClaude, cwd);
        add({
          kind: "claude-file",
          path: join(projectDir, `${sessionId}.jsonl`),
          dest: join(officeDir, `${sessionId}.jsonl`),
          session: { agentId: agent.id, sessionId, root: officeClaude },
        });
        add({
          kind: "claude-dir",
          path: join(projectDir, sessionId),
          destRoot: join(officeDir, sessionId),
        });
      }
    }
  }
  return { userId, sources, personal };
}

// The files of one agent that leaves the member `fromUserId` (a manager
// change, agent-host-move.ts): its sessions only, each as a Claude file and
// folder or a Codex rollout with an office destination (a session in the
// member's personal home too), and the data of the apps `appNames`. No
// provider-home or OpenCode tree.
export function planAgentMoveOut(
  agent: MemberMoveAgent,
  fromUserId: string,
  host: AgentHost,
  appNames: string[],
): MemberMoveOutPlan {
  const agentRoot = resolve(host.agentRoot());
  const memberEnv = buildEnvForUserId(fromUserId) ?? {};
  const sources: MoveOutSource[] = [];
  const add = (source: SourceWithoutIndex) =>
    sources.push({ ...source, index: sources.length });
  for (const name of appNames)
    add({
      kind: "tree",
      path: join(agentRoot, "apps", "data", name),
      destRoot: join(OFFICE_APP_DATA_ROOT, name),
    });
  const codexHome = resolve(
    memberEnv.CODEX_HOME || join(agentRoot, "codex-home"),
  );
  const memberRoots = isolatedMemberClaudeRoots(memberEnv, fromUserId);
  const officeClaude = resolve(claudeConfigRoot(buildOfficeEnv()));
  for (const [sessionId, session] of Object.entries(
    loadSessionsMap(agent.id),
  )) {
    const agentType = session.agentType ?? agent.agentType;
    if (agentType === "codex")
      add({
        kind: "codex",
        home: codexHome,
        threadId: sessionId,
        destRoot: ISOMUX_CODEX_HOME,
      });
    else if (agentType === "claude")
      addClaudeSession(add, {
        agentId: agent.id,
        sessionId,
        cwd: session.cwd || agent.cwd,
        memberRoots,
        memberEnv,
        officeClaude,
      });
  }
  return { userId: fromUserId, sources, personal: [] };
}

// A Claude session of the member as its transcript and its <id>/ folder,
// each a source with an office destination: from the pinned root when it
// is one of the member's, else their current one.
function addClaudeSession(
  add: (source: SourceWithoutIndex) => void,
  session: {
    agentId: string;
    sessionId: string;
    cwd: string;
    memberRoots: string[];
    memberEnv: Record<string, string | undefined>;
    officeClaude: string;
  },
): void {
  const { agentId, sessionId, cwd, officeClaude } = session;
  const pin = getSessionClaudeConfigDir(agentId, sessionId);
  const root =
    pin && session.memberRoots.includes(resolve(pin))
      ? resolve(pin)
      : resolve(claudeConfigRoot(session.memberEnv));
  const projectDir = claudeProjectDirIn(root, cwd);
  const officeDir = claudeProjectDirIn(officeClaude, cwd);
  add({
    kind: "claude-file",
    path: join(projectDir, `${sessionId}.jsonl`),
    dest: join(officeDir, `${sessionId}.jsonl`),
    session: { agentId, sessionId, root: officeClaude },
  });
  add({
    kind: "claude-dir",
    path: join(projectDir, sessionId),
    destRoot: join(officeDir, sessionId),
  });
}

// What files-out gets: the sources by kind, with no destination.
export function moveOutRequest(
  plan: MemberMoveOutPlan,
  nonce: string,
  agentRoot: string,
): unknown {
  return {
    nonce,
    agentRoot,
    fileMax: deps.fileMax,
    trees: plan.sources
      .filter((s) => s.kind === "tree" || s.kind === "claude-dir")
      .map((s) => ({ index: s.index, path: (s as { path: string }).path })),
    files: plan.sources
      .filter((s) => s.kind === "claude-file")
      .map((s) => ({ index: s.index, path: (s as { path: string }).path })),
    codex: plan.sources
      .filter((s) => s.kind === "codex")
      .map((s) => ({ index: s.index, home: s.home, threadId: s.threadId })),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalisedRel(rel: unknown): rel is string {
  return (
    typeof rel === "string" &&
    rel !== "" &&
    !isAbsolute(rel) &&
    normalize(rel) === rel &&
    !rel.split("/").includes("..") &&
    !rel.split("/").includes(".")
  );
}

// The destination of a record, or why the stream is refused.
function recordDest(
  source: MoveOutSource | undefined,
  rel: unknown,
): string | { refused: string } {
  if (!source) return { refused: "a record names no requested source" };
  switch (source.kind) {
    case "tree":
    case "claude-dir":
      return normalisedRel(rel)
        ? join(source.destRoot, rel)
        : { refused: `a bad path ${JSON.stringify(rel)}` };
    case "claude-file":
      return rel === ""
        ? source.dest
        : { refused: "a transcript record with a path" };
    case "codex": {
      const shape = new RegExp(
        `^sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]*-${escapeRegExp(source.threadId)}\\.jsonl$`,
      );
      return typeof rel === "string" && shape.test(rel) && normalisedRel(rel)
        ? join(source.destRoot, rel)
        : {
            refused: `${JSON.stringify(rel)} is not the rollout of ${source.threadId}`,
          };
    }
  }
}

// Reads exact byte counts from a stream of chunks.
class Reader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private readonly iterator: AsyncIterator<Uint8Array>;
  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }
  private async fill(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done) throw new Error("the stream from the runner ended early");
    const chunk = Buffer.from(next.value);
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }
  async exact(n: number): Promise<Buffer> {
    while (this.buffered < n) await this.fill();
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.buffered = all.length - n;
    return all.subarray(0, n);
  }
  async line(max: number): Promise<string> {
    for (;;) {
      const all = Buffer.concat(this.chunks);
      const at = all.indexOf(0x0a);
      if (at >= 0) {
        this.chunks = [all.subarray(at + 1)];
        this.buffered = all.length - at - 1;
        return all.subarray(0, at).toString("utf8");
      }
      if (all.length > max)
        throw new Error("the runner's first line is too long");
      await this.fill();
    }
  }
  async some(max: number): Promise<Buffer> {
    if (this.buffered === 0) await this.fill();
    const head = this.chunks[0];
    if (head.length <= max) {
      this.chunks.shift();
      this.buffered -= head.length;
      return head;
    }
    this.chunks[0] = head.subarray(max);
    this.buffered -= max;
    return head.subarray(0, max);
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// The nearest folder of `path` (itself or an ancestor) that exists.
function nearestExisting(path: string): string {
  let at = path;
  while (!lstatOrNull(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

// Staging folders, one per file system: <base>/.member-move-out/<userId>/
// <nonce>, for each base that nobody scans.
class Staging {
  private readonly byDev = new Map<number, string>();
  private counter = 0;
  constructor(
    private readonly userId: string,
    private readonly nonce: string,
    private readonly bases: string[],
  ) {}

  // The staging folder on the file system of `dest`.
  folderFor(dest: string): string {
    const dev = lstatSync(nearestExisting(dest)).dev;
    const known = this.byDev.get(dev);
    if (known) return known;
    for (const base of this.bases) {
      const stats = lstatOrNull(base);
      if (!stats?.isDirectory() || stats.dev !== dev) continue;
      const folder = join(base, ".member-move-out", this.userId, this.nonce);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      this.byDev.set(dev, folder);
      return folder;
    }
    throw new Error(`no staging folder on the file system of ${dest}`);
  }

  next(dest: string): string {
    return join(this.folderFor(dest), String(this.counter++));
  }

  remove(): void {
    for (const folder of this.byDev.values())
      rmSync(folder, { recursive: true, force: true });
  }
}

// The bases of the staging folders. Clearing them first removes what a
// stopped disable of this member left.
function stagingBases(): string[] {
  return [STATE_ROOT, AGENT_ROOT, resolve(claudeConfigRoot(buildOfficeEnv()))];
}

export function clearMoveOutStaging(userId: string): void {
  for (const base of stagingBases())
    rmSync(join(base, ".member-move-out", userId), {
      recursive: true,
      force: true,
    });
}

interface StagedOut {
  source: MoveOutSource;
  staged: string;
  dest: string;
  size: number;
  sha256: string;
}

export interface WrittenOut {
  // Files placed by this move ({dest, ino}) and folders it made, for the
  // undo.
  placed: { dest: string; ino: number }[];
  madeDirs: string[];
  // The Claude pins of the transcripts that arrived in full.
  pins: PinChange[];
  // The requested sources the runner sent nothing for.
  missing: number[];
  // Every file that arrived, placed now or there with the same bytes.
  arrived: { source: MoveOutSource; dest: string }[];
  staging: Staging;
}

// Make the folders of `dest` below `root` (0700), each one a real folder:
// a link refuses. Returns the folders it made.
function makeParents(root: string, dest: string): string[] {
  const made: string[] = [];
  if (!lstatOrNull(root)) {
    const first = mkdirSync(root, { recursive: true, mode: 0o700 });
    if (first) made.push(root);
  }
  if (!lstatOrNull(root)?.isDirectory())
    throw new Error(`${root} is not a folder`);
  let dir = root;
  for (const part of relative(root, dirname(dest)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    const stats = lstatOrNull(dir);
    if (!stats) {
      mkdirSync(dir, { mode: 0o700 });
      made.push(dir);
      continue;
    }
    if (!stats.isDirectory())
      throw new Error(`${dir} is not a folder (a link or a file)`);
  }
  return made;
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// The root under which a source's files go: makeParents checks from it.
function destRootOf(source: MoveOutSource): string {
  return source.kind === "claude-file" ? dirname(source.dest) : source.destRoot;
}

// Write the runner's stream into the office: staged, then placed. Throws on
// a refused record or a failed place, after undoing what it placed.
export async function writeMoveOut(
  plan: MemberMoveOutPlan,
  body: AsyncIterable<Uint8Array>,
  nonce: string = randomBytes(16).toString("hex"),
): Promise<WrittenOut> {
  const { userId } = plan;
  const byIndex = new Map(plan.sources.map((s) => [s.index, s]));
  const staging = new Staging(userId, nonce, stagingBases());
  const written: WrittenOut = {
    placed: [],
    madeDirs: [],
    pins: [],
    missing: [],
    arrived: [],
    staging,
  };
  const staged: StagedOut[] = [];
  const arrived = new Set<number>();
  const arrivedRels = new Set<string>();
  const codexSeen = new Set<number>();
  try {
    const reader = new Reader(body);
    const first = JSON.parse(await reader.line(1024 * 1024)) as {
      totals?: Record<string, unknown>;
    };
    // The space check per file system, before a byte is written.
    const perDev = new Map<number, { path: string; total: number }>();
    // The runner is held to the totals it declares: the space check counts
    // only them, so a record may not add bytes past its index's total.
    const declared = new Map<number, number>();
    let planned = 0;
    for (const [key, value] of Object.entries(first?.totals ?? {})) {
      const source = byIndex.get(Number(key));
      if (!source || !Number.isSafeInteger(value) || (value as number) < 0)
        throw new Error("the runner's totals name no requested source");
      if (declared.has(source.index))
        throw new Error("the runner's totals name a source twice");
      declared.set(source.index, value as number);
      planned += value as number;
      const at = nearestExisting(destRootOf(source));
      const dev = lstatSync(at).dev;
      const entry = perDev.get(dev) ?? { path: at, total: 0 };
      entry.total += value as number;
      perDev.set(dev, entry);
    }
    if (planned > deps.totalMax)
      throw new Error(
        `the member's files take ${planned} bytes; a move takes at most ${deps.totalMax}`,
      );
    for (const { path, total } of perDev.values()) {
      const free = deps.freeBytes(path);
      if (spaceNeeded(total) > free)
        throw Object.assign(
          new Error(
            `not enough free space at ${path}: ${spaceNeeded(total)} bytes needed, ${free} free`,
          ),
          { code: "ENOSPC" },
        );
    }
    let total = 0;
    for (;;) {
      const length = (await reader.exact(4)).readUInt32BE(0);
      if (length === 0) break;
      if (length > 64 * 1024) throw new Error("a record header is too long");
      const header = JSON.parse(
        (await reader.exact(length)).toString("utf8"),
      ) as { index?: unknown; rel?: unknown; size?: unknown };
      const source = byIndex.get(Number(header?.index));
      const dest = recordDest(source, header?.rel);
      if (typeof dest !== "string") throw new Error(dest.refused);
      if (source!.kind === "claude-file" || source!.kind === "codex") {
        if (codexSeen.has(source!.index))
          throw new Error("a second record for one file");
        codexSeen.add(source!.index);
      }
      const size = header.size;
      if (!Number.isSafeInteger(size) || (size as number) < 0)
        throw new Error("a record with a bad size");
      if ((size as number) > deps.fileMax)
        throw new Error(`a file larger than ${deps.fileMax} bytes`);
      const left = declared.get(source!.index);
      if (left === undefined)
        throw new Error("a record for a source the totals do not name");
      if ((size as number) > left)
        throw new Error("the files are larger than the runner's totals");
      declared.set(source!.index, left - (size as number));
      total += size as number;
      if (total > deps.totalMax)
        throw new Error(`the files are larger than ${deps.totalMax} bytes`);
      const path = staging.next(dest);
      const hash = createHash("sha256");
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let left = size as number;
        while (left > 0) {
          const chunk = await reader.some(Math.min(left, 1024 * 1024));
          hash.update(chunk);
          let off = 0;
          while (off < chunk.length)
            off += writeSync(fd, chunk, off, chunk.length - off);
          left -= chunk.length;
        }
      } finally {
        closeSync(fd);
      }
      staged.push({
        source: source!,
        staged: path,
        dest,
        size: size as number,
        sha256: hash.digest("hex"),
      });
      arrived.add(source!.index);
      if (source!.index === 0 && typeof header.rel === "string")
        arrivedRels.add(header.rel);
    }
    // Place: link with no replace.
    for (const file of staged) {
      written.arrived.push({ source: file.source, dest: file.dest });
      written.madeDirs.push(...makeParents(destRootOf(file.source), file.dest));
      try {
        linkSync(file.staged, file.dest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const there = lstatOrNull(file.dest);
        if (
          !there?.isFile() ||
          there.size !== file.size ||
          fileSha256(file.dest) !== file.sha256
        )
          throw new Error(`${file.dest} exists with other content`, {
            cause: error,
          });
        unlinkSync(file.staged);
        continue;
      }
      written.placed.push({ dest: file.dest, ino: lstatSync(file.dest).ino });
      unlinkSync(file.staged);
    }
  } catch (error) {
    undoMoveOut(written);
    throw error;
  }
  for (const source of plan.sources) {
    if (!arrived.has(source.index)) written.missing.push(source.index);
    if (source.kind === "claude-file" && arrived.has(source.index))
      written.pins.push({ ...source.session });
  }
  for (const session of plan.personal)
    if (arrivedRels.has(session.rel))
      written.pins.push({
        agentId: session.agentId,
        sessionId: session.sessionId,
        root: session.root,
      });
  return written;
}

// Remove what a move back placed (a file only while its inode is the one
// placed), the folders it made when empty, and its staging.
export function undoMoveOut(written: WrittenOut): void {
  for (const { dest, ino } of written.placed) {
    const stats = lstatOrNull(dest);
    if (stats?.isFile() && stats.ino === ino) {
      try {
        unlinkSync(dest);
      } catch {}
    }
  }
  for (const dir of [...written.madeDirs].reverse()) {
    try {
      rmdirSync(dir);
    } catch {}
  }
  written.staging.remove();
}

export interface MoveOutResult {
  pins: PinChange[];
  // What came into the office: each file that arrived (a host move's second
  // stage sends exactly these on), the ones this move placed, and the
  // folders it made.
  arrived?: WrittenOut["arrived"];
  placed?: WrittenOut["placed"];
  madeDirs?: string[];
  // Undo the office's side.
  undo(): void;
  // The member's copies go, through the runner; the paths it kept are
  // logged.
  removeMemberCopy(): Promise<void>;
  // The staging folders go.
  done(): void;
}

// files-out on the member's host, written into the office. Throws after
// undoing the office's side.
export async function transferMemberFilesOut(
  plan: MemberMoveOutPlan,
  host: AgentHost,
): Promise<MoveOutResult> {
  const { userId } = plan;
  if (!host.runEntryOut) throw new Error("the member host has no runner");
  const nonce = randomBytes(16).toString("hex");
  const agentRoot = resolve(host.agentRoot());
  clearMoveOutStaging(userId);
  const written = await writeMoveOut(
    plan,
    host.runEntryOut(
      "files-out",
      moveOutRequest(plan, nonce, agentRoot),
      MOVE_IN_TIMEOUT_MS,
    ),
    nonce,
  );
  for (const index of written.missing) {
    const source = plan.sources[index];
    const path =
      source.kind === "codex"
        ? `${source.home} (${source.threadId})`
        : source.path;
    deps.log(`[member-move] ${userId}: nothing came back from ${path}`);
  }
  return {
    pins: written.pins,
    arrived: written.arrived,
    placed: written.placed,
    madeDirs: written.madeDirs,
    undo: () => undoMoveOut(written),
    removeMemberCopy: async () => {
      try {
        const answer = (await host.runEntry(
          "files-remove",
          { nonce, agentRoot },
          MOVE_STEP_TIMEOUT_MS,
        )) as { kept?: unknown } | null;
        const kept = Array.isArray(answer?.kept) ? answer.kept : [];
        for (const path of kept)
          deps.log(
            `[member-move] ${userId}: kept ${String(path)} in the member's home: it changed during the move`,
          );
      } catch (error) {
        deps.log(
          `[member-move] ${userId}: cannot remove the member's copies: ${(error as Error).message}`,
        );
      }
    },
    done: () => written.staging.remove(),
  };
}

// The purge of a removed member who has their own OS user: their trees in
// their agent space go through their runner, as them. A host that is not
// connected leaves them, logged.
export async function purgeMemberAgentSpace(
  userId: string,
  host: AgentHost | undefined,
): Promise<void> {
  if (!host || host.member === undefined) return;
  const agentRoot = resolve(host.agentRoot());
  const memberKey = profileKeyForOwner(userId);
  const trees = [
    join(agentRoot, "provider-homes", userId),
    ...[memberKey, openCodeProfileKey(memberKey, "chat")].map((key) =>
      join(
        agentRoot,
        "opencode",
        "profiles",
        basename(openCodeProfilePaths(key).profileDir),
      ),
    ),
  ];
  try {
    await host.runEntry("files-remove", { agentRoot, trees });
  } catch (error) {
    deps.log(
      `[member-move] ${userId}: cannot remove the agent files of a removed member: ${(error as Error).message}`,
    );
  }
}
