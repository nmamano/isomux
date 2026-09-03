import { afterEach, describe, expect, it } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const roots: string[] = [];

function produce(target = "v2026.9.3", failMove = false) {
  const root = mkdtempSync(join(tmpdir(), "isomux-update-outcome-"));
  roots.push(root);
  chmodSync(root, 0o755);
  const privateDir = join(root, "private");
  const publicDir = join(root, "public");
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(publicDir, { mode: 0o755 });
  writeFileSync(
    join(privateDir, "status.json"),
    JSON.stringify({ target, message: 'root-only "detail"' }),
  );
  const artifact = join(publicDir, "outcome.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (failMove) {
    writeFileSync(join(bin, "mv"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const script = `
eval "$(sed -n '/^write_update_outcome()/,/^}/p' "$INSTALL_SH")"
UPDATE_STATE_DIR="$PRIVATE_DIR"
UPDATE_OUTCOME_FILE="$ARTIFACT"
UPDATE_OUTCOME_MESSAGES=("Restored installer-managed firewall rule: 443/tcp." "Installer-managed hardening verification failed.")
log() { echo "LOG: $*"; }
write_update_outcome
`;
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: failMove ? `${bin}:${process.env.PATH}` : process.env.PATH,
      INSTALL_SH,
      PRIVATE_DIR: privateDir,
      ARTIFACT: artifact,
    },
  });
  return {
    artifact,
    privateDir,
    publicDir,
    code: result.exitCode,
    out: `${result.stdout}${result.stderr}`,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("deps-only update outcome producer", () => {
  it("writes target identity, UTC time, and sanitized fixed messages", () => {
    const result = produce();
    expect(result.code).toBe(0);
    const parsed = JSON.parse(readFileSync(result.artifact, "utf8"));
    expect(parsed.target).toBe("v2026.9.3");
    expect(parsed.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(parsed.messages).toEqual([
      "Restored installer-managed firewall rule: 443/tcp.",
      "Installer-managed hardening verification failed.",
    ]);
    expect(readFileSync(result.artifact, "utf8")).not.toContain("root-only");
  });

  it("is traversable and readable by this non-root test process", () => {
    expect(process.getuid?.()).not.toBe(0);
    const result = produce();
    const directories: string[] = [];
    for (let path = dirname(result.artifact); ; path = dirname(path)) {
      directories.push(path);
      if (path === "/") break;
    }
    for (const path of directories) {
      expect(statSync(path).mode & 0o001).toBe(0o001);
      accessSync(path, constants.X_OK);
    }
    expect(statSync(result.artifact).mode & 0o004).toBe(0o004);
    accessSync(result.artifact, constants.R_OK);
    expect(statSync(result.privateDir).mode & 0o077).toBe(0);
  });

  it("publishes by rename and leaves no staged file", () => {
    const result = produce();
    expect(readdirSync(result.publicDir)).toEqual(["outcome.json"]);
    const source = readFileSync(INSTALL_SH, "utf8");
    expect(source).toContain('mv -f "$tmp" "$UPDATE_OUTCOME_FILE"');
    expect(source).not.toContain('rm -f "$UPDATE_OUTCOME_FILE"');
  });

  it("does not publish when the updater target cannot be identified", () => {
    const result = produce("main");
    expect(result.code).toBe(0);
    expect(() => readFileSync(result.artifact)).toThrow();
    expect(result.out).toContain(
      "update outcome was not recorded because the target release could not be identified",
    );
  });

  it("keeps the update successful when atomic publication fails", () => {
    const result = produce("v2026.9.3", true);
    expect(result.code).toBe(0);
    expect(() => readFileSync(result.artifact)).toThrow();
    expect(readdirSync(result.publicDir)).toEqual([]);
    expect(result.out).toContain("update outcome could not be recorded");
  });
});
