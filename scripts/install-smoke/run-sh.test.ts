// run.sh's Kubernetes cleanup deletes the fixed-name k3d cluster only when
// this run created it. Driven with PATH stubs for docker, k3d and kubectl, so
// no image is built and no cluster is touched.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
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
  stub(
    "docker",
    `case "$1 $2" in
  "build "*) [[ $STUB_MODE == build-fails ]] && exit 17
    [[ $STUB_MODE == build-hangs ]] && exec sleep 30
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
  stub(
    "git",
    `[[ $1 == clone ]] || exec "${GIT}" "$@"
d="\${@: -1}/deploy/kubernetes-latest"; mkdir -p "$d"; printf '#!/bin/sh\\n' > "$d/deploy.sh"; chmod +x "$d/deploy.sh"`,
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
      while (!/box-image/.test(out) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => undefined),
        ]);
        if (!next || next.done) break;
        out += decoder.decode(next.value, { stream: true });
      }
      expect(out).toMatch(/box-image/);
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
