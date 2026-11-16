// The new office's side of an office move for the members with their own
// OS user (task 78733adf, slice 5c-2): the whole move-in against the REAL
// old office in this process (test-support/office-move-in-harness.ts).
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberHomeSource, MoveMember } from "./office-move-members.ts";
import { listHome, sendHomeFiles } from "./member-home-send.ts";
import { walkMoveManifest } from "./office-move-pull.ts";
import { type MoveInDeps, type MoveInStatus } from "./office-move-in.ts";
import { MOVE_IN_DIR, MOVE_IN_STAGE } from "./office-move-stage.ts";
import {
  OWNER,
  FILE_MTIME,
  moveInBed,
  cleanupMoveInHarness,
  waitFor,
  TERMINAL,
  waitPhase,
  type OldOffice,
  oldOffice,
  type NewOffice,
  newOffice,
  stageOf,
  paths,
  errCode,
  toConfirm,
  toEnd,
  writeUsers,
  readSwap,
  finishAs,
  liveReady,
} from "./test-support/office-move-in-harness.ts";

setDefaultTimeout(30_000);

afterEach(cleanupMoveInHarness);

// Slice 5c-2 (task 78733adf, E1-E3): the old office's members with their
// own OS user. Their runners are the member's code (member-home-send.ts) in
// this process, each on a real home. Each home lands in its own stage,
// keyed by her id, and waits there for the enable command after the swap.
describe("slice 5c-2: the homes of members with their own OS user", () => {
  const memberOf = (name: string, uid: number, home: string): MoveMember => ({
    userId: `u-${name.toLowerCase()}`,
    name,
    osUser: `isomux-${name.toLowerCase()}`,
    uid,
    home,
    bundleHash: "a".repeat(64),
  });

  // Each member's runner reads her home at MoveMember.home.
  const realSource: MemberHomeSource = () => ({
    async *list(input) {
      const out: Uint8Array[] = [];
      await listHome(input, async (c) => void out.push(c));
      yield* out;
    },
    async *files(input) {
      const out: Uint8Array[] = [];
      await sendHomeFiles(input, async (c) => void out.push(c));
      yield* out;
    },
  });

  interface Bed {
    o: OldOffice;
    n: NewOffice;
    list: { value: MoveMember[] };
    mia: MoveMember;
    sam: MoveMember;
    /** The userIds this box blocks (name_taken). */
    blocked: Set<string>;
    /** The members each membersHere call got. */
    checked: string[][];
  }

  function memberBed(
    over: Parameters<typeof newOffice>[1] = {},
    opts: { live?: boolean; both?: boolean } = {},
  ): Bed {
    moveInBed.dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const homes = join(moveInBed.dir, "member-homes");
    const mia = memberOf("Mia", 60001, join(homes, "isomux-mia"));
    const sam = memberOf("Sam", 60002, join(homes, "isomux-sam"));
    for (const m of [mia, sam]) {
      mkdirSync(join(m.home, "proj"), { recursive: true, mode: 0o700 });
      writeFileSync(join(m.home, "proj", "own.txt"), `own of ${m.name}`);
      writeFileSync(join(m.home, ".bashrc"), `bashrc of ${m.name}`);
      // The same path, size and mtime in both homes, other bytes: a pass
      // that compares one member's files with another's ledger keeps the
      // wrong copy.
      writeFileSync(
        join(m.home, "same.txt"),
        m.name === "Mia" ? "MMMM" : "SSSS",
      );
      utimesSync(join(m.home, "same.txt"), FILE_MTIME, FILE_MTIME);
    }
    const list = { value: opts.both ? [mia, sam] : [mia] };
    const o = oldOffice("old", {
      memberList: list,
      memberSource: realSource,
      live: opts.live,
    });
    writeUsers(o.root, [{ id: "u-old", name: "Riley", role: "owner" }]);
    const blocked = new Set<string>();
    const checked: string[][] = [];
    const n = newOffice(o, {
      membersHere: (members) => {
        checked.push(members.map((m) => m.userId));
        return members.map((m) => ({
          userId: m.userId,
          name: m.name,
          osUser: m.osUser,
          oldHome: m.home,
          home: m.home,
          block: blocked.has(m.userId) ? ("name_taken" as const) : null,
        }));
      },
      enableCommand: (userId) => `isomux-member-user enable ${userId}`,
      ...over,
    });
    writeUsers(n.root, [{ id: OWNER.id, name: OWNER.name, role: "owner" }]);
    return { o, n, list, mia, sam, blocked, checked };
  }

  const memberStage = (n: NewOffice, userId: string) =>
    join(n.home, MOVE_IN_DIR, "members", userId, MOVE_IN_STAGE);
  const membersDir = (n: NewOffice) => join(n.home, MOVE_IN_DIR, "members");
  const read = (p: string) => readFileSync(p, "utf8");
  const failure = (s: MoveInStatus) => ({
    phase: s.phase,
    code: (s as { error?: { code: string } }).error?.code ?? null,
    retryable: (s as { retryable?: boolean }).retryable ?? null,
  });
  const here = (n: NewOffice) =>
    (
      n.moveIn.status() as {
        membersHere?: {
          userId: string;
          block: string | null;
          oldHome: string;
        }[];
      }
    ).membersHere ?? [];

  /** A fetch that runs `fn` once, after the old office answered the lock. */
  function atLock(b: () => Bed, fn: () => void): MoveInDeps["fetch"] {
    let done = false;
    return async (url, init) => {
      const res = await b().o.fetch(url, init);
      if (!done && new URL(url).pathname === "/api/move/lock") {
        done = true;
        fn();
      }
      return res;
    };
  }

  it("confirm shows each member as checked here; the pull stages her home under her id; finish hands the swap her old home and the report her enable command", async () => {
    const b = memberBed({}, { both: true });
    const preflightId = await toConfirm(b.o, b.n);
    expect(here(b.n).map((m) => [m.userId, m.block, m.oldHome])).toEqual([
      ["u-mia", null, b.mia.home],
      ["u-sam", null, b.sam.home],
    ]);
    expect((await b.n.moveIn.lock({ preflightId, by: OWNER })).ok).toBe(true);
    const end = await waitPhase(b.n.moveIn, [...TERMINAL], 15_000);
    expect(end.phase).toBe("staged");
    for (const m of [b.mia, b.sam]) {
      const st = memberStage(b.n, m.userId);
      expect(read(join(st, "proj", "own.txt"))).toBe(`own of ${m.name}`);
      expect(read(join(st, ".bashrc"))).toBe(`bashrc of ${m.name}`);
      expect(read(join(st, "same.txt"))).toBe(
        m.name === "Mia" ? "MMMM" : "SSSS",
      );
      expect(statSync(join(membersDir(b.n), m.userId)).mode & 0o777).toBe(
        0o700,
      );
    }
    // Nothing of a member's home is in the office's own stage.
    expect(existsSync(join(stageOf(b.n), "same.txt"))).toBe(false);
    const a = await finishAs(b.n);
    expect(a.ok).toBe(true);
    const sw = readSwap(b.n);
    expect(sw.inputs.members).toEqual([
      { userId: "u-mia", home: b.mia.home },
      { userId: "u-sam", home: b.sam.home },
    ]);
    expect((sw.inputs.report as { members?: unknown }).members).toEqual([
      {
        userId: "u-mia",
        name: "Mia",
        osUser: "isomux-mia",
        command: "isomux-member-user enable u-mia",
      },
      {
        userId: "u-sam",
        name: "Sam",
        osUser: "isomux-sam",
        command: "isomux-member-user enable u-sam",
      },
    ]);
  });

  it("the lock refuses a member whose home cannot land here (409 member_homes_blocked with the list) and sends no lock; once it can, the lock goes", async () => {
    const b = memberBed();
    b.blocked.add("u-mia");
    const preflightId = await toConfirm(b.o, b.n);
    expect(here(b.n).map((m) => [m.userId, m.block])).toEqual([
      ["u-mia", "name_taken"],
    ]);
    const refused = await b.n.moveIn.lock({ preflightId, by: OWNER });
    expect([
      refused.ok,
      refused.ok ? 0 : refused.status,
      errCode(refused),
    ]).toEqual([false, 409, "member_homes_blocked"]);
    expect(paths(b.o, "/api/move/lock")).toBe(0);
    expect(b.o.state()).toBe("paired");
    expect(b.n.moveIn.status().phase).toBe("confirm");
    b.blocked.clear();
    expect((await b.n.moveIn.lock({ preflightId, by: OWNER })).ok).toBe(true);
    expect((await waitPhase(b.n.moveIn, [...TERMINAL], 15_000)).phase).toBe(
      "staged",
    );
  });

  it("a pass checks again: a member blocked after the lock fails it (retryable, with the list) and stages nothing of hers; unblocked, the pull again stages her", async () => {
    let bed: Bed | null = null;
    const b = memberBed({
      fetch: atLock(
        () => bed!,
        () => bed!.blocked.add("u-mia"),
      ),
    });
    bed = b;
    const end = await toEnd(b.o, b.n);
    expect(failure(end)).toEqual({
      phase: "failed",
      code: "member_homes_blocked",
      retryable: true,
    });
    expect(here(b.n).map((m) => [m.userId, m.block])).toEqual([
      ["u-mia", "name_taken"],
    ]);
    expect(existsSync(join(memberStage(b.n, "u-mia"), ".bashrc"))).toBe(false);
    b.blocked.clear();
    expect((await b.n.moveIn.retryPull({ by: OWNER })).ok).toBe(true);
    expect((await waitPhase(b.n.moveIn, [...TERMINAL], 15_000)).phase).toBe(
      "staged",
    );
    expect(read(join(memberStage(b.n, "u-mia"), ".bashrc"))).toBe(
      "bashrc of Mia",
    );
  });

  it("C4: a manifest whose members differ from the ones checked fails the pass (members_changed, retryable) and stages none of them", async () => {
    let bed: Bed | null = null;
    const b = memberBed({
      fetch: atLock(
        () => bed!,
        () => (bed!.list.value = [bed!.mia, bed!.sam]),
      ),
    });
    bed = b;
    const end = await toEnd(b.o, b.n);
    expect(failure(end)).toEqual({
      phase: "failed",
      code: "members_changed",
      retryable: true,
    });
    for (const id of ["u-mia", "u-sam"])
      expect(existsSync(join(memberStage(b.n, id), ".bashrc"))).toBe(false);
  });

  it("N3: the final pass with the members in another order compares each member's files with her own copy only", async () => {
    const b = memberBed({}, { live: true, both: true });
    await toConfirm(b.o, b.n);
    await liveReady(b.n);
    expect(read(join(memberStage(b.n, "u-mia"), "same.txt"))).toBe("MMMM");
    // The records list them the other way round; Mia changed a file.
    b.list.value = [b.sam, b.mia];
    writeFileSync(join(b.mia.home, ".bashrc"), "bashrc of Mia, later");
    const before = (b.n.moveIn.status() as { preflightId: string }).preflightId;
    expect((await b.n.moveIn.rerunPreflight({ by: OWNER })).ok).toBe(true);
    await waitFor(() => {
      const s = b.n.moveIn.status() as { phase: string; preflightId?: string };
      return (
        s.phase === "confirm" && !!s.preflightId && s.preflightId !== before
      );
    });
    const s = b.n.moveIn.status() as { preflightId: string };
    expect(
      (await b.n.moveIn.lock({ preflightId: s.preflightId, by: OWNER })).ok,
    ).toBe(true);
    expect((await waitPhase(b.n.moveIn, [...TERMINAL], 15_000)).phase).toBe(
      "staged",
    );
    expect(read(join(memberStage(b.n, "u-mia"), "same.txt"))).toBe("MMMM");
    expect(read(join(memberStage(b.n, "u-sam"), "same.txt"))).toBe("SSSS");
    expect(read(join(memberStage(b.n, "u-mia"), ".bashrc"))).toBe(
      "bashrc of Mia, later",
    );
    expect(read(join(memberStage(b.n, "u-sam"), ".bashrc"))).toBe(
      "bashrc of Sam",
    );
  });

  it("C5: a member the live pass staged that the final list drops loses her stage folder", async () => {
    const b = memberBed({}, { live: true, both: true });
    await toConfirm(b.o, b.n);
    await liveReady(b.n);
    expect(existsSync(join(memberStage(b.n, "u-sam"), ".bashrc"))).toBe(true);
    b.list.value = [b.mia];
    const before = (b.n.moveIn.status() as { preflightId: string }).preflightId;
    expect((await b.n.moveIn.rerunPreflight({ by: OWNER })).ok).toBe(true);
    await waitFor(() => {
      const s = b.n.moveIn.status() as { phase: string; preflightId?: string };
      return (
        s.phase === "confirm" && !!s.preflightId && s.preflightId !== before
      );
    });
    const s = b.n.moveIn.status() as { preflightId: string };
    expect(
      (await b.n.moveIn.lock({ preflightId: s.preflightId, by: OWNER })).ok,
    ).toBe(true);
    expect((await waitPhase(b.n.moveIn, [...TERMINAL], 15_000)).phase).toBe(
      "staged",
    );
    expect(readdirSync(membersDir(b.n))).toEqual(["u-mia"]);
  });

  it("a path of her home that her runner cannot read is missing with her old home's path", async () => {
    const b = memberBed();
    mkdirSync(join(b.mia.home, "locked"));
    writeFileSync(join(b.mia.home, "locked", "x"), "x");
    chmodSync(join(b.mia.home, "locked"), 0o000);
    moveInBed.cleanups.push(() => chmodSync(join(b.mia.home, "locked"), 0o700));
    const s = await toEnd(b.o, b.n);
    expect(s.phase).toBe("incomplete");
    const result = (s as { result?: { missing: { path: string }[] } }).result;
    expect(
      (result?.missing ?? []).some((m) =>
        m.path.includes(join(b.mia.home, "locked")),
      ),
    ).toBe(true);
  });

  it("on one device, her home's bytes count with the office's: room for the office alone fails no_space before any batch", async () => {
    const big = 4 * 1024 * 1024;
    let bavail = 1e9;
    const b = memberBed({
      deviceOf: () => 1,
      statfsOf: () => ({ bavail, bsize: 4096, ffree: 1e9 }),
    });
    writeFileSync(join(b.mia.home, "big.bin"), Buffer.alloc(big, 7));
    const tmp = join(moveInBed.dir, "summary.ndjson");
    const home = await walkMoveManifest(b.o.scope, tmp);
    rmSync(tmp);
    // Room for the office's home with its margin and a block per entry, and
    // 50 blocks more: her 1024 blocks do not fit.
    bavail =
      Math.ceil(
        (home.totalBytes + Math.max(home.totalBytes * 0.1, 2 ** 30)) / 4096,
      ) +
      home.entries +
      50;
    const end = await toEnd(b.o, b.n);
    expect(failure(end)).toMatchObject({ phase: "failed", code: "no_space" });
    expect(paths(b.o, "/api/move/batch")).toBe(0);
    // The condition: the same room without her big file stages.
    rmSync(join(b.mia.home, "big.bin"));
    expect((await b.n.moveIn.retryPull({ by: OWNER })).ok).toBe(true);
    expect((await waitPhase(b.n.moveIn, [...TERMINAL], 15_000)).phase).toBe(
      "staged",
    );
  });
});
