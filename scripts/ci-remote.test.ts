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
  /** With merge, stderr goes into stdout as in a caller's `> log 2>&1`. */
  run(
    args: string[],
    opts?: { target?: string; stdin?: string; entry?: string; merge?: boolean },
  ): { status: number | null; out: string };
  /** One line per `bun` call: its arguments and the commit checked out. */
  bunCalls(): string[];
  /** One line per remote half started: its arguments. */
  remoteRuns(): string[];
  sshCalls(): string[];
  /** The files the script left in its TMPDIR. */
  logs(): string[];
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
  // remote half itself (CI or gate) is not run; it answers with remoteCode.
  // Any other piped script runs for real. With push-fails, every push fails.
  stub(
    join(bin, "ssh"),
    `printf '%s\\n' "$*" >> "$FIX/ssh.log"
while [[ $1 == -o ]]; do shift 2; done
[[ -e $FIX/unreachable ]] && exit 255
shift
cd "$FIX/home" || exit 1
[[ -e $FIX/push-fails && $* == *receive-pack* ]] && { echo "push refused" >&2; exit 1; }
if [[ $1 == bash && $2 == -s && ( $4 == --remote || $4 == --remote-gate ) ]]; then
  cat > "$FIX/remote-script"
  printf '%s\\n' "$*" >> "$FIX/remote.log"
  echo "remote output for $5"
  [[ -e $FIX/red-$5 ]] && exit 1
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
      const entry = [opts.entry ?? SCRIPT, ...args];
      const argv = opts.merge
        ? ["-c", 'exec bash "$@" 2>&1', "_", ...entry]
        : entry;
      const r = spawnSync("bash", argv, {
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
    logs: () => readdirSync(join(dir, "tmp")).sort(),
  };
}

const TARGET = "ci@ci-box";

// A red run keeps its log, and the verdict (the last line) names it.
function keptLog(f: Local, out: string, prefix: string): string {
  const logs = f.logs();
  expect(logs, out).toHaveLength(1);
  expect(logs[0]).toMatch(new RegExp(`^${prefix}-.+\\.log$`));
  const path = join(f.dir, "tmp", logs[0]!);
  expect(out.trim().split("\n").at(-1)).toContain(path);
  return path;
}

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
    keptLog(f, r.out, "isomux-pre-push");
  });

  it("deletes its log after a green run", () => {
    const f = local(0, 0);
    const r = f.run(["--pre-push"], {
      entry: HOOK,
      stdin: `refs/heads/main ${f.shas[1]} refs/heads/main ${f.shas[0]}\n`,
    });
    expect(r.status, r.out).toBe(0);
    expect(f.bunCalls()).toEqual([`run ci ${f.shas[1]}`]);
    expect(f.logs()).toEqual([]);
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
    // A green has nothing to keep: the caller has the output.
    expect(f.logs()).toEqual([]);
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
    expect(read(keptLog(f, r.out, "isomux-ci"))).toContain("remote output");
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
      if (expected === 0) expect(f.logs()).toEqual([]);
      else keptLog(f, r.out, "isomux-ci");
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

  it("keeps only the log of the red commit when the hook tests several", () => {
    const f = local(0);
    const [first, second] = f.shas;
    // The hook tests second, then first; the second one tested is red.
    writeFileSync(join(f.dir, `red-${first}`), "");
    const r = f.run([], {
      entry: HOOK,
      target: TARGET,
      stdin: `refs/heads/a ${second} refs/heads/a ${first}\nrefs/heads/b ${first} refs/heads/b ${first}\n`,
    });
    expect(r.status, r.out).toBe(1);
    expect(f.remoteRuns().map((line) => line.split(" ")[4])).toEqual([
      second,
      first,
    ]);
    const log = read(keptLog(f, r.out, "isomux-ci"));
    expect(log).toContain(first);
    expect(log).not.toContain(second);
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

// --- gate mode, local half ---------------------------------------------------

/** Adds a test file and a control-plane test file, commits, returns HEAD. */
function gateCommit(f: Local): string {
  for (const d of ["server", "control-plane"])
    mkdirSync(join(f.repo, d), { recursive: true });
  writeFileSync(join(f.repo, "server", "a.test.ts"), "// a\n");
  writeFileSync(join(f.repo, "control-plane", "store.test.ts"), "// pg\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-qm", "tests");
  return git(f.repo, "rev-parse", "HEAD");
}

// Every gate log has one frame, whatever the outcome: the tested sha on the
// first line, the exit code on the last, so a log counts as gate evidence.
function expectFrame(
  r: { status: number | null; out: string },
  sha: string,
  code: number,
): void {
  const lines = r.out.trimEnd().split("\n");
  expect(lines[0], r.out).toBe(sha);
  expect(lines.at(-1), r.out).toBe(`exit=${code}`);
  expect(r.status, r.out).toBe(code);
}

describe("ci-remote --gate, the local half", () => {
  it("runs the gate for HEAD on the target and keeps no local file", () => {
    const f = local(0);
    const head = gateCommit(f);
    const r = f.run(["--gate", "server/a.test.ts"], {
      target: TARGET,
      merge: true,
    });
    expectFrame(r, head, 0);
    expect(r.out).toContain("remote output");
    const runs = f.remoteRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(
      new RegExp(
        `^bash -s -- --remote-gate ${head} \\S+ -- server/a\\.test\\.ts$`,
      ),
    );
    const bare = join(f.home, REMOTE_ROOT, "repo.git");
    expect(git(bare, "cat-file", "-t", head)).toBe("commit");
    expect(f.bunCalls()).toEqual([]);
    // The caller redirects the output; the script writes no log of its own.
    expect(f.logs()).toEqual([]);
  });

  it("sends no test arguments when it is given none", () => {
    const f = local(0);
    const head = gateCommit(f);
    const r = f.run(["--gate"], { target: TARGET, merge: true });
    expectFrame(r, head, 0);
    expect(f.remoteRuns()[0]).toMatch(
      new RegExp(`^bash -s -- --remote-gate ${head} \\S+( --)?$`),
    );
  });

  it.each([
    ["red", 1, 1],
    ["no verdict", 3, 3],
  ])(
    "relays a remote %s and never runs anything here",
    (_, remoteCode, expected) => {
      const f = local(remoteCode, 0);
      const head = gateCommit(f);
      const r = f.run(["--gate", "server/a.test.ts"], {
        target: TARGET,
        merge: true,
      });
      expectFrame(r, head, expected);
      expect(f.remoteRuns()).toHaveLength(1);
      expect(f.bunCalls()).toEqual([]);
      expect(f.logs()).toEqual([]);
    },
  );

  it("gives no verdict, and runs nothing here, when the remote is unreachable", () => {
    const f = local(0, 0);
    const head = gateCommit(f);
    writeFileSync(join(f.dir, "unreachable"), "");
    const r = f.run(["--gate", "server/a.test.ts"], {
      target: TARGET,
      merge: true,
    });
    expectFrame(r, head, 3);
    expect(f.remoteRuns()).toEqual([]);
    expect(f.bunCalls()).toEqual([]);
  });

  it("gives no verdict, and runs nothing here, with no target", () => {
    const f = local(0, 0);
    const head = gateCommit(f);
    const r = f.run(["--gate", "server/a.test.ts"], { merge: true });
    expectFrame(r, head, 3);
    expect(f.sshCalls()).toEqual([]);
    expect(f.bunCalls()).toEqual([]);
  });

  // Each case breaks one rule and names its offender. bun reads a bare
  // argument as a substring filter, so only a tracked path outside
  // control-plane/ keeps the run off the Postgres that CI holds there.
  const refusals: [string, string[], string, "" | "dirty" | "untracked"][] = [
    [
      "a tracked file differs from HEAD",
      ["server/a.test.ts"],
      "f.txt",
      "dirty",
    ],
    [
      "an argument is under control-plane/",
      ["control-plane/store.test.ts"],
      "control-plane/store.test.ts",
      "",
    ],
    ["an argument holds control-plane/", ["."], "control-plane/", ""],
    [
      "an argument is not a tracked path",
      ["store.test.ts"],
      "store.test.ts",
      "",
    ],
    [
      "an argument is untracked",
      ["server/new.test.ts"],
      "server/new.test.ts",
      "untracked",
    ],
    [
      "an argument is a flag",
      ["--timeout", "server/a.test.ts"],
      "--timeout",
      "",
    ],
  ];
  it.each(refusals)(
    "refuses, sending nothing, when %s",
    (_, args, offender, setup) => {
      const f = local(0, 0);
      const head = gateCommit(f);
      if (setup === "dirty") writeFileSync(join(f.repo, "f.txt"), "edited\n");
      if (setup === "untracked")
        writeFileSync(join(f.repo, "server", "new.test.ts"), "// new\n");
      const r = f.run(["--gate", ...args], { target: TARGET, merge: true });
      expectFrame(r, head, 2);
      expect(r.out).toContain(offender);
      expect(f.sshCalls()).toEqual([]);
      expect(f.bunCalls()).toEqual([]);
    },
  );

  it("accepts a tracked directory with no control-plane file in it", () => {
    const f = local(0);
    const head = gateCommit(f);
    const r = f.run(["--gate", "server"], { target: TARGET, merge: true });
    expectFrame(r, head, 0);
    expect(f.remoteRuns()).toHaveLength(1);
  });
});

// --- push repair, both modes ------------------------------------------------

/**
 * A remote bare repo as a crash left it: an empty loose object, and refs
 * that point at it (the base refs and a killed run's ref). refs/heads/keep points
 * at a valid commit and must survive the repair.
 */
function corruptRemote(f: Local): {
  bare: string;
  empty: string;
  inFlight: string[];
} {
  const bare = join(f.home, REMOTE_ROOT, "repo.git");
  git(f.dir, "init", "-q", "--bare", bare);
  git(f.repo, "push", "-q", bare, `${f.shas[0]}:refs/heads/keep`);
  const bad = "0123456789abcdef0123456789abcdef01234567";
  const empty = join(bare, "objects", bad.slice(0, 2), bad.slice(2));
  mkdirSync(join(bare, "objects", bad.slice(0, 2)), { recursive: true });
  writeFileSync(empty, "");
  for (const ref of ["refs/ci-base", "refs/gate-base", "refs/ci/old-run"]) {
    mkdirSync(join(bare, ref, ".."), { recursive: true });
    writeFileSync(join(bare, ref), `${bad}\n`);
  }
  // Empty files that a push in progress writes: a loose object before its
  // rename, a pack before index-pack fills it, and the quarantine of a
  // receive-pack. Another lane can push while a repair runs.
  const inFlight = [
    join(bare, "objects", bad.slice(0, 2), "tmp_obj_AbC123"),
    join(bare, "objects", "pack", "tmp_pack_AbC123"),
    join(bare, "objects", "incoming-AbC123", bad.slice(0, 2), bad.slice(2)),
  ];
  for (const file of inFlight) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  // The fixture breaks a push as the 2026-10-23 crash did.
  const probe = spawnSync(
    "git",
    ["push", "-q", bare, `${f.shas[1]}:refs/probe`],
    { cwd: f.repo, encoding: "utf8" },
  );
  expect(probe.status, probe.stderr).not.toBe(0);
  return { bare, empty, inFlight };
}

const receivePacks = (f: Local) =>
  f.sshCalls().filter((line) => line.includes("receive-pack")).length;

describe("ci-remote, push repair", () => {
  const modes: [string, string[]][] = [
    ["ci", []],
    ["gate", ["--gate"]],
  ];
  it.each(modes)(
    "%s: removes the empty object and the refs it broke, then pushes",
    (_, mode) => {
      const f = local(0, 0);
      const { bare, empty, inFlight } = corruptRemote(f);
      const r = f.run([...mode], { target: TARGET, merge: true });
      expect(r.status, r.out).toBe(0);
      expect(f.remoteRuns()).toHaveLength(1);
      expect(f.bunCalls()).toEqual([]);
      expect(existsSync(empty)).toBe(false);
      // Only a final object name is never empty; another push's files stay.
      for (const file of inFlight) expect(existsSync(file), file).toBe(true);
      const refs = git(bare, "for-each-ref", "--format=%(refname)").split("\n");
      expect(refs).toContain("refs/heads/keep");
      for (const ref of ["refs/ci-base", "refs/gate-base", "refs/ci/old-run"])
        expect(refs).not.toContain(ref);
      expect(git(bare, "cat-file", "-t", f.shas[1])).toBe("commit");
      // The repair is visible: it names what it deleted.
      if (mode.length) expect(r.out).toContain("refs/ci-base");
    },
  );

  it("gate: a second push failure is final, with no verdict and no local run", () => {
    const f = local(0, 0);
    writeFileSync(join(f.dir, "push-fails"), "");
    const r = f.run(["--gate"], { target: TARGET, merge: true });
    expectFrame(r, f.shas[1], 3);
    expect(receivePacks(f)).toBe(2);
    expect(f.remoteRuns()).toEqual([]);
    expect(f.bunCalls()).toEqual([]);
  });

  it("ci: a second push failure falls back to a run here, as before", () => {
    const f = local(0, 0);
    writeFileSync(join(f.dir, "push-fails"), "");
    const r = f.run([], { target: TARGET });
    expect(r.status, r.out).toBe(0);
    expect(receivePacks(f)).toBe(2);
    expect(f.remoteRuns()).toEqual([]);
    expect(f.bunCalls()).toEqual([`run ci ${f.shas[1]}`]);
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
  /** The directory each bun call ran in, in call order. */
  bunDirs(): string[];
  /** Nanosecond timestamps of the bun calls, in call order. */
  bunTimes(): bigint[];
  /** Runs the gate half for one run id, with its test arguments. */
  gate(id: string, args: string[]): { status: number | null; out: string };
  /** The same, without waiting: for runs that overlap. */
  gateAsync(
    id: string,
    args: string[],
  ): Promise<{ status: number; out: string }>;
  /** The fixture directory: block-tsc and unblock live here. */
  dir: string;
  systemctlCalls(): string[];
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
  /** bun calls ("x tsc --noEmit", "run build:ui", ...) that exit 1. */
  fail?: string[];
  /** Replaces the script's GATE_WAIT (seconds). */
  gateWait?: number;
}): Promise<Remote> {
  const dir = mkdtempSync(join(tmpdir(), "isomux-ci-remote-half-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const root = join(home, REMOTE_ROOT);
  const tools = join(root, "toolchain");
  const bin = join(dir, "bin");
  const src = join(dir, "src");
  for (const d of [bin, src]) mkdirSync(d, { recursive: true });
  // The toolchain versions come from the script, so a bump edits the script only.
  const text = readFileSync(SCRIPT, "utf8");
  const pinOf = (name: string) => {
    const m = new RegExp(`^${name}=(\\S+)$`, "m").exec(text);
    if (!m) throw new Error(`ci-remote.sh has no ${name}`);
    return m[1];
  };
  const bunVersion = pinOf("BUN_VERSION");

  // The commit under test.
  git(dir, "init", "-q", "-b", "main", src);
  git(src, "config", "user.email", "probe@probe");
  git(src, "config", "user.name", "Probe");
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ packageManager: `bun@${opts.pin ?? bunVersion}` }),
  );
  mkdirSync(join(src, "server"));
  writeFileSync(join(src, "server", "a.test.ts"), "// a\n");
  git(src, "add", ".");
  git(src, "commit", "-qm", "commit under test");
  const sha = git(src, "rev-parse", "HEAD");
  const bare = join(root, "repo.git");
  git(dir, "init", "-q", "--bare", bare);

  const nodeBin = join(tools, `node-${pinOf("NODE_VERSION")}-linux-x64`, "bin");
  const bunDir = join(tools, `bun-${bunVersion}`);
  const pgBin = join(
    tools,
    `pg-${pinOf("PG_VERSION")}/node_modules/@embedded-postgres/linux-x64/native/bin`,
  );
  for (const d of [nodeBin, bunDir, pgBin]) mkdirSync(d, { recursive: true });
  stub(join(nodeBin, "node"), "exit 0");
  stub(join(nodeBin, "docker"), `exit ${opts.docker ?? 0}`);
  stub(
    join(bunDir, "bun"),
    `[[ $1 == --version ]] && { echo ${bunVersion}; exit 0; }
echo "$* $(pwd)" >> "${dir}/bun.log"
date +%s%N >> "${dir}/bun-times"
[[ $* == "run ci" ]] && { echo "ci output"; exit ${opts.ci ?? 0}; }
# With block-tsc, tsc waits for unblock (at most 20 s).
if [[ $* == *"tsc --noEmit"* && -e "${dir}/block-tsc" ]]; then
  for _ in $(seq 200); do [[ -e "${dir}/unblock" ]] && break; sleep 0.1; done
fi
${(opts.fail ?? []).map((c) => `[[ $* == "${c}" ]] && exit 1`).join("\n")}
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
    `echo "$*" >> "${dir}/systemctl.log"
[[ $2 == is-active ]] && exit ${opts.scopeStuck ? 0 : 3}
exit 0`,
  );

  // The suite's Postgres port is busy on a dev box; the check needs a free one.
  const port = await freePort();
  let patched = text.replace(/^PG_PORT=5433$/m, `PG_PORT=${port}`);
  expect(patched).not.toBe(text);
  if (opts.gateWait !== undefined) {
    const before = patched;
    patched = patched.replace(/^GATE_WAIT=\d+$/m, `GATE_WAIT=${opts.gateWait}`);
    if (patched === before)
      throw new Error("ci-remote.sh has no GATE_WAIT=<seconds>");
  }
  const script = join(dir, "ci-remote.sh");
  writeFileSync(script, patched);

  // TMPDIR keeps anything that ignores the script's own temp paths in the
  // fixture.
  mkdirSync(join(dir, "tmp"));
  const remoteEnv = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    USER: process.env.USER ?? "probe",
    TMPDIR: join(dir, "tmp"),
  };

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
    bunDirs: () =>
      read(join(dir, "bun.log"))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf(" /") + 1)),
    bunTimes: () =>
      read(join(dir, "bun-times"))
        .split("\n")
        .filter(Boolean)
        .map((t) => BigInt(t)),
    gate(id, args) {
      dirs.push(`/tmp/igr-${id.split("-")[1]}`);
      git(src, "push", "-q", bare, `${sha}:refs/gate/${id}`);
      const r = spawnSync(
        "bash",
        [
          "-c",
          'exec bash "$@" 2>&1',
          "_",
          "-s",
          "--",
          "--remote-gate",
          sha,
          id,
          "--",
          ...args,
        ],
        {
          cwd: home,
          input: readFileSync(script),
          env: remoteEnv,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      return { status: r.status, out: r.stdout };
    },
    async gateAsync(id, args) {
      dirs.push(`/tmp/igr-${id.split("-")[1]}`);
      git(src, "push", "-q", bare, `${sha}:refs/gate/${id}`);
      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          'exec bash "$@" 2>&1',
          "_",
          "-s",
          "--",
          "--remote-gate",
          sha,
          id,
          "--",
          ...args,
        ],
        {
          cwd: home,
          stdin: readFileSync(script),
          env: remoteEnv,
          stdout: "pipe",
        },
      );
      const timer = setTimeout(() => proc.kill(), 30_000);
      const [out, status] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { status, out };
    },
    dir,
    systemctlCalls: () =>
      read(join(dir, "systemctl.log")).split("\n").filter(Boolean),
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

// --- gate mode, remote half ---------------------------------------------------

const INSTALLS = [
  "install --frozen-lockfile",
  "install --cwd control-plane/web --frozen-lockfile",
];
const TSC = "x tsc --noEmit";

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const count = (lines: string[], line: string) =>
  lines.filter((l) => l === line).length;

/**
 * A process that holds the CI lock until unblock appears (at most 20 s).
 * Wrapped, because an async function would await the returned promise.
 */
async function holdCiLock(r: Remote): Promise<{ exited: Promise<number> }> {
  const held = join(r.dir, "lock-held");
  const proc = Bun.spawn([
    "flock",
    join(r.root, "lock"),
    "bash",
    "-c",
    `touch "${held}"; for _ in $(seq 200); do [[ -e "${r.dir}/unblock" ]] && break; sleep 0.1; done; date +%s%N > "${r.dir}/lock-released"`,
  ]);
  await until(() => existsSync(held), "the CI lock");
  return { exited: proc.exited };
}

describe("ci-remote --remote-gate, the remote half", () => {
  it("installs, runs tsc, builds the UI and tests the given paths, then cleans up", async () => {
    const r = await remote({});
    const id = runId();
    const res = r.gate(id, ["server/a.test.ts"]);
    expect(res.status, res.out).toBe(0);
    expect(r.bunCalls()).toEqual([
      ...INSTALLS,
      TSC,
      "run build:ui",
      // ./ makes bun read a path, not a substring filter.
      "test ./server/a.test.ts",
    ]);
    // Every step ran in the checkout of slot 1.
    for (const d of r.bunDirs())
      expect(d).toBe(join(r.root, "gate-runs", "slot-1", "src"));
    const runs = join(r.root, "gate-runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    expect(existsSync(`/tmp/igr-${id.split("-")[1]}`)).toBe(false);
    const bare = join(r.root, "repo.git");
    expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/gate-base",
    );
  });

  it("runs tsc only when it is given no paths", async () => {
    const r = await remote({});
    const res = r.gate(runId(), []);
    expect(res.status, res.out).toBe(0);
    expect(r.bunCalls()).toEqual([...INSTALLS, TSC]);
  });

  it.each([
    [TSC, [TSC, "run build:ui", "test ./server/a.test.ts"]],
    [
      "test ./server/a.test.ts",
      [TSC, "run build:ui", "test ./server/a.test.ts"],
    ],
    ["run build:ui", [TSC, "run build:ui"]],
  ])("is red when %s fails", async (failing, reached) => {
    // tsc and the tests are independent: either runs when the other fails.
    // The tests need the built UI, so they may be skipped when the build fails.
    const r = await remote({ fail: [failing] });
    const res = r.gate(runId(), ["server/a.test.ts"]);
    expect(res.status, res.out).toBe(1);
    for (const step of reached) expect(r.bunCalls()).toContain(step);
  });

  it("gives no verdict when the install fails", async () => {
    const r = await remote({ fail: [INSTALLS[0]!] });
    const res = r.gate(runId(), ["server/a.test.ts"]);
    expect(res.status, res.out).toBe(3);
    expect(r.bunCalls()).not.toContain(TSC);
  });

  it("waits while CI holds its lock, and starts after it", async () => {
    const r = await remote({});
    const released = await holdCiLock(r);
    const run = r.gateAsync(runId(), []);
    await Bun.sleep(1500);
    expect(r.bunCalls()).toEqual([]);
    writeFileSync(join(r.dir, "unblock"), "");
    expect(await released.exited).toBe(0);
    const res = await run;
    expect(res.status, res.out).toBe(0);
    const releasedAt = BigInt(read(join(r.dir, "lock-released")).trim());
    expect(r.bunTimes()[0]! > releasedAt).toBe(true);
  }, 20_000);

  it("does not hold up CI, and CI leaves the running gate alone", async () => {
    const r = await remote({ ci: 0 });
    writeFileSync(join(r.dir, "block-tsc"), "");
    const gate = r.gateAsync(runId(), ["server/a.test.ts"]);
    await until(() => r.bunCalls().includes(TSC), "the gate's tsc");
    const ci = r.run(runId());
    expect(ci.status, ci.out).toBe(0);
    // The gate is still in tsc while CI ran to its end.
    expect(r.bunCalls()).not.toContain("run build:ui");
    writeFileSync(join(r.dir, "unblock"), "");
    const res = await gate;
    expect(res.status, res.out).toBe(0);
    expect(r.bunCalls()).toContain("test ./server/a.test.ts");
  }, 20_000);

  it("runs two gates at once and holds a third until a slot frees", async () => {
    const r = await remote({});
    writeFileSync(join(r.dir, "block-tsc"), "");
    const first = [r.gateAsync(runId(), []), r.gateAsync(runId(), [])];
    await until(() => count(r.bunCalls(), TSC) === 2, "two gates in tsc");
    const third = r.gateAsync(runId(), []);
    await Bun.sleep(1500);
    expect(count(r.bunCalls(), INSTALLS[0]!)).toBe(2);
    writeFileSync(join(r.dir, "unblock"), "");
    for (const res of await Promise.all([...first, third]))
      expect(res.status, res.out).toBe(0);
    expect(count(r.bunCalls(), TSC)).toBe(3);
  }, 20_000);

  it.each(["both slots are taken", "CI holds its lock"])(
    "gives no verdict, without running a step, when %s past GATE_WAIT",
    async (busy) => {
      const r = await remote({ gateWait: 1 });
      let held: Promise<unknown>[] = [];
      if (busy === "CI holds its lock") held = [(await holdCiLock(r)).exited];
      else {
        writeFileSync(join(r.dir, "block-tsc"), "");
        held = [r.gateAsync(runId(), []), r.gateAsync(runId(), [])];
        await until(() => count(r.bunCalls(), TSC) === 2, "two gates in tsc");
      }
      const before = r.bunCalls().length;
      const res = await r.gateAsync(runId(), []);
      expect(res.status, res.out).toBe(3);
      expect(r.bunCalls()).toHaveLength(before);
      writeFileSync(join(r.dir, "unblock"), "");
      await Promise.all(held);
    },
    20_000,
  );

  it("clears what a killed run left in its slot before it checks out", async () => {
    const r = await remote({});
    const stale = join(r.root, "gate-runs", "slot-1", "src");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "left-behind"), "");
    const res = r.gate(runId(), []);
    expect(res.status, res.out).toBe(0);
    expect(r.bunCalls()).toEqual([...INSTALLS, TSC]);
    expect(existsSync(join(stale, "left-behind"))).toBe(false);
    expect(
      r
        .systemctlCalls()
        .some((c) => c.includes("kill") && c.includes("isomux-gate-slot-1")),
    ).toBe(true);
  });

  it("gives no verdict and keeps the slot's files while a killed run's processes live", async () => {
    const r = await remote({ scopeStuck: true });
    const stale = join(r.root, "gate-runs", "slot-1", "src");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "left-behind"), "");
    const res = r.gate(runId(), []);
    expect(res.status, res.out).toBe(3);
    expect(r.bunCalls()).toEqual([]);
    expect(existsSync(join(stale, "left-behind"))).toBe(true);
  }, 30_000);
});
