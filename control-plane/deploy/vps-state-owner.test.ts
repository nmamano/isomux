// own_state (control-plane/deploy/vps/running.sh): the step that gives the
// provisioner state volume to the user the next provisioner image runs as,
// before a deploy starts it and before a rollback starts the previous one.
// Against a stub of docker first on PATH; nothing here touches Docker.
//
// The stub answers `volume inspect` with volume.code, an image inspect with
// the user in user.out (or image.code), and `run` with run.code. It records
// every call. local-proof.sh proves the real chown on a real volume.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUNNING = path.join(import.meta.dir, "vps", "running.sh");
const IMAGE = "isomux-hosted-provisioner:0123456789ab-20261111T000000Z";
const VOLUME = "isomux-hosted_provisioner-state";

const STUB_DOCKER = `#!/usr/bin/env bash
d=\${0%/*}
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$d/count"
printf '%s\\0' "$@" >"$d/call$n.argv"
case "$1 $2" in
  "volume inspect")
    exit "$(cat "$d/volume.code" 2>/dev/null || echo 0)" ;;
  "image inspect"|"inspect "*)
    code=$(cat "$d/image.code" 2>/dev/null || echo 0)
    [[ $code == 0 ]] && cat "$d/user.out"
    exit "$code" ;;
  "run "*)
    exit "$(cat "$d/run.code" 2>/dev/null || echo 0)" ;;
esac
exit 99
`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vps-state-owner-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

interface Run {
  status: number | null;
  stderr: string;
  calls: string[][];
}

let counter = 0;
// One own_state call as deploy.sh's roll_back makes it: set -euo pipefail
// sourced, called in a || context, where set -e does not reach inside the
// function, so every failure must be an explicit return.
function ownState(user: string, answers: Record<string, string> = {}): Run {
  const dir = path.join(scratch, `stub${++counter}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "docker"), STUB_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "user.out"), `${user}\n`);
  for (const [name, body] of Object.entries(answers)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  const r = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; own_state "$2" "$3" && s=0 || s=$?; exit "$s"',
      "_",
      RUNNING,
      IMAGE,
      VOLUME,
    ],
    {
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
      encoding: "utf8",
    },
  );
  const count = fs.existsSync(path.join(dir, "count"))
    ? Number(fs.readFileSync(path.join(dir, "count"), "utf8"))
    : 0;
  const calls: string[][] = [];
  for (let n = 1; n <= count; n++) {
    calls.push(
      fs
        .readFileSync(path.join(dir, `call${n}.argv`), "utf8")
        .split("\0")
        .slice(0, -1),
    );
  }
  return { status: r.status, stderr: r.stderr, calls };
}

// The values of a flag in either spelling, `--flag value` or `--flag=value`,
// before the image: after it, the arguments are the command's.
function flagValues(options: string[], flag: string): string[] {
  const values: string[] = [];
  options.forEach((arg, i) => {
    if (arg === flag) values.push(options[i + 1]);
    else if (arg.startsWith(`${flag}=`))
      values.push(arg.slice(flag.length + 1));
  });
  return values;
}

// The docker run call, split at the image into its options and the command.
function theRun(run: Run): { options: string[]; command: string[] } {
  const runs = run.calls.filter((argv) => argv[0] === "run");
  expect(runs.length).toBe(1);
  const argv = runs[0];
  const at = argv.lastIndexOf(IMAGE);
  expect(at).toBeGreaterThan(0);
  return { options: argv.slice(1, at), command: argv.slice(at + 1) };
}

function expectOneLineFailure(run: Run): void {
  expect(run.status).not.toBe(0);
  expect(run.status).not.toBeNull();
  expect(run.stderr.trim()).not.toBe("");
  expect(run.stderr.trim().split("\n").length).toBe(1);
}

describe("own_state gives the state volume to the image's user", () => {
  test("chowns the whole volume, links not followed, to the image's numeric uid:gid", () => {
    const run = ownState("10102:10102");
    expect({ status: run.status, stderr: run.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const { options, command } = theRun(run);

    // The volume is checked first: a run would create a missing one, empty.
    const volumeCheck = run.calls.findIndex(
      (argv) => argv[0] === "volume" && argv[1] === "inspect",
    );
    expect(volumeCheck).toBeGreaterThanOrEqual(0);
    expect(run.calls[volumeCheck]).toContain(VOLUME);
    expect(volumeCheck).toBeLessThan(
      run.calls.findIndex((argv) => argv[0] === "run"),
    );

    expect(
      flagValues(options, "--entrypoint").map((e) => path.basename(e)),
    ).toEqual(["chown"]);
    expect(command.slice(-2)).toEqual(["10102:10102", "/data"]);
    expect(command.slice(0, -2).sort()).toEqual(["-P", "-R", "-h"]);
    // The owner only, never a mode.
    expect(run.calls.flat().some((arg) => /chmod/.test(arg))).toBe(false);
  });

  test("runs as root with only the two capabilities chown needs, no network, no new privileges", () => {
    const { options } = theRun(ownState("10102:10102"));
    expect(options).toContain("--rm");
    expect(flagValues(options, "--user")).toEqual(["0:0"]);
    expect(flagValues(options, "--network")).toEqual(["none"]);
    expect(flagValues(options, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(options, "--cap-add").sort()).toEqual([
      "CHOWN",
      "DAC_READ_SEARCH",
    ]);
    expect(flagValues(options, "--security-opt")).toEqual([
      expect.stringMatching(/^no-new-privileges(:true)?$/),
    ]);
    expect(options).not.toContain("--privileged");
  });

  test("mounts the named volume and nothing else, never as a bind mount", () => {
    const { options } = theRun(ownState("10102:10102"));
    expect(flagValues(options, "-v")).toEqual([]);
    expect(flagValues(options, "--volume")).toEqual([]);
    expect(flagValues(options, "--volumes-from")).toEqual([]);
    const mounts = flagValues(options, "--mount");
    expect(mounts.length).toBe(1);
    const fields = Object.fromEntries(
      mounts[0].split(",").map((field) => field.split("=", 2)),
    );
    expect({
      type: fields.type,
      src: fields.src ?? fields.source,
      dst: fields.dst ?? fields.target ?? fields.destination,
    }).toEqual({ type: "volume", src: VOLUME, dst: "/data" });
  });

  // A pre-change release runs the provisioner as root: a rollback to it gives
  // the volume back to root, or root with no capability cannot read its keys.
  for (const user of ["", "root", "0", "0:0"]) {
    test(`an image with user ${JSON.stringify(user)} gets the volume as 0:0`, () => {
      const run = ownState(user);
      expect(run.status).toBe(0);
      expect(theRun(run).command.slice(-2)).toEqual(["0:0", "/data"]);
    });
  }
});

describe("own_state fails closed", () => {
  // A user it cannot map to a numeric owner: it must not guess one.
  for (const user of [
    "node",
    "10102",
    "10102:",
    ":10102",
    "10102:node",
    "10102:10102:1",
  ]) {
    test(`refuses an image with user ${JSON.stringify(user)} before any run`, () => {
      const run = ownState(user);
      expectOneLineFailure(run);
      // The image's user was read: the refusal is about that user.
      expect(
        run.calls.some(
          (argv) =>
            argv[0] === "inspect" ||
            (argv[0] === "image" && argv[1] === "inspect"),
        ),
      ).toBe(true);
      expect(run.calls.filter((argv) => argv[0] === "run").length).toBe(0);
    });
  }

  // An inspect that fails prints no user; read as empty, that would be root.
  test("an image whose user cannot be read is refused, not taken as root", () => {
    const run = ownState("10102:10102", { "image.code": "1" });
    expectOneLineFailure(run);
    expect(run.calls.filter((argv) => argv[0] === "run").length).toBe(0);
  });

  test("a missing volume is refused before any run", () => {
    const run = ownState("10102:10102", { "volume.code": "1" });
    expectOneLineFailure(run);
    expect(
      run.calls.some((argv) => argv[0] === "volume" && argv[1] === "inspect"),
    ).toBe(true);
    expect(run.calls.filter((argv) => argv[0] === "run").length).toBe(0);
  });

  test("a chown that fails fails the step", () => {
    const run = ownState("10102:10102", { "run.code": "1" });
    expectOneLineFailure(run);
    expect(run.calls.filter((argv) => argv[0] === "run").length).toBe(1);
  });
});
