import { afterEach, expect, test } from "bun:test";
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

const SCRIPT = new URL("./run.sh", import.meta.url).pathname;
const RELEASED = readFileSync(SCRIPT, "utf8").match(/^RELEASED=(.+)$/m)![1]!;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// docker, k3d, kubectl, git and openssl stand-ins record their arguments.
// `docker image inspect` finds the image only when PRESENT is set; `git clone`
// writes a no-op CSI deploy script; openssl fails, since no key is generated.
function invoke(
  args: string[],
  options: { pulled?: string; present?: boolean; image?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "isomux-k8s-verify-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "work"));
  const stub = (tool: string, body = "") => {
    writeFileSync(
      join(dir, "bin", tool),
      `#!/usr/bin/env bash\nprintf '${tool} %s\\n' "$*" >> "${dir}/events"\n${body}\n`,
    );
    chmodSync(join(dir, "bin", tool), 0o755);
  };
  stub("docker", `[[ "$1 $2" != "image inspect" ]] || [[ -n $PRESENT ]]`);
  stub("k3d");
  stub("kubectl");
  stub("openssl", "exit 1");
  stub(
    "git",
    `if [[ $1 == clone ]]; then d="\${@: -1}/deploy/kubernetes-latest"; mkdir -p "$d"; printf '#!/bin/sh\\n' > "$d/deploy.sh"; chmod +x "$d/deploy.sh"; fi`,
  );
  if (options.pulled)
    writeFileSync(join(dir, "work", "pulled"), options.pulled + "\n");
  // Existing certificates and setup key skip key generation; kubectl only
  // receives their paths.
  writeFileSync(join(dir, "work", "ca.pem"), "");
  writeFileSync(join(dir, "work", "setup-key"), "");
  const env: Record<string, string> = {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    ISOMUX_VERIFY_DIR: join(dir, "work"),
    PRESENT: options.present ? "1" : "",
  };
  if (options.image) env.ISOMUX_VERIFY_IMAGE = options.image;
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], { env });
  const marker = join(dir, "work", "pulled");
  return {
    code: result.exitCode,
    events: readFileSync(join(dir, "events"), "utf8").trim().split("\n"),
    marker: existsSync(marker) ? readFileSync(marker, "utf8").trim() : null,
  };
}

const imageEvents = (events: string[]) =>
  events.filter((e) => /^docker image (rm|pull)|^docker pull/.test(e));

test("up records the released image it pulls", () => {
  const result = invoke(["up"]);
  expect(result.code).toBe(0);
  expect(imageEvents(result.events)).toEqual([
    `docker pull --quiet ${RELEASED}`,
  ]);
  expect(result.marker).toBe(RELEASED);
});

test("up records no pull when the released image is already present", () => {
  const result = invoke(["up"], { present: true });
  expect(result.code).toBe(0);
  expect(imageEvents(result.events)).toEqual([]);
  expect(result.marker).toBeNull();
});

test("up records no pull for a local image", () => {
  const result = invoke(["up"], { image: "isomux:local" });
  expect(result.code).toBe(0);
  expect(result.events).toContain(
    "k3d image import --cluster isomux-verify isomux:local",
  );
  expect(result.marker).toBeNull();
});

test("down removes the released image that up pulled", () => {
  const result = invoke(["down"], { pulled: RELEASED });
  expect(result.code).toBe(0);
  expect(result.events).toEqual([
    "k3d cluster delete isomux-verify",
    `docker image rm ${RELEASED}`,
  ]);
  expect(result.marker).toBeNull();
});

test("down keeps an image that was present before up", () => {
  const result = invoke(["down"]);
  expect(result.code).toBe(0);
  expect(result.events).toEqual(["k3d cluster delete isomux-verify"]);
});
