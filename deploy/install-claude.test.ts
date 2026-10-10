import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const installer = source.slice(source.indexOf("install_claude_cli() {"), source.indexOf("\ninstall_github_cli()"));
const asUser = source.slice(source.indexOf("as_service_user() {"), source.indexOf("\nrun_as_service_user()"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(mode = "success") {
  const dir = mkdtempSync(join(tmpdir(), "isomux-native-claude-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin); mkdirSync(home);
  const executable = (path: string, text: string) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  // Only the user switch is stubbed. The native install pipeline, HOME,
  // launcher chain and PATH lookup run in real Bash without host mutations.
  executable(join(bin, "runuser"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE/user-calls"
[[ "$1 $2 $3" == '-u service-fixture --' ]] || exit 91
shift 3
exec "$@"
`);
  executable(join(bin, "curl"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE/downloads"
[[ "$MODE" != download-fails ]] || exit 22
cat <<'NATIVE'
[[ "$MODE" != install-fails ]] || exit 23
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude/versions"
printf '#!/bin/bash\\nprintf "native-v1\\\\n"\\n' > "$HOME/.local/share/claude/versions/1"
chmod +x "$HOME/.local/share/claude/versions/1"
ln -s ../share/claude/versions/1 "$HOME/.local/bin/claude"
NATIVE
`);
  const harness = join(dir, "run.sh");
  writeFileSync(harness, `set -euo pipefail
SERVICE_USER=service-fixture
SERVICE_HOME="$FIXTURE/home"
DRY_RUN="\${DRY_RUN:-}"
step() { :; }
log() { printf '%s\\n' "$*"; }
${asUser}
${installer.replaceAll("/usr/local/bin", bin)}
install_claude_cli
printf 'continued\\n'
`);
  return { dir, bin, home, executable, run: (dry = false) => {
    const result = Bun.spawnSync(["bash", harness], { env: { ...process.env, HOME: "/root-wrong-home", PATH: `${bin}:/usr/bin:/bin`, FIXTURE: dir, MODE: mode, DRY_RUN: dry ? "1" : "" }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  } };
}

describe("native Claude installer", () => {
  it("installs as the service user and follows the user-owned launcher across updates", () => {
    const f = fixture();
    expect(f.run().code).toBe(0);
    const target = join(f.home, ".local/bin/claude");
    expect(readlinkSync(join(f.bin, "claude"))).toBe(target);
    const calls = readFileSync(join(f.dir, "user-calls"), "utf8").trim().split("\n");
    expect(calls.every((line) => line.startsWith(`-u service-fixture -- env HOME=${f.home} `))).toBe(true);
    expect(calls.some((line) => line.includes("bash -o pipefail -c"))).toBe(true);
    expect(readFileSync(join(f.dir, "downloads"), "utf8")).toContain("https://claude.ai/install.sh");
    f.executable(join(f.home, ".local/share/claude/versions/2"), "#!/bin/bash\necho native-v2\n");
    rmSync(target); symlinkSync("../share/claude/versions/2", target);
    const updated = Bun.spawnSync(["bash", "-c", "claude --version"], { env: { PATH: `${f.bin}:/usr/bin:/bin` } });
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout.toString().trim()).toBe("native-v2");
  });

  it("does not download or change links after a successful native install", () => {
    const f = fixture();
    expect(f.run().code).toBe(0);
    const downloads = readFileSync(join(f.dir, "downloads"), "utf8");
    const launcher = readlinkSync(join(f.bin, "claude"));
    expect(f.run().code).toBe(0);
    expect(readFileSync(join(f.dir, "downloads"), "utf8")).toBe(downloads);
    expect(readlinkSync(join(f.bin, "claude"))).toBe(launcher);
  });

  for (const dangling of [false, true]) {
    it(`repairs a ${dangling ? "dangling" : "missing"} system link without reinstalling the native launcher`, () => {
      const f = fixture();
      mkdirSync(join(f.home, ".local/bin"), { recursive: true });
      f.executable(join(f.home, ".local/bin/claude"), "#!/bin/bash\necho partial-native\n");
      if (dangling) symlinkSync(join(f.dir, "missing-version"), join(f.bin, "claude"));
      expect(f.run().code).toBe(0);
      expect(readlinkSync(join(f.bin, "claude"))).toBe(join(f.home, ".local/bin/claude"));
      expect(existsSync(join(f.dir, "downloads"))).toBe(false);
    });
  }

  it("leaves an existing CLI untouched and does not download a second install", () => {
    const f = fixture();
    const existing = "#!/bin/bash\necho existing-cli\n";
    f.executable(join(f.bin, "claude"), existing);
    expect(f.run().code).toBe(0);
    expect(readFileSync(join(f.bin, "claude"), "utf8")).toBe(existing);
    expect(existsSync(join(f.dir, "downloads"))).toBe(false);
    expect(existsSync(join(f.home, ".local"))).toBe(false);
  });

  for (const mode of ["download-fails", "install-fails"]) {
    it(`warns and continues when ${mode}`, () => {
      const f = fixture(mode);
      const result = f.run();
      expect(result.code).toBe(0);
      expect(result.output).toMatch(/warning:/);
      expect(result.output).toContain("continued");
      expect(existsSync(join(f.bin, "claude"))).toBe(false);
    });
  }

  it("does not download or link during a dry run", () => {
    const f = fixture();
    expect(f.run(true).code).toBe(0);
    expect(existsSync(join(f.dir, "downloads"))).toBe(false);
    expect(existsSync(join(f.bin, "claude"))).toBe(false);
  });
});
