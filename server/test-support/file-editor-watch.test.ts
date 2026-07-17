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
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openFile,
  watchFile,
  stopWatch,
  type FileWatcher,
} from "../file-editor.ts";

// Read + arm exactly like the server's open path: the watch baseline is the
// signature of the stat the read was served from.
function openAndWatch(
  path: string,
  onChange: (mtime: number) => void,
): FileWatcher {
  const r = openFile(path);
  if (r.kind !== "ok") throw new Error(`open failed: ${r.kind}`);
  return watchFile(path, "agent-x", onChange, r.sig);
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
  let events: number[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isomux-watch-test-"));
    file = join(dir, "watched.txt");
    writeFileSync(file, "v0");
    events = [];
    watcher = openAndWatch(file, (mtime) => events.push(mtime));
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
    const gapEvents: number[] = [];
    const w = watchFile(file2, "agent-x", (m) => gapEvents.push(m), r.sig);
    try {
      await waitFor(() => gapEvents.length > 0);
      expect(gapEvents.length).toBeGreaterThan(0);
    } finally {
      stopWatch(w);
    }
  });
});
