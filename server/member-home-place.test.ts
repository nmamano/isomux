// The office's side of the place of a moved home (task 78733adf, slice
// 5c-2; server/member-home-place.ts). The properties: the stage is walked
// with lstat and never through a link (a link goes as its target's text);
// a folder comes before what it holds; a file's bytes are read after its
// header and a short read fails the walk instead of padding (D8); a runner
// that stops reading, or a tree-place that never answers, fails the place
// within the stall bound (D7); a whole place through tree-in and
// tree-place (the runner's code, in this process) gives her home the
// stage's tree, read-only folders included (D4).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  placeMemberHome,
  stageTotals,
  stageTreeFrames,
} from "./member-home-place.ts";
import {
  placeTree,
  receiveTree,
  type TreeEntryHeader,
  type TreeInInput,
  type TreePlaceInput,
} from "./member-home-receive.ts";
import type { AgentHost } from "./agent-host.ts";

let root: string;
let stage: string;
let home: string;
let outside: string;

// Tests: give every folder under `dir` u+rwx, each before it is listed (a
// folder can be unlistable, as a 0311 one is), so rm can take it.
function openUp(dir: string): void {
  const stack = [dir];
  while (stack.length > 0) {
    const p = stack.pop()!;
    try {
      if (!lstatSync(p).isDirectory()) continue;
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) stack.push(join(p, n));
    } catch {
      // Gone.
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "member-home-place-"));
  stage = join(root, "state", "move-members", "u-alice", "home");
  home = join(root, "home");
  outside = join(root, "outside");
  mkdirSync(stage, { recursive: true });
  mkdirSync(join(home, ".isomux-agent"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "NOT HER STAGE");
});

afterEach(() => {
  openUp(root);
  rmSync(root, { recursive: true, force: true });
});

// The stage of a small home: folders, files, a link out of the stage, and
// a read-only folder at the top and nested.
function smallStage(): void {
  mkdirSync(join(stage, "docs", "deep"), { recursive: true });
  writeFileSync(join(stage, "docs", "a.txt"), "hello");
  writeFileSync(join(stage, "docs", "deep", "b.bin"), "b".repeat(70_000));
  writeFileSync(join(stage, ".bashrc"), "her bashrc");
  chmodSync(join(stage, ".bashrc"), 0o640);
  symlinkSync(join(outside, "secret"), join(stage, "docs", "to-secret"));
  mkdirSync(join(stage, "ro", "inner"), { recursive: true });
  writeFileSync(join(stage, "ro", "inner", "f"), "ro content");
  chmodSync(join(stage, "ro", "inner"), 0o555);
  chmodSync(join(stage, "ro"), 0o555);
}

// The frames of a byte stream: headers and their data, in order.
interface Decoded {
  h: TreeEntryHeader;
  bytes: Buffer;
}

async function decode(
  chunks: AsyncIterable<Uint8Array>,
  onHeader?: (h: TreeEntryHeader) => void,
): Promise<{ entries: Decoded[]; ended: boolean }> {
  const entries: Decoded[] = [];
  let buf = Buffer.alloc(0);
  let ended = false;
  for await (const chunk of chunks) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      if (len === 0) {
        ended = true;
        continue;
      }
      const last = entries.at(-1);
      if (last && last.h.t === "f" && last.bytes.length < last.h.size) {
        last.bytes = Buffer.concat([last.bytes, body]);
        continue;
      }
      const h = JSON.parse(body.toString("utf8")) as TreeEntryHeader;
      entries.push({ h, bytes: Buffer.alloc(0) });
      onHeader?.(h);
    }
  }
  return { entries, ended };
}

describe("stageTotals", () => {
  it("counts every entry under the stage and the bytes of its files, never through a link", () => {
    smallStage();
    // docs, docs/deep, docs/a.txt, docs/deep/b.bin, .bashrc,
    // docs/to-secret, ro, ro/inner, ro/inner/f.
    expect(stageTotals(stage)).toEqual({
      entries: 9,
      bytes: 5 + 70_000 + 10 + 10,
    });
  });
});

describe("stageTreeFrames", () => {
  it("sends each entry once with its lstat kind, mode and bytes, a folder before its content, and a link as its target", async () => {
    smallStage();
    const counted: number[] = [];
    const { entries, ended } = await decode(
      stageTreeFrames(stage, (b) => counted.push(b)),
    );
    expect(ended).toBe(true);
    const byPath = new Map(entries.map((e) => [e.h.p, e]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        ".bashrc",
        "docs",
        "docs/a.txt",
        "docs/deep",
        "docs/deep/b.bin",
        "docs/to-secret",
        "ro",
        "ro/inner",
        "ro/inner/f",
      ].sort(),
    );
    expect(entries.length).toBe(9);
    const at = (p: string) => entries.findIndex((e) => e.h.p === p);
    for (const [parent, child] of [
      ["docs", "docs/a.txt"],
      ["docs", "docs/deep"],
      ["docs/deep", "docs/deep/b.bin"],
      ["ro", "ro/inner"],
      ["ro/inner", "ro/inner/f"],
    ])
      expect([parent, child, at(parent) < at(child)]).toEqual([
        parent,
        child,
        true,
      ]);
    const link = byPath.get("docs/to-secret")!;
    expect([link.h.t, link.h.l, link.bytes.length]).toEqual([
      "l",
      join(outside, "secret"),
      0,
    ]);
    expect(byPath.get("docs/deep/b.bin")!.bytes.toString()).toBe(
      "b".repeat(70_000),
    );
    expect(byPath.get(".bashrc")!.h.mode & 0o7777).toBe(0o640);
    expect(byPath.get("ro")!.h.mode & 0o7777).toBe(0o555);
    expect(byPath.get("ro/inner")!.h.mode & 0o7777).toBe(0o555);
    expect(byPath.get("ro")!.h.t).toBe("d");
    // No byte of the link's target went out.
    for (const e of entries)
      expect(e.bytes.toString()).not.toContain("NOT HER STAGE");
    expect(counted.length).toBe(9);
  });

  it("fails when a file gives fewer bytes than its header, and never pads it", async () => {
    // Large enough that its bytes are read after its header goes out.
    const big = join(stage, "big");
    writeFileSync(big, "z".repeat(4 * 1024 * 1024));
    writeFileSync(join(stage, "small"), "s");
    let truncated = false;
    const sent: Decoded[] = [];
    const run = (async () => {
      const result = await decode(stageTreeFrames(stage), (h) => {
        if (h.p === "big") {
          truncateSync(big, 1000);
          truncated = true;
        }
      });
      sent.push(...result.entries);
    })();
    await expect(run).rejects.toThrow();
    // The condition the case needs: the file shrank after its header.
    expect(truncated).toBe(true);
  });
});

// A runner host that runs the runner's code in this process, as the member
// would (the test's own uid).
function runnerHost(
  over: Partial<{
    stream: (
      input: TreeInInput,
      body: AsyncIterable<Uint8Array>,
    ) => Promise<unknown>;
    place: (input: TreePlaceInput) => Promise<unknown>;
  }> = {},
) {
  const calls: string[] = [];
  const host = {
    runEntryStream: async (
      name: string,
      input: unknown,
      body: AsyncIterable<Uint8Array>,
    ) => {
      calls.push(name);
      if (name !== "tree-in") throw new Error(`unexpected entry ${name}`);
      return over.stream
        ? over.stream(input as TreeInInput, body)
        : receiveTree(input as TreeInInput, body);
    },
    runEntry: async (name: string, input: unknown) => {
      calls.push(name);
      if (name !== "tree-place") throw new Error(`unexpected entry ${name}`);
      return over.place
        ? over.place(input as TreePlaceInput)
        : placeTree(input as TreePlaceInput);
    },
  } as unknown as Pick<AgentHost, "runEntry" | "runEntryStream">;
  return { host, calls };
}

// How a promise settles within `ms`: a hang reads as "hung", so a mutant
// with no stall bound fails on the assertion, not on the test's timeout.
function settledWithin(
  promise: Promise<unknown>,
  ms = 2000,
): Promise<"ok" | "failed" | "hung"> {
  return Promise.race([
    promise.then(
      () => "ok" as const,
      () => "failed" as const,
    ),
    Bun.sleep(ms).then(() => "hung" as const),
  ]);
}

describe("placeMemberHome", () => {
  it("places the stage in her home through tree-in then tree-place, and reports the progress up to the total", async () => {
    smallStage();
    const { host, calls } = runnerHost();
    const progress: [number, number][] = [];
    const answer = await placeMemberHome({
      userId: "u-alice",
      stageDir: stage,
      home,
      host,
      onProgress: (placed, total) => progress.push([placed, total]),
    });
    expect(calls).toEqual(["tree-in", "tree-place"]);
    expect(answer).toEqual({ files: 4, bytes: 5 + 70_000 + 10 + 10 });
    expect(readFileSync(join(home, "docs/a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(home, "ro/inner/f"), "utf8")).toBe("ro content");
    expect(lstatSync(join(home, "ro")).mode & 0o7777).toBe(0o555);
    expect(readlinkSync(join(home, "docs/to-secret"))).toBe(
      join(outside, "secret"),
    );
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1)!;
    expect(last[0]).toBe(last[1]);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
  });

  // D4: the office opens a stage folder it cannot list only to read it.
  // The mode it sends is her mode, also when the place runs again after a
  // failed one (the job starts from the start).
  it("sends a folder's own mode when the office must open it to list it, also on a second run", async () => {
    mkdirSync(join(stage, "drop"));
    writeFileSync(join(stage, "drop", "f"), "in drop");
    chmodSync(join(stage, "drop"), 0o311);
    // The condition: the office cannot list it as it is.
    expect(lstatSync(join(stage, "drop")).mode & 0o7777).toBe(0o311);
    for (let run = 1; run <= 2; run++) {
      const { entries } = await decode(stageTreeFrames(stage));
      const drop = entries.find((e) => e.h.p === "drop")!;
      expect([run, drop.h.mode & 0o7777]).toEqual([run, 0o311]);
      expect([run, entries.some((e) => e.h.p === "drop/f")]).toEqual([
        run,
        true,
      ]);
      expect(stageTotals(stage).entries).toBe(2);
    }
    const { host } = runnerHost();
    await placeMemberHome({ userId: "u-alice", stageDir: stage, home, host });
    expect(lstatSync(join(home, "drop")).mode & 0o7777).toBe(0o311);
  });

  it("fails within the stall bound when the runner stops reading", async () => {
    // Enough bytes that the stream cannot fit in what the runner took.
    writeFileSync(join(stage, "big"), "q".repeat(8 * 1024 * 1024));
    const { host } = runnerHost({
      stream: async (_input, body) => {
        // One read, then never another (and no return() on the body).
        await body[Symbol.asyncIterator]().next();
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    expect(
      await settledWithin(
        placeMemberHome({
          userId: "u-alice",
          stageDir: stage,
          home,
          host,
          stallMs: 200,
          callMs: 60_000,
        }),
      ),
    ).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails within the stall bound when tree-place never answers", async () => {
    writeFileSync(join(stage, "f"), "x");
    const { host, calls } = runnerHost({ place: () => new Promise(() => {}) });
    const started = Date.now();
    expect(
      await settledWithin(
        placeMemberHome({
          userId: "u-alice",
          stageDir: stage,
          home,
          host,
          stallMs: 200,
          callMs: 60_000,
        }),
      ),
    ).toBe("failed");
    expect(calls).toEqual(["tree-in", "tree-place"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails when tree-in fails, and does not run tree-place", async () => {
    writeFileSync(join(stage, "f"), "x");
    const { host, calls } = runnerHost({
      stream: async () => {
        throw new Error("no room");
      },
    });
    await expect(
      placeMemberHome({ userId: "u-alice", stageDir: stage, home, host }),
    ).rejects.toThrow();
    expect(calls).toEqual(["tree-in"]);
  });
});
