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
import {
  markMoveLocked,
  mintMoveCode,
  MOVE_CANCELLED_FILE,
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
