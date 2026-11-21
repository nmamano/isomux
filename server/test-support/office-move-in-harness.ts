// The harness of the office move-in tests (server/office-move-in.test.ts,
// server/office-move-in-members.test.ts): the REAL old office in this
// process, its front door and MOVE-locked server over an injected fetch,
// and a new office's move-in pulling from it.
import { expect } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AuditActor } from "../../shared/audit.ts";
import {
  mintMoveCode,
  readMoveState,
  type MoveBoxInfo,
} from "../office-move.ts";
import {
  createMovePreflightJobs,
  type TurnInFlight,
} from "../office-move-preflight.ts";
import { createOfficeMoveFrontDoor } from "../office-move-routes.ts";
import type { MemberHomeSource, MoveMember } from "../office-move-members.ts";
import { moveLockedResponse } from "../move-locked-office.ts";
import { createMoveManifestJobs } from "../office-move-pull.ts";
import { createMoveScope, MOVE_SCRATCH_DIR } from "../office-move-scope.ts";
import { snapshotOfficeDatabase } from "../sqlite-snapshot.ts";
import {
  createMoveIn,
  type MoveIn,
  type MoveInBox,
  type MoveInDeps,
  type MoveInFreshInput,
  type MoveInStatfs,
  type MoveInStatus,
} from "../office-move-in.ts";
import { MOVE_IN_DIR, MOVE_IN_STAGE } from "../office-move-stage.ts";
import type {
  MoveInLive,
  MoveOutsideFolders,
} from "../../shared/office-move.ts";
import { type MoveInFolderFs } from "../office-move-outside.ts";
import { MOVE_IN_SWAP_FILE, type MoveInSwapFile } from "../office-move-swap.ts";

const REPO = join(import.meta.dir, "..", "..");
export const ORIGIN = "https://old.example.com";
export const OWNER: AuditActor = {
  kind: "member",
  id: "u-owner",
  name: "Morgan",
};
export const FILE_MTIME = new Date("2026-10-01T12:00:00Z");

/** The scratch folder of the current test, and what runs after it. */
export const moveInBed: {
  dir: string;
  cleanups: (() => Promise<void> | void)[];
} = {
  dir: "",
  cleanups: [],
};

/** The afterEach of every file that uses the harness. */
export async function cleanupMoveInHarness(): Promise<void> {
  for (const c of moveInBed.cleanups.splice(0).reverse()) await c();
  const dir = moveInBed.dir;
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
  moveInBed.dir = "";
}

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

export async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
}

export const TERMINAL = new Set(["staged", "incomplete", "failed"]);

export async function waitPhase(m: MoveIn, phases: string[], ms = 8_000) {
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
  /** The old office's state when the request came (slice 4: a batch in
   *  "paired" is the live pass's, in "move" the final pass's). */
  state: string | null;
}

export interface OldOffice {
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
  /** Holds every preflight step until released (slice 4). */
  holdPreflight(): () => void;
}

export const rnd = (n: number, seed: number) =>
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
  // close(true) finalizes the statements, so SQLite checkpoints the WAL
  // now, not at a later GC that would grow the home mid-test.
  db.close(true);
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

export function bodyText(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body))
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  return null;
}

// Slice 5c-1: a member's runner whose home holds one file.
const oneFileMember: MemberHomeSource = () => ({
  async *list() {
    yield Buffer.from(
      `${JSON.stringify({ p: "m.txt", t: "f", s: 3, m: 1000, mode: 0o644 })}\n{"end":true}\n`,
    );
  },
  async *files() {
    yield Buffer.alloc(4);
  },
});

export function oldOffice(
  name = "old",
  opts: {
    /** Slice 4: the running office serves the pull (the live pass). Off,
     *  it answers 404 there, as a release before slice 4 does. */
    live?: boolean;
    /** Slice 5b: what the read of the folders outside the home gives now
     *  (the preflight, the lock and each manifest job read it). */
    outside?: { value: MoveOutsideFolders };
    /** Slice 5c-1: members with their own OS user, ready to move, whose
     *  runners each list one file. */
    members?: MoveMember[];
    /** Slice 5c-2: the members as the old office's records give them now
     *  (the preflight, the lock and each manifest job read it), and their
     *  runners (default: one file each). */
    memberList?: { value: MoveMember[] };
    memberSource?: MemberHomeSource;
  } = {},
): OldOffice {
  const memberList =
    opts.memberList ?? (opts.members ? { value: opts.members } : null);
  const memberSource = opts.memberSource ?? oneFileMember;
  const home = join(moveInBed.dir, name, "home");
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
  let preflightHold: Promise<void> | null = null;
  // The old office's check of its members, as production gives it to both
  // the preflight and the routes (isomux-office.ts).
  const memberCheck = memberList
    ? {
        moveMembers: async () => ({
          members: memberList.value.map((m) => ({
            userId: m.userId,
            name: m.name,
            osUser: m.osUser,
            home: m.home,
            block: null,
            units: [],
          })),
          ready: memberList.value,
        }),
      }
    : {};
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
    ...memberCheck,
    ...(opts.outside ? { outsideFolders: () => opts.outside!.value } : {}),
    exec: async () => {
      if (preflightHold) await preflightHold;
      return { code: 0, stdout: "0\t.\n", timedOut: false };
    },
    osUser: "isomux",
    aptHistoryPath: join(moveInBed.dir, "no-apt-log"),
    now: () => Date.now(),
  });
  const scope = createMoveScope({
    home,
    stateRoot: root,
    codeDir: REPO,
    backupDir: join(moveInBed.dir, "backups"),
  });
  const scratch = join(root, MOVE_SCRATCH_DIR);
  const pull = {
    manifests: createMoveManifestJobs({
      scope,
      dir: scratch,
      units: () => [],
      secretCount: () => 0,
      ...(opts.outside ? { outside: () => opts.outside!.value.move } : {}),
      ...(memberList ? { members: () => memberList.value, memberSource } : {}),
      now,
    }),
    batch: { scope, scratchDir: scratch, snapshot: snapshotOfficeDatabase },
    ...(memberList ? { memberSource } : {}),
  };
  const door = createOfficeMoveFrontDoor({
    ...(opts.live ? { pull } : {}),
    stateRoot: root,
    ours: () => box,
    preflight,
    turnsInFlight: () => turns.map((t) => ({ ...t })),
    restartPolicy: () => "always",
    memberOsUsers: () => ({ names: [] }),
    ...memberCheck,
    ...(opts.outside ? { outsideFolders: () => opts.outside!.value } : {}),
    listUnits: () => [],
    lockProcess: () => {},
    audit: () => {},
    requestStop: () => {},
    allow: () => true,
    now,
  });
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
      state: state(),
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
    holdPreflight() {
      let release!: () => void;
      preflightHold = new Promise<void>((r) => (release = r));
      return () => {
        preflightHold = null;
        release();
      };
    },
  };
}

// ---- the new office ----

export interface NewOffice {
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

export const ROOMY: MoveInStatfs = { bavail: 1e9, bsize: 4096, ffree: 1e9 };

/** Slice 5b: the disk as checkMoveInFolder reads it, with one change: in a
 *  user namespace that maps only the test's user (an agent shell), "/" and
 *  the temp folder show the overflow uid and gid, which stand for root here.
 *  Outside a namespace no file has them, and this changes nothing. */
const OVERFLOW_ID = (() => {
  try {
    return Number(readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim());
  } catch {
    return 65534;
  }
})();
export function harnessFolderFs(): MoveInFolderFs {
  return {
    lstat(p) {
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        return null;
      }
      const root = (id: number) => (id === OVERFLOW_ID ? 0 : id);
      return {
        isDirectory: () => st.isDirectory(),
        isSymbolicLink: () => st.isSymbolicLink(),
        uid: root(st.uid),
        gid: root(st.gid),
        mode: st.mode,
      };
    },
    readdir: (p) => readdirSync(p),
    writable(p) {
      try {
        accessSync(p, fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function newOffice(
  old: OldOffice,
  over: {
    name?: string;
    fetch?: MoveInDeps["fetch"];
    ours?: () => MoveBoxInfo;
    timing?: Partial<MoveInDeps["timing"]>;
    limits?: Partial<MoveInDeps["limits"]>;
    box?: Partial<MoveInBox>;
    onRestart?: () => void;
    /** Slice 5b seams. */
    outsideRoot?: string;
    folderFs?: MoveInDeps["folderFs"];
    deviceOf?: MoveInDeps["deviceOf"];
    /** Slice 5b: statfs by path (default: statfs.value for every path). */
    statfsOf?: (path: string) => MoveInStatfs;
    /** Slice 5c-2 seams. */
    membersHere?: MoveInDeps["membersHere"];
    enableCommand?: MoveInDeps["enableCommand"];
  } = {},
): NewOffice {
  const home = join(moveInBed.dir, over.name ?? "new", "home");
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
      return over.statfsOf ? over.statfsOf(p) : { ...statfs.value };
    },
    ...(over.outsideRoot !== undefined
      ? { outsideRoot: over.outsideRoot }
      : {}),
    folderFs: over.folderFs ?? harnessFolderFs(),
    ...(over.deviceOf ? { deviceOf: over.deviceOf } : {}),
    ...(over.membersHere ? { membersHere: over.membersHere } : {}),
    ...(over.enableCommand ? { enableCommand: over.enableCommand } : {}),
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
  moveInBed.cleanups.push(() => moveIn.settled());
  return { home, root, moveIn, fresh, statfs, statfsPaths, audits, restarts };
}

export const SEEDED = [
  { name: "Claude Welcome Agent", roomId: "welcome" },
  { name: "Codex Welcome Agent", roomId: "welcome" },
  { name: "Free Welcome Agent", roomId: "welcome" },
  { name: "Receptionist", roomId: "lobby" },
];

export const stageOf = (n: NewOffice) =>
  join(n.home, MOVE_IN_DIR, MOVE_IN_STAGE);
export const paths = (o: OldOffice, p: string) =>
  o.log.filter((c) => c.path === p).length;
export const errCode = (a: { ok: boolean }) =>
  (a as { code?: string }).code ?? null;

/** start -> confirm; returns the preflight id. */
export async function toConfirm(o: OldOffice, n: NewOffice): Promise<string> {
  const a = await n.moveIn.start({ code: o.mint(), by: OWNER });
  if (!a.ok) throw new Error(`start: ${JSON.stringify(a)}`);
  const s = await waitPhase(n.moveIn, ["confirm", "failed"]);
  if (s.phase !== "confirm" || !("preflightId" in s) || !s.preflightId)
    throw new Error(`no confirm: ${JSON.stringify(s)}`);
  return s.preflightId;
}

export async function toEnd(o: OldOffice, n: NewOffice): Promise<MoveInStatus> {
  const preflightId = await toConfirm(o, n);
  const locked = await n.moveIn.lock({ preflightId, by: OWNER });
  if (!locked.ok) throw new Error(`lock: ${JSON.stringify(locked)}`);
  return waitPhase(n.moveIn, [...TERMINAL]);
}

export const REQ_ORIGIN = "https://req.example.com";

export function writeUsers(
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

export const swapFileOf = (n: NewOffice) =>
  join(n.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE);
export const readSwap = (n: NewOffice) =>
  JSON.parse(readFileSync(swapFileOf(n), "utf8")) as MoveInSwapFile;

export const finishAs = (n: NewOffice, acceptMissing = false) =>
  n.moveIn.finish({ acceptMissing, by: OWNER, requestOrigin: REQ_ORIGIN });

export const liveOf = (n: NewOffice) =>
  (n.moveIn.status() as { live?: MoveInLive }).live;

/** The live pass is done and the preflight after it (N3) is ready: the id
 *  the owner's Lock sends. Settled: the same id over two reads. */
export async function liveReady(n: NewOffice): Promise<string> {
  const now = () => {
    const s = n.moveIn.status();
    return s.phase === "confirm" && liveOf(n)?.phase === "ready"
      ? (s as { preflightId: string }).preflightId
      : null;
  };
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    const id = now();
    if (id !== null) {
      await Bun.sleep(100);
      if (now() === id) return id;
    }
    await Bun.sleep(10);
  }
  const s = n.moveIn.status();
  expect([s.phase, liveOf(n)?.phase]).toEqual(["confirm", "ready"]);
  throw new Error("the live pass did not settle");
}
