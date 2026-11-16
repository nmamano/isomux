// The move routes the new box calls on the old office (task 78733adf, slice
// 1), through the front door's handler with a real state root and real
// preflight jobs. The clock, the turns in flight, the restart policy and the
// stop are the seams; server/test-support/office-move-routes.test.ts drives
// the same routes through the whole server once, for the wiring.
//
// Who may lock (the [R] condition "who starts the lock"): only the holder of
// a live move session, in "paired", with a ready preflight of this pairing
// that is fresh, under a unit that restarts the office, and with no agent
// working that the preflight did not show.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_MARKER_FILE, LOCKDOWN_DIR_PREFIX } from "./lockdown.ts";
import {
  cancelMove,
  mintMoveCode,
  MOVE_PREFLIGHT_FRESH_MS,
  MOVE_SESSION_TTL_MS,
  parseMoveCode,
  readMoveState,
  type MoveBoxInfo,
} from "./office-move.ts";
import {
  createMovePreflightJobs,
  type MovePreflightResult,
  type TurnInFlight,
} from "./office-move-preflight.ts";
import {
  createOfficeMoveFrontDoor,
  type OfficeMoveFrontDoor,
} from "./office-move-routes.ts";
import { MOVE_UNITS_FILE, type AgentUnit } from "./office-move-units.ts";
import {
  createMoveManifestJobs,
  moveItemsHash,
  openMoveStream,
  readMoveRecords,
} from "./office-move-pull.ts";
import { Database } from "bun:sqlite";
import { createMoveScope, MOVE_SCRATCH_DIR } from "./office-move-scope.ts";
import { moveLockedResponse } from "./move-locked-office.ts";
import type { MoveOutsideFolders } from "../shared/office-move.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// This box, as both sides send it. bed() points homePath and stateRoot at
// its real folders: the redeem checks the state root on disk (slice 2b).
let BOX: MoveBoxInfo = {
  release: "v2026.11.12",
  commit: "a".repeat(40),
  homePath: "/home/isomux",
  stateRoot: "/home/isomux/.isomux",
};
const UNITS: AgentUnit[] = [
  {
    name: "tailscaled.service",
    fragmentPath: "/home/isomux/.config/systemd/user/tailscaled.service",
    unitFileState: "enabled",
    activeState: "active",
    transient: false,
  },
];
const OFF_BOX = { onBox: false, client: "203.0.113.9" };

interface Bed {
  root: string;
  /** The home the pull walks (slice 4), and the move scratch folder. */
  home: string;
  scratch: string;
  door: OfficeMoveFrontDoor;
  pull: NonNullable<Parameters<typeof createOfficeMoveFrontDoor>[0]["pull"]>;
  clock: { now: number };
  turns: TurnInFlight[];
  restart: { value: string | null };
  /** What the members-with-their-own-OS-user read gives now. */
  members: { value: MovePreflightResult["memberOsUsers"] };
  /** Slice 5b: what the read of the folders outside the home gives now. */
  outside: { value: MoveOutsideFolders };
  allow: { value: boolean };
  /** How far the clock moves at each preflight step (a slow preflight). */
  stepTakes: { ms: number };
  /** What lockProcess saw on disk when it ran, and how often it ran. */
  locks: { state: string | null; unitsRecord: boolean }[];
  stops: AgentUnit[][];
  audits: string[];
  /** Holds every preflight step until released. */
  holdPreflight(): () => void;
  call(
    method: string,
    path: string,
    opts?: { session?: string; body?: unknown; raw?: string },
  ): Promise<{ status: number; body: Record<string, unknown> | null }>;
  mint(): string;
}

function bed(): Bed {
  dir = mkdtempSync(join(tmpdir(), "office-move-routes-"));
  const root = join(dir, ".isomux");
  mkdirSync(root);
  BOX = { ...BOX, homePath: dir, stateRoot: root };
  const home = join(dir, "home");
  mkdirSync(home);
  // One top-level entry, so the preflight runs a step that holdPreflight
  // can hold.
  writeFileSync(join(home, "notes.txt"), "x");
  const clock = { now: Date.parse("2026-11-15T10:00:00Z") };
  const turns: TurnInFlight[] = [];
  const restart = { value: "always" as string | null };
  const members: Bed["members"] = { value: { names: [] } };
  const outside: Bed["outside"] = { value: { move: [], left: [] } };
  const allow = { value: true };
  const stepTakes = { ms: 0 };
  const locks: Bed["locks"] = [];
  const stops: AgentUnit[][] = [];
  const audits: string[] = [];
  let hold: Promise<void> | null = null;
  const preflight = createMovePreflightJobs({
    home,
    hosts: () => ["old.example.com"],
    apps: () => [],
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    listUnits: () => UNITS,
    restartPolicy: () =>
      restart.value === null
        ? null
        : { unit: "isomux.service", manager: "system", restart: restart.value },
    memberOsUsers: () => members.value,
    outsideFolders: () => outside.value,
    exec: async () => {
      if (hold) await hold;
      clock.now += stepTakes.ms;
      return { code: 0, stdout: "0\t.\n", timedOut: false };
    },
    osUser: "isomux",
    aptHistoryPath: join(dir, "no-apt-log"),
    now: () => clock.now,
  });
  // Slice 4: the pull of the running office, over the box's home.
  const scope = createMoveScope({
    home: dir,
    stateRoot: root,
    codeDir: null,
    backupDir: null,
  });
  const scratch = join(root, MOVE_SCRATCH_DIR);
  const pull = {
    manifests: createMoveManifestJobs({
      scope,
      dir: scratch,
      units: () => [],
      secretCount: () => 0,
      now: () => new Date(clock.now),
    }),
    batch: { scope, scratchDir: scratch, snapshot: snapshotOfficeDatabase },
  };
  const door = createOfficeMoveFrontDoor({
    pull,
    stateRoot: root,
    ours: () => BOX,
    preflight,
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    restartPolicy: () => restart.value,
    memberOsUsers: () => members.value,
    outsideFolders: () => outside.value,
    listUnits: () => UNITS,
    lockProcess: () => {
      locks.push({
        state: readMoveState(root, new Date(clock.now)).current?.state ?? null,
        unitsRecord: existsSync(join(root, MOVE_UNITS_FILE)),
      });
    },
    audit: (input) => audits.push(input.operation),
    requestStop: (units) => stops.push(units),
    allow: () => allow.value,
    now: () => new Date(clock.now),
  });
  return {
    root,
    home,
    scratch,
    door,
    pull,
    clock,
    turns,
    restart,
    members,
    outside,
    allow,
    stepTakes,
    locks,
    stops,
    audits,
    holdPreflight() {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
      const body =
        opts.raw ??
        (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const req = new Request(`https://old.example.com${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      const res = await door.handle(req, new URL(req.url), OFF_BOX);
      if (!res) throw new Error(`no answer for ${method} ${path}`);
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    },
    mint() {
      return mintMoveCode(root, {
        origin: "https://old.example.com",
        by: "Morgan",
        now: new Date(clock.now),
      }).code;
    },
  };
}

// The error code of an answer: {error: {code}}, as every office route answers.
const code = (r: { body: Record<string, unknown> | null }) =>
  ((r.body?.error as { code?: string } | undefined)?.code ?? null) as
    string | null;
const tokenOf = (c: string) => parseMoveCode(c)!.token;

async function pair(b: Bed): Promise<string> {
  const res = await b.call("POST", "/api/move/redeem", {
    body: { token: tokenOf(b.mint()), newBox: BOX },
  });
  if (res.status !== 200) throw new Error(`redeem: ${JSON.stringify(res)}`);
  return res.body!.session as string;
}

async function readyPreflight(b: Bed, session: string): Promise<string> {
  const started = await b.call("POST", "/api/move/preflight", { session });
  if (started.status !== 202)
    throw new Error(`preflight: ${JSON.stringify(started)}`);
  const id = started.body!.id as string;
  const deadline = performance.now() + 5_000;
  for (;;) {
    const s = await b.call("GET", `/api/move/preflight/${id}`, { session });
    if (s.body?.state === "ready") return id;
    if (s.body?.state === "failed" || performance.now() > deadline)
      throw new Error(`preflight: ${JSON.stringify(s)}`);
    await Bun.sleep(5);
  }
}

describe("the redeem route", () => {
  it("pairs with the code: 200 with the session and this box, one audit row, and the status route opens with the session", async () => {
    const b = bed();
    const res = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(b.mint()), newBox: BOX },
    });
    expect(res.status).toBe(200);
    // Slice 2c-1: the key is always there (null: a system unit or none).
    expect(res.body?.office).toEqual({ ...BOX, officeUnit: null });
    expect(typeof res.body?.session).toBe("string");
    expect(b.audits).toEqual(["office.pairMove"]);
    const status = await b.call("GET", "/api/move/status", {
      session: res.body!.session as string,
    });
    expect({ status: status.status, state: status.body?.state }).toEqual({
      status: 200,
      state: "paired",
    });
  });

  it("a wrong token gets 403 move_code_invalid before any comparison: no home path or release in the answer", async () => {
    const b = bed();
    b.mint();
    const res = await b.call("POST", "/api/move/redeem", {
      body: {
        token: Buffer.alloc(32, 3).toString("base64url"),
        newBox: { ...BOX, homePath: "/home/other" },
      },
    });
    expect({ status: res.status, code: code(res) }).toEqual({
      status: 403,
      code: "move_code_invalid",
    });
    expect(JSON.stringify(res.body)).not.toContain(BOX.homePath);
    expect(b.audits).toEqual([]);
  });

  it("a refusal shows both boxes to the token holder as 409 and leaves the code redeemable", async () => {
    const b = bed();
    const c = b.mint();
    const theirs = {
      ...BOX,
      homePath: "/home/office",
      stateRoot: "/home/office/.isomux",
    };
    const res = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: theirs },
    });
    expect({
      status: res.status,
      code: code(res),
      ours: res.body?.ours,
      theirs: res.body?.theirs,
    }).toEqual({
      status: 409,
      code: "home_path_differs",
      ours: BOX,
      theirs,
    });
    const again = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: BOX },
    });
    expect(again.status).toBe(200);
  });

  it("a body that is not {token, newBox} gets 400 and pairs nothing", async () => {
    const b = bed();
    const c = b.mint();
    const bad = [
      await b.call("POST", "/api/move/redeem", { raw: "not json" }),
      await b.call("POST", "/api/move/redeem", { body: { token: tokenOf(c) } }),
      await b.call("POST", "/api/move/redeem", {
        body: { token: tokenOf(c), newBox: { homePath: 7 } },
      }),
    ];
    expect(bad.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "code",
    );
  });

  it("refuses a body over 64 KB with 413 without reading it as a redeem", async () => {
    const b = bed();
    const c = b.mint();
    const res = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: BOX, pad: "x".repeat(1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "code",
    );
  });

  it("is rate-limited for callers off the box: 429, and the code is not tried", async () => {
    const b = bed();
    const c = b.mint();
    b.allow.value = false;
    const res = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: BOX },
    });
    expect(res.status).toBe(429);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "code",
    );
  });
});

describe("the move session", () => {
  it("every route but the redeem needs it: 401 move_session_invalid without it or with a wrong one", async () => {
    const b = bed();
    await pair(b);
    const wrong = Buffer.alloc(32, 9).toString("base64url");
    const got = [];
    for (const session of [undefined, wrong]) {
      for (const [method, path, body] of [
        ["POST", "/api/move/preflight", undefined],
        ["GET", "/api/move/preflight/x", undefined],
        ["POST", "/api/move/lock", { preflightId: "x" }],
        ["GET", "/api/move/status", undefined],
      ] as const) {
        const r = await b.call(method, path, { session, body });
        got.push(`${method} ${path} ${r.status} ${code(r)}`);
      }
    }
    expect(got).toEqual(
      [0, 1].flatMap(() => [
        "POST /api/move/preflight 401 move_session_invalid",
        "GET /api/move/preflight/x 401 move_session_invalid",
        "POST /api/move/lock 401 move_session_invalid",
        "GET /api/move/status 401 move_session_invalid",
      ]),
    );
    expect(b.locks).toEqual([]);
  });

  it("an expired pairing is dropped at the next request, audited once, and its session no longer opens", async () => {
    const b = bed();
    const session = await pair(b);
    b.clock.now += MOVE_SESSION_TTL_MS + 1;
    const res = await b.call("GET", "/api/move/status", { session });
    expect({ status: res.status, code: code(res) }).toEqual({
      status: 401,
      code: "move_session_invalid",
    });
    expect(b.audits).toEqual(["office.pairMove", "office.moveExpired"]);
    await b.call("GET", "/api/move/status", { session });
    expect(b.audits.filter((a) => a === "office.moveExpired")).toHaveLength(1);
  });
});

describe("the lock", () => {
  it("locks with a fresh preflight of this pairing: 202, the units record and the move state are on disk before the process locks, one audit row, the stop gets the units, and nothing is quarantined", async () => {
    const b = bed();
    for (const name of ["sessions.json", "api-tokens.json", "invites.json"])
      writeFileSync(join(b.root, name), "{}");
    b.turns.push({ agentId: "a1", name: "Mapper", roomName: "Lab" });
    const session = await pair(b);
    // A slow preflight: its one step takes 10 min. Freshness counts from its
    // end, so the lock below is in time.
    b.stepTakes.ms = 10 * 60_000;
    const id = await readyPreflight(b, session);
    b.stepTakes.ms = 0;
    // Within the freshness window, and the agent the owner saw has finished.
    b.clock.now += MOVE_PREFLIGHT_FRESH_MS - 1;
    b.turns.length = 0;

    const res = await b.call("POST", "/api/move/lock", {
      session,
      body: { preflightId: id },
    });
    expect(res.status).toBe(202);
    expect(b.locks).toEqual([{ state: "move", unitsRecord: true }]);
    const record = JSON.parse(
      readFileSync(join(b.root, MOVE_UNITS_FILE), "utf8"),
    );
    expect(record.map((u: AgentUnit) => u.name)).toEqual([
      "tailscaled.service",
    ]);
    expect(readMoveState(b.root, new Date(b.clock.now)).current).toMatchObject({
      state: "move",
      preflightId: id,
    });
    expect(b.audits).toEqual(["office.pairMove", "office.lockForMove"]);

    // The stop runs after the answer.
    const deadline = performance.now() + 2_000;
    while (b.stops.length === 0 && performance.now() < deadline)
      await Bun.sleep(10);
    expect(b.stops.map((u) => u.map((x) => x.name))).toEqual([
      ["tailscaled.service"],
    ]);

    for (const name of ["sessions.json", "api-tokens.json", "invites.json"])
      expect(existsSync(join(b.root, name))).toBe(true);
    expect(existsSync(join(b.root, LOCK_MARKER_FILE))).toBe(false);
    expect(
      readdirSync(b.root).filter((n) => n.startsWith(LOCKDOWN_DIR_PREFIX)),
    ).toEqual([]);

    const status = await b.call("GET", "/api/move/status", { session });
    expect(status.body?.state).toBe("move");
  });

  it("refuses a preflight that is unknown, still running, or finished more than 15 min ago, with 409 preflight_stale", async () => {
    const b = bed();
    const session = await pair(b);
    const lock = (preflightId: string) =>
      b.call("POST", "/api/move/lock", { session, body: { preflightId } });

    const unknown = await lock("no-such-preflight");

    const release = b.holdPreflight();
    const started = await b.call("POST", "/api/move/preflight", { session });
    // The condition this case needs: the job is still running at the lock.
    expect(
      (
        await b.call(
          "GET",
          `/api/move/preflight/${started.body!.id as string}`,
          { session },
        )
      ).body?.state,
    ).toBe("running");
    const running = await lock(started.body!.id as string);
    release();

    const id = started.body!.id as string;
    const deadline = performance.now() + 5_000;
    while (
      (await b.call("GET", `/api/move/preflight/${id}`, { session })).body
        ?.state !== "ready" &&
      performance.now() < deadline
    )
      await Bun.sleep(5);
    b.clock.now += MOVE_PREFLIGHT_FRESH_MS + 1;
    const stale = await lock(id);

    expect(
      [unknown, running, stale].map((r) => `${r.status} ${code(r)}`),
    ).toEqual([
      "409 preflight_stale",
      "409 preflight_stale",
      "409 preflight_stale",
    ]);
    expect(b.locks).toEqual([]);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
  });

  it("refuses the preflight of an earlier pairing", async () => {
    const b = bed();
    const first = await pair(b);
    const oldId = await readyPreflight(b, first);
    cancelMove(b.root, new Date(b.clock.now));
    const second = await pair(b);
    const res = await b.call("POST", "/api/move/lock", {
      session: second,
      body: { preflightId: oldId },
    });
    expect(`${res.status} ${code(res)}`).toBe("409 preflight_stale");
    expect(b.locks).toEqual([]);
  });

  it("refuses with 409 turns_changed and the current list when an agent works that the preflight did not show", async () => {
    const b = bed();
    b.turns.push({ agentId: "a1", name: "Mapper", roomName: "Lab" });
    const session = await pair(b);
    const id = await readyPreflight(b, session);
    b.turns.push({ agentId: "a2", name: "Gateway", roomName: "Lab" });
    const res = await b.call("POST", "/api/move/lock", {
      session,
      body: { preflightId: id },
    });
    expect(`${res.status} ${code(res)}`).toBe("409 turns_changed");
    expect(JSON.stringify(res.body)).toContain("a2");
    expect(b.locks).toEqual([]);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
  });

  it("slice 5b: refuses with 409 folders_changed when the folders that move differ from the preflight's, and writes nothing; a change of the left list only does not refuse; the lock records the list in the state", async () => {
    const b = bed();
    const a = { path: "/srv/a", mode: 0o755 };
    const c = { path: "/srv/c", mode: 0o700 };
    b.outside.value = { move: [a], left: [] };
    const session = await pair(b);
    const id = await readyPreflight(b, session);
    const lock = () =>
      b.call("POST", "/api/move/lock", { session, body: { preflightId: id } });
    const got: string[] = [];
    for (const move of [[a, c], [], [c]]) {
      b.outside.value = { move, left: [] };
      const res = await lock();
      got.push(`${res.status} ${code(res)}`);
    }
    expect(got).toEqual(Array(3).fill("409 folders_changed"));
    expect(b.locks).toEqual([]);
    expect(existsSync(join(b.root, MOVE_UNITS_FILE))).toBe(false);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
    // The same folders, with a folder left now that was not before.
    b.outside.value = {
      move: [a],
      left: [{ path: "/srv/theirs", reason: "owner" }],
    };
    const res = await lock();
    expect(res.status).toBe(202);
    expect(readMoveState(b.root, new Date(b.clock.now)).current).toMatchObject({
      state: "move",
      outside: ["/srv/a"],
    });
  });

  it("refuses with 409 no_service_manager unless the office's unit restarts it always", async () => {
    const b = bed();
    const session = await pair(b);
    const got: string[] = [];
    for (const value of ["on-failure", null]) {
      b.restart.value = value;
      const id = await readyPreflight(b, session);
      const res = await b.call("POST", "/api/move/lock", {
        session,
        body: { preflightId: id },
      });
      got.push(`${res.status} ${code(res)}`);
    }
    expect(got).toEqual(["409 no_service_manager", "409 no_service_manager"]);
    expect(b.locks).toEqual([]);
  });

  it("slice 3: the preflight names the members with their own OS user, as the read gives them", async () => {
    const b = bed();
    const session = await pair(b);
    const seen: unknown[] = [];
    for (const value of [
      { names: [] },
      { names: ["Mia", "Sam"] },
      { broken: true as const },
    ]) {
      b.members.value = value;
      const id = await readyPreflight(b, session);
      const s = await b.call("GET", `/api/move/preflight/${id}`, { session });
      seen.push(
        (s.body?.result as { memberOsUsers?: unknown } | undefined)
          ?.memberOsUsers,
      );
    }
    expect(seen).toEqual([
      { names: [] },
      { names: ["Mia", "Sam"] },
      { broken: true },
    ]);
  });

  it("slice 3: refuses with 409 member_os_users from a read at the lock, not the preflight's copy, and writes nothing; the lock goes once none is left", async () => {
    const b = bed();
    const session = await pair(b);
    const lockWith = async (value: Bed["members"]["value"]) => {
      // The preflight saw no such member; the lock reads again.
      b.members.value = { names: [] };
      const id = await readyPreflight(b, session);
      b.members.value = value;
      return b.call("POST", "/api/move/lock", {
        session,
        body: { preflightId: id },
      });
    };
    const named = await lockWith({ names: ["Mia"] });
    expect([`${named.status} ${code(named)}`, named.body?.names]).toEqual([
      "409 member_os_users",
      ["Mia"],
    ]);
    const broken = await lockWith({ broken: true });
    expect([`${broken.status} ${code(broken)}`, broken.body?.broken]).toEqual([
      "409 member_os_users",
      true,
    ]);
    expect(b.locks).toEqual([]);
    expect(b.stops).toEqual([]);
    expect(existsSync(join(b.root, MOVE_UNITS_FILE))).toBe(false);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
    const ok = await lockWith({ names: [] });
    expect(ok.status).toBe(202);
    expect(b.locks.length).toBe(1);
  });

  it("a units record that cannot be written answers 500 and changes nothing: still paired, not locked, no stop", async () => {
    const b = bed();
    const session = await pair(b);
    const id = await readyPreflight(b, session);
    mkdirSync(join(b.root, MOVE_UNITS_FILE));
    const res = await b.call("POST", "/api/move/lock", {
      session,
      body: { preflightId: id },
    });
    expect(res.status).toBe(500);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
    expect(b.locks).toEqual([]);
    await Bun.sleep(300);
    expect(b.stops).toEqual([]);
    expect(b.audits).toEqual(["office.pairMove"]);
  });
});

// Slice 2b, the reviewer's note: a state root outside the home, or
// ~/.isomux as a link, moves no office data (the walk lists a link and never
// enters it), and two different state roots put the data in the wrong
// folder on the new box. The old office refuses at the redeem, shows both
// boxes, and the code is not used up.
describe("the redeem and the state root", () => {
  const STATE_ROOT_CODES = ["state_root_outside_home", "state_root_differs"];

  async function refusedThenRedeemable(
    b: Bed,
    c: string,
    newBox: MoveBoxInfo,
  ): Promise<{
    status: number;
    code: string | null;
    ours: unknown;
    theirs: unknown;
  }> {
    const res = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox },
    });
    const state = readMoveState(b.root, new Date(b.clock.now)).current?.state;
    return {
      status: res.status,
      code: code(res),
      ours: res.body?.ours,
      theirs: res.body?.theirs,
      ...(state === "code" ? {} : { codeUsedUp: state }),
    };
  }

  it("refuses when this office's state root is a link (~/.isomux -> a real folder): 409, both boxes shown, the code stays", async () => {
    const b = bed();
    const real = BOX;
    const link = join(real.homePath, ".isomux-link");
    symlinkSync(real.stateRoot, link);
    BOX = { ...real, stateRoot: link };
    const c = b.mint();
    const res = await refusedThenRedeemable(b, c, BOX);
    expect(res.status).toBe(409);
    expect(STATE_ROOT_CODES).toContain(res.code!);
    expect(res).toMatchObject({ ours: BOX, theirs: BOX });
    // Fixed (the real folder): the same code pairs.
    BOX = real;
    const again = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: BOX },
    });
    expect(again.status).toBe(200);
  });

  it("refuses when this office's state root is outside its home: 409 state_root_outside_home", async () => {
    const b = bed();
    const outside = mkdtempSync(join(tmpdir(), "office-move-outside-"));
    try {
      BOX = { ...BOX, stateRoot: outside };
      const c = b.mint();
      const res = await refusedThenRedeemable(b, c, BOX);
      expect(res).toEqual({
        status: 409,
        code: "state_root_outside_home",
        ours: BOX,
        theirs: BOX,
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a new box whose state root differs: 409 state_root_differs, both values, the code stays", async () => {
    const b = bed();
    const c = b.mint();
    const theirs = { ...BOX, stateRoot: join(BOX.homePath, ".isomux-other") };
    const res = await refusedThenRedeemable(b, c, theirs);
    expect(res).toEqual({
      status: 409,
      code: "state_root_differs",
      ours: BOX,
      theirs,
    });
    const again = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(c), newBox: BOX },
    });
    expect(again.status).toBe(200);
  });

  // Precision: a home reached through a link is fine when the state root is
  // a real folder in it (the walk starts from the home's realpath).
  it("pairs when the home path is a link and the state root is a real folder inside it", async () => {
    const b = bed();
    const linkedHome = `${BOX.homePath}-via-link`;
    symlinkSync(BOX.homePath, linkedHome);
    try {
      BOX = {
        ...BOX,
        homePath: linkedHome,
        stateRoot: join(linkedHome, ".isomux"),
      };
      const res = await b.call("POST", "/api/move/redeem", {
        body: { token: tokenOf(b.mint()), newBox: BOX },
      });
      expect({ status: res.status, code: code(res) }).toEqual({
        status: 200,
        code: null,
      });
    } finally {
      rmSync(linkedHome, { force: true });
    }
  });
});

// Slice 4 (the live pass): the running office serves the pull in `paired`,
// to the move session only, so the new office copies before the lock. done
// stays MOVE-only. servedAt and its one audit row cover both passes, and an
// ended pairing ([R] C3) stops what is in flight and deletes the scratch.
describe("the pull while paired (slice 4)", () => {
  async function readyManifest(b: Bed, session: string): Promise<string> {
    const started = await b.call("POST", "/api/move/manifest", { session });
    if (started.status !== 202)
      throw new Error(`manifest: ${JSON.stringify(started)}`);
    const id = started.body!.id as string;
    const deadline = performance.now() + 5_000;
    for (;;) {
      const st = await b.call(
        "GET",
        `/api/move/manifest/${encodeURIComponent(id)}`,
        { session },
      );
      if (st.body?.state === "ready") return id;
      if (st.body?.state === "failed" || performance.now() > deadline)
        throw new Error(`manifest: ${JSON.stringify(st)}`);
      await Bun.sleep(5);
    }
  }
  const batchBody = (manifestId: string, n = 0, path = "home/notes.txt") => ({
    manifestId,
    batch: n,
    items: [{ path }],
  });
  const pulledAudits = (b: Bed) =>
    b.audits.filter((a) => a === "office.movePulled").length;

  it("serves the manifest, its data and a batch to the move session only; done waits for the lock", async () => {
    const b = bed();
    const session = await pair(b);
    const none = await b.call("POST", "/api/move/manifest");
    expect([none.status, code(none)]).toEqual([401, "move_session_invalid"]);
    const id = await readyManifest(b, session);
    const data = await b.call(
      "GET",
      `/api/move/manifest/${encodeURIComponent(id)}/data`,
      { session },
    );
    expect(data.status).toBe(200);
    const anon = await b.call("POST", "/api/move/batch", {
      body: batchBody(id),
    });
    expect([anon.status, code(anon)]).toEqual([401, "move_session_invalid"]);
    const got = await b.call("POST", "/api/move/batch", {
      session,
      body: batchBody(id),
    });
    expect(got.status).toBe(200);
    const done = await b.call("POST", "/api/move/done", {
      session,
      body: { manifestId: id, newOrigin: "https://new.example.com" },
    });
    expect([done.status, code(done)]).toEqual([409, "not_locked"]);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "paired",
    );
  });

  it("the first batch sets servedAt and audits once; the lock keeps it, and the locked office's batches audit nothing more", async () => {
    const b = bed();
    const session = await pair(b);
    const id = await readyManifest(b, session);
    const at = b.clock.now;
    expect(
      (
        await b.call("POST", "/api/move/batch", {
          session,
          body: batchBody(id),
        })
      ).status,
    ).toBe(200);
    b.clock.now += 1_000;
    expect(
      (
        await b.call("POST", "/api/move/batch", {
          session,
          body: batchBody(id, 1),
        })
      ).status,
    ).toBe(200);
    const served = () =>
      (
        readMoveState(b.root, new Date(b.clock.now)).current as {
          servedAt?: number;
        } | null
      )?.servedAt;
    expect(served()).toBe(at);
    expect(pulledAudits(b)).toBe(1);

    const preflightId = await readyPreflight(b, session);
    const locked = await b.call("POST", "/api/move/lock", {
      session,
      body: { preflightId },
    });
    expect(locked.status).toBe(202);
    expect(readMoveState(b.root, new Date(b.clock.now)).current?.state).toBe(
      "move",
    );
    expect(served()).toBe(at);

    // The final pass, on the MOVE-locked server.
    const lockedAudits: string[] = [];
    const lockedCall = async (method: string, path: string, body?: unknown) => {
      const res = await moveLockedResponse(
        new Request(`https://old.example.com${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${session}`,
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        {
          stateRoot: b.root,
          requestStop: () => {},
          now: () => new Date(b.clock.now),
          pull: b.pull,
          audit: (input) => lockedAudits.push(input.operation),
        },
      );
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    };
    const started = await lockedCall("POST", "/api/move/manifest");
    expect(started.status).toBe(202);
    const finalId = started.body!.id as string;
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const st = await lockedCall(
        "GET",
        `/api/move/manifest/${encodeURIComponent(finalId)}`,
      );
      if (st.body?.state !== "running") break;
      await Bun.sleep(5);
    }
    expect(
      (await lockedCall("POST", "/api/move/batch", batchBody(finalId))).status,
    ).toBe(200);
    expect(lockedAudits.filter((a) => a === "office.movePulled")).toEqual([]);
    expect(pulledAudits(b)).toBe(1);
    expect(served()).toBe(at);
  });

  it("[R] C2: a batch in paired sends a SQLite file as an error record and takes no snapshot, whatever the new office asks", async () => {
    const b = bed();
    const db = new Database(join(b.home, "data.db"), { create: true });
    db.run("CREATE TABLE t (v TEXT)");
    db.run("INSERT INTO t VALUES ('x')");
    db.close();
    const code = b.mint();
    const redeemed = await b.call("POST", "/api/move/redeem", {
      body: { token: tokenOf(code), newBox: BOX },
    });
    const session = redeemed.body!.session as string;
    const key = Buffer.from(parseMoveCode(code)!.key, "base64url");
    const id = await readyManifest(b, session);
    const items = [{ path: "home/data.db" }, { path: "home/notes.txt" }];
    const res = await b.door.handle(
      new Request("https://old.example.com/api/move/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ manifestId: id, batch: 0, items }),
      }),
      new URL("https://old.example.com/api/move/batch"),
      OFF_BOX,
    );
    expect(res?.status).toBe(200);
    const got: string[] = [];
    for await (const ev of readMoveRecords(
      openMoveStream(
        key,
        {
          route: "batch",
          manifestId: id,
          batch: 0,
          itemsHash: moveItemsHash(items),
        },
        res!.body!,
      ),
    ))
      if (ev.type === "entry" || ev.type === "error")
        got.push(`${ev.path} ${ev.type}`);
    expect(got).toEqual(["home/data.db error", "home/notes.txt entry"]);
    expect(
      readdirSync(b.scratch).filter((n) => n.startsWith("snapshot")),
    ).toEqual([]);
  });

  it("endPull stops a batch stream in flight and a walk in flight, and deletes the scratch folder", async () => {
    const b = bed();
    writeFileSync(join(b.home, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 5));
    const session = await pair(b);
    const id = await readyManifest(b, session);
    const res = await b.door.handle(
      new Request("https://old.example.com/api/move/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchBody(id, 0, "home/big.bin")),
      }),
      new URL("https://old.example.com/api/move/batch"),
      OFF_BOX,
    );
    expect(res?.status).toBe(200);
    const reader = res!.body!.getReader();
    let read = (await reader.read()).value?.length ?? 0;
    expect(read).toBeGreaterThan(0);
    // A walk in flight: the route answers at the walk's first await.
    const walking = await b.call("POST", "/api/move/manifest", { session });
    expect(walking.status).toBe(202);
    const walkId = walking.body!.id as string;

    b.door.endPull();
    const ends = (async () => {
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) return true;
          read += r.value.length;
        }
      } catch {
        return true;
      }
    })();
    expect(await Promise.race([ends, Bun.sleep(3_000).then(() => false)])).toBe(
      true,
    );
    // The stream ended well short of the 6 MB file.
    expect(read).toBeLessThan(3 * 1024 * 1024);
    expect(existsSync(b.scratch)).toBe(false);
    await Bun.sleep(150);
    expect(existsSync(b.scratch)).toBe(false);
    // Neither manifest is served any more.
    const states = [];
    for (const mid of [id, walkId])
      states.push(
        (
          await b.call("GET", `/api/move/manifest/${encodeURIComponent(mid)}`, {
            session,
          })
        ).body?.state ?? null,
      );
    expect(states.filter((st) => st === "ready" || st === "running")).toEqual(
      [],
    );
  });

  it("an expired pairing ends the pull: the next request deletes the scratch folder", async () => {
    const b = bed();
    const session = await pair(b);
    await readyManifest(b, session);
    expect(readdirSync(b.scratch).length).toBeGreaterThan(0);
    b.clock.now += MOVE_SESSION_TTL_MS + 1;
    const res = await b.call("GET", "/api/move/status", { session });
    expect(res.status).toBe(401);
    expect(existsSync(b.scratch)).toBe(false);
  });
});
