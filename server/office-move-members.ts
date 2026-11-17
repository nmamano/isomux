// The homes of members with their own OS user at an office move, on the old
// office (task 78733adf, slice 5c-1; design: internal-docs/office-move-design.md
// "Members with their own OS user"). The office cannot read her home: her
// runner lists it and sends its files, as her (server/member-home-send.ts).
//
// Every runner reply is member data (internal-docs/member-os-user-design.md
// 1.1): the office checks each listing line (normalised relative path,
// listed once, in walk order, its parent listed, in memberHomeScope, a
// bounded line), forwards only the bytes it asked for, computes every hash
// itself, and bounds every stream in stalls and in total time.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { AgentUnit, MoveMemberInfo } from "../shared/office-move.ts";
import {
  readRunnerInfo,
  runRunnerEntryOut,
  type RunnerInfo,
  type RunnerTarget,
} from "./agent-runner/client.ts";
import {
  MEMBER_HOME_LINE_MAX,
  memberHomeRelPath,
  memberHomeScope,
  type HomeFilesInput,
  type HomeListInput,
} from "./member-home-send.ts";
import {
  compareMoveWalkOrder,
  moveRecords,
  type MoveBatchItem,
  type MoveBatchOpts,
  type MoveManifestEntry,
  type MoveManifestSummary,
} from "./office-move-pull.ts";
import {
  restoreUnits,
  type UnitRestoreResult,
  type UnitRunner,
} from "./office-move-units.ts";

export type { MoveMemberBlock, MoveMemberInfo } from "../shared/office-move.ts";

/** A member whose home moves, as the lock recorded her in the state `move`
 *  (the MOVE-locked server loads no records). */
export interface MoveMember {
  userId: string;
  name: string;
  osUser: string;
  uid: number;
  /** From passwd, checked by moveMemberHomeRefusal. */
  home: string;
  /** The runtime hash her runner reported at the lock, equal to this
   *  office's (C2). */
  bundleHash: string;
}

/** One member's home in a ready manifest. Its entries are relative to
 *  `home`; `?member=<i>` of the data route and a batch's `member: i` index
 *  this list. */
export interface MoveMemberManifest extends MoveManifestSummary {
  userId: string;
  osUser: string;
  home: string;
}

/** The streams of one member's runner. Production: runnerMemberHomeSource.
 *  Tests: a fake per member index. */
export interface MemberHomeStreams {
  list(input: HomeListInput, signal: AbortSignal): AsyncIterable<Uint8Array>;
  files(input: HomeFilesInput, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export type MemberHomeSource = (
  member: MoveMember,
  index: number,
) => MemberHomeStreams;

/** A member's stream sent nothing for this long (C1). */
export const MEMBER_HOME_STALL_MS = 60_000;
/** The longest one home-list or home-files call may run (C1). */
export const MEMBER_HOME_CALL_MS = 60 * 60_000;
/** The most unreadable paths a member's walk keeps: they stay in memory for
 *  the status, so a runner that sends no end fails her walk here (C3). */
export const MEMBER_HOME_UNREADABLE_MAX = 10_000;
/** The free bytes a member's walk keeps on the manifest's file system (C3). */
export const MEMBER_HOME_FREE_FLOOR_BYTES = 1024 * 1024 * 1024;

/** One member as the office's records give her (member-os-users.json). */
export interface MoveMemberRecord {
  userId: string;
  /** Her name, or null when no user has the id. */
  name: string | null;
  /** null when her entry is malformed. */
  osUser: { name: string; uid: number } | null;
  /** Her enable did not finish (`moving`). */
  unfinished: boolean;
  /** She came with a move; the enable command has not run here (5c-2). */
  movedIn: boolean;
  /** Task e15a82e7: she runs as a person's existing OS user (enable
   *  --existing-user); a move would carry that person's whole home. */
  adopted?: boolean;
}

export interface MoveMembersDeps {
  /** The records, read now, with no cache. */
  records(): { broken: true } | { members: MoveMemberRecord[] };
  /** passwd: her uid and home, or null. */
  passwd(osUser: string): { uid: number; home: string } | null;
  /** An enable's go-on or a disable runs for her. */
  busy(userId: string): boolean;
  /** Her runner's info answer, with the peer check on the socket. Rejects
   *  when it does not answer in its bound. */
  info(osUser: { name: string; uid: number }): Promise<RunnerInfo>;
  /** The runtime hash of this office's member bundle. */
  expectedHash(): Promise<string>;
  /** Her agent-made user units, through her runner (Q5). Throws when her
   *  runner cannot be asked. */
  listUnits(member: MoveMember): AgentUnit[];
  officeHome: string;
  stateRoot: string;
  /** Tests: lstat of her home. */
  lstat?: (path: string) => {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
  } | null;
}

export type MoveMembersCheck =
  | { broken: true }
  | {
      /** Every member with her block (null: ready). */
      members: MoveMemberInfo[];
      /** The ready members, as the lock records them. */
      ready: MoveMember[];
    };

const realLstat: NonNullable<MoveMembersDeps["lstat"]> = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Whether `child` is `parent` or inside it (both absolute, normalised). */
function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(p);
}

/** C5: why her passwd home cannot be walked, or null. Absolute, normalised,
 *  not "/", not the office home, not in the office home or the state root
 *  nor above them, and an lstat folder (not a link) owned by her uid. */
export function moveMemberHomeRefusal(
  home: string,
  ctx: {
    uid: number;
    officeHome: string;
    stateRoot: string;
    lstat?: MoveMembersDeps["lstat"];
  },
): string | null {
  if (typeof home !== "string" || !isAbsolute(home))
    return "the home is not an absolute path";
  if (normalize(home) !== home || (home.length > 1 && home.endsWith("/")))
    return `the home ${home} is not a normalised path`;
  if (home === "/") return "the home is the root folder";
  for (const [what, path] of [
    ["the office user's home", ctx.officeHome],
    ["the office's state folder", ctx.stateRoot],
  ] as const)
    if (inside(home, path) || inside(path, home))
      return `the home ${home} holds or is inside ${what}`;
  const st = (ctx.lstat ?? realLstat)(home);
  if (!st) return `the home ${home} is missing`;
  if (st.isSymbolicLink()) return `the home ${home} is a link`;
  if (!st.isDirectory()) return `the home ${home} is not a folder`;
  if (st.uid !== ctx.uid)
    return `the home ${home} belongs to uid ${st.uid}, not ${ctx.uid}`;
  return null;
}

/** The longest block detail, in characters: a detail can quote her runner. */
const DETAIL_MAX = 200;

/** The preflight's and the lock's check of the members (D1, D2, C2, C5,
 *  C6). The lock refuses 409 member_os_users when the check is broken or
 *  any member has a block. */
export async function checkMoveMembers(
  deps: MoveMembersDeps,
): Promise<MoveMembersCheck> {
  const read = deps.records();
  if ("broken" in read) return { broken: true };
  const members: MoveMemberInfo[] = [];
  const ready: MoveMember[] = [];
  let expected: string | null = null;
  for (const rec of read.members) {
    const name = rec.name ?? rec.userId;
    const info: MoveMemberInfo = {
      userId: rec.userId,
      name,
      osUser: rec.osUser?.name ?? null,
      home: null,
      block: null,
    };
    members.push(info);
    const block = (b: MoveMemberInfo["block"], detail?: string) => {
      info.block = b;
      // Her runner's words: cut, so a forged runner cannot grow the body.
      if (detail)
        info.detail =
          detail.length > DETAIL_MAX
            ? `${detail.slice(0, DETAIL_MAX)}…`
            : detail;
    };
    const os = rec.osUser;
    if (!os) {
      block("broken");
      continue;
    }
    if (rec.unfinished) {
      block("unfinished");
      continue;
    }
    if (deps.busy(rec.userId)) {
      block("busy");
      continue;
    }
    if (rec.movedIn) {
      block("moved_in");
      continue;
    }
    if (rec.adopted) {
      block("adopted");
      continue;
    }
    const pw = deps.passwd(os.name);
    if (!pw || pw.uid !== os.uid) {
      block(
        "bad_home",
        pw
          ? `${os.name} has uid ${pw.uid} here, not ${os.uid}`
          : `no OS user ${os.name}`,
      );
      continue;
    }
    info.home = pw.home;
    const homeRefusal = moveMemberHomeRefusal(pw.home, {
      uid: os.uid,
      officeHome: deps.officeHome,
      stateRoot: deps.stateRoot,
      lstat: deps.lstat,
    });
    if (homeRefusal) {
      block("bad_home", homeRefusal);
      continue;
    }
    let answer: RunnerInfo;
    try {
      answer = await deps.info(os);
    } catch (err) {
      block("runner_down", (err as Error).message);
      continue;
    }
    if (
      answer.uid !== os.uid ||
      answer.user !== os.name ||
      answer.home !== pw.home
    ) {
      block(
        "wrong_runner",
        `the runner answers as ${answer.user} (uid ${answer.uid}, home ${answer.home})`,
      );
      continue;
    }
    expected ??= await deps.expectedHash();
    if (answer.bundleHash !== expected) {
      block(
        "old_runtime",
        `the runner runs ${answer.bundleHash ?? "an unknown runtime"}, this office ${expected}`,
      );
      continue;
    }
    const member: MoveMember = {
      userId: rec.userId,
      name,
      osUser: os.name,
      uid: os.uid,
      home: pw.home,
      bundleHash: expected,
    };
    try {
      info.units = deps.listUnits(member);
    } catch (err) {
      block("runner_down", (err as Error).message);
      continue;
    }
    ready.push(member);
  }
  return { members, ready };
}

/** The lock's 409 member_os_users body for a check, or null when every
 *  member is ready. */
export function moveMembersLockRefusal(
  check: MoveMembersCheck,
): { broken: true } | { names: string[]; members: MoveMemberInfo[] } | null {
  if ("broken" in check) return { broken: true };
  const blocked = check.members.filter((m) => m.block !== null);
  if (blocked.length === 0) return null;
  return { names: blocked.map((m) => m.name), members: check.members };
}

// ---- her runner ----

/** Production source: each stream checks her runner's info first (uid,
 *  user, home and runtime hash equal to the member's record, D7, C2), then
 *  runs the entry on her recorded socket with the stall and total bounds
 *  (C1). */
export function runnerMemberHomeSource(opts: {
  socketPath: (osUser: string) => string;
  readPeerUid: (fd: number) => number | null;
  stallMs?: number;
  callMs?: number;
}): MemberHomeSource {
  const stallMs = opts.stallMs ?? MEMBER_HOME_STALL_MS;
  const callMs = opts.callMs ?? MEMBER_HOME_CALL_MS;
  return (member) => {
    async function* run(
      name: "home-list" | "home-files",
      input: HomeListInput | HomeFilesInput,
      signal: AbortSignal,
    ): AsyncGenerator<Uint8Array> {
      const target: RunnerTarget = {
        path: opts.socketPath(member.osUser),
        peer: { uid: member.uid, read: opts.readPeerUid },
      };
      const started = Date.now();
      if (signal.aborted) throw new Error("stopped");
      const info = await readRunnerInfo(target, Math.min(stallMs, callMs));
      if (
        info.uid !== member.uid ||
        info.user !== member.osUser ||
        info.home !== member.home
      )
        throw new Error(
          `the runner of ${member.name} answers as ${info.user} (uid ${info.uid}, home ${info.home})`,
        );
      if (info.bundleHash !== member.bundleHash)
        throw new Error(
          `the runner of ${member.name} runs another runtime than at the lock`,
        );
      const left = callMs - (Date.now() - started);
      if (left <= 0) throw new Error("timed out");
      yield* runRunnerEntryOut(target, name, input, left, stallMs, signal);
    }
    return {
      list: (input, signal) => run("home-list", input, signal),
      files: (input, signal) => run("home-files", input, signal),
    };
  };
}

/** The next chunk of `it`, or a throw when `signal` aborts first (a quiet
 *  runner never answers next()). */
async function nextOrStop(
  it: AsyncIterator<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (!signal) return it.next();
  if (signal.aborted) throw new MemberStopped();
  let onAbort: (() => void) | null = null;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new MemberStopped());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([it.next(), stopped]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

class MemberStopped extends Error {
  constructor() {
    super("The move pairing ended.");
    this.name = "MemberStopped";
  }
}

const newNonce = () => randomBytes(16).toString("hex");

function freeBytesOf(path: string): number {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

/** A free-space check of the manifest's file system after this many bytes
 *  of NDJSON (C3). */
const FREE_CHECK_EVERY_BYTES = 10 * 1024 * 1024;

class LineRefused extends Error {}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One listing line as a manifest entry (x for a special), or a refusal. */
function parseLine(
  v: unknown,
): MoveManifestEntry | { p: string; t: "x" } | { u: string } | { end: true } {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new LineRefused("a line is not a JSON object");
  const r = v as Record<string, unknown>;
  if (r.end === true && Object.keys(r).length === 1) return { end: true };
  if ("u" in r && Object.keys(r).length === 1) {
    if (!memberHomeRelPath(r.u))
      throw new LineRefused("an unreadable path is not a plain path");
    return { u: r.u };
  }
  const { p, t, s, m, mode, l, q } = r;
  if (!memberHomeRelPath(p))
    throw new LineRefused(`${JSON.stringify(p)} is not a plain path`);
  if (t !== "f" && t !== "d" && t !== "l" && t !== "x")
    throw new LineRefused(`${p} has an unknown type`);
  if (!Number.isSafeInteger(s) || (s as number) < 0)
    throw new LineRefused(`${p} has a bad size`);
  if (!isNum(m)) throw new LineRefused(`${p} has a bad mtime`);
  if (
    !Number.isSafeInteger(mode) ||
    (mode as number) < 0 ||
    (mode as number) > 0o7777
  )
    throw new LineRefused(`${p} has a bad mode`);
  if (t === "l" ? typeof l !== "string" : l !== undefined)
    throw new LineRefused(`${p} has a bad link target`);
  if (q !== undefined && !(q === 1 && t === "f"))
    throw new LineRefused(`${p} has a bad SQLite flag`);
  if (t === "x") return { p, t };
  return {
    p,
    t,
    s: s as number,
    m,
    mode: mode as number,
    ...(t === "l" ? { l: l as string } : {}),
    ...(q === 1 ? { q: 1 as const } : {}),
  };
}

/** Walks her home through `streams` into `file` (the office's manifest
 *  NDJSON). Fails (the pass fails, naming her) on a bad line, a line over
 *  MEMBER_HOME_LINE_MAX, more than MEMBER_HOME_UNREADABLE_MAX unreadable
 *  paths, a stream that stalls or runs too long, or when the
 *  file's file system has less than the floor free (C3, C4, Q3). */
export async function walkMemberHome(
  member: MoveMember,
  streams: MemberHomeStreams,
  file: string,
  opts: {
    signal: AbortSignal;
    onProgress?: (entries: number) => void;
    /** Tests: the free bytes of the manifest's file system. */
    freeBytes?: (path: string) => number;
    freeFloorBytes?: number;
  },
): Promise<MoveMemberManifest> {
  const fail = (reason: string) =>
    new Error(
      `The home of ${member.name} (${member.osUser}) cannot be copied: ${reason}. If this keeps failing, turn off their own OS user before the move.`,
    );
  const floor = opts.freeFloorBytes ?? MEMBER_HOME_FREE_FLOOR_BYTES;
  const free = opts.freeBytes ?? freeBytesOf;
  const folder = dirname(file);
  const checkFree = () => {
    if (free(folder) < floor)
      throw fail("the disk of the office is almost full");
  };
  const summary: MoveMemberManifest = {
    userId: member.userId,
    osUser: member.osUser,
    home: member.home,
    entries: 0,
    totalBytes: 0,
    excluded: [],
    skipped: 0,
    unreadable: [],
  };
  checkFree();
  const out = openSync(file, "w", 0o600);
  chmodSync(file, 0o600);
  const listed = streams.list(
    { home: member.home, nonce: newNonce() },
    opts.signal,
  );
  const it = listed[Symbol.asyncIterator]();
  let ok = false;
  try {
    const dirs = new Set<string>([""]);
    let prev: string | null = null;
    let ended = false;
    let partial: Buffer[] = [];
    let partialBytes = 0;
    let pending = "";
    let sinceCheck = 0;
    const flush = (force: boolean) => {
      if (pending.length > 0 && (force || pending.length > 1024 * 1024)) {
        writeSync(out, pending);
        sinceCheck += Buffer.byteLength(pending);
        pending = "";
        if (sinceCheck >= FREE_CHECK_EVERY_BYTES) {
          sinceCheck = 0;
          checkFree();
        }
      }
    };
    const line = (text: string) => {
      if (ended) throw new LineRefused("a line comes after the end line");
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        throw new LineRefused("a line is not JSON");
      }
      const e = parseLine(v);
      if ("end" in e) {
        ended = true;
        return;
      }
      if ("u" in e) {
        if (summary.unreadable.length >= MEMBER_HOME_UNREADABLE_MAX)
          throw new LineRefused("it lists too many unreadable paths");
        summary.unreadable.push(e.u);
        return;
      }
      if (prev !== null && compareMoveWalkOrder(prev, e.p) >= 0)
        throw new LineRefused(`${e.p} is out of order or listed twice`);
      prev = e.p;
      const slash = e.p.lastIndexOf("/");
      if (!dirs.has(slash < 0 ? "" : e.p.slice(0, slash)))
        throw new LineRefused(`the folder of ${e.p} is not listed`);
      const kind = e.t === "d" ? "dir" : e.t === "l" ? "symlink" : "file";
      if (!memberHomeScope(e.p, kind).in)
        throw new LineRefused(`${e.p} is not part of the move`);
      if (e.t === "x") {
        summary.skipped++;
        return;
      }
      if (e.t === "d") dirs.add(e.p);
      if (e.t === "f") summary.totalBytes += e.s;
      summary.entries++;
      pending += `${JSON.stringify(e)}\n`;
      flush(false);
    };
    for (;;) {
      const r = await nextOrStop(it, opts.signal);
      if (r.done) break;
      let chunk = Buffer.from(r.value);
      for (;;) {
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) break;
        const head = chunk.subarray(0, nl);
        if (partialBytes + head.length > MEMBER_HOME_LINE_MAX)
          throw new LineRefused("a line is too long");
        const text = Buffer.concat([...partial, head]).toString("utf8");
        partial = [];
        partialBytes = 0;
        chunk = chunk.subarray(nl + 1);
        if (text !== "") line(text);
      }
      if (chunk.length > 0) {
        partial.push(chunk);
        partialBytes += chunk.length;
        if (partialBytes > MEMBER_HOME_LINE_MAX)
          throw new LineRefused("a line is too long");
      }
      opts.onProgress?.(summary.entries);
    }
    if (partialBytes > 0) throw new LineRefused("the listing is cut");
    if (!ended) throw new LineRefused("the listing has no end line");
    flush(true);
    ok = true;
    return summary;
  } catch (err) {
    if (err instanceof MemberStopped) throw err;
    if (err instanceof Error && err.message.startsWith("The home of "))
      throw err;
    throw fail(
      err instanceof LineRefused
        ? `their OS user sent a listing the office cannot use (${err.message})`
        : (err as Error).message,
    );
  } finally {
    closeSync(out);
    if (!ok) {
      rmSync(file, { force: true });
      // A quiet runner never answers: do not wait for its return().
      void it.return?.().catch(() => {});
    }
  }
}

// ---- the batch ----

/** A frame of home-files longer than this is not a header or a trailer. */
const JSON_FRAME_MAX = 64 * 1024;

class FrameRefused extends Error {}

/** Reads the u32-length frames of home-files. */
class FrameReader {
  private chunks: Buffer[] = [];
  private length = 0;
  constructor(
    private it: AsyncIterator<Uint8Array>,
    private signal: AbortSignal | undefined,
  ) {}

  private async fill(n: number): Promise<boolean> {
    while (this.length < n) {
      const r = await nextOrStop(this.it, this.signal);
      if (r.done) return false;
      const b = Buffer.from(r.value);
      this.chunks.push(b);
      this.length += b.length;
    }
    return true;
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(n)];
    this.length -= n;
    return all.subarray(0, n);
  }

  /** The next frame's payload, at most `max` bytes; null at the end frame. */
  async next(max: number): Promise<Buffer | null> {
    if (!(await this.fill(4))) throw new FrameRefused("the stream is cut");
    const len = this.take(4).readUInt32BE(0);
    if (len === 0) return null;
    if (len > max) throw new FrameRefused("a frame is too long");
    if (!(await this.fill(len))) throw new FrameRefused("the stream is cut");
    return this.take(len);
  }

  async json(): Promise<Record<string, unknown>> {
    const payload = await this.next(JSON_FRAME_MAX);
    if (payload === null) throw new FrameRefused("the stream ends too soon");
    let v: unknown;
    try {
      v = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new FrameRefused("a frame is not JSON");
    }
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new FrameRefused("a frame is not a JSON object");
    return v as Record<string, unknown>;
  }

  close(): void {
    void this.it.return?.().catch(() => {});
  }
}

/** The item's range, or a refusal. */
function rangeOf(item: MoveBatchItem): { offset?: number; length?: number } {
  if (item.offset === undefined && item.length === undefined) return {};
  const offset = item.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("the range's offset is not a whole number of bytes");
  if (
    item.length !== undefined &&
    (!Number.isSafeInteger(item.length) || item.length < 1)
  )
    throw new Error("the range's length is not a whole number of bytes");
  return {
    offset,
    ...(item.length !== undefined ? { length: item.length } : {}),
  };
}

/** A batch of her files as the office's plaintext record stream
 *  (writeMoveBatch's format): each item is checked again (normalised, in
 *  memberHomeScope), and every frame of her runner is checked against the
 *  request (D6). Snapshots: opts.snapshots (the state `move`). */
export async function* writeMemberBatch(
  member: MoveMember,
  streams: MemberHomeStreams,
  items: MoveBatchItem[],
  opts: MoveBatchOpts = {},
): AsyncGenerator<Uint8Array> {
  const snapshots = opts.snapshots !== false;
  // What the office could have listed; the rest gets an error record and is
  // never asked of her runner.
  type Step =
    | { path: string; refused: string }
    | {
        path: string;
        refused?: undefined;
        i: number;
        range: { offset?: number; length?: number };
      };
  const plan = items.map((item, i): Step => {
    const path = typeof item?.path === "string" ? item.path : "";
    if (!memberHomeRelPath(path) || !memberHomeScope(path, "file").in)
      return { path, refused: "The path is not part of the move." };
    try {
      return { path, i, range: rangeOf(item) };
    } catch (err) {
      return { path, refused: `${(err as Error).message}.` };
    }
  });
  const asked: HomeFilesInput["items"] = [];
  for (const step of plan)
    if (step.refused === undefined)
      asked.push({ i: step.i, p: step.path, ...step.range });
  let reader: FrameReader | null = null;
  if (asked.length > 0) {
    const sent = streams.files(
      {
        home: member.home,
        nonce: newNonce(),
        snapshot: snapshots,
        items: asked,
      },
      opts.signal ?? new AbortController().signal,
    );
    reader = new FrameReader(sent[Symbol.asyncIterator](), opts.signal);
  }
  let broken: string | null = null;
  try {
    for (const step of plan) {
      if (opts.signal?.aborted) throw new MemberStopped();
      if (step.refused !== undefined) {
        yield moveRecords.error(step.path, step.refused);
        continue;
      }
      if (broken !== null) {
        yield moveRecords.error(step.path, broken);
        continue;
      }
      try {
        const head = await reader!.json();
        if (typeof head.error === "string" && head.i === step.i) {
          yield moveRecords.error(
            step.path,
            `Their OS user could not read it: ${head.error.slice(0, 500)}`,
          );
          continue;
        }
        const { offset, length } = step.range;
        if (
          head.i !== step.i ||
          head.p !== step.path ||
          !Number.isSafeInteger(head.mode) ||
          !isNum(head.mtime) ||
          !Number.isSafeInteger(head.size) ||
          (head.size as number) < 0 ||
          (head.q !== undefined && head.q !== 1) ||
          head.offset !== offset ||
          (length !== undefined && (head.size as number) > length)
        )
          throw new FrameRefused("a header does not match the request");
        if (head.q === 1 && (!snapshots || offset !== undefined))
          throw new FrameRefused("a SQLite file came where none may come");
        const size = head.size as number;
        yield moveRecords.entry({
          path: step.path,
          mode: (head.mode as number) & 0o7777,
          mtime: head.mtime,
          ...(head.q === 1 ? { q: 1 as const } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        const hash = createHash("sha256");
        let got = 0;
        while (got < size) {
          const data = await reader!.next(size - got);
          if (data === null)
            throw new FrameRefused("the stream ends in a file");
          if (data.length === 0) throw new FrameRefused("an empty frame");
          hash.update(data);
          got += data.length;
          for (let at = 0; at < data.length; at += moveRecords.dataMax)
            yield moveRecords.data(data.subarray(at, at + moveRecords.dataMax));
        }
        const tail = await reader!.json();
        if (tail.i !== step.i || tail.end !== true)
          throw new FrameRefused("a trailer does not match the request");
        yield moveRecords.end({
          bytes: size,
          sha256: hash.digest("hex"),
          ...(tail.changed === true ? { changed: true as const } : {}),
        });
      } catch (err) {
        if (err instanceof MemberStopped) throw err;
        broken = `Their OS user sent what the office did not ask for: ${(err as Error).message}.`;
        yield moveRecords.error(step.path, broken);
      }
    }
  } finally {
    reader?.close();
  }
}

// ---- her agent-made user units (Q5) ----

/** The record of the members' units the lock changed, in the state root,
 *  written before any change. Her entry goes when her units are restored. */
export const MOVE_MEMBER_UNITS_FILE = "move-member-units.json";

export interface MoveMemberUnits {
  userId: string;
  osUser: string;
  units: AgentUnit[];
}

export function writeMemberUnitsRecord(
  stateRoot: string,
  records: MoveMemberUnits[],
): void {
  const path = join(stateRoot, MOVE_MEMBER_UNITS_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readMemberUnitsRecord(stateRoot: string): MoveMemberUnits[] {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(stateRoot, MOVE_MEMBER_UNITS_FILE), "utf8"),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        "[move] the members' units record is unreadable:",
        (err as Error).message,
      );
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is MoveMemberUnits =>
      !!r &&
      typeof r === "object" &&
      typeof (r as MoveMemberUnits).userId === "string" &&
      typeof (r as MoveMemberUnits).osUser === "string" &&
      Array.isArray((r as MoveMemberUnits).units),
  );
}

/** Restores her recorded units through `run` (her runner) and removes her
 *  entry. null when the record has no entry for her. Runs at her runner's
 *  first connect after a normal boot (a cancel; 5c-2: after go-on places a
 *  moved-in home). */
export function restoreMemberUnits(
  stateRoot: string,
  userId: string,
  run: UnitRunner,
): UnitRestoreResult | null {
  const records = readMemberUnitsRecord(stateRoot);
  const mine = records.find((r) => r.userId === userId);
  if (!mine) return null;
  const result = restoreUnits(run, mine.units);
  writeMemberUnitsRecord(
    stateRoot,
    records.filter((r) => r.userId !== userId),
  );
  return result;
}
