// run.sh's Kubernetes cleanup deletes the fixed-name k3d cluster only when
// this run created it. Driven with PATH stubs for docker, k3d and kubectl, so
// no image is built and no cluster is touched.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FREE_LIMIT_NOT_CHECKED } from "./check.ts";

const RUN_SH = join(import.meta.dir, "run.sh");
const GIT = Bun.which("git")!;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-smoke-run-"));
  const stub = (name: string, body: string) => {
    writeFileSync(
      join(base, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> "${base}/calls.log"\n${body}\n`,
    );
    chmodSync(join(base, name), 0o755);
  };
  // A docker call whose arguments match STUB_FAIL_MATCH prints the file
  // STUB_FAIL_OUT and exits with STUB_FAIL_RC: a step that fails with a
  // given log.
  stub(
    "docker",
    `if [[ -n \${STUB_FAIL_MATCH:-} && "$*" =~ $STUB_FAIL_MATCH ]]; then
  [[ -z \${STUB_FAIL_OUT:-} ]] || cat "$STUB_FAIL_OUT"
  exit "\${STUB_FAIL_RC:-1}"
fi
case "$1 $2" in
  "build "*) [[ $STUB_MODE == build-fails ]] && exit 17
    [[ $STUB_MODE == build-hangs ]] && { echo "stub-build-progress"; exec sleep 30; }
    cat >/dev/null; exit 0 ;;
  "image inspect") echo "sha256:0 linux/amd64" ;;
  "run "*) [[ $STUB_MODE == checks-fail ]] && exit 1
    [[ $STUB_MODE == free-limit ]] && echo "$STUB_CHECK_LINE" ;;
esac
exit 0`,
  );
  stub(
    "k3d",
    `case "$1 $2" in
  "cluster get") [[ $STUB_MODE == cluster-exists ]] && exit 0; exit 1 ;;
  "cluster create") printf 'contexts:\\n- name: k3d-isomux-verify\\n' >> "$KUBECONFIG"; exit 0 ;;
  "cluster delete") sed -i '/k3d-isomux-verify/d' "$KUBECONFIG"; exit 0 ;;
esac
exit 0`,
  );
  // The CSI driver clone gets a no-op deploy script.
  // serve_revision's fetch and init fail as STUB_GIT asks. A failed fetch
  // leaves a file in the bare repo, as a half-written pack would, and each
  // fetch records whether it found one. fsck exits with STUB_FSCK (0 by
  // default; 124 is what timeout returns when it stops the command).
  stub(
    "git",
    `if [[ $1 == init && $STUB_GIT == init-fails ]]; then echo "fatal: stub-init-failed" >&2; exit 1; fi
if [[ $1 == fsck ]]; then exit "\${STUB_FSCK:-0}"; fi
if [[ $1 == -C && $3 == fetch ]]; then
  n=$(( $(cat "${base}/fetches" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${base}/fetches"
  [[ -e $2/objects/pack/tmp_pack_stub ]] && echo "fetch $n found a leftover" >> "${base}/calls.log"
  if [[ $STUB_GIT == fetch-fails-twice || ( $STUB_GIT == fetch-fails-once && $n == 1 ) ]]; then
    mkdir -p "$2/objects/pack"; : > "$2/objects/pack/tmp_pack_stub"
    echo "fatal: stub-try-$n inflate: data stream error" >&2; exit 128
  fi
fi
[[ $1 == clone ]] || exec "${GIT}" "$@"
d="\${@: -1}/deploy/kubernetes-latest"; mkdir -p "$d"; printf '#!/bin/sh\\n' > "$d/deploy.sh"; chmod +x "$d/deploy.sh"`,
  );
  // The Ubuntu archive probe. STUB_ARCHIVE=stalls answers as curl does when
  // --max-time stops a slow download.
  stub(
    "curl",
    `if [[ $STUB_ARCHIVE == stalls ]]; then echo "curl: (28) Operation timed out" >&2; exit 28; fi
echo "2000000 bytes in 0.5s from 192.0.2.1: \${@: -1}"`,
  );
  // deploy/container/build.sh exports the source with python3 first.
  stub("python3", 'touch "$3"; echo 0000000');
  // Unless the checks fail instead, the first kubectl call in run.sh up fails,
  // after the cluster exists.
  stub(
    "kubectl",
    `[[ $STUB_MODE == checks-fail || $STUB_MODE == free-limit || $STUB_MODE == passes ]]`,
  );
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

async function run(
  mode: string,
  path = "kubernetes",
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(["bash", RUN_SH, path], {
    env: {
      ...process.env,
      ...env,
      PATH: `${base}:${process.env.PATH}`,
      STUB_MODE: mode,
      STUB_CHECK_LINE: FREE_LIMIT_NOT_CHECKED,
      SMOKE_LOG_DIR: join(base, "logs"),
      GITHUB_STEP_SUMMARY: join(base, "summary.md"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out =
    (await new Response(child.stdout).text()) +
    (await new Response(child.stderr).text());
  const code = await child.exited;
  const calls = readFileSync(join(base, "calls.log"), "utf8");
  return {
    code,
    out,
    calls,
    deletes: calls
      .split("\n")
      .filter((l) => l.startsWith("k3d cluster delete")),
  };
}

describe("run.sh kubernetes cleanup", () => {
  it("does not delete a cluster when the image build fails before the cluster step", async () => {
    const r = await run("build-fails");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL at step image");
    expect(r.deletes).toEqual([]);
  }, 60_000);

  it("refuses a cluster that already exists and leaves it alone", async () => {
    const r = await run("cluster-exists");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL at step cluster-free");
    expect(r.deletes).toEqual([]);
  }, 60_000);

  it("deletes the cluster once when up fails after creating it", async () => {
    const r = await run("created-then-fails");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL at step cluster ");
    expect(r.deletes).toEqual(["k3d cluster delete isomux-verify"]);
  }, 60_000);

  it("deletes the cluster it created when a step after up fails", async () => {
    const r = await run("checks-fail");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL at step office-checks");
    expect(r.deletes).toEqual(["k3d cluster delete isomux-verify"]);
  }, 60_000);
});

// Task a5c551e4: check.ts runs inside a container or a cluster client with
// no summary file, so run.sh copies its not-checked line to the job summary.
// Every path's checks are the office-checks step.
describe("run.sh job summary", () => {
  const summary = () => {
    const file = join(base, "summary.md");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };

  it("copies the free agent's not-checked line to the job summary", async () => {
    const r = await run("free-limit");
    expect(r.code).toBe(0);
    expect(summary()).toContain(FREE_LIMIT_NOT_CHECKED);
  }, 60_000);

  it("writes no such line when the checks pass without it", async () => {
    const r = await run("passes");
    expect(r.code).toBe(0);
    expect(summary()).not.toContain(FREE_LIMIT_NOT_CHECKED);
  }, 60_000);
});

// Task d5249443: CI's install smoke stage can be killed before run.sh's own
// cleanup runs, and its box belongs to the Docker daemon, not to the killed
// process tree. CI sets SMOKE_DOCKER_LABEL so that scripts/ci-remote.sh can
// remove what is left; a run started by hand sets nothing and is never swept.
describe("run.sh Docker label", () => {
  // The calls that make a Docker resource.
  const creates = (calls: string) =>
    calls
      .split("\n")
      .filter((l) => /^docker (build|run|create|volume create)( |$)/.test(l));

  // installer-gate is the path CI's stage runs.
  it("labels every Docker resource of the gate path when CI asks", async () => {
    const label = "isomux-test-sweep=1";
    const r = await run("passes", "installer-gate", {
      SMOKE_DOCKER_LABEL: label,
    });
    expect(r.code, r.out).toBe(0);
    const made = creates(r.calls);
    expect(made.some((l) => l.startsWith("docker build "))).toBe(true);
    expect(made.some((l) => l.startsWith("docker run "))).toBe(true);
    expect(
      made.filter((l) => !new RegExp(` --label[ =]${label}( |$)`).test(l)),
    ).toEqual([]);
  }, 60_000);

  it("labels nothing for a run started by hand", async () => {
    const r = await run("passes", "installer-gate", { SMOKE_DOCKER_LABEL: "" });
    expect(r.code, r.out).toBe(0);
    const made = creates(r.calls);
    expect(made.some((l) => l.startsWith("docker run "))).toBe(true);
    expect(made.filter((l) => l.includes("--label"))).toEqual([]);
  }, 60_000);
});

// CI's stage ceiling reports the stage log's last line. A stalled step must
// be named there, so run.sh says which step it starts before it ends.
describe("run.sh step progress", () => {
  it("names a step while the step still runs", async () => {
    const child = Bun.spawn(["bash", RUN_SH, "installer"], {
      env: {
        ...process.env,
        PATH: `${base}:${process.env.PATH}`,
        STUB_MODE: "build-hangs",
        SMOKE_LOG_DIR: join(base, "logs"),
        SMOKE_HEARTBEAT_SECONDS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let out = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 10_000;
    try {
      // A heartbeat names the step and carries the last line of its log.
      const beat = /box-image.*stub-build-progress/;
      while (!beat.test(out) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => undefined),
        ]);
        if (!next || next.done) break;
        out += decoder.decode(next.value, { stream: true });
      }
      expect(out).toMatch(beat);
      // The enabling condition: the step has started and still runs (the
      // stub sleeps). run.sh names the step before it starts the command.
      const calls = () => readFileSync(join(base, "calls.log"), "utf8");
      while (!calls().includes("docker build") && Date.now() < deadline)
        await Bun.sleep(20);
      expect(calls()).toContain("docker build");
      expect(out).not.toMatch(/(PASS|FAIL at step) box-image/);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await child.exited;
    }
  }, 30_000);
});

// 2026-11-10: a stalled Ubuntu archive held apt in the install step until
// CI's wall-clock limit. The probe's verdict sets the order of the box's apt
// mirrors: the archive first while it answers, the fallback first when it
// does not, with a warning in run.sh's own output.
describe("run.sh Ubuntu archive probe", () => {
  const builds = (calls: string) =>
    calls.split("\n").filter((l) => l.startsWith("docker build "));

  it("puts the fallback mirror first, with a warning, when the archive stalls", async () => {
    const r = await run("passes", "installer-gate", { STUB_ARCHIVE: "stalls" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /\[smoke:installer-gate\] warning:.*archive\.ubuntu\.com/,
    );
    expect(builds(r.calls)).toHaveLength(1);
    expect(builds(r.calls)[0]).toMatch(/--build-arg APT_ORDER=fallback( |$)/);
  }, 60_000);

  it("keeps the archive first when it answers", async () => {
    const r = await run("passes", "installer-gate");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/warning:/);
    expect(builds(r.calls)).toHaveLength(1);
    expect(builds(r.calls)[0]).toMatch(/--build-arg APT_ORDER=archive( |$)/);
  }, 60_000);
});

// apt-mirrors.sh on a copy of the ubuntu:24.04 sources: both archive hosts
// become mirror lists, in the order asked, and nothing else changes.
describe("apt-mirrors.sh", () => {
  const SOURCES = [
    "Types: deb",
    "URIs: http://archive.ubuntu.com/ubuntu/",
    "Suites: noble noble-updates noble-backports",
    "",
    "Types: deb",
    "URIs: http://security.ubuntu.com/ubuntu/",
    "Suites: noble-security",
    "",
  ].join("\n");
  const apply = (order: string) => {
    const root = join(base, `root-${order}`);
    mkdirSync(join(root, "etc/apt/sources.list.d"), { recursive: true });
    mkdirSync(join(root, "etc/apt/apt.conf.d"), { recursive: true });
    writeFileSync(join(root, "etc/apt/sources.list.d/ubuntu.sources"), SOURCES);
    const r = Bun.spawnSync(
      ["bash", join(import.meta.dir, "apt-mirrors.sh"), order],
      { env: { ...process.env, APT_ROOT: root } },
    );
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    return { code: r.exitCode, read, root };
  };
  const hosts = (list: string) =>
    list
      .trim()
      .split("\n")
      .map((l) => new URL(l.split("\t")[0]!).host);

  it("lists the archive first for archive and the fallback first for fallback", () => {
    for (const [order, first] of [
      ["archive", 0],
      ["fallback", 1],
    ] as const) {
      const { code, read } = apply(order);
      expect(code).toBe(0);
      const sources = read("etc/apt/sources.list.d/ubuntu.sources");
      expect(sources).not.toMatch(/^URIs: http:/m);
      expect(sources).toMatch(/^Suites: noble noble-updates noble-backports$/m);
      for (const [list, archive] of [
        ["ubuntu.list", "archive.ubuntu.com"],
        ["ubuntu-security.list", "security.ubuntu.com"],
      ]) {
        expect(sources).toContain(`URIs: mirror+file:/etc/apt/mirrors/${list}`);
        const order2 = hosts(read(`etc/apt/mirrors/${list}`));
        expect(order2).toHaveLength(2);
        expect(order2[first]).toBe(archive);
        expect(order2[1 - first]).not.toBe(archive);
      }
    }
  });

  it("refuses sources it does not recognise", () => {
    const root = join(base, "root-other");
    mkdirSync(join(root, "etc/apt/sources.list.d"), { recursive: true });
    writeFileSync(
      join(root, "etc/apt/sources.list.d/ubuntu.sources"),
      "URIs: http://example.org/ubuntu/\n",
    );
    const r = Bun.spawnSync(
      ["bash", join(import.meta.dir, "apt-mirrors.sh"), "archive"],
      { env: { ...process.env, APT_ROOT: root } },
    );
    expect(r.exitCode).not.toBe(0);
  });

  // 2026-11-10: apt-get update logged "Ign:3 ... noble InRelease" (no mirror
  // sent it), exited 0, and the install found no packages. The apt-get stub
  // acts as apt does then: exit 0, or 100 with --error-on=any. The Nth word
  // of STUB_IGNORES says whether call N ignores an index.
  const update = (order: string, ignores: string) => {
    const { root, read } = apply(order);
    const bin = join(base, "apt-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(base, "apt-calls.log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "apt-get"),
      `#!/usr/bin/env bash
n=$(grep -c '^apt-get' "${log}")
ignores=($STUB_IGNORES)
first=$(head -n 1 "$APT_ROOT/etc/apt/mirrors/ubuntu.list" | cut -f1)
echo "apt-get ignores=\${ignores[$n]} first=$first $*" >> "${log}"
[[ \${ignores[$n]} == 1 && " $* " == *" --error-on=any "* ]] && exit 100
exit 0
`,
    );
    writeFileSync(
      join(bin, "sleep"),
      `#!/usr/bin/env bash\necho "sleep $*" >> "${log}"\n`,
    );
    chmodSync(join(bin, "apt-get"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    const r = Bun.spawnSync(
      ["bash", join(import.meta.dir, "apt-mirrors.sh"), "update"],
      {
        env: {
          ...process.env,
          APT_ROOT: root,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_IGNORES: ignores,
        },
      },
    );
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const apt = calls.filter((l) => l.startsWith("apt-get "));
    const firstHost = (l: string) => new URL(/ first=(\S+)/.exec(l)![1]!).host;
    return { code: r.exitCode, calls, apt, firstHost, read };
  };

  it("runs apt-get update once when it gets every index", () => {
    const u = update("archive", "0");
    expect(u.code).toBe(0);
    expect(u.apt).toHaveLength(1);
    expect(u.calls.filter((l) => l.startsWith("sleep "))).toHaveLength(0);
  });

  it("tries again, after a pause, with the other mirror first when an index is ignored", () => {
    for (const [order, firstBefore] of [
      ["archive", "archive.ubuntu.com"],
      ["fallback", "mirrors.edge.kernel.org"],
    ] as const) {
      const u = update(order, "1 0");
      expect(u.code, u.calls.join("\n")).toBe(0);
      expect(u.apt).toHaveLength(2);
      expect(u.apt[0]).toMatch(/ ignores=1 /);
      expect(u.firstHost(u.apt[0]!)).toBe(firstBefore);
      expect(u.firstHost(u.apt[1]!)).not.toBe(firstBefore);
      const lists = ["ubuntu.list", "ubuntu-security.list"].map(
        (l) => hosts(u.read(`etc/apt/mirrors/${l}`))[0],
      );
      expect(lists[0]).toBe(u.firstHost(u.apt[1]!));
      expect(lists[1]).toBe(
        order === "archive" ? "mirrors.edge.kernel.org" : "security.ubuntu.com",
      );
      expect(u.calls.indexOf(u.apt[1]!)).toBeGreaterThan(
        u.calls.findIndex((l) => l.startsWith("sleep ")),
      );
      expect(u.calls.findIndex((l) => l.startsWith("sleep "))).toBeGreaterThan(
        0,
      );
    }
  });

  it("fails when the index is ignored with either mirror first", () => {
    const u = update("archive", "1 1");
    expect(u.code).not.toBe(0);
    expect(u.apt).toHaveLength(2);
    expect(u.apt[1]).toMatch(/ ignores=1 /);
  });
});

// Task cc5c205b: serve_revision's local fetch once failed with a corrupt
// pack while the stored objects were intact. It tries twice, each time into
// a fresh bare repo, checks the source with fsck after a failed first try,
// and a pass on the second try leaves one line in run.sh's own output, the
// only place a green CI run keeps it.
describe("run.sh serve-revision retry", () => {
  const lines = (out: string, marker: string) =>
    out.split("\n").filter((l) => l.includes(marker));
  const stepLog = () =>
    readFileSync(join(base, "logs", "serve-revision.log"), "utf8");
  const gitCalls = (calls: string, sub: string) =>
    calls
      .split("\n")
      .filter((l) => new RegExp(`^git (-C \\S+ )?${sub}( |$)`).test(l));

  it("passes on a second try into an empty repo, and says so once", async () => {
    const r = await run("passes", "installer-gate", {
      STUB_GIT: "fetch-fails-once",
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/PASS serve-revision/);
    // The enabling condition: the first try failed and a second one ran.
    expect(gitCalls(r.calls, "fetch")).toHaveLength(2);
    expect(r.calls).not.toMatch(/fetch \d+ found a leftover/);
    // One line in run.sh's output carries the first error, the fsck verdict
    // and the 1-minute load.
    const notes = lines(r.out, "stub-try-1");
    expect(notes, r.out).toHaveLength(1);
    expect(notes[0]).toMatch(/serve-revision/);
    expect(notes[0]).toMatch(/fsck\W+ok\b/);
    expect(notes[0]).toMatch(/\d+\.\d\d/);
    // fsck ran between the two tries.
    const order = r.calls
      .split("\n")
      .filter((l) => /^git (fsck|-C \S+ fetch)( |$)/.test(l))
      .map((l) => (l.startsWith("git fsck") ? "fsck" : "fetch"));
    expect(order).toEqual(["fetch", "fsck", "fetch"]);
    // The step log keeps the diagnostics: the load triple and free memory.
    const log = stepLog();
    expect(log).toMatch(/\d+\.\d\d \d+\.\d\d \d+\.\d\d/);
    expect(log).toMatch(/MemAvailable/);
  }, 60_000);

  it("reports a failed or stopped fsck without failing the step", async () => {
    for (const [exit, verdict] of [
      ["1", /fsck\W+failed\b/],
      ["124", /fsck\W+timeout\b/],
    ] as const) {
      rmSync(join(base, "fetches"), { force: true });
      const r = await run("passes", "installer-gate", {
        STUB_GIT: "fetch-fails-once",
        STUB_FSCK: exit,
      });
      expect(r.code, r.out).toBe(0);
      expect(gitCalls(r.calls, "fsck").length).toBeGreaterThan(0);
      const notes = lines(r.out, "stub-try-1");
      expect(notes, r.out).toHaveLength(1);
      expect(notes[0]).toMatch(verdict);
    }
  }, 120_000);

  it("fails the step after two failed tries, with both errors", async () => {
    const r = await run("passes", "installer-gate", {
      STUB_GIT: "fetch-fails-twice",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL at step serve-revision/);
    expect(gitCalls(r.calls, "fetch")).toHaveLength(2);
    expect(r.calls).not.toMatch(/fetch \d+ found a leftover/);
    expect(r.out).toContain("stub-try-1");
    expect(r.out).toContain("stub-try-2");
  }, 60_000);

  it("runs no fsck and prints no retry line when the first try passes", async () => {
    const r = await run("passes", "installer-gate");
    expect(r.code, r.out).toBe(0);
    expect(gitCalls(r.calls, "fetch")).toHaveLength(1);
    expect(gitCalls(r.calls, "fsck")).toEqual([]);
    expect(r.out).not.toMatch(/second try/i);
  }, 60_000);

  it("does not fetch when the bare repo cannot be made", async () => {
    const r = await run("passes", "installer-gate", { STUB_GIT: "init-fails" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL at step serve-revision/);
    expect(gitCalls(r.calls, "init").length).toBeGreaterThan(0);
    expect(gitCalls(r.calls, "fetch")).toEqual([]);
  }, 60_000);
});

// Task d381f3e2: a failed step prints its cause class in run.sh's own
// output, and run.sh exits 75 (EX_TEMPFAIL) for an infra class (network,
// vm), so that CI retries only those. A sign counts only at the failure
// point: the installer prints its network advice also on failures it
// survives, and box-image keeps apt's errors from a first update that the
// second one repaired. A product failure must stay exit 1.
describe("run.sh failure cause", () => {
  const INSTALL = String.raw`bash /root/install\.sh$`;
  const BOX_IMAGE = "^build ";
  const MACHINE = "^run -d ";
  const CHECKS = String.raw`check\.ts`;
  const STEP = (name: string) => `[isomux-install] --- step: ${name}`;
  const GITHUB_DOWN =
    "[isomux-install] could not download https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.deb. GitHub did not answer after 6 tries. Try again in a few minutes.";
  const ADVICE =
    "The cause is the network or the package mirror, not Isomux. Try again later, or switch apt to another mirror.";
  const MIRRORS_DOWN =
    "apt-mirrors: apt-get update did not get every index with either mirror first (archive.ubuntu.com and security.ubuntu.com, http://mirrors.edge.kernel.org/ubuntu/). This is outside isomux.";
  const MIRRORS_RETRY =
    "apt-mirrors: apt-get update did not get every index (above); trying again in 10s with the fallback mirror first";

  async function failStep(match: string, lines: string[], rc = 1) {
    const out = join(base, "step-out.txt");
    writeFileSync(out, `${lines.join("\n")}\n`);
    const r = await run("passes", "installer-gate", {
      STUB_FAIL_MATCH: match,
      STUB_FAIL_OUT: out,
      STUB_FAIL_RC: String(rc),
    });
    // The cause lines run.sh printed, as [class, sign].
    const causes = r.out
      .split("\n")
      .map((l) => /^\[smoke:installer-gate\] cause: (\w+) \((.*)\)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => [m[1], m[2]]);
    return { ...r, causes };
  }

  // The enabling condition of every case: the stub failed the step meant.
  const failedAt = (out: string, step: string) =>
    expect(out).toMatch(new RegExp(`FAIL at step ${step} `));

  it("classifies GitHub that did not answer in the failing install section as network", async () => {
    const r = await failStep(INSTALL, [
      STEP("caddy"),
      "curl: (22) The requested URL returned error: 504",
      GITHUB_DOWN,
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(75);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]![0]).toBe("network");
    expect(r.causes[0]![1]).not.toBe("");
  }, 60_000);

  it("keeps a GitHub 4xx red as product, a wrong URL or pin", async () => {
    const r = await failStep(INSTALL, [
      STEP("caddy"),
      "curl: (22) The requested URL returned error: 404",
      GITHUB_DOWN,
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  it("counts a GitHub 429 or 408 as network, as install.sh does", async () => {
    for (const code of ["429", "408"]) {
      const r = await failStep(INSTALL, [
        STEP("caddy"),
        `curl: (22) The requested URL returned error: ${code}`,
        GITHUB_DOWN,
      ]);
      failedAt(r.out, "install");
      expect(r.code, r.out).toBe(75);
      expect(r.causes.map((c) => c[0])).toEqual(["network"]);
    }
  }, 120_000);

  // Every 4xx at the failure point counts, not only the first line that
  // has one.
  it("keeps a 4xx red when an earlier line of the section had a 429", async () => {
    const r = await failStep(INSTALL, [
      STEP("caddy"),
      "curl: (22) The requested URL returned error: 429",
      "curl: (22) The requested URL returned error: 404",
      GITHUB_DOWN,
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  it("does not read an apt download size as an HTTP 4xx", async () => {
    const r = await failStep(INSTALL, [
      STEP("packages"),
      "Get:5 http://archive.ubuntu.com/ubuntu noble/main amd64 jq amd64 1.7.1-3build1 [404 kB]",
      "E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/main/t/tmux/tmux_3.4-1build1_amd64.deb  Could not connect to archive.ubuntu.com:80 (91.189.91.81), connection timed out",
      `[isomux-install] apt could not download from: archive.ubuntu.com. ${ADVICE}`,
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["network"]);
  }, 60_000);

  it("ignores the network advice on a warning line", async () => {
    const r = await failStep(INSTALL, [
      STEP("packages"),
      `[isomux-install] warning: apt could not download from: archive.ubuntu.com. ${ADVICE}`,
      "[isomux-install] ERROR: the office did not answer within 60 s",
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  // install.sh survives a failed GitHub CLI install: apt_report_hosts prints
  // the advice without "warning:", and the install goes on.
  it("ignores a network sign from an earlier install section", async () => {
    const r = await failStep(INSTALL, [
      STEP("github-cli"),
      `[isomux-install] apt could not download from: cli.github.com. ${ADVICE}`,
      "[isomux-install] warning: could not install GitHub CLI. The office will continue without it. Install it later with: apt-get install gh",
      STEP("service"),
      "[isomux-install] ERROR: isomux.service did not start",
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  it("classifies apt-mirrors failing with both mirrors in box-image as network", async () => {
    const r = await failStep(BOX_IMAGE, [
      "#9 [4/5] RUN isomux-smoke-apt-mirrors update && apt-get install -y",
      MIRRORS_RETRY,
      MIRRORS_DOWN,
      'ERROR: failed to solve: process "/bin/sh -c isomux-smoke-apt-mirrors update" did not complete successfully: exit code: 1',
    ]);
    failedAt(r.out, "box-image");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["network"]);
  }, 60_000);

  it("keeps a box-image failure red when apt's errors were repaired by the second update", async () => {
    const r = await failStep(BOX_IMAGE, [
      "#9 Err:1 http://archive.ubuntu.com/ubuntu noble InRelease",
      "#9   Temporary failure resolving 'archive.ubuntu.com'",
      "#9 W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'",
      "#9 E: Failed to fetch http://security.ubuntu.com/ubuntu/dists/noble-security/InRelease  503  Service Unavailable [IP: 91.189.91.82 80]",
      "#9   Cannot initiate the connection to security.ubuntu.com:80 (2620:2d:4000:1::101). - connect (101: Network is unreachable)",
      MIRRORS_RETRY,
      "#9 Hit:1 http://mirrors.edge.kernel.org/ubuntu noble InRelease",
      "#10 [5/5] RUN test -x /usr/local/bin/missing",
      'ERROR: failed to solve: process "/bin/sh -c test -x /usr/local/bin/missing" did not complete successfully: exit code: 1',
    ]);
    failedAt(r.out, "box-image");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  // Task b5c1c32b: a failed DNS lookup is a network failure. Docker prints
  // Go's resolver error; bun prints DNSResolveFailed. The line is from CI's
  // log of 2026-11-22, when the CI box could not reach its DNS server.
  const DOCKER_DNS =
    '#2 ERROR: failed to authorize: failed to fetch anonymous token: Get "https://auth.docker.io/token?scope=repository%3Alibrary%2Fubuntu%3Apull&service=registry.docker.io": dial tcp: lookup auth.docker.io on [fd7a:115c:a1e0::53]:53: dial udp [fd7a:115c:a1e0::53]:53: connect: network is unreachable';
  const BUN_DNS =
    'error: DNSResolveFailed downloading tarball hono@4.9.0 from "https://registry.npmjs.org/hono/-/hono-4.9.0.tgz"';

  it("classifies a failed DNS lookup of the base image as network", async () => {
    const r = await failStep(BOX_IMAGE, [
      "#2 [internal] load metadata for docker.io/library/ubuntu:24.04",
      DOCKER_DNS,
      `ERROR: failed to build: failed to solve: ${DOCKER_DNS.slice(DOCKER_DNS.indexOf("failed to fetch"))}`,
    ]);
    failedAt(r.out, "box-image");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["network"]);
  }, 60_000);

  // Every end of a failed lookup counts, with and without the server.
  it("classifies each failed Go lookup as network", async () => {
    for (const end of [
      "lookup registry-1.docker.io: no such host",
      "lookup auth.docker.io on 127.0.0.53:53: server misbehaving",
      "lookup auth.docker.io on 127.0.0.53:53: read udp 127.0.0.1:41000->127.0.0.53:53: i/o timeout",
    ]) {
      const r = await failStep(BOX_IMAGE, [
        `#2 ERROR: failed to do request: Head "https://registry-1.docker.io/v2/library/ubuntu/manifests/24.04": dial tcp: ${end}`,
      ]);
      failedAt(r.out, "box-image");
      expect(r.code, `${end}\n${r.out}`).toBe(75);
      expect(r.causes.map((c) => c[0])).toEqual(["network"]);
    }
  }, 120_000);

  it("classifies bun's DNSResolveFailed in the failing install section as network", async () => {
    const r = await failStep(INSTALL, [
      STEP("dependencies"),
      BUN_DNS,
      "[isomux-install] ERROR: bun install failed",
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["network"]);
  }, 60_000);

  // A DNS sign counts only at the failure point, as the other network signs.
  it("ignores a failed DNS lookup from an earlier install section or on a warning line", async () => {
    for (const [before, label] of [
      [[STEP("dependencies"), BUN_DNS, STEP("service")], "earlier section"],
      [
        [
          STEP("service"),
          `[isomux-install] warning: ${DOCKER_DNS.slice(DOCKER_DNS.indexOf("dial tcp"))}`,
        ],
        "warning line",
      ],
    ] as const) {
      const r = await failStep(INSTALL, [
        ...before,
        "[isomux-install] ERROR: isomux.service did not start",
      ]);
      failedAt(r.out, "install");
      expect(r.code, `${label}\n${r.out}`).toBe(1);
      expect(r.causes.map((c) => c[0])).toEqual(["product"]);
    }
  }, 120_000);

  it("keeps a 4xx red as product when the section also has a failed DNS lookup", async () => {
    const r = await failStep(INSTALL, [
      STEP("caddy"),
      BUN_DNS,
      "curl: (22) The requested URL returned error: 404",
      GITHUB_DOWN,
    ]);
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  it("classifies a machine that did not start as vm", async () => {
    const r = await failStep(
      MACHINE,
      [
        "docker: Error response from daemon: failed to create task for container: stub.",
      ],
      125,
    );
    failedAt(r.out, "machine");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["vm"]);
  }, 60_000);

  it("classifies a Docker daemon that went away during the checks as vm", async () => {
    const r = await failStep(CHECKS, [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ]);
    failedAt(r.out, "office-checks");
    expect(r.code, r.out).toBe(75);
    expect(r.causes.map((c) => c[0])).toEqual(["vm"]);
  }, 60_000);

  it("keeps a failed office check red as product", async () => {
    const r = await failStep(CHECKS, [
      "FAIL claim: the invite link answered 500",
    ]);
    failedAt(r.out, "office-checks");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
    expect(r.causes[0]![1]).not.toBe("");
  }, 60_000);

  it("does not pass on a step command's own exit 75 without a sign", async () => {
    const r = await failStep(
      INSTALL,
      [STEP("service"), "[isomux-install] ERROR: isomux.service did not start"],
      75,
    );
    failedAt(r.out, "install");
    expect(r.code, r.out).toBe(1);
    expect(r.causes.map((c) => c[0])).toEqual(["product"]);
  }, 60_000);

  it("prints no cause line when every step passes", async () => {
    const r = await failStep("^no-such-docker-call$", []);
    expect(r.code, r.out).toBe(0);
    expect(r.causes).toEqual([]);
  }, 60_000);
});
