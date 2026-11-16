// The office's stop ends every Codex App Server it started (task 36e2ae21).
// Each App Server leads its own process group (detached), so a stop that is
// not a systemd unit's (Ctrl-C, another supervisor) signals none of them, and
// a native that outlives its launcher or ignores SIGTERM outlives the office.
//
// The process cases run in a real subprocess: the subprocess gets the stop
// signal and must die by it, which would stop the test runner in-process.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CODEX_KILL_GRACE_MS,
  JsonRpcLiteClient,
  liveCodexClientCount,
  stopAllCodexClients,
} from "./client.ts";
import { groupAlive, killGroup } from "../../test-support/fake-codex-group.ts";

const CLIENT_MODULE = `${import.meta.dir}/client.ts`;
const STOP_MODULE = `${import.meta.dir}/../../server-stop.ts`;

// Far past a green run (about 2.5 s: the grace of a group that ignores
// SIGTERM, plus the subprocess start).
const HANG_MS = 8_000;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (const pgid of startedGroups(dir)) killGroup(pgid);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fake App Server. The launcher (group leader) appends its pid to
 * $FAKE_DIR/all and forks a worker into its group, as the bundled launcher
 * starts the native codex.
 * - ignore: the whole group ignores SIGTERM; only SIGKILL ends it.
 *   The ignore is set before the fork, so the worker has it from its start
 *   (a trap set in the worker races an early SIGTERM).
 * - self-exit: the worker ignores SIGTERM, and the launcher exits at once on
 *   its own, as a launcher that crashed and left its native running.
 * - graceful: the launcher dies at SIGTERM; the worker takes 300 ms to shut
 *   down and then writes $FAKE_DIR/done, as a native that saves its state.
 */
function scratch(): { dir: string; fake: string } {
  const dir = mkdtempSync(join(tmpdir(), "isomux-codex-stop-test-"));
  dirs.push(dir);
  const fake = join(dir, "fake-app-server.sh");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      'echo "$$" >> "$FAKE_DIR/all"',
      'case "$FAKE_MODE" in',
      '  ignore) trap "" TERM; (while :; do sleep 0.05; done) & wait ;;',
      '  self-exit) trap "" TERM; (while :; do sleep 0.05; done) & exit 0 ;;',
      "  graceful)",
      "    (trap 'sleep 0.3; : > \"$FAKE_DIR/done\"; exit 0' TERM",
      "     while :; do sleep 0.05; done) &",
      "    wait ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  return { dir, fake };
}

function startedGroups(dir: string): number[] {
  const file = join(dir, "all");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

async function goneWithin(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

function fakeClient(
  dir: string,
  fake: string,
  mode: "ignore" | "self-exit" | "graceful",
  home: string,
): JsonRpcLiteClient {
  return new JsonRpcLiteClient({
    cwd: dir,
    env: { ...process.env, CODEX_HOME: home, FAKE_DIR: dir, FAKE_MODE: mode },
    codexBin: fake,
    args: [],
    skipSafetyPreflightForTestProbe: true,
  });
}

interface StopRun {
  lines: Record<string, unknown>[];
  signalCode: string | null;
  hung: boolean;
  stderr: string;
}

/**
 * Run `body` in a fresh bun process that has loaded server-stop.ts and
 * client.ts (as the office has), then the process sends itself SIGTERM.
 * `body` gets `client(mode, home)`, which makes a fake client, and `out`.
 */
async function runOffice(dir: string, fake: string, body: string) {
  const code = `
    await import(${JSON.stringify(STOP_MODULE)});
    const codex = await import(${JSON.stringify(CLIENT_MODULE)});
    const out = (value) => console.log(JSON.stringify(value));
    const client = (mode, home) => new codex.JsonRpcLiteClient({
      cwd: ${JSON.stringify(dir)},
      env: { ...process.env, CODEX_HOME: home, FAKE_DIR: ${JSON.stringify(dir)}, FAKE_MODE: mode },
      codexBin: ${JSON.stringify(fake)},
      args: [],
      skipSafetyPreflightForTestProbe: true,
    });
    const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
    ${body}
    setInterval(() => {}, 1000);
    process.kill(process.pid, "SIGTERM");
  `;
  const proc = Bun.spawn(["bun", "-e", code], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    proc.kill("SIGKILL");
  }, HANG_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    lines: stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    hung,
    stderr,
  } satisfies StopRun;
}

describe("the office's stop ends its Codex App Servers", () => {
  async function expectAllGone(run: StopRun, names: string[]): Promise<void> {
    expect(run.lines).toHaveLength(1);
    const { groups, alive } = run.lines[0] as {
      groups: Record<string, number>;
      alive: Record<string, boolean>;
    };
    const all = (value: boolean) =>
      Object.fromEntries(names.map((name) => [name, value]));
    // The case's condition: every group still held a process at the signal.
    expect(alive).toEqual(all(true));
    expect({
      signalCode: run.signalCode,
      hung: run.hung,
      stderr: run.signalCode === null ? run.stderr : "",
    }).toEqual({ signalCode: "SIGTERM", hung: false, stderr: "" });
    const gone: Record<string, boolean> = {};
    for (const [name, pgid] of Object.entries(groups))
      gone[name] = await goneWithin(pgid, 1_000);
    expect(gone).toEqual(all(true));
  }

  const REPORT = `
    await new Promise((resolve) => setTimeout(resolve, 150));
    out({ groups, alive: Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, alive(g)])) });
  `;

  test("a live and a crashed-launcher group are gone after a SIGTERM", async () => {
    const { dir, fake } = scratch();
    const run = await runOffice(
      dir,
      fake,
      `
      const live = client("ignore", ${JSON.stringify(join(dir, "home-live"))});
      await live.start();
      // Its launcher exits on its own and leaves its worker in the group.
      const exited = client("self-exit", ${JSON.stringify(join(dir, "home-exited"))});
      const launcherExit = new Promise((resolve) => exited.onExit(() => resolve()));
      await exited.start();
      await launcherExit;
      const groups = { live: live.pid(), exited: exited.pid() };
      ${REPORT}`,
    );
    await expectAllGone(run, ["live", "exited"]);
  }, 15_000);

  test("a group in close()'s grace at the signal is gone after a SIGTERM", async () => {
    // Alone, so no other group's grace keeps the office alive until this
    // one's SIGKILL: an end that is not waited for dies with the office.
    const { dir, fake } = scratch();
    const run = await runOffice(
      dir,
      fake,
      `
      const closing = client("ignore", ${JSON.stringify(join(dir, "home-closing"))});
      await closing.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      void closing.close();
      const groups = { closing: closing.pid() };
      ${REPORT}`,
    );
    await expectAllGone(run, ["closing"]);
  }, 15_000);

  test("a start that waits at the launch gate when the signal comes never spawns", async () => {
    const { dir, fake } = scratch();
    const home = join(dir, "home");
    const run = await runOffice(
      dir,
      fake,
      `
      // The second launch on a cold home waits for the first one's
      // initialize answer, which the fake never sends: it goes on when the
      // first group exits at the stop.
      codex.setCodexLaunchGateWaitMsForTests(30_000);
      const first = client("graceful", ${JSON.stringify(home)});
      await first.start();
      const second = client("graceful", ${JSON.stringify(home)});
      void second.start().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      out({ first: first.pid(), secondSpawned: second.pid() !== undefined });
      `,
    );
    const { first, secondSpawned } = run.lines[0] as {
      first: number;
      secondSpawned: boolean;
    };
    // The case's condition: the second start was still waiting at the gate.
    expect(secondSpawned).toBe(false);
    expect(run.signalCode).toBe("SIGTERM");
    expect(await goneWithin(first, 1_000)).toBe(true);
    // A launch that slipped past the stop would show up here: the fake writes
    // its pid at its first line, and nothing ends it after the office died.
    await Bun.sleep(300);
    expect(startedGroups(dir)).toEqual([first]);
  }, 15_000);
});

describe("stopAllCodexClients", () => {
  test("waits for a group to finish its own SIGTERM shutdown, not only for the launcher", async () => {
    const { dir, fake } = scratch();
    const client = fakeClient(dir, fake, "graceful", join(dir, "home"));
    await client.start();
    const pgid = client.pid()!;
    await Bun.sleep(150);
    expect(groupAlive(pgid)).toBe(true);

    const started = Date.now();
    await stopAllCodexClients();

    // The launcher dies at once; a SIGKILL then would cut the worker's
    // 300 ms shutdown before it writes `done`.
    expect(existsSync(join(dir, "done"))).toBe(true);
    expect(groupAlive(pgid)).toBe(false);
    // Returned when the group emptied, not at the end of the grace.
    expect(Date.now() - started).toBeLessThan(CODEX_KILL_GRACE_MS);
  }, 10_000);

  test("ends every live group at once, SIGKILL after the grace, and empties the registry", async () => {
    const { dir, fake } = scratch();
    const before = liveCodexClientCount();
    const clients = [
      fakeClient(dir, fake, "ignore", join(dir, "home-a")),
      fakeClient(dir, fake, "ignore", join(dir, "home-b")),
    ];
    for (const client of clients) await client.start();
    const groups = clients.map((client) => client.pid()!);
    await Bun.sleep(150);
    expect(groups.map(groupAlive)).toEqual([true, true]);
    expect(liveCodexClientCount()).toBe(before + 2);

    const started = Date.now();
    await stopAllCodexClients();
    const took = Date.now() - started;

    expect(groups.map(groupAlive)).toEqual([false, false]);
    expect(liveCodexClientCount()).toBe(0);
    // One grace for all groups, not one per group: a stop must not grow
    // with the number of Codex agents.
    expect(took).toBeLessThan(CODEX_KILL_GRACE_MS + 1_000);
  }, 10_000);

  test("a launcher that exits on its own leaves no group behind while the office runs", async () => {
    const { dir, fake } = scratch();
    const client = fakeClient(dir, fake, "self-exit", join(dir, "home"));
    const launcherExit = new Promise<void>((resolve) =>
      client.onExit(() => resolve()),
    );
    await client.start();
    await launcherExit;
    const pgid = client.pid()!;
    await Bun.sleep(100);
    // The case's condition: the worker outlived its launcher.
    expect(groupAlive(pgid)).toBe(true);

    // No close() and no stop: the client ends the group itself.
    expect(await goneWithin(pgid, CODEX_KILL_GRACE_MS + 1_000)).toBe(true);
  }, 10_000);
});
