// The homes of members with their own OS user at an office move, on the old
// office (office-move-members.ts, task 78733adf slice 5c-1). Every runner
// reply is member data (internal-docs/member-os-user-design.md 1.1), so the
// fakes here play a runner that lies. The properties:
// - the check of the preflight and the lock: a block per member and why
//   (D2, C2, C5, C6), the ready members as the lock records them, and the
//   409 body;
// - the walk: only well-formed lines in walk order reach the manifest; any
//   other line, a line over the cap, a missing end and a full disk fail her
//   walk, naming her (C3, C4, Q3);
// - the batch: only items the office could have listed go to her runner,
//   and a frame that breaks the request ends the batch (D6);
// - the source: her runner's info is checked (uid, user, home, runtime) and
//   every call is bounded in stalls and in total time (C1, C2, D7);
// - her units record (Q5).
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFrameDecoder,
  encodeData,
  encodeJson,
  FRAME_JSON,
  FRAME_STDOUT,
} from "./agent-runner/frames.ts";
import type { RunnerInfo } from "./agent-runner/client.ts";
import {
  MEMBER_HOME_LINE_MAX,
  MEMBER_HOME_NONCE,
  type HomeFilesInput,
  type HomeListInput,
} from "./member-home-send.ts";
import {
  checkMoveMembers,
  moveMemberHomeRefusal,
  moveMembersLockRefusal,
  MOVE_MEMBER_UNITS_FILE,
  readMemberUnitsRecord,
  restoreMemberUnits,
  runnerMemberHomeSource,
  walkMemberHome,
  writeMemberBatch,
  writeMemberUnitsRecord,
  type MemberHomeStreams,
  type MoveMember,
  type MoveMemberRecord,
  type MoveMembersDeps,
} from "./office-move-members.ts";
import {
  compareMoveWalkOrder,
  readMoveRecords,
  type MoveBatchItem,
} from "./office-move-pull.ts";
import type { AgentUnit } from "./office-move-units.ts";
import {
  MEMBER_OS_USERS_FILE,
  memberOsUserRecordsForMove,
} from "./member-os-users.ts";

let dir = "";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), "office-move-members-"));
  return dir;
}

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const MIA: MoveMember = {
  userId: "u-mia",
  name: "Mia",
  osUser: "isomux-mia",
  uid: 60001,
  home: "/home/isomux-mia",
  bundleHash: HASH,
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function* chunksOf(parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === "string" ? Buffer.from(p) : p;
}

// ---- the check of the preflight and the lock ----

interface DirStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
}
const dirOf = (uid: number): DirStat => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid,
});
const linkOf = (uid: number): DirStat => ({
  isDirectory: () => false,
  isSymbolicLink: () => true,
  uid,
});
const fileOf = (uid: number): DirStat => ({
  isDirectory: () => false,
  isSymbolicLink: () => false,
  uid,
});

describe("C5: moveMemberHomeRefusal", () => {
  const OFFICE_HOME = "/home/isomux";
  const STATE = "/srv/isomux-state";
  const refusal = (home: string, stat: DirStat | null = dirOf(60001)) =>
    moveMemberHomeRefusal(home, {
      uid: 60001,
      officeHome: OFFICE_HOME,
      stateRoot: STATE,
      lstat: () => stat,
    });

  it("takes an absolute, normalised folder of her own that is not a link and touches neither the office home nor the state root", () => {
    expect(refusal("/home/isomux-mia")).toBeNull();
    expect(refusal("/var/data/members/home/isomux-mia")).toBeNull();
    // A name that only starts like the office home is not in it.
    expect(refusal("/home/isomux-2")).toBeNull();
  });

  it("refuses every other home, with a reason", () => {
    const table: [string, DirStat | null][] = [
      ["home/isomux-mia", dirOf(60001)],
      ["/home/x/../isomux-mia", dirOf(60001)],
      ["/home/./isomux-mia", dirOf(60001)],
      ["/", dirOf(60001)],
      [OFFICE_HOME, dirOf(60001)],
      [`${OFFICE_HOME}/members/mia`, dirOf(60001)],
      [`${STATE}/mia`, dirOf(60001)],
      // A home above the office home would walk it.
      ["/home", dirOf(60001)],
      ["/srv", dirOf(60001)],
      ["/home/isomux-mia", linkOf(60001)],
      ["/home/isomux-mia", fileOf(60001)],
      ["/home/isomux-mia", dirOf(60002)],
      ["/home/isomux-mia", null],
    ];
    expect(
      table.map(([home, st], n) => [n, home, typeof refusal(home, st)]),
    ).toEqual(table.map(([home], n) => [n, home, "string"]));
  });
});

interface CheckBed {
  deps: MoveMembersDeps;
  infoCalls: string[];
}

function checkBed(
  records: MoveMemberRecord[] | { broken: true },
  over: {
    passwd?: Record<string, { uid: number; home: string } | null>;
    info?: Record<string, RunnerInfo | "down">;
    busy?: string[];
    hash?: string;
    units?: Record<string, AgentUnit[]>;
    lstat?: Record<string, DirStat | null>;
  } = {},
): CheckBed {
  const infoCalls: string[] = [];
  const deps: MoveMembersDeps = {
    records: () => (Array.isArray(records) ? { members: records } : records),
    passwd: (osUser) =>
      over.passwd && osUser in over.passwd
        ? over.passwd[osUser]
        : { uid: uidOf(osUser), home: `/home/${osUser}` },
    busy: (userId) => (over.busy ?? []).includes(userId),
    info: async (os) => {
      infoCalls.push(os.name);
      const v = over.info?.[os.name];
      if (v === "down") throw new Error("the runner did not answer");
      return (
        v ?? {
          uid: os.uid,
          gid: os.uid,
          user: os.name,
          home: `/home/${os.name}`,
          env: {},
          bundleHash: HASH,
        }
      );
    },
    expectedHash: async () => over.hash ?? HASH,
    listUnits: (m) => over.units?.[m.osUser] ?? [],
    officeHome: "/home/isomux",
    stateRoot: "/home/isomux/.isomux",
    lstat: (p) =>
      over.lstat && p in over.lstat
        ? over.lstat[p]
        : dirOf(uidOf(p.split("/").at(-1)!)),
  };
  return { deps, infoCalls };
}

const UIDS: Record<string, number> = {
  "isomux-mia": 60001,
  "isomux-sam": 60002,
  "isomux-lea": 60003,
};
const uidOf = (osUser: string) => UIDS[osUser] ?? 60099;

const record = (
  userId: string,
  name: string | null,
  osUser: string | null,
  over: Partial<MoveMemberRecord> = {},
): MoveMemberRecord => ({
  userId,
  name,
  osUser: osUser === null ? null : { name: osUser, uid: uidOf(osUser) },
  unfinished: false,
  movedIn: false,
  ...over,
});

describe("D1, D2, C2, C5, C6: checkMoveMembers and the lock's refusal", () => {
  it("a broken record refuses the lock as broken", async () => {
    const { deps } = checkBed({ broken: true });
    const check = await checkMoveMembers(deps);
    expect(check).toEqual({ broken: true });
    expect(moveMembersLockRefusal(check)).toEqual({ broken: true });
  });

  it("a ready member: her passwd home, her units, and the lock records her with uid and runtime; no refusal", async () => {
    const unit: AgentUnit = {
      name: "bot.service",
      fragmentPath: "/home/isomux-mia/.config/systemd/user/bot.service",
      unitFileState: "enabled",
      activeState: "active",
      transient: false,
    };
    const { deps } = checkBed([record("u-mia", "Mia", "isomux-mia")], {
      units: { "isomux-mia": [unit] },
    });
    const check = await checkMoveMembers(deps);
    if ("broken" in check) throw new Error("broken");
    expect(check.members).toEqual([
      {
        userId: "u-mia",
        name: "Mia",
        osUser: "isomux-mia",
        home: "/home/isomux-mia",
        block: null,
        units: [unit],
      },
    ]);
    expect(check.ready).toEqual([
      {
        userId: "u-mia",
        name: "Mia",
        osUser: "isomux-mia",
        uid: 60001,
        home: "/home/isomux-mia",
        bundleHash: HASH,
      },
    ]);
    expect(moveMembersLockRefusal(check)).toBeNull();
    // No isolated member at all: nothing to refuse either.
    const none = await checkMoveMembers(checkBed([]).deps);
    expect(none).toEqual({ members: [], ready: [] });
    expect(moveMembersLockRefusal(none)).toBeNull();
  });

  it("gives each member her block; the lock refuses naming the blocked ones, and a blocked member is never in the ready list", async () => {
    const mk = (n: number) => `isomux-m${n}`;
    for (let n = 1; n <= 12; n++) UIDS[mk(n)] = 61000 + n;
    const info = (n: number, over: Partial<RunnerInfo>): RunnerInfo => ({
      uid: 61000 + n,
      gid: 61000 + n,
      user: mk(n),
      home: `/home/${mk(n)}`,
      env: {},
      bundleHash: HASH,
      ...over,
    });
    const cases: [MoveMemberRecord, string][] = [
      [record("u1", "One", null), "broken"],
      [record("u2", "Two", mk(2), { unfinished: true }), "unfinished"],
      [record("u3", "Three", mk(3)), "busy"],
      [record("u4", "Four", mk(4), { movedIn: true }), "moved_in"],
      [record("u5", "Five", mk(5)), "bad_home"],
      [record("u6", "Six", mk(6)), "bad_home"],
      [record("u7", "Seven", mk(7)), "runner_down"],
      [record("u8", "Eight", mk(8)), "wrong_runner"],
      [record("u9", "Nine", mk(9)), "wrong_runner"],
      [record("u10", "Ten", mk(10)), "wrong_runner"],
      [record("u11", "Eleven", mk(11)), "old_runtime"],
      [record("u12", "Twelve", mk(12)), "bad_home"],
    ];
    const { deps } = checkBed(
      [...cases.map(([r]) => r), record("u-mia", "Mia", "isomux-mia")],
      {
        busy: ["u3"],
        passwd: { [mk(5)]: null, [mk(6)]: { uid: 61006, home: "/" } },
        info: {
          [mk(7)]: "down",
          // Another uid, user or home than her record and passwd give (D7).
          [mk(8)]: info(8, { uid: 61099 }),
          [mk(9)]: info(9, { user: "isomux-other" }),
          [mk(10)]: info(10, { home: "/home/elsewhere" }),
          [mk(11)]: info(11, { bundleHash: OTHER_HASH }),
        },
        lstat: { [`/home/${mk(12)}`]: linkOf(61012) },
      },
    );
    const check = await checkMoveMembers(deps);
    if ("broken" in check) throw new Error("broken");
    const blocks = Object.fromEntries(
      check.members.map((m) => [m.userId, m.block]),
    );
    expect(blocks).toEqual({
      ...Object.fromEntries(cases.map(([r, block]) => [r.userId, block])),
      "u-mia": null,
    });
    expect(check.ready.map((m) => m.userId)).toEqual(["u-mia"]);
    const refusal = moveMembersLockRefusal(check);
    if (!refusal || "broken" in refusal) throw new Error("no refusal");
    for (const [r] of cases)
      expect([r.userId, refusal.names.includes(r.name!)]).toEqual([
        r.userId,
        true,
      ]);
    expect(
      refusal.members.filter((m) => m.block !== null).map((m) => m.userId),
    ).toEqual(cases.map(([r]) => r.userId));
  });

  it("C2: a runner whose runtime differs from this office's is old_runtime; one with no runtime hash too", async () => {
    const one = await checkMoveMembers(
      checkBed([record("u-mia", "Mia", "isomux-mia")], { hash: OTHER_HASH })
        .deps,
    );
    const two = await checkMoveMembers(
      checkBed([record("u-mia", "Mia", "isomux-mia")], {
        info: {
          "isomux-mia": {
            uid: 60001,
            gid: 60001,
            user: "isomux-mia",
            home: "/home/isomux-mia",
            env: {},
            bundleHash: null,
          },
        },
      }).deps,
    );
    for (const c of [one, two]) {
      if ("broken" in c) throw new Error("broken");
      expect(c.members.map((m) => m.block)).toEqual(["old_runtime"]);
      expect(c.ready).toEqual([]);
    }
  });

  // Task e15a82e7: a member who runs as a person's existing OS user. Her
  // home is that person's whole home, so it never moves: the block says to
  // turn her OS user off first, and her runner is never asked.
  it("an adopted member is blocked as adopted, before her runner is asked; the record file carries it", async () => {
    const adopted = {
      adopted: true,
    } as unknown as Partial<MoveMemberRecord>;
    const bed = checkBed([
      record("u-mia", "Mia", "isomux-mia", adopted),
      record("u-sam", "Sam", "isomux-sam"),
    ]);
    const check = await checkMoveMembers(bed.deps);
    if ("broken" in check) throw new Error("broken");
    expect(check.members.map((m) => [m.userId, m.block])).toEqual([
      ["u-mia", "adopted"],
      ["u-sam", null],
    ]);
    expect(check.ready.map((m) => m.userId)).toEqual(["u-sam"]);
    expect(bed.infoCalls).toEqual(["isomux-sam"]);
    const refusal = moveMembersLockRefusal(check);
    if (!refusal || "broken" in refusal) throw new Error("no refusal");
    expect(refusal.names).toEqual(["Mia"]);

    // From the record file, as the office reads it at the preflight.
    const stateRoot = mkdtempSync(join(tmpdir(), "move-adopted-"));
    try {
      writeFileSync(
        join(stateRoot, MEMBER_OS_USERS_FILE),
        JSON.stringify({
          "u-mia": { name: "isomux-mia", uid: 60001, adopted: true },
          "u-sam": { name: "isomux-sam", uid: 60002 },
        }),
      );
      const fromFile = await checkMoveMembers({
        ...bed.deps,
        records: () =>
          memberOsUserRecordsForMove(stateRoot, (id) =>
            id === "u-mia" ? "Mia" : "Sam",
          ),
      });
      if ("broken" in fromFile) throw new Error("broken");
      expect(fromFile.members.map((m) => [m.userId, m.block])).toEqual([
        ["u-mia", "adopted"],
        ["u-sam", null],
      ]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("a member no user has is named by her id", async () => {
    const check = await checkMoveMembers(
      checkBed([record("u-gone", null, "isomux-mia", { unfinished: true })])
        .deps,
    );
    if ("broken" in check) throw new Error("broken");
    expect(check.members.map((m) => m.name)).toEqual(["u-gone"]);
  });
});

// ---- the walk ----

type Line = Record<string, unknown>;
const f = (p: string, s = 1): Line => ({ p, t: "f", s, m: 1000, mode: 0o644 });
const d = (p: string): Line => ({ p, t: "d", s: 4096, m: 1000, mode: 0o755 });
const l = (p: string, target: string): Line => ({
  p,
  t: "l",
  s: target.length,
  m: 1000,
  mode: 0o777,
  l: target,
});
const x = (p: string): Line => ({ p, t: "x", s: 0, m: 1000, mode: 0o644 });
const END = { end: true };

// A good listing in walk order: the root's group, then each folder's group,
// depth first.
const GOOD: Line[] = [
  f("a.txt", 5),
  d("docs"),
  x("pipe"),
  d("z"),
  f("docs/b.txt", 7),
  d("docs/sub"),
  f("docs/sub/c.txt", 3),
  l("z/link", "/etc"),
];

const ndjson = (lines: unknown[]) =>
  lines.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n") +
  "\n";

interface ListBed {
  streams: MemberHomeStreams;
  inputs: HomeListInput[];
}

function listing(
  body: () => AsyncIterable<Uint8Array>,
  files?: MemberHomeStreams["files"],
): ListBed {
  const inputs: HomeListInput[] = [];
  return {
    inputs,
    streams: {
      list: (input) => {
        inputs.push(input);
        return body();
      },
      files:
        files ??
        (() => {
          throw new Error("no files in this case");
        }),
    },
  };
}

const linesOf = (lines: unknown[]) => () => chunksOf([ndjson(lines)]);

async function walk(
  b: ListBed,
  opts: Partial<Parameters<typeof walkMemberHome>[3]> = {},
) {
  const file = join(dir || scratch(), `m-${Math.random()}.ndjson`);
  try {
    const summary = await walkMemberHome(MIA, b.streams, file, {
      signal: new AbortController().signal,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      ...opts,
    });
    const written = readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => s !== "")
      .map((s) => JSON.parse(s) as Line);
    return { summary, written, error: null as string | null, file };
  } catch (err) {
    return {
      summary: null,
      written: null,
      error: (err as Error).message,
      file,
    };
  }
}

describe("C3, C4, Q3: walkMemberHome", () => {
  it("the good listing is in walk order (the condition of every bad case below)", () => {
    const paths = GOOD.map((e) => e.p as string);
    for (let i = 1; i < paths.length; i++)
      expect(compareMoveWalkOrder(paths[i - 1], paths[i])).toBeLessThan(0);
  });

  it("writes her f, d and l lines as given, counts a special as skipped, and asks for her recorded home with a fresh nonce", async () => {
    scratch();
    const b = listing(linesOf([...GOOD, END]));
    const got = await walk(b);
    expect(got.error).toBeNull();
    expect(got.written).toEqual(GOOD.filter((e) => e.t !== "x"));
    expect(statSync(got.file).mode & 0o777).toBe(0o600);
    expect(got.summary).toMatchObject({
      userId: "u-mia",
      osUser: "isomux-mia",
      home: "/home/isomux-mia",
      entries: 7,
      totalBytes: 15,
      skipped: 1,
    });
    expect(b.inputs.map((i) => i.home)).toEqual(["/home/isomux-mia"]);
    expect(MEMBER_HOME_NONCE.test(b.inputs[0].nonce)).toBe(true);
    const again = listing(linesOf([...GOOD, END]));
    await walk(again);
    expect(again.inputs[0].nonce).not.toBe(b.inputs[0].nonce);
  });

  it("fails her walk, naming her, on every line she could not have listed", async () => {
    scratch();
    const at = (i: number, ...lines: unknown[]) => [
      ...GOOD.slice(0, i),
      ...lines,
      ...GOOD.slice(i),
    ];
    const swap = (i: number) => {
      const g: unknown[] = [...GOOD];
      [g[i], g[i + 1]] = [g[i + 1], g[i]];
      return g;
    };
    const cases: [string, unknown[]][] = [
      ["absolute", at(0, f("/etc/passwd"))],
      ["dot-dot", [...GOOD, f("docs/../../etc/passwd")]],
      ["dot", [...GOOD.slice(0, 5), f("docs/./c.txt"), ...GOOD.slice(5)]],
      [
        "double slash",
        [...GOOD.slice(0, 5), f("docs//c.txt"), ...GOOD.slice(5)],
      ],
      ["trailing slash", at(4, d("y/"))],
      ["empty path", at(0, f(""))],
      ["listed twice", at(1, f("a.txt", 5))],
      ["out of order", swap(0)],
      ["parent never listed", [...GOOD, f("z/zz/r.txt")]],
      ["parent is a file", at(4, f("a.txt/x"))],
      ["parent is a link", [...GOOD, f("z/link/x")]],
      ["a cache", [d(".cache"), ...GOOD]],
      [
        "her SSH login keys",
        [
          d(".ssh"),
          ...GOOD.slice(0, 4),
          f(".ssh/authorized_keys"),
          ...GOOD.slice(4),
        ],
      ],
      [
        "what the office writes again",
        [
          d(".isomux-agent"),
          ...GOOD.slice(0, 4),
          d(".isomux-agent/apps"),
          d(".isomux-agent/apps/units"),
          ...GOOD.slice(4),
        ],
      ],
      ["an unknown type", at(0, { ...f("0.txt"), t: "s" })],
      ["a negative size", at(0, f("0.txt", -1))],
      ["a size as text", at(0, { ...f("0.txt"), s: "5" })],
      ["a mode as text", at(0, { ...f("0.txt"), mode: "644" })],
      ["a link with no target", at(0, { ...l("0.lnk", "x"), l: undefined })],
      ["not JSON", at(0, "{not json")],
      ["a JSON array", at(0, [1, 2])],
    ];
    const got: string[] = [];
    for (const [name, lines] of cases) {
      const r = await walk(listing(linesOf([...lines, END])));
      got.push(`${name}: ${r.error !== null && r.error.includes("Mia")}`);
    }
    expect(got).toEqual(cases.map(([name]) => `${name}: true`));
  });

  it("fails her walk with no end line, and with a line after the end line", async () => {
    scratch();
    const noEnd = await walk(listing(linesOf(GOOD)));
    const after = await walk(listing(linesOf([...GOOD, END, f("zz.txt")])));
    expect([
      noEnd.error?.includes("Mia"),
      after.error?.includes("Mia"),
    ]).toEqual([true, true]);
  });

  it("C3: a line over the cap fails her walk without reading on to its end", async () => {
    scratch();
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    let pulled = 0;
    // Bounded, and it gives the timers a turn, so a walk that reads on
    // fails this case instead of hanging the file.
    async function* endless() {
      yield Buffer.from(`${JSON.stringify(f("a.txt"))}\n{"p":"`);
      while (pulled < 1000) {
        pulled++;
        await new Promise((r) => setImmediate(r));
        yield chunk;
      }
    }
    const started = performance.now();
    const r = await walk(listing(endless));
    expect(r.error?.includes("Mia")).toBe(true);
    expect(pulled * chunk.length).toBeLessThanOrEqual(
      MEMBER_HOME_LINE_MAX + 2 * chunk.length,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("C3: fails her walk when the manifest's file system is under the floor at the start, and when an endless listing brings it there", async () => {
    scratch();
    const low = await walk(listing(linesOf([...GOOD, END])), {
      freeBytes: () => 999,
      freeFloorBytes: 1000,
    });
    expect(low.error?.includes("Mia")).toBe(true);

    // A forged runner: valid lines with no end. The disk fills as the
    // manifest grows.
    let lines = 0;
    async function* endless() {
      // Bounded (3M lines, then no end line), so a walk with no free-space
      // check fails the line count below instead of running for minutes.
      for (let batch = 0; batch < 3000; batch++) {
        await new Promise((r) => setImmediate(r));
        let s = "";
        for (let k = 0; k < 1000; k++) {
          lines++;
          s += `${JSON.stringify(f(`f${String(batch * 1000 + k).padStart(9, "0")}`))}\n`;
        }
        yield Buffer.from(s);
      }
    }
    let calls = 0;
    const started = performance.now();
    const r = await walk(listing(endless), {
      freeBytes: () => (++calls === 1 ? 10 ** 12 : 999),
      freeFloorBytes: 1000,
    });
    expect(r.error?.includes("Mia")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    // About 10 MB of manifest between two checks, never the whole stream.
    expect(lines).toBeLessThan(2_000_000);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  // Round 1: an unreadable path ({"u": path}) is kept in memory for the
  // status, not written to the manifest, so the free-space floor never sees
  // it. A forged runner must not grow the office's memory without bound.
  it("C3: an endless stream of unreadable paths fails her walk, naming her, long before it ends", async () => {
    scratch();
    let lines = 0;
    async function* endless() {
      // Bounded (1M lines, then an end line), so a walk that keeps them all
      // fails the count below instead of running for minutes.
      for (let batch = 0; batch < 1000; batch++) {
        await new Promise((r) => setImmediate(r));
        let s = "";
        for (let k = 0; k < 1000; k++) {
          lines++;
          s += `${JSON.stringify({ u: `u${String(batch * 1000 + k).padStart(9, "0")}` })}\n`;
        }
        yield Buffer.from(s);
      }
      yield Buffer.from(`${JSON.stringify(END)}\n`);
    }
    const r = await walk(listing(endless));
    expect(r.error?.includes("Mia")).toBe(true);
    expect(lines).toBeLessThan(500_000);
  }, 20_000);

  it("ends when its signal aborts, also while her runner is quiet", async () => {
    scratch();
    // The condition: the same start with an end walks.
    expect(
      (await walk(listing(linesOf([...GOOD.slice(0, 2), END])))).error,
    ).toBeNull();
    async function* slow() {
      yield Buffer.from(ndjson(GOOD.slice(0, 2)));
      await new Promise(() => {});
    }
    const ac = new AbortController();
    const started = performance.now();
    setTimeout(() => ac.abort(), 50);
    const r = await Promise.race([
      walk(listing(slow), { signal: ac.signal }),
      Bun.sleep(3000).then(() => ({ error: "still waiting" })),
    ]);
    expect(r.error).not.toBeNull();
    expect(r.error).not.toBe("still waiting");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// ---- the batch ----

const frame = (b: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
};
const jframe = (v: unknown) => frame(Buffer.from(JSON.stringify(v)));
const STREAM_END = Buffer.alloc(4);

// Her files, as an honest runner sends them.
const CONTENT: Record<string, string> = {
  "a.txt": "alpha",
  "docs/b.txt": "0123456789",
  "c.txt": "LATER BYTES",
};

function honest(items: HomeFilesInput["items"]): Buffer[] {
  const out: Buffer[] = [];
  for (const it of items) {
    const all = Buffer.from(CONTENT[it.p] ?? "");
    const bytes =
      it.offset !== undefined
        ? all.subarray(it.offset, it.offset + (it.length ?? all.length))
        : all;
    out.push(
      jframe({
        i: it.i,
        p: it.p,
        mode: 0o644,
        mtime: 1000,
        size: bytes.length,
        ...(it.offset !== undefined ? { offset: it.offset } : {}),
      }),
      // A zero length would be the end frame: no data frame then.
      ...(bytes.length > 0 ? [frame(bytes)] : []),
      jframe({ i: it.i, end: true }),
    );
  }
  out.push(STREAM_END);
  return out;
}

interface BatchRun {
  inputs: HomeFilesInput[];
  outcome: Record<string, string>;
  data: Record<string, string>;
  ends: Record<string, { bytes: number; sha256: string }>;
  raw: Buffer;
}

async function runBatch(
  items: MoveBatchItem[],
  script: (items: HomeFilesInput["items"]) => Buffer[],
  opts: { snapshots?: boolean } = {},
): Promise<BatchRun> {
  const inputs: HomeFilesInput[] = [];
  const streams: MemberHomeStreams = {
    list: () => {
      throw new Error("no list in this case");
    },
    files: (input) => {
      inputs.push(input);
      return chunksOf(script(input.items));
    },
  };
  const parts: Buffer[] = [];
  for await (const c of writeMemberBatch(MIA, streams, items, opts))
    parts.push(Buffer.from(c));
  const raw = Buffer.concat(parts);
  const outcome: Record<string, string> = {};
  const data: Record<string, string> = {};
  const ends: BatchRun["ends"] = {};
  let cur = "";
  async function* one() {
    yield raw;
  }
  for await (const ev of readMoveRecords(one())) {
    if (ev.type === "entry") {
      cur = ev.path;
      outcome[cur] = "open";
      data[cur] = "";
    } else if (ev.type === "data")
      data[cur] += Buffer.from(ev.bytes).toString();
    else if (ev.type === "end") {
      outcome[cur] = "ok";
      ends[cur] = { bytes: ev.bytes, sha256: ev.sha256 };
    } else outcome[ev.path] = "error";
  }
  return { inputs, outcome, data, ends, raw };
}

describe("D6: writeMemberBatch", () => {
  it("forwards her files with the hash the office computes, and asks for a range and the snapshot flag as given", async () => {
    const items: MoveBatchItem[] = [
      { path: "a.txt" },
      { path: "docs/b.txt", offset: 2, length: 3 },
    ];
    const on = await runBatch(items, honest);
    expect(on.outcome).toEqual({ "a.txt": "ok", "docs/b.txt": "ok" });
    expect(on.data).toEqual({ "a.txt": "alpha", "docs/b.txt": "234" });
    expect(on.ends["a.txt"]).toEqual({
      bytes: 5,
      sha256: sha256(Buffer.from("alpha")),
    });
    expect(on.inputs).toHaveLength(1);
    expect(on.inputs[0]).toMatchObject({
      home: "/home/isomux-mia",
      snapshot: true,
    });
    expect(MEMBER_HOME_NONCE.test(on.inputs[0].nonce)).toBe(true);
    expect(
      on.inputs[0].items.map((i) => [i.p, i.offset ?? null, i.length ?? null]),
    ).toEqual([
      ["a.txt", null, null],
      ["docs/b.txt", 2, 3],
    ]);
    const off = await runBatch([{ path: "a.txt" }], honest, {
      snapshots: false,
    });
    expect(off.inputs[0].snapshot).toBe(false);
    expect(off.outcome).toEqual({ "a.txt": "ok" });
  });

  it("an item the office could not have listed gets an error record and is never asked of her runner; the others go", async () => {
    const bad = [
      "/etc/passwd",
      "../x",
      "docs/../../x",
      "docs//b.txt",
      "./a.txt",
      ".cache/x",
      ".ssh/authorized_keys",
      ".isomux-agent/apps/units/app1.service",
      ".isomux-agent/.move-out/move-x.db",
      "",
    ];
    const r = await runBatch(
      [{ path: "a.txt" }, ...bad.map((path) => ({ path })), { path: "c.txt" }],
      honest,
    );
    expect(r.outcome).toEqual({
      "a.txt": "ok",
      ...Object.fromEntries(bad.map((p) => [p, "error"])),
      "c.txt": "ok",
    });
    expect(r.inputs.flatMap((i) => i.items.map((it) => it.p))).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  it("a frame that breaks the request ends the batch: the item that broke and every later one get an error, and no later byte of hers is forwarded", async () => {
    const items: MoveBatchItem[] = [
      { path: "a.txt" },
      { path: "docs/b.txt", offset: 2, length: 3 },
      { path: "c.txt" },
    ];
    // Each script answers a.txt honestly, then breaks on docs/b.txt.
    type Break = (its: HomeFilesInput["items"]) => Buffer[];
    const first = (its: HomeFilesInput["items"]) =>
      honest([its[0]]).slice(0, 3);
    const rest = (its: HomeFilesInput["items"]) => honest([its[2]]);
    const header = (its: HomeFilesInput["items"], over: object) =>
      jframe({
        i: its[1].i,
        p: its[1].p,
        mode: 0o644,
        mtime: 1000,
        size: 3,
        offset: 2,
        ...over,
      });
    const cases: [string, Break][] = [
      [
        "an item out of order",
        (its) => [...first(its), ...rest(its), ...honest([its[1]])],
      ],
      [
        "another path",
        (its) => [
          ...first(its),
          header(its, { p: "a.txt" }),
          frame(Buffer.from("234")),
          jframe({ i: its[1].i, end: true }),
          ...rest(its),
        ],
      ],
      [
        "more bytes than the range asked",
        (its) => [
          ...first(its),
          header(its, { size: 8 }),
          frame(Buffer.from("23456789")),
          jframe({ i: its[1].i, end: true }),
          ...rest(its),
        ],
      ],
      [
        "more bytes than its header said",
        (its) => [
          ...first(its),
          header(its, {}),
          frame(Buffer.from("234")),
          frame(Buffer.from("EXTRA")),
          jframe({ i: its[1].i, end: true }),
          ...rest(its),
        ],
      ],
      [
        "another offset",
        (its) => [
          ...first(its),
          header(its, { offset: 0 }),
          frame(Buffer.from("012")),
          jframe({ i: its[1].i, end: true }),
          ...rest(its),
        ],
      ],
      [
        "a trailer for another item",
        (its) => [
          ...first(its),
          header(its, {}),
          frame(Buffer.from("234")),
          jframe({ i: its[2].i, end: true }),
          ...rest(its),
        ],
      ],
      [
        "an error for an item not asked",
        (its) => [...first(its), jframe({ i: 999, error: "no" }), ...rest(its)],
      ],
      [
        "a frame that is not JSON where a header goes",
        (its) => [...first(its), frame(Buffer.from("{nope")), ...rest(its)],
      ],
      [
        "the stream ends inside an item",
        (its) => [...first(its), header(its, {}), frame(Buffer.from("2"))],
      ],
    ];
    const got: string[] = [];
    for (const [name, script] of cases) {
      const r = await runBatch(items, script);
      got.push(
        `${name}: ${JSON.stringify(r.outcome)} later=${r.raw.includes(Buffer.from("LATER BYTES"))}`,
      );
    }
    const want = `${JSON.stringify({ "a.txt": "ok", "docs/b.txt": "error", "c.txt": "error" })} later=false`;
    expect(got).toEqual(cases.map(([name]) => `${name}: ${want}`));
  });

  it("with snapshots off, a header that says SQLite ends the batch: the live pass never takes a database's bytes", async () => {
    const r = await runBatch(
      [{ path: "a.txt" }, { path: "c.txt" }],
      (its) => [
        jframe({
          i: its[0].i,
          p: its[0].p,
          mode: 0o644,
          mtime: 1,
          size: 5,
          q: 1,
        }),
        frame(Buffer.from("alpha")),
        jframe({ i: its[0].i, end: true }),
        ...honest([its[1]]),
      ],
      { snapshots: false },
    );
    expect(r.outcome).toEqual({ "a.txt": "error", "c.txt": "error" });
  });
});

// ---- the source: her runner, bounded ----

interface FakeRunner {
  socketPath: string;
  ops: string[];
}

// A runner on a Unix socket. `info` answers the info call (null: accept and
// never answer); `entry` answers an entry call with the socket.
async function fakeRunner(opts: {
  info: RunnerInfo | null;
  entry?: (socket: Socket, request: { name: string; input: unknown }) => void;
}): Promise<FakeRunner> {
  const socketPath = join(dir || scratch(), `r-${servers.length}.sock`);
  const ops: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    const decode = createFrameDecoder();
    let seen = false;
    socket.on("data", (chunk: Buffer) => {
      for (const fr of decode(chunk)) {
        if (seen || fr.type !== FRAME_JSON) continue;
        seen = true;
        const req = JSON.parse(fr.payload.toString("utf8")) as {
          op: string;
          name?: string;
          input?: unknown;
        };
        ops.push(req.op === "entry" ? `entry:${req.name}` : req.op);
        if (req.op === "info") {
          if (opts.info === null) return;
          socket.write(encodeJson({ type: "info", ...opts.info }));
          socket.end();
        } else if (req.op === "entry" && opts.entry) {
          opts.entry(socket, { name: req.name!, input: req.input });
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, ops };
}

const ME = process.getuid!();
const me: MoveMember = { ...MIA, uid: ME };
const goodInfo = (over: Partial<RunnerInfo> = {}): RunnerInfo => ({
  uid: ME,
  gid: ME,
  user: me.osUser,
  home: me.home,
  env: {},
  bundleHash: HASH,
  ...over,
});
const exitFrame = () => encodeJson({ type: "exit", code: 0, signal: null });

async function drain(
  it: AsyncIterable<Uint8Array>,
): Promise<{ text: string; error: string | null }> {
  const parts: Buffer[] = [];
  try {
    for await (const c of it) parts.push(Buffer.from(c));
    return { text: Buffer.concat(parts).toString(), error: null };
  } catch (err) {
    return {
      text: Buffer.concat(parts).toString(),
      error: (err as Error).message,
    };
  }
}

const sourceFor = (
  runner: FakeRunner,
  bounds: { stallMs?: number; callMs?: number } = {},
) =>
  runnerMemberHomeSource({
    socketPath: () => runner.socketPath,
    readPeerUid: () => ME,
    ...bounds,
  })(me, 0);

const LIST_INPUT: HomeListInput = {
  home: me.home,
  nonce: "0123456789abcdef0123456789abcdef",
};

describe("C1, C2, D7: runnerMemberHomeSource", () => {
  it("checks her runner's info, then streams the entry's output", async () => {
    const runner = await fakeRunner({
      info: goodInfo(),
      entry: (socket) => {
        for (const fr of encodeData(FRAME_STDOUT, Buffer.from("LISTING")))
          socket.write(fr);
        socket.write(exitFrame());
        socket.end();
      },
    });
    const r = await drain(
      sourceFor(runner).list(LIST_INPUT, new AbortController().signal),
    );
    expect(r).toEqual({ text: "LISTING", error: null });
    expect(runner.ops).toEqual(["info", "entry:home-list"]);
  });

  it("D7, C2: an info answer with another uid, user, home or runtime fails the call before any entry runs", async () => {
    const got: string[] = [];
    for (const over of [
      { uid: ME + 1 },
      { user: "isomux-other" },
      { home: "/home/elsewhere" },
      { bundleHash: OTHER_HASH },
      { bundleHash: null },
    ] as Partial<RunnerInfo>[]) {
      const runner = await fakeRunner({
        info: goodInfo(over),
        entry: (socket) => {
          socket.write(encodeData(FRAME_STDOUT, Buffer.from("LISTING"))[0]);
          socket.write(exitFrame());
          socket.end();
        },
      });
      const r = await drain(
        sourceFor(runner).files(
          { ...LIST_INPUT, snapshot: true, items: [] },
          new AbortController().signal,
        ),
      );
      got.push(
        `${JSON.stringify(over)}: ${r.error !== null} ${r.text === ""} ${runner.ops.join(",")}`,
      );
    }
    expect(got).toEqual(
      [
        { uid: ME + 1 },
        { user: "isomux-other" },
        { home: "/home/elsewhere" },
        { bundleHash: OTHER_HASH },
        { bundleHash: null },
      ].map((o) => `${JSON.stringify(o)}: true true info`),
    );
  });

  it("C1: a listener that accepts and never answers the info call fails the call within its bound", async () => {
    const runner = await fakeRunner({ info: null });
    const started = performance.now();
    const r = await Promise.race([
      drain(
        sourceFor(runner, { stallMs: 200, callMs: 1000 }).list(
          LIST_INPUT,
          new AbortController().signal,
        ),
      ),
      Bun.sleep(3000).then(() => ({ text: "", error: "still waiting" })),
    ]);
    expect(r.error).not.toBeNull();
    expect(r.error).not.toBe("still waiting");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("C1: an entry that goes quiet, and one that sends a byte per stall window, both end within their bounds", async () => {
    const quiet = await fakeRunner({
      info: goodInfo(),
      entry: (socket) => {
        socket.write(encodeData(FRAME_STDOUT, Buffer.from("one"))[0]);
      },
    });
    const timers: ReturnType<typeof setInterval>[] = [];
    const trickle = await fakeRunner({
      info: goodInfo(),
      entry: (socket) => {
        const t = setInterval(() => {
          if (socket.destroyed) return clearInterval(t);
          socket.write(encodeData(FRAME_STDOUT, Buffer.from("x"))[0]);
        }, 50);
        timers.push(t);
        socket.on("close", () => clearInterval(t));
      },
    });
    try {
      for (const runner of [quiet, trickle]) {
        const started = performance.now();
        const r = await Promise.race([
          drain(
            sourceFor(runner, { stallMs: 200, callMs: 1000 }).list(
              LIST_INPUT,
              new AbortController().signal,
            ),
          ),
          Bun.sleep(3000).then(() => ({ text: "", error: "still waiting" })),
        ]);
        expect([
          runner.ops.join(","),
          r.error !== null && r.error !== "still waiting",
        ]).toEqual(["info,entry:home-list", true]);
        expect(performance.now() - started).toBeLessThan(3000);
      }
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });

  it("ends the entry when the signal aborts", async () => {
    const runner = await fakeRunner({
      info: goodInfo(),
      entry: (socket) => {
        socket.write(encodeData(FRAME_STDOUT, Buffer.from("one"))[0]);
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = performance.now();
    const r = await Promise.race([
      drain(
        sourceFor(runner, { stallMs: 10_000, callMs: 60_000 }).list(
          LIST_INPUT,
          ac.signal,
        ),
      ),
      Bun.sleep(3000).then(() => ({ text: "", error: "still waiting" })),
    ]);
    expect(r.error).not.toBeNull();
    expect(r.error).not.toBe("still waiting");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// ---- her units (Q5) ----

describe("Q5: the members' units record", () => {
  const unit = (name: string, over: Partial<AgentUnit> = {}): AgentUnit => ({
    name,
    fragmentPath: `/home/isomux-mia/.config/systemd/user/${name}`,
    unitFileState: "enabled",
    activeState: "active",
    transient: false,
    ...over,
  });

  it("is written 0600 and read back as written", () => {
    const root = scratch();
    const records = [
      { userId: "u-mia", osUser: "isomux-mia", units: [unit("bot.service")] },
      { userId: "u-sam", osUser: "isomux-sam", units: [] },
    ];
    writeMemberUnitsRecord(root, records);
    expect(statSync(join(root, MOVE_MEMBER_UNITS_FILE)).mode & 0o777).toBe(
      0o600,
    );
    expect(readMemberUnitsRecord(root)).toEqual(records);
    expect(readMemberUnitsRecord(join(root, "none"))).toEqual([]);
  });

  it("restores her units through her runner and drops only her entry; a member with no entry gets null and no call", () => {
    const root = scratch();
    writeMemberUnitsRecord(root, [
      {
        userId: "u-mia",
        osUser: "isomux-mia",
        units: [
          unit("bot.service"),
          unit("job.service", { unitFileState: "disabled" }),
        ],
      },
      { userId: "u-sam", osUser: "isomux-sam", units: [unit("sam.service")] },
    ]);
    const calls: string[] = [];
    const run = (argv: string[]) => {
      calls.push(argv.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = restoreMemberUnits(root, "u-mia", run);
    expect(result?.failed).toEqual([]);
    expect([...(result?.restored ?? [])].sort()).toEqual([
      "bot.service",
      "job.service",
    ]);
    expect(calls.some((c) => / enable .*bot\.service/.test(c))).toBe(true);
    expect(calls.some((c) => / start .*bot\.service/.test(c))).toBe(true);
    expect(calls.some((c) => / enable .*job\.service/.test(c))).toBe(false);
    expect(calls.some((c) => / start .*job\.service/.test(c))).toBe(true);
    expect(calls.some((c) => c.includes("sam.service"))).toBe(false);
    expect(readMemberUnitsRecord(root).map((r) => r.userId)).toEqual(["u-sam"]);

    const before = calls.length;
    expect(restoreMemberUnits(root, "u-mia", run)).toBeNull();
    expect(restoreMemberUnits(root, "u-nobody", run)).toBeNull();
    expect(calls.length).toBe(before);
    expect(existsSync(join(root, MOVE_MEMBER_UNITS_FILE))).toBe(true);
  });
});
