// scripts/update.sh sync_system_deps — the step that lets an update deliver
// system dependencies the target release newly requires. The function is
// extracted from the updater with sed (same approach as
// deploy/install-resolve-ref.test.ts) and driven against a real git repo
// standing in for the root-owned trust repo, with a minimal PATH so
// "this box has no apt" is a fact of the fixture rather than of the machine
// running the tests. The installer it runs is a fake that records how it was
// called, so no test installs anything. Zero LLM.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";

const UPDATE_SH = new URL("./update.sh", import.meta.url).pathname;

let base: string;
let toolsDir: string;

// A PATH with exactly the tools sync_system_deps uses — and nothing else, so
// the no-apt branch is testable on a box that does have apt.
function buildToolsDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  // sed is the harness's own extraction tool; the rest is what the function
  // under test calls.
  for (const tool of [
    "sed",
    "mktemp",
    "chmod",
    "git",
    "grep",
    "rm",
    "bash",
    "env",
  ]) {
    const path = execSync(`command -v ${tool}`, { shell: "/bin/bash" })
      .toString()
      .trim();
    symlinkSync(path, join(dir, tool));
  }
}

// A repo standing in for $STATUS_DIR/trust.git: one commit whose
// deploy/install.sh is the fake installer described by `installer`.
function buildTrustRepo(name: string, installer: string | null): string {
  const repo = join(base, name);
  mkdirSync(repo);
  const run = (cmd: string) =>
    execSync(cmd, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  run("git init -q -b main");
  run("git config user.email t@t && git config user.name T");
  writeFileSync(join(repo, "README.md"), "x\n");
  if (installer !== null) {
    mkdirSync(join(repo, "deploy"));
    writeFileSync(join(repo, "deploy", "install.sh"), installer);
  }
  run("git add . && git commit -qm c1");
  return repo;
}

// The fake target installer: carries the protocol sentinel, records the flag
// and the environment it was handed, then succeeds or fails.
// The log path is baked in rather than read from the environment: the updater
// runs the installer with `env -i`, so nothing the caller exports reaches it.
function fakeInstaller(opts: { fails?: boolean } = {}): string {
  return `#!/usr/bin/env bash
ISOMUX_INSTALL_DEPS_MODE_VERSION=1
{
  printf 'ISOMUX_DEPS_ONLY=%s\\n' "\${ISOMUX_DEPS_ONLY:-unset}"
  printf 'DRY_RUN=%s\\n' "\${DRY_RUN:-unset}"
  printf 'INSTALL_CALLBACK_URL=%s\\n' "\${INSTALL_CALLBACK_URL:-unset}"
} > "${runLogPath()}"
${opts.fails ? 'echo "deps broken" >&2; exit 1' : "exit 0"}
`;
}

function runLogPath(): string {
  return join(base, "deps-run.log");
}

function syncDeps(opts: {
  trustRepo: string;
  serviceKind?: string;
  withApt?: boolean;
  hostileEnv?: boolean;
}): { code: number; out: string; ran: string | null } {
  const runLog = runLogPath();
  rmSync(runLog, { force: true });
  const bin = join(base, "bin");
  rmSync(bin, { recursive: true, force: true });
  buildToolsDir(bin);
  if (opts.withApt ?? true) {
    writeFileSync(join(bin, "apt-get"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "apt-get"), 0o755);
  }
  const commit = execSync("git rev-parse HEAD", { cwd: opts.trustRepo })
    .toString()
    .trim();
  const script = `
eval "$(sed -n '/^sync_system_deps()/,/^}/p' "$UPDATE_SH")"
log() { echo "LOG: $*"; }
sync_system_deps "${commit}"
echo "rc=$?"
`;
  const res = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: bin,
      UPDATE_SH,
      SERVICE_KIND: opts.serviceKind ?? "system",
      TRUST_REPO: opts.trustRepo,
      TARGET_TAG: "v2026.7.30",
      ...(opts.hostileEnv
        ? { DRY_RUN: "1", INSTALL_CALLBACK_URL: "https://attacker.example" }
        : {}),
    },
    encoding: "utf8",
  });
  return {
    code: res.status ?? -1,
    out: `${res.stdout}\n${res.stderr}`,
    ran: existsSync(runLog) ? readFileSync(runLog, "utf8").trim() : null,
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-deps-sync-test-"));
  toolsDir = join(base, "bin");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  expect(toolsDir).toBeTruthy();
});

describe("update.sh system-dependency sync", () => {
  it("runs the TARGET release's installer in deps-only mode", () => {
    const repo = buildTrustRepo("trust-ok", fakeInstaller());
    const r = syncDeps({ trustRepo: repo });
    expect(r.ran).toContain("ISOMUX_DEPS_ONLY=1");
    expect(r.out).toContain("installing v2026.7.30's system dependencies");
    expect(r.out).toContain("rc=0");
  });

  it("hands the installer a minimal environment, not the caller's", () => {
    // An inherited DRY_RUN would make the installer print instead of install
    // and still exit 0 — a dependency sync that reports success and did
    // nothing. INSTALL_CALLBACK_URL would post about an install nobody ran.
    const repo = buildTrustRepo("trust-env", fakeInstaller());
    const r = syncDeps({ trustRepo: repo, hostileEnv: true });
    expect(r.ran).toContain("ISOMUX_DEPS_ONLY=1");
    expect(r.ran).toContain("DRY_RUN=unset");
    expect(r.ran).toContain("INSTALL_CALLBACK_URL=unset");
  });

  it("propagates a dependency failure to the caller", () => {
    const repo = buildTrustRepo("trust-fail", fakeInstaller({ fails: true }));
    const r = syncDeps({ trustRepo: repo });
    expect(r.ran).toContain("ISOMUX_DEPS_ONLY=1");
    expect(r.out).toContain("rc=1");
  });

  it("skips on a user-kind box, which has no root", () => {
    const repo = buildTrustRepo("trust-user", fakeInstaller());
    const r = syncDeps({ trustRepo: repo, serviceKind: "user" });
    expect(r.ran).toBeNull();
    expect(r.out).toContain("SERVICE_KIND=user: skipping");
    expect(r.out).toContain("rc=0");
  });

  it("skips on a box without apt rather than failing its updates", () => {
    const repo = buildTrustRepo("trust-noapt", fakeInstaller());
    const r = syncDeps({ trustRepo: repo, withApt: false });
    expect(r.ran).toBeNull();
    expect(r.out).toContain(
      "warning: system dependencies were not synced (no apt-get on this box)",
    );
    expect(r.out).toContain("rc=0");
  });

  it("skips a target release whose installer predates the deps-only mode", () => {
    const repo = buildTrustRepo(
      "trust-old",
      "#!/usr/bin/env bash\necho old installer\n",
    );
    const r = syncDeps({ trustRepo: repo });
    expect(r.ran).toBeNull();
    expect(r.out).toContain("has no deps-only mode");
    expect(r.out).toContain("rc=0");
  });

  it("skips an installer that only MENTIONS the mode", () => {
    // The probe has to be the exact protocol assignment. An installer whose
    // header documents the flag but never branches on it would be run as root
    // with no deps-only behavior at all: a full install on a live box.
    const repo = buildTrustRepo(
      "trust-mention",
      `#!/usr/bin/env bash
# ISOMUX_DEPS_ONLY=1 installs only the system dependencies.
# ISOMUX_INSTALL_DEPS_MODE_VERSION=1 is the marker the updater looks for.
echo "  ISOMUX_INSTALL_DEPS_MODE_VERSION=1"
touch ${runLogPath()}
`,
    );
    const r = syncDeps({ trustRepo: repo });
    expect(r.ran).toBeNull();
    expect(r.out).toContain("has no deps-only mode");
    expect(r.out).toContain("rc=0");
  });

  it("leaves no temp installer behind", () => {
    const repo = buildTrustRepo("trust-cleanup", fakeInstaller());
    syncDeps({ trustRepo: repo });
    expect(
      readdirSync("/tmp").filter((f) => f.startsWith("isomux-deps.")),
    ).toEqual([]);
  });

  it("skips a target release that carries no installer at all", () => {
    const repo = buildTrustRepo("trust-none", null);
    const r = syncDeps({ trustRepo: repo });
    expect(r.ran).toBeNull();
    expect(r.out).toContain("carries no deploy/install.sh");
    expect(r.out).toContain("rc=0");
  });

  it("never reads the installer from the service checkout", () => {
    // The trust repo is the only source: a REPO_DIR planted by the service
    // user (agents run shell as it) must not be consulted.
    expect(readFileSync(UPDATE_SH, "utf8")).toContain(
      'git -C "$TRUST_REPO" cat-file -p "$target:deploy/install.sh"',
    );
  });
});
