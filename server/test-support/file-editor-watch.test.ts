// Regression coverage for watchFile (task 30ffe109): the editor's
// external-change watch must survive atomic-rename saves.
//
// Agent tooling (Claude Code Edit/Write among others) saves via
// write-to-tmp + rename, which replaces the file's inode. The original
// implementation used fs.watch on the file path itself; under Bun that
// watch fires NOTHING for a rename-replace and is permanently dead
// afterwards, so the editor never auto-reloaded agent edits. (A
// parent-directory fs.watch loses the rename too — Bun coalesces the burst
// into one pre-rename event.) watchFile now polls the file's mtime on an
// interval, which is save-mechanism-agnostic; these tests freeze that
// every save style produces a change event.
//
// Zero LLM, zero server — exercises server/file-editor.ts directly against
// a temp directory.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
  pollMs?: number,
): FileWatcher {
  const r = openFile(path);
  if (r.kind !== "ok") throw new Error(`open failed: ${r.kind}`);
  return watchFile(path, "agent-x", onEvent, r.sig, { pollMs });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Change delivery is async (1s poll); wait for the expected count instead
// of a fixed sleep so the pass path stays fast.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await sleep(20);
}

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
    watcher = openAndWatch(file, (ev) => events.push(ev));
  });

  afterEach(() => {
    stopWatch(watcher);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires on in-place writes", async () => {
    writeFileSync(file, "v1");
    await waitFor(() => events.length > 0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("fires on atomic rename-replace saves", async () => {
    const tmp = join(dir, "watched.txt.tmp.123.abc");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file);
    await waitFor(() => events.length > 0);
    expect(events.length).toBeGreaterThan(0);
  });

  it("keeps firing for writes AFTER a rename-replace", async () => {
    const tmp = join(dir, "watched.txt.tmp.123.abc");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file);
    await waitFor(() => events.length > 0);
    const afterRename = events.length;
    writeFileSync(file, "v2");
    await waitFor(() => events.length > afterRename);
    expect(events.length).toBeGreaterThan(afterRename);
  });

  it("ignores sibling files in the same directory", async () => {
    writeFileSync(join(dir, "other.txt"), "noise");
    // Cover at least one full poll cycle before asserting silence.
    await sleep(1300);
    expect(events.length).toBe(0);
  });

  it("emits for a save landing between read and watch install", async () => {
    // The read-then-watch gap (Reviewer2 finding): the baseline must be the
    // signature of the READ, not of watch-install time — otherwise a change
    // in the gap is recorded as the baseline and never emits.
    const file2 = join(dir, "gap.txt");
    writeFileSync(file2, "v0");
    const r = openFile(file2);
    if (r.kind !== "ok") throw new Error("open failed");
    // Change lands after the read but before the watch is armed (atomic
    // rename, the same-ms-capable worst case).
    const tmp = join(dir, "gap.txt.tmp.1.a");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file2);
    const gapEvents: WatchFileEvent[] = [];
    const w = watchFile(file2, "agent-x", (ev) => gapEvents.push(ev), r.sig);
    try {
      await waitFor(() => gapEvents.length > 0);
      expect(gapEvents.length).toBeGreaterThan(0);
    } finally {
      stopWatch(w);
    }
  });
});

// Deletion lifecycle (task 1ed49547): a confirmed-missing path must produce a
// distinct "deleted" event — exactly once — and a recreation afterwards must
// resume change events. All tests use a fast poll (the pollMs test override)
// so the two-consecutive-miss confirmation stays fast.
describe("watchFile deletion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-watch-del-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a single deleted event once the path is confirmed missing", async () => {
    const file = join(dir, "doomed.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev), 50);
    try {
      unlinkSync(file);
      await waitFor(() => events.some((e) => e.kind === "deleted"));
      // Cover several more polls: still-missing must not re-emit.
      await sleep(300);
      expect(events.filter((e) => e.kind === "deleted").length).toBe(1);
      expect(events.filter((e) => e.kind === "change").length).toBe(0);
    } finally {
      stopWatch(w);
    }
  });

  it("does not emit deleted for a single-poll transient absence", async () => {
    // A rare save style (unlink + recreate) can leave the path absent for one
    // poll. One miss must NOT be classified as a deletion — that's the
    // two-consecutive-miss confirmation. Recreate between the first and
    // second poll and assert the watch reports a change, never a deletion.
    const file = join(dir, "flicker.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev), 250);
    try {
      unlinkSync(file);
      // ~1 poll observes the absence, then the file is back (the second,
      // would-be-confirming poll at ~500ms sees it restored).
      await sleep(300);
      writeFileSync(file, "v1");
      await waitFor(() => events.some((e) => e.kind === "change"));
      expect(events.filter((e) => e.kind === "deleted").length).toBe(0);
    } finally {
      stopWatch(w);
    }
  });

  it("never emits deleted across repeated atomic rename-replace saves", async () => {
    // The agent-tooling save path: rename(2) is atomic, so the watched path
    // must never be observably absent regardless of when polls land.
    const file = join(dir, "renamed.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev), 20);
    try {
      for (let i = 1; i <= 30; i++) {
        const tmp = join(dir, `renamed.txt.tmp.${i}`);
        writeFileSync(tmp, `v${i}`);
        renameSync(tmp, file);
        await sleep(10);
      }
      await waitFor(() => events.some((e) => e.kind === "change"));
      expect(events.filter((e) => e.kind === "deleted").length).toBe(0);
      expect(events.filter((e) => e.kind === "change").length).toBeGreaterThan(
        0,
      );
    } finally {
      stopWatch(w);
    }
  });

  it("resumes change events when a deleted file is recreated", async () => {
    const file = join(dir, "reborn.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev), 50);
    try {
      unlinkSync(file);
      await waitFor(() => events.some((e) => e.kind === "deleted"));
      writeFileSync(file, "v1");
      await waitFor(() => events.some((e) => e.kind === "change"));
      expect(events.some((e) => e.kind === "change")).toBe(true);
    } finally {
      stopWatch(w);
    }
  });
});

// Revision registry (task 259224b6): the server issues a per-path revision on
// open/save and bumps it on every observed signature change, so clients can
// compare revisions instead of timestamps (the mtime same-millisecond blind
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
    // Replace the file (new inode — detectable even in the same millisecond).
    const tmp = join(dir, "rev.txt.tmp");
    writeFileSync(tmp, "v1");
    renameSync(tmp, file);
    const r3 = openFile(file);
    if (r3.kind !== "ok") throw new Error("open failed");
    expect(r3.rev).toBeGreaterThan(r1.rev);
  });

  it("saveFile with the current rev succeeds and returns a bumped rev", () => {
    const file = join(dir, "save.txt");
    writeFileSync(file, "v0");
    const r = openFile(file);
    if (r.kind !== "ok") throw new Error("open failed");
    // Longer content on purpose: an equal-length in-place write landing in
    // the same millisecond would produce an identical signature (no bump).
    const s = saveFile(file, "v1 with more bytes", r.mtime, r.rev, false);
    expect(s.kind).toBe("ok");
    if (s.kind !== "ok") return;
    expect(s.rev).toBeGreaterThan(r.rev);
  });

  it("saveFile with a stale rev refuses — even when mtime moved BACKWARDS", () => {
    // The legacy `currentMtime > expectedMtime` guard misses a rollback (a
    // restore that moves mtime into the past). The rev guard must catch it.
    const file = join(dir, "rollback.txt");
    writeFileSync(file, "v0");
    const r = openFile(file);
    if (r.kind !== "ok") throw new Error("open failed");
    // External change with an mtime OLDER than the open.
    writeFileSync(file, "external");
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    expect(Math.floor(statSync(file).mtimeMs)).toBeLessThan(r.mtime);
    const s = saveFile(file, "mine", r.mtime, r.rev, false);
    expect(s.kind).toBe("stale");
    if (s.kind !== "stale") return;
    expect(s.currentRev).toBeGreaterThan(r.rev);
  });

  it("saveFile on a deleted path returns kind=deleted; force recreates with a bumped rev", () => {
    const file = join(dir, "gone.txt");
    writeFileSync(file, "v0");
    const r = openFile(file);
    if (r.kind !== "ok") throw new Error("open failed");
    unlinkSync(file);
    const refused = saveFile(file, "mine", r.mtime, r.rev, false);
    expect(refused.kind).toBe("deleted");
    const forced = saveFile(file, "mine", r.mtime, r.rev, true);
    expect(forced.kind).toBe("ok");
    if (forced.kind !== "ok") return;
    // The deletion observation invalidated the registry, so the recreation is
    // a strict bump over the opened rev.
    expect(forced.rev).toBeGreaterThan(r.rev);
    const reopened = openFile(file);
    if (reopened.kind !== "ok") throw new Error("reopen failed");
    expect(reopened.content).toBe("mine");
  });

  it("recreation with a MATCHING signature still bumps: saveFile's ENOENT records the missing sentinel", () => {
    // rename-away + rename-back preserves ino, mtime and size — the recreated
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
    // The reconnect re-open observes the deletion — no watch armed, no save.
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
    // rev is generation*BLOCK+counter — no timing involved, so this test is
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
    // Same unchanged file, but the new generation must not echo the old rev —
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
    // left). The next "process" must NOT restart the sequence — it takes a
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

    // Corruption case B: non-numeric garbage — same non-low guarantee.
    writeFileSync(genFile, "not a number", "utf8");
    const genB = await freshGeneration("garbage");
    const rB = genB.openFile(file);
    if (rB.kind !== "ok") throw new Error("genB open failed");
    expect(generationOf(rB.rev)).toBeGreaterThanOrEqual(GENERATION_SEQ_MAX);
    expect(rB.rev).not.toBe(r1.rev);
  });

  it("a save's own write does not double-bump: the watch echo carries the save's rev", async () => {
    // The client uses rev equality to ignore the watch echo of its own save.
    // The registry must converge: the rev returned by saveFile equals the rev
    // the subsequent watch poll emits for that same write.
    const file = join(dir, "echo.txt");
    writeFileSync(file, "v0");
    const events: WatchFileEvent[] = [];
    const w = openAndWatch(file, (ev) => events.push(ev), 50);
    try {
      const r = openFile(file);
      if (r.kind !== "ok") throw new Error("open failed");
      // Different length than "v0" so the write is a signature change even
      // within the same millisecond.
      const s = saveFile(file, "v1 with more bytes", r.mtime, r.rev, false);
      if (s.kind !== "ok") throw new Error(`save failed: ${s.kind}`);
      await waitFor(() => events.some((e) => e.kind === "change"));
      const change = events.find((e) => e.kind === "change");
      if (!change || change.kind !== "change") throw new Error("no change");
      expect(change.rev).toBe(s.rev);
    } finally {
      stopWatch(w);
    }
  });
});
