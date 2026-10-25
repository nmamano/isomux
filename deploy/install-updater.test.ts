// deploy/install.sh install_updater - the root-owned record of the installed
// release that scripts/update.sh bases its downgrade refusal on. The function
// runs in bash with its system paths (/etc unit and polkit files) redirected
// into a temp dir and systemctl stubbed; the release refs come from a local
// bare origin. Nothing outside the temp dir is touched.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;

let base: string;
let origin: string;
let stateDir: string;

function git(cwd: string, cmd: string): void {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-install-updater-test-"));
  const src = join(base, "src");
  mkdirSync(join(src, "scripts"), { recursive: true });
  git(
    src,
    "git init -q -b main && git config user.email t@t && git config user.name T",
  );
  writeFileSync(join(src, "scripts", "update.sh"), "# fake updater\n");
  git(src, "git add . && git commit -qm c1 && git tag -a v2026.7.18 -m c1");
  writeFileSync(join(src, "app.txt"), "new\n");
  git(src, "git add . && git commit -qm c2 && git tag -a v2026.7.20 -m c2");
  origin = join(base, "origin.git");
  git(base, `git clone -q --bare ${src} ${origin}`);
  stateDir = join(base, "update-state");
  mkdirSync(join(base, "sbin"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runInstallUpdater(ref: string): string {
  const script = `
set -Eeuo pipefail
log() { echo "LOG: $*"; }
die() { echo "DIE: $*"; exit 1; }
step() { :; }
eval "$(sed -n '/^install_updater()/,/^}$/p' "$INSTALL_SH")"
reroot() { if [[ $1 == /etc/* ]]; then echo "$BASE/root$1"; else echo "$1"; fi; }
write_file() {
  local path
  path=$(reroot "$1")
  mkdir -p "$(dirname "$path")"
  cat >"$path"
  chmod "$2" "$path"
}
install() {
  local args=() a
  for a in "$@"; do args+=("$(reroot "$a")"); done
  command install "\${args[@]}"
}
systemctl() { :; }
DRY_RUN=""
UPDATE_CONF=$BASE/etc/isomux/update.conf
UPDATE_STATE_DIR=$BASE/update-state
UPDATER_PATH=$BASE/sbin/isomux-update
ISOMUX_REPO=$BASE/origin.git
ISOMUX_REF=$REF
INSTALL_DIR=$BASE/checkout
SERVICE_USER=isomux
SERVICE_HOME=$BASE/home
install_updater
echo INSTALLED
`;
  const r = spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH ?? "", INSTALL_SH, BASE: base, REF: ref },
    encoding: "utf8",
  });
  const out = `${r.stdout}${r.stderr}`;
  // The enabling condition: the function ran to the end and installed the
  // updater, so an absent record is the function's choice.
  expect(out).toContain("INSTALLED");
  expect(existsSync(join(base, "sbin", "isomux-update"))).toBe(true);
  return out;
}

const recordPath = () => join(stateDir, "installed-release");

describe("install.sh install_updater installed-release record", () => {
  it("a release ref is recorded, also over a record of a newer release", () => {
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(recordPath(), "v2026.7.20\n");
    runInstallUpdater("v2026.7.18");
    expect(readFileSync(recordPath(), "utf8").trim()).toBe("v2026.7.18");
  });

  it("a ref that is not a release leaves the record as it is", () => {
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(recordPath(), "v2026.7.20\n");
    runInstallUpdater("main");
    expect(readFileSync(recordPath(), "utf8").trim()).toBe("v2026.7.20");
  });
});
