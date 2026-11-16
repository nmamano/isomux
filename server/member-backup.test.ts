// The office's side of the backup of an isolated member's agent space
// (member-backup.ts, slice 3c). Her runner runs as her, so she controls
// every byte of both streams. The properties:
// - a copy holds her space as listed: files 0600 and folders 0700 that the
//   office made, no link made, nothing the exclusions leave out, and a
//   member.json that names what is left out;
// - nothing she sends can put a file outside her folder or make the office
//   write what it did not ask for: any such stream ends her part with no
//   tree of this run (D2), and the office goes on;
// - free space is checked for her alone (D1);
// - an unchanged file is a hard link to the previous copy's (incremental);
// - a member not copied carries the tree of the copy where she was last
//   copied, through any number of carries (E1);
// - her stream is closed when the office stops reading it;
// - the event loop is never held for long (C8).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHost } from "./agent-host.ts";
import {
  listSpace,
  sendSpaceFiles,
  type SpaceFilesInput,
} from "./member-backup-send.ts";
import {
  copyMemberSpace,
  MEMBER_MANIFEST,
  MEMBER_SPACE,
  MEMBERS_DIR,
  readMemberManifest,
  readMemberMarker,
  type MemberBackupSource,
  type MemberCopyContext,
  type PreviousMemberTree,
} from "./member-backup.ts";

let top = "";
beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), "member-backup-"));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

let serial = 0;
const fresh = (name: string) => {
  const dir = join(top, `${name}-${++serial}`);
  mkdirSync(dir);
  return dir;
};

const USER = "u-alice";
const OS_USER = { name: "isomux-alice", uid: 4711 };

type Entry = "backup-list" | "backup-files";
// A host whose streams come from `make`, each counted and with a close
// flag set when the office ends it.
function hostOf(
  agentRoot: string,
  make: (name: Entry, input: unknown) => AsyncIterable<Uint8Array>,
) {
  const calls: { name: Entry; input: unknown }[] = [];
  const open = { count: 0 };
  const host = {
    agentRoot: () => agentRoot,
    runEntryOut: (name: Entry, input: unknown) => {
      calls.push({ name, input });
      const inner = make(name, input);
      return (async function* () {
        open.count++;
        try {
          yield* inner;
        } finally {
          open.count--;
        }
      })();
    },
  } as unknown as AgentHost;
  return { host, calls, open };
}

async function* chunks(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

// Her real runner's side, in process, over a real tree.
function treeHost(space: string) {
  return hostOf(space, (name, input) => {
    const out: Buffer[] = [];
    const write = (chunk: Uint8Array) => {
      out.push(Buffer.from(chunk));
    };
    return (async function* () {
      if (name === "backup-list")
        await listSpace(input as { agentRoot: string }, write);
      else await sendSpaceFiles(input as SpaceFilesInput, write);
      yield* out;
    })();
  });
}

function makeSpace(files: Record<string, string>): string {
  const space = fresh("space");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(space, rel, ".."), { recursive: true });
    writeFileSync(join(space, rel), text);
  }
  return space;
}

function context(over: Partial<MemberCopyContext> = {}): MemberCopyContext {
  const partial = fresh("partial");
  return {
    partial,
    startedAt: 1000 + serial,
    previous: null,
    fits: () => true,
    checkSpace: () => {},
    log: () => {},
    ...over,
  };
}

const memberDir = (ctx: MemberCopyContext) =>
  join(ctx.partial, MEMBERS_DIR, USER);
const source = (host: AgentHost | null): MemberBackupSource => ({
  userId: USER,
  osUser: OS_USER,
  host,
});
// What her folder of this copy holds, at the top.
const topOf = (ctx: MemberCopyContext) => readdirSync(memberDir(ctx)).sort();
const asPrevious = (
  ctx: MemberCopyContext,
  copyName: string,
): PreviousMemberTree => ({
  copyName,
  dir: memberDir(ctx),
  marker: readMemberMarker(memberDir(ctx))!,
});

// A listing line of an entry, valid unless changed.
const entry = (p: string, k: "d" | "f" | "l" | "x", over: object = {}) => ({
  p,
  k,
  mode: k === "d" ? 0o700 : 0o600,
  size: 0,
  mtimeNs: "1000000000",
  ctimeNs: "1000000000",
  ino: String(p.length + 7),
  ...over,
});
const lines = (...values: unknown[]) =>
  Buffer.from(values.map((v) => `${JSON.stringify(v)}\n`).join(""));
const END = { end: true };
const record = (header: object, bytes = "") => {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([length, json, Buffer.from(bytes)]);
};
const STOP = Buffer.alloc(4);

describe("a copy of her space", () => {
  it("holds her files as the office's, no link, nothing left out by the exclusions, and names what it lacks", async () => {
    const space = makeSpace({
      "provider-homes/u1/claude/projects/s.jsonl": "TRANSCRIPT",
      "provider-homes/u1/claude/.credentials.json": "SECRET",
      "apps/secrets/app1.json": "APPSECRET",
      "apps/data/app1/x/cache/keep.txt": "KEEP",
    });
    symlinkSync("/etc", join(space, "etc-link"));
    expect(Bun.spawnSync(["mkfifo", join(space, "pipe")]).exitCode).toBe(0);
    const ctx = context();
    const { host, open } = treeHost(space);
    const result = await copyMemberSpace(source(host), ctx);
    const copy = join(memberDir(ctx), MEMBER_SPACE);
    const mode = (rel: string) => lstatSync(join(copy, rel)).mode & 0o777;
    const marker = readMemberMarker(memberDir(ctx))!;
    expect({
      state: result.state,
      top: topOf(ctx),
      transcript: readFileSync(
        join(copy, "provider-homes/u1/claude/projects/s.jsonl"),
        "utf8",
      ),
      deep: existsSync(join(copy, "apps/data/app1/x/cache/keep.txt")),
      secrets: [".credentials.json", "apps/secrets"].filter((rel) =>
        existsSync(
          join(
            copy,
            rel === ".credentials.json"
              ? "provider-homes/u1/claude/.credentials.json"
              : rel,
          ),
        ),
      ),
      link: existsSync(join(copy, "etc-link")),
      modes: [
        mode("provider-homes/u1/claude/projects/s.jsonl"),
        mode("provider-homes"),
      ],
      marker: [marker.state, marker.links, marker.leftOut],
      open: open.count,
    }).toEqual({
      state: "copied",
      top: [MEMBER_MANIFEST, "member.json", MEMBER_SPACE],
      transcript: "TRANSCRIPT",
      deep: true,
      secrets: [],
      link: false,
      modes: [0o600, 0o700],
      marker: ["copied", 1, { counts: { fifo: 1 }, names: ["pipe"] }],
      open: 0,
    });
    const manifest = await readMemberManifest(memberDir(ctx));
    expect(manifest.find((line) => line.p === "etc-link")).toMatchObject({
      k: "l",
      t: "/etc",
    });
  });
});

describe("a listing she made up", () => {
  const cases: [string, Buffer][] = [
    ["a path up", lines(entry("../escape", "d"), END)],
    ["an absolute path", lines(entry("/tmp/escape", "d"), END)],
    ["an empty segment", lines(entry("a", "d"), entry("a//b", "d"), END)],
    ["a path twice", lines(entry("a", "d"), entry("a", "d"), END)],
    ["a file before its folder", lines(entry("a/b", "f"), END)],
    [
      "a child of a link",
      lines(entry("l", "l", { target: "/" }), entry("l/x", "f"), END),
    ],
    ["no end", lines(entry("a", "d"))],
    ["a line after the end", lines(entry("a", "d"), END, entry("b", "d"))],
    ["a line that is not an entry", lines({ p: "a", k: "q" }, END)],
    ["a line too long", lines(entry(`${"a".repeat(70_000)}`, "d"), END)],
  ];
  for (const [label, bytes] of cases)
    it(`ends her part with no tree for ${label}, and her stream is closed`, async () => {
      const ctx = context();
      const { host, calls, open } = hostOf(
        "/home/isomux-alice/.isomux-agent",
        () => chunks([bytes]),
      );
      const result = await copyMemberSpace(source(host), ctx);
      expect({
        state: result.state,
        top: topOf(ctx),
        files: calls.filter((c) => c.name === "backup-files").length,
        outside: existsSync(join(ctx.partial, MEMBERS_DIR, "escape")),
        open: open.count,
      }).toEqual({
        state: "skipped",
        top: ["member.json"],
        files: 0,
        outside: false,
        open: 0,
      });
    });

  it("drops a path the exclusions leave out, with what is under it, and asks for none of it", async () => {
    const ctx = context();
    const { host, calls } = hostOf("/s", (name) =>
      chunks([
        name === "backup-list"
          ? lines(
              entry("apps", "d"),
              entry("apps/secrets", "d"),
              entry("apps/secrets/a.json", "f", { size: 3 }),
              entry("k.txt", "f", { size: 1 }),
              entry("x", "d"),
              entry("x/.credentials.json", "f", { size: 3 }),
              END,
            )
          : Buffer.concat([record({ i: 0, size: 1 }, "K"), STOP]),
      ]),
    );
    const result = await copyMemberSpace(source(host), ctx);
    const asked = (
      calls.find((c) => c.name === "backup-files")!.input as SpaceFilesInput
    ).files.map((f) => f.p);
    expect([
      result.state,
      asked,
      readdirSync(join(memberDir(ctx), MEMBER_SPACE)).sort(),
    ]).toEqual(["copied", ["k.txt"], ["apps", "k.txt", "x"]]);
  });
});

describe("a file stream she made up", () => {
  const listing = lines(
    entry("d", "d"),
    entry("d/a", "f", { size: 3 }),
    entry("d/b", "f", { size: 3 }),
    END,
  );
  const cases: [string, Buffer[]][] = [
    ["a file not asked for", [record({ i: 2, size: 3 }, "xxx"), STOP]],
    [
      "a file twice",
      [
        record({ i: 0, size: 3 }, "aaa"),
        record({ i: 0, size: 3 }, "aaa"),
        STOP,
      ],
    ],
    [
      "another size",
      [
        record({ i: 0, size: 4 }, "aaaa"),
        record({ i: 1, size: 3 }, "bbb"),
        STOP,
      ],
    ],
    ["a file missing", [record({ i: 0, size: 3 }, "aaa"), STOP]],
    [
      "bytes after the end",
      [
        record({ i: 0, size: 3 }, "aaa"),
        record({ i: 1, size: 3 }, "bbb"),
        STOP,
        Buffer.from("x"),
      ],
    ],
    [
      "a left-out record with bytes",
      [
        record({ i: 0, size: 3, left: "gone" }, "aaa"),
        record({ i: 1, size: 3 }, "bbb"),
        STOP,
      ],
    ],
    // D2: the stream breaks in the middle of a file.
    [
      "a stream that ends in a file",
      [record({ i: 0, size: 3 }, "aaa"), record({ i: 1, size: 3 }, "b")],
    ],
  ];
  for (const [label, parts] of cases)
    it(`ends her part with no tree for ${label}`, async () => {
      const ctx = context();
      const { host, open } = hostOf("/s", (name) =>
        chunks(name === "backup-list" ? [listing] : parts),
      );
      const result = await copyMemberSpace(source(host), ctx);
      expect([result.state, topOf(ctx), open.count]).toEqual([
        "skipped",
        ["member.json"],
        0,
      ]);
    });

  it("copies a stream that is right, and counts a file she no longer has", async () => {
    const ctx = context();
    const { host } = hostOf("/s", (name) =>
      chunks(
        name === "backup-list"
          ? [listing]
          : [
              record({ i: 0, size: 3 }, "aaa"),
              record({ i: 1, size: 0, left: "gone" }),
              STOP,
            ],
      ),
    );
    const result = await copyMemberSpace(source(host), ctx);
    expect([
      result.state,
      readdirSync(join(memberDir(ctx), MEMBER_SPACE, "d")),
      readMemberMarker(memberDir(ctx))?.leftOut,
    ]).toEqual(["copied", ["a"], { counts: { gone: 1 }, names: ["d/b"] }]);
  });
});

describe("free space", () => {
  it("skips her when her copy does not fit, before any write (D1)", async () => {
    const space = makeSpace({ "a.txt": "AAAA" });
    const ctx = context({ fits: () => false });
    const { host, calls } = treeHost(space);
    const result = await copyMemberSpace(source(host), ctx);
    expect([result.state, topOf(ctx), calls.map((c) => c.name)]).toEqual([
      "skipped",
      ["member.json"],
      ["backup-list"],
    ]);
  });
});

describe("the next copy", () => {
  it("links an unchanged file to the previous copy and asks only for the others", async () => {
    const space = makeSpace({ "same.txt": "SAME", "moved.txt": "OLD" });
    const first = context();
    await copyMemberSpace(source(treeHost(space).host), first);
    writeFileSync(join(space, "moved.txt"), "NEW!");
    const second = context({ previous: asPrevious(first, "c1") });
    const { host, calls } = treeHost(space);
    const result = await copyMemberSpace(source(host), second);
    const inode = (ctx: MemberCopyContext, rel: string) =>
      lstatSync(join(memberDir(ctx), MEMBER_SPACE, rel)).ino;
    const asked = (
      calls.find((c) => c.name === "backup-files")!.input as SpaceFilesInput
    ).files.map((f) => f.p);
    expect({
      state: result.state,
      newBytes: result.newBytes,
      asked,
      linked: inode(first, "same.txt") === inode(second, "same.txt"),
      moved: readFileSync(
        join(memberDir(second), MEMBER_SPACE, "moved.txt"),
        "utf8",
      ),
    }).toEqual({
      state: "copied",
      newBytes: 4,
      asked: ["moved.txt"],
      linked: true,
      moved: "NEW!",
    });
  });

  it("asks again for a file that changed while it was read", async () => {
    const listing = lines(entry("a", "f", { size: 3 }), END);
    const run = async (previous: PreviousMemberTree | null) => {
      const ctx = context({ previous });
      const { host, calls } = hostOf("/s", (name) =>
        chunks(
          name === "backup-list"
            ? [listing]
            : [record({ i: 0, size: 3, changed: true }, "aaa"), STOP],
        ),
      );
      await copyMemberSpace(source(host), ctx);
      return {
        ctx,
        asked: calls.filter((c) => c.name === "backup-files").length,
      };
    };
    const first = await run(null);
    const second = await run(asPrevious(first.ctx, "c1"));
    expect([first.asked, second.asked]).toEqual([1, 1]);
  });

  it("asks again for a file whose previous copy is no longer intact", async () => {
    const space = makeSpace({ "same.txt": "SAME" });
    const first = context();
    await copyMemberSpace(source(treeHost(space).host), first);
    truncateSync(join(memberDir(first), MEMBER_SPACE, "same.txt"), 1);
    const second = context({ previous: asPrevious(first, "c1") });
    const { host, calls } = treeHost(space);
    await copyMemberSpace(source(host), second);
    expect([
      (
        calls.find((c) => c.name === "backup-files")?.input as
          SpaceFilesInput | undefined
      )?.files.map((f) => f.p),
      readFileSync(join(memberDir(second), MEMBER_SPACE, "same.txt"), "utf8"),
    ]).toEqual([["same.txt"], "SAME"]);
  });
});

describe("a member not copied in a run (E1)", () => {
  it("carries the tree of the copy where she was copied, through carries, and is skipped when it is broken", async () => {
    const space = makeSpace({ "a/keep.txt": "KEEP" });
    const c1 = context();
    await copyMemberSpace(source(treeHost(space).host), c1);
    const c2 = context({ previous: asPrevious(c1, "c1") });
    const r2 = await copyMemberSpace(source(null), c2);
    // A stream that breaks is carried too.
    const c3 = context({ previous: asPrevious(c2, "c2") });
    const broken = hostOf("/s", () => chunks([lines(entry("a", "d"))]));
    const r3 = await copyMemberSpace(source(broken.host), c3);
    const m1 = readMemberMarker(memberDir(c1))!;
    const m3 = readMemberMarker(memberDir(c3))!;
    const inode = (ctx: MemberCopyContext) =>
      lstatSync(join(memberDir(ctx), MEMBER_SPACE, "a/keep.txt")).ino;
    expect({
      states: [r2.state, r3.state],
      from: [readMemberMarker(memberDir(c2))?.carriedFrom, m3.carriedFrom],
      copiedAt: m3.copiedAt === m1.copiedAt && m1.copiedAt === c1.startedAt,
      sameFile: inode(c1) === inode(c3),
      newBytes: [r2.newBytes, r3.newBytes],
    }).toEqual({
      states: ["carried", "carried"],
      from: ["c1", "c1"],
      copiedAt: true,
      sameFile: true,
      newBytes: [0, 0],
    });
    // A carried tree that does not verify is not carried.
    truncateSync(join(memberDir(c3), MEMBER_SPACE, "a/keep.txt"), 1);
    const c4 = context({ previous: asPrevious(c3, "c3") });
    const r4 = await copyMemberSpace(source(null), c4);
    expect([r4.state, topOf(c4)]).toEqual(["skipped", ["member.json"]]);
  });

  it("makes no folder for a member id that cannot name one", async () => {
    const ctx = context();
    const result = await copyMemberSpace(
      { userId: "../u", osUser: OS_USER, host: null },
      ctx,
    );
    expect([result.state, existsSync(join(ctx.partial, MEMBERS_DIR))]).toEqual([
      "skipped",
      false,
    ]);
  });

  // F2: her folder cannot be made (here: an entry already holds its name).
  it("answers skipped when her folder cannot be made, and leaves what was there", async () => {
    const ctx = context();
    mkdirSync(join(ctx.partial, MEMBERS_DIR, USER), { recursive: true });
    writeFileSync(join(ctx.partial, MEMBERS_DIR, USER, "other"), "OTHER");
    const result = await copyMemberSpace(source(null), ctx);
    expect([result.state, topOf(ctx)]).toEqual(["skipped", ["other"]]);
  });
});

describe("the event loop", () => {
  // C8: a member with many folders, sent in the largest frames a runner may
  // send (1 MiB), all queued at once.
  it("is never held for long while her listing is read and her folders are made", async () => {
    const count = 20_000;
    const all = lines(
      ...Array.from({ length: count }, (_, i) =>
        entry(`f${String(i).padStart(6, "0")}`, "d"),
      ),
      END,
    );
    const frames: Buffer[] = [];
    for (let at = 0; at < all.length; at += 1024 * 1024)
      frames.push(all.subarray(at, at + 1024 * 1024));
    // On a tmpfs when there is one: the test measures the CPU the office
    // holds the loop for, not one slow mkdir on a busy disk.
    const base = existsSync("/dev/shm") ? "/dev/shm" : top;
    const partial = mkdtempSync(join(base, "member-backup-loop-"));
    const ctx = context({ partial });
    const { host } = hostOf("/s", () => chunks(frames));
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    let result;
    try {
      result = await copyMemberSpace(source(host), ctx);
    } finally {
      clearInterval(timer);
      longest = Math.max(longest, performance.now() - last);
      rmSync(partial, { recursive: true, force: true });
    }
    expect(result.state).toBe("copied");
    expect(longest).toBeLessThan(250);
  }, 30_000);
});
