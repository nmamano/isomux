// The owner export's jobs (task cdd7883d, slice 4), through
// createOfficeExportJobs with a fake child that writes the file the real one
// would. server/office-export-main.test.ts owns what the real child writes;
// the route test owns who may start, read and download an export.

import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  createOfficeExportJobs,
  EXPORTS_SUBDIR,
  sweepExportFiles,
  type ExportChild,
  type OfficeExportJobs,
  type OfficeExportJobsDeps,
} from "./office-export-jobs.ts";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");

let dir = "";
let jobs: OfficeExportJobs | null = null;
afterEach(() => {
  try {
    jobs?.stop();
  } catch {
    // A stub that throws; the test already failed.
  }
  jobs = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// A child the test ends by hand: finish() writes the file and exits 0,
// fail() writes stderr and exits 1.
interface FakeChild extends ExportChild {
  outFile: string;
  kills: (number | NodeJS.Signals | undefined)[];
  finish(content?: string): void;
  fail(stderr: string, code?: number): void;
}

function fakeChild(outFile: string): FakeChild {
  let exit!: (code: number) => void;
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const kills: (number | NodeJS.Signals | undefined)[] = [];
  const close = () => {
    out.close();
    err.close();
  };
  return {
    outFile,
    kills,
    exited: new Promise<number>((r) => (exit = r)),
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (out = c) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => void (err = c) }),
    kill(signal) {
      kills.push(signal);
      close();
      exit(143);
    },
    finish(content = "tar bytes") {
      writeFileSync(outFile, content, { mode: 0o600 });
      close();
      exit(0);
    },
    fail(stderr, code = 1) {
      err.enqueue(new TextEncoder().encode(stderr));
      close();
      exit(code);
    },
  };
}

interface Bed {
  stateRoot: string;
  baseDir: string;
  exportsDir: string;
  spawned: FakeChild[];
  clock: { now: number };
  jobs: OfficeExportJobs;
}

function bed(overrides: Partial<OfficeExportJobsDeps> = {}): Bed {
  dir = mkdtempSync(join(tmpdir(), "office-export-jobs-"));
  const stateRoot = join(dir, ".isomux");
  const baseDir = join(dir, "isomux-backups");
  mkdirSync(stateRoot, { mode: 0o700 });
  const spawned: FakeChild[] = [];
  const clock = { now: T0 };
  jobs = createOfficeExportJobs({
    stateRoot,
    baseDir: () => baseDir,
    spawnChild: ({ outFile }) => {
      const child = fakeChild(outFile);
      spawned.push(child);
      return child;
    },
    now: () => clock.now,
    ...overrides,
  });
  return {
    stateRoot,
    baseDir,
    exportsDir: join(baseDir, EXPORTS_SUBDIR),
    spawned,
    clock,
    jobs,
  };
}

// The child's exit reaches the jobs through a promise; let it settle.
async function settle(
  b: Bed,
  id: string,
  state: "ready" | "failed",
  budgetMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (b.jobs.status(id)?.state !== state && performance.now() < deadline)
    await Bun.sleep(5);
}

function startOk(b: Bed): string {
  const started = b.jobs.start();
  if (!started.ok) throw new Error(`start refused: ${started.status}`);
  return started.id;
}

test("an export runs in one child that writes into <backup folder>/exports/ (0700), outside the state root; it is ready with its size and expiry, and a second start meanwhile is 409", async () => {
  const b = bed({ keepMs: 60_000 });
  // An exports folder an earlier version or a person left open to others.
  mkdirSync(b.exportsDir, { recursive: true });
  chmodSync(b.exportsDir, 0o755);
  const id = startOk(b);

  expect(b.spawned).toHaveLength(1);
  const outFile = b.spawned[0].outFile;
  expect(dirname(resolve(outFile))).toBe(resolve(b.exportsDir));
  expect(resolve(outFile).startsWith(resolve(b.stateRoot) + sep)).toBe(false);
  // The folder holds full copies of the office: its owner only.
  expect(statSync(b.exportsDir).mode & 0o777).toBe(0o700);
  expect(b.jobs.status(id)).toEqual({ state: "running" });
  expect(b.jobs.file(id)).toBeNull();
  const second = b.jobs.start();
  expect(second.ok ? "ok" : second.status).toBe(409);
  expect(b.spawned).toHaveLength(1);

  b.clock.now = T0 + 5_000;
  b.spawned[0].finish("0123456789");
  await settle(b, id, "ready");
  expect(b.jobs.status(id)).toEqual({
    state: "ready",
    bytes: 10,
    expiresAt: T0 + 5_000 + 60_000,
  });
  expect(b.jobs.file(id)).toBe(outFile);
  expect(b.jobs.status("no-such-export")).toBeNull();
  expect(b.jobs.file("no-such-export")).toBeNull();
});

test("a child that exits non-zero fails the job with its last error line, leaves no file, and frees the slot", async () => {
  const b = bed();
  const id = startOk(b);
  // A partial file the child left before it died.
  writeFileSync(b.spawned[0].outFile, "half");
  b.spawned[0].fail(
    "reading the office\nexport: the secret store is unreadable, so the export stopped\n",
  );
  await settle(b, id, "failed");

  expect(b.jobs.status(id)).toEqual({
    state: "failed",
    error: "export: the secret store is unreadable, so the export stopped",
  });
  expect(b.jobs.file(id)).toBeNull();
  expect(existsSync(b.spawned[0].outFile)).toBe(false);
  expect(b.jobs.start().ok).toBe(true);
});

test("a child past the time limit is killed and its job fails", async () => {
  const b = bed({ timeLimitMs: 50 });
  const id = startOk(b);
  await settle(b, id, "failed");

  expect(b.spawned[0].kills).toHaveLength(1);
  const status = b.jobs.status(id);
  expect(status?.state).toBe("failed");
  expect(status?.error ?? "").not.toBe("");
});

test("a ready export is deleted when its time is up: the file goes and the id is unknown", async () => {
  const b = bed({ keepMs: 50 });
  const id = startOk(b);
  b.spawned[0].finish();
  await settle(b, id, "ready");
  const file = b.jobs.file(id)!;
  expect(existsSync(file)).toBe(true);

  const deadline = performance.now() + 1_000;
  while (existsSync(file) && performance.now() < deadline) await Bun.sleep(10);
  expect(existsSync(file)).toBe(false);
  expect(b.jobs.status(id)).toBeNull();
  expect(b.jobs.file(id)).toBeNull();
});

test("a new export deletes the previous one", async () => {
  const b = bed({ keepMs: 60_000 });
  const first = startOk(b);
  b.spawned[0].finish();
  await settle(b, first, "ready");
  const firstFile = b.jobs.file(first)!;

  const second = startOk(b);
  b.spawned[1].finish();
  await settle(b, second, "ready");

  expect(existsSync(firstFile)).toBe(false);
  expect(b.jobs.status(first)).toBeNull();
  expect(b.jobs.file(second)).toBe(b.spawned[1].outFile);
  expect(readdirSync(b.exportsDir)).toEqual([
    b.spawned[1].outFile.slice(b.exportsDir.length + 1),
  ]);
});

test("sweep deletes what a crash left in exports/ and keeps the file of a ready job; sweepExportFiles (the locked boot) deletes every file", async () => {
  const b = bed({ keepMs: 60_000 });
  mkdirSync(b.exportsDir, { recursive: true, mode: 0o700 });
  const stray = join(b.exportsDir, "left-by-a-crash.tar.gz");
  writeFileSync(stray, "old office");
  const id = startOk(b);
  b.spawned[0].finish();
  await settle(b, id, "ready");

  b.jobs.sweep();
  expect(existsSync(stray)).toBe(false);
  expect(existsSync(b.jobs.file(id)!)).toBe(true);

  sweepExportFiles(b.baseDir);
  expect(readdirSync(b.exportsDir)).toEqual([]);
  // No exports/ folder at all: nothing to do, no throw.
  sweepExportFiles(join(dir, "never-made"));
});

test("stop kills a running child", () => {
  const b = bed();
  startOk(b);
  b.jobs.stop();
  expect(b.spawned[0].kills).toHaveLength(1);
});

test("a spawn or a folder that throws is a 500 and frees the slot; a child whose streams and exit reject fails its job without an unhandled error", async () => {
  let spawnThrows = true;
  let baseThrows = false;
  const b = bed({
    baseDir: () => {
      if (baseThrows) throw new Error("EACCES");
      return join(dir, "isomux-backups");
    },
    spawnChild: ({ outFile }) => {
      if (spawnThrows) throw new Error("ENOENT: bun");
      const broken = new ReadableStream<Uint8Array>({
        start: (c) => c.error(new Error("pipe broke")),
      });
      return {
        exited: Promise.reject(new Error(`lost ${outFile}`)),
        stdout: broken,
        stderr: new ReadableStream<Uint8Array>({
          start: (c) => c.error(new Error("pipe broke")),
        }),
        kill: () => {
          throw new Error("ESRCH");
        },
      };
    },
  });

  const spawnFail = b.jobs.start();
  expect(spawnFail.ok ? "ok" : spawnFail.status).toBe(500);

  baseThrows = true;
  const baseFail = b.jobs.start();
  expect(baseFail.ok ? "ok" : baseFail.status).toBe(500);

  baseThrows = false;
  spawnThrows = false;
  const id = startOk(b);
  await settle(b, id, "failed");
  expect(b.jobs.status(id)?.state).toBe("failed");
  // stop() on a child whose kill throws does not throw either.
  b.jobs.stop();
});
