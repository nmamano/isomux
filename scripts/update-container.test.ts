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

const OLD_IMAGE = `ghcr.io/nmamano/isomux@sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `ghcr.io/nmamano/isomux@sha256:${"2".repeat(64)}`;

// Docker stand-in: IDS maps each present reference to its image id, and every
// removal is recorded. FAIL_RM makes removal fail as an in-use image does.
function finalize(ids: Record<string, string>, failRemoval = false) {
  return fixture(`
mkdir -p "$FIXTURE/stage"
echo checksum > "$FIXTURE/stage/installer.sha256"
CONTAINER_STAGE="$FIXTURE/stage"
CONTAINER_DIGEST=${NEW_IMAGE}
echo ${OLD_IMAGE} > "$FIXTURE/image"
echo v2099.1.1 > "$FIXTURE/release"
declare -A IDS=(${Object.entries(ids)
    .map(([ref, id]) => `["${ref}"]=${id}`)
    .join(" ")})
docker() {
  if [[ $1 == image && $2 == inspect ]]; then [[ -n \${IDS[$5]:-} ]] && echo "\${IDS[$5]}"; return; fi
  if [[ $1 == image && $2 == rm ]]; then echo "REMOVED $3" >&2; ${failRemoval ? "return 1" : 'unset "IDS[$3]"'}; return; fi
  return 1
}
container_finalize
echo "RECORDED $(cat "$FIXTURE/release") $(cat "$FIXTURE/image")"
`);
}

const removed = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.startsWith("REMOVED "))
    .map((line) => line.slice("REMOVED ".length));

test("a container update removes the replaced release's image references", async () => {
  const result = await finalize({
    [NEW_IMAGE]: "sha256:new",
    "ghcr.io/nmamano/isomux:v2099.1.2": "sha256:new",
    "ghcr.io/nmamano/isomux:v2099.1.1": "sha256:old",
    [OLD_IMAGE]: "sha256:old",
  });
  expect(result.code).toBe(0);
  expect(removed(result.output)).toEqual([
    "ghcr.io/nmamano/isomux:v2099.1.1",
    OLD_IMAGE,
  ]);
  expect(result.output).toContain(`RECORDED v2099.1.2 ${NEW_IMAGE}`);
});

test("a container update never removes the image it now runs", async () => {
  const result = await finalize({
    [NEW_IMAGE]: "sha256:new",
    "ghcr.io/nmamano/isomux:v2099.1.1": "sha256:new",
  });
  expect(result.code).toBe(0);
  expect(removed(result.output)).toEqual([]);
});

test("a refused image removal does not fail a finished update", async () => {
  const result = await finalize(
    {
      [NEW_IMAGE]: "sha256:new",
      "ghcr.io/nmamano/isomux:v2099.1.1": "sha256:old",
      [OLD_IMAGE]: "sha256:old",
    },
    true,
  );
  expect(result.code).toBe(0);
  expect(removed(result.output)).toEqual([
    "ghcr.io/nmamano/isomux:v2099.1.1",
    OLD_IMAGE,
  ]);
  expect(result.output).toContain(`RECORDED v2099.1.2 ${NEW_IMAGE}`);
});
