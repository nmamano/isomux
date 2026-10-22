// Regression coverage for watchFile (task 30ffe109): the editor's
// external-change watch must survive atomic-rename saves.
//
// Agent tooling (Claude Code Edit/Write among others) saves via
// write-to-tmp + rename, which replaces the file's inode. The original
// implementation used fs.watch on the file path itself; under Bun that
// watch fires NOTHING for a rename-replace and is permanently dead
// afterwards, so the editor never auto-reloaded agent edits. (A
// parent-directory fs.watch loses the rename too - Bun coalesces the burst
// into one pre-rename event.) watchFile now polls the file's mtime on an
// interval, which is save-mechanism-agnostic; these tests freeze that
// every save style produces a change event.
//
// Zero LLM, zero server - exercises server/file-editor.ts directly against
// a temp directory.

import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import {
  openFile,
  saveFile,
  watchFile,
  stopWatch,
  type FileWatcher,
  type WatchFileEvent,
} from "../file-editor.ts";

// Read + arm exactly like the server's open path: the watch baseline is the
// signature of the stat the read was served from.
function openAndWatch(
  path: string,
  onEvent: (ev: WatchFileEvent) => void,
): FileWatcher {
  const r = openFile(path);
  if (r.kind !== "ok") throw new Error(`open failed: ${r.kind}`);
  return watchFile(path, onEvent, r.sig);
}

// The production poll interval. Every watch test runs on fake timers, so one
// advance of POLL_MS runs exactly one poll.
const POLL_MS = 1000;
const poll = (n = 1) => jest.advanceTimersByTime(POLL_MS * n);
const kinds = (events: WatchFileEvent[], kind: WatchFileEvent["kind"]) =>
  events.filter((e) => e.kind === kind).length;

describe("watchFile", () => {
  let dir: string;
  let file: string;
  let watcher: FileWatcher;
  let events: WatchFileEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-watch-test-"));
    file = join(dir, "watched.txt");
    writeFileSync(file, "v0");
    events = [];
    jest.useFakeTimers();
    watcher = openAndWatch(file, (ev) => events.push(ev));
  });

  afterEach(() => {
    stopWatch(watcher);
    jest.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires on in-place writes to the target only", () => {
    // A sibling change must not reach this watch.
    writeFileSync(join(dir, "other.txt"), "noise");
    poll();
    expect(events).toHaveLength(0);

    // A same-size in-place write keeps ino and size, so only mtime can move
    // the signature. Linux stamps mtime from a coarse clock, and a write in
    // the same tick as the baseline write keeps the old mtime (task
    // e490d5ad: a real-clock version was red in most hot reruns), so the
    // test moves mtime explicitly.
    const before = statSync(file);
    writeFileSync(file, "v1");
    const later = new Date(before.mtimeMs + 10_000);
    utimesSync(file, later, later);
    const after = statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);

    poll();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("change");
  });

  it("keeps firing for writes AFTER a rename-replace", () => {
    const tmp = join(dir, "watched.txt.tmp.123.abc");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file);
    poll();
    expect(kinds(events, "change")).toBe(1);
    // A different size: no real time passes, so mtime may not move.
    writeFileSync(file, "v2 longer");
    poll();
    expect(kinds(events, "change")).toBe(2);
  });

  it("emits for a save landing between read and watch install", () => {
    // The read-then-watch gap (Reviewer2 finding): the baseline must be the
    // signature of the READ, not of watch-install time - otherwise a change
    // in the gap is recorded as the baseline and never emits.
    const file2 = join(dir, "gap.txt");
    writeFileSync(file2, "v0");
    const r = openFile(file2);
    if (r.kind !== "ok") throw new Error("open failed");
    // Change lands after the read but before the watch is armed (atomic
    // rename, the same-tick-capable worst case).
    const tmp = join(dir, "gap.txt.tmp.1.a");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file2);
    const gapEvents: WatchFileEvent[] = [];
    const w = watchFile(file2, (ev) => gapEvents.push(ev), r.sig);
    try {
      poll();
      expect(kinds(gapEvents, "change")).toBe(1);
    } finally {
      stopWatch(w);
    }
  });
});

// Deletion lifecycle (task 1ed49547): a confirmed-missing path must produce a
// distinct "deleted" event - exactly once - and a recreation afterwards must
// resume change events.
describe("watchFile deletion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-watch-del-test-"));
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a single deleted event once the path is confirmed missing", () => {
    const file = join(dir, "doomed.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev));
    try {
      unlinkSync(file);
      poll(2);
      expect(kinds(events, "deleted")).toBe(1);
      // Still missing: further polls must not re-emit.
      poll(5);
      expect(kinds(events, "deleted")).toBe(1);
      expect(kinds(events, "change")).toBe(0);
    } finally {
      stopWatch(w);
    }
  });

  it("does not emit deleted for a single-poll transient absence", () => {
    // A rare save style (unlink + recreate) can leave the path absent for one
    // poll. One miss must NOT be classified as a deletion - that's the
    // two-consecutive-miss confirmation. Recreate between the first and
    // second poll and assert the watch reports a change, never a deletion.
    const file = join(dir, "flicker.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev));
    try {
      // Phase A proves that one clock advance runs exactly one watch poll.
      writeFileSync(file, "v1 longer");
      poll();
      expect(kinds(events, "change")).toBe(1);

      // Phase B exposes the path as missing for exactly one poll.
      unlinkSync(file);
      poll();
      expect(kinds(events, "deleted")).toBe(0);

      // Phase C restores a different signature before the confirming poll.
      writeFileSync(file, "v2 even longer than v1");
      poll();
      expect(kinds(events, "change")).toBe(2);
      expect(kinds(events, "deleted")).toBe(0);
    } finally {
      stopWatch(w);
    }
  });

  it("resumes change events when a deleted file is recreated", () => {
    const file = join(dir, "reborn.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev));
    try {
      unlinkSync(file);
      poll(2);
      expect(kinds(events, "deleted")).toBe(1);
      writeFileSync(file, "v1");
      poll();
      expect(kinds(events, "change")).toBe(1);
    } finally {
      stopWatch(w);
    }
  });
});

// Revision registry (task 259224b6): the server issues a per-path revision on
// open/save and bumps it on every observed signature change, so clients can
// compare revisions instead of timestamps (the mtime same-clock-tick blind
// spot, and the rollback case where mtime moves BACKWARDS).
describe("file revisions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-rev-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("openFile issues a stable rev; an on-disk change bumps it", () => {
    const file = join(dir, "rev.txt");
    writeFileSync(file, "v0");
    const r1 = openFile(file);
    const r2 = openFile(file);
    if (r1.kind !== "ok" || r2.kind !== "ok") throw new Error("open failed");
    expect(r2.rev).toBe(r1.rev);
    // Replace the file (new inode - detectable even in the same clock tick).
    const tmp = join(dir, "rev.txt.tmp");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file);
    const r3 = openFile(file);
    if (r3.kind !== "ok") throw new Error("open failed");
    expect(r3.rev).toBeGreaterThan(r1.rev);
  });

  it("recreation with a MATCHING signature still bumps: saveFile's ENOENT records the missing sentinel", () => {
    // rename-away + rename-back preserves ino, mtime and size - the recreated
    // signature EQUALS the pre-delete one. Without the missing sentinel being
    // recorded at the saveFile ENOENT observation, the restore would return
    // the old rev and a client that saw the deletion banner could be told
    // "nothing changed".
    const file = join(dir, "resurrect.txt");
    writeFileSync(file, "v0");
    const r = openFile(file);
    if (r.kind !== "ok") throw new Error("open failed");
    const aside = join(dir, "resurrect.aside");
    renameSync(file, aside);
    // The ENOENT observation (a watcher may not have confirmed yet).
    const refused = saveFile(file, "x", r.mtime, r.rev, false);
    expect(refused.kind).toBe("deleted");
    renameSync(aside, file); // same signature restored
    const reopened = openFile(file);
    if (reopened.kind !== "ok") throw new Error("reopen failed");
    expect(reopened.rev).toBeGreaterThan(r.rev);
  });

  it("recreation with a MATCHING signature still bumps: openFile's not_found records it too (the reconnect-404 path)", () => {
    const file = join(dir, "resurrect2.txt");
    writeFileSync(file, "v0");
    const r = openFile(file);
    if (r.kind !== "ok") throw new Error("open failed");
    const aside = join(dir, "resurrect2.aside");
    renameSync(file, aside);
    // The reconnect re-open observes the deletion - no watch armed, no save.
    expect(openFile(file).kind).toBe("not_found");
    renameSync(aside, file); // same signature restored
    const reopened = openFile(file);
    if (reopened.kind !== "ok") throw new Error("reopen failed");
    expect(reopened.rev).toBeGreaterThan(r.rev);
  });

  it("revisions never collide across a server restart (persisted generation reservation)", async () => {
    // The registry is per-process; a restart must not re-issue a rev the
    // previous process handed out for the same path, or the save guard would
    // miss exactly the disconnected-conflict cases the revision exists to
    // catch. Non-reuse is STATE-based: each process reserves a generation by
    // read-increment-persist on <STATE_ROOT>/editor-rev-generation, and every
    // rev is generation*BLOCK+counter - no timing involved, so this test is
    // deterministic. Simulate the restart at the module boundary: fresh
    // imports (the query string busts the module cache) get a brand-new
    // registry AND run the same generation reservation a new server process
    // would, against the same persisted state file.
    // Non-literal specifier so tsc doesn't try to resolve the query-string
    // module id (Bun resolves it fine and treats each distinct URL as a fresh
    // module instance).
    const freshGeneration = (tag: string) =>
      import(`../file-editor.ts?restart=${tag}`) as Promise<
        typeof import("../file-editor.ts")
      >;
    const file = join(dir, "gen.txt");
    writeFileSync(file, "v0");
    const r1 = openFile(file);
    if (r1.kind !== "ok") throw new Error("open failed");
    const gen2 = await freshGeneration("gen2");
    const r2 = gen2.openFile(file);
    if (r2.kind !== "ok") throw new Error("gen2 open failed");
    // Same unchanged file, but the new generation must not echo the old rev -
    // it has no basis to claim continuity with pre-restart state.
    expect(r2.rev).not.toBe(r1.rev);
    // And the guard side: a pre-restart rev presented to the new generation
    // refuses (benign false conflict, never a silent overwrite).
    const s = gen2.saveFile(
      file,
      "post-restart write",
      r1.mtime,
      r1.rev,
      false,
    );
    expect(s.kind).toBe("stale");
    // A third generation stays collision-free with BOTH predecessors.
    const gen3 = await freshGeneration("gen3");
    const r3 = gen3.openFile(file);
    if (r3.kind !== "ok") throw new Error("gen3 open failed");
    expect(r3.rev).not.toBe(r1.rev);
    expect(r3.rev).not.toBe(r2.rev);
  });

  it("a corrupt generation file cannot cause low-generation reuse", async () => {
    const freshGeneration = (tag: string) =>
      import(`../file-editor.ts?corrupt=${tag}`) as Promise<
        typeof import("../file-editor.ts")
      >;
    // Constants mirrored from file-editor.ts: revs are gen*REV_BLOCK+counter;
    // sequential generations live below GENERATION_SEQ_MAX, the degraded
    // fallback at/above it.
    const REV_BLOCK = 2 ** 33;
    const GENERATION_SEQ_MAX = 2 ** 19;
    const generationOf = (rev: number) => Math.floor(rev / REV_BLOCK);
    const genFile = join(STATE_ROOT, "editor-rev-generation");

    const file = join(dir, "corrupt.txt");
    writeFileSync(file, "v0");
    // Ensure the main module has reserved its (low, sequential) generation
    // and issued a rev a live tab could be holding.
    const r1 = openFile(file);
    if (r1.kind !== "ok") throw new Error("open failed");

    // Corruption case A: empty file (what a torn non-atomic write would have
    // left). The next "process" must NOT restart the sequence - it takes a
    // degraded high-range generation, so it can never reissue any low
    // sequential generation (in particular not the one r1.rev lives in).
    writeFileSync(genFile, "", "utf8");
    const genA = await freshGeneration("empty");
    const rA = genA.openFile(file);
    if (rA.kind !== "ok") throw new Error("genA open failed");
    expect(generationOf(rA.rev)).toBeGreaterThanOrEqual(GENERATION_SEQ_MAX);
    expect(rA.rev).not.toBe(r1.rev);
    // The guard side: the pre-corruption rev refuses against the new state.
    const sA = genA.saveFile(file, "post-corruption", r1.mtime, r1.rev, false);
    expect(sA.kind).toBe("stale");
    // The degraded boot REPAIRS the file so later boots resume sequentially
    // above its high-range generation.
    expect(/^\d+$/.test(readFileSync(genFile, "utf8").trim())).toBe(true);

    // Corruption case B: non-numeric garbage - same non-low guarantee.
    writeFileSync(genFile, "not a number", "utf8");
    const genB = await freshGeneration("garbage");
    const rB = genB.openFile(file);
    if (rB.kind !== "ok") throw new Error("genB open failed");
    expect(generationOf(rB.rev)).toBeGreaterThanOrEqual(GENERATION_SEQ_MAX);
    expect(rB.rev).not.toBe(r1.rev);
  });

  it("a save's own write does not double-bump: the watch echo carries the save's rev", () => {
    // The client uses rev equality to ignore the watch echo of its own save.
    // The registry must converge: the rev returned by saveFile equals the rev
    // the subsequent watch poll emits for that same write.
    const file = join(dir, "echo.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    jest.useFakeTimers();
    const w = openAndWatch(file, (ev) => events.push(ev));
    try {
      const r = openFile(file);
      if (r.kind !== "ok") throw new Error("open failed");
      // Different length than "v0" so the write is a signature change even
      // within the same clock tick.
      const s = saveFile(file, "v1 with more bytes", r.mtime, r.rev, false);
      if (s.kind !== "ok") throw new Error(`save failed: ${s.kind}`);
      poll();
      const change = events.find((e) => e.kind === "change");
      if (!change || change.kind !== "change") throw new Error("no change");
      expect(change.rev).toBe(s.rev);
    } finally {
      stopWatch(w);
      jest.useRealTimers();
    }
  });
});
