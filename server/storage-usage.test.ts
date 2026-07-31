// T0/T1 - the disk-usage breakdown (task 2366ccb0).
//
// Every root is injected, so these build a fixture state root under the OS temp
// dir and never stat the real ~/.isomux. Cleanup goes through the temp-state
// guard, which refuses any target that is not strictly under the temp dir.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  measureStorage,
  measureTree,
  aggregateOnly,
  measureStorageCached,
  resetStorageUsageCache,
  type StorageCategoryId,
  type StorageUsage,
} from "./storage-usage.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "isomux-storage-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  resetStorageUsageCache();
  while (dirs.length > 0) removeStateDir(dirs.pop()!);
});

function write(path: string, bytes: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
}

function bytesOf(usage: StorageUsage, id: StorageCategoryId): number {
  return usage.categories.find((c) => c.id === id)!.bytes;
}

// A state root with two agents, a codex home, cronjobs, memory, and a stray
// top-level file that must land in other-state.
function buildStateRoot(): string {
  const root = tempDir();
  write(join(root, "logs", "agent-a", "s1.jsonl"), 100);
  write(join(root, "logs", "agent-a", "s2.jsonl"), 200);
  write(join(root, "logs", "agent-a", "sessions.json"), 10);
  write(join(root, "logs", "agent-a", "files", "photo.png"), 50);
  write(join(root, "logs", "agent-b", "s3.jsonl"), 400);
  write(join(root, "codex-home", "logs_2.sqlite"), 1000);
  write(join(root, "cronjobs", "job1", "runs.json"), 25);
  write(join(root, "memory", "office.md"), 5);
  write(join(root, "agents.json"), 70);
  return root;
}

describe("measureTree", () => {
  it("sums a tree recursively and counts files", () => {
    const root = tempDir();
    write(join(root, "a.txt"), 10);
    write(join(root, "sub", "b.txt"), 20);
    write(join(root, "sub", "deep", "c.txt"), 30);
    expect(measureTree(root)).toEqual({ bytes: 60, files: 3 });
  });

  it("measures a missing path as zero instead of throwing", () => {
    expect(measureTree(join(tempDir(), "nope"))).toEqual({
      bytes: 0,
      files: 0,
    });
  });

  it("does not follow symlinks out of the tree", () => {
    const root = tempDir();
    const outside = tempDir();
    write(join(outside, "huge.bin"), 5000);
    write(join(root, "small.txt"), 10);
    symlinkSync(outside, join(root, "link"));
    const usage = measureTree(root);
    // The link counts as its own inode, never as the 5000-byte target.
    expect(usage.bytes).toBeLessThan(1000);
    expect(usage.files).toBe(2);
  });
});

describe("measureStorage", () => {
  it("splits the state root into categories", () => {
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: null,
      snapshotDir: null,
    });
    expect(bytesOf(usage, "transcripts")).toBe(700);
    expect(bytesOf(usage, "attachments")).toBe(50);
    expect(bytesOf(usage, "session-metadata")).toBe(10);
    expect(bytesOf(usage, "codex-home")).toBe(1000);
    expect(bytesOf(usage, "cronjobs")).toBe(25);
    expect(bytesOf(usage, "memory")).toBe(5);
    expect(bytesOf(usage, "other-state")).toBe(70);
  });

  it("makes the in-root categories sum to the state-root total", () => {
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: null,
      snapshotDir: null,
    });
    const inRoot: StorageCategoryId[] = [
      "transcripts",
      "attachments",
      "session-metadata",
      "codex-home",
      "cronjobs",
      "memory",
      "other-state",
    ];
    const sum = inRoot.reduce((acc, id) => acc + bytesOf(usage, id), 0);
    expect(sum).toBe(usage.stateRootBytes);
  });

  it("reports per-agent detail, largest first", () => {
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: null,
      snapshotDir: null,
    });
    // agent-b holds 400 bytes, agent-a 300 + 50 = 350.
    expect(usage.agents.map((a) => a.agentId)).toEqual(["agent-b", "agent-a"]);
    const a = usage.agents[1];
    expect(a.transcriptBytes).toBe(300);
    expect(a.attachmentBytes).toBe(50);
    expect(a.sessions).toBe(2);
    expect(a.lastActivityAt).toBeGreaterThan(0);
  });

  it("measures backups and update snapshots outside the state root", () => {
    const backupDir = tempDir();
    const snapshotDir = tempDir();
    write(join(backupDir, "isomux-2026-07-01.tar.gz"), 300);
    write(join(snapshotDir, "pre-update-v1-to-v2.tar.gz"), 400);
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir,
      snapshotDir,
    });
    expect(bytesOf(usage, "backups")).toBe(300);
    expect(bytesOf(usage, "update-snapshots")).toBe(400);
    // External categories are NOT part of the state-root total.
    expect(usage.stateRootBytes).toBe(1860);
  });

  it("reports a null path for a location the box does not have", () => {
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: null,
      snapshotDir: null,
    });
    const snapshots = usage.categories.find(
      (c) => c.id === "update-snapshots",
    )!;
    expect(snapshots.path).toBeNull();
    expect(snapshots.available).toBe(false);
    expect(snapshots.bytes).toBe(0);
  });

  it("distinguishes a missing backup dir from an empty one", () => {
    const emptyBackups = tempDir();
    const withDir = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: emptyBackups,
      snapshotDir: null,
    });
    const present = withDir.categories.find((c) => c.id === "backups")!;
    expect(present.available).toBe(true);
    expect(present.bytes).toBe(0);

    const missing = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir: join(emptyBackups, "not-created-yet"),
      snapshotDir: null,
    });
    const absent = missing.categories.find((c) => c.id === "backups")!;
    // Same zero bytes, but the caller can tell "no backup has ever run" from
    // "the backup dir is empty".
    expect(absent.available).toBe(false);
    expect(absent.path).not.toBeNull();
    expect(absent.bytes).toBe(0);
  });

  it("returns zeroes for a state root that does not exist yet", () => {
    const usage = measureStorage({
      stateRoot: join(tempDir(), "fresh-install"),
      backupDir: null,
      snapshotDir: null,
    });
    expect(usage.stateRootBytes).toBe(0);
    expect(usage.agents).toEqual([]);
  });
});

describe("aggregateOnly", () => {
  it("drops per-agent detail and every filesystem path, keeps the sizes", () => {
    const backupDir = tempDir();
    const usage = measureStorage({
      stateRoot: buildStateRoot(),
      backupDir,
      snapshotDir: null,
    });
    const stripped = aggregateOnly(usage);
    expect(stripped.agents).toEqual([]);
    expect(stripped.stateRoot).toBeNull();
    expect(stripped.categories.every((c) => c.path === null)).toBe(true);
    // Sizes, ids, and availability survive - a member can still see what is
    // filling the disk, just not where it lives or which agents own it.
    expect(
      stripped.categories.map((c) => [c.id, c.bytes, c.available]),
    ).toEqual(usage.categories.map((c) => [c.id, c.bytes, c.available]));
    expect(stripped.stateRootBytes).toBe(usage.stateRootBytes);
  });
});

describe("measureStorageCached", () => {
  it("reuses a fresh measurement and re-measures once the TTL passes", () => {
    const root = buildStateRoot();
    const roots = { stateRoot: root, backupDir: null, snapshotDir: null };
    const first = measureStorageCached(roots);
    write(join(root, "logs", "agent-b", "s4.jsonl"), 5000);

    const cachedRead = measureStorageCached(roots);
    expect(cachedRead.measuredAt).toBe(first.measuredAt);
    expect(cachedRead.stateRootBytes).toBe(first.stateRootBytes);

    const afterTtl = measureStorageCached(roots, 30_000, Date.now() + 60_000);
    expect(afterTtl.stateRootBytes).toBe(first.stateRootBytes + 5000);
  });

  it("does not serve one state root's measurement for another", () => {
    const a = measureStorageCached({
      stateRoot: buildStateRoot(),
      backupDir: null,
      snapshotDir: null,
    });
    const b = measureStorageCached({
      stateRoot: tempDir(),
      backupDir: null,
      snapshotDir: null,
    });
    expect(b.stateRootBytes).toBe(0);
    expect(a.stateRootBytes).toBeGreaterThan(0);
  });
});
