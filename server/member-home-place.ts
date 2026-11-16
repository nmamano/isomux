// The office's side of the place of a moved home (task 78733adf, slice
// 5c-2; design: internal-docs/office-move-design.md "Members with their own
// OS user (slice 5c)"). In the enable command's go-on for a movedIn member,
// the office walks her stage (<state>/move-members/<userId>/home) with
// lstat, never following a link, and streams it to her new runner's
// tree-in (member-home-receive.ts), then runs tree-place. The office gives
// its own stage folders u+rwx only to read them (D4). A stage file that
// gives fewer bytes than its header promised fails the place; nothing is
// padded (D8). A runner that stops reading, or a tree-place that does not
// answer, fails the place after the stall bound (D7).

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentHost } from "./agent-host.ts";

/** A place with no progress for this long fails (D7). tree-place, which
 *  only renames, must answer within PLACE_ANSWER_STALLS of it. */
export const MEMBER_PLACE_STALL_MS = 60_000;
const PLACE_ANSWER_STALLS = 5;
/** The longest tree-in or tree-place may run. */
export const MEMBER_PLACE_CALL_MS = 3 * 60 * 60_000;
/** One data frame of a file. */
const DATA_FRAME_BYTES = 1024 * 1024;

const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface StageTotals {
  /** Files, folders and links under the stage (the stage itself not
   *  counted). */
  entries: number;
  /** The bytes of its files. */
  bytes: number;
}

/** The names of a stage folder, sorted. The stage keeps her modes; the
 *  office gives its own folder u+rx only when it lacks it (D4). */
function namesOf(path: string, mode: number): string[] {
  if ((mode & 0o500) === 0o500) return readdirSync(path).sort();
  chmodSync(path, (mode & 0o7777) | 0o700);
  try {
    return readdirSync(path).sort();
  } finally {
    // The stage keeps her modes for every run (D4).
    chmodSync(path, mode & 0o7777);
  }
}

/** The entries and bytes of her stage, by an lstat walk. */
export function stageTotals(stageDir: string): StageTotals {
  const totals = { entries: 0, bytes: 0 };
  const stack = [stageDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of namesOf(dir, lstatSync(dir).mode)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) stack.push(path);
      else if (st.isFile()) totals.bytes += st.size;
      else if (!st.isSymbolicLink()) continue;
      totals.entries++;
    }
  }
  return totals;
}

function frame(payload: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([head, payload]);
}

const jsonFrame = (value: unknown) => frame(Buffer.from(JSON.stringify(value)));

/** The tree-in body of her stage: per entry a header frame, a file's bytes
 *  in data frames, then a zero-length frame. Folders before what they hold,
 *  in walk order. Throws when a file gives fewer bytes than its header
 *  (D8). `onEntry` counts each entry sent. */
export async function* stageTreeFrames(
  stageDir: string,
  onEntry?: (bytes: number) => void,
): AsyncGenerator<Uint8Array> {
  async function* walk(rel: string, mode: number): AsyncGenerator<Uint8Array> {
    const dir = rel === "" ? stageDir : join(stageDir, rel);
    for (const name of namesOf(dir, mode)) {
      const p = rel === "" ? name : `${rel}/${name}`;
      const path = join(stageDir, p);
      const st = lstatSync(path);
      const head = { p, mode: st.mode & 0o7777, mtime: st.mtimeMs };
      if (st.isSymbolicLink()) {
        yield jsonFrame({ ...head, t: "l", size: 0, l: readlinkSync(path) });
        onEntry?.(0);
      } else if (st.isDirectory()) {
        yield jsonFrame({ ...head, t: "d", size: 0 });
        onEntry?.(0);
        yield* walk(p, st.mode);
      } else if (st.isFile()) {
        let fd: number;
        if ((st.mode & 0o400) === 0) {
          chmodSync(path, (st.mode & 0o7777) | 0o600);
          try {
            fd = openSync(path, READ_FLAGS);
          } finally {
            // The stage keeps her modes for every run (D4).
            chmodSync(path, st.mode & 0o7777);
          }
        } else fd = openSync(path, READ_FLAGS);
        try {
          const fst = fstatSync(fd);
          if (!fst.isFile() || fst.ino !== st.ino)
            throw new Error(`${p} changed in the stage`);
          const size = fst.size;
          yield jsonFrame({ ...head, t: "f", size });
          // D8: exactly `size` bytes, read after the header; never padded.
          let sent = 0;
          while (sent < size) {
            const want = Math.min(DATA_FRAME_BYTES, size - sent);
            const buf = Buffer.alloc(want);
            let got = 0;
            while (got < want) {
              const n = readSync(fd, buf, got, want - got, sent + got);
              if (n === 0) throw new Error(`${p} shrank in the stage`);
              got += n;
            }
            sent += want;
            yield frame(buf);
          }
          onEntry?.(size);
        } finally {
          closeSync(fd);
        }
      }
    }
  }
  yield* walk("", lstatSync(stageDir).mode);
  yield frame(new Uint8Array(0));
}

export interface PlaceMemberHomeInput {
  userId: string;
  /** <state>/move-members/<userId>/home */
  stageDir: string;
  /** Her home here (passwd), the one go-on checked. */
  home: string;
  host: Pick<AgentHost, "runEntry" | "runEntryStream">;
  onProgress?: (placed: number, total: number) => void;
  /** Tests. */
  stallMs?: number;
  callMs?: number;
}

/** `run` with a watchdog: fails when `ms` passes with no kick. */
function watchdog(ms: number, why: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fail: (err: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    fail = reject;
  });
  // A watchdog that never fires must not reject unhandled.
  stalled.catch(() => {});
  return {
    stalled,
    kick() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(why)), ms);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** tree-in then tree-place through her runner. Throws on a failure, with
 *  the reason. */
export async function placeMemberHome(
  input: PlaceMemberHomeInput,
): Promise<{ files: number; bytes: number }> {
  const { host, stageDir, home } = input;
  const stallMs = input.stallMs ?? MEMBER_PLACE_STALL_MS;
  const callMs = input.callMs ?? MEMBER_PLACE_CALL_MS;
  if (!host.runEntryStream) throw new Error("the member's host has no runner");
  const totals = stageTotals(stageDir);
  const nonce = randomBytes(16).toString("hex");
  let placed = 0;
  input.onProgress?.(0, totals.entries);
  const frames = stageTreeFrames(stageDir, () => {
    placed++;
    input.onProgress?.(placed, totals.entries);
  });
  // D7: the time her runner takes to read the next frame, and to answer
  // after the last one, is bounded; reading the stage is not.
  const dog = watchdog(
    stallMs,
    "the member's runner stopped reading the moved home",
  );
  async function* body(): AsyncGenerator<Uint8Array> {
    for (;;) {
      dog.stop();
      const r = await frames.next();
      if (r.done) break;
      dog.kick();
      yield r.value;
    }
    dog.kick();
  }
  let answer: unknown;
  try {
    dog.kick();
    answer = await Promise.race([
      host.runEntryStream(
        "tree-in",
        { nonce, home, total: totals.bytes },
        body(),
        callMs,
      ),
      dog.stalled,
    ]);
  } finally {
    dog.stop();
    void frames.return(undefined).catch(() => {});
  }
  const place = watchdog(
    stallMs * PLACE_ANSWER_STALLS,
    "the member's runner did not answer tree-place",
  );
  try {
    place.kick();
    await Promise.race([
      host.runEntry("tree-place", { nonce, home }, callMs),
      place.stalled,
    ]);
  } finally {
    place.stop();
  }
  input.onProgress?.(totals.entries, totals.entries);
  const a = answer as { files?: unknown; bytes?: unknown } | null;
  if (
    typeof a !== "object" ||
    a === null ||
    !Number.isSafeInteger(a.files) ||
    !Number.isSafeInteger(a.bytes)
  )
    throw new Error("the member's runner answered tree-in with something else");
  if (a.bytes !== totals.bytes)
    throw new Error(
      `the member's runner took ${String(a.bytes)} bytes of the moved home, and the office sent ${totals.bytes}`,
    );
  return { files: a.files as number, bytes: totals.bytes };
}
