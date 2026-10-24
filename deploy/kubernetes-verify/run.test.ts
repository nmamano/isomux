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
const K3S_IMAGE = readFileSync(SCRIPT, "utf8").match(/^K3S_IMAGE=(.+)$/m)![1]!;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Options = {
  present?: boolean;
  image?: string;
  exists?: boolean;
  network?: boolean;
  checks?: boolean;
  rollout?: "fail" | "hang";
  createHangs?: boolean;
};

// docker, k3d, kubectl, git and openssl stand-ins record their arguments.
// `docker image inspect` finds the image only when PRESENT is set, `docker
// network inspect` finds the network only when NETWORK is set, and `docker ps`
// lists a stopped k3d check container and a node when CHECKS is set; `k3d cluster
// get` finds the cluster only when EXISTS is set, and `k3d cluster create`
// hangs when CREATE says so; `kubectl rollout status` fails or hangs when
// ROLLOUT says so; `git clone` writes a no-op CSI deploy script; openssl
// fails, since no key is generated.
function setup(options: Options) {
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
  stub(
    "docker",
    `[[ "$1 $2" != "image inspect" ]] || [[ -n $PRESENT ]] || exit 1
[[ $1 != ps || -z $CHECKS ]] || printf '%s\\n' 'check1 "sh -c [ -d /sys/devices/system/edac ]"' 'node1 "/bin/k3d-entrypoint.sh server"'
[[ "$1 $2" != "network inspect" ]] || [[ -n $NETWORK ]]`,
  );
  stub(
    "k3d",
    `[[ "$1 $2" != "cluster get" ]] || [[ -n $EXISTS ]] || exit 1
[[ "$1 $2" != "cluster create" ]] || [[ $CREATE != hang ]] || sleep 30`,
  );
  stub(
    "kubectl",
    `[[ $* == *"rollout status"* ]] || exit 0
case $ROLLOUT in fail) exit 1 ;; hang) sleep 30 ;; esac`,
  );
  stub("openssl", "exit 1");
  stub(
    "git",
    `if [[ $1 == clone ]]; then d="\${@: -1}/deploy/kubernetes-latest"; mkdir -p "$d"; printf '#!/bin/sh\\n' > "$d/deploy.sh"; chmod +x "$d/deploy.sh"; fi`,
  );
  // Existing certificates and setup key skip key generation; kubectl only
  // receives their paths.
  writeFileSync(join(dir, "work", "ca.pem"), "");
  writeFileSync(join(dir, "work", "setup-key"), "");
  const env: Record<string, string> = {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    ISOMUX_VERIFY_DIR: join(dir, "work"),
    PRESENT: options.present ? "1" : "",
    EXISTS: options.exists ? "1" : "",
    NETWORK: options.network ? "1" : "",
    CHECKS: options.checks ? "1" : "",
    ROLLOUT: options.rollout ?? "",
    CREATE: options.createHangs ? "hang" : "",
  };
  if (options.image) env.ISOMUX_VERIFY_IMAGE = options.image;
  const events = () =>
    existsSync(join(dir, "events"))
      ? readFileSync(join(dir, "events"), "utf8").trim().split("\n")
      : [];
  const outcome = (code: number | null) => {
    const marker = join(dir, "work", "pulled");
    return {
      code,
      events: events(),
      marker: existsSync(marker) ? readFileSync(marker, "utf8").trim() : null,
    };
  };
  // Runs the script; its events are the calls this run made.
  const run = (args: string[]) => {
    const before = events().length;
    const result = outcome(
      Bun.spawnSync(["bash", SCRIPT, ...args], { env }).exitCode,
    );
    return { ...result, events: result.events.slice(before) };
  };
  return { env, events, outcome, run };
}

function invoke(args: string[], options: Options = {}) {
  return setup(options).run(args);
}

// Runs `up` until a stub records the REACHED call, then interrupts it. setsid
// makes bash a process group leader, so the interrupt reaches the whole
// group, as Ctrl-C does.
async function interruptUp(options: Options, reached: string) {
  const { env, events, outcome } = setup(options);
  const child = Bun.spawn(["setsid", "bash", SCRIPT, "up"], { env });
  const deadline = Date.now() + 5_000;
  while (!events().some((e) => e.startsWith(reached))) {
    if (Date.now() > deadline) {
      process.kill(-child.pid, "SIGKILL");
      throw new Error(`up never reached ${reached}`);
    }
    await Bun.sleep(20);
  }
  process.kill(-child.pid, "SIGINT");
  return outcome(await child.exited);
}

const imageEvents = (events: string[]) =>
  events.filter((e) => /^docker image (rm|pull)|^docker pull/.test(e));

const DELETE = "k3d cluster delete isomux-verify";
const NETWORK = "docker network inspect k3d-isomux-verify";
const CHECKS = `docker ps -a --no-trunc --filter status=exited --filter ancestor=${K3S_IMAGE} --format {{.ID}} {{.Command}}`;
const fromDelete = (events: string[]) => events.slice(events.indexOf(DELETE));

test("down removes the released image that up pulled", () => {
  const fx = setup({});
  const up = fx.run(["up"]);
  expect(up.code).toBe(0);
  expect(imageEvents(up.events)).toEqual([`docker pull --quiet ${RELEASED}`]);
  expect(up.marker).toBe(RELEASED);
  expect(up.events).not.toContain(DELETE);
  const down = fx.run(["down"]);
  expect(down.code).toBe(0);
  expect(down.events).toEqual([
    DELETE,
    NETWORK,
    CHECKS,
    `docker image rm ${RELEASED}`,
  ]);
  expect(down.marker).toBeNull();
});

test("down keeps an image that was present before up", () => {
  const fx = setup({ present: true });
  const up = fx.run(["up"]);
  expect(up.code).toBe(0);
  expect(imageEvents(up.events)).toEqual([]);
  expect(up.marker).toBeNull();
  const down = fx.run(["down"]);
  expect(down.code).toBe(0);
  expect(down.events).toEqual([DELETE, NETWORK, CHECKS]);
});

test("up refuses a cluster that already exists and leaves it alone", () => {
  const result = invoke(["up"], { exists: true });
  expect(result.code).not.toBe(0);
  // The refusal comes from the existence check, and nothing runs after it.
  expect(result.events).toEqual(["k3d cluster get isomux-verify"]);
});

test("a failed up deletes the cluster and the image it pulled", () => {
  const result = invoke(["up"], { rollout: "fail" });
  expect(result.code).not.toBe(0);
  expect(result.events.some((e) => e.startsWith("k3d cluster create"))).toBe(
    true,
  );
  expect(fromDelete(result.events)).toEqual([
    DELETE,
    NETWORK,
    CHECKS,
    `docker image rm ${RELEASED}`,
  ]);
  expect(result.marker).toBeNull();
});

test("an up interrupted during the create deletes the cluster", async () => {
  const result = await interruptUp(
    { createHangs: true, present: true },
    "k3d cluster create",
  );
  expect(result.code).not.toBe(0);
  expect(result.events.some((e) => e.startsWith("kubectl"))).toBe(false);
  expect(fromDelete(result.events)).toEqual([DELETE, NETWORK, CHECKS]);
}, 15_000);

test("up records no pull for a local image", () => {
  const result = invoke(["up"], { image: "isomux:local" });
  expect(result.code).toBe(0);
  expect(result.events).toContain(
    "k3d image import --cluster isomux-verify isomux:local",
  );
  expect(result.marker).toBeNull();
});

test("down removes the check container that k3d leaves, and no node", () => {
  const result = invoke(["down"], { checks: true });
  expect(result.code).toBe(0);
  expect(result.events.filter((e) => e.startsWith("docker rm"))).toEqual([
    "docker rm check1",
  ]);
});

test("down removes the network that k3d keeps", () => {
  const result = invoke(["down"], { network: true });
  expect(result.code).toBe(0);
  expect(result.events).toContain("docker network rm k3d-isomux-verify");
});
