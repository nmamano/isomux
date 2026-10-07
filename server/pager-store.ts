// The pager store: durable page records (internal-docs/pager-design.md).
//
// A page is durable state, not a chat message. Agents and apps raise pages,
// members (and agents in the same rooms) ack and resolve them, and the
// delivery module (server/pager-delivery.ts) sends them to the member's
// Discord through the onRaised and onTransitioned seams below.
//
// Persistence is one JSON array in STATE_ROOT/pager.json. Every write saves
// the NEXT array first and changes memory only after the save returned, so a
// failed save leaves memory and disk in agreement and the caller gets an
// error instead of a page that dies on restart.
//
// Pages are never deleted (Nil, 2026-10-06), but memory and pager.json hold
// only open and acked pages and resolved pages still owed their "resolved"
// message. Every other resolved page moves to the append-only archive
// STATE_ROOT/pager-resolved.jsonl, one page per line, in resolve order. A
// move writes an intent record (the archive's size and the ids), appends,
// saves pager.json without the pages, and clears the record. A crash or a
// failed write between those steps leaves the pages in pager.json and the
// record set; the next write cuts the archive back to the recorded size and
// moves them again, so a page is never lost and never archived twice. (The
// record and pager.json are written with rename but without fsync, so this
// holds for a process that dies or a write that fails, not a power cut.) Reads
// prefer pager.json while a page is in both. The
// previous release reads pager.json unchanged and never touches the archive:
// after a rollback its view lacks the archived pages, and they show again
// after the next update. Archive reads run backward in fixed chunks, off the
// event loop's critical path, and a line that is not a page is skipped and
// counted, never a reason to set the archive aside.
//
// Load posture:
//   - no file                 → no pages (a new or older install)
//   - unparsable / bad shape  → the file is moved aside and the store starts
//                               empty; if it cannot be moved aside, the store
//                               refuses every operation so nothing overwrites
//                               a file a human may still want
//   - unreadable (EACCES...)  → the store refuses every operation; an
//                               unreadable file is not an empty file
//
// LEAF: imports only shared types and the atomic writer, so the state machine
// is unit-testable with an in-memory persistence.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "fs";
import { open } from "fs/promises";
import { dirname } from "path";
import { atomicWriteFileSync } from "./persistence.ts";
import { errMessage } from "../shared/errors.ts";
import {
  comparePagerResolve,
  generatePagerId,
  type PagerDelivery,
  type PagerEntry,
  type PagerSource,
  type PagerTransition,
} from "../shared/types.ts";

// Sanity bounds only. BODY_MAX is not the whole outbound message budget: the
// delivery slice adds the room, the source and a link around it.
export const PAGER_TITLE_MAX = 200;
export const PAGER_BODY_MAX = 2000;
export const PAGER_KEY_MAX = 200;
// Open plus acked pages one source may hold, so a looping agent cannot fill
// the store. A raise that dedupes into an existing page does not count.
export const PAGER_MAX_ACTIVE_PER_SOURCE = 50;

const PAGER_STATES: ReadonlySet<string> = new Set([
  "open",
  "acked",
  "resolved",
]);
const PAGER_DELIVERY_STATES: ReadonlySet<string> = new Set([
  "not_delivered",
  "delivered",
  "failed",
]);

export type PagerLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface PagerPersistence {
  load(): PagerLoadResult;
  // Durable write. MUST THROW on failure.
  save(entries: PagerEntry[]): void;
  // Move a corrupt file aside. False when it could not be moved.
  quarantine(): boolean;
}

export function createPagerFilePersistence(path: string): PagerPersistence {
  return {
    load() {
      // Read first and classify the error: existsSync also answers false
      // when a parent directory is not searchable, and that is not "no file".
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "missing" };
        }
        console.error(`[pager] cannot read ${path}: ${errMessage(err)}`);
        return { kind: "unreadable" };
      }
      try {
        return { kind: "data", value: JSON.parse(text) };
      } catch {
        return { kind: "corrupt" };
      }
    },
    save(entries) {
      atomicWriteFileSync(path, JSON.stringify(entries, null, 2));
    },
    quarantine() {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
        console.error(`[pager] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[pager] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

// The archive of resolved pages: one JSON page per line, newest at the end.
//
// A move is guarded by an intent record beside the archive: the archive's
// size before the append and the ids being moved. It is written before the
// append and cleared after pager.json is saved without those pages. Whoever
// finds it set knows exactly what an interrupted move left behind (see
// recoverMove in createPagerStore), whatever the append managed to write.
export interface PagerMoveIntent {
  size: number;
  ids: string[];
}

export interface PagerArchive {
  // The archive's current size, as truncate() takes it.
  size(): number;
  // Durable append of whole lines, starting on a new line. MUST THROW unless
  // every byte reached the disk.
  append(entries: PagerEntry[]): void;
  // Cut the archive back to `size`. MUST THROW on failure.
  truncate(size: number): void;
  // The intent record: null when none, "corrupt" when it cannot be read.
  readIntent(): PagerMoveIntent | null | "corrupt";
  // Durable write of the intent record. MUST THROW on failure.
  writeIntent(intent: PagerMoveIntent): void;
  clearIntent(): void;
  // The lines in the archive's last `maxBytes`, newest first. Synchronous:
  // the boot reads the newest page's resolve time from it.
  newestLines(maxBytes: number): (string | null)[];
  // Every line, newest first, read in fixed chunks. The lines at the end of
  // the file when the scan starts; a later append is not part of it. null is
  // a line too long to be a page.
  scan(): AsyncIterable<string | null>;
}

const ARCHIVE_CHUNK_BYTES = 64 * 1024;
// The raise bounds keep a page well under this. A longer line is skipped
// instead of held.
const ARCHIVE_LINE_MAX_BYTES = 1024 * 1024;

// Splits a file read from its end into lines, newest first. Feed it the
// chunks from the end toward the start.
class BackwardLines {
  private carry = Buffer.alloc(0);
  private oversized = false;

  push(chunk: Buffer): (string | null)[] {
    const out: (string | null)[] = [];
    const data = Buffer.concat([chunk, this.carry]);
    let end = data.length;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 0x0a) continue;
      if (this.oversized) {
        out.push(null);
        this.oversized = false;
      } else if (end > i + 1) {
        out.push(data.subarray(i + 1, end).toString("utf-8"));
      }
      end = i;
    }
    if (this.oversized || end > ARCHIVE_LINE_MAX_BYTES) {
      this.oversized = true;
      this.carry = Buffer.alloc(0);
    } else {
      this.carry = Buffer.from(data.subarray(0, end));
    }
    return out;
  }

  finish(): (string | null)[] {
    if (this.oversized) return [null];
    return this.carry.length > 0 ? [this.carry.toString("utf-8")] : [];
  }
}

// The file system calls the archive writes through. Tests replace them to
// model a short write or a failed fsync.
export interface PagerArchiveIo {
  writeSync: (
    fd: number,
    buf: Buffer,
    offset: number,
    length: number,
  ) => number;
  fsyncSync: (fd: number) => void;
}

export function createPagerArchiveFile(
  path: string,
  io: PagerArchiveIo = {
    writeSync: (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
    fsyncSync,
  },
): PagerArchive {
  const intentPath = `${path}.move`;
  const size = () => {
    try {
      return statSync(path).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  };
  return {
    size,

    append(entries) {
      if (entries.length === 0) return;
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a+");
      try {
        // A file that does not end in a newline (cut by hand, or by a disk
        // that lost a write) still gets whole lines.
        const at = fstatSync(fd).size;
        let lead = "";
        if (at > 0) {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, at - 1);
          if (last[0] !== 0x0a) lead = "\n";
        }
        const buf = Buffer.from(
          lead + entries.map((e) => JSON.stringify(e) + "\n").join(""),
        );
        // writeSync may take less than it is given.
        let done = 0;
        while (done < buf.length) {
          const n = io.writeSync(fd, buf, done, buf.length - done);
          if (n <= 0) throw new Error("the archive write made no progress");
          done += n;
        }
        io.fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },

    truncate(to) {
      if (size() === to) return;
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, to);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },

    readIntent() {
      let text: string;
      try {
        text = readFileSync(intentPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        return "corrupt";
      }
      try {
        const v = JSON.parse(text) as Partial<PagerMoveIntent>;
        if (
          typeof v.size === "number" &&
          Array.isArray(v.ids) &&
          v.ids.every((id) => typeof id === "string")
        ) {
          return { size: v.size, ids: v.ids };
        }
      } catch {
        // falls through
      }
      return "corrupt";
    },

    writeIntent(intent) {
      atomicWriteFileSync(intentPath, JSON.stringify(intent));
    },

    clearIntent() {
      rmSync(intentPath, { force: true });
    },

    newestLines(maxBytes) {
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      try {
        const lines: (string | null)[] = [];
        const splitter = new BackwardLines();
        const end = fstatSync(fd).size;
        let pos = end;
        while (pos > 0 && end - pos < maxBytes) {
          const n = Math.min(ARCHIVE_CHUNK_BYTES, pos);
          pos -= n;
          const chunk = Buffer.alloc(n);
          const read = readSync(fd, chunk, 0, n, pos);
          lines.push(...splitter.push(chunk.subarray(0, read)));
        }
        if (pos === 0) lines.push(...splitter.finish());
        return lines;
      } finally {
        closeSync(fd);
      }
    },

    async *scan() {
      let handle;
      try {
        handle = await open(path, "r");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      try {
        const splitter = new BackwardLines();
        let pos = (await handle.stat()).size;
        while (pos > 0) {
          const n = Math.min(ARCHIVE_CHUNK_BYTES, pos);
          pos -= n;
          const chunk = Buffer.alloc(n);
          // A recovery may have cut the file since the scan began: what is
          // gone reads as nothing.
          const { bytesRead } = await handle.read(chunk, 0, n, pos);
          yield* splitter.push(chunk.subarray(0, bytesRead));
        }
        yield* splitter.finish();
      } finally {
        await handle.close();
      }
    },
  };
}

// An archive in memory, for tests. `lines` is the file's content, oldest
// first (its size counts lines), and a test may push a raw line into it.
// `tornNextAppend` models an append that wrote part of its batch, cut the
// last line short, and then threw.
export function createMemoryPagerArchive() {
  const a = {
    lines: [] as string[],
    appends: 0,
    failNextAppend: false,
    tornNextAppend: false,
    intent: null as PagerMoveIntent | null | "corrupt",
    size: () => a.lines.length,
    append(entries: PagerEntry[]) {
      if (a.failNextAppend) {
        a.failNextAppend = false;
        throw new Error("disk full");
      }
      const lines = entries.map((e) => JSON.stringify(e));
      if (a.tornNextAppend) {
        a.tornNextAppend = false;
        a.lines.push(...lines.slice(0, -1), lines.at(-1)!.slice(0, 20));
        throw new Error("fsync failed");
      }
      a.appends++;
      a.lines.push(...lines);
    },
    truncate(to: number) {
      a.lines.length = to;
    },
    newestLines: () => a.lines.slice().reverse(),
    readIntent: () => a.intent,
    writeIntent(intent: PagerMoveIntent) {
      a.intent = structuredClone(intent);
    },
    clearIntent() {
      a.intent = null;
    },
    async *scan() {
      const snapshot = a.lines.slice();
      for (let i = snapshot.length - 1; i >= 0; i--) {
        await Promise.resolve();
        yield snapshot[i];
      }
    },
  };
  return a satisfies PagerArchive;
}

// The raise body, after validation. Title is trimmed; an omitted body or key
// stays absent.
export interface PagerRaiseFields {
  title: string;
  body?: string;
  key?: string;
}

// Validate a raise body. Returns the fields, or the message for a 400.
export function parseRaiseFields(
  raw: unknown,
): { ok: true; fields: PagerRaiseFields } | { ok: false; message: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "body must be a JSON object" };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, message: "title is required" };
  }
  const title = body.title.trim();
  if (/[\r\n\u2028\u2029]/.test(title)) {
    return { ok: false, message: "title must be one line" };
  }
  if (title.length > PAGER_TITLE_MAX) {
    return {
      ok: false,
      message: `title is longer than ${PAGER_TITLE_MAX} characters`,
    };
  }
  const fields: PagerRaiseFields = { title };
  if (body.body !== undefined) {
    if (typeof body.body !== "string") {
      return { ok: false, message: "body must be a string" };
    }
    if (body.body.length > PAGER_BODY_MAX) {
      return {
        ok: false,
        message: `body is longer than ${PAGER_BODY_MAX} characters`,
      };
    }
    if (body.body.length > 0) fields.body = body.body;
  }
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || body.key.length === 0) {
      return { ok: false, message: "key must be a non-empty string" };
    }
    if (body.key.length > PAGER_KEY_MAX) {
      return {
        ok: false,
        message: `key is longer than ${PAGER_KEY_MAX} characters`,
      };
    }
    fields.key = body.key;
  }
  return { ok: true, fields };
}

// One identity per source, so an agent and an app with the same id string
// never share pages, and neither do two registrations of one app name.
export function pagerSourceKey(source: PagerSource): string {
  return source.kind === "agent"
    ? `agent:${source.agentId}`
    : `app:${source.appName}:${source.registrationGen}`;
}

function isPagerSource(v: unknown): v is PagerSource {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== "string") return false;
  if (s.kind === "agent") {
    return typeof s.agentId === "string" && typeof s.roomId === "string";
  }
  return (
    s.kind === "app" &&
    typeof s.appName === "string" &&
    typeof s.registrationGen === "number" &&
    (s.roomId === null || typeof s.roomId === "string")
  );
}

// Who is looking at a page: the rooms they can access, their user, and
// whether that user is an office owner.
export interface PagerViewer {
  accessibleRoomIds: ReadonlySet<string>;
  userId: string | null;
  isOfficeOwner: boolean;
}

// The one visibility rule, for the routes and the per-socket event. A viewer
// sees a page when they can access its stored room (the room at the first
// raise; never looked up again). An app page is also visible to the app owner
// (its target) and to office owners, and with a null room only to them.
export function pagerEntryVisible(
  entry: PagerEntry,
  viewer: PagerViewer,
): boolean {
  const roomId = entry.source.roomId;
  if (roomId !== null && viewer.accessibleRoomIds.has(roomId)) return true;
  return (
    entry.source.kind === "app" &&
    (viewer.isOfficeOwner ||
      (viewer.userId !== null && viewer.userId === entry.targetUserId))
  );
}

function isTransition(v: unknown): v is PagerTransition {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.by === "string" && typeof t.at === "number";
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

// Shape check for one persisted record. Field types only: the store does not
// re-run the raise bounds on load, so a constant lowered later does not
// destroy old pages.
export function isPagerEntry(v: unknown): v is PagerEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  const delivery = e.delivery as Record<string, unknown> | null | undefined;
  return (
    typeof e.id === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.lastRaisedAt === "number" &&
    typeof e.raiseCount === "number" &&
    isPagerSource(e.source) &&
    typeof e.targetUserId === "string" &&
    typeof e.title === "string" &&
    isOptionalString(e.body) &&
    isOptionalString(e.key) &&
    typeof e.state === "string" &&
    PAGER_STATES.has(e.state) &&
    (e.acked === undefined || isTransition(e.acked)) &&
    (e.resolved === undefined || isTransition(e.resolved)) &&
    typeof delivery === "object" &&
    delivery !== null &&
    typeof delivery.state === "string" &&
    PAGER_DELIVERY_STATES.has(delivery.state) &&
    typeof delivery.sends === "number" &&
    (delivery.lastAttemptAt === undefined ||
      typeof delivery.lastAttemptAt === "number") &&
    isOptionalString(delivery.lastFailure) &&
    (delivery.resolvedNotice === undefined ||
      delivery.resolvedNotice === "pending" ||
      delivery.resolvedNotice === "done")
  );
}

// The store refuses every operation (see the load posture above).
export class PagerUnavailableError extends Error {
  constructor() {
    super("the pager store is unavailable");
    this.name = "PagerUnavailableError";
  }
}

export type PagerRaiseResult =
  | { outcome: "created" | "updated"; entry: PagerEntry }
  | { outcome: "too_many" };

export type PagerActResult =
  | { outcome: "changed" | "unchanged"; entry: PagerEntry }
  | { outcome: "already_resolved"; entry: PagerEntry }
  | { outcome: "not_found" };

export interface PagerStoreDeps {
  persistence: PagerPersistence;
  // Where resolved pages go. Omitted only by tests: an archive in memory.
  archive?: PagerArchive;
  now?: () => number;
  // Every committed change, for the per-recipient event push.
  onChange?: (entry: PagerEntry) => void;
  // The ONE hand-off to delivery: a new page, or a raise that deduped into
  // an open or acked page. Runs after the commit; a throw or a rejected
  // promise is logged and never undoes or fails the raise.
  onRaised?: (
    entry: PagerEntry,
    kind: "created" | "reraised",
  ) => void | Promise<void>;
  // An ack or a resolve that changed the state, after the commit. Same
  // never-throw rule as onRaised.
  onTransitioned?: (
    entry: PagerEntry,
    to: "acked" | "resolved",
  ) => void | Promise<void>;
}

// One slice of resolved pages, or the answer for a `before` that names no
// resolved page the caller accepts.
export type PagerResolvedSlice =
  | { ok: true; entries: PagerEntry[] }
  | { ok: false };

export interface PagerStore {
  // The pages in memory: open, acked, and resolved pages still owed their
  // "resolved" message. Archived pages are not here.
  list(): PagerEntry[];
  get(id: string): PagerEntry | null;
  // An archived page by id. Null when the id is not archived (an id in
  // memory answers null here; get() has it).
  findArchived(id: string): Promise<PagerEntry | null>;
  // Up to `limit` resolved pages that `accept` keeps, newest-archived first:
  // the resolved pages still in memory (newest resolve first), then the
  // archive from its end. With `before`, the slice starts after that page,
  // which must be one `accept` keeps.
  listResolved(opts: {
    accept: (entry: PagerEntry) => boolean;
    limit: number;
    before?: string;
  }): Promise<PagerResolvedSlice>;
  raise(input: {
    source: PagerSource;
    targetUserId: string;
    fields: PagerRaiseFields;
  }): PagerRaiseResult;
  ack(id: string, by: string): PagerActResult;
  resolve(id: string, by: string): PagerActResult;
  // Replace the delivery block of one page. Null when the page is gone.
  recordDelivery(id: string, delivery: PagerDelivery): PagerEntry | null;
}

const copy = (e: PagerEntry): PagerEntry => structuredClone(e);

const byResolve = comparePagerResolve;

// The pages a save moves to the archive, oldest first: the resolved pages in
// resolve order, up to the first one that still owes its "resolved" message.
// A page that owes it stays in memory and pager.json so delivery can send it.
// That is unfinished work, not history: a message stays owed only behind a
// Discord 429 hold, which drains, or while the pager settings cannot be read,
// which also stops every page send (PM ruling, 2026-10-07). A page whose
// message is done waits behind an older one that is still owed, so the
// archive stays in resolve order: a move never changes a page's place in a
// list of resolved pages, and "Load more" neither skips nor repeats one.
const movable = (pages: PagerEntry[]): PagerEntry[] => {
  const out: PagerEntry[] = [];
  for (const e of pages.filter((p) => p.state === "resolved").sort(byResolve)) {
    if (e.delivery.resolvedNotice === "pending") break;
    out.push(e);
  }
  return out;
};

export function createPagerStore(deps: PagerStoreDeps): PagerStore {
  const now = deps.now ?? (() => Date.now());
  const archive = deps.archive ?? createMemoryPagerArchive();
  let entries: PagerEntry[] = [];
  let available = true;
  // An intent record may be set: at boot until read, and from writing one
  // until it is cleared.
  let intentMaybe = true;
  let skippedLogged = 0;
  // The latest resolve time this office has given, in memory or archived.
  // Every resolve gets a later one, so resolve order (time, then id) is the
  // order pages are resolved in and archived in, across moves and restarts,
  // and the client's cursor (the same comparison) never meets a tie that the
  // archive ordered the other way.
  let lastResolvedAt = 0;
  const noteResolved = (e: PagerEntry) => {
    if (e.resolved && e.resolved.at > lastResolvedAt) {
      lastResolvedAt = e.resolved.at;
    }
  };

  // One archive line as a page, or null for a line that is not one.
  const parseLine = (line: string | null): PagerEntry | null => {
    if (line === null) return null;
    try {
      const v: unknown = JSON.parse(line);
      return isPagerEntry(v) ? v : null;
    } catch {
      return null;
    }
  };

  const reportSkipped = (skipped: number) => {
    if (skipped === 0 || skipped === skippedLogged) return;
    skippedLogged = skipped;
    console.error(
      `[pager] skipped ${skipped} unreadable line(s) in the resolved-page archive`,
    );
  };

  // Finish a move an earlier write left behind. `held` is what pager.json
  // holds now. None of the intent's pages there: the save landed, so only the
  // record remains. All of them there: the save did not land, so whatever
  // the append wrote is cut off and the pages move again. Some: not a state
  // this store writes, so moves stop and nothing is cut. False while a move
  // is not safe.
  const recoverMove = (held: PagerEntry[]): boolean => {
    if (!intentMaybe) return true;
    try {
      const intent = archive.readIntent();
      if (intent === "corrupt") {
        console.error(
          "[pager] the archive move record is unreadable; moves are paused",
        );
        return false;
      }
      if (intent !== null) {
        const ids = new Set(held.map((e) => e.id));
        const present = intent.ids.filter((id) => ids.has(id)).length;
        if (present > 0 && present < intent.ids.length) {
          console.error(
            "[pager] an archive move left pages in both files; moves are paused",
          );
          return false;
        }
        if (present > 0) archive.truncate(intent.size);
        archive.clearIntent();
      }
      intentMaybe = false;
      return true;
    } catch (err) {
      console.error(
        `[pager] cannot finish an archive move: ${errMessage(err)}`,
      );
      return false;
    }
  };

  // Save `next` as pager.json, after moving what it can to the archive: the
  // intent record, then the append, then the save, then the record is
  // cleared. A failed append or record write keeps the pages in pager.json;
  // a failed save throws and leaves the record for the next write to
  // recover. Returns what pager.json now holds.
  const persist = (next: PagerEntry[]): PagerEntry[] => {
    let moving = recoverMove(entries) ? movable(next) : [];
    if (moving.length > 0) {
      try {
        intentMaybe = true;
        archive.writeIntent({
          size: archive.size(),
          ids: moving.map((e) => e.id),
        });
        archive.append(moving);
      } catch (err) {
        console.error(
          `[pager] cannot append to the resolved-page archive: ${errMessage(err)}`,
        );
        moving = [];
      }
    }
    const moved = new Set(moving.map((e) => e.id));
    const kept = moved.size > 0 ? next.filter((e) => !moved.has(e.id)) : next;
    deps.persistence.save(kept);
    if (moved.size > 0) {
      try {
        archive.clearIntent();
        intentMaybe = false;
      } catch (err) {
        console.error(
          `[pager] cannot clear the archive move record: ${errMessage(err)}`,
        );
      }
    }
    return kept;
  };

  const loaded = deps.persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = deps.persistence.quarantine();
  } else if (loaded.kind === "data") {
    const value = loaded.value;
    if (Array.isArray(value) && value.every(isPagerEntry)) {
      entries = value;
    } else {
      available = deps.persistence.quarantine();
    }
  }

  // The newest resolve time: pager.json's resolved pages, and the newest
  // archived page (at most two of the longest lines from the archive's end).
  if (available) {
    for (const e of entries) noteResolved(e);
    try {
      for (const line of archive.newestLines(2 * ARCHIVE_LINE_MAX_BYTES)) {
        const e = parseLine(line);
        if (e) {
          noteResolved(e);
          break;
        }
      }
    } catch (err) {
      console.error(
        `[pager] cannot read the newest archived page: ${errMessage(err)}`,
      );
    }
  }

  // Boot: finish a move a crash interrupted, and move what pager.json holds
  // that belongs in the archive (all its resolved pages after an update from
  // a release without the archive, in resolve order). A failure leaves them
  // in pager.json for the next write.
  if (available) {
    try {
      const pending = archive.readIntent() !== null;
      if (!pending) intentMaybe = false;
      if (pending || movable(entries).length > 0) entries = persist(entries);
    } catch (err) {
      console.error(
        `[pager] cannot move resolved pages to the archive: ${errMessage(err)}`,
      );
    }
  }

  const ensureAvailable = () => {
    if (!available) throw new PagerUnavailableError();
  };

  // Save first, then commit, then notify.
  const commit = (next: PagerEntry[], changed: PagerEntry) => {
    entries = persist(next);
    try {
      deps.onChange?.(copy(changed));
    } catch (err) {
      console.error(`[pager] change listener failed: ${errMessage(err)}`);
    }
  };

  // A listener's throw or rejected promise is logged and never undoes or
  // fails the operation that committed.
  const notify = (entry: PagerEntry, call: () => void | Promise<void>) => {
    const fail = (err: unknown) =>
      console.error(
        `[pager] delivery hand-off failed for ${entry.id}: ${errMessage(err)}`,
      );
    try {
      const r = call();
      if (r instanceof Promise) r.catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  const handOff = (entry: PagerEntry, kind: "created" | "reraised") => {
    const onRaised = deps.onRaised;
    if (onRaised) notify(entry, () => onRaised(copy(entry), kind));
  };

  const replace = (updated: PagerEntry): PagerEntry[] =>
    entries.map((e) => (e.id === updated.id ? updated : e));

  const transition = (
    id: string,
    by: string,
    to: "acked" | "resolved",
  ): PagerActResult => {
    ensureAvailable();
    const current = entries.find((e) => e.id === id);
    if (!current) return { outcome: "not_found" };
    if (current.state === to) {
      return { outcome: "unchanged", entry: copy(current) };
    }
    if (current.state === "resolved") {
      return { outcome: "already_resolved", entry: copy(current) };
    }
    const at = to === "resolved" ? Math.max(now(), lastResolvedAt + 1) : now();
    const updated: PagerEntry = {
      ...copy(current),
      state: to,
      [to]: { by, at },
    };
    // Recorded in the same commit as the resolve, so a restart right after it
    // still owes the member the "resolved" message.
    if (to === "resolved") updated.delivery.resolvedNotice = "pending";
    commit(replace(updated), updated);
    if (to === "resolved") noteResolved(updated);
    const onTransitioned = deps.onTransitioned;
    if (onTransitioned) {
      notify(updated, () => onTransitioned(copy(updated), to));
    }
    return { outcome: "changed", entry: copy(updated) };
  };

  return {
    list() {
      ensureAvailable();
      return entries.map(copy);
    },

    get(id) {
      ensureAvailable();
      const e = entries.find((x) => x.id === id);
      return e ? copy(e) : null;
    },

    async findArchived(id) {
      ensureAvailable();
      if (entries.some((e) => e.id === id)) return null;
      let skipped = 0;
      try {
        for await (const line of archive.scan()) {
          const e = parseLine(line);
          if (!e) skipped++;
          else if (e.id === id) return e;
        }
        return null;
      } finally {
        reportSkipped(skipped);
      }
    },

    async listResolved({ accept, limit, before }) {
      ensureAvailable();
      const inMemory = new Set(entries.map((e) => e.id));
      const owed = entries
        .filter((e) => e.state === "resolved")
        .sort((a, b) => byResolve(b, a))
        .map(copy);
      const out: PagerEntry[] = [];
      let started = before === undefined;
      // False once the slice is full.
      const take = (e: PagerEntry): boolean => {
        if (!accept(e)) return true;
        if (!started) {
          started = e.id === before;
          return true;
        }
        out.push(e);
        return out.length < limit;
      };
      for (const e of owed) {
        if (!take(e)) return { ok: true, entries: out };
      }
      let skipped = 0;
      try {
        for await (const line of archive.scan()) {
          const e = parseLine(line);
          if (!e) {
            skipped++;
            continue;
          }
          // In memory too: a move whose pager.json save has not landed yet.
          if (inMemory.has(e.id)) continue;
          if (!take(e)) break;
        }
      } finally {
        reportSkipped(skipped);
      }
      return started ? { ok: true, entries: out } : { ok: false };
    },

    raise({ source, targetUserId, fields }) {
      ensureAvailable();
      const sourceKey = pagerSourceKey(source);
      const t = now();
      // At most one open or acked page per (source, key): a raise with the
      // same key updates it. A raise on an acked page does not re-open it.
      const existing =
        fields.key === undefined
          ? undefined
          : entries.find(
              (e) =>
                e.state !== "resolved" &&
                e.key === fields.key &&
                pagerSourceKey(e.source) === sourceKey,
            );
      if (existing) {
        // Room, source name and target stay as at the first raise. An omitted
        // body clears the old one: the newest raise describes the incident.
        const updated: PagerEntry = {
          ...copy(existing),
          title: fields.title,
          lastRaisedAt: t,
          raiseCount: existing.raiseCount + 1,
        };
        if (fields.body === undefined) delete updated.body;
        else updated.body = fields.body;
        commit(replace(updated), updated);
        handOff(updated, "reraised");
        return { outcome: "updated", entry: copy(updated) };
      }
      const active = entries.filter(
        (e) => e.state !== "resolved" && pagerSourceKey(e.source) === sourceKey,
      ).length;
      if (active >= PAGER_MAX_ACTIVE_PER_SOURCE) return { outcome: "too_many" };
      const entry: PagerEntry = {
        id: generatePagerId(entries.map((e) => e.id)),
        createdAt: t,
        lastRaisedAt: t,
        raiseCount: 1,
        source: { ...source },
        targetUserId,
        title: fields.title,
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.key !== undefined ? { key: fields.key } : {}),
        state: "open",
        delivery: { state: "not_delivered", sends: 0 },
      };
      commit([...entries, entry], entry);
      handOff(entry, "created");
      return { outcome: "created", entry: copy(entry) };
    },

    ack(id, by) {
      return transition(id, by, "acked");
    },

    resolve(id, by) {
      return transition(id, by, "resolved");
    },

    recordDelivery(id, delivery) {
      ensureAvailable();
      const current = entries.find((e) => e.id === id);
      if (!current) return null;
      const updated: PagerEntry = {
        ...copy(current),
        delivery: { ...delivery },
      };
      commit(replace(updated), updated);
      return copy(updated);
    },
  };
}
