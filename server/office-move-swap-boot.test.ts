// The swap of a move-in through the real entry, as the unit starts it (task
// 78733adf, slice 2c-1, design round D5, D6, D8). systemctl and systemd-run
// are recorders on PATH.
//
// - The swap runs before any state module reads the disk: after the boot the
//   office serves the OLD office's members, and the fresh owner's browser
//   session (sessions.json is kept) works as an owner on them.
// - The first normal boot puts the units back after a daemon-reload, fills
//   the report and audits the swap.
// - A swap that fails boots the swap-failed server: no normal boot, swap.json
//   stays, and its retry ends the process.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MOVE_IN_DIR, MOVE_IN_STATE_FILE } from "./office-move.ts";
import { MOVE_IN_STAGE } from "./office-move-stage.ts";
import {
  MOVE_IN_SWAP_FILE,
  runMoveInSwapAtBoot,
  writeMoveInSwapFile,
  type MoveInSwapFile,
  type MoveInSwapInputs,
} from "./office-move-swap.ts";
import { SWAP_RETRY_PATH } from "./move-swap-failed-office.ts";
import { exclusiveTestPort } from "./test-support/test-port.ts";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "isomux-office.ts");
const READY_BUDGET_MS = 20_000;
const OFFICE_ID = "aaaaaaaaaaaa";
const TOKEN = "fresh-owner-browser-token-0123456789abcdef";
const COOKIE = `isomux_session_${OFFICE_ID}=${TOKEN}`;

let dir = "";
let office: Subprocess | null = null;
afterEach(async () => {
  if (office && office.exitCode === null) {
    office.kill("SIGKILL");
    await office.exited;
  }
  office = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function put(root: string, rel: string, data: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), data);
}

interface Boot {
  port: number;
  log: () => string;
  calls: () => string;
  get(path: string): Promise<Response | null>;
}

async function bootEntry(home: string): Promise<Boot> {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const callLog = join(dir, "systemctl-calls.log");
  for (const name of ["systemctl", "systemd-run"]) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${callLog}'\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const scratch = join(dir, "tmp");
  mkdirSync(scratch, { recursive: true });
  const port = exclusiveTestPort();
  office = Bun.spawn([process.execPath, ENTRY], {
    cwd: REPO,
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      ISOMUX_HOME: join(home, ".isomux"),
      // The swap deletes the fresh office's backups: never the live ones.
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
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200)
        break;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50);
  }
  return {
    port,
    log: () => output,
    calls: () => (existsSync(callLog) ? readFileSync(callLog, "utf8") : ""),
    get: (path) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { cookie: COOKIE },
        redirect: "manual",
      }).catch(() => null),
  };
}

async function stop(): Promise<void> {
  if (!office) return;
  office.kill("SIGTERM");
  await office.exited;
  office = null;
}

/** A fresh office's home: its one owner, signed in in a browser. */
function freshHome(): string {
  dir = mkdtempSync(join(tmpdir(), "move-swap-boot-"));
  const home = join(dir, "home");
  const now = Date.now();
  put(home, ".isomux/office-id", `${OFFICE_ID}\n`);
  put(
    home,
    ".isomux/users.json",
    JSON.stringify({
      "u-fresh": {
        id: "u-fresh",
        name: "Morgan",
        role: "owner",
        createdAt: now,
      },
    }),
  );
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  put(
    home,
    ".isomux/sessions.json",
    JSON.stringify({
      [hash]: {
        sessionIdHash: hash,
        sessionPrefix: TOKEN.slice(0, 8),
        userId: "u-fresh",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 86_400_000,
        absoluteExpiresAt: now + 86_400_000,
        userAgent: null,
      },
    }),
  );
  return home;
}

/** The old office's stage and swap.json, as finish leaves them. */
function pendingSwap(home: string): MoveInSwapInputs {
  const stage = join(home, MOVE_IN_DIR, MOVE_IN_STAGE);
  put(
    stage,
    ".isomux/users.json",
    JSON.stringify({
      "u-old1": { id: "u-old1", name: "Riley", role: "owner", createdAt: 1 },
      "u-old2": { id: "u-old2", name: "Sam", role: "member", createdAt: 2 },
    }),
  );
  put(
    stage,
    ".isomux/office-config.json",
    JSON.stringify({ name: "Old office" }),
  );
  put(
    stage,
    ".config/systemd/user/tunnel.service",
    "[Service]\nExecStart=/bin/true\n",
  );
  put(stage, "docs/a.txt", "old-docs");
  put(
    home,
    `.isomux/${MOVE_IN_STATE_FILE}`,
    JSON.stringify({ phase: "swapping" }),
  );
  const root = join(home, ".isomux");
  const box = {
    release: "v2026.11.12",
    commit: "a".repeat(40),
    homePath: home,
    stateRoot: root,
    officeUnit: null,
  };
  const inputs: MoveInSwapInputs = {
    version: 1,
    home,
    stateRoot: root,
    codeDir: REPO,
    backupDir: join(dir, "backups"),
    newOfficeUnit: null,
    oldOfficeUnit: null,
    ownerId: "u-fresh",
    units: [
      {
        name: "tunnel.service",
        fragmentPath: join(home, ".config/systemd/user/tunnel.service"),
        unitFileState: "enabled",
        activeState: "active",
        transient: false,
      },
    ],
    report: {
      oldOrigin: "https://old.example.com",
      office: box,
      finishedAt: Date.now(),
      by: { kind: "member", id: "u-fresh", name: "Morgan" },
      excluded: [],
      secretCount: 0,
      missing: [],
    },
  };
  writeMoveInSwapFile(home, { inputs, ops: null });
  return inputs;
}

async function json(
  res: Response | null,
): Promise<Record<string, unknown> | null> {
  if (!res || res.status !== 200) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("the swap through the real entry", () => {
  it("boots the old office: the fresh owner's browser stays signed in as an owner, the old members are there, the units come back after a daemon-reload, and the report is filled", async () => {
    const home = freshHome();
    // The control: the fresh office, with its owner's browser session.
    let o = await bootEntry(home);
    const before = await o.get("/api/office/move-in");
    if (before?.status !== 200) console.error(o.log().slice(-3000));
    expect(before?.status).toBe(200);
    expect((await o.get("/api/users/Sam/instructions"))?.status).not.toBe(200);
    await stop();

    pendingSwap(home);
    // Only the swap boot's systemctl calls.
    rmSync(join(dir, "systemctl-calls.log"), { force: true });
    o = await bootEntry(home);
    const res = await o.get("/api/office/move-in");
    const status = await json(res);
    if (!status) console.error(res?.status, o.log().slice(-3000));
    expect(status?.phase).toBe("moved");
    // The fresh owner's session reads an old member: the old users.json is
    // the one in memory, with the kept owner in it.
    expect((await o.get("/api/users/Sam/instructions"))?.status).toBe(200);
    expect(existsSync(join(home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(false);
    expect(readFileSync(join(home, "docs/a.txt"), "utf8")).toBe("old-docs");

    // The first normal boot: the units back, the report filled, audited once.
    const report = status?.report as {
      units: { restored: string[] } | null;
      audited: boolean;
    };
    expect(report.units?.restored).toContain("tunnel.service");
    expect(report.audited).toBe(true);
    const calls = o.calls().split("\n");
    const reload = calls.findIndex((l) =>
      /systemctl .*--user.* daemon-reload/.test(l),
    );
    const enable = calls.findIndex((l) =>
      /systemctl .*enable.*tunnel\.service/.test(l),
    );
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(reload);
  }, 60_000);

  it("D8: the first boot writes the old office's app units again for this machine", async () => {
    const home = freshHome();
    let o = await bootEntry(home);
    // An app of the office, registered as an owner does it.
    const reg = await fetch(`http://localhost:${o.port}/api/apps`, {
      method: "POST",
      headers: {
        cookie: COOKIE,
        origin: `http://localhost:${o.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "board",
        command: "bun run serve.ts",
        cwd: home,
      }),
    }).catch(() => null);
    if (reg?.status !== 201)
      console.error(reg?.status, await reg?.text(), o.log().slice(-3000));
    expect(reg?.status).toBe(201);
    await stop();
    const unitDir = join(home, ".config/systemd/user");
    const appUnit = readdirSync(unitDir).find((n) =>
      n.endsWith("board.service"),
    );
    expect(appUnit).toBeDefined();
    const realUnit = readFileSync(join(unitDir, appUnit!), "utf8");
    const pathLine = realUnit
      .split("\n")
      .find((l) => l.startsWith('Environment="PATH='));
    expect(pathLine).toBeDefined();

    pendingSwap(home);
    // The old office had the same app; its unit names the old machine's PATH.
    // The token, secrets and address lines are right, so only the move-in's
    // pass writes it again.
    const stage = join(home, MOVE_IN_DIR, MOVE_IN_STAGE);
    cpSync(join(home, ".isomux/apps"), join(stage, ".isomux/apps"), {
      recursive: true,
    });
    put(
      stage,
      `.config/systemd/user/${appUnit}`,
      realUnit.replace(pathLine!, 'Environment="PATH=/old-box/bin"'),
    );
    o = await bootEntry(home);
    const status = await json(await o.get("/api/office/move-in"));
    if (!status) console.error(o.log().slice(-3000));
    expect(status?.phase).toBe("moved");
    const unitNow = readFileSync(join(unitDir, appUnit!), "utf8");
    expect(unitNow).not.toContain("/old-box/bin");
    expect(unitNow.split("\n")).toContain(pathLine!);
  }, 60_000);

  it("a swap that fails boots the swap-failed server: no normal boot, swap.json stays, and the retry ends the process", async () => {
    const home = freshHome();
    const inputs = pendingSwap(home);
    // Crash at the first op, after the ops are stored; then a home entry
    // appears where a stored `in` goes.
    const CRASH = new Error("crash");
    expect(() =>
      runMoveInSwapAtBoot({
        home,
        now: () => new Date(),
        onStep: () => {
          const stored = JSON.parse(
            readFileSync(join(home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE), "utf8"),
          ) as MoveInSwapFile;
          if (stored.ops !== null) throw CRASH;
        },
      }),
    ).toThrow(CRASH);
    put(home, "docs/other.txt", "in the way");
    const usersBefore = readFileSync(
      join(inputs.stateRoot, "users.json"),
      "utf8",
    );

    const o = await bootEntry(home);
    const ready = await fetch(`http://127.0.0.1:${o.port}/readyz`).catch(
      () => null,
    );
    if (!ready) console.error(o.log().slice(-3000));
    expect(ready?.status).toBe(200);
    const page = await o.get("/");
    expect(page?.status).toBeGreaterThanOrEqual(500);
    expect(await page?.text()).toContain("docs");
    // No normal boot: the office routes do not answer, and the fresh state
    // root was not written.
    expect(await json(await o.get("/api/office/move-in"))).toBeNull();
    expect(readFileSync(join(inputs.stateRoot, "users.json"), "utf8")).toBe(
      usersBefore,
    );
    expect(existsSync(join(home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(true);
    await Bun.sleep(300);
    expect(office?.exitCode).toBeNull();

    const retry = await fetch(`http://127.0.0.1:${o.port}${SWAP_RETRY_PATH}`, {
      method: "POST",
      redirect: "manual",
    }).catch(() => null);
    expect(retry !== null && retry.status < 400).toBe(true);
    const exited = await Promise.race([
      office!.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    expect(exited).toBe(true);
  }, 60_000);
});
