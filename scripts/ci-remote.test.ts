// scripts/ci-remote.sh: which machine runs CI for a commit, and which exit
// code becomes the verdict. ssh, bun and the remote's system tools are stubs;
// git, flock and jq are real. Zero LLM, no network.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "ci-remote.sh");
const HOOK = join(import.meta.dir, "..", ".githooks", "pre-push");
const REMOTE_ROOT = ".cache/isomux-ci-remote";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// --- local half ---------------------------------------------------------

type Local = {
  dir: string;
  repo: string;
  /** The remote's home directory; the stub ssh runs commands in it. */
  home: string;
  shas: [string, string];
  run(
    args: string[],
    opts?: { target?: string; stdin?: string; entry?: string },
  ): { status: number | null; out: string };
  /** One line per `bun` call: its arguments and the commit checked out. */
  bunCalls(): string[];
  /** One line per remote half started: its arguments. */
  remoteRuns(): string[];
  sshCalls(): string[];
};

function local(remoteCode: number, localCode = 0): Local {
  const dir = mkdtempSync(join(tmpdir(), "isomux-ci-remote-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(dir, "tmp"));
  git(dir, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.email", "probe@probe");
  git(repo, "config", "user.name", "Probe");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "two\n");
  git(repo, "commit", "-qam", "two");
  const second = git(repo, "rev-parse", "HEAD");

  // ssh: drops options, then runs the command in the remote's home. The
  // remote half itself is not run; it answers with remoteCode.
  stub(
    join(bin, "ssh"),
    `printf '%s\\n' "$*" >> "$FIX/ssh.log"
while [[ $1 == -o ]]; do shift 2; done
[[ -e $FIX/unreachable ]] && exit 255
shift
cd "$FIX/home" || exit 1
if [[ $1 == bash && $2 == -s ]]; then
  cat > "$FIX/remote-script"
  printf '%s\\n' "$*" >> "$FIX/remote.log"
  echo "remote output"
  exit ${remoteCode}
fi
exec bash -c "$*"`,
  );
  stub(
    join(bin, "bun"),
    `echo "$* $(git rev-parse HEAD)" >> "$FIX/bun.log"
exit ${localCode}`,
  );

  return {
    dir,
    repo,
    home,
    shas: [first, second],
    run(args, opts = {}) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
      }
      if (opts.target) git(repo, "config", "isomux.ciRemote", opts.target);
      const r = spawnSync("bash", [opts.entry ?? SCRIPT, ...args], {
        cwd: repo,
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: join(dir, "tmp"),
          FIX: dir,
          // Only the fixture repo's own config names a target.
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        input: opts.stdin ?? "",
        encoding: "utf8",
        timeout: 30_000,
      });
      return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
    },
    bunCalls: () => read(join(dir, "bun.log")).split("\n").filter(Boolean),
    remoteRuns: () => read(join(dir, "remote.log")).split("\n").filter(Boolean),
    sshCalls: () => read(join(dir, "ssh.log")).split("\n").filter(Boolean),
  };
}

const TARGET = "ci@ci-box";

describe("ci-remote, with no target", () => {
  it("runs bun run ci here, once, and never calls ssh", () => {
    const f = local(0, 1);
    const [first, second] = f.shas;
    const r = f.run(["--pre-push"], {
      entry: HOOK,
      stdin: `refs/heads/main ${second} refs/heads/main ${first}\nrefs/heads/x ${first} refs/heads/x ${first}\n`,
    });
    expect(r.status, r.out).toBe(1);
    expect(f.bunCalls()).toEqual([`run ci ${second}`]);
    expect(f.sshCalls()).toEqual([]);
  });
});

describe("ci-remote, with a target", () => {
  it("takes the remote green as the verdict and runs nothing here", () => {
    const f = local(0);
    const head = f.shas[1];
    const r = f.run([], { target: TARGET });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("remote output");
    expect(f.bunCalls()).toEqual([]);
    const [run] = f.remoteRuns();
    expect(run).toMatch(new RegExp(`^bash -s -- --remote ${head} \\S+$`));
    // The remote half is this script, and the commit is in the remote repo.
    expect(read(join(f.dir, "remote-script"))).toBe(
      readFileSync(SCRIPT, "utf8"),
    );
    const bare = join(f.home, REMOTE_ROOT, "repo.git");
    expect(git(bare, "cat-file", "-t", head)).toBe("commit");
    // The ref that carried it is gone once the run ends.
    expect(git(bare, "for-each-ref", "refs/ci/")).toBe("");
  });

  it("tests the commit it is given, not HEAD", () => {
    const f = local(0);
    const r = f.run(["HEAD~1"], { target: TARGET });
    expect(r.status, r.out).toBe(0);
    expect(f.remoteRuns()[0]).toContain(` ${f.shas[0]} `);
  });

  it("takes a remote red as the verdict and never falls back", () => {
    const f = local(1, 0);
    const r = f.run([], { target: TARGET });
    expect(r.status, r.out).toBe(1);
    expect(f.bunCalls()).toEqual([]);
  });

  it.each([
    [0, 0],
    [1, 1],
  ])(
    "runs here when the remote cannot run the suite (local exit %d)",
    (localCode, expected) => {
      const f = local(3, localCode);
      const r = f.run([], { target: TARGET });
      expect(r.status, r.out).toBe(expected);
      expect(f.remoteRuns()).toHaveLength(1);
      expect(f.bunCalls()).toEqual([`run ci ${f.shas[1]}`]);
    },
  );

  it("runs here when the remote is unreachable", () => {
    const f = local(0, 0);
    writeFileSync(join(f.dir, "unreachable"), "");
    const r = f.run([], { target: TARGET });
    expect(r.status, r.out).toBe(0);
    expect(f.remoteRuns()).toEqual([]);
    expect(f.bunCalls()).toEqual([`run ci ${f.shas[1]}`]);
  });

  it("does not run the pre-push hook for its own push", () => {
    const f = local(0);
    const hooks = join(f.dir, "hooks");
    mkdirSync(hooks);
    stub(join(hooks, "pre-push"), 'touch "$FIX/hook-ran"; exit 1');
    git(f.repo, "config", "core.hooksPath", hooks);
    const r = f.run([], { target: TARGET });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(f.dir, "hook-ran"))).toBe(false);
  });

  it("tests each pushed commit once from the hook and skips deletions", () => {
    const f = local(0);
    const [first, second] = f.shas;
    const zero = "0".repeat(40);
    const r = f.run([], {
      entry: HOOK,
      target: TARGET,
      stdin: [
        `refs/heads/main ${second} refs/heads/main ${first}`,
        `refs/tags/v1 ${second} refs/tags/v1 ${zero}`,
        `(delete) ${zero} refs/heads/gone ${first}`,
        `refs/heads/old ${first} refs/heads/old ${zero}`,
      ].join("\n"),
    });
    expect(r.status, r.out).toBe(0);
    expect(f.remoteRuns().map((line) => line.split(" ")[4])).toEqual([
      second,
      first,
    ]);
  });

  it("stops the hook at the first red commit", () => {
    const f = local(1);
    const [first, second] = f.shas;
    const r = f.run([], {
      entry: HOOK,
      target: TARGET,
      stdin: `refs/heads/a ${second} refs/heads/a ${first}\nrefs/heads/b ${first} refs/heads/b ${first}\n`,
    });
    expect(r.status, r.out).toBe(1);
    expect(f.remoteRuns()).toHaveLength(1);
  });

  it("runs nothing for a push that only deletes", () => {
    const f = local(1, 1);
    const zero = "0".repeat(40);
    const r = f.run([], {
      entry: HOOK,
      target: TARGET,
      stdin: `(delete) ${zero} refs/heads/gone ${f.shas[0]}\n`,
    });
    expect(r.status, r.out).toBe(0);
    expect(f.sshCalls()).toEqual([]);
    expect(f.bunCalls()).toEqual([]);
  });
});

// --- remote half --------------------------------------------------------

/** A port nothing listens on, for the script's Postgres-port check. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Remote = {
  home: string;
  root: string;
  sha: string;
  /** Runs the remote half for one run id. */
  run(id: string): { status: number | null; out: string; stderr: string };
  /** One line per bun call inside the sandbox. */
  bunCalls(): string[];
};

/**
 * The remote half against a remote home whose toolchain is stubs. `ci` is
 * the exit code of `bun run ci`; `docker` and `pg` fail the Docker check or
 * the Postgres start; `pin` is the bun version the commit names.
 */
async function remote(opts: {
  ci?: number;
  docker?: number;
  pg?: number;
  pin?: string;
  scopeStuck?: boolean;
}): Promise<Remote> {
  const dir = mkdtempSync(join(tmpdir(), "isomux-ci-remote-half-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const root = join(home, REMOTE_ROOT);
  const tools = join(root, "toolchain");
  const bin = join(dir, "bin");
  const src = join(dir, "src");
  for (const d of [bin, src]) mkdirSync(d, { recursive: true });

  // The commit under test.
  git(dir, "init", "-q", "-b", "main", src);
  git(src, "config", "user.email", "probe@probe");
  git(src, "config", "user.name", "Probe");
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ packageManager: `bun@${opts.pin ?? "1.4.2"}` }),
  );
  git(src, "add", ".");
  git(src, "commit", "-qm", "commit under test");
  const sha = git(src, "rev-parse", "HEAD");
  const bare = join(root, "repo.git");
  git(dir, "init", "-q", "--bare", bare);

  const nodeBin = join(tools, "node-v24.19.0-linux-x64", "bin");
  const bunDir = join(tools, "bun-1.4.2");
  const pgBin = join(
    tools,
    "pg-18.4.0-beta.17/node_modules/@embedded-postgres/linux-x64/native/bin",
  );
  for (const d of [nodeBin, bunDir, pgBin]) mkdirSync(d, { recursive: true });
  stub(join(nodeBin, "node"), "exit 0");
  stub(join(nodeBin, "docker"), `exit ${opts.docker ?? 0}`);
  stub(
    join(bunDir, "bun"),
    `[[ $1 == --version ]] && { echo 1.4.2; exit 0; }
echo "$* $(pwd)" >> "${dir}/bun.log"
[[ $* == "run ci" ]] && { echo "ci output"; exit ${opts.ci ?? 0}; }
exit 0`,
  );
  stub(join(pgBin, "initdb"), "exit 0");
  stub(join(pgBin, "postgres"), "cat >/dev/null; exit 0");
  stub(join(pgBin, "pg_ctl"), `exit ${opts.pg ?? 0}`);
  // systemd: the scope runs its command in place; is-active answers for the
  // scope this test leaves running, or for none.
  stub(
    join(bin, "systemd-run"),
    'while [[ $1 != -- ]]; do shift; done; shift; exec "$@"',
  );
  stub(
    join(bin, "systemctl"),
    `[[ $2 == is-active ]] && exit ${opts.scopeStuck ? 0 : 3}
exit 0`,
  );

  // The suite's Postgres port is busy on a dev box; the check needs a free one.
  const port = await freePort();
  const text = readFileSync(SCRIPT, "utf8");
  const patched = text.replace(/^PG_PORT=5433$/m, `PG_PORT=${port}`);
  expect(patched).not.toBe(text);
  const script = join(dir, "ci-remote.sh");
  writeFileSync(script, patched);

  return {
    home,
    root,
    sha,
    run(id) {
      // The script's own cleanup removes this; a test whose cleanup is meant
      // to fail must not leave it behind.
      dirs.push(`/tmp/icr-${id.split("-")[1]}`);
      git(src, "push", "-q", bare, `${sha}:refs/ci/${id}`);
      const r = spawnSync("bash", ["-s", "--", "--remote", sha, id], {
        cwd: home,
        input: readFileSync(script),
        env: {
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          HOME: home,
          USER: process.env.USER ?? "probe",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      return {
        status: r.status,
        out: `${r.stdout}\n${r.stderr}`,
        stderr: r.stderr,
      };
    },
    bunCalls: () =>
      read(join(dir, "bun.log"))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" /")[0]),
  };
}

function runId(): string {
  return `20261006T000000Z-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
}

describe("ci-remote, the remote half", () => {
  it("exits 0 for a green run and leaves only its cache", async () => {
    const r = await remote({ ci: 0 });
    const id = runId();
    const res = r.run(id);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("ci output");
    expect(r.bunCalls()).toEqual([
      "install --frozen-lockfile",
      "install --cwd control-plane/web --frozen-lockfile",
      "run ci",
    ]);
    expect(readdirSync(join(r.root, "runs"))).toEqual([]);
    expect(existsSync(`/tmp/icr-${id.split("-")[1]}`)).toBe(false);
    const bare = join(r.root, "repo.git");
    expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/ci-base",
    );
  });

  it.each([1, 3, 124])(
    "exits 1 when bun run ci ran and exited %d",
    async (code) => {
      const r = await remote({ ci: code });
      const res = r.run(runId());
      expect(res.status, res.out).toBe(1);
    },
  );

  it.each([
    [1, 1],
    [0, 0],
  ])(
    "keeps the verdict of bun run ci exit %d when its cleanup fails, and says so",
    async (ci, verdict) => {
      const r = await remote({ ci, scopeStuck: true });
      const id = runId();
      const run = join(r.root, "runs", id);
      const res = r.run(id);
      // CI ran, and its processes outlived the cleanup.
      expect(r.bunCalls()).toContain("run ci");
      expect(existsSync(run)).toBe(true);
      expect(existsSync(`/tmp/icr-${id.split("-")[1]}`)).toBe(true);
      expect(res.stderr).toContain(run);
      expect(res.status, res.out).toBe(verdict);
    },
    30_000,
  );

  it.each([
    ["Docker is not running", { docker: 1 }],
    ["Postgres does not start", { pg: 1 }],
    ["the commit pins another bun", { pin: "1.3.12" }],
  ])("exits 3 without running CI when %s", async (_, opts) => {
    const r = await remote(opts);
    const res = r.run(runId());
    expect(res.status, res.out).toBe(3);
    expect(r.bunCalls()).not.toContain("run ci");
    expect(readdirSync(join(r.root, "runs"))).toEqual([]);
  });

  it("removes a run that was killed before its own cleanup", async () => {
    const r = await remote({ ci: 0 });
    const stale = runId();
    const staleTmp = `/tmp/icr-${stale.split("-")[1]}`;
    mkdirSync(join(r.root, "runs", stale, "src"), { recursive: true });
    mkdirSync(staleTmp);
    dirs.push(staleTmp);
    const res = r.run(runId());
    expect(res.status, res.out).toBe(0);
    expect(readdirSync(join(r.root, "runs"))).toEqual([]);
    expect(existsSync(staleTmp)).toBe(false);
  });
});
