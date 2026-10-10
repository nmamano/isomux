// Drive the real runner through Docker's boundary without installing a machine.
// Its saved-state checks run as real bash/jq against temporary fixture files.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function run(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "hosted-run-"));
  dirs.push(dir);
  const stub = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\nset -e\n${body}\n`);
    chmodSync(file, 0o755);
  };
  writeFileSync(join(dir, "office-config.json"), JSON.stringify({ externalAccess: mode !== "access-off", publicOrigin: mode === "wrong-origin" ? "https://other.isomux.app" : "https://smoke.isomux.app" }));
  if (mode !== "missing-invite") writeFileSync(join(dir, "invite-url"), "https://smoke.isomux.app/i/fixture");
  stub("git", '[[ $1 != rev-parse ]] || echo 1111111111111111111111111111111111111111');
  stub("docker", `
if [[ $1 != exec ]]; then exit 0; fi
shift
while [[ $1 == -e || $1 == -u ]]; do
  [[ $1 != -e ]] || export "$2"
  shift 2
done
shift # container name
if [[ $1 == cat ]]; then
  [[ $STUB_MODE != wrong-marker ]] && echo hosted || echo self-hosted
elif [[ "$*" == *"/root/hosted-install.sh"* ]]; then
  if [[ $STUB_MODE == install-fails ]]; then echo original-install-failure; exit 23; fi
  [[ $STUB_MODE == missing-boundary ]] || echo HOSTED_SMOKE_TLS_BOUNDARY
elif [[ $1 == bash && $2 == -ec && $3 == *"office-config.json"* ]]; then
  script=$3
  script=\${script//\\/var\\/lib\\/isomux-install\\/invite-url/$STUB_ROOT/invite-url}
  script=\${script//\\/home\\/isomux\\/.isomux\\/office-config.json/$STUB_ROOT/office-config.json}
  bash -ec "$script"
elif [[ $1 == bash && $2 == -c && $3 == *"replayed PUT"* ]]; then
  echo 'replayed PUT /api/office/access after install failure:'
  echo 'replay HTTP 200'
  exit 0
elif [[ "$*" == *"/opt/install-smoke/check.ts"* ]]; then
  touch "$STUB_ROOT/office-checked"
fi`);
  const child = Bun.spawn(["bash", join(import.meta.dir, "run.sh"), "hosted"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_ROOT: dir, STUB_MODE: mode, SMOKE_LOG_DIR: join(dir, "logs") },
    stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  return { code: await child.exited, out, checked: await Bun.file(join(dir, "office-checked")).exists(), installLog: readFileSync(join(dir, "logs/install.log"), "utf8") };
}

test("hosted runner reaches office checks with marker, saved address and invite", async () => {
  const result = await run("valid");
  expect(result.code).toBe(0);
  expect(result.checked).toBe(true);
});

for (const mode of ["wrong-marker", "missing-boundary", "access-off", "wrong-origin", "missing-invite"]) {
  test(`hosted runner refuses ${mode} before office checks`, async () => {
    const result = await run(mode);
    expect(result.code).not.toBe(0);
    expect(result.checked).toBe(false);
  });
}

test("successful diagnostic replay cannot hide an installer failure", async () => {
  const result = await run("install-fails");
  expect(result.code).not.toBe(0);
  expect(result.checked).toBe(false);
  expect(result.installLog).toContain("replay HTTP 200");
  expect(result.out).toContain("exit 23");
});
