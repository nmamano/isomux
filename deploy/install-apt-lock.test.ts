import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const roots: string[] = [];

function runApt(command: "update" | "install", heldFor: number) {
  const root = mkdtempSync(join(tmpdir(), "isomux-apt-lock-"));
  roots.push(root);
  const apt = join(root, "apt-get");
  const lslocks = join(root, "lslocks");
  const sleep = join(root, "sleep");
  const elapsed = join(root, "elapsed");
  const calls = join(root, "calls");
  writeFileSync(elapsed, "0\n");
  writeFileSync(
    apt,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
timeout=""
for arg in "$@"; do
  [[ $arg == DPkg::Lock::Timeout=* ]] && timeout=\${arg#*=}
done
[[ $timeout =~ ^[0-9]+$ ]] && ((timeout >= 0)) || exit 100
elapsed=$(cat "$ELAPSED")
((elapsed >= HELD_FOR)) || exit 100
`,
  );
  chmodSync(apt, 0o755);
  writeFileSync(
    lslocks,
    `#!/usr/bin/env bash
elapsed=$(cat "$ELAPSED")
((elapsed < HELD_FOR)) && echo /var/lib/dpkg/lock-frontend
`,
  );
  chmodSync(lslocks, 0o755);
  writeFileSync(
    sleep,
    `#!/usr/bin/env bash
elapsed=$(cat "$ELAPSED")
echo $((elapsed + $1)) > "$ELAPSED"
`,
  );
  chmodSync(sleep, 0o755);
  const script = `
eval "$(grep -m1 '^APT_LOCK_TIMEOUT_SECONDS=' "$INSTALL_SH")"
eval "$(grep -m1 '^APT_LOCK_POLL_SECONDS=' "$INSTALL_SH")"
APT_LOCK_POLL_SECONDS=10
eval "$(sed -n '/^package_manager_locked()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^wait_for_package_manager()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^apt_get()/,/^}/p' "$INSTALL_SH")"
eval "$(sed -n '/^report_failure()/,/^}/p' "$INSTALL_SH")"
run() { "$@"; }
log() { echo "LOG: $*"; }
CURRENT_STEP=install-packages
FAILURE_SENTINEL=""
CADDY_MASKED=""
CADDY_SNAPSHOT_ARMED=""
INSTALL_CALLBACK_URL=""
DRY_RUN=""
restore_caddy_state() { return 0; }
apt_get ${command} -y || { rc=$?; report_failure; exit "$rc"; }
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${root}:/usr/bin:/bin`,
      INSTALL_SH,
      CALLS: calls,
      HELD_FOR: String(heldFor),
      ELAPSED: elapsed,
    },
  });
  return {
    code: result.exitCode,
    out: `${result.stdout}${result.stderr}`,
    call: existsSync(calls) ? readFileSync(calls, "utf8").trim() : "",
    elapsed: Number(readFileSync(elapsed, "utf8")),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("install.sh apt lock bound", () => {
  // Ubuntu's first-boot updates hold the lock for about a minute; the bound is
  // inclusive.
  for (const [command, heldFor] of [
    ["update", 70],
    ["install", 120],
  ] as const) {
    it(`lets apt-get ${command} outwait a lock held for ${heldFor} seconds`, () => {
      const result = runApt(command, heldFor);
      expect(result.code).toBe(0);
      expect(result.elapsed).toBeGreaterThanOrEqual(heldFor);
      expect(result.call).toContain(`DPkg::Lock::Timeout=120 ${command} -y`);
    });
  }

  it("fails once a held lock exceeds the bound", () => {
    const result = runApt("update", 121);
    expect(result.code).toBe(100);
    expect(result.out).toContain("INSTALL FAILED at step: install-packages");
  });
});
