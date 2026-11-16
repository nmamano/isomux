// The move preflight (task 78733adf, slice 1; SRE items 9, 10, 11): what the
// owner sees before they agree to the lock. du and grep run for real on a temp
// home; a step that must time out is the one fake, so the time limits are
// tested without waiting for them.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMovePreflightJobs,
  PREFLIGHT_MAX_HOST_PATHS,
  sudoPackagesFromAptHistory,
  type MovePreflightDeps,
  type MovePreflightStatus,
  type PreflightExec,
} from "./office-move-preflight.ts";
import type { AgentUnit } from "./office-move-units.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const OLD_HOST = "old.example.com";
const TAILNET_HOST = "old-office.tail1234.ts.net";

// A real child process; `slow` paths answer as timed out without running.
function execWith(slow: string[]): PreflightExec {
  return async (argv, _timeoutMs) => {
    if (argv.some((a) => slow.some((s) => a === s || a.startsWith(`${s}/`))))
      return { code: -1, stdout: "", timedOut: true };
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout, timedOut: false };
  };
}

function write(path: string, content: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

interface Bed {
  home: string;
  deps: MovePreflightDeps;
}

function bed(over: Partial<MovePreflightDeps> = {}): Bed {
  dir = mkdtempSync(join(tmpdir(), "office-move-preflight-"));
  const home = join(dir, "home");
  // Top-level entries of the office user's home, dot entries included.
  write(join(home, "notes.txt"), "x".repeat(1000));
  write(join(home, ".claude", "projects", "a.jsonl"), "y".repeat(3000));
  write(join(home, "media", "video.mp4"), "z");

  // An app whose code names the old host: an OAuth redirect URI and a config.
  const board = join(home, "apps", "board");
  write(
    join(board, "src", "auth.ts"),
    `const cb = "https://${OLD_HOST}/oauth/callback";\n`,
  );
  write(
    join(board, "config.json"),
    `{"origin": "http://${TAILNET_HOST}:4000"}\n`,
  );
  write(join(board, "README.md"), "Nothing to see.\n");
  // Not the app's own code, or too big to be config.
  write(
    join(board, "node_modules", "dep", "index.js"),
    `"https://${OLD_HOST}"`,
  );
  write(join(board, ".git", "config"), `url = https://${OLD_HOST}/repo.git\n`);
  write(
    join(board, "dump.sql"),
    Buffer.concat([
      Buffer.from(`https://${OLD_HOST}\n`),
      Buffer.alloc(1_100_000, 97),
    ]),
  );
  // An app with more matches than the list holds.
  const crowd = join(home, "apps", "crowd");
  for (let i = 0; i < PREFLIGHT_MAX_HOST_PATHS + 5; i++)
    write(
      join(crowd, `page-${i}.html`),
      `<a href="https://${OLD_HOST}/">home</a>\n`,
    );
  const slow = join(home, "apps", "slow");
  write(join(slow, "a.ts"), `"https://${OLD_HOST}"`);

  const apt = join(dir, "history.log");
  write(apt, APT_HISTORY);

  const units: AgentUnit[] = [
    {
      name: "tailscaled.service",
      fragmentPath: join(home, ".config/systemd/user/tailscaled.service"),
      unitFileState: "enabled",
      activeState: "active",
      transient: false,
    },
  ];
  let clock = 1_000;
  const deps: MovePreflightDeps = {
    home,
    hosts: () => [OLD_HOST, TAILNET_HOST],
    apps: () => [
      { name: "board", folder: board },
      { name: "crowd", folder: crowd },
      { name: "slow", folder: slow },
    ],
    turnsInFlight: () => [{ agentId: "a1", name: "Mapper", roomName: "Lab" }],
    listUnits: () => units,
    restartPolicy: () => ({
      unit: "isomux.service",
      manager: "system",
      restart: "always",
    }),
    memberOsUsers: () => ({ names: [] }),
    // media/ is the step that runs out of time; so is the slow app's grep.
    exec: execWith([join(home, "media"), slow]),
    osUser: "isomux",
    aptHistoryPath: apt,
    now: () => (clock += 1_000),
    ...over,
  };
  return { home, deps };
}

async function settle(
  jobs: ReturnType<typeof createMovePreflightJobs>,
  id: string,
  pairing: string,
): Promise<MovePreflightStatus> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const s = jobs.status(id, pairing);
    if (!s) throw new Error("the job is gone");
    if (s.state !== "running" || performance.now() > deadline) return s;
    await Bun.sleep(10);
  }
}

const APT_HISTORY = `
Start-Date: 2026-10-01  10:00:00
Commandline: apt-get install -y jq
Requested-By: isomux (1001)
Install: jq:amd64 (1.6-2.1ubuntu3), libjq1:amd64 (1.6-2.1ubuntu3, automatic), libonig5:amd64 (6.9.7.1-2build1, automatic)
End-Date: 2026-10-01  10:00:05

Start-Date: 2026-10-02  09:00:00
Commandline: apt-get install -y htop
Requested-By: nil (1000)
Install: htop:amd64 (3.0.5-7build2)
End-Date: 2026-10-02  09:00:03

Start-Date: 2026-10-03  06:00:00
Commandline: /usr/bin/unattended-upgrade
Upgrade: openssl:amd64 (3.0.2-0ubuntu1.15, 3.0.2-0ubuntu1.16)
End-Date: 2026-10-03  06:00:20

Start-Date: 2026-10-04  11:00:00
Commandline: apt install ffmpeg tmux
Requested-By: isomux (1001)
Install: ffmpeg:amd64 (7:4.4.2-0ubuntu0.22.04.1), tmux:amd64 (3.2a-4ubuntu0.2)
End-Date: 2026-10-04  11:01:00

Start-Date: 2026-10-05  11:00:00
Commandline: apt install cowsay
Requested-By: isomuxer (1002)
Install: cowsay:all (3.03+dfsg2-8)
End-Date: 2026-10-05  11:00:02
`;

describe("the preflight job", () => {
  it("reports the turns in flight, the units, the restart policy, the home's sizes, the app files that name the old host and the sudo packages, each step with its own time limit", async () => {
    const b = bed();
    const jobs = createMovePreflightJobs(b.deps);
    const started = jobs.start("pairing-1");
    if (!started.ok) throw new Error(JSON.stringify(started));
    const s = await settle(jobs, started.id, "pairing-1");
    if (s.state !== "ready")
      throw new Error(`job ${s.state}: ${JSON.stringify(s)}`);
    const r = s.result;

    expect(r.turnsInFlight).toEqual([
      { agentId: "a1", name: "Mapper", roomName: "Lab" },
    ]);
    expect(r.units).toEqual(b.deps.listUnits());
    expect(r.restart).toEqual({
      unit: "isomux.service",
      manager: "system",
      restart: "always",
    });

    // One entry per top-level entry, dot entries included; a timed-out du
    // has no size and is left out of the total.
    const sizes = Object.fromEntries(r.sizes.entries.map((e) => [e.name, e]));
    expect(Object.keys(sizes).sort()).toEqual([
      ".claude",
      "apps",
      "media",
      "notes.txt",
    ]);
    expect(sizes["notes.txt"]).toEqual({
      name: "notes.txt",
      bytes: 1000,
      timedOut: false,
    });
    expect(sizes.media).toEqual({ name: "media", bytes: null, timedOut: true });
    expect(sizes[".claude"].bytes).toBeGreaterThanOrEqual(3000);
    expect(r.sizes.total).toBe(
      (sizes["notes.txt"].bytes ?? 0) +
        (sizes[".claude"].bytes ?? 0) +
        (sizes.apps.bytes ?? 0),
    );

    // Paths relative to the app folder or absolute: compare by the tail.
    const rel = (app: string, paths: string[]) =>
      paths.map((p) => p.replace(`${join(b.home, "apps", app)}/`, "")).sort();
    const refs = Object.fromEntries(r.hostRefs.map((h) => [h.app, h]));
    expect({
      paths: rel("board", refs.board.paths),
      truncated: refs.board.truncated,
      timedOut: refs.board.timedOut,
    }).toEqual({
      paths: ["config.json", "src/auth.ts"],
      truncated: false,
      timedOut: false,
    });
    expect(refs.crowd.paths).toHaveLength(PREFLIGHT_MAX_HOST_PATHS);
    expect(refs.crowd.truncated).toBe(true);
    expect(refs.slow.timedOut).toBe(true);

    expect(r.sudoPackages).toEqual({ packages: ["ffmpeg", "jq", "tmux"] });
    // Freshness counts from the end of the job, not its start.
    expect(r.finishedAt).toBeGreaterThan(s.startedAt);
  }, 20_000);

  it("an unreadable apt log reads as unknown, not as none", async () => {
    const b = bed();
    const jobs = createMovePreflightJobs({
      ...b.deps,
      aptHistoryPath: join(dir, "missing.log"),
    });
    const started = jobs.start("pairing-1");
    if (!started.ok) throw new Error(JSON.stringify(started));
    const s = await settle(jobs, started.id, "pairing-1");
    expect(s.state === "ready" ? s.result.sudoPackages : s).toEqual({
      unknown: true,
    });
  }, 20_000);

  it("runs one job at a time, shows a job only to its own pairing, and a clear drops every job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const b = bed();
    const real = b.deps.exec;
    const jobs = createMovePreflightJobs({
      ...b.deps,
      exec: async (argv, t) => {
        await gate;
        return real(argv, t);
      },
    });
    const first = jobs.start("pairing-1");
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(jobs.status(first.id, "pairing-1")?.state).toBe("running");
    expect(jobs.start("pairing-1")).toMatchObject({ ok: false, status: 409 });
    expect(jobs.start("pairing-2")).toMatchObject({ ok: false, status: 409 });
    expect(jobs.status(first.id, "pairing-2")).toBeNull();
    expect(jobs.status("no-such-job", "pairing-1")).toBeNull();

    release();
    expect((await settle(jobs, first.id, "pairing-1")).state).toBe("ready");
    // Done: a new job may start.
    const second = jobs.start("pairing-1");
    expect(second.ok).toBe(true);
    jobs.clear();
    expect(jobs.status(first.id, "pairing-1")).toBeNull();
    if (second.ok) expect(jobs.status(second.id, "pairing-1")).toBeNull();
  }, 20_000);
});

describe("the sudo packages", () => {
  it("lists what the office user asked apt for, without the dependencies apt pulled in, other users' installs or upgrades", () => {
    expect(sudoPackagesFromAptHistory(APT_HISTORY, "isomux")).toEqual([
      "ffmpeg",
      "jq",
      "tmux",
    ]);
    expect(sudoPackagesFromAptHistory(APT_HISTORY, "nobody")).toEqual([]);
  });
});
