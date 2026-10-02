import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./check.sh", import.meta.url).pathname;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// bash and python3 stand-ins record the build and the two checks and fail the
// one named in FAIL; docker records image removal.
function check(fail: string) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-container-check-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  // build.sh takes REVISION IMAGE; the checks take IMAGE.
  const step = (image: string) =>
    `echo "$(basename "$1") ${image}" >> "$FIXTURE/events"; [ "$(basename "$1")" != "$FAIL" ]`;
  stub("bash", step("$3"));
  stub("python3", step("$2"));
  stub(
    "docker",
    `[ "$2" = inspect ] && exit 0; echo "docker $*" >> "$FIXTURE/events"`,
  );
  const result = Bun.spawnSync(["/bin/bash", SCRIPT, "0123abcd"], {
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      FIXTURE: dir,
      FAIL: fail,
    },
  });
  const events = readFileSync(join(dir, "events"), "utf8").trim().split("\n");
  return { code: result.exitCode, events };
}

for (const [fail, ran] of [
  ["", ["build.sh", "smoke.py", "compose-check.py"]],
  ["smoke.py", ["build.sh", "smoke.py"]],
  ["build.sh", ["build.sh"]],
] as const) {
  test(`the local image check removes its image (${fail || "pass"})`, () => {
    const { code, events } = check(fail);
    expect(code === 0).toBe(fail === "");
    const steps = events.filter((e) => !e.startsWith("docker "));
    expect(steps.map((e) => e.split(" ")[0])).toEqual([...ran]);
    const image = steps[0]!.split(" ")[1]!;
    expect(image).toMatch(/^isomux-check:[a-f0-9]{12}$/);
    expect(steps.every((e, i) => i === 0 || e.split(" ")[1] === image)).toBe(
      true,
    );
    expect(events.at(-1)).toBe(`docker image rm ${image}`);
  });
}
