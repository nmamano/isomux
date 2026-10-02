import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./prepare-container-update-fixture.py", import.meta.url)
  .pathname;
const PUBLISH = new URL("./container/publish.py", import.meta.url).pathname;
const IMAGE = "localhost:15000/isomux-fixture";
const REGISTRY = "isomux-update-fixture-registry";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Docker stand-in that records every call. $FIXTURE/container holds the one
// container named REGISTRY: its id, then one label per line. `ps` applies the
// name and label filters to it, `rm` deletes it, `image ls` prints
// $FIXTURE/listed and a removed reference no longer inspects. `run` follows
// RUN: "created" leaves a created container and fails as a port conflict
// does; "collision" fails because another run took the name; "ok" starts.
const DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIXTURE/events"
store() { { echo "$1"; shift; printf '%s\\n' "$@"; } > "$FIXTURE/container"; }
case "$1 $2" in
  "ps -aq")
    [[ -f $FIXTURE/container ]] || exit 0
    shift 2
    while [[ $# -gt 0 ]]; do
      filter=$2; shift 2
      case $filter in
        name=*) ;;
        label=*=*) tail -n +2 "$FIXTURE/container" | grep -qxF "\${filter#label=}" || exit 0 ;;
        label=*) tail -n +2 "$FIXTURE/container" | grep -q "^\${filter#label=}=" || exit 0 ;;
      esac
    done
    head -n 1 "$FIXTURE/container" ;;
  "run -d")
    labels=(); while [[ $# -gt 0 ]]; do [[ $1 == --label ]] && labels+=("$2"); shift; done
    case $RUN in
      created) store c0ffee000001 "\${labels[@]}"; exit 125 ;;
      collision) store f0f0f0f0f0f0 isomux.updater-fixture=other isomux.updater-fixture-run=other; exit 125 ;;
      ok) store c0ffee000001 "\${labels[@]}"; echo c0ffee000001 ;;
    esac ;;
  "rm -f")
    [[ $(head -n 1 "$FIXTURE/container" 2>/dev/null) == "$4" ]] && rm "$FIXTURE/container"; true ;;
  "image ls") [[ $3 == -q ]] || cat "$FIXTURE/listed" ;;
  "image inspect") ! grep -qxF "$3" "$FIXTURE/removed" ;;
  "image rm") echo "$3" >> "$FIXTURE/removed" ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "isomux-fixture-cleanup-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "listed"), "");
  writeFileSync(join(dir, "removed"), "");
  writeFileSync(join(dir, "events"), "");
  writeFileSync(join(dir, "bin", "docker"), DOCKER);
  chmodSync(join(dir, "bin", "docker"), 0o755);
  return dir;
}

function spawn(dir: string, script: string, args: string[], run = "") {
  const result = Bun.spawnSync(["python3", "-B", script, ...args], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      FIXTURE: dir,
      RUN: run,
    },
  });
  const events = readFileSync(join(dir, "events"), "utf8").trim().split("\n");
  return { code: result.exitCode, events };
}

const removedImages = (events: string[]) =>
  events.filter((e) => e.startsWith("image rm ")).map((e) => e.slice(9));
const removedContainers = (events: string[]) =>
  events.filter((e) => e.startsWith("rm "));

function cleanup(listed: string[], labels: string[] | null) {
  const dir = fixture();
  writeFileSync(join(dir, "listed"), listed.join("\n") + "\n");
  if (labels)
    writeFileSync(join(dir, "container"), ["0123456789ab", ...labels].join("\n"));
  return { ...spawn(dir, SCRIPT, ["--cleanup"]), dir };
}

// A committed copy of the script in its own checkout, so the fixture output
// directory (beside the checkout) is private to the test.
function prepare(run: string) {
  const dir = fixture();
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts", "container"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "prepare-container-update-fixture.py"));
  copyFileSync(PUBLISH, join(repo, "scripts", "container", "publish.py"));
  writeFileSync(
    join(repo, "scripts", "update.sh"),
    "CONTAINER_IMAGE=ghcr.io/nmamano/isomux\n",
  );
  const git = (...args: string[]) =>
    expect(
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: dir },
      }).exitCode,
    ).toBe(0);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const script = join(repo, "scripts", "prepare-container-update-fixture.py");
  return { ...spawn(dir, script, [], run), dir };
}

test("fixture cleanup removes the labelled registry with its volume and every fixture reference", () => {
  const { code, events } = cleanup(
    [
      `${IMAGE} v2099.1.1 sha256:${"a".repeat(64)}`,
      `${IMAGE} v2099.1.2 sha256:${"b".repeat(64)}`,
      `${IMAGE} <none> sha256:${"c".repeat(64)}`,
      `${IMAGE}-other v1 sha256:${"d".repeat(64)}`,
    ],
    ["isomux.updater-fixture=0123", "isomux.updater-fixture-run=0123"],
  );
  expect(code).toBe(0);
  expect(removedContainers(events)).toEqual(["rm -f -v 0123456789ab"]);
  expect(removedImages(events).sort()).toEqual(
    [
      `${IMAGE}:v2099.1.1`,
      `${IMAGE}:v2099.1.2`,
      `${IMAGE}@sha256:${"a".repeat(64)}`,
      `${IMAGE}@sha256:${"b".repeat(64)}`,
      `${IMAGE}@sha256:${"c".repeat(64)}`,
    ].sort(),
  );
});

test("fixture cleanup leaves a container without the fixture label alone", () => {
  const { code, events, dir } = cleanup([], ["com.example.other=1"]);
  expect(code).toBe(0);
  expect(removedContainers(events)).toEqual([]);
  expect(existsSync(join(dir, "container"))).toBe(true);
});

test("a registry that was created but failed to start is removed with its volume", () => {
  const { code, events, dir } = prepare("created");
  expect(code).not.toBe(0);
  expect(events.some((e) => e.startsWith(`run -d --name ${REGISTRY}`))).toBe(true);
  expect(removedContainers(events)).toEqual(["rm -f -v c0ffee000001"]);
  expect(existsSync(join(dir, "container"))).toBe(false);
});

test("a registry another run created under the same name is left alone", () => {
  const { code, events, dir } = prepare("collision");
  expect(code).not.toBe(0);
  expect(removedContainers(events)).toEqual([]);
  expect(existsSync(join(dir, "container"))).toBe(true);
  expect(events.some((e) => e.startsWith("image ls --digests"))).toBe(false);
});

test("a failure after the registry starts removes the registry and the fixture images", () => {
  const { code, events, dir } = prepare("ok");
  expect(code).not.toBe(0);
  expect(removedContainers(events)).toEqual(["rm -f -v c0ffee000001"]);
  expect(existsSync(join(dir, "container"))).toBe(false);
  expect(events.some((e) => e.startsWith("image ls --digests"))).toBe(true);
});
