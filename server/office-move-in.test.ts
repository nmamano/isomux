// The new office's side of an office move (task 78733adf, slice 2b): the
// freshness check, and the whole move-in run against the REAL old office in
// the same process - the front door (redeem, preflight, lock, status) while
// it is paired, the MOVE-locked server's pull routes once it is locked - over
// an injected fetch, so the pull needs no port.
//
// The [R] conditions here: the new box checks free space (blocks and inodes)
// before the first batch; the lock is sent only on the owner's yes (lock());
// the copy is checked from the trailers; slice 2b ends at `staged` and never
// sends `done` (design round D1), so the old office stays in MOVE.

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AuditActor } from "../shared/audit.ts";
import {
  mintMoveCode,
  MOVE_STATE_FILE,
  parseMoveCode,
  readMoveState,
  type MoveBoxInfo,
} from "./office-move.ts";
import {
  createMovePreflightJobs,
  type TurnInFlight,
} from "./office-move-preflight.ts";
import { createOfficeMoveFrontDoor } from "./office-move-routes.ts";
import { moveLockedResponse } from "./move-locked-office.ts";
import {
  createMoveManifestJobs,
  walkMoveManifest,
} from "./office-move-pull.ts";
import { createMoveScope, MOVE_SCRATCH_DIR } from "./office-move-scope.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";
import {
  checkMoveInFresh,
  createMoveIn,
  MOVE_IN_STATE_FILE,
  type MoveIn,
  type MoveInBox,
  type MoveInDeps,
  type MoveInFreshInput,
  type MoveInMovedState,
  type MoveInStatfs,
  type MoveInStatus,
} from "./office-move-in.ts";
import { MOVE_IN_DIR, MOVE_IN_STAGE } from "./office-move-stage.ts";
import {
  MOVE_IN_SWAP_FILE,
  type MoveInReport,
  type MoveInSwapFile,
} from "./office-move-swap.ts";

const REPO = join(import.meta.dir, "..");
const ORIGIN = "https://old.example.com";
const OWNER: AuditActor = { kind: "member", id: "u-owner", name: "Morgan" };
const FILE_MTIME = new Date("2026-10-01T12:00:00Z");
const STATE_ROOT_CODES = ["state_root_outside_home", "state_root_differs"];

// Each wait below ends in an assertion well before this: a broken move-in
// fails on what it got wrong, not on the runner's timeout.
setDefaultTimeout(30_000);

let dir = "";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (dir) {
    // Read-only and unreadable entries of the fixtures must not stop the
    // cleanup.
    for (const p of walkPaths(dir))
      try {
        if (!lstatSync(p).isSymbolicLink()) chmodSync(p, 0o700);
      } catch {
        // Gone already.
      }
    rmSync(dir, { recursive: true, force: true });
  }
  dir = "";
});

function walkPaths(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    out.push(p);
    try {
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        chmodSync(p, 0o700);
        for (const n of readdirSync(p)) stack.push(join(p, n));
      }
    } catch {
      // Skip.
    }
  }
  return out;
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
}

const TERMINAL = new Set(["staged", "incomplete", "failed"]);

async function waitPhase(m: MoveIn, phases: string[], ms = 8_000) {
  await waitFor(() => phases.includes(m.status().phase), ms);
  return m.status();
}

// ---- the old office ----

interface FetchCall {
  method: string;
  path: string;
  url: string;
  redirect: RequestRedirect | undefined;
  body: string | null;
}

interface OldOffice {
  home: string;
  root: string;
  box: MoveBoxInfo;
  turns: TurnInFlight[];
  scope: ReturnType<typeof createMoveScope>;
  log: FetchCall[];
  /** The move sessions the redeem gave. */
  sessions: string[];
  fetch: MoveInDeps["fetch"];
  mint(): string;
  state(): string | null;
}

const rnd = (n: number, seed: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) % 256));

// A home with a little of everything the move must carry.
function fillHome(home: string): void {
  const w = (p: string, data: string | Buffer, mode?: number) => {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), data);
    if (mode !== undefined) chmodSync(join(home, p), mode);
  };
  w(".isomux/agents.json", '{"agents":[]}\n');
  w("docs/a.txt", "alpha", 0o640);
  w("docs/sub/deep/n.txt", "deep");
  for (let i = 0; i < 30; i++)
    w(`files/f${String(i).padStart(3, "0")}.bin`, rnd(700 + i * 37, i));
  // Several batches of ranges at the test's 8 KiB batch size.
  w("big.bin", rnd(50_000, 99));
  w("bin/tool", "#!/bin/sh\necho hi\n", 0o4755);
  w("empty.txt", "");
  mkdirSync(join(home, "emptydir"));
  symlinkSync("a.txt", join(home, "docs/ln"));
  symlinkSync(join(home, "docs/a.txt"), join(home, "abs-ln"));
  symlinkSync("gone", join(home, "dangling"));
  w("ro/inside.txt", "read only folder");
  // Left out of the move (a cache).
  w(".cache/junk.bin", rnd(1000, 1));
  // Slice 3: sign-ins and secrets move; the box's SSH login keys and the
  // origin-bound sessions stay.
  w(".claude/.credentials.json", '{"token":"old-claude"}', 0o600);
  w(".ssh/id_ed25519", "OLD-SSH-ID", 0o600);
  w(".ssh/authorized_keys", "ssh-ed25519 AAAA old-box-login", 0o600);
  w(".config/gh/hosts.yml", "github.com: {oauth_token: old}");
  w(".isomux/secrets/office.json", '{"secrets":[]}', 0o600);
  w(".isomux/sessions.json", '{"old":"sessions"}', 0o600);
  // A SQLite database whose snapshot is smaller than the live file (freed
  // pages): its trailer, not the manifest size, is the right size.
  mkdirSync(join(home, "data"), { recursive: true });
  const db = new Database(join(home, "data/app.sqlite"));
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) ins.run("x".repeat(200));
  })();
  db.run("DELETE FROM t WHERE id > 100");
  db.close();
  for (const p of walkFiles(home))
    if (!p.endsWith(".sqlite")) utimesSync(p, FILE_MTIME, FILE_MTIME);
  chmodSync(join(home, "ro"), 0o500);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory())
      for (const n of readdirSync(p)) stack.push(join(p, n));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function bodyText(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body))
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  return null;
}

function oldOffice(name = "old"): OldOffice {
  const home = join(dir, name, "home");
  const root = join(home, ".isomux");
  mkdirSync(root, { recursive: true });
  fillHome(home);
  const box: MoveBoxInfo = {
    release: "v2026.11.12",
    commit: "a".repeat(40),
    homePath: home,
    stateRoot: root,
  };
  const turns: TurnInFlight[] = [];
  const now = () => new Date();
  const preflight = createMovePreflightJobs({
    home,
    hosts: () => ["old.example.com"],
    apps: () => [],
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    listUnits: () => [],
    restartPolicy: () => ({
      unit: "isomux.service",
      manager: "system",
      restart: "always",
    }),
    memberOsUsers: () => ({ names: [] }),
    exec: async () => ({ code: 0, stdout: "0\t.\n", timedOut: false }),
    osUser: "isomux",
    aptHistoryPath: join(dir, "no-apt-log"),
    now: () => Date.now(),
  });
  const door = createOfficeMoveFrontDoor({
    stateRoot: root,
    ours: () => box,
    preflight,
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    restartPolicy: () => "always",
    memberOsUsers: () => ({ names: [] }),
    listUnits: () => [],
    lockProcess: () => {},
    audit: () => {},
    requestStop: () => {},
    allow: () => true,
    now,
  });
  const scope = createMoveScope({
    home,
    stateRoot: root,
    codeDir: REPO,
    backupDir: join(dir, "backups"),
  });
  const scratch = join(root, MOVE_SCRATCH_DIR);
  const pull = {
    manifests: createMoveManifestJobs({
      scope,
      dir: scratch,
      units: () => [],
      secretCount: () => 0,
      now,
    }),
    batch: { scope, scratchDir: scratch, snapshot: snapshotOfficeDatabase },
  };
  const log: FetchCall[] = [];
  const sessions: string[] = [];
  const state = () => readMoveState(root, now()).current?.state ?? null;
  const fetch: MoveInDeps["fetch"] = async (url, init) => {
    const u = new URL(url);
    log.push({
      method: init.method ?? "GET",
      path: u.pathname,
      url,
      redirect: init.redirect,
      body: bodyText(init.body),
    });
    if (u.origin !== ORIGIN) throw new TypeError("fetch failed");
    const req = new Request(url, init);
    // The office restarts into the MOVE-locked server at the lock.
    const s = state();
    if (s === "move" || s === "moved")
      return moveLockedResponse(req, {
        stateRoot: root,
        requestStop: () => {},
        now,
        pull,
        audit: () => {},
      });
    const res =
      (await door.handle(req, u, { onBox: false, client: "203.0.113.9" })) ??
      new Response("not found", { status: 404 });
    if (u.pathname === "/api/move/redeem" && res.status === 200)
      sessions.push(
        ((await res.clone().json()) as { session: string }).session,
      );
    return res;
  };
  return {
    home,
    root,
    box,
    turns,
    scope,
    log,
    sessions,
    fetch,
    mint: () =>
      mintMoveCode(root, { origin: ORIGIN, by: "Morgan", now: now() }).code,
    state,
  };
}

// ---- the new office ----

interface NewOffice {
  home: string;
  root: string;
  moveIn: MoveIn;
  fresh: MoveInFreshInput;
  statfs: { value: MoveInStatfs };
  statfsPaths: string[];
  audits: string[];
  /** requestRestart calls (slice 2c-1). */
  restarts: { n: number };
}

const ROOMY: MoveInStatfs = { bavail: 1e9, bsize: 4096, ffree: 1e9 };

function newOffice(
  old: OldOffice,
  over: {
    name?: string;
    fetch?: MoveInDeps["fetch"];
    ours?: () => MoveBoxInfo;
    timing?: Partial<MoveInDeps["timing"]>;
    limits?: Partial<MoveInDeps["limits"]>;
    box?: Partial<MoveInBox>;
    onRestart?: () => void;
  } = {},
): NewOffice {
  const home = join(dir, over.name ?? "new", "home");
  const root = join(home, ".isomux");
  mkdirSync(root, { recursive: true });
  const fresh: MoveInFreshInput = {
    users: [{ role: "owner" }],
    agents: [],
    seededAgents: SEEDED,
    apps: 0,
    tasks: 0,
  };
  const statfs = { value: { ...ROOMY } };
  const statfsPaths: string[] = [];
  const audits: string[] = [];
  const restarts = { n: 0 };
  const moveIn = createMoveIn({
    stateRoot: root,
    home,
    fetch: over.fetch ?? old.fetch,
    // The home path is the same on both boxes (the redeem refuses
    // otherwise): this box answers with the old office's paths.
    ours: over.ours ?? (() => old.box),
    freshness: () => fresh,
    statfs: (p) => {
      statfsPaths.push(p);
      return { ...statfs.value };
    },
    audit: (op) => {
      audits.push(op);
    },
    box: () => ({
      codeDir: null,
      backupDir: null,
      officeUnit: null,
      restartPolicy: "always",
      publicOrigin: null,
      ...over.box,
    }),
    requestRestart: () => {
      restarts.n++;
      over.onRestart?.();
    },
    now: () => new Date(),
    timing: {
      requestMs: 2_000,
      idleMs: 400,
      pollMs: 10,
      restartWaitMs: 3_000,
      preflightWaitMs: 3_000,
      manifestWaitMs: 5_000,
      ...over.timing,
    },
    limits: {
      batchBytes: 8 * 1024,
      batchItemsJsonBytes: 800 * 1024,
      concurrency: 3,
      batchAttempts: 3,
      jsonMaxBytes: 1024 * 1024,
      ...over.limits,
    },
  });
  cleanups.push(() => moveIn.settled());
  return { home, root, moveIn, fresh, statfs, statfsPaths, audits, restarts };
}

const SEEDED = [
  { name: "Claude Welcome Agent", roomId: "welcome" },
  { name: "Codex Welcome Agent", roomId: "welcome" },
  { name: "Free Welcome Agent", roomId: "welcome" },
  { name: "Receptionist", roomId: "lobby" },
];

const stageOf = (n: NewOffice) => join(n.home, MOVE_IN_DIR, MOVE_IN_STAGE);
const paths = (o: OldOffice, p: string) =>
  o.log.filter((c) => c.path === p).length;
const errCode = (a: { ok: boolean }) => (a as { code?: string }).code ?? null;

/** start -> confirm; returns the preflight id. */
async function toConfirm(o: OldOffice, n: NewOffice): Promise<string> {
  const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
  if (!a.ok) throw new Error(`start: ${JSON.stringify(a)}`);
  const s = await waitPhase(n.moveIn, ["confirm", "failed"]);
  if (s.phase !== "confirm" || !("preflightId" in s) || !s.preflightId)
    throw new Error(`no confirm: ${JSON.stringify(s)}`);
  return s.preflightId;
}

async function toEnd(o: OldOffice, n: NewOffice): Promise<MoveInStatus> {
  const preflightId = await toConfirm(o, n);
  const locked = await n.moveIn.lock({ preflightId, by: OWNER });
  if (!locked.ok) throw new Error(`lock: ${JSON.stringify(locked)}`);
  return waitPhase(n.moveIn, [...TERMINAL]);
}

// ---- the tree compare ----

interface Seen {
  t: "f" | "d" | "l";
  mode?: number;
  sha?: string;
  mtime?: number;
  target?: string;
}

/** What the move must carry, read from a home or a stage. */
function tree(root: string, skip: (rel: string) => boolean): Map<string, Seen> {
  const out = new Map<string, Seen>();
  const visit = (rel: string) => {
    for (const name of readdirSync(rel ? join(root, rel) : root)) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const abs = join(root, r);
      const st = lstatSync(abs);
      if (st.isSymbolicLink())
        out.set(r, { t: "l", target: readlinkSync(abs) });
      else if (st.isDirectory()) {
        out.set(r, { t: "d", mode: st.mode & 0o1777 });
        visit(r);
      } else if (r.endsWith(".sqlite")) out.set(r, { t: "f" });
      else
        out.set(r, {
          t: "f",
          mode: st.mode & 0o1777,
          sha: createHash("sha256").update(readFileSync(abs)).digest("hex"),
          mtime: st.mtimeMs,
        });
    }
  };
  visit("");
  return out;
}

// The old office's own move files are not part of the copy; nor is a cache,
// nor a SQLite side file (it moves inside its database's snapshot).
const oldSkip = (r: string) =>
  /\.sqlite-(wal|shm|journal)$/.test(r) ||
  r === ".cache" ||
  r.startsWith(".cache/") ||
  // Slice 3: bound to the old box, so it stays there.
  r === ".ssh/authorized_keys" ||
  (r.startsWith(".isomux/") &&
    r !== ".isomux/agents.json" &&
    r !== ".isomux/secrets" &&
    r !== ".isomux/secrets/office.json");

const rows = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

// ---- the tests ----

describe("checkMoveInFresh", () => {
  const base: MoveInFreshInput = {
    users: [{ role: "owner" }],
    agents: SEEDED.map((a) => ({ ...a })),
    seededAgents: SEEDED,
    apps: 0,
    tasks: 0,
  };
  const kinds = (r: ReturnType<typeof checkMoveInFresh>) =>
    r.fresh ? [] : r.reasons.map((x) => x.kind).sort();
  const countOf = (r: ReturnType<typeof checkMoveInFresh>, kind: string) =>
    r.fresh ? 0 : (r.reasons.find((x) => x.kind === kind)?.count ?? 0);

  it("a new office is fresh: the installer owner, the seeded agents or fewer, no apps, no tasks", () => {
    expect(checkMoveInFresh(base)).toEqual({ fresh: true });
    expect(checkMoveInFresh({ ...base, agents: base.agents.slice(1) })).toEqual(
      { fresh: true },
    );
  });

  it("names each rule that fails, with a count", () => {
    const madeAgent = checkMoveInFresh({
      ...base,
      agents: [...base.agents, { name: "Helper", roomId: "welcome" }],
    });
    // A seeded name in another room is an agent the owner made.
    const movedSeed = checkMoveInFresh({
      ...base,
      agents: [{ name: "Receptionist", roomId: "welcome" }],
    });
    const member = checkMoveInFresh({
      ...base,
      users: [{ role: "owner" }, { role: "member" }],
    });
    const noOwner = checkMoveInFresh({ ...base, users: [{ role: "member" }] });
    const apps = checkMoveInFresh({ ...base, apps: 2 });
    const tasks = checkMoveInFresh({ ...base, tasks: 3 });
    const all = checkMoveInFresh({
      users: [{ role: "owner" }, { role: "owner" }],
      agents: [{ name: "Helper", roomId: "r" }],
      seededAgents: SEEDED,
      apps: 1,
      tasks: 1,
    });
    expect({
      madeAgent: [kinds(madeAgent), countOf(madeAgent, "agents")],
      movedSeed: [kinds(movedSeed), countOf(movedSeed, "agents")],
      member: kinds(member),
      noOwner: kinds(noOwner),
      apps: [kinds(apps), countOf(apps, "apps")],
      tasks: [kinds(tasks), countOf(tasks, "tasks")],
      all: kinds(all),
    }).toEqual({
      madeAgent: [["agents"], 1],
      movedSeed: [["agents"], 1],
      member: ["users"],
      noOwner: ["users"],
      apps: [["apps"], 2],
      tasks: [["tasks"], 3],
      all: ["agents", "apps", "tasks", "users"],
    });
    expect(countOf(member, "users")).toBeGreaterThan(0);
  });

  it("gives counts, never names", () => {
    const r = checkMoveInFresh({
      ...base,
      agents: [{ name: "Secret Project Bot", roomId: "r" }],
    });
    expect(JSON.stringify(r)).not.toContain("Secret Project Bot");
  });
});

describe("the move-in, start to staged, against the real old office", () => {
  it("pairs, shows the old office's preflight, locks on the owner's yes, pulls, checks, and stops at staged: the old office stays locked and gets no done", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const code = o.mint();
    const parts = parseMoveCode(code)!;

    const started = await n.moveIn.start({ code, by: OWNER });
    expect(started).toMatchObject({ ok: true, status: 202 });
    const confirm = await waitPhase(n.moveIn, ["confirm", "failed"]);
    expect(confirm.phase).toBe("confirm");
    // The owner sees the old office's preflight on this box.
    const pf = (confirm as { preflight?: Record<string, unknown> }).preflight;
    expect(Array.isArray(pf?.turnsInFlight)).toBe(true);
    expect(typeof pf?.sizes).toBe("object");
    // Nothing locked before the owner's yes.
    expect(o.state()).toBe("paired");
    expect(paths(o, "/api/move/lock")).toBe(0);

    const redeem = o.log.find((c) => c.path === "/api/move/redeem")!;
    expect(JSON.parse(redeem.body!).newBox).toEqual(o.box);

    const locked = await n.moveIn.lock({
      preflightId: (confirm as { preflightId: string }).preflightId,
      by: OWNER,
    });
    expect(locked).toMatchObject({ ok: true, status: 202 });
    const end = await waitPhase(n.moveIn, [...TERMINAL], 15_000);
    expect({
      phase: end.phase,
      error: (end as { error?: unknown }).error,
    }).toEqual({
      phase: "staged",
      error: undefined,
    });

    // The copy: every entry of the old home in scope, as it was; setuid and
    // setgid dropped; nothing else in the stage.
    const want = tree(o.home, oldSkip);
    for (const [, s] of want) if (s.mode !== undefined) s.mode &= ~0o6000;
    const got = tree(stageOf(n), () => false);
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(want));
    // The condition of the SQLite check: the snapshot is not the live size.
    const liveSize = lstatSync(join(o.home, "data/app.sqlite")).size;
    const stagedDb = join(stageOf(n), "data/app.sqlite");
    expect(lstatSync(stagedDb).size).not.toBe(liveSize);
    expect(rows(stagedDb)).toBe(rows(join(o.home, "data/app.sqlite")));

    // D1: no done in 2b; the old office stays in MOVE.
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(o.state()).toBe("move");
    expect(n.audits).toEqual(["office.moveInStaged"]);

    // D6: every request goes to the old origin and refuses a redirect.
    expect(o.log.filter((c) => !c.url.startsWith(`${ORIGIN}/`))).toEqual([]);
    expect(
      o.log.filter((c) => c.redirect !== "error").map((c) => c.path),
    ).toEqual([]);
    // Free space was read on this home before the pull.
    expect(n.statfsPaths.length).toBeGreaterThan(0);
    expect(n.statfsPaths.every((p) => p.startsWith(n.home))).toBe(true);

    // D8: the status never carries the session, the key or the code.
    expect(o.sessions.length).toBe(1);
    for (const s of [confirm, n.moveIn.status()]) {
      const text = JSON.stringify(s);
      expect(text).not.toContain(parts.key);
      expect(text).not.toContain(parts.token);
      expect(text).not.toContain(o.sessions[0]);
    }
  });
});

describe("before the redeem", () => {
  it("refuses an office that is not fresh: 409 office_not_fresh with the reasons, and no request to the old office", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    n.fresh.apps = 1;
    const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
    expect({ ok: a.ok, status: a.status, code: errCode(a) }).toEqual({
      ok: false,
      status: 409,
      code: "office_not_fresh",
    });
    expect(JSON.stringify(a)).toContain("apps");
    expect(o.log).toEqual([]);
    expect(o.state()).toBe("code");
    expect(n.moveIn.status().phase).toBe("none");
  });

  it("refuses a code that does not parse with 400 and no request", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const a = await n.moveIn.start({ code: "not a move code", by: OWNER });
    expect({ ok: a.ok, status: a.status, code: errCode(a) }).toEqual({
      ok: false,
      status: 400,
      code: "move_code_malformed",
    });
    expect(o.log).toEqual([]);
  });

  it("refuses when this office's own state root is a link or outside its home, with no request", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const link = join(o.home, ".isomux-link");
    symlinkSync(o.root, link);
    const outside = join(dir, "outside-state");
    mkdirSync(outside);
    const results = [];
    for (const stateRoot of [link, outside]) {
      const n = newOffice(o, {
        name: `new-${results.length}`,
        ours: () => ({ ...o.box, stateRoot }),
      });
      const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
      results.push({
        ok: a.ok,
        status: a.status,
        known: STATE_ROOT_CODES.includes(errCode(a) ?? ""),
      });
    }
    expect(results).toEqual([
      { ok: false, status: 409, known: true },
      { ok: false, status: 409, known: true },
    ]);
    expect(o.log).toEqual([]);
  });

  it("passes the old office's refusal through with both boxes, and the code stays usable", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    // This box runs an older release than the old office.
    const n = newOffice(o, {
      ours: () => ({ ...o.box, release: "v2026.1.1", commit: "b".repeat(40) }),
    });
    const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
    expect({ ok: a.ok, status: a.status, code: errCode(a) }).toEqual({
      ok: false,
      status: 409,
      code: "release_older",
    });
    const extra = (a as { extra?: Record<string, unknown> }).extra;
    expect(extra?.ours).toEqual(o.box);
    expect(o.state()).toBe("code");
    expect(n.moveIn.status().phase).toBe("none");
  });

  // D11: an old office that does not check the state root (or names none)
  // is refused by this box after the pair; nothing goes on from there.
  it("refuses a redeem answer with no state root, or another one, and starts no preflight", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const results = [];
    const variants = [
      (b: MoveBoxInfo) =>
        Object.fromEntries(
          Object.entries(b).filter(([k]) => k !== "stateRoot"),
        ),
      (b: MoveBoxInfo) => ({ ...b, stateRoot: join(b.homePath, ".other") }),
      // Slice 2c-1: no officeUnit key (an older release).
      (b: MoveBoxInfo) =>
        Object.fromEntries(
          Object.entries(b).filter(([k]) => k !== "officeUnit"),
        ),
      // The swap moves the paths the old office's unit names: a name or a
      // file that leaves the unit folders is refused.
      (b: MoveBoxInfo) => ({
        ...b,
        officeUnit: { name: "..", fragmentPath: null },
      }),
      (b: MoveBoxInfo) => ({
        ...b,
        officeUnit: { name: ".", fragmentPath: null },
      }),
      (b: MoveBoxInfo) => ({
        ...b,
        officeUnit: {
          name: "isomux.service",
          fragmentPath: `${b.homePath}/.config/systemd/user/../../../../victim`,
        },
      }),
      (b: MoveBoxInfo) => ({
        ...b,
        officeUnit: {
          name: "isomux.service",
          fragmentPath: ".config/systemd/user/isomux.service",
        },
      }),
    ];
    for (const office of variants) {
      // One old office each: the first one stays paired.
      const o = oldOffice(`old-${results.length}`);
      const n = newOffice(o, {
        name: `new-${results.length}`,
        fetch: async (url, init) => {
          const res = await o.fetch(url, init);
          if (!url.endsWith("/api/move/redeem") || res.status !== 200)
            return res;
          const body = (await res.json()) as { office: MoveBoxInfo };
          return Response.json({ ...body, office: office(body.office) });
        },
      });
      const before = paths(o, "/api/move/preflight");
      const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
      await n.moveIn.settled();
      results.push({
        ok: a.ok,
        preflights: paths(o, "/api/move/preflight") - before,
        phase: ["none", "failed"].includes(n.moveIn.status().phase),
      });
    }
    expect(results).toEqual(
      variants.map(() => ({ ok: false, preflights: 0, phase: true })),
    );
  });

  it("slice 2c-1: refuses a start when the office unit does not restart by itself, before the redeem", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, { box: { restartPolicy: "on-failure" } });
    const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
    expect([a.ok, errCode(a)]).toEqual([false, "restart_policy"]);
    expect(o.log.length).toBe(0);
    expect(o.state()).not.toBe("paired");
  });

  it("D9: two starts at the same time: one 202, one 409 move_in_running, one redeem", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, {
      fetch: async (url, init) => {
        await Bun.sleep(20);
        return o.fetch(url, init);
      },
    });
    const code = o.mint();
    const [a, b] = await Promise.all([
      n.moveIn.start({ code, by: OWNER }),
      n.moveIn.start({ code, by: OWNER }),
    ]);
    expect(
      [
        { status: a.status, code: errCode(a) },
        { status: b.status, code: errCode(b) },
      ].sort((x, y) => x.status - y.status),
    ).toEqual([
      { status: 202, code: null },
      { status: 409, code: "move_in_running" },
    ]);
    expect(paths(o, "/api/move/redeem")).toBe(1);
  });

  it("D6: a redeem that never answers fails within the request limit", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, {
      timing: { requestMs: 200 },
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const t0 = performance.now();
    const a = await Promise.race([
      n.moveIn.start({ code: o.mint(), by: OWNER }),
      Bun.sleep(3_000).then(() => "hung" as const),
    ]);
    expect(a === "hung" ? "hung" : a.ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it("D6: a JSON answer over the cap is not read: the move-in fails before confirm", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, {
      limits: { jsonMaxBytes: 64 * 1024 },
      fetch: async (url, init) => {
        const res = await o.fetch(url, init);
        if (!/\/api\/move\/preflight\/[^/]+$/.test(new URL(url).pathname))
          return res;
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, pad: "x".repeat(200 * 1024) });
      },
    });
    const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
    const s = a.ok
      ? await waitPhase(n.moveIn, ["confirm", "failed"])
      : n.moveIn.status();
    expect(s.phase === "confirm").toBe(false);
    expect(o.state()).toBe("paired");
  });
});

describe("the lock", () => {
  it("checks freshness again: an app made since the start refuses, and nothing is sent", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const preflightId = await toConfirm(o, n);
    n.fresh.apps = 1;
    const a = await n.moveIn.lock({ preflightId, by: OWNER });
    expect({ status: a.status, code: errCode(a) }).toEqual({
      status: 409,
      code: "office_not_fresh",
    });
    expect(paths(o, "/api/move/lock")).toBe(0);
    expect(o.state()).toBe("paired");
  });

  it("passes the old office's turns_changed through, and the old office stays paired", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const preflightId = await toConfirm(o, n);
    o.turns.push({ agentId: "a1", name: "Builder", roomName: "Lab" });
    const a = await n.moveIn.lock({ preflightId, by: OWNER });
    expect({ status: a.status, code: errCode(a) }).toEqual({
      status: 409,
      code: "turns_changed",
    });
    expect(o.state()).toBe("paired");
    expect(n.moveIn.status().phase).toBe("confirm");
  });

  it("the pull again is refused before the lock, and never sends one", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    await toConfirm(o, n);
    const a = await n.moveIn.retryPull({ by: OWNER });
    expect(a.ok).toBe(false);
    expect(a.status).toBe(409);
    await n.moveIn.settled();
    expect(paths(o, "/api/move/lock")).toBe(0);
    expect(o.state()).toBe("paired");
  });
});

// D5: blocks and inodes, before the first batch.
describe("the free-space check", () => {
  async function manifestSummary(o: OldOffice) {
    const tmp = join(dir, "summary.ndjson");
    const s = await walkMoveManifest(o.scope, tmp);
    rmSync(tmp);
    return s;
  }

  it("counts whole blocks: enough bytes but too few blocks fails no_space before any batch; the retry with room gives staged", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const sum = await manifestSummary(o);
    const bsize = 64 * 1024 * 1024;
    const bytesNeed = sum.totalBytes + Math.max(sum.totalBytes * 0.1, 2 ** 30);
    // Enough for the byte sum and its margin, short of one block per file.
    n.statfs.value = {
      bavail: Math.ceil(bytesNeed / bsize) + 2,
      bsize,
      ffree: 1e9,
    };
    const end = await toEnd(o, n);
    expect({
      phase: end.phase,
      code: (end as { error?: { code: string } }).error?.code,
      retryable: (end as { retryable?: boolean }).retryable,
    }).toEqual({ phase: "failed", code: "no_space", retryable: true });
    expect(paths(o, "/api/move/batch")).toBe(0);
    expect(o.state()).toBe("move");

    n.statfs.value = { ...ROOMY };
    const again = await n.moveIn.retryPull({ by: OWNER });
    expect(again.ok).toBe(true);
    const s = await waitPhase(n.moveIn, [...TERMINAL], 15_000);
    expect(s.phase).toBe("staged");
  });

  it("counts inodes: free inodes equal to the entries fails no_space before any batch", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const sum = await manifestSummary(o);
    n.statfs.value = { ...ROOMY, ffree: sum.entries };
    const end = await toEnd(o, n);
    expect({
      phase: end.phase,
      code: (end as { error?: { code: string } }).error?.code,
    }).toEqual({ phase: "failed", code: "no_space" });
    expect(paths(o, "/api/move/batch")).toBe(0);
  });
});

/** A fetch that changes the answers of the batch route. */
function batchFetch(
  o: OldOffice,
  change: (res: Response, nth: number) => Response | Promise<Response>,
): MoveInDeps["fetch"] {
  let nth = 0;
  return async (url, init) => {
    const res = await o.fetch(url, init);
    if (new URL(url).pathname !== "/api/move/batch" || res.status !== 200)
      return res;
    return change(res, nth++);
  };
}

/** The first half of a body, then `end` (close, error or stall). The
 *  whole body is read first, so the cut always falls inside it. */
async function cut(
  res: Response,
  end: "close" | "error" | "stall",
): Promise<Response> {
  const all = new Uint8Array(await res.arrayBuffer());
  const half = all.subarray(0, Math.floor(all.length / 2));
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(half);
        return;
      }
      if (end === "close") c.close();
      else if (end === "error") c.error(new Error("connection reset"));
      else await new Promise(() => {});
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

describe("a batch that fails", () => {
  for (const end of ["close", "error", "stall"] as const)
    it(`runs again when its stream ends early (${end}), and the copy is whole`, async () => {
      dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
      const o = oldOffice();
      const cuts = { n: 0 };
      const n = newOffice(o, {
        fetch: batchFetch(o, (res, nth) => {
          if (nth > 1) return res;
          cuts.n++;
          return cut(res, end);
        }),
      });
      const s = await toEnd(o, n);
      expect(cuts.n).toBe(2);
      expect(s.phase).toBe("staged");
      const want = tree(o.home, oldSkip);
      for (const [, v] of want) if (v.mode !== undefined) v.mode &= ~0o6000;
      expect(Object.fromEntries(tree(stageOf(n), () => false))).toEqual(
        Object.fromEntries(want),
      );
    });

  it("fails the pull (retryable) when one batch fails every attempt; no done, the old office stays locked", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, {
      fetch: batchFetch(o, (res) => cut(res, "close")),
    });
    const s = await toEnd(o, n);
    expect({
      phase: s.phase,
      retryable: (s as { retryable?: boolean }).retryable,
    }).toEqual({ phase: "failed", retryable: true });
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(o.state()).toBe("move");
  });

  // D6: a request past its time limit is aborted, not left open next to its
  // retry (each one holds a connection to the old office).
  it("a batch whose answer never starts is aborted at the request limit, and runs again", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const hung: AbortSignal[] = [];
    const n = newOffice(o, {
      timing: { requestMs: 300 },
      fetch: (url, init) => {
        if (new URL(url).pathname === "/api/move/batch" && hung.length === 0) {
          const signal = init.signal;
          if (!signal) throw new Error("a request with no signal");
          hung.push(signal);
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          );
        }
        return o.fetch(url, init);
      },
    });
    const s = await toEnd(o, n);
    expect({
      phase: s.phase,
      held: hung.length,
      aborted: hung[0]?.aborted,
    }).toEqual({
      phase: "staged",
      held: 1,
      aborted: true,
    });
  });

  it("a fetch that throws ends in failed, never an unhandled error", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o, {
      fetch: (url, init) => {
        if (new URL(url).pathname === "/api/move/batch")
          throw new Error("boom");
        return o.fetch(url, init);
      },
    });
    const s = await toEnd(o, n);
    expect(s.phase).toBe("failed");
  });
});

describe("a file the old office cannot read", () => {
  it("gives incomplete with its path, is asked once, and sends no done", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    mkdirSync(join(o.home, "secret"));
    writeFileSync(join(o.home, "secret/locked.txt"), "no");
    chmodSync(join(o.home, "secret/locked.txt"), 0o000);
    const n = newOffice(o);
    const s = await toEnd(o, n);
    expect(s.phase).toBe("incomplete");
    const result = (s as { result?: { missing: { path: string }[] } }).result;
    expect(result?.missing.map((m) => m.path)).toContain("secret/locked.txt");
    const asked = o.log.filter(
      (c) =>
        c.path === "/api/move/batch" && c.body?.includes("secret/locked.txt"),
    ).length;
    expect(asked).toBe(1);
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(o.state()).toBe("move");
  });
});

/** A fetch whose requests to `path` wait until released. */
function holding(o: OldOffice, path: string) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = { n: 0 };
  const fetch: MoveInDeps["fetch"] = async (url, init) => {
    if (new URL(url).pathname === path) {
      held.n++;
      await gate;
      throw new Error("the process is gone");
    }
    return o.fetch(url, init);
  };
  return { fetch, held, release: () => release!() };
}

// The pull job lives in the process. A restart is a second office on a copy
// of the first one's state file, while the first stays held (a dead process
// writes nothing more).
describe("a restart of the new office", () => {
  it("mid-pull gives failed (interrupted, retryable); the pull again wipes the stage and ends staged", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const h = holding(o, "/api/move/batch");
    const n1 = newOffice(o, { fetch: h.fetch });
    // Released before n1.settled() runs (the cleanups run in reverse).
    cleanups.push(h.release);
    const preflightId = await toConfirm(o, n1);
    expect((await n1.moveIn.lock({ preflightId, by: OWNER })).ok).toBe(true);
    await waitFor(() => h.held.n > 0);
    expect(n1.moveIn.status().phase).toBe("pulling");

    const n2Home = join(dir, "new2", "home");
    mkdirSync(join(n2Home, ".isomux"), { recursive: true });
    copyFileSync(
      join(n1.root, MOVE_IN_STATE_FILE),
      join(n2Home, ".isomux", MOVE_IN_STATE_FILE),
    );
    const junk = join(n2Home, MOVE_IN_DIR, MOVE_IN_STAGE, "junk.txt");
    mkdirSync(join(junk, ".."), { recursive: true });
    writeFileSync(junk, "left over");
    const n2 = newOffice(o, { name: "new2" });
    n2.moveIn.recoverAtBoot();
    const s = n2.moveIn.status();
    expect({
      phase: s.phase,
      code: (s as { error?: { code: string } }).error?.code,
      retryable: (s as { retryable?: boolean }).retryable,
    }).toEqual({ phase: "failed", code: "interrupted", retryable: true });

    expect((await n2.moveIn.retryPull({ by: OWNER })).ok).toBe(true);
    const end = await waitPhase(n2.moveIn, [...TERMINAL], 15_000);
    expect(end.phase).toBe("staged");
    expect(existsSync(junk)).toBe(false);
    expect(o.state()).toBe("move");
  });

  it("while the lock was in flight: the pull again finds the old office still paired and goes back to confirm, sending no lock", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const h = holding(o, "/api/move/lock");
    const n1 = newOffice(o, { fetch: h.fetch });
    cleanups.push(h.release);
    const preflightId = await toConfirm(o, n1);
    void n1.moveIn.lock({ preflightId, by: OWNER });
    await waitFor(() => h.held.n > 0);
    expect(n1.moveIn.status().phase).toBe("locking");

    const n2Home = join(dir, "new2", "home");
    mkdirSync(join(n2Home, ".isomux"), { recursive: true });
    copyFileSync(
      join(n1.root, MOVE_IN_STATE_FILE),
      join(n2Home, ".isomux", MOVE_IN_STATE_FILE),
    );
    const n2 = newOffice(o, { name: "new2" });
    n2.moveIn.recoverAtBoot();
    expect(n2.moveIn.status().phase).toBe("failed");
    await n2.moveIn.retryPull({ by: OWNER });
    const s = await waitPhase(n2.moveIn, ["confirm", "staged", "failed"]);
    expect(s.phase).toBe("confirm");
    expect(o.state()).toBe("paired");
  });
});

/** A fetch whose requests to `method path` wait until released, then go
 *  through. */
function gated(o: OldOffice, method: string, path: string) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = { n: 0 };
  const fetch: MoveInDeps["fetch"] = async (url, init) => {
    if (new URL(url).pathname === path && (init.method ?? "GET") === method) {
      held.n++;
      await gate;
    }
    return o.fetch(url, init);
  };
  return { fetch, held, release: () => release!() };
}

describe("the cancel", () => {
  // A cancel while the redeem or the preflight request is in flight: the
  // request that comes back after it must not bring the move-in back.
  it("during the redeem: nothing comes back after it, no preflight starts", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const g = gated(o, "POST", "/api/move/redeem");
    const n = newOffice(o, { fetch: g.fetch });
    cleanups.push(g.release);
    const started = n.moveIn.start({ code: o.mint(), by: OWNER });
    await waitFor(() => g.held.n > 0);
    expect((await n.moveIn.cancel({ by: OWNER })).ok).toBe(true);
    g.release();
    const a = await started;
    await n.moveIn.settled();
    expect({
      ok: a.ok,
      phase: n.moveIn.status().phase,
      file: existsSync(join(n.root, MOVE_IN_STATE_FILE)),
      preflights: paths(o, "/api/move/preflight"),
    }).toEqual({ ok: false, phase: "none", file: false, preflights: 0 });
  });

  it("during the preflight again: the move-in stays cancelled", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n0 = newOffice(o);
    await toConfirm(o, n0);
    await n0.moveIn.settled();
    // The same state file, read by an office whose preflight start waits.
    const g = gated(o, "POST", "/api/move/preflight");
    const n = newOffice(o, { fetch: g.fetch });
    cleanups.push(g.release);
    expect(n.moveIn.status().phase).toBe("confirm");
    const again = n.moveIn.rerunPreflight({ by: OWNER });
    await waitFor(() => g.held.n > 0);
    expect((await n.moveIn.cancel({ by: OWNER })).ok).toBe(true);
    g.release();
    await again;
    await n.moveIn.settled();
    expect({
      phase: n.moveIn.status().phase,
      file: existsSync(join(n.root, MOVE_IN_STATE_FILE)),
    }).toEqual({ phase: "none", file: false });
  });

  it("before the lock: the state file goes, the status is none, the old office is not locked", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    await toConfirm(o, n);
    const a = await n.moveIn.cancel({ by: OWNER });
    expect(a.ok).toBe(true);
    expect(n.moveIn.status().phase).toBe("none");
    expect(existsSync(join(n.root, MOVE_IN_STATE_FILE))).toBe(false);
    expect(o.state()).toBe("paired");
  });

  it("after staged: the stage goes too", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    expect((await toEnd(o, n)).phase).toBe("staged");
    expect(existsSync(stageOf(n))).toBe(true);
    const a = await n.moveIn.cancel({ by: OWNER });
    expect(a.ok).toBe(true);
    expect(existsSync(stageOf(n))).toBe(false);
    expect(existsSync(join(n.root, MOVE_IN_STATE_FILE))).toBe(false);
    expect(n.moveIn.status().phase).toBe("none");
  });
});

// ---- slice 2c-1: finish ----

const NEW_ORIGIN = "https://new.example.com";
const REQ_ORIGIN = "https://req.example.com";

function writeUsers(
  root: string,
  users: { id: string; name: string; role: string }[],
) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "users.json"),
    JSON.stringify(
      Object.fromEntries(users.map((u) => [u.id, { ...u, createdAt: 1 }])),
    ),
  );
}

const swapFileOf = (n: NewOffice) =>
  join(n.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE);
const readSwap = (n: NewOffice) =>
  JSON.parse(readFileSync(swapFileOf(n), "utf8")) as MoveInSwapFile;
const phaseOnDisk = (n: NewOffice) =>
  (
    JSON.parse(readFileSync(join(n.root, MOVE_IN_STATE_FILE), "utf8")) as {
      phase: string;
    }
  ).phase;
const doneBodies = (o: OldOffice) =>
  o.log
    .filter((c) => c.path === "/api/move/done")
    .map(
      (c) =>
        JSON.parse(c.body ?? "null") as {
          manifestId: string;
          newOrigin: string;
        },
    );

/** An old office and a new office with their users, at staged. */
async function stagedPair(
  over: Parameters<typeof newOffice>[1] = {},
  oldUsers: { id: string; name: string; role: string }[] = [
    { id: "u-old", name: "Riley", role: "owner" },
  ],
  /** Wraps the old office's fetch (the new office's view of it). */
  wrap?: (o: OldOffice) => MoveInDeps["fetch"],
) {
  dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
  const o = oldOffice();
  writeUsers(o.root, oldUsers);
  const n = newOffice(o, wrap ? { ...over, fetch: wrap(o) } : over);
  writeUsers(n.root, [{ id: OWNER.id, name: OWNER.name, role: "owner" }]);
  const s = await toEnd(o, n);
  return { o, n, s };
}

const finishAs = (n: NewOffice, acceptMissing = false) =>
  n.moveIn.finish({ acceptMissing, by: OWNER, requestOrigin: REQ_ORIGIN });

describe("finish (slice 2c-1)", () => {
  it("staged: done with the public origin, swap.json with the inputs and no ops, phase swapping, then one restart; 202", async () => {
    const atRestart: { seen: { swap: boolean; phase: string } | null } = {
      seen: null,
    };
    const { o, n, s } = await stagedPair({
      box: { publicOrigin: NEW_ORIGIN },
      onRestart: () => {
        atRestart.seen = {
          swap: existsSync(swapFileOf(n)),
          phase: phaseOnDisk(n),
        };
      },
    });
    expect(s.phase).toBe("staged");
    const a = await finishAs(n);
    expect(a.ok && a.status).toBe(202);
    expect(o.state()).toBe("moved");
    expect(doneBodies(o).map((b) => b.newOrigin)).toEqual([NEW_ORIGIN]);
    const sw = readSwap(n);
    // B1: finish stores the inputs only; the swap boot computes the ops.
    expect(sw.ops).toBeNull();
    expect(sw.inputs.ownerId).toBe(OWNER.id);
    expect(sw.inputs.home).toBe(n.home);
    expect(sw.inputs.stateRoot).toBe(n.root);
    expect(sw.inputs.report.oldOrigin).toBe(ORIGIN);
    expect(sw.inputs.report.missing).toEqual([]);
    expect(n.moveIn.status().phase).toBe("swapping");
    // The restart comes last: swap.json and the phase are on disk by then.
    expect(n.restarts.n).toBe(1);
    expect(atRestart.seen).toEqual({ swap: true, phase: "swapping" });
    // Nothing moved yet: the stage is still there.
    expect(existsSync(join(stageOf(n), ".isomux/agents.json"))).toBe(true);
  });

  it("with no public origin, sends the origin of the owner's request", async () => {
    const { o, n } = await stagedPair();
    expect((await finishAs(n)).ok).toBe(true);
    expect(doneBodies(o).map((b) => b.newOrigin)).toEqual([REQ_ORIGIN]);
    // How the office listens is kept for a failed swap's page: absent reads
    // as loopback.
    expect(readSwap(n).inputs.loopbackOnly).toBe(true);
  });

  it("keeps an office that listens on all interfaces as such for a failed swap's page", async () => {
    const { n } = await stagedPair({ box: { loopbackOnly: false } });
    expect((await finishAs(n)).ok).toBe(true);
    expect(readSwap(n).inputs.loopbackOnly).toBe(false);
  });

  for (const c of [
    {
      // The unit changed after the start checked it.
      label: "an office unit that is not Restart=always: 409 restart_policy",
      code: "restart_policy",
      setup: (n: NewOffice, box: Partial<MoveInBox>) => {
        void n;
        box.restartPolicy = "on-failure";
      },
    },
    {
      label: "an office that is no longer fresh: 409 office_not_fresh",
      code: "office_not_fresh",
      setup: (n: NewOffice) => {
        n.fresh.apps = 1;
      },
    },
  ]) {
    it(`refuses before done: ${c.label}; no swap.json, no restart, still staged`, async () => {
      const box: Partial<MoveInBox> = {};
      const { o, n } = await stagedPair({ box });
      c.setup(n, box);
      const a = await finishAs(n);
      expect([a.ok, a.ok ? null : a.status, errCode(a)]).toEqual([
        false,
        409,
        c.code,
      ]);
      expect(paths(o, "/api/move/done")).toBe(0);
      expect(o.state()).toBe("move");
      expect(existsSync(swapFileOf(n))).toBe(false);
      expect(n.restarts.n).toBe(0);
      expect(n.moveIn.status().phase).toBe("staged");
    });
  }

  it("refuses before done: an old office user with the fresh owner's id: 409 account_clash", async () => {
    const { o, n } = await stagedPair({}, [
      { id: OWNER.id, name: "Riley", role: "owner" },
    ]);
    const a = await finishAs(n);
    expect([a.ok, errCode(a)]).toEqual([false, "account_clash"]);
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(existsSync(swapFileOf(n))).toBe(false);
    expect(n.restarts.n).toBe(0);
    expect(n.moveIn.status().phase).toBe("staged");
  });

  it("refuses a phase before staged (confirm) and sends nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    await toConfirm(o, n);
    const a = await finishAs(n);
    expect([a.ok, a.ok ? null : a.status]).toEqual([false, 409]);
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(o.state()).toBe("paired");
  });

  it("incomplete: refused without acceptMissing (409 copy_incomplete); with it, done and the missing paths in the report", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    writeUsers(o.root, [{ id: "u-old", name: "Riley", role: "owner" }]);
    mkdirSync(join(o.home, "secret"));
    writeFileSync(join(o.home, "secret/locked.txt"), "no");
    chmodSync(join(o.home, "secret/locked.txt"), 0o000);
    const n = newOffice(o);
    writeUsers(n.root, [{ id: OWNER.id, name: OWNER.name, role: "owner" }]);
    expect((await toEnd(o, n)).phase).toBe("incomplete");

    const refused = await finishAs(n, false);
    expect([
      refused.ok,
      refused.ok ? null : refused.status,
      errCode(refused),
    ]).toEqual([false, 409, "copy_incomplete"]);
    expect(paths(o, "/api/move/done")).toBe(0);
    expect(n.moveIn.status().phase).toBe("incomplete");

    const a = await finishAs(n, true);
    expect(a.ok && a.status).toBe(202);
    expect(o.state()).toBe("moved");
    expect(readSwap(n).inputs.report.missing.map((m) => m.path)).toContain(
      "secret/locked.txt",
    );
    expect(n.restarts.n).toBe(1);
  });

  it("done's answer is lost after the old office took it: status says moved, so it goes on", async () => {
    const { o, n } = await stagedPair(
      {},
      undefined,
      (o) => async (url, init) => {
        const res = await o.fetch(url, init);
        if (new URL(url).pathname === "/api/move/done")
          throw new TypeError("fetch failed");
        return res;
      },
    );
    const a = await finishAs(n);
    expect(a.ok && a.status).toBe(202);
    expect(o.state()).toBe("moved");
    expect(paths(o, "/api/move/status")).toBeGreaterThan(0);
    expect(readSwap(n).ops).toBeNull();
    expect(n.restarts.n).toBe(1);
  });

  it("done lost before the old office got it (status move): back to staged with done_failed, nothing written; finish again works", async () => {
    const refuseDone = { on: true };
    const { o, n } = await stagedPair(
      {},
      undefined,
      (o) => async (url, init) => {
        // The request never reached the old office.
        if (refuseDone.on && new URL(url).pathname === "/api/move/done")
          throw new TypeError("fetch failed");
        return o.fetch(url, init);
      },
    );
    const a = await finishAs(n);
    expect(a.ok).toBe(false);
    expect(o.state()).toBe("move");
    const s = n.moveIn.status();
    expect(s.phase).toBe("staged");
    expect((s as { error?: { code: string } }).error?.code).toBe("done_failed");
    expect(existsSync(swapFileOf(n))).toBe(false);
    expect(n.restarts.n).toBe(0);
    // The stage is kept (never the pull again).
    expect(existsSync(join(stageOf(n), ".isomux/agents.json"))).toBe(true);

    refuseDone.on = false;
    const again = await finishAs(n);
    expect(again.ok && again.status).toBe(202);
    expect(o.state()).toBe("moved");
    expect(n.restarts.n).toBe(1);
  });

  it("the old office no longer knows the move (cancelled): failed, not retryable, no swap", async () => {
    const { n } = await stagedPair({}, undefined, (o) => async (url, init) => {
      if (new URL(url).pathname === "/api/move/done") {
        // The old office's owner cancelled by code just before.
        rmSync(join(o.root, MOVE_STATE_FILE), { force: true });
        throw new TypeError("fetch failed");
      }
      return o.fetch(url, init);
    });
    const a = await finishAs(n);
    expect(a.ok).toBe(false);
    const s = n.moveIn.status();
    expect([s.phase, (s as { retryable?: boolean }).retryable]).toEqual([
      "failed",
      false,
    ]);
    expect(existsSync(swapFileOf(n))).toBe(false);
    expect(n.restarts.n).toBe(0);
  });

  it("a cancel while finish runs never leaves a done old office without its copy", async () => {
    const { o, n } = await stagedPair();
    // finish stops at its first await (the dry run); the cancel comes then.
    const f = finishAs(n);
    const c = await n.moveIn.cancel({ by: OWNER });
    const a = await f;
    // Either the cancel won (nothing sent to the old office) or the finish
    // did (the cancel refused); never both.
    expect(c.ok && a.ok).toBe(false);
    if (o.state() === "moved") {
      expect(existsSync(join(stageOf(n), ".isomux/agents.json"))).toBe(true);
      expect(existsSync(swapFileOf(n))).toBe(true);
    } else {
      expect(paths(o, "/api/move/done")).toBe(0);
      expect(existsSync(swapFileOf(n))).toBe(false);
    }
  });

  it("a restart while done was in flight: the boot goes back to staged with the stage, and finish again asks the old office (done 409, status moved) and goes on", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = { n: 0 };
    const { o, n: n1 } = await stagedPair(
      {},
      undefined,
      (o) => async (url, init) => {
        const res = await o.fetch(url, init);
        if (new URL(url).pathname === "/api/move/done") {
          held.n++;
          await gate;
          throw new Error("the process is gone");
        }
        return res;
      },
    );
    cleanups.push(() => release!());
    void finishAs(n1);
    await waitFor(() => held.n > 0);
    expect(phaseOnDisk(n1)).toBe("finishing");
    expect(o.state()).toBe("moved");

    // The second process: a copy of the first one's disk.
    const n2Home = join(dir, "new2", "home");
    mkdirSync(n2Home, { recursive: true });
    cpSync(join(n1.home, ".isomux"), join(n2Home, ".isomux"), {
      recursive: true,
    });
    cpSync(join(n1.home, MOVE_IN_DIR), join(n2Home, MOVE_IN_DIR), {
      recursive: true,
    });
    const n2 = newOffice(o, { name: "new2" });
    n2.moveIn.recoverAtBoot();
    expect(n2.moveIn.status().phase).toBe("staged");
    expect(existsSync(join(stageOf(n2), ".isomux/agents.json"))).toBe(true);

    const a = await finishAs(n2);
    expect(a.ok && a.status).toBe(202);
    // The second done found the old office moved already.
    expect(o.log.filter((c) => c.path === "/api/move/done").length).toBe(2);
    expect(existsSync(swapFileOf(n2))).toBe(true);
    expect(n2.restarts.n).toBe(1);
  });
});

describe("moved (slice 2c-1)", () => {
  function movedOffice() {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const n = newOffice(o);
    const report: MoveInReport = {
      oldOrigin: ORIGIN,
      office: o.box,
      finishedAt: 1,
      by: OWNER,
      excluded: [{ unit: "ssh", entries: 2, bytes: 10 }],
      secretCount: 1,
      missing: [],
      swappedAt: 2,
      ownerRenamedTo: null,
      oldOfficeUnitSetAside: null,
      aside: { entries: ["notes.txt"], bytes: 5 },
      units: null,
      audited: false,
    };
    // As the swap boot leaves it.
    const moved: MoveInMovedState = {
      phase: "moved",
      oldOrigin: ORIGIN,
      office: o.box,
      report,
    };
    writeFileSync(join(n.root, MOVE_IN_STATE_FILE), JSON.stringify(moved));
    mkdirSync(join(n.home, MOVE_IN_DIR, "aside"), { recursive: true });
    writeFileSync(join(n.home, MOVE_IN_DIR, "aside/notes.txt"), "fresh");
    return { o, n, report };
  }

  it("the status after a restart is the report, with no session or key", () => {
    const { n, report } = movedOffice();
    n.moveIn.recoverAtBoot();
    const s = n.moveIn.status();
    expect(s.phase).toBe("moved");
    expect((s as { report?: MoveInReport }).report).toEqual(report);
    expect(JSON.stringify(s)).not.toMatch(/session|"key"/i);
  });

  it("the delete removes the report and the move-in folder (the fresh office set aside)", async () => {
    const { n } = movedOffice();
    n.moveIn.recoverAtBoot();
    expect(n.moveIn.status().phase).toBe("moved");
    expect((await n.moveIn.cancel({ by: OWNER })).ok).toBe(true);
    expect(n.moveIn.status().phase).toBe("none");
    expect(existsSync(join(n.root, MOVE_IN_STATE_FILE))).toBe(false);
    expect(existsSync(join(n.home, MOVE_IN_DIR))).toBe(false);
  });

  it("slice 2c-2: the status names the aside folder, the folder the delete removes; the delete answers the old office not locked", async () => {
    const { n } = movedOffice();
    n.moveIn.recoverAtBoot();
    const s = n.moveIn.status();
    const asidePath = (s as { asidePath?: string }).asidePath ?? "";
    expect(asidePath).toBe(join(n.home, MOVE_IN_DIR, "aside"));
    expect(readFileSync(join(asidePath, "notes.txt"), "utf8")).toBe("fresh");
    const a = await n.moveIn.cancel({ by: OWNER });
    expect(a.ok && a.body).toEqual({ cancelled: true, oldOfficeLocked: false });
    expect(existsSync(asidePath)).toBe(false);
  });

  it("refuses finish and a new start", async () => {
    const { o, n } = movedOffice();
    n.moveIn.recoverAtBoot();
    expect((await finishAs(n)).ok).toBe(false);
    expect((await n.moveIn.start({ code: o.mint(), by: OWNER })).ok).toBe(
      false,
    );
    expect(o.log.length).toBe(0);
  });
});

// ---- slice 2c-2: what the Settings pane reads ----

describe("the status for the Settings pane (slice 2c-2)", () => {
  it("phase none carries the start's own refusal as the blocker, and null on an office that can take a move", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const outside = join(dir, "outside-state");
    mkdirSync(outside);
    const variants: [
      string,
      (n: NewOffice) => void,
      Parameters<typeof newOffice>[1],
    ][] = [
      ["notFresh", (n) => void (n.fresh.apps = 2), {}],
      ["restart", () => {}, { box: { restartPolicy: "on-failure" } }],
      ["noUnit", () => {}, { box: { restartPolicy: null } }],
      [
        "stateRoot",
        () => {},
        { ours: () => ({ ...o.box, stateRoot: outside }) },
      ],
    ];
    const seen: Record<string, unknown> = {};
    for (const [name, spoil, over] of variants) {
      const n = newOffice(o, { name, ...over });
      spoil(n);
      const s = n.moveIn.status();
      const blocker = (s as { blocker?: { code: string; extra?: unknown } })
        .blocker;
      const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
      seen[name] = {
        phase: s.phase,
        same: blocker?.code === errCode(a) && !a.ok,
        extra:
          JSON.stringify(blocker?.extra ?? null) ===
          JSON.stringify((a as { extra?: unknown }).extra ?? null),
      };
    }
    const same = { phase: "none", same: true, extra: true };
    expect(seen).toEqual({
      notFresh: same,
      restart: same,
      noUnit: same,
      stateRoot: same,
    });
    // The not-fresh blocker names its reasons with counts.
    const n = newOffice(o, { name: "counts" });
    n.fresh.apps = 2;
    expect(
      (n.moveIn.status() as { blocker?: { extra?: unknown } }).blocker?.extra,
    ).toEqual({ reasons: [{ kind: "apps", count: 2 }] });
    // None of the GETs reached the old office.
    expect(o.log.length).toBe(0);

    const ready = newOffice(o, { name: "ready" });
    expect(ready.moveIn.status()).toEqual({ phase: "none", blocker: null });
  });

  it("oldOfficeLocked says what the cancel would say: not before the lock, yes while it is in flight and after it, yes on a failure after it", async () => {
    dir = mkdtempSync(join(tmpdir(), "office-move-in-"));
    const o = oldOffice();
    const locked = (s: MoveInStatus) =>
      (s as { oldOfficeLocked?: boolean }).oldOfficeLocked;
    const cancelSays = async (n: NewOffice) => {
      const a = await n.moveIn.cancel({ by: OWNER });
      return a.ok
        ? (a.body as { oldOfficeLocked?: boolean }).oldOfficeLocked
        : a;
    };

    // Before the lock.
    const n1 = newOffice(o, { name: "n1" });
    await toConfirm(o, n1);
    const atConfirm = locked(n1.moveIn.status());
    const cancelAtConfirm = await cancelSays(n1);

    // A failure after the lock (the restart cut the pull), from a second
    // old office: the first stays paired with n1.
    const o2 = oldOffice("old2");
    const h = holding(o2, "/api/move/batch");
    const n2 = newOffice(o2, { name: "n2", fetch: h.fetch });
    cleanups.push(h.release);
    const preflightId = await toConfirm(o2, n2);
    expect((await n2.moveIn.lock({ preflightId, by: OWNER })).ok).toBe(true);
    await waitFor(() => h.held.n > 0);
    const atPulling = locked(n2.moveIn.status());
    const n3Home = join(dir, "n3", "home");
    mkdirSync(join(n3Home, ".isomux"), { recursive: true });
    copyFileSync(
      join(n2.root, MOVE_IN_STATE_FILE),
      join(n3Home, ".isomux", MOVE_IN_STATE_FILE),
    );
    const n3 = newOffice(o2, { name: "n3" });
    n3.moveIn.recoverAtBoot();
    const failed = n3.moveIn.status();
    expect(failed.phase).toBe("failed");
    const atFailed = locked(failed);
    const cancelAtFailed = await cancelSays(n3);

    // The lock in flight: no lockedAt yet, but it may have arrived.
    const o4 = oldOffice("old4");
    const h4 = holding(o4, "/api/move/lock");
    const n4 = newOffice(o4, { name: "n4", fetch: h4.fetch });
    cleanups.push(h4.release);
    const pf4 = await toConfirm(o4, n4);
    void n4.moveIn.lock({ preflightId: pf4, by: OWNER });
    await waitFor(() => h4.held.n > 0);
    const s4 = n4.moveIn.status();
    expect(s4.phase).toBe("locking");
    expect((s4 as { lockedAt?: number | null }).lockedAt ?? null).toBe(null);
    const atLocking = locked(s4);

    expect({
      atConfirm,
      cancelAtConfirm,
      atLocking,
      atPulling,
      atFailed,
      cancelAtFailed,
    }).toEqual({
      atConfirm: false,
      cancelAtConfirm: false,
      atLocking: true,
      atPulling: true,
      atFailed: true,
      cancelAtFailed: true,
    });
  });

  it("oldOfficeLocked on a staged copy matches the cancel", async () => {
    const { n } = await stagedPair();
    const s = n.moveIn.status();
    expect(s.phase).toBe("staged");
    const atStaged = (s as { oldOfficeLocked?: boolean }).oldOfficeLocked;
    const a = await n.moveIn.cancel({ by: OWNER });
    expect({
      atStaged,
      cancel: a.ok && (a.body as { oldOfficeLocked?: boolean }).oldOfficeLocked,
    }).toEqual({ atStaged: true, cancel: true });
  });
});
