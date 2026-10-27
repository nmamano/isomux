// The app revision and serving probe behind the widget's reload after a change
// (task d7ac4f73). The widget reloads the frame when the revision moved across
// an agent's turn and the app serves again; the route wiring is in
// server/test-support/app-widget.test.ts.

import { afterEach, expect, it, spyOn } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRecord } from "../shared/types.ts";
import {
  appFilesRevision,
  appReloadRequestedAt,
  appServing,
  bumpAppRestartSeq,
  requestAppReload,
} from "./app-revision.ts";

const dirs: string[] = [];
let listener: { stop(closeActive?: boolean): void } | null = null;
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  listener?.stop(true);
  listener = null;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-revision-"));
  dirs.push(dir);
  return dir;
}

let seq = 0;
function appIn(cwd: string, port = 1): AppRecord {
  return { name: `rev-${++seq}`, cwd, port } as AppRecord;
}

// An app tree with the entries the walk must skip already in place, and a
// symlink to a directory outside the app.
function fixture() {
  const cwd = tempDir();
  const outside = tempDir();
  mkdirSync(join(cwd, "src", "pages"), { recursive: true });
  writeFileSync(join(cwd, "index.html"), "<h1>one</h1>");
  writeFileSync(join(cwd, "src", "pages", "a.ts"), "a");
  for (const skipped of ["node_modules", ".git", ".cache"])
    mkdirSync(join(cwd, skipped, "deep"), { recursive: true });
  writeFileSync(join(outside, "linked.txt"), "x");
  symlinkSync(outside, join(cwd, "linked"));
  return { cwd, outside };
}

// A time well past anything the fixture wrote, so a changed file differs even
// on a filesystem with coarse timestamps.
const LATER = new Date(Date.now() + 60_000);

for (const [change, mutate] of [
  [
    "a file edited in place",
    (cwd: string) => {
      writeFileSync(join(cwd, "index.html"), "<h1>two</h1>");
      utimesSync(join(cwd, "index.html"), LATER, LATER);
    },
  ],
  [
    "a new file in a nested folder",
    (cwd: string) => writeFileSync(join(cwd, "src", "pages", "b.ts"), "b"),
  ],
  [
    "a deleted file",
    (cwd: string) => unlinkSync(join(cwd, "src", "pages", "a.ts")),
  ],
] as const) {
  it(`moves the revision for ${change}`, async () => {
    const { cwd } = fixture();
    const app = appIn(cwd);
    const before = await appFilesRevision(app);
    expect(typeof before).toBe("string");
    expect(await appFilesRevision(app)).toBe(before);
    mutate(cwd);
    const after = await appFilesRevision(app);
    expect(typeof after).toBe("string");
    expect(after).not.toBe(before);
  });
}

// Dependencies, VCS data, dot folders and whatever a symlink points at are not
// the app's own files: a change there is not a change to the app.
it("keeps the revision for changes in skipped folders and behind a symlink", async () => {
  const { cwd, outside } = fixture();
  const app = appIn(cwd);
  const before = await appFilesRevision(app);
  expect(typeof before).toBe("string");
  for (const skipped of ["node_modules", ".git", ".cache"]) {
    const file = join(cwd, skipped, "deep", "f.js");
    writeFileSync(file, "x");
    utimesSync(file, LATER, LATER);
    utimesSync(join(cwd, skipped, "deep"), LATER, LATER);
  }
  writeFileSync(join(outside, "new.txt"), "x");
  utimesSync(join(outside, "linked.txt"), LATER, LATER);
  utimesSync(outside, LATER, LATER);
  expect(await appFilesRevision(app)).toBe(before);
  // The same kind of write in the app's own folder does move it: the skips
  // above are skips, not a walk that sees nothing.
  writeFileSync(join(cwd, "src", "f.js"), "x");
  expect(await appFilesRevision(app)).not.toBe(before);
});

// An office restart with no file change still reloads the frame, and only for
// the app that restarted.
it("moves the revision when the office restarts the app, and only that app", async () => {
  const { cwd } = fixture();
  const restarted = appIn(cwd);
  const other = appIn(cwd);
  const before = await appFilesRevision(restarted);
  const otherBefore = await appFilesRevision(other);
  bumpAppRestartSeq(restarted.name);
  expect(await appFilesRevision(restarted)).not.toBe(before);
  expect(await appFilesRevision(other)).toBe(otherBefore);
});

// A widget reloads only on a request newer than the last one it saw, so each
// request must be newer than the one before, even within one millisecond or
// after the clock steps back.
it("makes each reload request newer than the last, whatever the clock says", () => {
  const name = `reload-${++seq}`;
  const now = spyOn(Date, "now");
  try {
    expect(appReloadRequestedAt(name)).toBe(null);
    now.mockReturnValue(5000);
    requestAppReload(name);
    expect(appReloadRequestedAt(name)).toBe(5000);
    requestAppReload(name);
    expect(appReloadRequestedAt(name)).toBeGreaterThan(5000);
    const second = appReloadRequestedAt(name)!;
    now.mockReturnValue(1000);
    requestAppReload(name);
    expect(appReloadRequestedAt(name)).toBeGreaterThan(second);
  } finally {
    now.mockRestore();
  }
});

it("is null when the app folder cannot be read", async () => {
  const app = appIn(join(tempDir(), "gone"));
  expect(await appFilesRevision(app)).toBeNull();
});

// Serving means the app runs AND its port accepts: a stopped app whose port
// another process holds is not serving, and a running app before it binds is
// not serving either.
it("serves only when the app runs and its port accepts a connection", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  listener = server;
  const open = appIn(tempDir(), server.port);
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const closed = appIn(tempDir(), probe.port);
  probe.stop(true);
  expect(await appServing(open, true)).toBe(true);
  expect(await appServing(open, false)).toBe(false);
  expect(await appServing(closed, true)).toBe(false);
});
