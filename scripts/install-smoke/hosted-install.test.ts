import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function run(failAt = "", entry = 'main "$@"', boundary = "configure_caddy") {
  const dir = mkdtempSync(join(tmpdir(), "hosted-smoke-"));
  dirs.push(dir);
  const file = join(dir, "install.sh");
  const steps = join(dir, "steps");
  writeFileSync(file, `set -Eeuo pipefail
step() { echo "$1" >> "$STEPS"; [[ $1 != "$FAIL_AT" ]]; }
configure_caddy() { step tls; }
main() {
  step marker
  step claim
  step access
  step invite
  ${boundary}
  step report
}
${entry}
`);
  const child = Bun.spawn(["bash", join(import.meta.dir, "hosted-install.sh"), file], {
    env: { ...process.env, STEPS: steps, FAIL_AT: failAt }, stdout: "pipe", stderr: "pipe",
  });
  const code = await child.exited;
  return { code, steps: Bun.file(steps).size ? readFileSync(steps, "utf8").trim().split("\n") : [] };
}

test("hosted wrapper runs claim, access and invite before stopping at TLS", async () => {
  const result = await run();
  expect(result.code).toBe(0);
  expect(result.steps).toEqual(["marker", "claim", "access", "invite"]);
});

test("hosted wrapper propagates first address enable failure", async () => {
  const result = await run("access");
  expect(result.code).not.toBe(0);
  expect(result.steps).toEqual(["marker", "claim", "access"]);
});

test("hosted wrapper propagates invite failure", async () => {
  const result = await run("invite");
  expect(result.code).not.toBe(0);
  expect(result.steps).toEqual(["marker", "claim", "access", "invite"]);
});

test("hosted wrapper refuses a changed installer entry point", async () => {
  const result = await run("", "main --new-entry");
  expect(result.code).not.toBe(0);
  expect(result.steps).toEqual([]);
});

test("hosted wrapper refuses an installer that returns without the TLS boundary", async () => {
  const result = await run("", 'main "$@"', "return 0");
  expect(result.code).not.toBe(0);
  expect(result.steps).toEqual(["marker", "claim", "access", "invite"]);
});
