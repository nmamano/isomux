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
  type TurnInFlight,
} from "./office-move-preflight.ts";
import { createOfficeMoveFrontDoor } from "./office-move-routes.ts";
import { MOVE_UNITS_FILE, type AgentUnit } from "./office-move-units.ts";

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
  clock: { now: number };
  turns: TurnInFlight[];
  restart: { value: string | null };
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
    exec: async () => {
      if (hold) await hold;
      clock.now += stepTakes.ms;
      return { code: 0, stdout: "0\t.\n", timedOut: false };
    },
    osUser: "isomux",
    aptHistoryPath: join(dir, "no-apt-log"),
    now: () => clock.now,
  });
  const door = createOfficeMoveFrontDoor({
    stateRoot: root,
    ours: () => BOX,
    preflight,
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    restartPolicy: () => restart.value,
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
    clock,
    turns,
    restart,
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
