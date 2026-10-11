import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const step = source.slice(
  source.indexOf("link_bundled_claude() {"),
  source.indexOf("# Root-of-trust config"),
);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "isomux-claude-link-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const other = join(dir, "other-bin");
  const install = join(dir, "install");
  const target = join(
    install,
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  );
  const link = join(bin, "claude");
  mkdirSync(bin);
  mkdirSync(other);
  mkdirSync(join(target, ".."), { recursive: true });
  const executable = (path: string, version: string) => {
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(path, 0o755);
  };
  executable(target, "bundled-v1");
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `set -euo pipefail
step() { :; }
log() { printf '%s\\n' "$*"; }
as_service_user() {
  printf '%s\\n' "$*" >> "$FIXTURE/calls"
  if [[ $1 == /usr/local/bin/bun ]]; then
    [[ $2 == -e && $4 == "$INSTALL_DIR/server/cwd-utils.ts" ]] || return 91
    printf '%s' "$SDK_BINARY"
  else
    "$@"
  fi
}
${step.replace("/usr/local/bin:/usr/bin:/bin", `${bin}:${other}:/usr/bin:/bin`).replaceAll("/usr/local/bin/claude", link)}
link_bundled_claude
printf 'continued\\n'
`,
  );
  return {
    dir,
    bin,
    other,
    install,
    target,
    link,
    executable,
    run(dry = false, sdkBinary = target) {
      const result = Bun.spawnSync(["bash", script], {
        env: {
          ...process.env,
          FIXTURE: dir,
          INSTALL_DIR: install,
          SDK_BINARY: sdkBinary,
          DRY_RUN: dry ? "1" : "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: result.exitCode,
        output: result.stdout.toString() + result.stderr.toString(),
      };
    },
  };
}

describe("bundled Claude terminal link", () => {
  it("creates the link through the agents' resolver and follows a replaced SDK binary", () => {
    const f = fixture();
    expect(f.run().code).toBe(0);
    expect(readlinkSync(f.link)).toBe(f.target);
    const calls = readFileSync(join(f.dir, "calls"), "utf8");
    expect(calls).toContain(
      `env PATH=${f.bin}:${f.other}:/usr/bin:/bin sh -c command -v claude`,
    );
    expect(calls).toContain("CLAUDE_NATIVE_BIN");
    f.executable(f.target, "bundled-v2");
    const result = Bun.spawnSync([f.link, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("bundled-v2");
  });

  it("does not shadow an existing command in another service PATH directory", () => {
    const f = fixture();
    f.executable(join(f.other, "claude"), "existing");
    expect(f.run().code).toBe(0);
    expect(existsSync(f.link)).toBe(false);
  });

  it("leaves an existing executable file untouched", () => {
    const f = fixture();
    f.executable(f.link, "existing");
    const bytes = readFileSync(f.link);
    expect(f.run().code).toBe(0);
    expect(lstatSync(f.link).isSymbolicLink()).toBe(false);
    expect(readFileSync(f.link)).toEqual(bytes);
  });

  it("leaves an existing working link elsewhere untouched", () => {
    const f = fixture();
    const existing = join(f.dir, "existing");
    f.executable(existing, "existing");
    symlinkSync(existing, f.link);
    expect(f.run().code).toBe(0);
    expect(readlinkSync(f.link)).toBe(existing);
  });

  it("repairs a dangling link into this install's SDK packages", () => {
    const f = fixture();
    symlinkSync(
      join(
        f.install,
        "node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
      ),
      f.link,
    );
    expect(f.run().code).toBe(0);
    expect(readlinkSync(f.link)).toBe(f.target);
  });

  it("leaves a foreign dangling link untouched", () => {
    const f = fixture();
    const foreign = join(
      f.dir,
      "other-install/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    );
    symlinkSync(foreign, f.link);
    expect(f.run().code).toBe(0);
    expect(readlinkSync(f.link)).toBe(foreign);
  });

  it("leaves an existing non-executable file untouched", () => {
    const f = fixture();
    writeFileSync(f.link, "reserved");
    expect(f.run().code).toBe(0);
    expect(lstatSync(f.link).isSymbolicLink()).toBe(false);
    expect(readFileSync(f.link, "utf8")).toBe("reserved");
  });

  it("makes no link in a dry run", () => {
    const f = fixture();
    expect(f.run(true).code).toBe(0);
    expect(existsSync(f.link)).toBe(false);
  });

  it("warns and continues when the resolver returns a binary outside this install", () => {
    const f = fixture();
    const foreign = join(f.dir, "foreign-sdk");
    f.executable(foreign, "foreign");
    const result = f.run(false, foreign);
    expect(result.code).toBe(0);
    expect(existsSync(f.link)).toBe(false);
    expect(result.output).toMatch(/warning:/);
    expect(result.output).toContain("continued");
  });

  it("warns and continues when the SDK binary is missing", () => {
    const f = fixture();
    rmSync(f.target);
    const result = f.run();
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/warning:/);
    expect(result.output).toContain("continued");
    expect(existsSync(f.link)).toBe(false);
  });
});
