// deploy/install.sh side-by-side Bun installs (task ffd70e4a). The bun-pin
// range (BUN_VERSION, the hash table, converge_bun and its helpers) is
// extracted with sed, as in install-resolve-ref.test.ts, with the download
// base pointed at a file:// directory of fake release zips. A fake "bun" is a
// shell script that prints its version, so no real Bun is downloaded or run.
// Zero LLM.
//
// The layout contract: <dir>/<version>/bun holds each version, and <link>
// (the path the service runs) stays a REGULAR file with the bytes of one of
// them. Not a symlink: Bun's process.execPath resolves a symlink, and the
// server bakes dirname(process.execPath) into each app unit's PATH.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
  symlinkSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";

const INSTALL_SH = new URL("./install.sh", import.meta.url).pathname;
const PACKAGE_JSON = new URL("../package.json", import.meta.url).pathname;
const SRC = readFileSync(INSTALL_SH, "utf8");
// The installer's own Bun pin; empty (and every test using it red) if absent.
const PINNED = SRC.match(/^BUN_VERSION=(\S+)$/m)?.[1] ?? "";

let base: string;
let dl: string; // file:// download root: <dl>/bun-v<version>/bun-linux-<arch>.zip
let table: string; // "version arch sha256" lines the test's bun_sha256 reads
let link: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-install-bun-test-"));
  dl = join(base, "dl");
  table = join(base, "table");
  link = join(base, "bin", "bun");
  dir = join(base, "lib", "bun");
  mkdirSync(dl);
  mkdirSync(join(base, "bin"));
  writeFileSync(table, "");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function fakeBun(version: string): string {
  return `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\nexit 0\n`;
}

function writeFakeBun(path: string, version: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fakeBun(version));
  chmodSync(path, 0o755);
}

// A zip with one stored (uncompressed) file whose Unix mode is `mode`. Built
// here because CI has unzip but no zip.
function storedZip(name: string, data: Buffer, mode: number): Buffer {
  const path = Buffer.from(name);
  const crc = Bun.hash.crc32(data);
  const dosDate = (1 << 5) | 1; // 1980-01-01
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so mode is read
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(path.length, 28);
  central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12);
  end.writeUInt32LE(local.length + path.length + data.length, 16);
  return Buffer.concat([local, path, data, central, path, end]);
}

// A release zip laid out like Bun's own (bun-linux-<arch>/bun inside, the
// layout bun.sh/install unpacks). The binary is stored WITHOUT the exec bit,
// so an implementation that relies on the zip's mode fails here instead of on
// a box. Returns its sha256.
function publishZip(opts: {
  version: string;
  reports?: string;
  arch?: string;
  hashInTable?: boolean;
  corruptHash?: boolean;
}): string {
  const arch = opts.arch ?? "x64";
  const outDir = join(dl, `bun-v${opts.version}`);
  mkdirSync(outDir, { recursive: true });
  const zip = join(outDir, `bun-linux-${arch}.zip`);
  writeFileSync(
    zip,
    storedZip(
      `bun-linux-${arch}/bun`,
      Buffer.from(fakeBun(opts.reports ?? opts.version)),
      0o644,
    ),
  );
  const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (opts.hashInTable ?? true) {
    const listed = opts.corruptHash
      ? sha.replace(/^./, sha[0] === "0" ? "1" : "0")
      : sha;
    writeFileSync(
      table,
      `${readFileSync(table, "utf8")}${opts.version} ${arch} ${listed}\n`,
    );
  }
  return sha;
}

// A PATH holding every command of the real PATH except `without`, so "this
// box has no unzip" is a fact of the fixture.
function pathWithout(without: string): string {
  const shadow = join(base, `path-without-${without}`);
  mkdirSync(shadow);
  const seen = new Set<string>([without]);
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d || !existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        symlinkSync(join(d, name), join(shadow, name));
      } catch {
        // an unreadable entry is not a command this test needs
      }
    }
  }
  return shadow;
}

// The extracted range with the real bun_sha256 and bun_arch replaced by the
// fixture's table and a fixed arch, unless `realTable` keeps the real ones.
function runConverge(opts: {
  version: string;
  path?: string;
  realTable?: boolean;
  tail?: string;
}): { code: number; out: string } {
  const script = `
set -Eeuo pipefail
log() { echo "LOG: $*"; }
die() { echo "DIE: $*" >&2; exit 1; }
step() { :; }
eval "$(sed -n '/^# --- BEGIN bun-pin/,/^# --- END bun-pin/p' "$INSTALL_SH" |
  sed "s#^BUN_DOWNLOAD_BASE=.*#BUN_DOWNLOAD_BASE=file://$DL#")"
${
  opts.realTable
    ? ""
    : `bun_sha256() { awk -v v="$1" -v a="$2" '$1 == v && $2 == a { print $3; found = 1 } END { exit !found }' "$TABLE"; }
bun_arch() { echo x64; }`
}
${opts.tail ?? `converge_bun "$VERSION" "$LINK" "$DIR"`}
`;
  const r = spawnSync("bash", ["-c", script], {
    env: {
      PATH: opts.path ?? process.env.PATH ?? "",
      HOME: base,
      INSTALL_SH,
      DL: dl,
      TABLE: table,
      LINK: link,
      DIR: dir,
      VERSION: opts.version,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function versionOf(path: string): string {
  return execFileSync(path, ["--version"], { encoding: "utf8" }).trim();
}

function ino(path: string): number {
  return statSync(path).ino;
}

function entries(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

// The link is the file the service runs: a regular file, never a symlink.
function expectRegularLinkAt(version: string) {
  expect(lstatSync(link).isSymbolicLink()).toBe(false);
  expect(lstatSync(link).isFile()).toBe(true);
  expect(versionOf(link)).toBe(version);
}

// What every failed converge must leave: the link exactly as it was (same
// inode, same version), no target version directory, and no temp leftovers
// beside the link or in the Bun directory.
function expectUntouched(linkIno: number, linkVersion: string, target: string) {
  expect(ino(link)).toBe(linkIno);
  expectRegularLinkAt(linkVersion);
  expect(existsSync(join(dir, target))).toBe(false);
  expect(
    entries(dirname(link)).filter((n) => n !== "bun" && n !== "bunx"),
  ).toEqual([]);
  expect(entries(dir).filter((n) => n.startsWith("."))).toEqual([]);
}

describe("install.sh converge_bun: switching versions", () => {
  it("adopts a legacy single-file Bun by hardlink and switches to a verified download", () => {
    writeFakeBun(link, "9.9.0");
    const legacyIno = ino(link);
    publishZip({ version: "9.9.1" });

    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);

    expectRegularLinkAt("9.9.1");
    expect(entries(dir)).toEqual(["9.9.0", "9.9.1"]);
    expect(versionOf(join(dir, "9.9.1", "bun"))).toBe("9.9.1");
    // The old bytes are kept for rollback as the SAME inode the running
    // server holds: adopted by hardlink, not copied and not rewritten.
    expect(ino(join(dir, "9.9.0", "bun"))).toBe(legacyIno);
    expect(versionOf(join(dir, "9.9.0", "bun"))).toBe("9.9.0");
    // The link carries the new version's bytes as a hardlink of its file.
    expect(ino(link)).toBe(ino(join(dir, "9.9.1", "bun")));
    // bunx resolves to the link, as bun.sh/install left it.
    const bunx = join(dirname(link), "bunx");
    expect(lstatSync(bunx).isSymbolicLink()).toBe(true);
    expect(realpathSync(bunx)).toBe(realpathSync(link));
    expect(entries(dirname(link))).toEqual(["bun", "bunx"]);
    expect(entries(dir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("installs on a box with no Bun yet (a fresh install)", () => {
    publishZip({ version: "9.9.1" });
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expectRegularLinkAt("9.9.1");
    expect(entries(dir)).toEqual(["9.9.1"]);
  });

  it("switches to a version already in the directory without downloading", () => {
    // Rollback and re-update land here: nothing is published, so any download
    // attempt fails the run.
    writeFakeBun(link, "9.9.0");
    writeFakeBun(join(dir, "9.9.1", "bun"), "9.9.1");
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expectRegularLinkAt("9.9.1");
    expect(ino(link)).toBe(ino(join(dir, "9.9.1", "bun")));
    expect(entries(dir)).toEqual(["9.9.0", "9.9.1"]);
  });

  it("is a no-op on a second run", () => {
    writeFakeBun(link, "9.9.0");
    publishZip({ version: "9.9.1" });
    expect(runConverge({ version: "9.9.1" }).code).toBe(0);
    const switched = ino(link);
    rmSync(dl, { recursive: true, force: true });
    mkdirSync(dl);
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expect(ino(link)).toBe(switched);
    expect(entries(dir)).toEqual(["9.9.0", "9.9.1"]);
  });

  it("adopts the target of a link that points outside the directory, leaving it in place", () => {
    const elsewhere = join(base, "elsewhere", "bun");
    writeFakeBun(elsewhere, "9.9.0");
    const before = readFileSync(elsewhere, "utf8");
    symlinkSync(elsewhere, link);
    publishZip({ version: "9.9.1" });

    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expectRegularLinkAt("9.9.1");
    expect(versionOf(join(dir, "9.9.0", "bun"))).toBe("9.9.0");
    expect(readFileSync(elsewhere, "utf8")).toBe(before);
  });

  it("replaces a version directory whose bun reports another version", () => {
    // A member's `bun upgrade` that wrote through a hardlink, or a crashed
    // earlier run, can leave <dir>/<v>/bun holding a different build.
    writeFakeBun(link, "9.9.0");
    writeFakeBun(join(dir, "9.9.1", "bun"), "9.9.7");
    publishZip({ version: "9.9.1" });

    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expectRegularLinkAt("9.9.1");
    expect(versionOf(join(dir, "9.9.1", "bun"))).toBe("9.9.1");
    expect(entries(dir)).toEqual(["9.9.0", "9.9.1"]);
  });

  it("clears temp directories a killed run left behind", () => {
    writeFakeBun(link, "9.9.0");
    mkdirSync(join(dir, ".tmp-killed", "bun-linux-x64"), { recursive: true });
    writeFileSync(join(dir, ".tmp-killed", "bun-linux-x64", "bun"), "partial");
    publishZip({ version: "9.9.1" });

    const r = runConverge({ version: "9.9.1" });
    expect(r.code).toBe(0);
    expectRegularLinkAt("9.9.1");
    expect(entries(dir)).toEqual(["9.9.0", "9.9.1"]);
  });
});

describe("install.sh converge_bun: a failed install changes nothing the service runs", () => {
  beforeEach(() => {
    writeFakeBun(link, "9.9.0");
  });

  it("refuses a download whose hash differs from the pinned one", () => {
    publishZip({ version: "9.9.1", corruptHash: true });
    const before = ino(link);
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).not.toBe(0);
    expectUntouched(before, "9.9.0", "9.9.1");
  });

  it("refuses a version the table has no hash for, even when its download is valid", () => {
    publishZip({ version: "9.9.1", hashInTable: false });
    const before = ino(link);
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).not.toBe(0);
    expectUntouched(before, "9.9.0", "9.9.1");
  });

  it("refuses a verified download whose bun reports another version", () => {
    publishZip({ version: "9.9.1", reports: "9.9.2" });
    const before = ino(link);
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).not.toBe(0);
    expectUntouched(before, "9.9.0", "9.9.1");
  });

  it("fails when the download is missing", () => {
    const before = ino(link);
    const r = runConverge({ version: "9.9.1" });
    expect(r.code).not.toBe(0);
    expectUntouched(before, "9.9.0", "9.9.1");
  });

  for (const tool of ["curl", "unzip", "sha256sum"]) {
    it(`checks for ${tool} before it changes anything`, () => {
      publishZip({ version: "9.9.1" });
      const before = ino(link);
      // The fixture's PATH has every other command, and the same run with
      // the full PATH succeeds below: the missing tool is the only cause.
      const r = runConverge({ version: "9.9.1", path: pathWithout(tool) });
      expect(r.code).not.toBe(0);
      expectUntouched(before, "9.9.0", "9.9.1");
      // Not even the adopt step ran.
      expect(existsSync(dir)).toBe(false);
      expect(runConverge({ version: "9.9.1" }).code).toBe(0);
      expectRegularLinkAt("9.9.1");
    });
  }
});

describe("install.sh Bun pin", () => {
  it("pins the Bun package.json declares, with a hash for every Linux build", () => {
    // CI and the container image read package.json; the installer carries its
    // own copy because deps-only runs before the checkout. A pin bump without
    // hashes would fail closed on every box at its next update.
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      packageManager: string;
    };
    expect(`bun@${PINNED}`).toBe(pkg.packageManager);
    const r = runConverge({
      version: PINNED,
      realTable: true,
      tail: `for a in x64 x64-baseline aarch64; do printf '%s=%s\\n' "$a" "$(bun_sha256 "$VERSION" "$a")"; done
if out=$(bun_sha256 0.0.0 x64); then echo "unknown=$out"; else echo unknown=missing; fi`,
    });
    expect(r.code).toBe(0);
    for (const arch of ["x64", "x64-baseline", "aarch64"]) {
      expect(r.out).toMatch(new RegExp(`^${arch}=[0-9a-f]{64}$`, "m"));
    }
    // And no hash at all for a version the table does not know.
    expect(r.out).toMatch(/^unknown=missing$/m);
  });
});

describe("install.sh install_bun and deps-only", () => {
  function runWithStubbedConverge(fn: string, setup: string): string {
    const script = `
set -Eeuo pipefail
log() { echo "LOG: $*"; }
die() { echo "DIE: $*"; exit 1; }
step() { :; }
eval "$(sed -n '/^# --- BEGIN bun-pin/,/^# --- END bun-pin/p' "$INSTALL_SH")"
eval "$(sed -n '/^${fn}()/,/^}/p' "$INSTALL_SH")"
converge_bun() { echo "converge_bun $*"; }
DRY_RUN=""
${setup}
${fn}
`;
    // A curl that always fails: an install_bun that still downloads by itself
    // must not reach the network (or /usr/local) from a test.
    const noNet = join(base, "no-net");
    mkdirSync(noNet, { recursive: true });
    writeFileSync(
      join(noNet, "curl"),
      "#!/bin/sh\necho 'curl: no network in this test' >&2\nexit 7\n",
    );
    chmodSync(join(noNet, "curl"), 0o755);
    const r = spawnSync("bash", ["-c", script], {
      env: { PATH: `${noNet}:${process.env.PATH ?? ""}`, INSTALL_SH },
      encoding: "utf8",
    });
    return `${r.stdout}${r.stderr}`;
  }

  it("a fresh install converges the checkout's pin into the system Bun layout", () => {
    const checkout = join(base, "checkout");
    mkdirSync(checkout);
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ name: "fake", packageManager: "bun@7.7.8" }),
    );
    const out = runWithStubbedConverge(
      "install_bun",
      `INSTALL_DIR=${checkout}`,
    );
    expect(out).toContain(
      "converge_bun 7.7.8 /usr/local/bin/bun /usr/local/lib/isomux/bun",
    );
  });

  it("a fresh install of a checkout without a pin converges the installer's own pin", () => {
    const checkout = join(base, "checkout");
    mkdirSync(checkout);
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({ name: "fake" }),
    );
    const out = runWithStubbedConverge(
      "install_bun",
      `INSTALL_DIR=${checkout}`,
    );
    expect(out).toContain(
      `converge_bun ${PINNED} /usr/local/bin/bun /usr/local/lib/isomux/bun`,
    );
  });

  it("ISOMUX_BUN_ONLY=1 converges this release's pin at the given paths, without root", () => {
    // The real installer, run end to end as the test user: the mode is taken
    // before preflight (no DOMAIN, no root). The pinned version is already in
    // the directory, so nothing is downloaded; the download base points
    // nowhere to make sure of it.
    const copy = join(base, "install.sh");
    writeFileSync(
      copy,
      SRC.replace(
        /^BUN_DOWNLOAD_BASE=.*$/m,
        `BUN_DOWNLOAD_BASE=file://${join(base, "nowhere")}`,
      ),
    );
    writeFakeBun(link, "0.0.1");
    writeFakeBun(join(dir, PINNED, "bun"), PINNED);
    const r = spawnSync("bash", [copy], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: base,
        ISOMUX_BUN_ONLY: "1",
        ISOMUX_BUN_LINK: link,
        ISOMUX_BUN_DIR: dir,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    // The output rides along so a red run shows why the installer stopped.
    expect({ status: r.status, out: `${r.stdout}${r.stderr}` }).toEqual({
      status: 0,
      out: expect.any(String),
    });
    expectRegularLinkAt(PINNED);
    expect(versionOf(join(dir, "0.0.1", "bun"))).toBe("0.0.1");
  });
});
