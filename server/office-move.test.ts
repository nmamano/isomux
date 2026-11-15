// The old office's side of a move (task 78733adf, slice 1): the move code,
// the state file and its transitions, over a temp state root.
//
// The routes that drive these (server/office-move-routes.test.ts, the owner
// routes in server/test-support/office-move-routes.test.ts) own the HTTP
// answers; this file owns what each transition leaves on disk, because that is
// what the boot gate, the MOVE-locked server and a lockdown read later.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_MARKER_FILE,
  lockMarkerBody,
  ROOT_MARKER_FILE,
} from "./lockdown.ts";
import {
  cancelMove,
  cancelMoveByCode,
  checkMoveSession,
  killMoveForLockdown,
  markMoveDone,
  markMoveLocked,
  markMoveServed,
  mintMoveCode,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
  MOVE_CODE_TTL_MS,
  MOVE_SESSION_TTL_MS,
  MOVE_STATE_FILE,
  moveBootMode,
  moveOriginFrom,
  moveReleaseRefusal,
  MoveStateError,
  parseMoveCode,
  readMoveCancelled,
  readMoveState,
  redeemMoveCode,
  type MoveBoxInfo,
} from "./office-move.ts";
import { MOVE_UNITS_FILE } from "./office-move-units.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function stateRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "office-move-"));
  const root = join(dir, ".isomux");
  mkdirSync(root);
  return root;
}

// A root marker folder with no marker in it, so no test reads /etc/isomux.
function noRootMarkers(): string {
  const d = join(dir, "etc-isomux");
  mkdirSync(d, { recursive: true });
  return d;
}

const T0 = new Date("2026-11-15T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const BOX: MoveBoxInfo = {
  release: "v2026.11.12",
  commit: "a".repeat(40),
  homePath: "/home/isomux",
};
const stateFile = (root: string) => join(root, MOVE_STATE_FILE);
const rawState = (root: string) => readFileSync(stateFile(root), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function mint(root: string, now = T0) {
  return mintMoveCode(root, {
    origin: "https://old.example.com",
    by: "Morgan",
    now,
  });
}

function tokenOf(code: string): string {
  const parts = parseMoveCode(code);
  if (!parts) throw new Error("the minted code does not parse");
  return parts.token;
}

// "code" -> "paired" through the redeem, as the new box does it.
function pair(root: string, now = T0) {
  const minted = mint(root, now);
  const res = redeemMoveCode(root, {
    token: tokenOf(minted.code),
    newBox: BOX,
    ours: BOX,
    now,
  });
  if (!res.ok) throw new Error(`redeem refused: ${JSON.stringify(res)}`);
  return { code: minted.code, session: res.session };
}

function lockMove(root: string, now = T0) {
  const paired = pair(root, now);
  markMoveLocked(root, { preflightId: "pf-1", now });
  return paired;
}

describe("the move code", () => {
  it("carries the origin and two 256-bit secrets, and the state file keeps only the token's hash, at mode 0600", () => {
    const root = stateRoot();
    const minted = mint(root);
    const parts = parseMoveCode(minted.code);
    expect(parts?.origin).toBe("https://old.example.com");
    expect(minted.origin).toBe("https://old.example.com");
    expect(minted.expiresAt).toBe(T0.getTime() + MOVE_CODE_TTL_MS);
    for (const secret of [parts!.token, parts!.key])
      expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(parts!.token).not.toBe(parts!.key);

    // A copy of the state file (a backup, a log of it) does not redeem.
    const raw = rawState(root);
    expect(raw).not.toContain(parts!.token);
    expect(JSON.parse(raw)).toMatchObject({
      state: "code",
      tokenHash: sha256(parts!.token),
    });
    expect(statSync(stateFile(root)).mode & 0o777).toBe(0o600);
  });

  it("flags an origin another box cannot reach, and only that", () => {
    const root = stateRoot();
    const flag = (origin: string) =>
      mintMoveCode(root, { origin, by: "Morgan", now: T0 }).loopbackOrigin;
    expect({
      v4: flag("http://127.0.0.1:4000"),
      name: flag("http://localhost:4000"),
      v6: flag("http://[::1]:4000"),
      public: flag("https://old.example.com"),
      tailnet: flag("http://100.101.102.103:4000"),
    }).toEqual({
      v4: true,
      name: true,
      v6: true,
      public: false,
      tailnet: false,
    });
  });

  it("parses nothing that is not a move code", () => {
    const root = stateRoot();
    const { code } = mint(root);
    const body = code.slice(code.indexOf(".") + 1);
    expect({
      empty: parseMoveCode(""),
      noPrefix: parseMoveCode(body),
      otherVersion: parseMoveCode(`isomux-move-2.${body}`),
      garbage: parseMoveCode("isomux-move-1.not-base64-json"),
      noKey: parseMoveCode(
        `isomux-move-1.${Buffer.from(JSON.stringify({ o: "https://x", t: "a" })).toString("base64url")}`,
      ),
    }).toEqual({
      empty: null,
      noPrefix: null,
      otherVersion: null,
      garbage: null,
      noKey: null,
    });
  });

  it("a new mint replaces an unredeemed code: the old token no longer redeems", () => {
    const root = stateRoot();
    const first = mint(root);
    const second = mint(root, at(1_000));
    expect(tokenOf(second.code)).not.toBe(tokenOf(first.code));
    const old = redeemMoveCode(root, {
      token: tokenOf(first.code),
      newBox: BOX,
      ours: BOX,
      now: at(2_000),
    });
    expect(old).toEqual({ ok: false, status: 403, error: "move_code_invalid" });
    const fresh = redeemMoveCode(root, {
      token: tokenOf(second.code),
      newBox: BOX,
      ours: BOX,
      now: at(2_000),
    });
    expect(fresh.ok).toBe(true);
  });

  it("no mint once paired or locked: the pairing stays as it was", () => {
    const root = stateRoot();
    pair(root);
    const before = rawState(root);
    const err = (() => {
      try {
        mint(root, at(1_000));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MoveStateError);
    expect((err as MoveStateError).code).toBe("move_paired");
    expect(rawState(root)).toBe(before);

    markMoveLocked(root, { preflightId: "pf-1", now: at(2_000) });
    expect(() => mint(root, at(3_000))).toThrow(MoveStateError);
    expect(readMoveState(root, at(3_000)).current?.state).toBe("move");
  });
});

describe("the redeem", () => {
  it("checks the token before anything else: a wrong token gets the one 403 even when the boxes differ, and learns nothing about this box", () => {
    const root = stateRoot();
    mint(root);
    const res = redeemMoveCode(root, {
      token: Buffer.alloc(32, 7).toString("base64url"),
      newBox: { ...BOX, homePath: "/home/other", release: "v2026.1.1" },
      ours: BOX,
      now: at(1_000),
    });
    expect(res).toEqual({ ok: false, status: 403, error: "move_code_invalid" });
    expect(readMoveState(root, at(1_000)).current?.state).toBe("code");
  });

  it("a different home path is refused with both values, and the code still redeems once the new box is fixed", () => {
    const root = stateRoot();
    const { code } = mint(root);
    const theirs = { ...BOX, homePath: "/home/office" };
    const refused = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox: theirs,
      ours: BOX,
      now: at(1_000),
    });
    expect(refused).toEqual({
      ok: false,
      status: 409,
      error: "home_path_differs",
      ours: BOX,
      theirs,
    });
    expect(readMoveState(root, at(1_000)).current?.state).toBe("code");

    const paired = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox: BOX,
      ours: BOX,
      now: at(2_000),
    });
    expect(paired.ok).toBe(true);
  });

  it("an older release on the new box is refused with both values and does not use up the code", () => {
    const root = stateRoot();
    const { code } = mint(root);
    const theirs = { ...BOX, release: "v2026.11.9", commit: "b".repeat(40) };
    const refused = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox: theirs,
      ours: BOX,
      now: at(1_000),
    });
    expect(refused).toEqual({
      ok: false,
      status: 409,
      error: "release_older",
      ours: BOX,
      theirs,
    });
    expect(readMoveState(root, at(1_000)).current?.state).toBe("code");
  });

  it("pairs once: the answer carries a 256-bit session and this box, the file keeps only the session's hash, and the token never redeems again", () => {
    const root = stateRoot();
    const { code } = mint(root);
    const newBox = { ...BOX, release: "v2026.11.14", commit: "c".repeat(40) };
    const res = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox,
      ours: BOX,
      now: at(1_000),
    });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(Buffer.from(res.session, "base64url")).toHaveLength(32);
    expect(res.office).toEqual(BOX);
    expect(res.sessionExpiresAt).toBe(
      at(1_000).getTime() + MOVE_SESSION_TTL_MS,
    );

    const raw = rawState(root);
    expect(raw).not.toContain(res.session);
    expect(JSON.parse(raw)).toMatchObject({
      state: "paired",
      sessionHash: sha256(res.session),
      pairedAt: at(1_000).getTime(),
      newBox,
    });

    const again = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox,
      ours: BOX,
      now: at(2_000),
    });
    expect(again).toEqual({
      ok: false,
      status: 403,
      error: "move_code_invalid",
    });
    expect(
      checkMoveSession(root, `Bearer ${res.session}`, at(2_000))?.state,
    ).toBe("paired");
  });

  it("an expired code gets the same 403 as a wrong one", () => {
    const root = stateRoot();
    const { code } = mint(root);
    const res = redeemMoveCode(root, {
      token: tokenOf(code),
      newBox: BOX,
      ours: BOX,
      now: at(MOVE_CODE_TTL_MS + 1),
    });
    expect(res).toEqual({ ok: false, status: 403, error: "move_code_invalid" });
  });
});

describe("the release rule", () => {
  const box = (release: string | null, commit: string | null): MoveBoxInfo => ({
    release,
    commit,
    homePath: "/home/isomux",
  });
  it("compares CalVer releases as numbers, and asks for the same commit when either side is not a release", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect({
      same: moveReleaseRefusal(box("v2026.11.12", a), box("v2026.11.12", a)),
      newer: moveReleaseRefusal(box("v2026.11.12", a), box("v2026.11.14", b)),
      // 9 < 12 as numbers, not as text.
      newerByNumber: moveReleaseRefusal(
        box("v2026.11.9", a),
        box("v2026.11.12", b),
      ),
      olderByNumber: moveReleaseRefusal(
        box("v2026.11.12", a),
        box("v2026.11.9", b),
      ),
      olderPatch: moveReleaseRefusal(
        box("v2026.11.12.2", a),
        box("v2026.11.12", b),
      ),
      newerPatch: moveReleaseRefusal(
        box("v2026.11.12", a),
        box("v2026.11.12.2", b),
      ),
      devSameCommit: moveReleaseRefusal(box(null, a), box(null, a)),
      devOtherCommit: moveReleaseRefusal(box(null, a), box(null, b)),
      devToRelease: moveReleaseRefusal(box(null, a), box("v2026.11.14", b)),
      releaseToDevSameCommit: moveReleaseRefusal(
        box("v2026.11.12", a),
        box(null, a),
      ),
      noCommits: moveReleaseRefusal(box(null, null), box(null, null)),
    }).toEqual({
      same: null,
      newer: null,
      newerByNumber: null,
      olderByNumber: "release_older",
      olderPatch: "release_older",
      newerPatch: null,
      devSameCommit: null,
      devOtherCommit: "release_unknown",
      devToRelease: "release_unknown",
      releaseToDevSameCommit: null,
      noCommits: "release_unknown",
    });
  });
});

describe("expiry (the auto-unlock happens only before the lock)", () => {
  it("drops an unredeemed code after an hour and says what it dropped", () => {
    const root = stateRoot();
    mint(root);
    expect(readMoveState(root, at(MOVE_CODE_TTL_MS - 1)).current?.state).toBe(
      "code",
    );
    const read = readMoveState(root, at(MOVE_CODE_TTL_MS + 1));
    expect(read.current).toBeNull();
    expect(read.dropped?.state).toBe("code");
    expect(existsSync(stateFile(root))).toBe(false);
    // Dropped once: the next read has nothing to report.
    expect(readMoveState(root, at(MOVE_CODE_TTL_MS + 2)).dropped).toBeNull();
  });

  it("drops a pairing 24 h after the redeem, not after the code's hour, and its session stops working", () => {
    const root = stateRoot();
    const { session } = pair(root);
    const later = at(MOVE_CODE_TTL_MS + 60_000);
    expect(readMoveState(root, later).current?.state).toBe("paired");
    expect(checkMoveSession(root, `Bearer ${session}`, later)?.state).toBe(
      "paired",
    );

    const expired = at(MOVE_SESSION_TTL_MS + 1);
    expect(checkMoveSession(root, `Bearer ${session}`, expired)).toBeNull();
    const read = readMoveState(root, expired);
    expect(read.current).toBeNull();
    expect(read.dropped?.state).toBe("paired");
    expect(existsSync(stateFile(root))).toBe(false);
  });

  it("never drops a locked move: a week later the state and the session are still there", () => {
    const root = stateRoot();
    const { session } = lockMove(root);
    const week = at(7 * 24 * 60 * 60_000);
    const read = readMoveState(root, week);
    expect(read.current?.state).toBe("move");
    expect(read.dropped).toBeNull();
    expect(checkMoveSession(root, `Bearer ${session}`, week)?.state).toBe(
      "move",
    );
  });
});

describe("the move session", () => {
  it("opens only with the exact bearer", () => {
    const root = stateRoot();
    const { session, code } = pair(root);
    const now = at(1_000);
    expect({
      right: checkMoveSession(root, `Bearer ${session}`, now)?.state ?? null,
      none: checkMoveSession(root, null, now),
      bare: checkMoveSession(root, session, now),
      wrong: checkMoveSession(
        root,
        `Bearer ${Buffer.alloc(32, 1).toString("base64url")}`,
        now,
      ),
      // The code is not the session.
      token: checkMoveSession(root, `Bearer ${tokenOf(code)}`, now),
    }).toEqual({
      right: "paired",
      none: null,
      bare: null,
      wrong: null,
      token: null,
    });
  });
});

describe("the lock and the cancels", () => {
  it("the lock turns a pairing into a move and keeps the session; it refuses a state that is not paired", () => {
    const root = stateRoot();
    mint(root);
    expect(() =>
      markMoveLocked(root, { preflightId: "pf-1", now: at(1_000) }),
    ).toThrow(MoveStateError);
    expect(readMoveState(root, at(1_000)).current?.state).toBe("code");

    rmSync(stateFile(root));
    const { session } = pair(root, at(2_000));
    const moved = markMoveLocked(root, { preflightId: "pf-9", now: at(3_000) });
    expect(moved).toMatchObject({
      state: "move",
      preflightId: "pf-9",
      lockedAt: at(3_000).getTime(),
      sessionHash: sha256(session),
    });
    expect(JSON.parse(rawState(root))).toMatchObject({
      state: "move",
      preflightId: "pf-9",
    });
  });

  it("the owner's cancel ends a code or a pairing, and cannot end a locked move", () => {
    const root = stateRoot();
    expect(cancelMove(root, T0)).toBeNull();

    mint(root);
    expect(cancelMove(root, at(1_000))?.state).toBe("code");
    expect(existsSync(stateFile(root))).toBe(false);

    const { session } = pair(root, at(2_000));
    expect(cancelMove(root, at(3_000))?.state).toBe("paired");
    expect(checkMoveSession(root, `Bearer ${session}`, at(3_000))).toBeNull();

    lockMove(root, at(4_000));
    let err: unknown = null;
    try {
      cancelMove(root, at(5_000));
    } catch (e) {
      err = e;
    }
    expect((err as MoveStateError | null)?.code).toBe("move_locked");
    expect(readMoveState(root, at(5_000)).current?.state).toBe("move");
  });

  it("the cancel by code ends a locked move only with the right code, and leaves the cancel record", () => {
    const root = stateRoot();
    const { code } = lockMove(root);
    const other = (() => {
      const r2 = join(dir, "other");
      mkdirSync(r2);
      return mintMoveCode(r2, {
        origin: "https://old.example.com",
        by: "M",
        now: T0,
      }).code;
    })();

    expect(cancelMoveByCode(root, other, at(1_000))).toBe(false);
    expect(cancelMoveByCode(root, "isomux-move-1.nonsense", at(1_000))).toBe(
      false,
    );
    expect(readMoveState(root, at(1_000)).current?.state).toBe("move");
    expect(readMoveCancelled(root)).toBeNull();

    expect(cancelMoveByCode(root, code, at(2_000))).toBe(true);
    expect(existsSync(stateFile(root))).toBe(false);
    expect(readMoveCancelled(root)).toEqual({ at: at(2_000).toISOString() });
  });

  it("the cancel by code does nothing before the lock: the owner's cancel is the way there", () => {
    const root = stateRoot();
    const { code } = pair(root);
    expect(cancelMoveByCode(root, code, at(1_000))).toBe(false);
    expect(readMoveState(root, at(1_000)).current?.state).toBe("paired");
    expect(readMoveCancelled(root)).toBeNull();
  });

  it("the cancel record is written before the state file goes: when it cannot be written, the move stays", () => {
    const root = stateRoot();
    const { code } = lockMove(root);
    // A directory where the record goes: the write fails.
    mkdirSync(join(root, MOVE_CANCELLED_FILE));
    let threw = false;
    let result: boolean | null = null;
    try {
      result = cancelMoveByCode(root, code, at(1_000));
    } catch {
      threw = true;
    }
    expect(threw || result === false).toBe(true);
    expect(readMoveState(root, at(1_000)).current?.state).toBe("move");
  });

  it("a lockdown kills the move (code, key and session) and keeps the units record for the unlock", () => {
    const root = stateRoot();
    const { session } = lockMove(root);
    writeFileSync(join(root, MOVE_UNITS_FILE), "[]");
    expect(killMoveForLockdown(root)).toBe(true);
    expect(existsSync(stateFile(root))).toBe(false);
    expect(checkMoveSession(root, `Bearer ${session}`, at(1_000))).toBeNull();
    expect(existsSync(join(root, MOVE_UNITS_FILE))).toBe(true);
    expect(killMoveForLockdown(root)).toBe(false);
  });
});

describe("the boot gate", () => {
  it("boots the MOVE-locked server only in a locked move", () => {
    const root = stateRoot();
    const markers = noRootMarkers();
    const mode = () => moveBootMode(root, { rootMarkerDir: markers });
    expect(mode()).toBe("normal");
    mint(root);
    expect(mode()).toBe("normal");
    rmSync(stateFile(root));
    pair(root);
    expect(mode()).toBe("normal");
    markMoveLocked(root, { preflightId: "pf-1", now: T0 });
    expect(mode()).toBe("move");
  });

  it("a security lock wins over a move, from the state marker or the root marker", () => {
    const root = stateRoot();
    const markers = noRootMarkers();
    lockMove(root);
    writeFileSync(
      join(root, LOCK_MARKER_FILE),
      lockMarkerBody(root, { reason: "intrusion", by: "host", now: T0 }),
    );
    expect(moveBootMode(root, { rootMarkerDir: markers })).toBe("lockdown");
    rmSync(join(root, LOCK_MARKER_FILE));
    expect(moveBootMode(root, { rootMarkerDir: markers })).toBe("move");
    writeFileSync(
      join(markers, ROOT_MARKER_FILE),
      lockMarkerBody(root, { reason: "intrusion", by: "host", now: T0 }),
    );
    expect(moveBootMode(root, { rootMarkerDir: markers })).toBe("lockdown");
  });

  it("a cancel record wins over a state file a crash left behind: the boot is normal and the state file goes", () => {
    const root = stateRoot();
    const markers = noRootMarkers();
    lockMove(root);
    writeFileSync(
      join(root, MOVE_CANCELLED_FILE),
      JSON.stringify({ at: at(1_000).toISOString() }),
    );
    expect(moveBootMode(root, { rootMarkerDir: markers })).toBe("normal");
    expect(existsSync(stateFile(root))).toBe(false);
    // The record stays for the normal boot, which audits the cancel.
    expect(readMoveCancelled(root)).toEqual({ at: at(1_000).toISOString() });
  });
});

// Slice 2a: the pull's marks on the state, the MOVED state, and the lock
// marker that keeps an unreadable state file locked (N1).
const marker = (root: string) => join(root, MOVE_LOCK_MARKER);

function moved(root: string, now = T0) {
  const locked = lockMove(root, now);
  markMoveDone(root, {
    manifestId: "m-1",
    newOrigin: "https://new.example.com",
    now,
  });
  return locked;
}

describe("the pull's marks and MOVED", () => {
  it("the first batch served is marked once, and only in a locked move", () => {
    const root = stateRoot();
    pair(root);
    expect(markMoveServed(root, at(1_000))).toBe(false);
    expect(JSON.parse(rawState(root)).servedAt).toBeUndefined();

    markMoveLocked(root, { preflightId: "pf-1", now: at(2_000) });
    expect(markMoveServed(root, at(3_000))).toBe(true);
    expect(markMoveServed(root, at(4_000))).toBe(false);
    expect(JSON.parse(rawState(root))).toMatchObject({
      state: "move",
      servedAt: at(3_000).getTime(),
    });
  });

  it("done turns a locked move into MOVED with the new origin, keeps the session, and only once", () => {
    const root = stateRoot();
    pair(root);
    expect(() =>
      markMoveDone(root, {
        manifestId: "m-1",
        newOrigin: "https://new.example.com",
        now: at(1_000),
      }),
    ).toThrow(MoveStateError);
    expect(readMoveState(root, at(1_000)).current?.state).toBe("paired");

    rmSync(stateFile(root));
    const { session } = lockMove(root, at(2_000));
    const done = markMoveDone(root, {
      manifestId: "m-7",
      newOrigin: "https://new.example.com",
      now: at(3_000),
    });
    expect(done).toMatchObject({
      state: "moved",
      manifestId: "m-7",
      newOrigin: "https://new.example.com",
      doneAt: at(3_000).getTime(),
    });
    expect(JSON.parse(rawState(root)).state).toBe("moved");
    expect(checkMoveSession(root, `Bearer ${session}`, at(4_000))?.state).toBe(
      "moved",
    );
    let err: unknown = null;
    try {
      markMoveDone(root, {
        manifestId: "m-8",
        newOrigin: "https://other.example.com",
        now: at(5_000),
      });
    } catch (e) {
      err = e;
    }
    expect((err as MoveStateError | null)?.code).toBe("not_locked");
    expect(JSON.parse(rawState(root)).manifestId).toBe("m-7");
  });

  it("MOVED never expires, and neither the owner's cancel nor a new code ends it", () => {
    const root = stateRoot();
    moved(root);
    const later = at(30 * 24 * 60 * 60_000);
    expect(readMoveState(root, later).current?.state).toBe("moved");
    expect(() => cancelMove(root, later)).toThrow(MoveStateError);
    expect(() => mint(root, later)).toThrow(MoveStateError);
    expect(readMoveState(root, later).current?.state).toBe("moved");
  });

  it("keeps only the http(s) origin of the new office's URL", () => {
    expect(moveOriginFrom("https://new.example.com:8443/a/b?c=1#d")).toBe(
      "https://new.example.com:8443",
    );
    expect(moveOriginFrom("http://100.64.0.7:4000")).toBe(
      "http://100.64.0.7:4000",
    );
    for (const bad of [
      "javascript:alert(1)",
      "ftp://new.example.com",
      "data:text/html,x",
      "new.example.com",
      "",
      42,
      null,
      { href: "https://new.example.com" },
    ])
      expect([bad, moveOriginFrom(bad)]).toEqual([bad, null]);
  });
});

describe("the lock marker (N1)", () => {
  it("the lock writes it; the cancel by code and a lockdown delete it, also from MOVED", () => {
    const root = stateRoot();
    pair(root);
    expect(existsSync(marker(root))).toBe(false);
    markMoveLocked(root, { preflightId: "pf-1", now: T0 });
    expect(existsSync(marker(root))).toBe(true);
    killMoveForLockdown(root);
    expect(existsSync(marker(root))).toBe(false);

    const second = join(dir, "second", ".isomux");
    mkdirSync(second, { recursive: true });
    const { code } = moved(second);
    expect(existsSync(marker(second))).toBe(true);
    expect(cancelMoveByCode(second, code, at(1_000))).toBe(true);
    expect(existsSync(marker(second))).toBe(false);
    expect(existsSync(stateFile(second))).toBe(false);
  });

  it("boots MOVED and a marked unreadable state file locked, and an unmarked or missing one normal", () => {
    const root = stateRoot();
    const markers = noRootMarkers();
    const mode = () => moveBootMode(root, { rootMarkerDir: markers });
    moved(root);
    expect(mode()).toBe("move");

    writeFileSync(stateFile(root), "{not json");
    expect(existsSync(marker(root))).toBe(true);
    expect(mode()).toBe("move");
    rmSync(marker(root));
    expect(mode()).toBe("normal");

    // A marker the state file no longer backs: a readable pairing, or no file.
    writeFileSync(marker(root), "");
    rmSync(stateFile(root));
    expect(mode()).toBe("normal");
    pair(root);
    expect(mode()).toBe("normal");
  });

  it("a cancel record wins over a marked unreadable state file, and the boot clears the marker", () => {
    const root = stateRoot();
    const markers = noRootMarkers();
    lockMove(root);
    expect(existsSync(marker(root))).toBe(true);
    writeFileSync(stateFile(root), "{not json");
    writeFileSync(
      join(root, MOVE_CANCELLED_FILE),
      JSON.stringify({ at: at(1_000).toISOString() }),
    );
    expect(moveBootMode(root, { rootMarkerDir: markers })).toBe("normal");
    expect(existsSync(stateFile(root))).toBe(false);
    expect(existsSync(marker(root))).toBe(false);
  });
});
