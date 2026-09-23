import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("./update.sh", import.meta.url), "utf8");
const definitions = source.slice(0, source.lastIndexOf('\nmain "$@"'));

async function fixture(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-container-ops-"));
  try {
    mkdirSync(join(dir, "status"));
    writeFileSync(
      join(dir, "run.sh"),
      definitions +
        `
DEPLOYMENT_KIND=container
STATUS_DIR="$FIXTURE/status"
CONTAINER_DIR="$FIXTURE"
TARGET_TAG=v2099.1.2
OLD_DESC=v2099.1.1
OLD_COMMIT=${"a".repeat(40)}
target_commit=${"b".repeat(40)}
READY_TIMEOUT_S=1
` +
        script,
    );
    const proc = Bun.spawn(["bash", join(dir, "run.sh")], {
      env: { ...process.env, FIXTURE: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, output: out + err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("container image revision mismatch fails before stopping the office", async () => {
  const result = await fixture(`
docker() {
  if [[ $1 == pull ]]; then return; fi
  if [[ "$*" == *RepoDigests* ]]; then printf '["ghcr.io/nmamano/isomux@sha256:${"c".repeat(64)}"]'; else echo "$OLD_COMMIT"; fi
}
svc() { echo UNEXPECTED_SERVICE_MUTATION; }
container_prepare
svc stop isomux-container
`);
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("UNEXPECTED_SERVICE_MUTATION");
  expect(result.output).toContain("image source revision");
});

test("HTTP readiness alone cannot accept an incorrect running image identity", async () => {
  const ready = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  try {
    const result = await fixture(`
BASE_URL=http://127.0.0.1:${ready.port}
container_compose() { printf '{"commit":"${"a".repeat(40)}","release":"v2099.1.1"}'; }
container_ready
`);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("running container version");
  } finally {
    await ready.stop(true);
  }
});
