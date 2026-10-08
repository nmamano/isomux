// run.sh's Kubernetes cleanup deletes the fixed-name k3d cluster only when
// this run created it. Driven with PATH stubs for docker, k3d and kubectl, so
// no image is built and no cluster is touched.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_SH = join(import.meta.dir, "run.sh");
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
  "build "*) [[ $STUB_MODE == build-fails ]] && exit 17; cat >/dev/null; exit 0 ;;
  "image inspect") echo "sha256:0 linux/amd64" ;;
esac
exit 0`,
  );
  stub(
    "k3d",
    `case "$1 $2" in
  "cluster get") [[ $STUB_MODE == cluster-exists ]] && exit 0; exit 1 ;;
  "cluster create") printf 'contexts:\\n- name: k3d-isomux-verify\\n' >> "$KUBECONFIG"; exit 0 ;;
esac
exit 0`,
  );
  // deploy/container/build.sh exports the source with python3 first.
  stub("python3", 'touch "$3"; echo 0000000');
  // The first kubectl call in run.sh up fails, after the cluster exists.
  stub("kubectl", "exit 1");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

async function run(mode: string) {
  const child = Bun.spawn(["bash", RUN_SH, "kubernetes"], {
    env: {
      ...process.env,
      PATH: `${base}:${process.env.PATH}`,
      STUB_MODE: mode,
      SMOKE_LOG_DIR: join(base, "logs"),
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

  it("deletes the cluster it created when a later step fails", async () => {
    const r = await run("created-then-fails");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("FAIL at step cluster ");
    expect(r.deletes).toEqual(["k3d cluster delete isomux-verify"]);
  }, 60_000);
});
