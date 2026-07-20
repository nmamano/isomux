// scripts/update.sh — the customer-box updater, driven end-to-end in a
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
// build, failed readiness with a state migration to roll back.

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
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

const UPDATE_SH = new URL("./update.sh", import.meta.url).pathname;

interface Fixture {
  base: string;
  repo: string;
  stateRoot: string;
  snapshotDir: string;
  statusDir: string;
  stubLog: string;
  readyFlag: string;
  conf: string;
  port: number;
  oldCommit: string;
  newCommit: string;
  env: Record<string, string>;
}

let fx: Fixture;
let readyServer: ReturnType<typeof Bun.serve> | null = null;

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

// Build: origin bare repo with commit c1 (current install) and commit c2
// tagged as a release; the installed checkout sits detached at c1 with the
// release tag known only to origin (fetch must bring it).
function buildFixture(opts: {
  tag?: string;
  newFiles?: Record<string, string>;
  readyAfterStarts?: number;
  mutateStateOnStart?: boolean;
}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "isomux-update-test-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  sh(repo, "git init -q -b main");
  sh(repo, "git config user.email t@t && git config user.name T");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fake", packageManager: "bun@1.3.11" }),
  );
  writeFileSync(join(repo, "app.txt"), "old\n");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "update.sh"), "# fake updater v-old\n");
  sh(repo, "git add . && git commit -qm c1");
  const oldCommit = sh(repo, "git rev-parse HEAD");

  const origin = join(base, "origin.git");
  sh(base, "git clone -q --bare repo origin.git");
  sh(repo, `git remote add origin ${origin}`);

  writeFileSync(join(repo, "app.txt"), "new\n");
  writeFileSync(join(repo, "scripts", "update.sh"), "# fake updater v-new\n");
  for (const [name, content] of Object.entries(opts.newFiles ?? {})) {
    writeFileSync(join(repo, name), content);
  }
  sh(repo, "git add . && git commit -qm c2");
  const newCommit = sh(repo, "git rev-parse HEAD");
  const tag = opts.tag ?? "v2026.7.20";
  sh(repo, `git tag -a ${tag} -m "${tag}"`);
  sh(repo, "git push -q origin main --tags");
  sh(repo, `git checkout -q --detach ${oldCommit}`);
  sh(repo, `git tag -d ${tag}`);

  const stateRoot = join(base, "state", ".isomux");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, "users.json"), '{"u1":{"name":"Boss"}}\n');

  const snapshotDir = join(base, "snapshots");
  const statusDir = join(base, "status");
  const stubLog = join(base, "stub-calls.log");
  const stubState = join(base, "service-state");
  const readyFlag = join(base, "ready-ok");
  writeFileSync(stubState, "active\n");

  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
[[ $1 == --user ]] && shift
case $1 in
  stop) echo inactive > "$STUB_STATE" ;;
  start)
    echo active > "$STUB_STATE"
    starts=$(grep -c "systemctl.* start " "$STUB_LOG")
    if [[ -n \${READY_AFTER_STARTS:-} ]] && ((starts >= READY_AFTER_STARTS)); then
      touch "$READY_FLAG"
    fi
    # Only the FIRST start simulates the new version migrating state; the
    # rollback's start runs the old version, which must not re-pollute the
    # restored state root.
    if [[ -n \${MUTATE_STATE_ON_START:-} ]] && ((starts == 1)); then
      echo migrated > "$TEST_STATE_ROOT/migrated-marker"
    fi
    ;;
  is-active)
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
echo "bun $* (cwd=$PWD)" >> "$STUB_LOG"
case $1 in
  --version) echo 1.3.11 ;;
  install) [[ -e BREAK_INSTALL ]] && { echo "install broken" >&2; exit 1; } ;;
  run) [[ $2 == build:ui && -e BREAK_BUILD ]] && { echo "build broken" >&2; exit 1; } ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "bun"), 0o755);

  readyServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/readyz" && existsSync(readyFlag)) {
        return new Response("ok\n");
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
READY_TIMEOUT_S=3
`,
  );

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ISOMUX_UPDATE_CONF: conf,
    STUB_LOG: stubLog,
    STUB_STATE: stubState,
    READY_FLAG: readyFlag,
    TEST_STATE_ROOT: stateRoot,
    READY_AFTER_STARTS: String(opts.readyAfterStarts ?? 1),
  };
  if (opts.mutateStateOnStart) env.MUTATE_STATE_ON_START = "1";

  return {
    base,
    repo,
    stateRoot,
    snapshotDir,
    statusDir,
    stubLog,
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
async function runUpdate(args: string[]): Promise<{
  code: number;
  out: string;
}> {
  const proc = Bun.spawn(["bash", UPDATE_SH, ...args], {
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

function head(): string {
  return sh(fx.repo, "git rev-parse HEAD");
}

function stubCalls(): string[] {
  return existsSync(fx.stubLog)
    ? readFileSync(fx.stubLog, "utf8").trim().split("\n")
    : [];
}

function status(): Record<string, string> {
  return JSON.parse(readFileSync(join(fx.statusDir, "status.json"), "utf8"));
}

afterEach(() => {
  readyServer?.stop(true);
  readyServer = null;
  rmSync(fx.base, { recursive: true, force: true });
});

describe("update.sh happy path", () => {
  beforeEach(() => {
    fx = buildFixture({});
  });

  it("fetches the tag, builds, stops before snapshotting, starts, reports ok", async () => {
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.out).toContain("updated");
    expect(r.code).toBe(0);
    expect(head()).toBe(fx.newCommit);

    // stop strictly before start; exactly one of each.
    const svcOps = stubCalls().filter((l) => / (stop|start) /.test(l));
    expect(svcOps).toEqual([
      "systemctl --user stop isomux",
      "systemctl --user start isomux",
    ]);

    // The snapshot exists, is a valid tarball, and holds the state file.
    const snaps = readdirSync(fx.snapshotDir).filter((f) =>
      f.startsWith("pre-update-"),
    );
    expect(snaps.length).toBe(1);
    const listing = sh(
      fx.snapshotDir,
      `tar -tzf ${join(fx.snapshotDir, snaps[0])}`,
    );
    expect(listing).toContain(".isomux/users.json");

    // Install + build ran for the target.
    const bunOps = stubCalls().filter((l) => l.startsWith("bun"));
    expect(bunOps.some((l) => l.includes("install --frozen-lockfile"))).toBe(
      true,
    );
    expect(bunOps.some((l) => l.includes("run build:ui"))).toBe(true);

    expect(status().result).toBe("ok");
    // The installed updater copy was refreshed from the NEW checkout.
    expect(readFileSync(join(fx.base, "installed-updater"), "utf8")).toContain(
      "v-new",
    );
  });

  it("no-op when already on the target tag", async () => {
    sh(fx.repo, "git fetch -q --tags origin");
    sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already on");
    expect(stubCalls().filter((l) => / stop /.test(l))).toEqual([]);
  });
});

describe("update.sh validation", () => {
  beforeEach(() => {
    fx = buildFixture({});
  });

  it("refuses a non-CalVer target", async () => {
    const r = await runUpdate(["main"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("CalVer");
    expect(stubCalls()).toEqual([]);
    expect(head()).toBe(fx.oldCommit);
  });

  it("refuses an unknown tag, service untouched", async () => {
    const r = await runUpdate(["v2099.1.1"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(head()).toBe(fx.oldCommit);
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
    // service-user-writable checkout, absent upstream, must be refused —
    // the configured upstream is the only tag authority.
    sh(fx.repo, `git tag -a v2026.7.30 -m planted ${fx.oldCommit}`);
    const r = await runUpdate(["v2026.7.30"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
  });

  it("a tag that moved upstream is refused", async () => {
    // First update pins v2026.7.20 into the trust repo; then the tag is
    // force-moved upstream. The non-forced trust fetch must refuse it.
    expect((await runUpdate(["v2026.7.20"])).code).toBe(0);
    sh(
      fx.base,
      `git -C origin.git tag -f v2026.7.20 ${fx.oldCommit} 2>/dev/null || git -C origin.git update-ref refs/tags/v2026.7.20 ${fx.oldCommit}`,
    );
    const r = await runUpdate(["v2026.7.20", "--allow-downgrade"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not found at");
    expect(head()).toBe(fx.newCommit);
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

  it("warns about a bun pin mismatch before touching the checkout", async () => {
    fx = buildFixture({
      newFiles: {
        "package.json": JSON.stringify({
          name: "fake",
          packageManager: "bun@9.9.9",
        }),
      },
    });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).toBe(0);
    const warn = r.out.indexOf("pins bun@9.9.9");
    const checkout = r.out.indexOf("--- checkout");
    expect(warn).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(checkout);
  });
});

describe("update.sh downgrade guard", () => {
  beforeEach(() => {
    fx = buildFixture({ readyAfterStarts: 1 });
    // Make the CURRENT checkout the newer commit and target the older tag:
    // tag c1 as an older release on origin, sit at c2.
    sh(fx.repo, `git tag -a v2026.7.18 -m old ${fx.oldCommit}`);
    sh(fx.repo, "git push -q origin --tags");
    sh(fx.repo, "git tag -d v2026.7.18");
    sh(fx.repo, "git fetch -q --tags origin");
    sh(fx.repo, `git checkout -q --detach ${fx.newCommit}`);
  });

  it("refuses without --allow-downgrade, proceeds with it", async () => {
    const refused = await runUpdate(["v2026.7.18"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("--allow-downgrade");
    expect(head()).toBe(fx.newCommit);

    const r = await runUpdate(["v2026.7.18", "--allow-downgrade"]);
    expect(r.code).toBe(0);
    expect(head()).toBe(fx.oldCommit);
  });
});

describe("update.sh failure ladders", () => {
  it("failed install: restores old deps+UI, never touches the service", async () => {
    fx = buildFixture({ newFiles: { BREAK_INSTALL: "1" } });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(head()).toBe(fx.oldCommit);
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
    fx = buildFixture({ newFiles: { BREAK_BUILD: "1" } });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(head()).toBe(fx.oldCommit);
    expect(stubCalls().filter((l) => / (stop|start) /.test(l))).toEqual([]);
    expect(status().result).toBe("failed");
  });

  it("failed readiness: full rollback restores code AND pre-update state", async () => {
    // New version "migrates" state on start (the stub writes a marker into
    // the state root) and never becomes ready; readiness succeeds only from
    // the second start (the rolled-back old version).
    fx = buildFixture({ readyAfterStarts: 2, mutateStateOnStart: true });
    const r = await runUpdate(["v2026.7.20"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("rolled back");
    expect(head()).toBe(fx.oldCommit);

    // State root restored from the snapshot: original file back, migration
    // marker gone.
    expect(existsSync(join(fx.stateRoot, "users.json"))).toBe(true);
    expect(existsSync(join(fx.stateRoot, "migrated-marker"))).toBe(false);
    // The broken state was preserved for forensics, marker included.
    const broken = readdirSync(fx.snapshotDir).filter((f) =>
      f.startsWith("broken-"),
    );
    expect(broken.length).toBe(1);
    expect(existsSync(join(fx.snapshotDir, broken[0], "migrated-marker"))).toBe(
      true,
    );
    expect(status().result).toBe("failed");
    // Rolled-back service is up: stop, start (fails ready), stop, start.
    const svcOps = stubCalls().filter((l) => / (stop|start) /.test(l));
    expect(svcOps.at(-1)).toContain("start");
  });
});
