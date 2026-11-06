// deploy/install.sh unlink_bundled_claude (task 88e54847). Older installers
// linked /usr/local/bin/claude into $INSTALL_DIR/node_modules, which the
// service user writes, so root's `claude` ran a binary the agents could
// replace. The step removes only that link and creates nothing. The step is
// extracted unmodified, except that the link path points into a fixture.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const start = source.indexOf("\nunlink_bundled_claude() {\n") + 1;
if (start === 0) throw new Error("install.sh has no unlink_bundled_claude()");
const step = source.slice(start, source.indexOf("\n}\n", start) + 3);
const SDK = "node_modules/@anthropic-ai";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(join(dir, "bin"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "isomux-claude-unlink-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const install = join(dir, "install");
  const target = join(install, SDK, "claude-agent-sdk-linux-x64/claude");
  const link = join(bin, "claude");
  mkdirSync(bin);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "#!/bin/sh\necho bundled\n");
  chmodSync(target, 0o755);
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `set -Eeuo pipefail
trap 'echo ERR-TRAP' ERR
step() { printf 'STEP:%s\\n' "$1"; }
log() { printf '%s\\n' "$*"; }
${step.replaceAll("/usr/local/bin/claude", link)}
unlink_bundled_claude
printf 'continued\\n'
`,
  );
  return {
    dir,
    bin,
    install,
    target,
    link,
    run(dry = false) {
      const result = Bun.spawnSync(["bash", script], {
        env: { ...process.env, INSTALL_DIR: install, DRY_RUN: dry ? "1" : "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      // The step ran, returned success and set -e never fired inside it.
      expect({
        code: result.exitCode,
        reached: output.includes("STEP:unlink-bundled-claude"),
        continued: output.includes("continued"),
        errTrap: output.includes("ERR-TRAP"),
      }).toEqual({ code: 0, reached: true, continued: true, errTrap: false });
      return output;
    },
  };
}

describe("unlink_bundled_claude", () => {
  it("removes the link into this install's SDK and leaves the binary", () => {
    const f = fixture();
    symlinkSync(f.target, f.link);
    f.run();
    expect(readdirSync(f.bin)).toEqual([]);
    // rm removed the link, not the file it pointed to.
    expect(readFileSync(f.target, "utf8")).toContain("bundled");
  });

  for (const variant of ["linux-arm64", "linux-x64-musl", "linux-arm64-musl"]) {
    it(`removes a dangling link into this install's ${variant} package`, () => {
      const f = fixture();
      symlinkSync(
        join(f.install, SDK, `claude-agent-sdk-${variant}/claude`),
        f.link,
      );
      f.run();
      expect(readdirSync(f.bin)).toEqual([]);
    });
  }

  it("creates nothing when there is no link", () => {
    const f = fixture();
    f.run();
    expect(readdirSync(f.bin)).toEqual([]);
  });

  // Each kept entry is left byte for byte, and nothing is added next to it.
  const keeps: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      "a link into another install whose path starts with this one's",
      (f) =>
        symlinkSync(
          join(`${f.install}2`, SDK, "claude-agent-sdk-linux-x64/claude"),
          f.link,
        ),
    ],
    [
      "a link to an unrelated binary",
      (f) => {
        const other = join(f.dir, "other-claude");
        writeFileSync(other, "#!/bin/sh\n");
        symlinkSync(other, f.link);
      },
    ],
    [
      "a link to a link into this install's SDK (never resolved)",
      (f) => {
        const hop = join(f.dir, "hop");
        symlinkSync(f.target, hop);
        symlinkSync(hop, f.link);
      },
    ],
    [
      "a relative link that names the SDK path",
      (f) => symlinkSync(`${SDK}/claude-agent-sdk-linux-x64/claude`, f.link),
    ],
    ["a regular file", (f) => writeFileSync(f.link, "reserved")],
    ["a directory", (f) => mkdirSync(f.link)],
  ];
  for (const [name, make] of keeps) {
    it(`keeps ${name}`, () => {
      const f = fixture();
      make(f);
      const before = lstatSync(f.link);
      const linkText = before.isSymbolicLink() ? readlinkSync(f.link) : null;
      f.run();
      expect(readdirSync(f.bin)).toEqual(["claude"]);
      const after = lstatSync(f.link);
      expect({
        ino: after.ino,
        mode: after.mode,
        link: after.isSymbolicLink() ? readlinkSync(f.link) : null,
      }).toEqual({ ino: before.ino, mode: before.mode, link: linkText });
    });
  }

  it("keeps the link in a dry run", () => {
    const f = fixture();
    symlinkSync(f.target, f.link);
    f.run(true);
    expect(readlinkSync(f.link)).toBe(f.target);
  });

  it("warns and continues when the link cannot be removed", () => {
    const f = fixture();
    symlinkSync(f.target, f.link);
    chmodSync(f.bin, 0o555);
    // The enabling condition: this process cannot change the directory.
    expect(() => writeFileSync(join(f.bin, "probe"), "")).toThrow();
    const output = f.run();
    expect(readlinkSync(f.link)).toBe(f.target);
    expect(output).toMatch(/^warning:/m);
    expect(existsSync(join(f.bin, "probe"))).toBe(false);
  });
});
