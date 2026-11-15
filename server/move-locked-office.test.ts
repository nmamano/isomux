// The office while it moves (task 78733adf, slice 1): the MOVE-locked
// server's answers, its boot safety net, and the boot gate of the real entry.
//
// The real entry runs with a PATH whose systemctl and systemd-run are
// recorders: a boot that reaches for the user manager must never touch the
// units of the user who runs the tests.

import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  LOCK_MARKER_FILE,
  LOCKED_HEADER,
  LOCKED_READY_BODY,
  lockMarkerBody,
  type LockdownApps,
} from "./lockdown.ts";
import { Database } from "bun:sqlite";
import {
  markMoveDone,
  markMoveLocked,
  mintMoveCode,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
  MOVE_STATE_FILE,
  parseMoveCode,
  readMoveCancelled,
  readMoveState,
  redeemMoveCode,
  type MoveBoxInfo,
} from "./office-move.ts";
import {
  moveLockedResponse,
  startMoveLockedOffice,
} from "./move-locked-office.ts";
import { MOVE_UNITS_FILE, type AgentUnit } from "./office-move-units.ts";
import {
  createMoveManifestJobs,
  moveItemsHash,
  openMoveStream,
  readMoveRecords,
  type MoveBatchItem,
  type MoveSealContext,
} from "./office-move-pull.ts";
import { createMoveScope } from "./office-move-scope.ts";
import { snapshotOfficeDatabase } from "./sqlite-snapshot.ts";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "isomux-office.ts");
const READY_BUDGET_MS = 20_000;

let dir = "";
let office: Subprocess | null = null;
let handle: { stop(): Promise<void> } | null = null;
afterEach(async () => {
  if (office) {
    office.kill("SIGKILL");
    await office.exited;
  }
  office = null;
  await handle?.stop();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const T0 = new Date("2026-11-15T10:00:00Z");
const BOX: MoveBoxInfo = {
  release: "v2026.11.12",
  commit: "a".repeat(40),
  homePath: "/home/isomux",
};

function stateRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "move-locked-office-"));
  const root = join(dir, "home", ".isomux");
  mkdirSync(root, { recursive: true });
  return root;
}

// A state root in "move", as the lock route leaves it.
function lockedMove(root: string): { code: string; session: string } {
  const { code } = mintMoveCode(root, {
    origin: "https://old.example.com",
    by: "Morgan",
    now: T0,
  });
  const res = redeemMoveCode(root, {
    token: parseMoveCode(code)!.token,
    newBox: BOX,
    ours: BOX,
    now: T0,
  });
  if (!res.ok) throw new Error(JSON.stringify(res));
  markMoveLocked(root, { preflightId: "pf-1", now: T0 });
  return { code, session: res.session };
}

function respond(
  root: string,
  req: Request,
  stops: { n: number },
): Promise<Response> {
  return moveLockedResponse(req, {
    stateRoot: root,
    requestStop: () => {
      stops.n++;
    },
    now: () => new Date(T0.getTime() + 60_000),
  });
}

const url = (path: string) => `https://old.example.com${path}`;

const cancelForm = (html: string) => ({
  form: /<form\b[^>]*\baction="\/api\/move\/cancel"/i.test(html),
  post: /<form\b[^>]*\bmethod="post"/i.test(html),
  codeField: /<(input|textarea)\b[^>]*\bname="code"/i.test(html),
});

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check() && performance.now() < deadline) await Bun.sleep(10);
}

describe("the MOVE-locked server's answers", () => {
  it("/readyz says locked; every other path gets the static 503 MOVE page with the lock header and a cancel form that takes the code", async () => {
    const root = stateRoot();
    lockedMove(root);
    const stops = { n: 0 };
    const ready = await respond(root, new Request(url("/readyz")), stops);
    expect([
      ready.status,
      await ready.text(),
      ready.headers.get(LOCKED_HEADER),
    ]).toEqual([200, LOCKED_READY_BODY, "1"]);
    const head = await respond(
      root,
      new Request(url("/readyz"), { method: "HEAD" }),
      stops,
    );
    expect(head.status).toBe(200);

    for (const path of ["/", "/api/agents", "/api/office/move"]) {
      const res = await respond(root, new Request(url(path)), stops);
      const html = await res.text();
      expect([path, res.status, res.headers.get(LOCKED_HEADER)]).toEqual([
        path,
        503,
        "1",
      ]);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      expect(cancelForm(html)).toEqual({
        form: true,
        post: true,
        codeField: true,
      });
      // Static: nothing to run or load.
      expect(html).not.toMatch(/<script|<link|src=/i);
    }
    expect(stops.n).toBe(0);
  });

  it("the status route answers the move session only", async () => {
    const root = stateRoot();
    const { session } = lockedMove(root);
    const stops = { n: 0 };
    const ok = await respond(
      root,
      new Request(url("/api/move/status"), {
        headers: { Authorization: `Bearer ${session}` },
      }),
      stops,
    );
    expect([ok.status, ((await ok.json()) as { state: string }).state]).toEqual(
      [200, "move"],
    );
    const none = await respond(
      root,
      new Request(url("/api/move/status")),
      stops,
    );
    expect(none.status).toBe(401);
  });

  it("a wrong code does not cancel: 403, the move stays and the process keeps running", async () => {
    const root = stateRoot();
    lockedMove(root);
    const other = mintMoveCode(join(dir, "home"), {
      origin: "https://old.example.com",
      by: "M",
      now: T0,
    }).code;
    const stops = { n: 0 };
    const json = await respond(
      root,
      new Request(url("/api/move/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: other }),
      }),
      stops,
    );
    const form = await respond(
      root,
      new Request(url("/api/move/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "isomux-move-1.wrong" }).toString(),
      }),
      stops,
    );
    expect([json.status, form.status]).toEqual([403, 403]);
    // The page again, so the owner can try once more.
    expect(cancelForm(await form.text()).form).toBe(true);
    expect(readMoveState(root, T0).current?.state).toBe("move");
    expect(readMoveCancelled(root)).toBeNull();
    await Bun.sleep(300);
    expect(stops.n).toBe(0);
  });

  it("a cancel body over 64 KB gets 413 and cancels nothing, even with the right code in it", async () => {
    const root = stateRoot();
    const { code } = lockedMove(root);
    const stops = { n: 0 };
    const res = await respond(
      root,
      new Request(url("/api/move/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, pad: "x".repeat(1024 * 1024) }),
      }),
      stops,
    );
    expect(res.status).toBe(413);
    expect(readMoveState(root, T0).current?.state).toBe("move");
    await Bun.sleep(300);
    expect(stops.n).toBe(0);
  });

  it("the right code cancels, from the page's form or as JSON: the cancel record, no state file, and one stop", async () => {
    for (const kind of ["form", "json"] as const) {
      const root = stateRoot();
      const { code } = lockedMove(root);
      const stops = { n: 0 };
      const req =
        kind === "form"
          ? new Request(url("/api/move/cancel"), {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ code }).toString(),
            })
          : new Request(url("/api/move/cancel"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            });
      const res = await respond(root, req, stops);
      expect([kind, res.status]).toEqual([kind, 200]);
      expect(existsSync(join(root, MOVE_STATE_FILE))).toBe(false);
      expect(readMoveCancelled(root)).not.toBeNull();
      await waitFor(() => stops.n > 0);
      expect(stops.n).toBe(1);
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the MOVE-locked server's boot", () => {
  it("stops the apps and the recorded units again before it answers", async () => {
    const root = stateRoot();
    lockedMove(root);
    const units: AgentUnit[] = [
      {
        name: "tailscaled.service",
        fragmentPath: "/home/isomux/.config/systemd/user/tailscaled.service",
        unitFileState: "enabled",
        activeState: "active",
        transient: false,
      },
    ];
    writeFileSync(join(root, MOVE_UNITS_FILE), JSON.stringify(units));
    const stopped: string[] = [];
    const apps: LockdownApps = {
      list: () => ["board"],
      isActive: () => true,
      stop: (name) => {
        stopped.push(name);
      },
      start: () => {},
    };
    const calls: string[][] = [];
    const port = await freePort();
    handle = await startMoveLockedOffice({
      stateRoot: root,
      port,
      hostname: "127.0.0.1",
      apps,
      runUnits: (argv) => {
        calls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
      requestStop: () => {},
      now: () => T0,
    });
    expect(stopped).toEqual(["board"]);
    const touched = calls.filter((a) => a.includes("tailscaled.service"));
    expect(touched.some((a) => a.includes("disable"))).toBe(true);
    expect(
      touched.some(
        (a) =>
          a.includes("stop") || (a.includes("disable") && a.includes("--now")),
      ),
    ).toBe(true);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([ready.status, await ready.text()]).toEqual([
      200,
      LOCKED_READY_BODY,
    ]);
  });
});

// The real entry, as the unit starts it. systemctl and systemd-run are
// recorders on PATH.
async function bootEntry(root: string): Promise<{
  port: number;
  log: () => string;
  calls: () => string;
}> {
  const home = join(root, "..");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const callLog = join(dir, "systemctl-calls.log");
  for (const name of ["systemctl", "systemd-run"]) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${callLog}'\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const scratch = join(dir, "tmp");
  mkdirSync(scratch);
  const port = await freePort();
  office = Bun.spawn([process.execPath, ENTRY], {
    cwd: REPO,
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      ISOMUX_HOME: root,
      ISOMUX_BACKUP_DIR: join(dir, "backups"),
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: scratch,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(office.stdout as ReadableStream<Uint8Array>);
  void collect(office.stderr as ReadableStream<Uint8Array>);
  const deadline = performance.now() + READY_BUDGET_MS;
  while (performance.now() < deadline && office.exitCode === null) {
    try {
      await fetch(`http://127.0.0.1:${port}/readyz`);
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  return {
    port,
    log: () => output,
    calls: () => (existsSync(callLog) ? readFileSync(callLog, "utf8") : ""),
  };
}

describe("the boot gate of the real entry", () => {
  it('a state root in "move" boots the MOVE-locked server: the cancel page, /readyz locked, no office boot, and it stays up', async () => {
    const root = stateRoot();
    lockedMove(root);
    const o = await bootEntry(root);
    const ready = await fetch(`http://127.0.0.1:${o.port}/readyz`).catch(
      () => null,
    );
    if (!ready) console.error(o.log().slice(-3000));
    expect(ready ? [ready.status, await ready.text()] : null).toEqual([
      200,
      LOCKED_READY_BODY,
    ]);
    const page = await fetch(`http://127.0.0.1:${o.port}/`, {
      redirect: "manual",
    });
    expect([page.status, page.headers.get(LOCKED_HEADER)]).toEqual([503, "1"]);
    expect(cancelForm(await page.text()).form).toBe(true);
    // No office boot ran: a full boot creates the office database.
    expect(existsSync(join(root, "office.sqlite"))).toBe(false);
    expect(readMoveState(root, T0).current?.state).toBe("move");
    await Bun.sleep(500);
    expect(office?.exitCode).toBeNull();
  }, 30_000);

  it("a lock marker wins over a move: the plain locked page, the move state is gone, the units record stays", async () => {
    const root = stateRoot();
    lockedMove(root);
    writeFileSync(join(root, MOVE_UNITS_FILE), "[]");
    writeFileSync(
      join(root, LOCK_MARKER_FILE),
      lockMarkerBody(root, { reason: "intrusion", by: "host", now: T0 }),
    );
    const o = await bootEntry(root);
    const page = await fetch(`http://127.0.0.1:${o.port}/`, {
      redirect: "manual",
    }).catch(() => null);
    if (!page) console.error(o.log().slice(-3000));
    expect(
      page ? [page.status, page.headers.get(LOCKED_HEADER)] : null,
    ).toEqual([503, "1"]);
    // The security lock's page, not the move's: no way to cancel from it.
    expect(cancelForm(await page!.text()).form).toBe(false);
    expect(existsSync(join(root, MOVE_STATE_FILE))).toBe(false);
    expect(existsSync(join(root, MOVE_UNITS_FILE))).toBe(true);
    expect(existsSync(join(root, MOVE_CANCELLED_FILE))).toBe(false);
  }, 30_000);
});

// Slice 2a: the pull, served only here, and MOVED.

// The code key the state file holds; the new office has it from the code.
function keyOf(root: string): Uint8Array {
  const raw = JSON.parse(readFileSync(join(root, MOVE_STATE_FILE), "utf8")) as {
    key: string;
  };
  return Buffer.from(raw.key, "base64url");
}

async function opened(
  root: string,
  res: Response,
  ctx: MoveSealContext,
): Promise<Buffer> {
  expect(res.status).toBe(200);
  const parts: Uint8Array[] = [];
  for await (const c of openMoveStream(
    keyOf(root),
    ctx,
    res.body as unknown as AsyncIterable<Uint8Array>,
  ))
    parts.push(c);
  return Buffer.concat(parts);
}

// The file contents a batch's record stream carries, by path; errors as
// "error".
async function batchFiles(plain: Buffer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let path = "";
  async function* one() {
    yield plain;
  }
  for await (const ev of readMoveRecords(one())) {
    if (ev.type === "entry") {
      path = ev.path;
      out[path] = "";
    } else if (ev.type === "data")
      out[path] += Buffer.from(ev.bytes).toString();
    else if (ev.type === "error") out[ev.path] = "error";
  }
  return out;
}

interface Pull {
  root: string;
  audits: string[];
  stops: { n: number };
  call(
    method: string,
    path: string,
    opts?: { session?: string; body?: unknown; raw?: string },
  ): Promise<Response>;
}

// A home with one member file, and the MOVE-locked server's answers over it
// with the pull wired as production wires it.
function pullOffice(root: string): Pull {
  const home = join(root, "..");
  mkdirSync(join(home, "docs"), { recursive: true });
  writeFileSync(join(home, "docs", "a.txt"), "alpha");
  const scope = createMoveScope({
    home,
    stateRoot: root,
    codeDir: REPO,
    backupDir: join(dir, "backups"),
  });
  const scratch = join(root, "move-pull");
  mkdirSync(scratch, { recursive: true });
  const now = () => new Date(T0.getTime() + 60_000);
  const audits: string[] = [];
  const stops = { n: 0 };
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
  return {
    root,
    audits,
    stops,
    call: (method, path, opts = {}) => {
      const headers: Record<string, string> = {};
      if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
      let body: string | undefined;
      if (opts.raw !== undefined || opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = opts.raw ?? JSON.stringify(opts.body);
      }
      return moveLockedResponse(
        new Request(url(path), { method, headers, body }),
        {
          stateRoot: root,
          requestStop: () => {
            stops.n++;
          },
          now,
          pull,
          audit: ({ operation }) => {
            audits.push(operation);
          },
        },
      );
    },
  };
}

async function readyManifest(p: Pull, session: string): Promise<string> {
  const start = await p.call("POST", "/api/move/manifest", { session });
  expect(start.status).toBe(202);
  const { id } = (await start.json()) as { id: string };
  const deadline = performance.now() + 10_000;
  for (;;) {
    const res = await p.call("GET", `/api/move/manifest/${id}`, { session });
    const s = (await res.json()) as { state: string };
    if (s.state !== "running" || performance.now() > deadline) {
      expect(s.state).toBe("ready");
      return id;
    }
    await Bun.sleep(10);
  }
}

async function errorCode(res: Response): Promise<string> {
  return (
    ((await res.json()) as { error?: { code?: string } }).error?.code ?? ""
  );
}

const DONE_ORIGIN = "https://new.example.com:8443";

describe("the pull", () => {
  it("serves the manifest and the batches sealed to this move; the first batch marks the move served and audits once", async () => {
    const root = stateRoot();
    const { session } = lockedMove(root);
    const p = pullOffice(root);
    const id = await readyManifest(p, session);
    const data = await opened(
      root,
      await p.call("GET", `/api/move/manifest/${id}/data`, { session }),
      { route: "manifest", manifestId: id, batch: 0, itemsHash: "" },
    );
    const paths = data
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { p: string }).p);
    expect(paths).toContain("docs/a.txt");
    expect(p.audits).toEqual([]);

    const items: MoveBatchItem[] = [{ path: "docs/a.txt" }];
    for (const n of [1, 2]) {
      const plain = await opened(
        root,
        await p.call("POST", "/api/move/batch", {
          session,
          body: { manifestId: id, batch: n, items },
        }),
        {
          route: "batch",
          manifestId: id,
          batch: n,
          itemsHash: moveItemsHash(items),
        },
      );
      expect(await batchFiles(plain)).toEqual({ "docs/a.txt": "alpha" });
    }
    expect(p.audits).toEqual(["office.movePulled"]);
    expect(
      (readMoveState(root, T0).current as { servedAt?: number } | null)
        ?.servedAt,
    ).toBe(T0.getTime() + 60_000);
  });

  it("every pull route needs the move session, and a batch body is read only after it", async () => {
    const root = stateRoot();
    const { session } = lockedMove(root);
    const p = pullOffice(root);
    for (const [method, path] of [
      ["POST", "/api/move/manifest"],
      ["GET", "/api/move/manifest/x"],
      ["GET", "/api/move/manifest/x/data"],
      ["POST", "/api/move/batch"],
      ["POST", "/api/move/done"],
    ] as const) {
      const res = await p.call(method, path, { session: "wrong", body: {} });
      expect([path, res.status]).toEqual([path, 401]);
    }
    const big = JSON.stringify({ items: [], pad: "x".repeat(2 * 1024 * 1024) });
    expect((await p.call("POST", "/api/move/batch", { raw: big })).status).toBe(
      401,
    );
    expect(
      (await p.call("POST", "/api/move/batch", { session, raw: big })).status,
    ).toBe(413);
    expect(p.audits).toEqual([]);
  });

  it("done needs a manifest whose data was served and an http(s) URL; it keeps only the origin and audits once", async () => {
    const root = stateRoot();
    const { session } = lockedMove(root);
    const p = pullOffice(root);
    const id = await readyManifest(p, session);
    const done = (body: unknown) =>
      p.call("POST", "/api/move/done", { session, body });

    const early = await done({ manifestId: id, newOrigin: DONE_ORIGIN });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(readMoveState(root, T0).current?.state).toBe("move");

    await (
      await p.call("GET", `/api/move/manifest/${id}/data`, { session })
    ).arrayBuffer();
    for (const newOrigin of [
      "javascript:alert(1)",
      "ftp://new.example.com",
      "new.example.com",
      7,
    ])
      expect([
        newOrigin,
        (await done({ manifestId: id, newOrigin })).status,
      ]).toEqual([newOrigin, 400]);
    expect(
      (await done({ manifestId: "other", newOrigin: DONE_ORIGIN })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(readMoveState(root, T0).current?.state).toBe("move");
    expect(p.audits).toEqual([]);

    const ok = await done({
      manifestId: id,
      newOrigin: `${DONE_ORIGIN}/office?x=1#y`,
    });
    expect(ok.status).toBe(200);
    expect(readMoveState(root, T0).current).toMatchObject({
      state: "moved",
      manifestId: id,
      newOrigin: DONE_ORIGIN,
    });
    expect(p.audits).toEqual(["office.moveDone"]);
  });

  it("outside a locked move the pull answers 409 not_locked: paired, and MOVED", async () => {
    const paired = stateRoot();
    const { code } = mintMoveCode(paired, {
      origin: "https://old.example.com",
      by: "M",
      now: T0,
    });
    const res = redeemMoveCode(paired, {
      token: parseMoveCode(code)!.token,
      newBox: BOX,
      ours: BOX,
      now: T0,
    });
    if (!res.ok) throw new Error(JSON.stringify(res));
    const routes = [
      ["POST", "/api/move/manifest"],
      ["GET", "/api/move/manifest/x"],
      ["GET", "/api/move/manifest/x/data"],
      ["POST", "/api/move/batch"],
      ["POST", "/api/move/done"],
    ] as const;
    const p1 = pullOffice(paired);
    for (const [method, path] of routes) {
      const r = await p1.call(method, path, {
        session: res.session,
        body: { manifestId: "x", batch: 1, items: [], newOrigin: DONE_ORIGIN },
      });
      expect([path, r.status, await errorCode(r)]).toEqual([
        path,
        409,
        "not_locked",
      ]);
    }
    rmSync(dir, { recursive: true, force: true });

    const root = stateRoot();
    const { session } = lockedMove(root);
    markMoveDone(root, { manifestId: "m-1", newOrigin: DONE_ORIGIN, now: T0 });
    const p2 = pullOffice(root);
    for (const [method, path] of routes) {
      const r = await p2.call(method, path, {
        session,
        body: {
          manifestId: "m-1",
          batch: 1,
          items: [{ path: "docs/a.txt" }],
          newOrigin: DONE_ORIGIN,
        },
      });
      expect([path, r.status, await errorCode(r)]).toEqual([
        path,
        409,
        "not_locked",
      ]);
    }
    const status = await p2.call("GET", "/api/move/status", { session });
    expect(((await status.json()) as { state: string }).state).toBe("moved");
    expect(p2.audits).toEqual([]);
  });
});

describe("MOVED", () => {
  function movedRoot(origin = DONE_ORIGIN) {
    const root = stateRoot();
    const locked = lockedMove(root);
    markMoveDone(root, { manifestId: "m-1", newOrigin: origin, now: T0 });
    return { root, ...locked };
  }

  it("the page names the new office's origin as text, never a link, with a cancel form that asks to confirm", async () => {
    const { root } = movedRoot();
    const p = pullOffice(root);
    const res = await p.call("GET", "/");
    const html = await res.text();
    expect(res.headers.get(LOCKED_HEADER)).toBe("1");
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(html).toContain(DONE_ORIGIN);
    expect(html).not.toMatch(/href=["']?https?:/i);
    expect(html).not.toMatch(/<script|<link|src=/i);
    expect(cancelForm(html)).toEqual({
      form: true,
      post: true,
      codeField: true,
    });
    expect(html).toMatch(
      /<input\b[^>]*\btype="checkbox"[^>]*\bname="confirmMoved"|<input\b[^>]*\bname="confirmMoved"[^>]*\btype="checkbox"/i,
    );
  });

  it("escapes an origin the state file holds, whatever it holds", async () => {
    const { root } = movedRoot();
    const path = join(root, MOVE_STATE_FILE);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    raw.newOrigin = 'https://x.example"><script>alert(1)</script>';
    writeFileSync(path, JSON.stringify(raw));
    const html = await (await pullOffice(root).call("GET", "/")).text();
    expect(html).not.toMatch(/<script/i);
  });

  it("the cancel by code from MOVED needs confirmMoved, from the form or as JSON", async () => {
    for (const kind of ["form", "json"] as const) {
      const { root, code } = movedRoot();
      const p = pullOffice(root);
      const html = await (await p.call("GET", "/")).text();
      const value =
        /<input\b[^>]*\bname="confirmMoved"[^>]*>/i
          .exec(html)?.[0]
          .match(/\bvalue="([^"]*)"/)?.[1] ?? "on";
      const send = (confirm: boolean) =>
        moveLockedResponse(
          kind === "form"
            ? new Request(url("/api/move/cancel"), {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams(
                  confirm ? { code, confirmMoved: value } : { code },
                ).toString(),
              })
            : new Request(url("/api/move/cancel"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                  confirm ? { code, confirmMoved: true } : { code },
                ),
              }),
          { stateRoot: root, requestStop: () => p.stops.n++, now: () => T0 },
        );
      const refused = await send(false);
      expect([kind, refused.status]).toEqual([kind, 409]);
      if (kind === "json")
        expect(await errorCode(refused)).toBe("moved_confirm_required");
      expect(readMoveState(root, T0).current?.state).toBe("moved");
      expect(readMoveCancelled(root)).toBeNull();

      const ok = await send(true);
      expect([kind, ok.status]).toEqual([kind, 200]);
      expect(existsSync(join(root, MOVE_STATE_FILE))).toBe(false);
      expect(readMoveCancelled(root)).not.toBeNull();
      await waitFor(() => p.stops.n > 0);
      expect(p.stops.n).toBe(1);
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });
});

describe("the pull through the real entry", () => {
  it("the entry wires the pull and its audit: manifest, batch and done over HTTP, then the MOVED page", async () => {
    const root = stateRoot();
    const { session } = lockedMove(root);
    mkdirSync(join(root, "..", "docs"));
    writeFileSync(join(root, "..", "docs", "a.txt"), "alpha");
    const o = await bootEntry(root);
    const base = `http://127.0.0.1:${o.port}`;
    const auth = { Authorization: `Bearer ${session}` };
    const start = await fetch(`${base}/api/move/manifest`, {
      method: "POST",
      headers: auth,
    });
    if (start.status !== 202) console.error(o.log().slice(-3000));
    expect(start.status).toBe(202);
    const { id } = (await start.json()) as { id: string };
    const deadline = performance.now() + 15_000;
    let state = "running";
    while (state === "running" && performance.now() < deadline) {
      await Bun.sleep(50);
      const s = await fetch(`${base}/api/move/manifest/${id}`, {
        headers: auth,
      });
      state = ((await s.json()) as { state: string }).state;
    }
    expect(state).toBe("ready");
    const data = await opened(
      root,
      await fetch(`${base}/api/move/manifest/${id}/data`, { headers: auth }),
      { route: "manifest", manifestId: id, batch: 0, itemsHash: "" },
    );
    expect(data.toString()).toContain('"docs/a.txt"');

    const items: MoveBatchItem[] = [{ path: "docs/a.txt" }];
    const plain = await opened(
      root,
      await fetch(`${base}/api/move/batch`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId: id, batch: 1, items }),
      }),
      {
        route: "batch",
        manifestId: id,
        batch: 1,
        itemsHash: moveItemsHash(items),
      },
    );
    expect(await batchFiles(plain)).toEqual({ "docs/a.txt": "alpha" });

    const done = await fetch(`${base}/api/move/done`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId: id, newOrigin: DONE_ORIGIN }),
    });
    expect(done.status).toBe(200);
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain(DONE_ORIGIN);

    const db = new Database(join(root, "office.sqlite"), { readonly: true });
    try {
      const ops = (
        db
          .query(
            "SELECT operation FROM audit WHERE operation LIKE 'office.move%' ORDER BY sequence",
          )
          .all() as { operation: string }[]
      ).map((r) => r.operation);
      expect(ops).toEqual(["office.movePulled", "office.moveDone"]);
    } finally {
      db.close();
    }
  }, 45_000);

  it("an unreadable state file with the lock marker boots the MOVE page, where no session works", async () => {
    const root = stateRoot();
    lockedMove(root);
    expect(existsSync(join(root, MOVE_LOCK_MARKER))).toBe(true);
    writeFileSync(join(root, MOVE_STATE_FILE), "{not json");
    const o = await bootEntry(root);
    const page = await fetch(`http://127.0.0.1:${o.port}/`, {
      redirect: "manual",
    }).catch(() => null);
    if (!page) console.error(o.log().slice(-3000));
    expect(
      page ? [page.status, page.headers.get(LOCKED_HEADER)] : null,
    ).toEqual([503, "1"]);
    expect(existsSync(join(root, "office.sqlite"))).toBe(false);
    const status = await fetch(`http://127.0.0.1:${o.port}/api/move/status`, {
      headers: { Authorization: "Bearer anything" },
    });
    expect(status.status).toBe(401);
  }, 30_000);
});
