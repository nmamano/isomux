// scripts/update.sh - the customer-box updater, driven end-to-end in a
// sandbox: temp git repos (a bare "origin" and an installed checkout), a
// PATH-stubbed systemctl (records calls, keeps a fake active/inactive state,
// and can mutate the state root on start to simulate a migration), a stub
// bun (fails on demand via BREAK_INSTALL/BREAK_BUILD files committed in the
// target release), a temp state root, and a real loopback readiness server
// whose 200 is gated on a flag file the systemctl stub creates after the
// Nth start. No real systemd, no real bun installs, nothing outside the
// fixture dir. Zero LLM.
//
// The failure-path coverage here is the point of the design's explicit
// recovery ladders (internal-docs/release-design.md): failed install, failed
// build, failed readiness rolled back to the old code. The stubs also record
// the published progress file at each call, which is how the phase events
// are observed.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from "bun:test";

// Failure-path tests wait out real readiness timeouts (a few seconds each).
setDefaultTimeout(60_000);
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  chmodSync,
  readdirSync,
  statSync,
  renameSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const UPDATE_SH = new URL("./update.sh", import.meta.url).pathname;

interface Fixture {
  base: string;
  repo: string;
  stateRoot: string;
  snapshotDir: string;
  statusDir: string;
  stubLog: string;
  progressLog: string;
  readyFlag: string;
  conf: string;
  port: number;
  oldCommit: string;
  newCommit: string;
  env: Record<string, string>;
}

let fx: Fixture;
let readyServer: ReturnType<typeof Bun.serve> | null = null;

// Mitigation: avoid a synchronous child-exit wait on the main thread.
// Bun 1.3.11 timed out a live sleep with BOTH helpers on 2026-09-10:
// /tmp/ci-hang/rev/m-h-async.log and /tmp/ci-hang/rev/m-h-sync.log.
// The sync control unblocked after SIGTERM; it did not reproduce the
// exited-child spin. The async form is not a fix for a Bun reaping bug.
async function sh(cwd: string, cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd}\n${err}`);
  return out.trim();
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

// Build: origin bare repo with commit c1 (current install) and commit c2
// tagged as a release; the installed checkout sits detached at c1 with the
// release tag known only to origin (fetch must bring it).
async function buildFixture(opts: {
  tag?: string;
  newFiles?: Record<string, string>;
  readyAfterStarts?: number;
  failStarts?: number;
  mutateStateOnStart?: boolean;
  stopStaysActive?: boolean;
  caddyActive?: boolean;
  caddyUnitPresent?: boolean;
  /** /readyz answers 503 this many times after the office is up. */
  lateReadyPolls?: number;
}): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "isomux-update-test-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  await sh(repo, "git init -q -b main");
  await sh(repo, "git config user.email t@t && git config user.name T");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fake", packageManager: "bun@1.3.11" }),
  );
  writeFileSync(join(repo, "app.txt"), "old\n");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "update.sh"), "# fake updater v-old\n");
  await sh(repo, "git add . && git commit -qm c1");
  const oldCommit = await sh(repo, "git rev-parse HEAD");

  const origin = join(base, "origin.git");
  await sh(base, "git clone -q --bare repo origin.git");
  await sh(repo, `git remote add origin ${origin}`);

  writeFileSync(join(repo, "app.txt"), "new\n");
  writeFileSync(join(repo, "scripts", "update.sh"), "# fake updater v-new\n");
  // @BASE@ in a file stands for the fixture directory, for a fake target
  // installer the updater runs with `env -i` (it inherits no paths).
  for (const [name, content] of Object.entries(opts.newFiles ?? {})) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content.replaceAll("@BASE@", base));
  }
  await sh(repo, "git add . && git commit -qm c2");
  const newCommit = await sh(repo, "git rev-parse HEAD");
  const tag = opts.tag ?? "v2026.7.20";
  await sh(repo, `git tag -a ${tag} -m "${tag}"`);
  await sh(repo, "git push -q origin main --tags");
  await sh(repo, `git checkout -q --detach ${oldCommit}`);
  await sh(repo, `git tag -d ${tag}`);

  const stateRoot = join(base, "state", ".isomux");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, "users.json"), '{"u1":{"name":"Morgan"}}\n');
  const profile = join(
    stateRoot,
    "opencode",
    "profiles",
    "shared",
    "data",
    "opencode",
  );
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "auth.json"), "PROFILE_AUTH_CANARY_BEFORE\n", {
    mode: 0o600,
  });

  const snapshotDir = join(base, "snapshots");
  const statusDir = join(base, "status");
  const stubLog = join(base, "stub-calls.log");
  const progressLog = join(base, "progress-calls.log");
  const stubState = join(base, "service-state");
  const readyFlag = join(base, "ready-ok");
  writeFileSync(stubState, "active\n");

  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
if [[ -f $PROGRESS_FILE ]]; then echo "systemctl $* $(cat "$PROGRESS_FILE")" >> "$PROGRESS_LOG"; fi
[[ $1 == --user ]] && shift
case $1 in
  cat)
    if [[ $2 == caddy && "$CADDY_UNIT_PRESENT" != 1 ]]; then exit 4; fi
    ;;
  stop)
    [[ -n \${STOP_STAYS_ACTIVE:-} ]] || echo inactive > "$STUB_STATE"
    stops=$(grep -c "systemctl.* stop " "$STUB_LOG")
    if [[ -n \${FAIL_RECOVERY_STOP:-} ]] && ((stops >= 2)); then
      exit 1
    fi
    ;;
  start)
    starts=$(grep -c "systemctl.* start " "$STUB_LOG")
    if [[ -n \${FAIL_STARTS:-} ]] && ((starts <= FAIL_STARTS)); then
      echo inactive > "$STUB_STATE"
      exit 1
    fi
    echo active > "$STUB_STATE"
    if [[ -n \${READY_AFTER_STARTS:-} ]] && ((starts >= READY_AFTER_STARTS)); then
      touch "$READY_FLAG"
    fi
    # Only the FIRST start simulates the new version migrating state; the
    # rollback's start runs the old version, which must not re-pollute the
    # restored state root.
    if [[ -n \${MUTATE_STATE_ON_START:-} ]] && ((starts == 1)); then
      echo migrated > "$TEST_STATE_ROOT/migrated-marker"
      echo PROFILE_AUTH_CANARY_MIGRATED > "$TEST_STATE_ROOT/opencode/profiles/shared/data/opencode/auth.json"
    fi
    ;;
  is-active)
    if [[ $* == 'is-active --quiet caddy' ]]; then
      [[ "$CADDY_ACTIVE" == 1 ]]
      exit
    fi
    cat "$STUB_STATE"
    [[ $(cat "$STUB_STATE") == active ]] || exit 3
    ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
# The version this stub reports; a fake target installer switches Bun by
# writing a copy with another V.
V=1.3.11
[[ -n \${STUB_LOG:-} ]] && echo "bun $* (cwd=$PWD) v=$V" >> "$STUB_LOG"
if [[ -f \${PROGRESS_FILE:-} ]]; then echo "bun $* $(cat "$PROGRESS_FILE")" >> "$PROGRESS_LOG"; fi
case $1 in
  --version) echo "$V" ;;
  install) [[ -e BREAK_INSTALL ]] && { echo "install broken" >&2; exit 1; } ;;
  run)
    [[ $2 == build:ui && -e BREAK_BUILD ]] && { echo "build broken" >&2; exit 1; }
    if [[ $2 == build:ui && -n \${BUILD_GATE:-} ]]; then
      until [[ -e $BUILD_GATE ]]; do sleep 0.05; done
    fi
    ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "bun"), 0o755);

  let late = opts.lateReadyPolls ?? 0;
  readyServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/readyz" && existsSync(readyFlag)) {
        if (late-- <= 0) return new Response("ok\n");
      }
      return new Response("not ready", { status: 503 });
    },
  });
  const port = readyServer.port!;

  const conf = join(base, "update.conf");
  writeFileSync(
    conf,
    `REPO_DIR=${repo}
REPO_URL=${join(base, "origin.git")}
SERVICE_NAME=isomux
SERVICE_KIND=user
STATE_ROOT=${stateRoot}
SNAPSHOT_DIR=${snapshotDir}
STATUS_DIR=${statusDir}
BUN=${join(bin, "bun")}
BASE_URL=http://127.0.0.1:${port}
UPDATER_PATH=${join(base, "installed-updater")}
READY_TIMEOUT_S=${opts.lateReadyPolls ? 3 : 0}
`,
  );

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ISOMUX_UPDATE_CONF: conf,
    STUB_LOG: stubLog,
    PROGRESS_LOG: progressLog,
    PROGRESS_FILE: join(statusDir, "progress.json"),
    STUB_STATE: stubState,
    READY_FLAG: readyFlag,
    TEST_STATE_ROOT: stateRoot,
    READY_AFTER_STARTS: String(opts.readyAfterStarts ?? 1),
    FAIL_STARTS: String(opts.failStarts ?? 0),
    CADDY_ACTIVE: opts.caddyActive === false ? "0" : "1",
    CADDY_UNIT_PRESENT: opts.caddyUnitPresent === false ? "0" : "1",
  };
  if (opts.mutateStateOnStart) env.MUTATE_STATE_ON_START = "1";
  if (opts.stopStaysActive) env.STOP_STAYS_ACTIVE = "1";

  return {
    base,
    repo,
    stateRoot,
    snapshotDir,
    statusDir,
    stubLog,
    progressLog,
    readyFlag,
    conf,
    port,
    oldCommit,
    newCommit,
    env,
  };
}

// Async on purpose: the readiness server lives in THIS process, and a
// blocking spawnSync would freeze the event loop so its fetch handler could
// never answer update.sh's curl polls (verified: curl times out against an
// in-process Bun.serve while spawnSync blocks).
async function runUpdate(
  args: string[],
  updateSh = UPDATE_SH,
): Promise<{
  code: number;
  out: string;
}> {
  const proc = Bun.spawn(["bash", updateSh, ...args], {
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}\n${err}` };
}

async function head(): Promise<string> {
  return await sh(fx.repo, "git rev-parse HEAD");
}

function stubCalls(): string[] {
  return existsSync(fx.stubLog)
    ? readFileSync(fx.stubLog, "utf8").trim().split("\n")
    : [];
}

function status(): Record<string, string> {
  return JSON.parse(readFileSync(join(fx.statusDir, "status.json"), "utf8"));
}

interface Progress {
  attempt: string;
  phase: string;
  result: string;
  pid: number;
  pidStart: string;
  boot: string;
}

function progressPath(): string {
  return join(fx.statusDir, "progress.json");
}

function progress(): Progress {
  return JSON.parse(readFileSync(progressPath(), "utf8"));
}

// [call, published progress] pairs recorded by the stubs, in call order.
function progressAtCalls(): { call: string; progress: Progress }[] {
  if (!existsSync(fx.progressLog)) return [];
  return readFileSync(fx.progressLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const at = line.indexOf("{");
      return {
        call: line.slice(0, at).trim(),
        progress: JSON.parse(line.slice(at)) as Progress,
      };
    });
}

function disposeFixture(): void {
  readyServer?.stop(true);
  readyServer = null;
  rmSync(fx.base, { recursive: true, force: true });
}

afterEach(disposeFixture);

describe("update.sh happy path", () => {
  beforeEach(async () => {
    fx = await buildFixture({});
  });

  it("fetches the tag, builds, restarts without a state snapshot, reports ok", async () => {
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.out).toContain("updated");
    expect(r.code).toBe(0);
    expect(await head()).toBe(fx.newCommit);

    // stop strictly before start; exactly one of each.
    const svcOps = stubCalls().filter((l) => / (stop|start) /.test(l));
    expect(svcOps).toEqual([
      "systemctl --user stop isomux",
      "systemctl --user start isomux",
    ]);

    // No state snapshot: nothing is written to the snapshot directory, and
    // the state root stays in place untouched.
    expect(existsSync(fx.snapshotDir)).toBe(false);
    expect(r.out).not.toContain("--- snapshot");
    expect(readFileSync(join(fx.stateRoot, "users.json"), "utf8")).toBe(
      '{"u1":{"name":"Morgan"}}\n',
    );
    expect(
      readFileSync(
        join(fx.stateRoot, "opencode/profiles/shared/data/opencode/auth.json"),
        "utf8",
      ),
    ).toBe("PROFILE_AUTH_CANARY_BEFORE\n");

    // Install + build ran for the target.
    const bunOps = stubCalls().filter((l) => l.startsWith("bun"));
    expect(bunOps.some((l) => l.includes("install --frozen-lockfile"))).toBe(
      true,
    );
    expect(bunOps.some((l) => l.includes("run build:ui"))).toBe(true);

    expect(status().result).toBe("ok");
    // The tag lands in the checkout, not just in FETCH_HEAD: server/version.ts
    // identifies the running release with `git tag --points-at HEAD`, so
    // without it the updated box reports a bare sha and the release banner
    // never stops offering the release it is already running.
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");
    // The fixture is a user-kind box, so the system-dependency sync stays out
    // of the way (it needs root); sync_system_deps itself is covered in
    // update-deps-sync.test.ts.
    expect(r.out).toContain("SERVICE_KIND=user: skipping");
    // The installed updater copy was refreshed from the NEW checkout.
    expect(readFileSync(join(fx.base, "installed-updater"), "utf8")).toContain(
      "v-new",
    );
  });

  it("publishes each phase of one attempt to the progress file, ending ok", async () => {
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    const seen = progressAtCalls();
    const at = (call: string) => seen.find((s) => s.call.startsWith(call));
    expect(at("bun install")?.progress.phase).toBe("install");
    expect(at("bun run build:ui")?.progress.phase).toBe("build");
    expect(at("systemctl --user stop")?.progress.phase).toBe("stop");
    expect(at("systemctl --user start")?.progress.phase).toBe("start");
    for (const s of seen) expect(s.progress.result).toBe("running");
    const attempts = new Set(seen.map((s) => s.progress.attempt));
    expect(attempts.size).toBe(1);

    const last = progress();
    expect([...attempts]).toEqual([last.attempt]);
    expect(last.attempt).toMatch(/^[a-f0-9]{32}$/);
    expect(last.phase).toBe("finalize");
    expect(last.result).toBe("ok");
    expect(statMode(progressPath())).toBe(0o644);
    // The process identity the server checks names this run's shell.
    expect(Number.isInteger(last.pid)).toBe(true);
    expect(last.pidStart).toMatch(/^[0-9]+$/);
    expect(last.boot).toBe(
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    );
    // Only the safe fields: no message, target, path or version text.
    expect(Object.keys(last).sort()).toEqual(
      ["attempt", "boot", "phase", "pid", "pidStart", "result"].sort(),
    );
    // A no-dot temp file is all that may remain.
    expect(
      readdirSync(fx.statusDir).filter((f) => f.startsWith(".progress.")),
    ).toEqual([]);
  });

  it("waits for an office that answers after its first readiness poll", async () => {
    disposeFixture();
    fx = await buildFixture({ lateReadyPolls: 1 });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(status().result).toBe("ok");
    expect(await head()).toBe(fx.newCommit);
  });

  it("runs on a conf with no snapshot or state keys", async () => {
    writeFileSync(
      fx.conf,
      readFileSync(fx.conf, "utf8")
        .replace(/^STATE_ROOT=.*\n/m, "")
        .replace(/^SNAPSHOT_DIR=.*\n/m, ""),
    );
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(status().result).toBe("ok");
  });

  it("a progress publication failure never changes the update", async () => {
    // mktemp fails for the progress file only.
    const bin = join(fx.base, "bin");
    writeFileSync(
      join(bin, "mktemp"),
      `#!/usr/bin/env bash
[[ $* == *.progress.* ]] && exit 1
exec /usr/bin/mktemp "$@"
`,
      { mode: 0o755 },
    );
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(await head()).toBe(fx.newCommit);
    expect(status().result).toBe("ok");
    expect(existsSync(progressPath())).toBe(false);
  });

  it("an updater that loses the lock never overwrites the live attempt", async () => {
    mkdirSync(fx.statusDir, { recursive: true });
    const live =
      '{"attempt":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","phase":"build","result":"running","pid":1,"pidStart":"1","boot":"x"}\n';
    writeFileSync(progressPath(), live);
    const holder = Bun.spawn(
      ["flock", join(fx.statusDir, "lock"), "sleep", "30"],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      // Wait until the holder has the lock.
      for (let i = 0; i < 50; i++) {
        const probe = Bun.spawnSync([
          "flock",
          "-n",
          join(fx.statusDir, "lock"),
          "true",
        ]);
        if (probe.exitCode !== 0) break;
        await Bun.sleep(20);
      }
      const r = await runUpdate(["v2026.7.20"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("another update is already running");
      expect(readFileSync(progressPath(), "utf8")).toBe(live);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  it("a stopped updater reports a failed attempt", async () => {
    // The build waits for this file, so the stop lands inside it.
    fx.env.BUILD_GATE = join(fx.base, "build-gate");
    const proc = Bun.spawn(["bash", UPDATE_SH, "v2026.7.20"], {
      env: fx.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Signal while the build runs, the long step a stop lands in. (Bash can
    // fail to run a trap that lands inside a command substitution; the
    // server's process-identity check covers that case.)
    for (let i = 0; i < 200; i++) {
      if (stubCalls().some((l) => l.startsWith("bun run build:ui"))) break;
      await Bun.sleep(25);
    }
    expect(progress().phase).toBe("build");
    proc.kill("SIGTERM");
    // Bash runs the trap when the build, its foreground child, ends.
    writeFileSync(fx.env.BUILD_GATE, "");
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(progress().result).toBe("failed");
    expect(status().result).toBe("failed");
    expect(status().message).toContain("stopped during build");
  });

  it("no-op when already on the target tag, as a new attempt", async () => {
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    const first = progress().attempt;
    rmSync(fx.stubLog);
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(progress().attempt).not.toBe(first);
    expect(r.out).toContain("already on");
    expect(r.out).not.toContain("--- deps");
    expect(stubCalls().filter((l) => / stop /.test(l))).toEqual([]);
    // A terminal result, so no screen waits on a run that already ended.
    expect(progress().result).toBe("ok");
  });

  it("a tagged box with no dependency record syncs once, then no-ops", async () => {
    // An older updater moved this box to the target and recorded the tag,
    // but never ran the target's dependency sync. The tag must not stand in
    // for the sync.
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--- deps");
    expect(r.out).toContain("SERVICE_KIND=user: skipping");
    // A missing record is the expected first state, not an error to print.
    expect(r.out).not.toContain("deps-synced");
    expect(stubCalls().filter((l) => / stop /.test(l)).length).toBe(1);
    expect(stubCalls().filter((l) => / start /.test(l)).length).toBe(1);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");
    expect(status().result).toBe("ok");

    rmSync(fx.stubLog);
    const again = await runUpdate(["v2026.7.20"]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("--- deps");
    expect(stubCalls().filter((l) => / stop /.test(l))).toEqual([]);
  });

  it("a failed sync on a tagged box is not recorded, so the next run syncs", async () => {
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    const failingUpdater = join(fx.base, "failing-updater");
    const source = readFileSync(UPDATE_SH, "utf8");
    const changed = source.replace(
      "sync_system_deps() {\n",
      "sync_system_deps() {\n  return 42\n",
    );
    expect(changed).not.toBe(source);
    writeFileSync(failingUpdater, changed, { mode: 0o700 });

    const first = await runUpdate(["v2026.7.20"], failingUpdater);
    expect(first.code).not.toBe(0);
    expect(first.out).toContain("--- deps");
    expect(stubCalls().filter((l) => / stop /.test(l))).toEqual([]);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");

    const retry = await runUpdate(["v2026.7.20"]);
    expect(retry.code).toBe(0);
    expect(retry.out).toContain("--- deps");
    expect(status().result).toBe("ok");
  });

  it("a failed restart after the sync is not recorded, so the next run syncs", async () => {
    fx.env.FAIL_STARTS = "1";
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);

    const first = await runUpdate(["v2026.7.20"]);
    expect(first.code).not.toBe(0);
    expect(first.out).toContain("--- deps");
    expect(status().result).toBe("failed");
    // The tag was already there, so the failure leaves it in place.
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");

    // The stub fails only the first start of the fixture.
    const retry = await runUpdate(["v2026.7.20"]);
    expect(retry.code).toBe(0);
    expect(retry.out).toContain("--- deps");
    expect(status().result).toBe("ok");
  });

  it("a recorded sync is not redone when only the tag is missing", async () => {
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    await sh(fx.repo, "git tag -d v2026.7.20");
    rmSync(fx.stubLog);

    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("--- deps");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");
    expect(stubCalls().filter((l) => / stop /.test(l)).length).toBe(1);
    expect(stubCalls().filter((l) => / start /.test(l)).length).toBe(1);
  });

  it("re-running on the target repairs a checkout with no local tag", async () => {
    // The repair path for boxes updated before the tag was recorded: they sit
    // on the right commit with no tag, so they report a bare sha and keep
    // being offered the release they run. Writing the tag ahead of the
    // already-on-target exit is what makes a plain re-run fix them.
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("recorded the release tag");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("v2026.7.20");
    // A pre-deps-sync updater leaves exactly this shape after its first update:
    // current code and updater, but no tag and none of the target's new system
    // dependencies. The repair run must attempt target deps sync before it
    // restarts. This user-kind fixture skips the root-only body, which has its
    // own focused coverage in update-deps-sync.test.ts.
    expect(r.out).toContain("--- deps");
    expect(r.out).toContain("SERVICE_KIND=user: skipping");
    // The office reads its version once per process, so the tag alone changes
    // nothing a user can see: the repair is only finished after a restart, and
    // one is enough.
    expect(stubCalls().filter((l) => / stop /.test(l)).length).toBe(1);
    expect(stubCalls().filter((l) => / start /.test(l)).length).toBe(1);
  });

  it("a failed repair restores the absent tag so the next run retries deps", async () => {
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");

    // Force only the target-dependency seam to fail in a temp copy of the
    // real updater. No product-only test switch reaches the root-running
    // updater, and the unchanged remainder is the branch under test.
    const failingUpdater = join(fx.base, "failing-updater");
    const source = readFileSync(UPDATE_SH, "utf8");
    const changed = source.replace(
      "sync_system_deps() {\n",
      "sync_system_deps() {\n  return 42\n",
    );
    expect(changed).not.toBe(source);
    writeFileSync(failingUpdater, changed, { mode: 0o700 });

    const first = await runUpdate(["v2026.7.20"], failingUpdater);
    expect(first.code).not.toBe(0);
    expect(first.out).toContain("--- deps");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");

    const retry = await runUpdate(["v2026.7.20"], failingUpdater);
    expect(retry.code).not.toBe(0);
    expect(retry.out).toContain("--- deps");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
  });

  it("a stop timeout restores the absent tag so retries cannot report a no-op", async () => {
    disposeFixture();
    fx = await buildFixture({ stopStaysActive: true });
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");

    // Keep the production timeout fixed while making this sandbox failure
    // quick. The full source line is unique, so this cannot also shorten the
    // separate rollback stop-wait deadline.
    const timeoutLine = "  local deadline=$((SECONDS + 60)) state";
    const source = readFileSync(UPDATE_SH, "utf8");
    expect(source.split(timeoutLine)).toHaveLength(2);
    const timedUpdater = join(fx.base, "timed-updater");
    writeFileSync(
      timedUpdater,
      source.replace(timeoutLine, "  local deadline=$((SECONDS + 0)) state"),
      { mode: 0o700 },
    );

    const first = await runUpdate(["v2026.7.20"], timedUpdater);
    expect(first.code).not.toBe(0);
    expect(first.out).toContain(
      "service did not stop within 60s (state: active)",
    );
    expect(first.out).not.toContain("already on v2026.7.20; nothing to do");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    expect(status().result).toBe("failed");

    const retry = await runUpdate(["v2026.7.20"], timedUpdater);
    expect(retry.code).not.toBe(0);
    expect(retry.out).toContain("--- deps");
    expect(retry.out).not.toContain("already on v2026.7.20; nothing to do");
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    expect(status().result).toBe("failed");
  });

  it("a failed first start restores the tag and recovers the office", async () => {
    fx.env.FAIL_STARTS = "1";
    // The recovery stop also reports failure. Its guard must keep `set -e`
    // from skipping the second start and the honest final message.
    fx.env.FAIL_RECOVERY_STOP = "1";
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);

    const r = await runUpdate(["v2026.7.20"]);

    expect(r.code).not.toBe(0);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    expect(stubCalls().filter((line) => / start /.test(line))).toHaveLength(2);
    expect(r.out).toContain("a second start brought isomux back up");
    expect(r.out).toContain("re-run the update to finish the repair");
    expect(status().result).toBe("failed");
  });

  it("reports manual attention when the recovery start also fails", async () => {
    fx.env.FAIL_STARTS = "2";
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);

    const r = await runUpdate(["v2026.7.20"]);

    expect(r.code).not.toBe(0);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    expect(stubCalls().filter((line) => / start /.test(line))).toHaveLength(2);
    expect(r.out).toContain("the office is still down");
    expect(r.out).toContain("needs manual attention");
    expect(status().result).toBe("failed");
  });

  it("does not claim recovery until the office answers", async () => {
    fx.env.FAIL_STARTS = "1";
    fx.env.READY_AFTER_STARTS = "3";
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);

    const r = await runUpdate(["v2026.7.20"]);

    expect(r.code).not.toBe(0);
    expect(await sh(fx.repo, "git tag --points-at HEAD")).toBe("");
    expect(stubCalls().filter((line) => / start /.test(line))).toHaveLength(2);
    expect(r.out).toContain("the office is still down");
    expect(r.out).toContain("needs manual attention");
    expect(r.out).not.toContain("a second start brought isomux back up");
    expect(status().result).toBe("failed");
  });
});

describe("update.sh validation", () => {
  beforeEach(async () => {
    fx = await buildFixture({});
  });

  it("refuses a non-CalVer target", async () => {
    const r = await runUpdate(["main"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("CalVer");
    expect(stubCalls()).toEqual([]);
    expect(await head()).toBe(fx.oldCommit);
  });

  it("refuses an unknown tag, service untouched", async () => {
    const r = await runUpdate(["v2099.1.1"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(await head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
  });

  it("refuses a dirty checkout", async () => {
    writeFileSync(join(fx.repo, "app.txt"), "local edit\n");
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("dirty");
  });

  it("a local-only tag in the service checkout is never accepted", async () => {
    // Reviewer regression (finding 2): a CalVer tag planted in the
    // service-user-writable checkout, absent upstream, must be refused -
    // the configured upstream is the only tag authority.
    await sh(fx.repo, `git tag -a v2026.7.30 -m planted ${fx.oldCommit}`);
    const r = await runUpdate(["v2026.7.30"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(await head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
  });

  it("a tag that moved upstream is refused", async () => {
    // First update pins v2026.7.20 into the trust repo; then the tag is
    // force-moved upstream. The non-forced trust fetch must refuse it.
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    await sh(
      fx.base,
      `git -C origin.git tag -f v2026.7.20 ${fx.oldCommit} 2>/dev/null || git -C origin.git update-ref refs/tags/v2026.7.20 ${fx.oldCommit}`,
    );
    const r = await runUpdate(["v2026.7.20", "--allow-downgrade"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(await head()).toBe(fx.newCommit);
  });

  it("conf values are data, never code: an injection in REPO_URL is inert and refused", async () => {
    // Reviewer regression (config injection): the conf used to be sourced;
    // a value with shell syntax would have executed as the updater's user
    // (root on VPS boxes). The literal parser stores it as a string and the
    // REPO_URL charset validation refuses it.
    writeFileSync(
      fx.conf,
      readFileSync(fx.conf, "utf8").replace(
        /REPO_URL=.*/,
        `REPO_URL=$(touch ${join(fx.base, "pwned")})`,
      ),
    );
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not a plain git URL/path");
    expect(existsSync(join(fx.base, "pwned"))).toBe(false);
  });

  it("a multi-line conf value fails closed as an unknown key", async () => {
    writeFileSync(
      fx.conf,
      readFileSync(fx.conf, "utf8").replace(
        /SERVICE_NAME=.*/,
        `SERVICE_NAME=isomux\nEVIL_KEY=1`,
      ),
    );
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("unknown key");
  });
});

describe("update.sh downgrade guard", () => {
  beforeEach(async () => {
    fx = await buildFixture({ readyAfterStarts: 1 });
    // Make the CURRENT checkout the newer commit and target the older tag:
    // tag c1 as an older release on origin, sit at c2.
    await sh(fx.repo, `git tag -a v2026.7.18 -m old ${fx.oldCommit}`);
    await sh(fx.repo, "git push -q origin --tags");
    await sh(fx.repo, "git tag -d v2026.7.18");
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
  });

  it("refuses without --allow-downgrade, proceeds with it", async () => {
    const refused = await runUpdate(["v2026.7.18"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("--allow-downgrade");
    expect(await head()).toBe(fx.newCommit);

    const r = await runUpdate(["v2026.7.18", "--allow-downgrade"]);
    expect(r.code).toBe(0);
    expect(await head()).toBe(fx.oldCommit);
  });
});

// The root-owned record of the installed release. Its name is the protocol
// between the installer, the updater and these tests.
function recordPath(): string {
  return join(fx.statusDir, "installed-release");
}

function writeRecord(content: string): void {
  mkdirSync(fx.statusDir, { recursive: true });
  writeFileSync(recordPath(), content);
}

function readRecord(): string | null {
  return existsSync(recordPath())
    ? readFileSync(recordPath(), "utf8").trim()
    : null;
}

// What an update before the fix leaves behind: the root-owned trust repo
// holds the tag it installed, and no record exists.
async function seedTrust(tag: string): Promise<void> {
  const trust = join(fx.statusDir, "trust.git");
  mkdirSync(fx.statusDir, { recursive: true });
  await sh(fx.base, `git init -q --bare ${trust}`);
  await sh(
    fx.base,
    `git -C ${trust} fetch -q --depth 1 ${join(fx.base, "origin.git")} refs/tags/${tag}:refs/tags/${tag}`,
  );
}

async function ancestry(older: string): Promise<string> {
  return await sh(
    fx.repo,
    `git merge-base --is-ancestor ${older} HEAD && echo ancestor || echo not-ancestor`,
  );
}

// Each leaves the service checkout clean, and each hides the older release
// from the ancestry walk in the checkout. Run as the service user, which
// owns the checkout.
const TAMPERS: Record<string, string> = {
  graft: "git replace --graft HEAD",
  shallow: "git rev-parse HEAD > .git/shallow",
  orphan: "git checkout -q --orphan tamper && git commit -qm orphan",
};

const INSTALLED_UPDATER = "# installed updater marker\n";

describe("update.sh root-side downgrade basis", () => {
  beforeEach(async () => {
    // Same layout as the downgrade guard: v2026.7.18 at c1, v2026.7.20 at
    // c2, the checkout at c2 with both tags.
    fx = await buildFixture({ readyAfterStarts: 1 });
    await sh(fx.repo, `git tag -a v2026.7.18 -m old ${fx.oldCommit}`);
    await sh(fx.repo, "git push -q origin --tags");
    await sh(fx.repo, "git tag -d v2026.7.18");
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    writeFileSync(join(fx.base, "installed-updater"), INSTALLED_UPDATER);
    expect(await ancestry(fx.oldCommit)).toBe("ancestor");
  });

  async function tamper(name: string): Promise<string> {
    await sh(fx.repo, TAMPERS[name]!);
    // The enabling condition: the checkout passes the clean check, and its
    // history no longer shows the older release.
    expect(await sh(fx.repo, "git status --porcelain")).toBe("");
    expect(await ancestry(fx.oldCommit)).toBe("not-ancestor");
    return await head();
  }

  async function expectRefused(
    r: { code: number; out: string },
    headBefore: string,
  ): Promise<void> {
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--allow-downgrade");
    expect(status().result).toBe("failed");
    expect(await head()).toBe(headBefore);
    expect(readFileSync(join(fx.base, "installed-updater"), "utf8")).toBe(
      INSTALLED_UPDATER,
    );
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
  }

  for (const name of Object.keys(TAMPERS)) {
    it(`the ${name} tamper does not let an older release pass the record`, async () => {
      writeRecord("v2026.7.20\n");
      const before = await tamper(name);
      await expectRefused(await runUpdate(["v2026.7.18"]), before);
      expect(readRecord()).toBe("v2026.7.20");
    });
  }

  it("a checkout moved to the older release gets no root-side repair of it", async () => {
    writeRecord("v2026.7.20\n");
    // Clean, and the target is now the checkout's own HEAD and tag.
    await sh(fx.repo, "git checkout -q --detach v2026.7.18");
    expect(await sh(fx.repo, "git status --porcelain")).toBe("");
    const r = await runUpdate(["v2026.7.18"]);
    await expectRefused(r, fx.oldCommit);
    // Refused before the target's dependency sync and Bun switch.
    expect(r.out).not.toContain("--- deps");
    expect(readRecord()).toBe("v2026.7.20");
  });

  it("with no record, the trust repo's newest release is the basis, and it is recorded", async () => {
    await seedTrust("v2026.7.20");
    expect(readRecord()).toBeNull();
    const before = await tamper("graft");
    await expectRefused(await runUpdate(["v2026.7.18"]), before);
    expect(readRecord()).toBe("v2026.7.20");
  });

  it("a malformed record is not a basis; the trust repo is", async () => {
    writeRecord("not-a-release\n");
    await seedTrust("v2026.7.20");
    const before = await tamper("graft");
    await expectRefused(await runUpdate(["v2026.7.18"]), before);
  });

  it("an allowed downgrade records the older release", async () => {
    writeRecord("v2026.7.20\n");
    await tamper("graft");
    const r = await runUpdate(["v2026.7.18", "--allow-downgrade"]);
    expect(r.code).toBe(0);
    expect(await head()).toBe(fx.oldCommit);
    expect(readRecord()).toBe("v2026.7.18");
  });

  it("a failed update to a newer release does not raise the basis", async () => {
    // v2026.7.21 at c3 and a broken v2026.7.22 at c4, both after c2.
    const scratch = join(fx.base, "scratch");
    await sh(fx.base, `git clone -q ${join(fx.base, "origin.git")} scratch`);
    await sh(scratch, "git config user.email t@t && git config user.name T");
    await sh(scratch, `git checkout -q --detach ${fx.newCommit}`);
    writeFileSync(join(scratch, "app.txt"), "newer\n");
    await sh(scratch, "git commit -qam c3 && git tag -a v2026.7.21 -m c3");
    const c3 = await sh(scratch, "git rev-parse HEAD");
    writeFileSync(join(scratch, "BREAK_BUILD"), "");
    await sh(scratch, "git add . && git commit -qm c4");
    await sh(scratch, "git tag -a v2026.7.22 -m c4");
    await sh(scratch, "git push -q origin --tags");
    await seedTrust("v2026.7.20");

    const failed = await runUpdate(["v2026.7.22"]);
    expect(failed.code).not.toBe(0);
    expect(await head()).toBe(fx.newCommit);
    expect(
      await sh(fx.base, `git -C ${join(fx.statusDir, "trust.git")} tag -l`),
    ).toContain("v2026.7.22");

    const r = await runUpdate(["v2026.7.21"]);
    expect(r.code).toBe(0);
    expect(await head()).toBe(c3);
    expect(readRecord()).toBe("v2026.7.21");
  });
});

describe("update.sh installed-release record", () => {
  beforeEach(async () => {
    fx = await buildFixture({ readyAfterStarts: 1 });
  });

  it("an update records the release it installed", async () => {
    expect(readRecord()).toBeNull();
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    expect(readRecord()).toBe("v2026.7.20");
  });

  it("a repair of the release the checkout is on records it", async () => {
    await sh(fx.repo, "git fetch -q --tags origin");
    await sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--- deps");
    expect(readRecord()).toBe("v2026.7.20");
  });

  it("a failed update does not record the release", async () => {
    fx.env.FAIL_STARTS = "99";
    expect((await runUpdate(["v2026.7.20"])).code).not.toBe(0);
    expect(readRecord()).toBeNull();
  });
});

describe("update.sh failure ladders", () => {
  it("failed install: restores old deps+UI, never touches the service", async () => {
    fx = await buildFixture({ newFiles: { BREAK_INSTALL: "1" } });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(await head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
    // Recovery reinstalled AND rebuilt for the old commit (reviewer point:
    // ui/dist may already be dirty by then).
    const bunOps = stubCalls().filter((l) => l.startsWith("bun"));
    const lastInstall = bunOps.lastIndexOf(
      bunOps.filter((l) => l.includes("install")).at(-1)!,
    );
    const lastBuild = bunOps.lastIndexOf(
      bunOps.filter((l) => l.includes("build:ui")).at(-1)!,
    );
    expect(lastBuild).toBeGreaterThan(lastInstall);
    expect(status().result).toBe("failed");
  });

  it("failed build: same recovery, service untouched", async () => {
    fx = await buildFixture({ newFiles: { BREAK_BUILD: "1" } });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(await head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
    expect(status().result).toBe("failed");
  });

  it("failed readiness: rolls back the code only and starts it", async () => {
    // The new version "migrates" state on start (the stub writes a marker
    // into the state root) and never becomes ready; readiness succeeds only
    // from the second start (the rolled-back old version).
    fx = await buildFixture({ readyAfterStarts: 2, mutateStateOnStart: true });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("rolled the code back");
    expect(await head()).toBe(fx.oldCommit);
    // The old code was reinstalled and rebuilt before its start.
    const ops = stubCalls().filter(
      (l) => / (stop|start) /.test(l) || l.startsWith("bun"),
    );
    const lastStart = ops.findLastIndex((l) => / start /.test(l));
    const lastBuild = ops.findLastIndex((l) => l.includes("build:ui"));
    expect(lastBuild).toBeGreaterThan(-1);
    expect(lastBuild).toBeLessThan(lastStart);

    // No snapshot to restore: the state root stays as the new version left
    // it, and nothing is moved aside.
    expect(existsSync(join(fx.stateRoot, "users.json"))).toBe(true);
    expect(existsSync(join(fx.stateRoot, "migrated-marker"))).toBe(true);
    expect(existsSync(fx.snapshotDir)).toBe(false);
    expect(status().result).toBe("failed");
    expect(progress().result).toBe("failed");
    // Rolled-back service is up: stop, start (fails ready), stop, start.
    const svcOps = stubCalls().filter((l) => / (stop|start) /.test(l));
    expect(svcOps).toEqual([
      "systemctl --user stop isomux",
      "systemctl --user start isomux",
      "systemctl --user stop isomux",
      "systemctl --user start isomux",
    ]);
  });

  it("failed readiness with a rollback that never answers needs manual attention", async () => {
    fx = await buildFixture({ readyAfterStarts: 99 });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("rollback did not come up");
    expect(status().phase).toBe("recovery-failed");
    expect(progress().result).toBe("failed");
  });
});

// Network convergence lives in the target release's deps-only installer. The
// installed updater does not mutate the terminator's config, but it must not
// report an unqualified success when the public front door is down.
describe("update.sh public-front-door result", () => {
  const SRC = readFileSync(new URL("./update.sh", import.meta.url), "utf8");
  // The warning names the unit to check.
  const CADDY_WARNING = /warning:.*systemctl status caddy/;

  function updaterWithSystemFrontDoorProbe(): string {
    const path = join(fx.base, "system-front-door-updater");
    const changed = SRC.replaceAll(
      "check_public_front_door\n",
      "SERVICE_KIND=system check_public_front_door\n",
    );
    expect(changed).not.toBe(SRC);
    writeFileSync(path, changed, { mode: 0o700 });
    return path;
  }

  it("warns in both output and status when loopback is ready but Caddy is down", async () => {
    fx = await buildFixture({ caddyActive: false });
    const result = await runUpdate(
      ["v2026.7.20"],
      updaterWithSystemFrontDoorProbe(),
    );
    expect(result.code).toBe(0);
    // A qualified ok, with the warning in both places.
    expect(result.out).toMatch(CADDY_WARNING);
    expect(status().result).toBe("ok");
    expect(status().message).toMatch(CADDY_WARNING);
  });

  it("does not warn on a system office with no Caddy unit", async () => {
    fx = await buildFixture({
      caddyActive: false,
      caddyUnitPresent: false,
    });
    const result = await runUpdate(
      ["v2026.7.20"],
      updaterWithSystemFrontDoorProbe(),
    );
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(CADDY_WARNING);
    expect(status().message).not.toMatch(CADDY_WARNING);
  });
});

// Side-by-side Bun installs (task ffd70e4a). The target release carries a fake
// installer with the bun-mode marker that does what converge_bun does to the
// layout (adopt the current Bun into <dir>/<version>/bun, add the pinned one,
// swap $BUN), and logs how the updater ran it. converge_bun itself is covered
// in deploy/install-bun.test.ts.
const PIN = "1.4.9";
const OLD_BUN = "1.3.11";

function bunModeInstaller(opts: { failAfterSwitch?: boolean } = {}): string {
  return `#!/usr/bin/env bash
ISOMUX_INSTALL_BUN_MODE_VERSION=1
ISOMUX_INSTALL_DEPS_MODE_VERSION=1
set -e
{
  printf 'ISOMUX_BUN_ONLY=%s\\n' "\${ISOMUX_BUN_ONLY:-unset}"
  printf 'ISOMUX_DEPS_ONLY=%s\\n' "\${ISOMUX_DEPS_ONLY:-unset}"
  printf 'LINK=%s\\n' "\${ISOMUX_BUN_LINK:-unset}"
  printf 'DIR=%s\\n' "\${ISOMUX_BUN_DIR:-unset}"
  printf 'DRY_RUN=%s\\n' "\${DRY_RUN:-unset}"
} >> "@BASE@/bun-mode.log"
[[ \${ISOMUX_BUN_ONLY:-} == 1 ]] || exit 0
cur=$("$ISOMUX_BUN_LINK" --version)
mkdir -p "$ISOMUX_BUN_DIR/$cur" "$ISOMUX_BUN_DIR/${PIN}"
[[ -e $ISOMUX_BUN_DIR/$cur/bun ]] || cp "$ISOMUX_BUN_LINK" "$ISOMUX_BUN_DIR/$cur/bun"
sed "s/^V=.*/V=${PIN}/" "$ISOMUX_BUN_LINK" > "$ISOMUX_BUN_DIR/${PIN}/bun"
chmod 755 "$ISOMUX_BUN_DIR/${PIN}/bun"
cp "$ISOMUX_BUN_DIR/${PIN}/bun" "$ISOMUX_BUN_LINK.new"
mv -f "$ISOMUX_BUN_LINK.new" "$ISOMUX_BUN_LINK"
${opts.failAfterSwitch ? 'echo "bun switch broke" >&2; exit 1' : "exit 0"}
`;
}

function pinnedRelease(
  extra: Record<string, string> = {},
  installer = bunModeInstaller(),
): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "fake",
      packageManager: `bun@${PIN}`,
    }),
    "deploy/install.sh": installer,
    ...extra,
  };
}

function bunPath(): string {
  return join(fx.base, "bin", "bun");
}

function bunDir(): string {
  return join(fx.statusDir, "bun");
}

function bunVersion(): string {
  const r = Bun.spawnSync([bunPath(), "--version"]);
  return r.stdout.toString().trim();
}

function bunModeLog(): string | null {
  const path = join(fx.base, "bun-mode.log");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// The Bun version each target or rollback `bun install` / `bun run build:ui`
// ran on, in call order.
function buildSteps(): string[] {
  return stubCalls()
    .filter(
      (l) => / (stop|start) /.test(l) || /^bun (install|run build:ui)/.test(l),
    )
    .map((l) =>
      l.startsWith("bun")
        ? `${l.split(" ")[1] === "install" ? "install" : "build"} ${l.slice(l.lastIndexOf("v=") + 2)}`
        : l.includes(" stop ")
          ? "stop"
          : "start",
    );
}

describe("update.sh side-by-side Bun", () => {
  it("switches to the target's pinned Bun through the target's installer before building it", async () => {
    fx = await buildFixture({ newFiles: pinnedRelease() });
    // An unrelated old version and a file that is not a version: the prune
    // removes the first and never touches the second.
    mkdirSync(join(bunDir(), "0.0.9"), { recursive: true });
    writeFileSync(join(bunDir(), "0.0.9", "bun"), "#!/bin/sh\necho 0.0.9\n");
    writeFileSync(join(bunDir(), "notes.txt"), "kept\n");
    fx.env.DRY_RUN = "1";

    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(status().result).toBe("ok");
    expect(bunVersion()).toBe(PIN);
    // Built and started on the new Bun only.
    expect(buildSteps()).toEqual([
      `install ${PIN}`,
      `build ${PIN}`,
      "stop",
      "start",
    ]);
    // The mode, its paths, and a fixed environment (an inherited DRY_RUN
    // would turn the switch into a reported success that did nothing).
    const log = bunModeLog();
    expect(log).toContain("ISOMUX_BUN_ONLY=1\n");
    expect(log).toContain(`LINK=${bunPath()}\n`);
    expect(log).toContain(`DIR=${bunDir()}\n`);
    expect(log).toContain("DRY_RUN=unset\n");
    // The old Bun stays for the next rollback; nothing else of the past does.
    expect(readdirSync(bunDir()).sort()).toEqual([OLD_BUN, PIN, "notes.txt"]);
  });

  it("a failed build switches Bun back before the old code is rebuilt", async () => {
    fx = await buildFixture({ newFiles: pinnedRelease({ BREAK_BUILD: "1" }) });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(status().result).toBe("failed");
    expect(await head()).toBe(fx.oldCommit);
    expect(bunVersion()).toBe(OLD_BUN);
    // The target was built on the new Bun (the switch happened), and the
    // old code was reinstalled and rebuilt on its own Bun.
    expect(buildSteps()).toEqual([
      `install ${PIN}`,
      `build ${PIN}`,
      `install ${OLD_BUN}`,
      `build ${OLD_BUN}`,
    ]);
  });

  it("a failed readiness switches Bun back before the old code restarts", async () => {
    fx = await buildFixture({
      newFiles: pinnedRelease(),
      readyAfterStarts: 2,
    });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("rolled the code back");
    expect(await head()).toBe(fx.oldCommit);
    expect(bunVersion()).toBe(OLD_BUN);
    expect(buildSteps()).toEqual([
      `install ${PIN}`,
      `build ${PIN}`,
      "stop",
      "start",
      "stop",
      `install ${OLD_BUN}`,
      `build ${OLD_BUN}`,
      "start",
    ]);
  });

  it("a failed Bun switch fails the update before the checkout and puts Bun back", async () => {
    // The installer swaps $BUN and then fails, so the updater's own restore
    // is what puts the old Bun back.
    fx = await buildFixture({
      newFiles: pinnedRelease({}, bunModeInstaller({ failAfterSwitch: true })),
    });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(status().result).toBe("failed");
    expect(bunModeLog()).toContain("ISOMUX_BUN_ONLY=1\n");
    expect(await head()).toBe(fx.oldCommit);
    expect(bunVersion()).toBe(OLD_BUN);
    expect(buildSteps()).toEqual([]);
  });

  it("never runs a target installer that only mentions the Bun mode", async () => {
    // Running an installer without the mode would run a FULL install on a
    // live box. The update itself goes on, on the installed Bun.
    fx = await buildFixture({
      newFiles: pinnedRelease(
        {},
        `#!/usr/bin/env bash
# ISOMUX_BUN_ONLY=1 installs only the pinned Bun.
# ISOMUX_INSTALL_BUN_MODE_VERSION=1 is the marker the updater looks for.
echo "  ISOMUX_INSTALL_BUN_MODE_VERSION=1"
touch "@BASE@/bun-mode.log"
`,
      ),
    });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(bunModeLog()).toBeNull();
    expect(bunVersion()).toBe(OLD_BUN);
    // It warns about the mismatch before it touches the checkout.
    const warn = r.out.indexOf(`bun@${PIN}`);
    const checkout = r.out.indexOf("--- checkout");
    expect(warn).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(checkout);
  });

  it("a box already on the target but on another Bun switches and restarts", async () => {
    // A box an older updater moved to this release, or a member's
    // `bun upgrade`: the release and its dependency record are in place, so
    // only the Bun check can tell this from a no-op.
    fx = await buildFixture({ newFiles: pinnedRelease() });
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    expect(bunVersion()).toBe(PIN);
    // On the target and on its Bun: a no-op.
    const switched = buildSteps().length;
    const noop = await runUpdate(["v2026.7.20"]);
    expect(noop.code).toBe(0);
    expect(status().result).toBe("ok");
    expect(buildSteps()).toHaveLength(switched);
    // Replaced by rename, as `bun upgrade` does, so the file in the Bun
    // directory keeps its bytes.
    writeFileSync(
      `${bunPath()}.upgrade`,
      readFileSync(bunPath(), "utf8").replace(/^V=.*$/m, `V=${OLD_BUN}`),
      { mode: 0o755 },
    );
    renameSync(`${bunPath()}.upgrade`, bunPath());
    expect(bunVersion()).toBe(OLD_BUN);
    const before = buildSteps().length;

    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(status().result).toBe("ok");
    expect(await head()).toBe(fx.newCommit);
    expect(bunVersion()).toBe(PIN);
    expect(buildSteps().slice(before)).toEqual(["stop", "start"]);
  });
});
