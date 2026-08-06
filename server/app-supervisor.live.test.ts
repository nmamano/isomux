// The ONE test that drives real systemd. Gated behind ISOMUX_TEST_SYSTEMD=1
// (`bun run test:systemd`), so `bun test` never runs it.
//
// Why a separate gate from ISOMUX_TEST_LIVE: that flag means "spend real model
// credits", and this test spends none. Conflating them would make a systemd
// check cost money and an LLM check create unit files, and someone would then
// stop running whichever half they were not after.
//
// Why it exists at all: everything under it is a claim about a program isomux
// does not control - unit-file syntax systemd accepts, whether $PORT actually
// reaches the process, whether Restart=on-failure counts what we read as
// restartCount. A fake can only prove we send the strings we meant to send.
//
// CLEANUP IS THE SAFETY PROPERTY. Units are machine-global, so this file uses
// its own `isomux-app-test-live-<pid>-` prefix - which cannot collide with the
// production `isomux-app-<name>` namespace - and tears every unit down in a
// finally + afterAll, so a failing assertion never leaves a service behind.

import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bindProbe, APP_PORT_MIN, APP_PORT_MAX } from "./app-registry.ts";
import {
  createAppSupervisor,
  createSystemdHost,
  type AppSupervisor,
} from "./app-supervisor.ts";
import {
  cleanupFailure,
  cleanupLiveTestUnit,
} from "./test-support/live-unit-cleanup.ts";
import type { AppRecord } from "../shared/types.ts";

const LIVE = process.env.ISOMUX_TEST_SYSTEMD === "1";
const suite = LIVE ? describe : describe.skip;

// Distinct per process, and structurally incapable of being a production unit
// name: the `.` cannot appear in an app name, so nothing the registry can
// produce renders into this namespace (the same rule unitPrefixFor uses).
const UNIT_PREFIX = `isomux-app-test-.live-${process.pid}-`;
const APP_NAME = "probe";

const tmpRoot = LIVE
  ? mkdtempSync(join(tmpdir(), "isomux-app-live-"))
  : join(tmpdir(), "unused");

let supervisor: AppSupervisor | null = null;

// Runs whatever happened above it, because the cleanup must not depend on the
// test body reaching its own teardown call - an assertion that fails partway
// through skips everything after it.
//
// And it ASSERTS rather than hoping. A swallowed cleanup failure is the worst
// outcome available here: the suite goes green while a real service is left
// running on the machine, which is the exact thing the isolation rail exists to
// prevent. So a residue check that fails must fail the run and say what is
// still there.
afterAll(() => {
  if (!LIVE) return;
  const host = createSystemdHost();
  const unit = `${UNIT_PREFIX}${APP_NAME}.service`;
  // The janitor is deliberately NOT supervisor.teardown(): teardown is strict
  // by design and refuses to remove anything it cannot prove is stopped, which
  // is right for a delete and wrong for a cleanup whose only job is that
  // nothing survives. It lives in test-support and is unit-tested against a
  // fake host (live-unit-cleanup.test.ts), because it only ever RUNS on a box
  // with real systemd and would otherwise be the least-tested code here while
  // carrying the highest consequence.
  const outcome = cleanupLiveTestUnit(
    host,
    {
      unit,
      unitFile: join(host.unitDir, unit),
      enableSymlink: join(host.unitDir, "default.target.wants", unit),
      launcher: join(tmpRoot, "units 50%", `${APP_NAME}.sh`),
      unitGlob: `${UNIT_PREFIX}*`,
    },
    { exists: existsSync, lexists: lstatSafe },
  );
  // Only after the launcher has been inspected.
  rmSync(tmpRoot, { recursive: true, force: true });
  const failure = cleanupFailure(outcome);
  if (failure) throw failure;
});

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  budgetMs: number,
  probe: () => T | Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (done(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}; last saw ${JSON.stringify(last)}`,
      );
    }
    await sleep(250);
  }
}

suite("app-supervisor against real systemd", () => {
  it("installs, serves on the injected port, survives a kill, takes an updated command, and cleans up", async () => {
    const host = createSystemdHost();
    // The launcher lives in the temp root, not the real state dir - the only
    // thing this test writes outside its own directory is the unit file, and
    // that is the thing under test.
    const launcherDir = join(tmpRoot, "units 50%");
    supervisor = createAppSupervisor({
      host: { ...host, launcherDir },
      unitPrefix: UNIT_PREFIX,
    });

    // A real free port from the app window, probed the way the registry does.
    let port = 0;
    for (let p = APP_PORT_MAX; p >= APP_PORT_MIN; p--) {
      if (bindProbe(p)) {
        port = p;
        break;
      }
    }
    expect(port).toBeGreaterThan(0);

    // A space AND a percent sign, deliberately: `%` is a systemd specifier
    // and a space is what quoting exists for, and the two directives that
    // carry these paths are escaped by DIFFERENT rules (WorkingDirectory is
    // not quote-parsed, Environment and ExecStart are). Asserting our
    // renderer's output only proves we wrote what we meant to write; putting
    // the awkward characters through a real systemd is what proves the rules
    // are right.
    const cwd = join(tmpRoot, "app dir 100%");
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "server.js"),
      // Reads PORT from the environment - never a literal - so a unit that
      // failed to inject it cannot pass this test.
      `Bun.serve({\n` +
        `  port: Number(process.env.PORT),\n` +
        `  fetch: () => new Response(process.env.ISOMUX_APP_DATA_DIR ?? "no-data-dir"),\n` +
        `});\n` +
        `console.log("probe listening on " + process.env.PORT);\n`,
    );

    const dataDir = join(tmpRoot, "data 25%");
    mkdirSync(dataDir, { recursive: true });
    const app: AppRecord = {
      name: APP_NAME,
      port,
      command: "bun server.js",
      cwd,
      dataDir,
      userId: "u-live",
      username: "live",
      createdBy: "app-supervisor.live.test",
      createdAt: Date.now(),
    };

    try {
      supervisor.install(app);

      // 1. It actually serves, on the port isomux chose, with the data dir
      //    isomux handed it. `bun` resolving at all is the PATH story working.
      const body = await until(
        "the app to answer on its allocated port",
        20_000,
        async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            return await res.text();
          } catch {
            return null;
          }
        },
        (text) => text !== null,
      );
      expect(body).toBe(dataDir);
      expect(supervisor.states([APP_NAME]).get(APP_NAME)).toEqual({
        state: "running",
        restartCount: 0,
      });

      // 2. Killed, it comes back, and the restart is COUNTED - which is what
      //    the Apps tab will show as a crash loop.
      const mainPid = Number(
        host
          .run([
            "systemctl",
            "--user",
            "show",
            supervisor.unitName(APP_NAME),
            "--property=MainPID",
            "--value",
          ])
          .stdout.trim(),
      );
      expect(mainPid).toBeGreaterThan(0);
      process.kill(mainPid, "SIGKILL");
      const after = await until(
        "systemd to restart the app and count it",
        30_000,
        () => supervisor!.states([APP_NAME]).get(APP_NAME)!,
        (runtime) => runtime.restartCount >= 1,
      );
      expect(after.restartCount).toBeGreaterThanOrEqual(1);

      // 3. Its own stdout is reachable as logs.
      const logs = await until(
        "the app's own output to reach journald",
        15_000,
        () => supervisor!.logs(APP_NAME, 50),
        (lines) => lines.some((l) => l.includes("probe listening on")),
      );
      expect(logs.join("\n")).toContain(String(port));

      // 4. Its command is CHANGED, and the running app comes back on the new
      //    one. Everything a fake can prove about reinstall stops at "we sent
      //    the right strings": whether systemd actually picks up a rewritten
      //    unit after a daemon-reload, and whether the restart lands on the new
      //    launcher rather than the cached old one, is a claim about systemd.
      writeFileSync(
        join(cwd, "server2.js"),
        `Bun.serve({\n` +
          `  port: Number(process.env.PORT),\n` +
          `  fetch: () => new Response("updated"),\n` +
          `});\n`,
      );
      supervisor.reinstall({ ...app, command: "bun server2.js" });
      const updated = await until(
        "the app to answer with its NEW command's response",
        20_000,
        async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            return await res.text();
          } catch {
            return null;
          }
        },
        (text) => text === "updated",
      );
      expect(updated).toBe("updated");
      expect(supervisor.states([APP_NAME]).get(APP_NAME)?.state).toBe(
        "running",
      );

      // 5. And a stopped app is NOT started by a reinstall. The API's whole
      //    promise here is that PATCH preserves activation intent, and this is
      //    the half that would be silent if it broke: an app the user stopped
      //    coming back to life on an unrelated edit.
      supervisor.stop(APP_NAME);
      await until(
        "the app to come to rest",
        15_000,
        () => supervisor!.states([APP_NAME]).get(APP_NAME)!.state,
        (state) => state === "stopped",
      );
      supervisor.reinstall({ ...app, command: "bun server.js" });
      // Given a moment to be wrong in: a restart triggered by mistake would
      // have systemd report `activating` or `active` well inside this window.
      await sleep(2000);
      expect(supervisor.states([APP_NAME]).get(APP_NAME)?.state).toBe(
        "stopped",
      );
    } finally {
      supervisor.teardown(APP_NAME);
    }

    // 6. Nothing is left: no unit file, no launcher, and systemd has
    //    forgotten the unit entirely.
    expect(
      existsSync(join(host.unitDir, `${UNIT_PREFIX}${APP_NAME}.service`)),
    ).toBe(false);
    expect(existsSync(join(launcherDir, `${APP_NAME}.sh`))).toBe(false);
    expect(supervisor.states([APP_NAME]).get(APP_NAME)?.state).toBe("unknown");
    const listed = host.run([
      "systemctl",
      "--user",
      "list-units",
      "--all",
      "--no-legend",
      `${UNIT_PREFIX}*`,
    ]);
    expect(listed.stdout.trim()).toBe("");
    // The enable symlink is a separate artifact from the unit file, and a
    // leftover one makes systemd complain about a missing unit on every
    // subsequent daemon-reload.
    expect(
      existsSync(
        join(
          host.unitDir,
          "default.target.wants",
          `${UNIT_PREFIX}${APP_NAME}.service`,
        ),
      ),
    ).toBe(false);
    const files = host.run([
      "systemctl",
      "--user",
      "list-unit-files",
      "--no-legend",
      `${UNIT_PREFIX}*`,
    ]);
    expect(files.stdout.trim()).toBe("");
  }, 120_000);
});
